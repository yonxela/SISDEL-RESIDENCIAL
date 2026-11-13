// Pruebas de los datos del Sistema Financiero en el navegador (finanzas-datos.js), del Store de OIKOS en memoria
// (finanzas/index.html) y de las funciones nuevas de finanzas-sync.js: sin emuladores ni navegador.
// Uso: node test-finanzas-datos.mjs (tambien corre con npm test).
//
// Lo central: el Store en memoria debe dar EXACTAMENTE lo mismo que el de antes (un texto en localStorage).
// Se comprueba con miles de operaciones al azar (azar repetible) sobre los dos a la vez.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../finanzas-datos.js');
const { internals: F } = require('../finanzas-sync.js');
const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function yes(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    yes(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

// Azar repetible
let seed = 20261112;
function random() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
const pick = (list) => list[Math.floor(random() * list.length)];
const jsonCopy = (x) => { const text = JSON.stringify(x); return text === undefined ? null : JSON.parse(text); };
const stripStamps = (o) => { if (!o || typeof o !== 'object' || Array.isArray(o)) return o; const c = { ...o }; delete c.updated_at; delete c.created_at; return c; };

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';
const NOW = '2026-11-12T12:00:00.000Z';

// ───────── Copias de registros ─────────
console.log('\nCopias de registros');
{
    const samples = [
        { id: 'a', amount: 425, concept: 'Cuota', deleted: false, breakdown: { maintenance: 300, water: 125 }, notes: null },
        { id: 'b', x: undefined, f() {}, n: NaN, inf: Infinity, z: -0, list: [1, undefined, { a: 1 }], when: new Date(Date.UTC(2026, 10, 1)) },
        { 2: 'dos', 1: 'uno', b: 'b', a: 'a' },
        null, 5, 'texto', [1, 2, { a: undefined }]
    ];
    samples.forEach((sample, i) => equal(`la copia de un registro es la de JSON (${i + 1})`, D.cloneRecord(sample), jsonCopy(sample)));
    const original = { id: 'a', breakdown: { water: 1 } };
    const copy = D.cloneRecord(original);
    copy.breakdown.water = 99;
    copy.id = 'z';
    equal('cambiar la copia no cambia el original', original, { id: 'a', breakdown: { water: 1 } });
    equal('las claves de la copia quedan en el mismo orden que en JSON', Object.keys(D.cloneRecord(samples[2])), Object.keys(jsonCopy(samples[2])));
    equal('una lista se copia registro por registro', D.cloneList([{ id: 1, a: undefined }, null]), [{ id: 1 }, null]);
    equal('cloneJson de undefined es null (como en una lista de JSON)', D.cloneJson(undefined), null);
}

// ───────── Comparacion de registros ─────────
console.log('\nComparacion de registros');
{
    const values = [1, 0, -0, 425, 425.5, '1', '', 'Cuota', true, false, null, undefined, NaN, { a: 1 }, { a: 2 }, { a: 1, b: undefined }, [1, 2], [1, 3]];
    const keys = ['id', 'amount', 'concept', 'updated_at', 'created_at', 'deleted', 'breakdown', 'x'];
    const randomRecord = () => {
        const o = {};
        keys.filter(() => random() < 0.7).sort(() => random() - 0.5).forEach((k) => { o[k] = pick(values); });
        return o;
    };
    let mismatches = 0;
    let equals = 0;
    for (let i = 0; i < 6000; i++) {
        const a = randomRecord();
        // La mitad de las veces b sale de a (para que haya muchos iguales)
        const b = random() < 0.5 ? randomRecord() : (() => { const c = { ...a }; if (random() < 0.5) c[pick(keys)] = pick(values); if (random() < 0.3) c.updated_at = 'otro'; return c; })();
        for (const skip of [true, false]) {
            const expected = skip ? JSON.stringify(stripStamps(a)) === JSON.stringify(stripStamps(b)) : JSON.stringify(a) === JSON.stringify(b);
            if (expected) equals++;
            if (D.sameRecord(a, b, skip) !== expected) mismatches++;
        }
    }
    equal('12 000 comparaciones al azar coinciden con comparar el JSON', mismatches, 0);
    yes('entre ellas hay iguales y distintas', equals > 1000 && equals < 11000, `(${equals} iguales)`);
    yes('el mismo objeto es igual a si mismo', D.sameRecord(values[13], values[13], false));
    yes('el orden de las claves cuenta, como en JSON', !D.sameRecord({ a: 1, b: 2 }, { b: 2, a: 1 }, false));
    yes('sin sellos: solo cambia updated_at', D.sameRecord({ id: 1, updated_at: T1 }, { id: 1, updated_at: T2 }, true) && !D.sameRecord({ id: 1, updated_at: T1 }, { id: 1, updated_at: T2 }, false));
    yes('numero y texto no son iguales', !D.sameRecord({ a: 1 }, { a: '1' }, false));
    yes('lo que no es un registro se compara por su JSON', D.sameRecord([1, 2], [1, 2], false) && !D.sameRecord([1, 2], [2, 1], true) && D.sameRecord(null, null, true));
}

// ───────── Guardar una lista (lo que hace Store.set) ─────────
console.log('\nGuardar una lista');
// Como lo hacia OIKOS con localStorage (finanzas/index.html, Store.set), sobre el texto guardado
function legacySet(storedText, v, now) {
    let prevArr = [];
    try { prevArr = JSON.parse(storedText) || []; } catch { prevArr = []; }
    if (!Array.isArray(prevArr)) prevArr = [];
    const prevById = new Map(prevArr.map((x) => [String(x && x.id), x]));
    const seen = new Set();
    const out = (Array.isArray(v) ? v : []).map((item) => {
        if (!item || item.id == null) return item;
        seen.add(String(item.id));
        const prev = prevById.get(String(item.id));
        if (!prev) return { ...item, created_at: item.created_at || now, updated_at: item.updated_at || now };
        if (JSON.stringify(stripStamps(prev)) !== JSON.stringify(stripStamps(item))) return { ...item, created_at: item.created_at || prev.created_at || now, updated_at: now };
        return item;
    });
    prevArr.forEach((x) => { if (x && x.deleted && !seen.has(String(x.id))) out.push(x); });
    return JSON.stringify(out);
}
{
    const prev = [{ id: '1', amount: 100, created_at: T1, updated_at: T1 }, { id: '2', amount: 50, deleted: true, created_at: T1, updated_at: T1 }, { id: '3', amount: 7, created_at: T1, updated_at: T1 }];
    const frozen = JSON.stringify(prev);
    const input = [{ id: '1', amount: 100, created_at: T1, updated_at: T1 }, { id: '3', amount: 8, created_at: T1, updated_at: T1 }, { id: '4', amount: 9 }];
    const out = D.stampList(prev, input, NOW);
    equal('el resultado es el de antes (texto en localStorage)', out, JSON.parse(legacySet(frozen, input, NOW)));
    yes('lo que no cambio es EL MISMO registro guardado', out[0] === prev[0]);
    yes('lo que cambio es un registro nuevo, sellado ahora', out[1] !== prev[2] && out[1].updated_at === NOW && out[1].created_at === T1);
    yes('lo nuevo recibe fecha de alta y de cambio', out[2].created_at === NOW && out[2].updated_at === NOW && out[2] !== input[2]);
    yes('el anulado que no venia en la lista se conserva', out[3] === prev[1]);
    equal('la lista anterior no se modifica', JSON.stringify(prev), frozen);
    input[2].amount = 1000;
    equal('cambiar despues lo que se entrego no cambia lo guardado', out[2].amount, 9);
    const older = [{ id: '1', amount: 100, created_at: T1, updated_at: '2020-01-01T00:00:00.000Z' }];
    const kept = D.stampList(prev, older, NOW);
    yes('mismo contenido con otro sello: se guarda lo entregado (como antes), no el registro anterior', kept[0] !== prev[0] && kept[0].updated_at === '2020-01-01T00:00:00.000Z');
    equal('una lista que no es lista se guarda vacia (mas los anulados)', D.stampList(prev, null, NOW), [prev[1]]);
    equal('sin lista anterior todo es nuevo', D.stampList(null, [{ id: 'x' }], NOW), [{ id: 'x', created_at: NOW, updated_at: NOW }]);
    equal('los elementos sin id pasan como en JSON', D.stampList([], [null, undefined, { a: 1 }, { id: null, b: 2 }], NOW), [null, null, { a: 1 }, { id: null, b: 2 }]);

    // Miles de operaciones al azar contra el metodo anterior
    let text = '[]';
    let list = [];
    let differences = 0;
    let reused = 0;
    let clock = Date.parse(T1);
    const amounts = [425, 100.5, 0.1, 0.2, '300', 1e3];
    for (let step = 0; step < 1500; step++) {
        clock += 60000;
        const now = new Date(clock).toISOString();
        // Lo que OIKOS tiene en la mano: una copia de la lista (viva o completa), que modifica y vuelve a guardar
        let working = jsonCopy(JSON.parse(text));
        if (random() < 0.5) working = working.filter((x) => x && !x.deleted);
        const op = random();
        if (op < 0.35) working.push({ id: 'n' + step, type: pick(['income', 'charge', 'expense']), amount: pick(amounts), resiId: pick(['r1', 'r2', 'r3']), ...(random() < 0.3 ? { breakdown: { water: pick(amounts) } } : {}) });
        else if (op < 0.55 && working.length) { const t = pick(working); if (t) t.amount = pick(amounts); }
        else if (op < 0.7 && working.length) { const t = pick(working); if (t) { t.deleted = true; t.deleted_at = now; } }
        else if (op < 0.8 && working.length) working.splice(Math.floor(random() * working.length), 1);
        else if (op < 0.9 && working.length) { const t = pick(working); if (t) delete t.created_at; }
        else if (working.length) { const i = Math.floor(random() * working.length); working[i] = { ...working[i], updated_at: T1 }; }
        const before = list;
        text = legacySet(text, working, now);
        list = D.stampList(list, working, now);
        if (JSON.stringify(list) !== text) differences++;
        const previous = new Set(before);
        reused += list.filter((x) => previous.has(x)).length;
    }
    equal('1 500 operaciones al azar: la lista en memoria es identica al texto de antes', differences, 0);
    yes('y casi todos los registros se reutilizan sin copiarlos', reused > 1500 * 20, `(${reused})`);
}

// ───────── Saldos, indices y orden ─────────
console.log('\nSaldos, indices y orden');
{
    // Como _residentBalanceMap de OIKOS
    const legacyBalances = (arr) => {
        const map = new Map();
        arr.forEach((t) => {
            if (!t || t.deleted || !t.resiId) return;
            const amt = parseFloat(t.amount) || 0;
            const key = String(t.resiId);
            const prev = map.get(key) || 0;
            if (t.type === 'income') map.set(key, prev + amt);
            else if (t.type === 'charge') map.set(key, prev - amt);
        });
        return map;
    };
    const txs = [];
    for (let i = 0; i < 3000; i++) {
        txs.push(random() < 0.02 ? null : {
            id: 't' + i, type: pick(['income', 'charge', 'expense']), amount: pick([425, '425.10', 0.1, 0.2, 33.33, 'x', null]),
            resiId: pick(['r1', 'r2', 'r3', 4, undefined]), deleted: random() < 0.1
        });
    }
    equal('saldos iguales a los de antes, al centavo y al ultimo decimal', [...D.balanceMap(txs)], [...legacyBalances(txs)]);
    equal('saldos de una lista vacia o ausente', [[...D.balanceMap([])], [...D.balanceMap(null)]], [[], []]);
    const groups = D.byResident(txs);
    const expected = txs.filter((t) => t && !t.deleted && String(t.resiId) === 'r2');
    yes('movimientos vivos de un residente, en el orden de la lista', groups.get('r2').length === expected.length && groups.get('r2').every((t, i) => t === expected[i]));
    yes('el residente con id numerico se encuentra por su texto', groups.get('4').every((t) => t.resiId === 4));
    yes('los movimientos sin residente no se agrupan', !groups.has('undefined'));

    const records = [
        { id: 'b', created_at: T2 }, { id: 'c', created_at: T1 }, { id: 'a', created_at: T2 }, { id: 'z' }, { id: 'd', createdAt: T1 }, { id: 'a0', created_at: T1 }
    ];
    equal('orden al abrir: por fecha de alta y, a igual fecha, por id', D.canonicalOrder(records).map((r) => r.id), ['z', 'a0', 'c', 'd', 'a', 'b']);
    equal('ordenar no cambia la lista original', records.map((r) => r.id), ['b', 'c', 'a', 'z', 'd', 'a0']);
    // El orden que daba mergeList a un equipo sin copia: la nube llega por id y se ordena (estable) por fecha de alta
    const cloud = new Map(records.slice().sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r]));
    equal('es el orden que recibia un equipo sin copia local', D.canonicalOrder(records).map((r) => r.id), F.mergeList([], cloud).merged.map((r) => r.id));
}

// ───────── Memoria compartida ─────────
console.log('\nMemoria compartida con OIKOS');
{
    const store = D.createStore('oikos_multisys-c1_');
    const local = [];
    const remoteCalls = [];
    store.setLocalListener((kind) => local.push(kind));
    store.setRemoteListener((kind) => remoteCalls.push(kind));
    equal('empieza sin listas', [store.read('transactions'), store.version('transactions')], [null, 0]);
    const given = [{ id: 1 }];
    store.write('transactions', given);
    equal('cuando OIKOS guarda se avisa a la sincronizacion, no a OIKOS', [local, remoteCalls], [['transactions'], []]);
    yes('la lista guardada es un arreglo propio con los mismos registros', store.read('transactions') !== given && store.read('transactions')[0] === given[0]);
    store.replace('transactions', [{ id: 2 }], true);
    equal('cuando la sincronizacion aplica un cambio se avisa a OIKOS, no a si misma', [local, remoteCalls], [['transactions'], ['transactions']]);
    store.replace('residents', [], false);
    equal('sin aviso, OIKOS no se entera', remoteCalls, ['transactions']);
    equal('la version sube con cada escritura', [store.version('transactions'), store.version('residents'), store.version('settings')], [2, 1, 0]);
    store.setRemoteListener(() => { throw new Error('iframe recargando'); });
    let threw = false;
    try { store.replace('settings', { fee: 1 }, true); } catch { threw = true; }
    yes('si OIKOS se esta recargando el aviso no rompe la sincronizacion', !threw && store.read('settings').fee === 1);
    equal('el prefijo es el de OIKOS para ese condominio', store.prefix, 'oikos_' + F.oikosCompanyId('c1') + '_');
}

// ───────── Copia del equipo ─────────
console.log('\nCopia del equipo');
{
    const cache = D.memoryCache();
    let saved = await cache.load();
    equal('copia nueva: vacia', [saved.info, saved.records.size, saved.pending.length, saved.deltaCount], [null, 0, 0, 0]);
    await cache.resetMirror({ schema: D.SCHEMA, complete: false });
    await cache.appendChunk(0, [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], null);
    await cache.appendChunk(1, [{ id: 'c', v: 1 }], { schema: D.SCHEMA, complete: true, cursor: { s: 10, n: 0 } });
    await cache.applyDeltas([{ id: 'b', v: 2 }, { id: 'x/y', v: 1 }], { schema: D.SCHEMA, complete: true, cursor: { s: 20, n: 5 } });
    saved = await cache.load();
    equal('los cambios sueltos se aplican encima de los bloques', [...saved.records].map(([id, r]) => [id, r.v]), [['a', 1], ['b', 2], ['c', 1], ['x_y', 1]]);
    equal('recuerda hasta donde llego', [saved.info.cursor, saved.info.complete, saved.deltaCount], [{ s: 20, n: 5 }, true, 2]);
    saved.records.get('a').v = 99;
    equal('lo leido es una copia: modificarlo no cambia lo guardado', (await cache.load()).records.get('a').v, 1);
    await cache.putPending('transactions', [{ id: 'p1', amount: 5 }, { id: 'p2', amount: 6 }]);
    await cache.putPending('settings', [{ fee: 425 }]);
    await cache.deletePending('transactions', ['p1']);
    equal('los pendientes se guardan y se quitan por tipo e id', (await cache.load()).pending.map((p) => [p.kind, p.id]), [['transactions', 'p2'], ['settings', 'settings']]);
    await cache.compact([{ id: 'a', v: 1 }, { id: 'b', v: 2 }], { schema: D.SCHEMA, complete: true, cursor: { s: 30, n: 0 } });
    saved = await cache.load();
    equal('compactar deja solo bloques y conserva los pendientes', [saved.records.size, saved.deltaCount, saved.pending.length, saved.info.cursor.s], [2, 0, 2, 30]);
    await cache.resetMirror(null);
    saved = await cache.load();
    equal('vaciar el espejo conserva los pendientes', [saved.records.size, saved.pending.length], [0, 2]);

    const none = D.nullCache();
    await none.appendChunk(0, [{ id: 1 }], null);
    await none.putPending('transactions', [{ id: 1 }]);
    equal('sin IndexedDB la copia no guarda nada y no falla', [(await none.load()).records.size, none.persistent], [0, false]);
    equal('sin IndexedDB se abre la copia que no guarda', (await D.openCache('c1', { indexedDB: null, localStorage: null })).persistent, false);
    const warn = console.warn;
    console.warn = () => {};
    const broken = await D.openCache('c1', { indexedDB: { open() { throw new Error('bloqueado'); } }, localStorage: null });
    console.warn = warn;
    equal('si IndexedDB falla al abrir se sigue sin copia', broken.persistent, false);
    await D.destroyCaches({ indexedDB: null, localStorage: null });
    const calls = [];
    const fakeStorage = { data: { [D.REGISTRY_KEY]: '["c1","c2"]' }, getItem(k) { return this.data[k] || null; }, removeItem(k) { delete this.data[k]; }, setItem(k, v) { this.data[k] = v; } };
    await D.destroyCaches({ indexedDB: { deleteDatabase(name) { calls.push(name); const req = {}; setTimeout(() => req.onsuccess && req.onsuccess(), 0); return req; } }, localStorage: fakeStorage }, 500);
    equal('al cerrar sesion se borra la base de cada condominio anotado', [calls, fakeStorage.data], [[D.DB_PREFIX + 'c1', D.DB_PREFIX + 'c2'], {}]);
}

// ───────── Sincronizacion: funciones nuevas ─────────
console.log('\nSincronizacion: mezcla al abrir y cambios');
{
    const cloudList = [{ id: '1', v: 'nube', created_at: T1, updated_at: T1 }, { id: '2', v: 'nube', created_at: T2, updated_at: T1 }];
    const cloudById = new Map(cloudList.map((x) => [x.id, x]));
    let r = F.overlayList(cloudList, cloudById, [{ id: '2', v: 'local', updated_at: T2 }, { id: '9', v: 'solo aqui', updated_at: T1 }]);
    equal('lo local mas nuevo queda en el lugar de la nube; lo que solo existe aqui, al final', r.merged.map((x) => x.id + ':' + x.v), ['1:nube', '2:local', '9:solo aqui']);
    equal('y se sube', r.toPush.map((x) => x.id), ['2', '9']);
    yes('lo que no cambio es el mismo registro de la nube', r.merged[0] === cloudList[0]);
    r = F.overlayList(cloudList, cloudById, [{ id: '2', v: 'local', updated_at: T1 }]);
    equal('en empate gana la nube', [r.merged.map((x) => x.v), r.toPush.length], [['nube', 'nube'], 0]);
    r = F.overlayList(cloudList, cloudById, [{ id: '9', v: 'solo aqui' }], false);
    equal('lo que solo existe aqui se descarta si no quedo pendiente', [r.merged.length, r.toPush.length], [2, 0]);
    r = F.overlayList(cloudList, cloudById, [{ id: '2', v: 'a', updated_at: T2 }, { id: '2', v: 'b', updated_at: NOW }, null, { v: 'sin id' }]);
    equal('un id repetido cuenta una vez y lo que no tiene id se ignora', [r.merged.map((x) => x.v), r.toPush.length], [['nube', 'a'], 1]);
    yes('no modifica la lista de la nube', cloudList[1].v === 'nube' && r.merged !== cloudList);
    // Mismas decisiones que mergeList (la mezcla de siempre) con listas al azar
    let disagreements = 0;
    for (let i = 0; i < 300; i++) {
        const stamps = [T1, T2, NOW, undefined];
        const cloudItems = ['1', '2', '3', '4', '5'].filter(() => random() < 0.7).map((id) => ({ id, v: 'nube', updated_at: pick(stamps), created_at: T1 }));
        const localItems = ['1', '2', '3', '4', '5', '6', '7'].filter(() => random() < 0.5).map((id) => ({ id, v: 'local', updated_at: pick(stamps) }));
        const byId = new Map(cloudItems.map((x) => [x.id, x]));
        const keep = random() < 0.5;
        const a = F.mergeList(localItems, byId, keep);
        const b = F.overlayList(cloudItems, byId, localItems, keep);
        const view = (list) => JSON.stringify(list.map((x) => x.id + x.v).sort());
        if (view(a.merged) !== view(b.merged) || view(a.toPush) !== view(b.toPush)) disagreements++;
    }
    equal('300 mezclas al azar: mismas decisiones que la mezcla de siempre', disagreements, 0);

    const a = { id: '1', amount: 5, updated_at: T1 };
    const b = { id: '2', amount: 7, updated_at: T1 };
    const syncedObjects = new Map([['1', a], ['2', b]]);
    let d = F.diffList([a, b], syncedObjects, NOW);
    equal('los mismos registros: nada que subir', [d.changed.length, d.rewrite], [0, false]);
    d = F.diffList([{ ...a }, b], syncedObjects, NOW);
    equal('una copia identica tampoco es un cambio', d.changed.length, 0);
    const edited = { id: '1', amount: 6, updated_at: T2 };
    d = F.diffList([edited, b], syncedObjects, NOW);
    yes('un registro cambiado se sube tal cual', d.changed.length === 1 && d.changed[0] === edited && !d.rewrite);
    d = F.diffList([{ id: '1', amount: 6, updated_at: T1 }, b], syncedObjects, NOW);
    equal('cambio sin sello nuevo: se sella ahora y la lista se reescribe', [d.changed[0].updated_at, d.rewrite, d.items[0].updated_at], [NOW, true, NOW]);
    const input = [b];
    d = F.diffList(input, syncedObjects, NOW);
    equal('lo que desaparecio se anula', [d.changed.map((x) => [x.id, x.deleted, x.updated_at]), d.rewrite], [[['1', true, NOW]], true]);
    yes('sin modificar la lista recibida ni el registro sincronizado', input.length === 1 && a.deleted === undefined);
    equal('texto u objeto: lo sincronizado se entiende igual', F.diffList([edited, b], new Map([['1', F.canon(a)], ['2', F.canon(b)]]), NOW).changed.length, 1);

    // Deshacer: lo que se le dice a la nube cuando un registro deja de estar anulado, eliminado o finiquitado
    const annulled = { id: 'p1', amount: 5, deleted: true, deleted_at: T1, deleted_reason: 'error', updated_at: T1 };
    const undone = { id: 'p1', amount: 5, updated_at: T2 };
    equal('deshacer una anulacion: la nube recibe deleted:false y cuando se devolvio', F.revivedFields(undone, annulled), { deleted: false, restored_at: T2 });
    const sortedKeys = (o) => Object.keys(o).sort().reduce((out, k) => { out[k] = o[k]; return out; }, {});
    equal('y no se le pide borrar el motivo ni la fecha de la anulacion (quedan como rastro)', sortedKeys(F.changedData(undone, annulled)), { deleted: false, id: 'p1', restored_at: T2, updated_at: T2 });
    equal('si el registro ya trae deleted:false solo se anota cuando se devolvio', sortedKeys(F.changedData({ ...undone, deleted: false, deleted_at: T1, deleted_reason: 'error' }, annulled)), { deleted: false, id: 'p1', restored_at: T2, updated_at: T2 });
    equal('anular no es devolver', F.revivedFields(annulled, { id: 'p1', amount: 5, updated_at: T1 }), {});
    equal('un cambio cualquiera no toca esos campos', sortedKeys(F.changedData({ id: 'p1', amount: 5, notes: 'x', updated_at: T2 }, { id: 'p1', amount: 5, updated_at: T1 })), { id: 'p1', notes: 'x', updated_at: T2 });
    equal('deshacer un finiquito: el residente vuelve a estar activo en la nube', F.revivedFields({ id: 'r1', updated_at: T2 }, { id: 'r1', status: 'closed', closedAt: T1, closeReason: 'vendio', updated_at: T1 }), { status: 'active' });
    equal('un residente reactivado desde OIKOS ya trae su estado', F.revivedFields({ id: 'r1', status: 'active', updated_at: T2 }, { id: 'r1', status: 'closed', updated_at: T1 }), {});
    equal('registro nuevo: nada que devolver', [F.revivedFields(undone, null), F.revivedFields(null, annulled)], [{}, {}]);
    equal('devolver una anulacion sigue pidiendo "deshacer" (reciente) y nada mas', F.movementNeeds({ ...undone, type: 'income' }, { ...annulled, type: 'income', updated_at: new Date().toISOString() }), [['finanzas.deshacer']]);
    equal('aunque el registro local ya traiga el rastro de una devolucion anterior', F.movementNeeds({ ...undone, type: 'income' }, { ...annulled, type: 'income', restored_at: T1, updated_at: new Date().toISOString() }), [['finanzas.deshacer']]);
    equal('la copia vieja no arrastra el sello del servidor', [F.withoutServerStamp({ id: 1, server_at: { seconds: 5, nanoseconds: 0 }, amount: 2 }), F.withoutServerStamp({ id: 2 }), F.withoutServerStamp(null)], [{ id: 1, amount: 2 }, { id: 2 }, null]);

    equal('sello del servidor desde un Timestamp', F.stampValue({ seconds: 100, nanoseconds: 7 }), { s: 100, n: 7 });
    equal('sello guardado en la copia', F.stampValue({ s: 100, n: 7 }), { s: 100, n: 7 });
    equal('sin sello', [F.stampValue(null), F.stampValue('x'), F.stampValue({})], [null, null, null]);
    equal('el sello mas reciente', [F.laterStamp({ s: 1, n: 9 }, { s: 2, n: 0 }), F.laterStamp({ s: 2, n: 5 }, { s: 2, n: 4 }), F.laterStamp(null, { s: 1, n: 0 }), F.laterStamp({ s: 1, n: 0 }, null)], [{ s: 2, n: 0 }, { s: 2, n: 5 }, { s: 1, n: 0 }, { s: 1, n: 0 }]);
    equal('margen hacia atras', [F.stampMinus({ s: 1000, n: 3 }, 300000), F.stampMinus({ s: 10, n: 0 }, 300000), F.stampMinus(null, 1000)], [{ s: 700, n: 3 }, { s: 0, n: 0 }, { s: 0, n: 0 }]);
    const nowMs = Date.parse(NOW);
    equal('un sello imposible (muy adelantado) no cuenta', [F.saneStamp({ s: nowMs / 1000, n: 0 }, nowMs), F.saneStamp({ s: nowMs / 1000 + 3 * 86400, n: 0 }, nowMs), F.saneStamp(null, nowMs)], [true, false, false]);

    const info = (extra) => ({ schema: D.SCHEMA, complete: true, loadedAt: NOW, cursor: { s: 1, n: 0 }, ...extra });
    equal('sin copia: se baja todo', F.mirrorPlan(null, D.SCHEMA, nowMs, false), 'cargar');
    equal('copia reciente: solo se piden los cambios', F.mirrorPlan(info(), D.SCHEMA, nowMs + 86400000, false), 'usar');
    equal('copia vencida (mas de 30 dias): se baja todo', F.mirrorPlan(info(), D.SCHEMA, nowMs + F.MIRROR_MAX_AGE_MS + 1000, false), 'cargar');
    equal('copia de otro formato: se baja todo', F.mirrorPlan(info({ schema: D.SCHEMA + 1 }), D.SCHEMA, nowMs, false), 'cargar');
    equal('a pedido (recargar=1): se baja todo', F.mirrorPlan(info(), D.SCHEMA, nowMs, true), 'cargar');
    equal('carga interrumpida hace poco: se retoma', F.mirrorPlan(info({ complete: false, lastId: 'x', chunks: 2 }), D.SCHEMA, nowMs + 3600000, false), 'retomar');
    equal('carga interrumpida hace mucho: se empieza de nuevo', F.mirrorPlan(info({ complete: false, lastId: 'x', chunks: 2 }), D.SCHEMA, nowMs + F.RESUME_MAX_AGE_MS + 1000, false), 'cargar');
    equal('carga interrumpida antes de la primera pagina: se empieza de nuevo', F.mirrorPlan(info({ complete: false, lastId: null, chunks: 0 }), D.SCHEMA, nowMs, false), 'cargar');
    equal('fecha ilegible: se baja todo', F.mirrorPlan(info({ loadedAt: 'ayer' }), D.SCHEMA, nowMs, false), 'cargar');
    yes('la pagina de lectura cabe en lo que entrega el emulador', F.PAGE_SIZE > 0 && F.PAGE_SIZE <= 5000);
}

// ───────── El Store de OIKOS: memoria contra localStorage ─────────
console.log('\nStore de OIKOS: en memoria da lo mismo que en localStorage');
{
    const html = read('finanzas/index.html');
    const from = html.indexOf('        // ========== COMPANY-SCOPED STORE ==========');
    const to = html.indexOf('        let myChart, currentView');
    yes('se encuentra el Store en finanzas/index.html', from > 0 && to > from);
    const storeCode = html.slice(from, to) + '\n;globalThis.__api = { Store, sisdelMem, sisdelDerived };';
    const clock = { now: Date.parse(T1) };
    // Mismo reloj para los dos: new Date() sin argumentos es la hora de la prueba
    class FakeDate extends Date { constructor(...args) { if (args.length) super(...args); else super(clock.now); } }
    function makeOikos(memory) {
        const storage = new Map();
        const localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
        const sessionStorage = { getItem: (k) => (k === 'oikos_active_company' ? 'multisys-c1' : null) };
        const window = {};
        window.parent = memory ? { sisdelFinanzasStore: memory } : window;
        const ctx = vm.createContext({ window, localStorage, sessionStorage, SisdelFinanzasDatos: D, Date: FakeDate, console });
        vm.runInContext(storeCode, ctx);
        return { ...ctx.__api, storage };
    }
    const memory = D.createStore('oikos_multisys-c1_');
    const pushes = [];
    memory.setLocalListener((kind) => pushes.push(kind));
    const mem = makeOikos(memory);
    const old = makeOikos(null);
    yes('con la memoria de SISDEL el Store la usa', mem.sisdelMem() === memory);
    yes('sin ella sigue en localStorage', old.sisdelMem() === null);
    yes('la memoria de otro condominio no se usa', makeOikos(D.createStore('oikos_multisys-otro_')).sisdelMem() === null);

    const same = (label) => {
        const view = (o) => JSON.stringify([o.Store.getRaw('residents'), o.Store.getRaw('transactions'), o.Store.getRaw('settings'), o.Store.get('residents'), o.Store.get('transactions'), o.Store.getDeleted('transactions'), o.Store.txOf('r2'), o.Store.snapshot('transactions')]);
        return view(mem) === view(old) ? null : label;
    };
    equal('vacio: mismos valores por defecto', same('vacio'), null);
    yes('la configuracion por defecto es una copia nueva cada vez', mem.Store.get('settings') !== mem.Store.get('settings'));

    const both = (fn) => { fn(mem.Store); fn(old.Store); };
    const failuresAt = [];
    const amounts = [425, 100.5, 0.1, 0.2, 33.33, 1250];
    for (let step = 0; step < 1200; step++) {
        clock.now += 60000;
        const op = random();
        const choice = Math.floor(random() * 1000);
        const amount = pick(amounts);
        const type = pick(['income', 'charge', 'expense']);
        const resident = pick(['r1', 'r2', 'r3']);
        if (op < 0.08) both((S) => { const res = S.get('residents'); res.push({ id: 'r' + (res.length + 1), name: 'Residente ' + step, unit: 'Lote ' + step, balance: 0 }); S.set('residents', res); });
        else if (op < 0.14) both((S) => { const res = S.get('residents'); if (res.length) { res[choice % res.length].notes = 'nota ' + step; S.set('residents', res); } });
        // Como handleTransactionSubmit: suma al saldo del residente y guarda las dos listas
        else if (op < 0.5) both((S) => {
            const txs = S.get('transactions');
            const tx = { id: 't' + step, date: new FakeDate().toISOString(), type, amount, concept: 'Movimiento ' + step, resiId: type === 'expense' ? undefined : resident, ...(type === 'charge' ? { kind: 'fee', period: '2026-11', breakdown: { maintenance: amount } } : {}) };
            const res = S.get('residents');
            const i = res.findIndex((r) => r.id === tx.resiId);
            if (i > -1) { res[i].balance += amount; S.set('residents', res); }
            txs.push(tx); S.set('transactions', txs);
        });
        // Como deleteTransaction: anula sobre la lista cruda
        else if (op < 0.65) both((S) => { const raw = S.getRaw('transactions'); const live = raw.filter((t) => t && !t.deleted); if (live.length) { const tx = live[choice % live.length]; tx.deleted = true; tx.deleted_at = new FakeDate().toISOString(); tx.deleted_reason = 'prueba'; S.set('transactions', raw); } });
        // Como deshacer: vuelve a una foto anterior
        else if (op < 0.75) both((S) => { const snap = S.snapshot('transactions'); const cut = snap.slice(0, Math.max(0, snap.length - 1 - (choice % 3))); S.set('transactions', cut); });
        // Modificar un movimiento vivo y guardar la lista viva (los anulados no vienen)
        else if (op < 0.85) both((S) => { const txs = S.get('transactions'); if (txs.length) { txs[choice % txs.length].amount = amount; S.set('transactions', txs); } });
        // Como la migracion: tocar la lista cruda sin cambiar nada
        else if (op < 0.9) both((S) => { S.set('transactions', S.getRaw('transactions')); });
        else both((S) => { const s = S.get('settings'); s.fee = amount; s.chargedMonths = (s.chargedMonths || []).concat('2026-' + String(1 + (choice % 12)).padStart(2, '0')); S.set('settings', s); });
        const bad = same('paso ' + step);
        if (bad) { failuresAt.push(bad); break; }
    }
    equal('1 200 operaciones al azar (altas, pagos, anulaciones, deshacer, configuracion): mismas listas, saldos y fotos', failuresAt, []);
    yes('hubo movimientos, anulados y residentes en la prueba', mem.Store.getRaw('transactions').length > 100 && mem.Store.getDeleted('transactions').length > 10 && mem.Store.get('residents').length > 3);
    yes('en memoria no se escribe nada en localStorage', mem.storage.size === 0 && old.storage.size === 3);
    yes('cada guardado avisa a la sincronizacion', pushes.length > 1000 && pushes.includes('settings') && pushes.includes('residents'));
    const first = mem.Store.get('transactions')[0];
    first.amount = -1;
    yes('lo que entrega el Store es una copia: modificarlo no cambia lo guardado', mem.Store.get('transactions')[0].amount !== -1);
    yes('la foto para deshacer es la lista guardada (no una copia)', mem.Store.snapshot('transactions') === memory.read('transactions'));
    const balances = mem.sisdelDerived(memory, 'balances', D.balanceMap);
    yes('los saldos se calculan una vez por cambio de la lista', mem.sisdelDerived(memory, 'balances', D.balanceMap) === balances);
    mem.Store.set('transactions', mem.Store.getRaw('transactions').concat({ id: 'ultimo', type: 'income', amount: 1, resiId: 'r1' }));
    yes('y se vuelven a calcular cuando la lista cambia', mem.sisdelDerived(memory, 'balances', D.balanceMap) !== balances);
}

// ───────── Conexiones entre archivos ─────────
console.log('\nConexiones');
{
    const fin = read('finanzas.html');
    const oikos = read('finanzas/index.html');
    const core = read('sisdel-core.js');
    const sync = read('finanzas-sync.js');
    const version = (html) => (html.match(/finanzas-datos\.js\?v=(\w+)/) || [])[1];
    yes('finanzas.html y OIKOS cargan finanzas-datos.js con la misma version', !!version(fin) && version(fin) === version(oikos));
    yes('finanzas.html lo carga antes que la sincronizacion', fin.indexOf('finanzas-datos.js') > 0 && fin.indexOf('finanzas-datos.js') < fin.indexOf('finanzas-sync.js'));
    yes('OIKOS lo carga antes de su codigo', oikos.indexOf('finanzas-datos.js') > 0 && oikos.indexOf('finanzas-datos.js') < oikos.indexOf('const Store = {'));
    yes('finanzas-datos.js no tiene errores de sintaxis', (() => { try { new vm.Script(read('finanzas-datos.js')); return true; } catch { return false; } })());
    yes('al cerrar sesion sisdel-core.js borra las mismas bases que crea finanzas-datos.js', core.includes(`'${D.DB_PREFIX}' + id`) && core.includes(`'${D.REGISTRY_KEY}'`));
    yes('y no las borra si quedaron cambios sin subir', /sisdel_fin_pendiente_'\)\)\) return Promise\.resolve\(\)/.test(core));
    yes('la sincronizacion ya no guarda las listas en localStorage', !/localStorage\.setItem\(storageKey/.test(sync) && !/function writeRaw/.test(sync));
    yes('los movimientos se bajan por paginas y los cambios por el sello del servidor', /orderBy\(fs\.FieldPath\.documentId\(\)\)\.limit\(pageSize\)/.test(sync) && /where\(SERVER_STAMP, '>'/.test(sync));
    yes('el sello del servidor nunca llega a OIKOS ni se sube', /delete record\[SERVER_STAMP\]/.test(sync) && !/server_at/.test(oikos));
    yes('el servidor y el navegador usan el mismo nombre de sello', require('../functions/src/finanzas/sello.js').SERVER_STAMP === 'server_at' && /const SERVER_STAMP = 'server_at'/.test(sync));
    yes('las reglas no dejan que un cliente cree un movimiento con sello', /!\('server_at' in request\.resource\.data\)/.test(read('firestore.rules')));
    yes('OIKOS: deshacer usa la foto sin copiar y la contabilidad se pinta por tramos', /Store\.snapshot\('transactions'\)/.test(oikos) && /function showMoreAccounting\(\)/.test(oikos));
}

// ───────── Sello del servidor (functions/src/finanzas/sello.js) ─────────
console.log('\nSello del servidor');
{
    const S = require('../functions/src/finanzas/sello.js');
    const ts = (ms) => ({ ms, toMillis() { return this.ms; }, isEqual(other) { return !!other && other.ms === this.ms; } });
    yes('un movimiento nuevo sin sello se sella', S.needsStamp(null, { id: 1 }));
    yes('un sello que no es una fecha del servidor cuenta como si no hubiera', S.needsStamp(null, { id: 1, server_at: { seconds: 5, nanoseconds: 0 } }) && S.needsStamp({ id: 1, server_at: ts(5) }, { id: 1, server_at: 'ayer' }));
    yes('uno nuevo que ya trae sello (lo creo el servidor) no', !S.needsStamp(null, { id: 1, server_at: ts(5) }));
    yes('un cambio que deja el sello de antes se sella', S.needsStamp({ id: 1, server_at: ts(5) }, { id: 1, deleted: true, server_at: ts(5) }));
    yes('el sellado mismo no se vuelve a sellar', !S.needsStamp({ id: 1 }, { id: 1, server_at: ts(5) }) && !S.needsStamp({ id: 1, server_at: ts(5) }, { id: 1, server_at: ts(9) }));
    yes('un documento borrado no se sella', !S.needsStamp({ id: 1 }, null));
    yes('si solo cambio el sello no hay nada que recalcular', S.onlyStampChanged({ id: 1, amount: 5 }, { amount: 5, id: 1, server_at: ts(5) }) && S.onlyStampChanged({ id: 1, server_at: ts(5) }, { id: 1, server_at: ts(9) }));
    yes('si cambio algo mas, se recalcula', !S.onlyStampChanged({ id: 1, amount: 5 }, { id: 1, amount: 6, server_at: ts(5) }) && !S.onlyStampChanged(null, { id: 1 }) && !S.onlyStampChanged({ id: 1, server_at: ts(5) }, { id: 1, deleted: true, server_at: ts(5) }));
    const now = 1e12;
    yes('tarea diaria: sello al dia, no se toca', !S.staleStamp(ts(now - 1000), ts(now - 1000), now) && !S.staleStamp(ts(now - 1000), ts(now - 2500), now));
    yes('tarea diaria: escrito despues de su sello, se repone', S.staleStamp(ts(now - 1000), ts(now - 60000), now));
    yes('tarea diaria: reciente y sin sello, se repone', S.staleStamp(ts(now - 3600000), undefined, now));
    yes('tarea diaria: lo anterior al sello no hace falta sellarlo', !S.staleStamp(ts(now - S.RECENT_MS - 1000), undefined, now));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
