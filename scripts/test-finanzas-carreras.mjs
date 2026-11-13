// Pruebas de las "carreras" de la sincronizacion del Sistema Financiero (finanzas-sync.js): que pasa cuando dos cosas
// ocurren casi a la vez (deshacer justo cuando llega el sello del servidor, crear y deshacer antes de que suba, dos
// pestanas sobre la misma copia del equipo). Con el emulador dependerian del azar; aqui se usa un Firestore de
// mentira (firestore-falso.mjs) donde el orden se decide en la prueba. Sin emuladores ni navegador.
// Cada caso salio de la revision independiente del 2026-11-13: antes de corregirlo dejaba un pago anulado o
// resucitado, o una copia del equipo incompleta marcada como completa.
// Uso: node test-finanzas-carreras.mjs (tambien corre con npm test).
import { createServer, open, seed, oikosSet, oikosGet, txDoc, live, sleep, deviceCache, D, CONDO, memoryStorage } from './firestore-falso.mjs';

let passed = 0;
const failures = [];
function yes(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    yes(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}
// Los rechazos y cortes de estas pruebas son a proposito: no deben llenar la salida
console.error = () => {};
console.warn = () => {};

const payment = (id) => ({ id, type: 'income', amount: 250, concept: 'Pago', resiId: 'v1', date: new Date().toISOString() });
// Lo que el equipo tiene anotado como pendiente: en la copia y en el respaldo de localStorage
const pending = (device) => ({
    copia: [...device.cache.state.pending.keys()],
    respaldo: Object.keys(JSON.parse(device.storage.getItem(D.PENDING_PREFIX + CONDO) || '{}'))
});
const NOTHING = { copia: [], respaldo: [] };
const marker = (device) => device.storage.getItem('sisdel_fin_pendiente_' + CONDO);
const lastStatus = (device) => device.events.status[device.events.status.length - 1];
const add = (device, tx) => oikosSet(device, 'transactions', oikosGet(device, 'transactions').concat(tx));
const removeTx = (device, id) => oikosSet(device, 'transactions', oikosGet(device, 'transactions').filter((t) => t.id !== id));
const cloudCount = (server) => [...server.docs.keys()].filter((k) => k.includes('/finanzas_movimientos/')).length;
const reopen = (server, device) => open(server, { cache: device.cache, storage: device.storage });

console.log('\nLinea base');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    add(a, payment('p0'));
    await a.sync.waitIdle();
    server.stamp(CONDO, 'p0'); await sleep(30);
    equal('un pago se sube, queda vivo y nada queda pendiente', [!!txDoc(server, 'p0'), live(a).includes('p0'), pending(a), marker(a), lastStatus(a)], [true, true, NOTHING, null, 'ok']);
    a.close();
    const b = await reopen(server, a);
    equal('y al volver a abrir esta igual', [live(b).length, live(b).includes('p0')], [6, true]);
    b.close();
}

console.log('\nDeshacer un alta justo cuando llega su sello del servidor');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    add(a, payment('p1'));
    await a.sync.waitIdle();
    removeTx(a, 'p1');                         // Ctrl+Z: la lista ya no trae el pago
    server.stamp(CONDO, 'p1'); await sleep(60); // el sello de su alta llega antes de que suba la anulacion (300 ms)
    equal('el pago no reaparece en pantalla', live(a).includes('p1'), false);
    equal('ni se avisa de un cambio de otro equipo (no lo hubo)', a.events.remote, []);
    await sleep(400); await a.sync.waitIdle();
    equal('y la nube queda con el pago anulado, no vivo', txDoc(server, 'p1').deleted, true);
    equal('sin nada pendiente', [pending(a), lastStatus(a)], [NOTHING, 'ok']);
    a.close();
    const b = await reopen(server, a);
    equal('al volver a abrir sigue anulado, en pantalla y en la nube', [live(b).includes('p1'), txDoc(server, 'p1').deleted], [false, true]);
    b.close();
}

console.log('\nCrear y deshacer antes de que suba');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    add(a, payment('p2'));
    removeTx(a, 'p2');
    await sleep(400); await a.sync.waitIdle();
    equal('no llega a la nube ni queda pendiente', [!!txDoc(server, 'p2'), pending(a), marker(a), lastStatus(a)], [false, NOTHING, null, 'ok']);
    a.close();
    const b = await reopen(server, a);
    equal('y al volver a abrir no resucita', [live(b).includes('p2'), !!txDoc(server, 'p2')], [false, false]);
    b.close();
}

console.log('\nUn alta que el servidor rechazo y luego se deshace');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    server.failCommit = (writes) => (writes.some((w) => w.path.endsWith('/p3')) ? 'permission-denied' : null);
    add(a, payment('p3'));
    await sleep(400); await a.sync.waitIdle(1000);
    equal('rechazada: queda en pantalla, pendiente y con aviso', [live(a).includes('p3'), pending(a).copia, pending(a).respaldo, lastStatus(a), marker(a)], [true, ['transactions:p3'], ['transactions:p3'], 'denied', '1']);
    removeTx(a, 'p3');
    await sleep(400); await a.sync.waitIdle(1000);
    equal('al deshacerla deja de estar pendiente', pending(a), NOTHING);
    a.close(); server.failCommit = null;
    const b = await reopen(server, a);
    await b.sync.waitIdle();
    equal('y al volver a abrir no aparece ni se crea en la nube', [live(b).includes('p3'), !!txDoc(server, 'p3')], [false, false]);
    b.close();
}

console.log('\nDeshacer y rehacer enseguida un pago que ya estaba en la nube');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    add(a, payment('p4'));
    await a.sync.waitIdle();
    server.stamp(CONDO, 'p4'); await sleep(30);
    const kept = a.store.read('transactions');
    removeTx(a, 'p4');                          // deshacer
    a.store.write('transactions', kept);        // rehacer: vuelve la lista de antes
    await sleep(400); await a.sync.waitIdle();
    equal('el pago sigue vivo en pantalla y en la nube, sin nada pendiente', [live(a).includes('p4'), txDoc(server, 'p4').deleted, pending(a)], [true, undefined, NOTHING]);
    a.close();
    const b = await reopen(server, a);
    await b.sync.waitIdle();
    equal('y al volver a abrir no se anula', [live(b).includes('p4'), txDoc(server, 'p4').deleted], [true, undefined]);
    b.close();
}

console.log('\nUna subida rechazada no queda tapada por otra que sale bien');
{
    const server = createServer(); seed(server, 5);
    const a = await open(server);
    server.failCommit = (writes) => (writes.some((w) => w.path.endsWith('/p9')) ? 'permission-denied' : null);
    add(a, payment('p9'));
    await sleep(400); await a.sync.waitIdle(1000);
    // Despues se guarda la configuracion, que si sube
    a.store.write('settings', D.cloneJson({ ...a.store.read('settings'), graceDays: 9, updated_at: new Date().toISOString() }));
    await sleep(400);
    const idle = await a.sync.waitIdle(1000);
    equal('la configuracion subio', server.docs.get(`condominios/${CONDO}/finanzas_config/oikos_settings`).graceDays, 9);
    equal('pero el estado sigue avisando del pago que no subio', [lastStatus(a), marker(a), idle], ['denied', '1', false]);
    equal('que sigue en pantalla y anotado como pendiente', [live(a).includes('p9'), !!txDoc(server, 'p9'), pending(a).copia], [true, false, ['transactions:p9']]);
    a.close();
}

console.log('\nDos pestanas sobre la misma copia del equipo');
{
    // Los movimientos son anteriores al sello (sin server_at): solo llegan en una carga completa
    const server = createServer(); seed(server, 200, false);
    const a = await open(server);
    equal('la primera pestana abre con todo', live(a).length, 200);
    // Otra pestana rehace la copia (finanzas.html?recargar=1) y se corta en la tercera pagina
    let pages = 0;
    server.failGet = (col, spec, deviceId) => deviceId !== a.deviceId && col.endsWith('finanzas_movimientos') && (spec.orderBy || [])[0] === '__name__' && ++pages === 3;
    const b = await open(server, { cache: deviceCache(a.storage, a.cache.state), storage: a.storage, reload: true, noWait: true });
    let cut = null;
    await b.sync.ready.catch((e) => { cut = e.message; });
    b.close(); server.failGet = null;
    equal('la segunda se corta a media carga: la copia queda incompleta', [cut, a.cache.state.info.complete, a.cache.state.base.size], ['unavailable', false, 2]);
    // La primera sigue abierta y recibe un cambio de otro equipo
    server.apply([{ op: 'set', path: `condominios/${CONDO}/finanzas_movimientos/x1`, data: { id: 'x1', type: 'expense', amount: 5, concept: 'Luz', date: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }], 'otro-equipo');
    server.stamp(CONDO, 'x1'); await sleep(60);
    equal('la primera lo muestra', live(a).includes('x1'), true);
    equal('pero NO marca como completa una copia que otra pestana dejo a medias', [a.cache.state.info.complete, a.cache.state.delta.size], [false, 0]);
    a.close();
    const c = await open(server, { cache: deviceCache(a.storage, a.cache.state), storage: a.storage });
    equal('la siguiente apertura termina la carga y trae todo', [live(c).length, cloudCount(server), c.cache.state.info.complete], [201, 201, true]);
    c.close();
}
{
    // Primera carga en dos pestanas casi a la vez; la segunda se cierra enseguida
    const server = createServer(); seed(server, 200, false);
    const storage = memoryStorage();
    const first = deviceCache(storage);
    const isPage = (spec) => (spec.orderBy || [])[0] === '__name__';
    let secondPages = 0;
    server.delayGet = (col, spec, deviceId) => {
        if (!col.endsWith('finanzas_movimientos')) return 0;
        if (deviceId === 'pestana-1') return isPage(spec) ? 10 : 0;   // la primera baja una pagina cada 10 ms
        return isPage(spec) ? 0 : 25;                                 // la segunda empieza un poco despues
    };
    server.failGet = (col, spec, deviceId) => deviceId !== 'pestana-1' && col.endsWith('finanzas_movimientos') && isPage(spec) && ++secondPages >= 1;
    const a = await open(server, { deviceId: 'pestana-1', cache: first, storage, noWait: true });
    const b = await open(server, { deviceId: 'pestana-2', cache: deviceCache(storage, first.state), storage, noWait: true });
    let cut = null;
    await Promise.all([a.sync.ready, b.sync.ready.catch((e) => { cut = e.message; })]);
    equal('la primera termina con todo en pantalla aunque la otra haya vaciado la copia', [live(a).length, cut], [200, 'unavailable']);
    equal('y la copia no queda marcada como completa', first.state.info.complete, false);
    a.close(); b.close(); server.failGet = null; server.delayGet = null;
    const c = await open(server, { cache: deviceCache(storage, first.state), storage });
    equal('la siguiente apertura trae todo', [live(c).length, c.cache.state.info.complete], [200, true]);
    c.close();
}

console.log('\nLo de siempre sigue igual');
{
    const server = createServer(); seed(server, 90);
    const a = await open(server);
    equal('carga por paginas (de 40): tres bloques', [live(a).length, a.cache.state.base.size, a.cache.stats.resets], [90, 3, 1]);
    // Una lista vacia no se sube: se restaura desde la nube
    a.store.write('transactions', []);
    await sleep(400); await a.sync.waitIdle();
    equal('una lista vaciada se restaura desde la nube sin escribir nada alla', [live(a).length, cloudCount(server), server.log.length, a.events.remote.includes('restored')], [90, 90, 0, true]);
    // Anular y devolver: la nube conserva el rastro
    const raw = a.store.read('transactions').map(D.cloneRecord);
    const target = raw.find((t) => t.id === 'm-0007');
    Object.assign(target, { deleted: true, deleted_at: new Date().toISOString(), deleted_reason: 'error' });
    oikosSet(a, 'transactions', raw);
    await sleep(400); await a.sync.waitIdle();
    const before = a.store.read('transactions');
    oikosSet(a, 'transactions', before.map(D.cloneRecord).map((t) => { if (t.id === 'm-0007') { delete t.deleted; delete t.deleted_at; delete t.deleted_reason; } return t; }));
    await sleep(400); await a.sync.waitIdle();
    const doc = txDoc(server, 'm-0007');
    equal('anular y devolver: la nube queda sin anular y con el rastro', [doc.deleted, doc.deleted_reason, typeof doc.restored_at, 'server_at' in (server.log[server.log.length - 1].data)], [false, 'error', 'string', false]);
    yes('las fotos de deshacer (listas guardadas) no se modificaron', before.find((t) => t.id === 'm-0007').deleted === true);
    a.close();
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
process.exit(failures.length ? 1 : 0);
