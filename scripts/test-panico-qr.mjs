// Pruebas del QR de panico por vecino, sin emuladores:
//  1. panico-qr.js: el enlace del QR, la lista de vecinos, el QR (con la libreria de vendor/), las tarjetas, la hoja y el PDF.
//  2. functions/src/panico-qr.js (linkPanicDevice y panicDevice) con una base de datos simulada en memoria: vincular el
//     telefono con el codigo del vecino, enviar la alerta, verla, cancelarla, desvincular, y que un extrano no pueda nada.
// Las mismas funciones corren contra los emuladores en test-emulator.mjs (seccion "QR de panico").
// Uso: node test-panico-qr.mjs (tambien corre con npm test).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Las funciones registran cada intento con el logger de Firebase; aqui se silencia para leer la salida
const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (/^\{"[\s\S]*"severity"/.test(String(chunk)) ? true : writeOut(chunk, ...rest));

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

const Q = require('../panico-qr.js');
const qrcode = require('../vendor/qrcode-generator-1.4.4.js');

console.log('\nEl enlace del QR');
{
    const url = Q.panicUrl('https://garita.app', 'condo-villa-ferrer', 'u-ana');
    equal('el QR lleva solo el condominio y el vecino', url, 'https://garita.app/panico.html?c=condo-villa-ferrer&v=u-ana');
    equal('panico.html lee el condominio y el vecino del enlace', Q.parsePanicQuery(new URL(url).search), { c: 'condo-villa-ferrer', v: 'u-ana' });
    equal('un enlace sin vecino, con rutas o con identificadores raros no es un QR valido', [Q.parsePanicQuery('?c=abc'), Q.parsePanicQuery('?c=a/b&v=x'), Q.parsePanicQuery('?c=..&v=x'), Q.parsePanicQuery(`?c=${'a'.repeat(65)}&v=x`), Q.parsePanicQuery('')], [null, null, null, null, null]);
    equal('las tarjetas apuntan a garita.app (tambien impresas desde el espejo de Firebase) y, en desarrollo, a la maquina local', [
        Q.publicOrigin({ hostname: 'garita.app', origin: 'https://garita.app' }),
        Q.publicOrigin({ hostname: 'sisdel-datacenter.web.app', origin: 'https://sisdel-datacenter.web.app' }),
        Q.publicOrigin({ hostname: 'localhost', origin: 'http://localhost:5050' })
    ], ['https://garita.app', 'https://garita.app', 'http://localhost:5050']);
    equal('las funciones: en la nube, y en la maquina local los emuladores (salvo que se pida la nube)', [
        Q.functionUrl({ hostname: 'garita.app' }, 'panicDevice'),
        Q.functionUrl({ hostname: '127.0.0.1' }, 'panicDevice'),
        Q.functionUrl({ hostname: 'localhost' }, 'panicDevice', true)
    ], ['https://us-central1-sisdel-datacenter.cloudfunctions.net/panicDevice', 'http://127.0.0.1:5001/sisdel-datacenter/us-central1/panicDevice', 'https://us-central1-sisdel-datacenter.cloudfunctions.net/panicDevice']);
    equal('el QR nunca lleva el codigo de acceso: solo los parametros c (condominio) y v (vecino)', [Q.panicUrl.length, [...new URL(url).searchParams.keys()]], [3, ['c', 'v']]);
}

console.log('\nLlamar al servidor sin el SDK de Firebase (protocolo de las funciones callable)');
{
    const calls = [];
    const fakeFetch = (reply, status = 200) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => { if (reply === 'nojson') throw new Error('x'); return reply; } }; };
    const r = await Q.callFunction('https://x/f', { a: 1 }, fakeFetch({ result: { ok: true } }));
    equal('manda POST { data } en JSON y devuelve result', [r, calls[0].init.method, JSON.parse(calls[0].init.body), calls[0].init.headers['Content-Type']], [{ ok: true }, 'POST', { data: { a: 1 } }, 'application/json']);
    const err = async (p) => { try { await p; return 'sin error'; } catch (e) { return e.message; } };
    equal('un error del servidor se lanza con su mensaje; una respuesta rara, con el estado HTTP', [
        await err(Q.callFunction('https://x/f', {}, fakeFetch({ error: { message: 'Acción no válida', status: 'INVALID_ARGUMENT' } }, 400))),
        await err(Q.callFunction('https://x/f', {}, fakeFetch('nojson', 502)))
    ], ['Acción no válida', 'HTTP 502']);
    equal('lo que el telefono recuerda de cada QR va por condominio y vecino', Q.storageKey('c1', 'u1'), 'sisdel_panico_qr_c1_u1');
}

console.log('\nVecinos y tarjetas');
{
    const users = [
        { id: 'u3', role: 'vecino', name: 'Carla', casa: 'A10', fase: '2' },
        { id: 'u1', role: 'vecino', name: 'Ana', casa: 'A2', fase: '1' },
        { id: 'u2', role: 'vecino', name: 'Beto', casa: 'A2', fase: '' },
        { id: 'u4', role: 'policia', name: 'Guardia', casa: '' },
        { id: 'u5', role: 'vecino', name: 'De baja', casa: 'B1', active: false },
        { id: 'mal/id', role: 'vecino', name: 'Raro', casa: 'C1' }
    ];
    const list = Q.neighbors(users);
    equal('solo vecinos activos, por lote en orden natural (A2 antes que A10) y por nombre', list.map((u) => u.id), ['u1', 'u2', 'u3']);
    equal('las fases que existen (sin fase al final)', Q.fases(list), ['1', '2', '']);
    equal('imprimir todos, una fase, sin fase o los elegidos (uno solo es elegir uno)', [
        Q.select(list, {}).map((u) => u.id), Q.select(list, { mode: 'fase', fase: '2' }).map((u) => u.id),
        Q.select(list, { mode: 'fase', fase: '' }).map((u) => u.id), Q.select(list, { mode: 'picked', ids: ['u3'] }).map((u) => u.id)
    ], [['u1', 'u2', 'u3'], ['u3'], ['u2'], ['u3']]);
    equal('"Lote 12" bajo el QR; si la casa ya dice Casa o Lote, se deja igual', [Q.unitLabel('12'), Q.unitLabel('A-12'), Q.unitLabel('Casa 12'), Q.unitLabel('lote 45'), Q.unitLabel('  '), Q.unitLabel(null)], ['Lote 12', 'Lote A-12', 'Casa 12', 'lote 45', '', '']);
    const cards = Q.cardsFor(list, 'https://garita.app', 'c1');
    equal('cada tarjeta trae su enlace, su lote y su nombre', cards[0], { id: 'u1', name: 'Ana', unit: 'Lote A2', fase: '1', url: 'https://garita.app/panico.html?c=c1&v=u1' });
}

console.log('\nEl QR (qrcode-generator 1.4.4 de vendor/, dibujado en el navegador)');
{
    const lib = read('vendor/qrcode-generator-1.4.4.js');
    yes('la libreria es la del paquete de npm (MIT) con su licencia, sin cambios', /Copyright \(c\) 2009 Kazuhiko Arase/.test(lib) && /Licensed under the MIT license/.test(lib) && sha256(lib) === '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780');
    equal('panico-qr.js carga la libreria desde vendor/ (no desde otro sitio)', Q.QR_LIB, 'vendor/qrcode-generator-1.4.4.js');
    const url = Q.panicUrl('https://garita.app', 'AbCdEfGhIjKlMnOpQrSt', 'UvWxYz0123456789AbCd');
    const m = Q.qrMatrix(qrcode, url);
    equal('un enlace de 76 caracteres (ids de 20, como los de Firestore) da un QR de 45 x 45 modulos con correccion Q', [url.length, m.size], [76, 45]);
    // Los tres cuadros de las esquinas (deteccion): borde de 7 x 7 oscuro, anillo claro y centro de 3 x 3 oscuro
    const finder = (r0, c0) => [0, 6].every((i) => [...Array(7).keys()].every((j) => m.dark(r0 + i, c0 + j) && m.dark(r0 + j, c0 + i)))
        && [1, 5].every((i) => [1, 2, 3, 4, 5].every((j) => !m.dark(r0 + i, c0 + j))) && [2, 3, 4].every((i) => [2, 3, 4].every((j) => m.dark(r0 + i, c0 + j)));
    yes('el QR tiene sus tres cuadros de deteccion en las esquinas', finder(0, 0) && finder(0, m.size - 7) && finder(m.size - 7, 0));
    const runs = Q.qrRuns(m);
    let dark = 0;
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) dark++;
    const covered = new Set();
    let overlap = false;
    runs.forEach((t) => { for (let i = 0; i < t.w; i++) { const k = `${t.y},${t.x + i}`; if (covered.has(k) || !m.dark(t.y, t.x + i)) overlap = true; covered.add(k); } });
    equal('los tramos cubren exactamente los modulos oscuros, sin encimarse', [covered.size, overlap], [dark, false]);
    const svg = Q.qrSvg(m);
    yes('el SVG lleva el margen blanco de 4 modulos y nitidez de modulo', svg.includes(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`) && svg.includes('shape-rendering="crispEdges"') && (svg.match(/M\d+ \d+h\d+v1h-\d+z/g) || []).length === runs.length);
    const short = Q.qrMatrix(qrcode, Q.panicUrl('https://garita.app', 'condo-villa-ferrer', 'u-ana'));
    yes('distintos vecinos tienen distintos QR', Q.qrSvg(short) !== Q.qrSvg(Q.qrMatrix(qrcode, Q.panicUrl('https://garita.app', 'condo-villa-ferrer', 'u-maria'))));
}

console.log('\nTarjetas, hojas y PDF');
{
    equal('tarjetas por hoja: chica (carro) 9 en carta y 12 en oficio; mediana (puerta) 4 en carta y 6 en oficio', [
        Q.layout('carta', 'chica').perPage, Q.layout('oficio', 'chica').perPage, Q.layout('carta', 'mediana').perPage, Q.layout('oficio', 'mediana').perPage
    ], [9, 12, 4, 6]);
    for (const p of ['carta', 'oficio']) for (const z of ['chica', 'mediana']) {
        const L = Q.layout(p, z);
        yes(`${p} / ${z}: las tarjetas caben en la hoja con su margen`, L.x0 >= Q.MARGIN - 0.01 && L.y0 >= Q.MARGIN - 0.01 && L.x0 * 2 + L.cols * L.size.w + (L.cols - 1) * Q.GAP <= L.paper.w + 0.01 && L.y0 * 2 + L.rows * L.size.h + (L.rows - 1) * Q.GAP <= L.paper.h + 0.01);
    }
    const lib = qrcode;
    const evil = { id: 'u1', name: '<img src=x onerror=alert(1)> Ñoño', unit: 'Lote <b>1</b>', url: 'https://garita.app/panico.html?c=c&v=u1' };
    const matrix = Q.qrMatrix(lib, evil.url);
    const html = Q.cardHtml(evil, 'chica', Q.qrSvg(matrix), 'Villa "Ferrer" & <Co>');
    yes('la tarjeta escapa el nombre, el lote y el condominio', !html.includes('<img') && !html.includes('<b>') && html.includes('&lt;img src=x onerror=alert(1)&gt; Ñoño') && html.includes('Villa &quot;Ferrer&quot; &amp; &lt;Co&gt;'));
    yes('la tarjeta lleva el icono del boton de panico (SVG, sin emojis), el QR, "Escanee en una emergencia", el lote y el nombre', html.includes('BOTÓN DE PÁNICO') && /<svg[^>]*aria-hidden="true"><circle/.test(html) && html.includes('class="pq-qr"') && html.includes('Escanee en una emergencia') && html.includes('pq-unit') && html.includes('pq-name') && !/[\u{1F300}-\u{1FAFF}]/u.test(html));
    const cards = Array.from({ length: 10 }, (_, i) => ({ ...evil, id: `u${i}`, svg: '<svg></svg>' }));
    const page = Q.printHtml(cards, { paper: 'carta', size: 'chica', condoName: 'X', title: 'qr' });
    equal('la impresion: hoja carta sin margenes del navegador, una seccion por hoja (10 tarjetas = 2 hojas de 9)', [/@page \{ size: 215\.9mm 279\.4mm; margin: 0; \}/.test(page), (page.match(/<section class="pq-sheet">/g) || []).length, (page.match(/class="pq-card"/g) || []).length], [true, 2, 10]);
    // PDF con un jsPDF de mentira: hojas, figuras dentro de la hoja y textos en Latin-1
    const ops = { pages: 1, rects: [], circles: [], texts: [], bad: [] };
    const doc = {
        setDrawColor() {}, setFillColor() {}, setTextColor() {}, setLineWidth() {}, setLineDashPattern() {}, setFont() {}, setFontSize() {},
        roundedRect(x, y, w, h) { ops.rects.push([x, y, w, h]); }, rect(x, y, w, h) { ops.rects.push([x, y, w, h]); }, circle(cx, cy, r) { ops.circles.push([cx, cy, r]); }, ellipse(cx, cy, rx, ry) { ops.circles.push([cx, cy, Math.max(rx, ry)]); },
        text(t) { (Array.isArray(t) ? t : [t]).forEach((line) => { ops.texts.push(line); if (/[^\x00-\xff]/.test(line)) ops.bad.push(line); }); },
        getTextWidth: (t) => String(t).length * 1.5, splitTextToSize: (t, w) => { const per = Math.max(1, Math.floor(w / 1.5)); const out = []; for (let i = 0; i < t.length; i += per) out.push(t.slice(i, i + per)); return out; },
        addPage() { ops.pages++; }
    };
    const pdfCards = Array.from({ length: 13 }, (_, i) => ({ id: `u${i}`, name: `Vecina ${i} con un nombre muy largo que no cabe en dos lineas de la tarjeta → sí`, unit: `Lote ${i}`, url: evil.url, matrix }));
    const L = Q.drawPdf(doc, pdfCards, { paper: 'oficio', size: 'chica', condoName: 'Residencial Ñandú' });
    equal('el PDF: 13 tarjetas chicas en oficio = 2 hojas', ops.pages, 2);
    yes('todo lo que se dibuja queda dentro de la hoja', ops.rects.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= L.paper.w + 0.02 && y + h <= L.paper.h + 0.02)
        && ops.circles.every(([cx, cy, r]) => cx - r >= 0 && cy - r >= 0 && cx + r <= L.paper.w + 0.02 && cy + r <= L.paper.h + 0.02));
    // El icono del boton de panico va GRANDE arriba de la tarjeta (pedido del usuario el 2026-11-20: "no solo una franja")
    {
        const big = ops.circles.filter(([, , r]) => Math.abs(r - 6.5) < 0.01);
        equal('el PDF dibuja el icono del boton de panico (aro blanco de 13 mm) en cada una de las 13 tarjetas', big.length, 13);
        const icon = Q.ICON_LAYERS;
        yes('el icono es un boton de domo rojo sobre su base, con brillo y signo de admiracion', icon.length === 10 && icon[0].f === '#ffffff' && icon.some((l) => l.f === '#dc2626') && icon.some((l) => l.t === 'e') && icon.some((l) => l.t === 'r') && icon.filter((l) => l.f === '#ffffff').length === 3);
        const svg = Q.panicIconSvg('13mm');
        equal('el SVG de la vista previa dibuja las mismas capas que el PDF', [(svg.match(/<circle/g) || []).length, (svg.match(/<ellipse/g) || []).length, (svg.match(/<rect/g) || []).length], [8, 1, 1]);
        equal('la parte de arriba mide 18.9 mm en la chica y 26.5 en la mediana (icono 13 mm + titulo)', [Q.headHeight(1).toFixed(1), Q.headHeight(1.4).toFixed(1)], ['18.9', '26.5']);
        equal('en la vista previa el icono es de 13 mm (chica) y 18.2 mm (mediana) y va arriba, antes del QR', [/class="pq-head"><svg[^>]*width="13\.00mm"/.test(Q.cardHtml(evil, 'chica', '<svg></svg>', 'X')), /class="pq-head"><svg[^>]*width="18\.20mm"/.test(Q.cardHtml(evil, 'mediana', '<svg></svg>', 'X'))], [true, true]);
    }
    yes('los textos del PDF van en Latin-1 (acentos y enie si; flechas y demas, "?"), y un nombre largo se corta con "..."', ops.bad.length === 0 && ops.texts.includes('Residencial Ñandú') && ops.texts.some((t) => t.endsWith('...')) && ops.texts.includes('BOTÓN DE PÁNICO'));
}

console.log('\nLo que el telefono recuerda: la clave en dos copias (localStorage e IndexedDB)');
{
    // Un localStorage y un IndexedDB de mentira (el IndexedDB responde como el de verdad: despues, con eventos)
    const fakeStorage = (opts = {}) => {
        const data = new Map();
        return { data, getItem: (k) => { if (opts.throws) throw new Error('bloqueado'); return data.has(k) ? data.get(k) : null; }, setItem: (k, v) => { if (opts.throws) throw new Error('bloqueado'); data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } };
    };
    const fakeIdb = (opts = {}) => {
        const dbs = new Map();
        return {
            dbs,
            open(name) {
                if (opts.throws) throw new Error('sin IndexedDB');
                const request = {};
                setTimeout(() => {
                    if (opts.hang) return;
                    const fresh = !dbs.has(name);
                    if (fresh) dbs.set(name, new Map());
                    const stores = dbs.get(name);
                    const db = {
                        createObjectStore: (n) => { if (!stores.has(n)) stores.set(n, new Map()); },
                        close() {},
                        transaction(n) {
                            const tx = {};
                            const run = (fn) => { const r = {}; setTimeout(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); }, 0); return r; };
                            tx.objectStore = () => ({ get: (k) => run(() => stores.get(n).get(k)), put: (v, k) => run(() => { stores.get(n).set(k, v); return k; }), delete: (k) => run(() => { stores.get(n).delete(k); }) });
                            return tx;
                        }
                    };
                    request.result = db;
                    if (fresh && request.onupgradeneeded) request.onupgradeneeded();
                    if (request.onsuccess) request.onsuccess();
                }, 0);
                return request;
            }
        };
    };
    const SECRET = 'A'.repeat(43);
    const LINK = { secret: SECRET, name: 'Ana García', casa: 'Casa 12', condoName: 'Villa Uno', canCancel: true, at: '2026-11-20T12:00:00.000Z' };
    const KEY = Q.storageKey('c1', 'u-ana');
    const make = (ls, idb, nav) => Q.createKeeper({ localStorage: ls, indexedDB: idb, navigator: nav }, KEY);
    const nav = (persisted = false, grant = true) => ({ storage: { persisted: async () => persisted, persist: async () => grant } });
    const idbHas = (idb) => { const st = idb.dbs.get('sisdel-panico'); return !!(st && st.get('vinculos') && st.get('vinculos').has(KEY)); };

    let ls = fakeStorage(), idb = fakeIdb();
    let k = make(ls, idb, nav());
    equal('sin nada guardado no hay vinculo', await k.load(), { link: null, from: null, repaired: false });
    const saved = await k.save(LINK);
    equal('guardar deja las DOS copias y pide que el navegador no las borre', [saved.local, saved.idb, saved.persistent, ls.data.has(KEY), idbHas(idb)], [true, true, true, true, true]);
    equal('lo guardado es lo mismo en las dos y nunca incluye un codigo de acceso', [JSON.parse(ls.data.get(KEY)).secret, JSON.parse(idb.dbs.get('sisdel-panico').get('vinculos').get(KEY)).secret, JSON.stringify(LINK).includes('code')], [SECRET, SECRET, false]);
    equal('al abrir lo lee de localStorage al instante (sin esperar a IndexedDB)', k.readLocal(), LINK);
    equal('con las dos copias no repara nada', [(await k.load()).from, (await k.load()).repaired], ['local', false]);

    ls.data.clear();
    equal('si el telefono pierde localStorage, el vinculo sigue ahi (IndexedDB) y se repone', [await k.load(), ls.data.has(KEY)], [{ link: LINK, from: 'idb', repaired: true }, true]);
    idb.dbs.clear();
    equal('si pierde IndexedDB, localStorage lo repone', [await k.load(), idbHas(idb)], [{ link: LINK, from: 'local', repaired: true }, true]);
    ls.data.clear(); idb.dbs.clear();
    equal('si pierde las dos (borrar los datos del sitio, o Safari tras 7 dias sin uso) hay que vincular de nuevo', await k.load(), { link: null, from: null, repaired: false });

    // Datos danados o ajenos no sirven
    ls = fakeStorage(); idb = fakeIdb(); k = make(ls, idb, nav());
    ls.data.set(KEY, '{no es json');
    equal('un localStorage danado se ignora', await k.load(), { link: null, from: null, repaired: false });
    ls.data.set(KEY, JSON.stringify({ secret: 'corta' }));
    equal('una clave que no tiene la forma de las del servidor se ignora', await k.load(), { link: null, from: null, repaired: false });
    equal('validLink: pide una clave de 40 a 64 letras, numeros, guion o guion bajo', [Q.validLink(LINK), Q.validLink({ secret: 'x'.repeat(40) }), Q.validLink({ secret: 'x'.repeat(39) }), Q.validLink({ secret: 'a b'.repeat(20) }), Q.validLink(null)], [true, true, false, false, false]);

    // Navegadores que no dejan guardar
    ls = fakeStorage({ throws: true }); idb = fakeIdb(); k = make(ls, idb, nav());
    equal('sin localStorage (modo privado) queda la copia de IndexedDB', [await k.save(LINK), (await k.load()).from], [{ local: false, idb: true, persistent: true }, 'idb']);
    ls = fakeStorage(); k = make(ls, null, nav());
    equal('sin IndexedDB queda la de localStorage y avisa que una sola copia', [await k.save(LINK), (await k.load()).from], [{ local: true, idb: false, persistent: true }, 'local']);
    ls = fakeStorage({ throws: true }); k = make(ls, fakeIdb({ throws: true }), nav());
    equal('sin ninguno de los dos no se puede guardar y lo dice (el telefono tendra que vincularse cada vez)', await k.save(LINK), { local: false, idb: false, persistent: true });
    ls = fakeStorage(); k = make(ls, fakeIdb(), null);
    equal('sin la API de almacenamiento persistente no se rompe: guarda y dice que no lo sabe', (await k.save(LINK)).persistent, null);
    ls = fakeStorage(); k = make(ls, fakeIdb(), nav(false, false));
    equal('si el navegador niega la persistencia, igual guarda las dos copias', await k.save(LINK), { local: true, idb: true, persistent: false });
    ls = fakeStorage(); k = make(ls, fakeIdb(), nav(true));
    equal('si ya era persistente no lo vuelve a pedir', (await k.save(LINK)).persistent, true);

    // IndexedDB que no responde no atrasa el boton
    ls = fakeStorage(); k = make(ls, fakeIdb({ hang: true }), nav());
    const t0 = Date.now();
    const slow = await k.save(LINK);
    equal('un IndexedDB que no responde no cuelga la pagina (espera poco y sigue con localStorage)', [slow.local, slow.idb, Date.now() - t0 < 6000], [true, false, true]);

    ls = fakeStorage(); idb = fakeIdb(); k = make(ls, idb, nav());
    await k.save(LINK);
    await k.drop();
    equal('desvincular borra las dos copias', [ls.data.has(KEY), idbHas(idb), (await k.load()).link], [false, false, null]);
}

console.log('\nServidor: vincular el telefono y enviar la alerta (base simulada)');
const store = new Map();
let autoId = 0;
const snapOf = (path) => ({ exists: store.has(path), data: () => (store.has(path) ? { ...store.get(path) } : undefined), id: path.split('/').pop(), ref: docRef(path) });
function docRef(path) {
    return {
        path, id: path.split('/').pop(),
        get: async () => snapOf(path),
        delete: async () => { store.delete(path); },
        set: async (data) => { store.set(path, { ...data }); },
        create: async (data) => { if (store.has(path)) throw new Error('ya existe'); store.set(path, { ...data }); },
        update: async (data) => { if (!store.has(path)) throw new Error('no existe'); store.set(path, { ...store.get(path), ...data }); }
    };
}
function collectionRef(path, filters = []) {
    return {
        doc: (id) => docRef(`${path}/${id || `auto${++autoId}`}`),
        where: (field, op, value) => collectionRef(path, [...filters, [field, op, value]]),
        get: async () => {
            const docs = [...store.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
                .filter((k) => filters.every(([f, op, v]) => op === '==' && store.get(k)[f] === v)).map(snapOf);
            return { docs, size: docs.length, empty: !docs.length };
        }
    };
}
const fakeDb = {
    doc: docRef,
    collection: (path) => collectionRef(path),
    runTransaction: async (fn) => fn({
        get: async (ref) => ref.get(),
        set: (ref, data) => store.set(ref.path, { ...data }),
        update: (ref, data) => store.set(ref.path, { ...store.get(ref.path), ...data })
    })
};
const devicePathOf = (condo, secret) => `condominios/${condo}/panico_dispositivos/${sha256(secret)}`;
const firebasePath = require.resolve('../functions/src/firebase.js');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: fakeDb, auth: {} } };
const { linkPanicDevice, panicDevice } = require('../functions/src/panico-qr.js');

let ipCounter = 0;
const req = (data, ip) => ({ auth: null, data, rawRequest: { headers: { 'user-agent': 'Prueba/1.0', 'x-forwarded-for': ip || `10.0.0.${++ipCounter % 250}` }, ip: '127.0.0.1' } });
const link = (c, v, code, ip) => linkPanicDevice.run(req({ c, v, code }, ip));
const device = (data) => panicDevice.run(req(data));
const errOf = async (p) => { try { await p; return 'sin error'; } catch (e) { return e.code || e.message; } };

function seed() {
    store.clear();
    const person = (condo, id, code, role, extra = {}) => {
        store.set(`codigos/${code}`, { condominioId: condo, userId: id, role });
        store.set(`condominios/${condo}/usuarios/${id}`, { name: `Nombre ${id}`, role, casa: extra.casa || '', phone: '55551234', ...extra });
    };
    store.set('condominios/c1', { name: 'Villa Uno', active: true });
    store.set('condominios/c2', { name: 'Villa Dos', active: true });
    store.set('condominios/c1/rondas_config/general', { neighbor_panic_enabled: 1 });
    store.set('condominios/c2/rondas_config/general', { neighbor_panic_enabled: 1 });
    person('c1', 'u-ana', 'VA101', 'vecino', { casa: 'Casa 12' });
    person('c1', 'u-maria', 'VM102', 'vecino', { casa: 'Casa 23' });
    person('c1', 'u-guardia', 'VP103', 'policia');
    person('c1', 'u-sincancel', 'VS106', 'vecino', { privilegios: { 'panico.cancelar': false } });
    person('c2', 'u-otro', 'VO200', 'vecino');
}
seed();
{
    equal('un QR sin condominio o vecino validos no se vincula', (await link('c1', 'a/b', 'VA101')).ok, false);
    const bad = await link('c1', 'u-ana', 'NOEXISTE');
    equal('con un codigo que no existe no se vincula, y el mensaje no dice de quien es ningun codigo', [bad.ok, bad.error], [false, 'Ese código no es el de este vecino. Escriba el código de acceso de la persona del QR.']);
    const other = await link('c1', 'u-ana', 'VM102');
    equal('con el codigo de OTRO vecino tampoco (un extrano que escanea el QR de su vecino no puede usarlo), con el mismo mensaje', [other.ok, other.error], [false, bad.error]);
    equal('nada quedo vinculado', [...store.keys()].filter((k) => k.includes('panico_dispositivos')).length, 0);
    for (let i = 0; i < 3; i++) await link('c1', 'u-ana', `MAL${i}`);
    const blocked = await link('c1', 'u-ana', 'VA101');
    equal('5 intentos fallidos con el QR de un vecino lo bloquean 15 minutos (aunque despues pongan el codigo bueno)', [blocked.ok, blocked.blocked], [false, true]);
    store.delete(`_privado/rate/panico_vincular/${sha256('c1/u-ana').slice(0, 32)}`);
    for (let i = 0; i < 30; i++) await link('c1', `u-x${i}`, `X${i}`, '9.9.9.9');
    equal('y 30 intentos fallidos desde una misma red tambien (para quien prueba codigos en muchos QR)', (await link('c1', 'u-maria', 'VM102', '9.9.9.9')).blocked, true);
}
seed();
let secretAna = '';
{
    const ok = await link('c1', 'u-ana', ' va101 ');
    secretAna = ok.secret;
    equal('con su propio codigo (sin importar mayusculas ni espacios) el telefono queda vinculado', [ok.ok, ok.name, ok.casa, ok.condoName, ok.canCancel, ok.alert], [true, 'Nombre u-ana', 'Casa 12', 'Villa Uno', true, null]);
    yes('el telefono recibe una clave al azar larga (no el codigo)', /^[A-Za-z0-9_-]{43}$/.test(ok.secret) && !ok.secret.includes('VA101'));
    const devKeys = [...store.keys()].filter((k) => k.includes('panico_dispositivos'));
    const dev = store.get(devKeys[0]);
    equal('el servidor guarda solo la huella de la clave y del codigo, nunca la clave ni el codigo', [devKeys.length, devKeys[0], dev.codeHash === sha256('VA101'), JSON.stringify(dev).includes(ok.secret), JSON.stringify(dev).includes('VA101')],
        [1, `condominios/c1/panico_dispositivos/${sha256(ok.secret)}`, true, false, false]);
    const g = await link('c1', 'u-guardia', 'VP103');
    equal('el QR de alguien que no es vecino no se vincula ni con su codigo', [g.ok, g.error], [false, 'Este QR ya no corresponde a un vecino registrado. Pida uno nuevo a la administración.']);
    store.set('condominios/c1/rondas_config/general', { neighbor_panic_enabled: 0 });
    const off = await link('c1', 'u-maria', 'VM102');
    equal('con el panico de vecinos apagado en RONDIN no se vincula y se dice por que', [off.ok, /no está activado/.test(off.error)], [false, true]);
    store.set('condominios/c1/rondas_config/general', { neighbor_panic_enabled: 1 });
}
{
    const check = await device({ action: 'check', c: 'c1', v: 'u-ana', secret: secretAna });
    equal('el telefono vinculado se comprueba al abrir el QR', [check.ok, check.name, check.alert], [true, 'Nombre u-ana', null]);
    equal('una clave inventada, de otro vecino o de otro condominio pide vincular', [
        (await device({ action: 'check', c: 'c1', v: 'u-ana', secret: 'x'.repeat(43) })).relink,
        (await device({ action: 'check', c: 'c1', v: 'u-maria', secret: secretAna })).relink,
        (await device({ action: 'check', c: 'c2', v: 'u-ana', secret: secretAna })).relink,
        (await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: '' })).relink
    ], [true, true, true, true]);
    equal('una accion desconocida se rechaza', await errOf(device({ action: 'borrar', c: 'c1', v: 'u-ana', secret: secretAna })), 'invalid-argument');

    const sent = await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: secretAna, lat: 14.6, lng: -90.5, accuracy: 12.4 });
    const alertKeys = [...store.keys()].filter((k) => k.startsWith('condominios/c1/alertas_panico/'));
    const saved = store.get(alertKeys[0]);
    equal('la alerta sale como la del portal (alertas_panico, source vecino) con los datos del vecino, su ubicacion y via qr', [sent.ok, alertKeys.length, saved.source, saved.via, saved.userId, saved.userName, saved.casa, saved.phone, saved.lat, saved.lng, saved.accuracy, saved.status, saved.condominioId],
        [true, 1, 'vecino', 'qr', 'u-ana', 'Nombre u-ana', 'Casa 12', '55551234', 14.6, -90.5, 12, 'ACTIVE', 'c1']);
    equal('el telefono recibe como va su alerta (sin datos de mas)', Object.keys(sent.alert).sort(), ['attendedByName', 'createdAt', 'hasLocation', 'id', 'status']);
    yes('el telefono queda con la fecha de su ultimo uso', store.get(`condominios/c1/panico_dispositivos/${sha256(secretAna)}`).lastUsedAt === saved.createdAt);
    await new Promise((r) => setTimeout(r, 5)); // la segunda alerta, un momento despues
    const nogps = await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: secretAna, lat: 200, lng: 'x' });
    const saved2 = store.get(`condominios/c1/alertas_panico/${nogps.alert.id}`);
    equal('sin ubicacion valida la alerta sale igual, sin coordenadas', [nogps.ok, saved2.lat, saved2.lng, saved2.accuracy, nogps.alert.hasLocation], [true, null, null, null, false]);
    const back = await device({ action: 'check', c: 'c1', v: 'u-ana', secret: secretAna });
    equal('al volver a escanear se ve la alerta abierta mas reciente', back.alert && back.alert.id, nogps.alert.id);
    store.set(`condominios/c1/alertas_panico/${sent.alert.id}`, { ...saved, status: 'ATTENDED', attendedByName: 'Guardia Pedro' });
    const st = await device({ action: 'status', c: 'c1', v: 'u-ana', secret: secretAna, alertId: sent.alert.id });
    equal('ve como va su alerta: atendida y por quien', [st.ok, st.alert.status, st.alert.attendedByName], [true, 'ATTENDED', 'Guardia Pedro']);
    equal('no la puede cancelar si ya fue atendida', (await device({ action: 'cancel', c: 'c1', v: 'u-ana', secret: secretAna, alertId: sent.alert.id })).ok, false);
    const cancel = await device({ action: 'cancel', c: 'c1', v: 'u-ana', secret: secretAna, alertId: nogps.alert.id });
    equal('cancela su alerta activa (fue un error)', [cancel.ok, cancel.alert.status, !!store.get(`condominios/c1/alertas_panico/${nogps.alert.id}`).cancelledAt], [true, 'CANCELLED', true]);
    // Una alerta de otro vecino no se ve ni se cancela con este telefono
    store.set('condominios/c1/alertas_panico/ajena', { id: 'ajena', userId: 'u-maria', status: 'ACTIVE', createdAt: new Date().toISOString() });
    equal('la alerta de otro vecino no se ve ni se cancela', [
        (await device({ action: 'status', c: 'c1', v: 'u-ana', secret: secretAna, alertId: 'ajena' })).ok,
        (await device({ action: 'cancel', c: 'c1', v: 'u-ana', secret: secretAna, alertId: 'ajena' })).ok,
        store.get('condominios/c1/alertas_panico/ajena').status
    ], [false, false, 'ACTIVE']);
    // Tope de alertas (un telefono o programa que se queda enviando)
    let last = null;
    for (let i = 0; i < 9; i++) last = await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: secretAna });
    equal('mas de 10 alertas en 10 minutos se frenan con un aviso', [last.ok, /varias alertas/.test(last.error)], [false, true]);
}
seed();
{
    const sc = await link('c1', 'u-sincancel', 'VS106');
    const a = await device({ action: 'alert', c: 'c1', v: 'u-sincancel', secret: sc.secret });
    equal('sin el privilegio panico.cancelar el telefono no ofrece ni puede cancelar', [sc.canCancel, (await device({ action: 'cancel', c: 'c1', v: 'u-sincancel', secret: sc.secret, alertId: a.alert.id })).ok], [false, false]);

    const ana = await link('c1', 'u-ana', 'VA101');
    store.set('condominios/c1/usuarios/u-ana', { ...store.get('condominios/c1/usuarios/u-ana'), privilegios: { 'panico.activar': false } });
    const noPriv = await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: ana.secret });
    equal('si el administrador le quita el boton de panico, el telefono vinculado deja de enviar (sin pedir vincular)', [noPriv.ok, noPriv.relink, /no tiene el botón de pánico/.test(noPriv.error)], [false, undefined, true]);
    store.set('condominios/c1/usuarios/u-ana', { ...store.get('condominios/c1/usuarios/u-ana'), privilegios: {}, active: false });
    equal('un vecino desactivado tampoco', /desactivado/.test((await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: ana.secret })).error), true);
    store.set('condominios/c1/usuarios/u-ana', { ...store.get('condominios/c1/usuarios/u-ana'), active: true });
    store.set('condominios/c1', { name: 'Villa Uno', active: false });
    equal('un condominio sin servicio tampoco', (await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: ana.secret })).error, 'El condominio no está activo.');
    store.set('condominios/c1', { name: 'Villa Uno', active: true });

    // Cambiarle el codigo al vecino desvincula sus telefonos (asi se corta un telefono perdido)
    store.delete('codigos/VA101');
    store.set('codigos/VA999', { condominioId: 'c1', userId: 'u-ana', role: 'vecino' });
    const changed = await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: ana.secret });
    equal('si el administrador le cambia el codigo, el telefono pide vincularse otra vez con el codigo nuevo', [changed.ok, changed.relink, /cambió/.test(changed.error)], [false, true, true]);
    equal('nadie envio la alerta despues del cambio', [...store.keys()].filter((k) => k.startsWith('condominios/c1/alertas_panico/') && store.get(k).userId === 'u-ana').length, 0);
    const relinked = await link('c1', 'u-ana', 'VA999');
    equal('con el codigo nuevo se vuelve a vincular', relinked.ok, true);
    equal('desvincular este telefono', (await device({ action: 'unlink', c: 'c1', v: 'u-ana', secret: relinked.secret })).ok, true);
    equal('despues de desvincularlo, el telefono ya no envia', (await device({ action: 'alert', c: 'c1', v: 'u-ana', secret: relinked.secret })).relink, true);
}
seed();
{
    // Tope de telefonos por vecino (con el codigo vigente)
    const phones = [];
    for (let i = 0; i < 20; i++) { phones.push((await link('c1', 'u-maria', 'VM102')).secret); store.get(devicePathOf('c1', phones[i])).createdAt = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`; }
    const liveCount = () => [...store.entries()].filter(([k, v]) => k.startsWith('condominios/c1/panico_dispositivos/') && v.userId === 'u-maria' && !v.revokedAt).length;
    equal('un vecino tiene hasta 20 telefonos vinculados a la vez', liveCount(), 20);
    // Quien tiene su codigo nunca se queda sin poder vincular: el telefono que lleva mas tiempo sin usarse se reemplaza (un telefono que
    // olvida su clave se vincula de nuevo y deja el vinculo viejo huerfano)
    const extra = await link('c1', 'u-maria', 'VM102');
    equal('el telefono 21 se vincula y reemplaza al mas viejo sin uso: siguen 20', [extra.ok, liveCount()], [true, 20]);
    equal('el reemplazado deja de servir (hay que vincularlo de nuevo) y queda anotado', [(await device({ action: 'check', c: 'c1', v: 'u-maria', secret: phones[0] })).relink, store.get(devicePathOf('c1', phones[0])).revokedBy], [true, 'reemplazado']);
    equal('los demas siguen sirviendo', [(await device({ action: 'check', c: 'c1', v: 'u-maria', secret: phones[1] })).ok, (await device({ action: 'check', c: 'c1', v: 'u-maria', secret: extra.secret })).ok], [true, true]);
    // Uno que se uso hace poco no se reemplaza aunque sea de los primeros en vincularse
    store.get(devicePathOf('c1', phones[1])).lastUsedAt = '2026-11-19T00:00:00.000Z';
    const again = await link('c1', 'u-maria', 'VM102');
    equal('al siguiente se reemplaza el mas viejo SIN USO (el que se uso hace poco se queda)', [again.ok, !!store.get(devicePathOf('c1', phones[1])).revokedAt, !!store.get(devicePathOf('c1', phones[2])).revokedAt, liveCount()], [true, false, true, 20]);
}

console.log('\nReglas y paginas');
{
    const rules = read('firestore.rules');
    yes('las reglas no dejan leer ni escribir los telefonos vinculados desde el navegador', /match \/panico_dispositivos\/\{deviceId\} \{\s*allow read, write: if false;\s*\}/.test(rules));
    const index = read('functions/index.js');
    yes('functions/index.js publica linkPanicDevice y panicDevice', /require\('\.\/src\/panico-qr'\)/.test(index) && /linkPanicDevice, panicDevice/.test(index));
    const page = read('panico.html');
    yes('panico.html no carga el SDK de Firebase (abre rapido) y llama al servidor con panico-qr.js', !/firebasejs/.test(page) && /Q\.callFunction\(Q\.functionUrl\(location, name, forceProd\)/.test(page));
    yes('panico.html no se indexa ni manda su direccion a otros sitios', /<meta name="robots" content="noindex, nofollow">/.test(page) && /<meta name="referrer" content="no-referrer">/.test(page));
    yes('el codigo no se queda en la pagina ni en el telefono: se borra del campo y solo se guarda la clave del vinculo', /input\.value = ''; \/\/ el codigo no se queda en la pagina/.test(page) && /link = \{ secret: res\.secret, name: res\.name, casa: res\.casa, condoName: res\.condoName, canCancel: res\.canCancel, at: /.test(page) && !/code:\s*code[\s\S]{0,40}saveLink/.test(page));
    yes('panico.html pinta los datos del vecino con textContent (nunca como HTML)', !/innerHTML/.test(page.split('<script>').slice(1).join('')));
    const v = (f, name) => (read(f).match(new RegExp(`${name.replace('.', '\\.')}\\?v=(\\w+)`)) || [])[1];
    yes('panico-qr.js lleva la misma version en admin.html y panico.html', v('admin.html', 'panico-qr.js') && v('admin.html', 'panico-qr.js') === v('panico.html', 'panico-qr.js'));
    const admin = read('admin.html');
    yes('admin.html carga panico-qr.js antes de reportes-ui.js', admin.indexOf('src="panico-qr.js') > 0 && admin.indexOf('src="panico-qr.js') < admin.indexOf('src="reportes-ui.js'));
    const rp = read('reportes-ui.js');
    yes('el reporte usa la libreria de vendor/ y el privilegio reportes.panico_qr', /tag\.src = PQ\(\)\.QR_LIB;/.test(rp) && /can\('reportes\.panico_qr'\)/.test(rp) && /else if \(def\.id === 'panico-qr'\) renderPanicQr\(def\);/.test(rp));
    yes('la vista previa muestra TODAS las tarjetas (no solo las primeras), pintadas de 40 en 40 y cortando la pintada anterior al cambiar un filtro', /const cards = Q\.cardsFor\(list, origin, condoId\);/.test(rp) && !/list\.slice\(0, PREVIEW\)/.test(rp) && /const PREVIEW_CHUNK = 40;/.test(rp) && /if \(mine !== paintSeq \|\| !preview\.isConnected\) return;/.test(rp) && /if \(next < cards\.length\) setTimeout\(paintChunk, 0\);/.test(rp));
    yes('el reporte avisa si el boton de panico de vecinos esta apagado en RONDIN', /SisdelRondas\.neighborPanicEnabled\(\)\.then/.test(rp) && /los QR no enviarán alertas hasta activarlo/.test(rp));
    yes('el reporte no manda nada a otro servicio para hacer el QR (sin APIs de QR externas)', !/api\.qrserver|chart\.googleapis|quickchart/i.test(rp + read('panico-qr.js')));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
