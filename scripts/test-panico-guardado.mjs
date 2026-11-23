// El telefono NO olvida la clave del boton de panico (panico.html en un navegador de verdad, contra los emuladores): se vincula una vez
// con el codigo del vecino y la clave queda en DOS copias (localStorage e IndexedDB); si el telefono pierde una, se repone sola con la
// otra, y solo si pierde las dos (borrar los datos del sitio, o Safari tras 7 dias sin uso) vuelve a pedir el codigo. Tambien: el aviso
// de guardarlo en la pantalla de inicio (con pasos para iPhone y Android), que no sale si ya se abrio desde ahi, y que la pagina nunca
// guarda el codigo de acceso. Al final, la clave que entrega la oficina con el QR: se ve una sola vez y vincula el telefono.
// No corre con `npm test` porque necesita Chrome instalado:
//   cd scripts && npm run seed && node test-panico-guardado.mjs     (con los emuladores levantados; tambien en `npm run test:navegador`)
import { connect, parseArgs } from './admin.mjs';
import { launch, sleep } from './chrome.mjs';

const args = parseArgs();
const BASE = String(args.url || 'http://127.0.0.1:5050').replace(/\/$/, '');
const CONDO = 'condo-villa-ferrer';
const NEIGHBOR = 'u-ana';
const CODE = 'VA101';
const KEY = `sisdel_panico_qr_${CONDO}_${NEIGHBOR}`;
const PAGE = `${BASE}/panico.html?c=${CONDO}&v=${NEIGHBOR}`;
const db = connect('emulator');

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
const equal = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);

async function run() {
    // El boton de panico de vecinos tiene que estar activado en Rondas
    await db.doc(`condominios/${CONDO}/rondas_config/general`).set({ neighbor_panic_enabled: 1 }, { merge: true });
    // Sin vinculos de corridas anteriores
    for (const d of (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).docs) await d.ref.delete();
    for (const d of (await db.collection(`condominios/${CONDO}/panico_entregas`).get()).docs) await d.ref.delete();

    const { newPage, close } = await launch(args.chrome);
    try {
        const page = await newPage({ stepTimeoutMs: 60000 });
        // La ubicacion ya permitida y una posicion de mentira (la pagina la pide antes de mostrar el boton): el GPS de mentira de las pruebas
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
            const pos = { coords: { latitude: 14.6349, longitude: -90.5069, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };
            Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok) => setTimeout(() => ok(pos), 10), watchPosition: (ok) => { setTimeout(() => ok(pos), 10); return 1; }, clearWatch() {} } });
            try { navigator.permissions.query = async () => ({ state: 'granted', onchange: null }); } catch (e) { /* sin API de permisos */ }
        })();` });
        const visible = (id) => `!document.getElementById('${id}').hidden`;
        const state = () => page.evaluate(`(() => { const d = (id) => document.getElementById(id); return { link: !d('pqStepLink').hidden, panic: !d('pqStepPanic').hidden, save: !d('pqStepSave').hidden, who: d('pqWho').textContent, unlink: !d('pqUnlink').hidden }; })()`);
        // Lo que el telefono tiene guardado: las dos copias
        const copies = () => page.evaluate(`(async () => {
            const local = localStorage.getItem(${JSON.stringify(KEY)});
            const idb = await new Promise((resolve) => {
                const r = indexedDB.open('sisdel-panico', 1);
                r.onupgradeneeded = () => { try { r.result.createObjectStore('vinculos'); } catch (e) {} };
                r.onerror = () => resolve(null);
                r.onsuccess = () => { try { const g = r.result.transaction('vinculos').objectStore('vinculos').get(${JSON.stringify(KEY)}); g.onsuccess = () => { r.result.close(); resolve(g.result === undefined ? null : g.result); }; g.onerror = () => resolve(null); } catch (e) { resolve(null); } };
            });
            return { local: local ? JSON.parse(local) : null, idb: idb ? JSON.parse(idb) : null };
        })()`);
        const wipe = (what) => page.evaluate(`(async () => {
            ${what.includes('local') ? `localStorage.removeItem(${JSON.stringify(KEY)});` : ''}
            ${what.includes('idb') ? `await new Promise((resolve) => { const r = indexedDB.open('sisdel-panico', 1); r.onupgradeneeded = () => { try { r.result.createObjectStore('vinculos'); } catch (e) {} }; r.onsuccess = () => { try { const tx = r.result.transaction('vinculos', 'readwrite'); tx.objectStore('vinculos').delete(${JSON.stringify(KEY)}); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onerror = tx.onabort = () => resolve(); } catch (e) { resolve(); } }; r.onerror = () => resolve(); });` : ''}
            return true; })()`);
        // Abre la pagina (de cero) y espera a que muestre el paso que toca
        const open = async (waitFor) => { await page.goto(PAGE); await page.waitFor(`document.getElementById('pqWho') && ${waitFor}`, 'la pagina del QR', 25000); await sleep(250); };

        console.log('\nPrimera vez: vincular con el codigo');
        await page.goto(PAGE);
        await page.evaluate(`localStorage.clear()`).catch(() => {});
        await wipe(['local', 'idb']);
        await open(visible('pqStepLink'));
        equal('un telefono sin vinculo pide el codigo del vecino', await state(), { link: true, panic: false, save: false, who: 'QR de pánico de un vecino', unlink: false });
        await page.evaluate(`(() => { window.__persistCalls = 0; try { navigator.storage.persist = async () => { window.__persistCalls++; return true; }; navigator.storage.persisted = async () => false; } catch (e) {} document.getElementById('pqCode').value = ${JSON.stringify(CODE.toLowerCase())}; document.getElementById('pqLinkForm').requestSubmit(); })()`);
        await page.waitFor(visible('pqStepPanic'), 'el boton tras vincular', 20000);
        await sleep(600);
        const linked = await state();
        record('al vincular muestra el boton, el vecino y el aviso de guardarlo en la pantalla de inicio', linked.panic && !linked.link && linked.save && /Casa 12/.test(linked.who) && linked.unlink, JSON.stringify(linked));
        let c = await copies();
        record('la clave queda en las DOS copias (localStorage e IndexedDB) y son la misma', !!c.local && !!c.idb && c.local.secret === c.idb.secret && /^[A-Za-z0-9_-]{40,64}$/.test(c.local.secret), JSON.stringify(c));
        record('la pagina pide que el navegador no borre sus datos (storage.persist)', (await page.evaluate(`window.__persistCalls`)) >= 1);
        record('nunca se guarda el codigo de acceso en el telefono', !JSON.stringify(c).toUpperCase().includes(CODE) && !(await page.evaluate(`JSON.stringify(Object.entries(localStorage)).toUpperCase().includes(${JSON.stringify(CODE)})`)));
        const devices = (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).docs.map((d) => d.data());
        equal('el servidor tiene UN telefono vinculado a este vecino', [devices.length, devices[0] && devices[0].userId, devices[0] && !devices[0].revokedAt], [1, NEIGHBOR, true]);

        console.log('\nDespues: escanear basta');
        await open(visible('pqStepPanic'));
        let st = await state();
        record('al volver a abrir el QR muestra el boton sin pedir el codigo', st.panic && !st.link && /Casa 12/.test(st.who), JSON.stringify(st));

        console.log('\nEl telefono pierde una copia: se repone sola');
        await wipe(['local']);
        c = await copies();
        record('(se borra localStorage: queda IndexedDB)', !c.local && !!c.idb);
        await open(visible('pqStepPanic'));
        st = await state();
        c = await copies();
        record('aun asi abre con el boton, sin pedir el codigo, y repone localStorage', st.panic && !st.link && !!c.local && !!c.idb && c.local.secret === c.idb.secret, JSON.stringify([st, c.local && 'local', c.idb && 'idb']));
        await wipe(['idb']);
        c = await copies();
        record('(se borra IndexedDB: queda localStorage)', !!c.local && !c.idb);
        await open(visible('pqStepPanic'));
        await sleep(500);
        st = await state();
        c = await copies();
        record('aun asi abre con el boton y repone IndexedDB', st.panic && !st.link && !!c.local && !!c.idb && c.local.secret === c.idb.secret, JSON.stringify([st, c.local && 'local', c.idb && 'idb']));

        console.log('\nEl telefono pierde las dos (borrar datos del sitio, o Safari tras 7 dias)');
        await wipe(['local', 'idb']);
        await open(visible('pqStepLink'));
        st = await state();
        record('vuelve a pedir el codigo (no hay otra forma de saber quien es)', st.link && !st.panic, JSON.stringify(st));
        await page.evaluate(`(() => { document.getElementById('pqCode').value = ${JSON.stringify(CODE)}; document.getElementById('pqLinkForm').requestSubmit(); })()`);
        await page.waitFor(visible('pqStepPanic'), 'el boton tras volver a vincular', 20000);
        const devices2 = (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).docs.map((d) => d.data());
        equal('y el servidor lo cuenta como otro telefono (el viejo queda ahi, sin uso, hasta que se reemplace)', [devices2.length, devices2.filter((x) => !x.revokedAt).length], [2, 2]);

        console.log('\nGuardarlo en la pantalla de inicio');
        const steps = () => page.evaluate(`[...document.querySelectorAll('#pqSaveSteps li')].map((li) => li.textContent)`);
        const desktop = await steps();
        record('en la computadora u otro telefono: pasos generales', desktop.length === 2 && /Agregar a la pantalla de inicio/.test(desktop[0]), JSON.stringify(desktop));
        await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
        await open(visible('pqStepPanic'));
        await sleep(400);
        const ios = await steps();
        const iosWhy = await page.evaluate(`document.getElementById('pqSaveWhy').textContent`);
        record('en iPhone: Compartir > Agregar a inicio, y dice por que (Safari borra a la semana)', ios.length === 3 && /Compartir/.test(ios[0]) && /Agregar a inicio/.test(ios[1]) && /una semana/.test(iosWhy), JSON.stringify([ios, iosWhy]));
        await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
        await open(visible('pqStepPanic'));
        await sleep(400);
        const android = await steps();
        record('en Android: el menu ⋮ y Agregar a la pantalla de inicio', android.length === 3 && /⋮/.test(android[0]) && /Agregar a la pantalla de inicio/.test(android[1]), JSON.stringify(android));
        await page.send('Emulation.setUserAgentOverride', { userAgent: '' });
        // Abierto desde el icono de la pantalla de inicio: ya no se ofrece
        // (Chrome no deja emular display-mode por el protocolo: se simula con lo que el navegador ofrece de verdad, navigator.standalone del
        // iPhone y la consulta display-mode: standalone)
        const standaloneScript = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }); } catch (e) {} })();` });
        await open(visible('pqStepPanic'));
        await sleep(400);
        equal('si ya se abrio desde la pantalla de inicio (iPhone: navigator.standalone) no sale el aviso', (await state()).save, false);
        await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: standaloneScript.identifier });
        const mediaScript = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode:\\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q)); })();` });
        await open(visible('pqStepPanic'));
        await sleep(400);
        equal('y con la consulta display-mode: standalone (Android y otros) tampoco', (await state()).save, false);
        await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: mediaScript.identifier });
        await open(visible('pqStepPanic'));
        await sleep(400);
        record('en el navegador si sale', (await state()).save === true);
        await page.evaluate(`document.getElementById('pqSaveOk').click()`);
        equal('"Ya lo agregue / Ahora no" lo esconde', (await state()).save, false);
        await open(visible('pqStepPanic'));
        await sleep(400);
        equal('y no vuelve a salir al reabrir', (await state()).save, false);

        console.log('\nDesvincular');
        page.evaluate(`window.confirm = () => true`);
        await page.evaluate(`document.getElementById('pqUnlink').click()`);
        await page.waitFor(visible('pqStepLink'), 'pedir el codigo tras desvincular', 15000);
        await sleep(400);
        c = await copies();
        record('desvincular borra las DOS copias y vuelve a pedir el codigo', !c.local && !c.idb && (await state()).link === true, JSON.stringify(c));

        console.log('\nLa oficina entrega la clave con el QR: el vecino la ve una sola vez');
        const reveal = () => page.evaluate(`(() => { const d = (id) => document.getElementById(id); return { step: !d('pqStepReveal').hidden, ask: !d('pqRevealAsk').hidden, show: !d('pqRevealShow').hidden, code: d('pqRevealCode').textContent, btn: d('pqRevealBtn').textContent, notice: d('pqRevealNotice').textContent, link: !d('pqStepLink').hidden, panic: !d('pqStepPanic').hidden, delivered: d('pqDelivered').hidden ? '' : d('pqDelivered').textContent }; })()`);
        // La oficina la activa (en OIKOS lo hace panicCodeDelivery; aqui se escribe igual que el servidor)
        const now = Date.now();
        await db.doc(`condominios/${CONDO}/panico_entregas/${NEIGHBOR}`).set({ userId: NEIGHBOR, condominioId: CONDO, status: 'armed', armedAt: new Date(now).toISOString(), armedUntil: new Date(now + 24 * 3600000).toISOString(), armedById: 'u-admin', armedByName: 'Administrador', history: [] });
        const devicesBefore = (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).size;
        await open(visible('pqStepReveal'));
        let rv = await reveal();
        equal('con la entrega activa, el QR ofrece ver la clave (sin mostrarla todavia) en vez de pedir el codigo', [rv.step, rv.ask, rv.show, rv.code, rv.btn, rv.link, rv.panic], [true, true, false, '', 'Ver mi clave (una sola vez)', false, false]);
        equal('abrir la pagina no gasta la entrega', (await db.doc(`condominios/${CONDO}/panico_entregas/${NEIGHBOR}`).get()).get('status'), 'armed');
        await page.evaluate(`document.getElementById('pqRevealBtn').click()`);
        await page.waitFor(visible('pqRevealShow'), 'la clave en pantalla', 20000);
        await sleep(400);
        rv = await reveal();
        const codeNow = (await db.collection('codigos').where('userId', '==', NEIGHBOR).get()).docs.filter((d) => d.get('condominioId') === CONDO).map((d) => d.id)[0];
        equal('al tocar "Ver mi clave" se ve SU clave en grande, con el aviso, y el telefono ya tiene el boton', [rv.show, rv.code, rv.code === codeNow, rv.panic, rv.link], [true, codeNow, true, true, false]);
        record('el aviso es el del mensaje "Enviar clave de acceso" (guardarla, no compartirla y a quien llega el panico)', /^Favor guarde y no comparta su clave\. ESTA APLICACIÓN SERÁ DE GRAN UTILIDAD/.test(rv.notice) && /A GARITA, A PNC Y A 5 FAMILIARES PREVIAMENTE CONFIGURADOS\.$/.test(rv.notice), rv.notice);
        const dl = (await db.doc(`condominios/${CONDO}/panico_entregas/${NEIGHBOR}`).get()).data();
        const devicesAfter = (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).docs.map((d) => d.data()).filter((x) => x.via === 'entrega' && !x.revokedAt);
        equal('la entrega queda gastada (cuando y en que aparato) y el telefono vinculado en el servidor', [dl.status, !!dl.deliveredAt, !!dl.deliveredOn, devicesAfter.length, (await db.collection(`condominios/${CONDO}/panico_dispositivos`).get()).size], ['delivered', true, true, 1, devicesBefore + 1]);
        c = await copies();
        record('el telefono guarda el vinculo (las dos copias) pero NUNCA la clave', !!c.local && !!c.idb && !(await page.evaluate(`JSON.stringify(Object.entries(localStorage)).toUpperCase().includes(${JSON.stringify(codeNow)})`)) && !JSON.stringify(c).toUpperCase().includes(codeNow), JSON.stringify(c));
        // Se recargo la pagina antes de anotarla: el mismo telefono la puede volver a ver un rato
        await open(visible('pqStepPanic'));
        await page.waitFor(visible('pqStepReveal'), 'volver a verla', 15000);
        rv = await reveal();
        equal('si recarga antes de anotarla, el mismo telefono puede volver a verla (con el boton a la vista)', [rv.step, rv.btn, rv.panic], [true, 'Volver a ver mi clave', true]);
        await page.evaluate(`document.getElementById('pqRevealBtn').click()`);
        await page.waitFor(visible('pqRevealShow'), 'la clave otra vez', 15000);
        equal('y la ve otra vez', (await reveal()).code, codeNow);
        page.evaluate(`window.confirm = () => true`);
        await page.evaluate(`document.getElementById('pqRevealDone').click()`);
        await sleep(300);
        rv = await reveal();
        equal('"Ya la guarde" la quita de la pantalla y queda el boton', [rv.step, rv.code, rv.panic], [false, '', true]);
        await open(visible('pqStepPanic'));
        await sleep(1500);
        equal('y al volver a escanear ya no la ofrece: el QR solo abre el boton de panico', [(await reveal()).step, (await state()).panic], [false, true]);
        // Otro telefono (sin el vinculo) escanea el mismo QR
        await wipe(['local', 'idb']);
        await page.evaluate(`localStorage.clear()`);
        await open(visible('pqStepLink'));
        await sleep(500);
        rv = await reveal();
        record('otro telefono ya no la ve: pide el codigo y dice cuando se entrego (por si no fue el vecino)', !rv.step && rv.link && /La clave de este QR ya se entregó el .+avise a la administración/.test(rv.delivered), JSON.stringify(rv));
        record('sin errores de JavaScript en la pagina', page.errors.length === 0, JSON.stringify(page.errors.slice(0, 4)));
    } finally {
        await close();
    }
}

try { await run(); } catch (error) { failures.push('la prueba se detuvo'); console.log(`  FALLA la prueba se detuvo: ${error.message}`); }
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
