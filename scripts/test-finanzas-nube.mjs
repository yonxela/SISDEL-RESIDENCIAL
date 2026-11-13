// Pruebas de extremo a extremo de la sincronizacion del Sistema Financiero (finanzas-sync.js) contra los emuladores:
// el mismo codigo que corre en finanzas.html, con varios "equipos" a la vez. Cada equipo tiene su sesion, su
// almacenamiento y su copia local (en memoria: ver memoryCache en finanzas-datos.js), asi se puede cerrar y volver
// a abrir como si fuera el navegador. Lo que hace OIKOS al guardar (Store.set) se imita con stampList.
// Los disparadores de functions quedan siempre activos (como en produccion): cada movimiento recibe su sello.
// Uso: levantar emuladores, correr seed-emulator.mjs y luego este archivo (tambien corre con npm test).
import { createRequire } from 'node:module';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/functions';
import { PROJECT_ID, EMULATOR } from './lib.mjs';
import { connect, emulatorTriggersRespond } from './admin.mjs';

const require = createRequire(import.meta.url);
const D = require('../finanzas-datos.js');
const PRIV = require('../privilegios.js');

const SisdelFinanzas = require('../finanzas-sync.js');
const { internals: F } = SisdelFinanzas;

const CONDO = 'condo-prueba-nube';
const ADMIN_CODE = 'PN9001';
const AUDITOR_CODE = 'PN9002';
// Paginas chicas para probar la carga por paginas con pocos movimientos
const PAGE = 40;
const SEEDED = 130;
const adminDb = connect('emulator');
// Los rechazos esperados (privilegios) no deben llenar la salida
firebase.firestore.setLogLevel('silent');
const condoRef = adminDb.doc(`condominios/${CONDO}`);
const txRef = (id) => condoRef.collection('finanzas_movimientos').doc(id);

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(name, fn, timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        try { last = await fn(); if (last) { record(name, true); return last; } } catch (e) { last = e.code || e.message; }
        await sleep(250);
    }
    record(name, false, `-> no se cumplio en ${timeoutMs / 1000}s (${JSON.stringify(last)})`);
    return null;
}
function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

const T0 = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const pad = (n) => String(n).padStart(5, '0');

async function seedCondo() {
    await adminDb.recursiveDelete(condoRef);
    const start = iso(0);
    const writes = [];
    const add = (ref, data) => writes.push({ ref, data });
    add(condoRef, { id: CONDO, name: 'Condominio Prueba Nube', address: 'Prueba', phone: '', active: true, hasQR: true, hasManual: true, hasLPR: false, reminderEnabled: false, gracePeriodDays: 15, serviceExpiry: null, moraAutomatica: true, createdAt: start });
    const users = [
        { id: 'u-pn-admin', code: ADMIN_CODE, name: 'Admin Prueba Nube', role: 'admin' },
        { id: 'u-pn-auditor', code: AUDITOR_CODE, name: 'Auditora Prueba Nube', role: 'auditor' },
        { id: 'pn-1', code: 'PN9011', name: 'Ana Uno', role: 'vecino', casa: 'Lote 1', paymentStatus: 'al_dia' },
        { id: 'pn-2', code: 'PN9012', name: 'Luis Dos', role: 'vecino', casa: 'Lote 2', paymentStatus: 'al_dia' },
        { id: 'pn-3', code: 'PN9013', name: 'Rosa Tres', role: 'vecino', casa: 'Lote 3', paymentStatus: 'al_dia' }
    ];
    users.forEach(({ code, ...user }) => {
        add(condoRef.collection('usuarios').doc(user.id), { casa: '', phone: '5555-0000', email: '', paymentStatus: null, morosoSince: null, active: true, createdAt: start, updatedAt: start, ...user, condominioId: CONDO });
        add(adminDb.doc(`codigos/${code}`), { condominioId: CONDO, userId: user.id, role: user.role, createdAt: start });
        if (user.role === 'vecino') add(condoRef.collection('finanzas_residentes').doc(user.id), { id: user.id, dpi: '100' + user.id.slice(-1), feeFrom: '2026-01', createdAt: start, updated_at: start });
    });
    add(condoRef.collection('finanzas_config').doc('oikos_settings'), { currency: 'GTQ', lang: 'es', name: 'Condominio Prueba Nube', fee: 425, chargeDay: 1, graceDays: 5, feeMode: 'manual', updated_at: start });
    for (let i = 1; i <= SEEDED; i++) {
        const id = 'm-' + pad(i);
        const at = iso(i);
        const kind = i % 3;
        add(txRef(id), kind === 0
            ? { id, date: at, type: 'expense', amount: 10 + (i % 7), concept: 'Limpieza', receiptNum: 'EG' + pad(i), created_at: at, updated_at: at }
            : kind === 1
                ? { id, date: at, type: 'charge', kind: 'extra', amount: 100, concept: 'Cargo de prueba', resiId: 'pn-' + (1 + (i % 3)), created_at: at, updated_at: at }
                : { id, date: at, type: 'income', amount: 100, concept: 'Abono', receiptNum: 'AB' + pad(i), resiId: 'pn-' + (1 + (i % 3)), created_at: at, updated_at: at });
    }
    for (let i = 0; i < writes.length; i += 400) {
        const batch = adminDb.batch();
        writes.slice(i, i + 400).forEach(({ ref, data }) => batch.set(ref, data));
        await batch.commit();
    }
}
const stampedCount = async () => (await condoRef.collection('finanzas_movimientos').where('server_at', '>', new Date(0)).count().get()).data().count;

let deviceCount = 0;
const devices = [];
// Abre el Sistema Financiero en un "equipo". cache y storage sobreviven a cerrar y abrir.
async function open(code, options = {}) {
    const app = firebase.initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'equipo-' + (++deviceCount));
    app.auth().useEmulator(`http://${EMULATOR.auth}`, { disableWarnings: true });
    const db = app.firestore();
    const [host, port] = EMULATOR.firestore.split(':');
    db.useEmulator(host, Number(port));
    const functions = app.functions('us-central1');
    functions.useEmulator(...EMULATOR.functions);
    const login = await functions.httpsCallable('login')({ code });
    if (!login.data.success) throw new Error('No se pudo entrar con ' + code);
    await app.auth().signInWithCustomToken(login.data.token);
    const events = { status: [], remote: [], blocked: [], progress: [], created: [] };
    const device = {
        app, db, events, cache: options.cache || D.memoryCache(), storage: options.storage || memoryStorage(),
        closed: false,
        async close() { if (this.closed) return; this.closed = true; this.sync.dispose(); await app.delete(); }
    };
    devices.push(device);
    // finanzas-sync.js espera el navegador: se le da lo minimo, y solo mientras arranca (con un `window`
    // presente todo el tiempo, la libreria de sesiones de Firebase cree que esta en un navegador)
    globalThis.window = { firebase, SisdelFinanzasDatos: D, sisdelFirebase: { db }, addEventListener() {}, removeEventListener() {} };
    try {
        device.sync = SisdelFinanzas.start(CONDO, {
            cache: device.cache, storage: device.storage, reload: options.reload, can: options.can, pageSize: PAGE,
            onStatus: (s) => events.status.push(s), onRemoteChange: (k) => events.remote.push(k),
            onBlocked: (b) => events.blocked.push(b), onProgress: (c) => events.progress.push(c),
            newAccessCode: () => 'PN' + (7000 + Math.floor(Math.random() * 999)), onResidentCreated: (name, code) => events.created.push([name, code])
        });
    } finally {
        delete globalThis.window;
    }
    device.store = device.sync.store;
    await device.sync.ready;
    return device;
}
// Lo que hace OIKOS al guardar una lista o la configuracion (Store.set en finanzas/index.html)
function oikosSet(device, kind, change) {
    const now = new Date().toISOString();
    if (kind === 'settings') {
        const settings = D.cloneJson(device.store.read('settings'));
        change(settings);
        device.store.write('settings', D.cloneJson({ ...settings, updated_at: now }));
        return;
    }
    const working = D.cloneList(device.store.read(kind) || []);
    const next = change(working) || working;
    device.store.write(kind, D.stampList(device.store.read(kind), next, now));
}
async function denied(name, fn) {
    try { await fn(); record(name, false, '-> se esperaba denegado'); } catch (e) { record(name, String(e.code).includes('permission-denied'), `-> ${e.code || e.message}`); }
}
const txOf = (device, id) => (device.store.read('transactions') || []).find((t) => t && t.id === id);
const idsOf = (device) => (device.store.read('transactions') || []).map((t) => t.id);
const cloudTx = async (id) => { const snap = await txRef(id).get(); return snap.exists ? snap.data() : null; };
const isTimestamp = (v) => !!v && typeof v.toMillis === 'function';
const pendingOf = (device) => [...device.cache.state.pending.keys()];

async function run() {
    console.log('\nPreparacion');
    if (!(await emulatorTriggersRespond(adminDb, 10000))) throw new Error('los disparadores de functions no responden: reinicie los emuladores');
    await seedCondo();
    await waitFor(`condominio de prueba: el servidor sello sus ${SEEDED} movimientos`, async () => (await stampedCount()) === SEEDED, 60000);

    // ───────── Primera apertura: baja todo por paginas ─────────
    console.log('\nPrimera apertura');
    let a = await open(ADMIN_CODE);
    equal('baja todos los movimientos', a.store.read('transactions').length, SEEDED);
    equal(`por paginas de ${PAGE}: una carga completa en ${Math.ceil(SEEDED / PAGE)} bloques`, [a.cache.stats.resets, a.cache.stats.chunks], [1, Math.ceil(SEEDED / PAGE)]);
    equal('avisa el avance hasta el total', [a.events.progress[0], Math.max(...a.events.progress)], [0, SEEDED]);
    record('la lista queda en orden de alta', idsOf(a).every((id, i, list) => i === 0 || list[i - 1] < id));
    equal('trae los residentes (vecinos de SISDEL con sus datos financieros)', a.store.read('residents').map((r) => [r.id, r.name, r.unit, r.dpi]), [['pn-1', 'Ana Uno', 'Lote 1', '1001'], ['pn-2', 'Luis Dos', 'Lote 2', '1002'], ['pn-3', 'Rosa Tres', 'Lote 3', '1003']]);
    equal('trae la configuracion', [a.store.read('settings').fee, a.store.read('settings').feeMode], [425, 'manual']);
    equal('queda guardado en la nube y sin pendientes', [a.events.status[a.events.status.length - 1], pendingOf(a)], ['ok', []]);
    record('ningun movimiento lleva el sello del servidor hacia OIKOS', a.store.read('transactions').every((t) => !('server_at' in t)));
    equal('la copia del equipo quedo completa', [a.cache.state.info.complete, a.cache.state.info.schema], [true, D.SCHEMA]);
    const firstList = JSON.stringify(a.store.read('transactions'));

    // ───────── Segunda apertura: usa la copia del equipo ─────────
    console.log('\nSegunda apertura (con la copia del equipo)');
    await a.close();
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('no vuelve a bajar todo', [a.cache.stats.resets, a.cache.stats.chunks], [1, Math.ceil(SEEDED / PAGE)]);
    record('y la lista es identica a la de la primera vez', JSON.stringify(a.store.read('transactions')) === firstList);

    // ───────── Un pago registrado en un equipo ─────────
    console.log('\nRegistrar y anular entre dos equipos');
    const payment = { id: 'pago-a-1', date: new Date().toISOString(), type: 'income', amount: 425, concept: 'Cuota - Noviembre 2026', receiptNum: 'AU0001', resiId: 'pn-1' };
    oikosSet(a, 'transactions', (txs) => { txs.push(payment); });
    record('queda anotado en este equipo antes de subir', pendingOf(a).includes('transactions:pago-a-1') && a.storage.getItem(F.pendingKey(CONDO)) === '1');
    record('se guarda en la nube', await a.sync.waitIdle(15000));
    const savedPayment = await cloudTx('pago-a-1');
    equal('con sus datos y sus fechas', [savedPayment.amount, savedPayment.resiId, typeof savedPayment.created_at, savedPayment.updated_at === txOf(a, 'pago-a-1').updated_at], [425, 'pn-1', 'string', true]);
    equal('y deja de estar pendiente', [pendingOf(a), a.storage.getItem(F.pendingKey(CONDO))], [[], null]);
    const stamped = await waitFor('el servidor le pone su sello', async () => { const d = await cloudTx('pago-a-1'); return isTimestamp(d.server_at) ? d : null; });
    await waitFor('el equipo guarda hasta donde vio (para pedir solo lo nuevo)', () => a.cache.state.info.cursor && a.cache.state.info.cursor.s >= stamped.server_at.seconds);
    equal('su propio pago, al volver sellado, no cuenta como cambio de otro equipo', a.events.remote, []);

    const b = await open(ADMIN_CODE);
    record('otro equipo lo ve al abrir', !!txOf(b, 'pago-a-1') && b.store.read('transactions').length === SEEDED + 1);
    // B lo anula (como deleteTransaction: sobre la lista con anulados)
    oikosSet(b, 'transactions', (txs) => { const t = txs.find((x) => x.id === 'pago-a-1'); t.deleted = true; t.deleted_at = new Date().toISOString(); t.deleted_reason = 'prueba'; });
    await b.sync.waitIdle(15000);
    await waitFor('la anulacion llega al primer equipo sin recargar', () => { const t = txOf(a, 'pago-a-1'); return t && t.deleted === true && t.deleted_reason === 'prueba'; });
    equal('y se le avisa que otro usuario hizo cambios', a.events.remote.includes('remote'), true);
    const annulled = await cloudTx('pago-a-1');
    equal('en la nube el pago sigue existiendo, anulado, con todos sus datos', [annulled.deleted, annulled.amount, annulled.receiptNum], [true, 425, 'AU0001']);
    await waitFor('la anulacion recibe un sello mas nuevo', async () => { const d = await cloudTx('pago-a-1'); return isTimestamp(d.server_at) && d.server_at.toMillis() > stamped.server_at.toMillis(); });

    // Deshacer la anulacion (la foto de antes no trae los campos de la anulacion): la nube debe decir lo mismo que la pantalla
    oikosSet(b, 'transactions', (txs) => { const t = txs.find((x) => x.id === 'pago-a-1'); delete t.deleted; delete t.deleted_at; delete t.deleted_reason; });
    record('deshacer la anulacion se guarda', await b.sync.waitIdle(15000));
    const restored = await cloudTx('pago-a-1');
    equal('en la nube el pago deja de estar anulado', restored.deleted, false);
    equal('y queda el rastro: motivo y fecha de la anulacion, y cuando se devolvio', [restored.deleted_reason, typeof restored.deleted_at, restored.restored_at === txOf(b, 'pago-a-1').updated_at], ['prueba', 'string', true]);
    await waitFor('el otro equipo lo vuelve a ver vivo', () => { const t = txOf(a, 'pago-a-1'); return t && t.deleted === false; });
    // Y se vuelve a anular (rehacer), para seguir con el pago anulado
    oikosSet(b, 'transactions', (txs) => { const t = txs.find((x) => x.id === 'pago-a-1'); t.deleted = true; t.deleted_at = new Date().toISOString(); t.deleted_reason = 'prueba'; });
    await b.sync.waitIdle(15000);
    equal('volver a anular funciona igual', (await cloudTx('pago-a-1')).deleted, true);
    await waitFor('y llega al otro equipo', () => txOf(a, 'pago-a-1').deleted === true);

    // Lo mismo con un residente: eliminar y deshacer, finiquitar y deshacer
    const extraOf = async (id) => (await condoRef.collection('finanzas_residentes').doc(id).get()).data();
    oikosSet(b, 'residents', (res) => { const r = res.find((x) => x.id === 'pn-2'); r.deleted = true; r.deleted_at = new Date().toISOString(); });
    await b.sync.waitIdle(15000);
    equal('residente eliminado en OIKOS: marcado en la nube (no borrado)', (await extraOf('pn-2')).deleted, true);
    oikosSet(b, 'residents', (res) => { const r = res.find((x) => x.id === 'pn-2'); delete r.deleted; delete r.deleted_at; });
    await b.sync.waitIdle(15000);
    equal('deshacer la eliminacion llega a la nube, con rastro', await (async () => { const e = await extraOf('pn-2'); return [e.deleted, typeof e.deleted_at, typeof e.restored_at]; })(), [false, 'string', 'string']);
    oikosSet(b, 'residents', (res) => { const r = res.find((x) => x.id === 'pn-2'); r.status = 'closed'; r.closedAt = new Date().toISOString(); r.closeReason = 'Vendió'; });
    await b.sync.waitIdle(15000);
    equal('finiquito guardado', (await extraOf('pn-2')).status, 'closed');
    oikosSet(b, 'residents', (res) => { const r = res.find((x) => x.id === 'pn-2'); delete r.status; delete r.closedAt; delete r.closeReason; });
    await b.sync.waitIdle(15000);
    equal('deshacer el finiquito: activo en la nube, con el motivo del finiquito como rastro', await (async () => { const e = await extraOf('pn-2'); return [e.status, e.closeReason]; })(), ['active', 'Vendió']);

    // B edita un residente y cambia la configuracion: A lo recibe
    oikosSet(b, 'residents', (res) => { res.find((r) => r.id === 'pn-2').notes = 'Paga por transferencia'; });
    oikosSet(b, 'settings', (s) => { s.graceDays = 7; });
    await b.sync.waitIdle(15000);
    await waitFor('los datos de un residente y la configuracion tambien llegan', () => a.store.read('residents').find((r) => r.id === 'pn-2').notes === 'Paga por transferencia' && a.store.read('settings').graceDays === 7);
    await b.close();

    // ───────── Cambios mientras el equipo estaba cerrado ─────────
    console.log('\nCambios mientras el equipo estaba cerrado');
    await waitFor('el equipo ya vio el ultimo sello antes de cerrarse', async () => { const d = await cloudTx('pago-a-1'); return a.cache.state.info.cursor && isTimestamp(d.server_at) && a.cache.state.info.cursor.s >= d.server_at.seconds; });
    await a.close();
    // El servidor genera una cuota y alguien anula un movimiento viejo desde otro equipo
    const later = new Date().toISOString();
    await txRef('fee_pn-1_2026-11').set({ id: 'fee_pn-1_2026-11', date: later, type: 'charge', kind: 'fee', period: '2026-11', amount: 425, concept: 'Cuota - Noviembre 2026', resiId: 'pn-1', auto: true, serverGenerated: true, created_at: later, updated_at: later });
    await txRef('m-00002').set({ deleted: true, deleted_at: later, deleted_reason: 'desde otro equipo', updated_at: later }, { merge: true });
    await waitFor('el servidor sella los dos cambios', async () => isTimestamp((await cloudTx('fee_pn-1_2026-11')).server_at) && isTimestamp((await cloudTx('m-00002')).server_at));
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('al abrir de nuevo no baja todo', a.cache.stats.resets, 1);
    record('pero trae lo que cambio: la cuota nueva y la anulacion', !!txOf(a, 'fee_pn-1_2026-11') && txOf(a, 'm-00002').deleted === true);
    equal('la lista sigue completa', a.store.read('transactions').length, SEEDED + 2);

    // ───────── Un sello atrasado (el disparador no corrio): la tarea diaria lo repone ─────────
    console.log('\nSello repuesto por la tarea diaria');
    await a.close();
    // Se imita un cambio que quedo con el sello de antes: el movimiento cambia ahora pero su sello dice "hace una hora"
    const { Timestamp: AdminTimestamp } = require('firebase-admin/firestore');
    await txRef('m-00003').set({ deleted: true, deleted_reason: 'sello atrasado', updated_at: new Date().toISOString(), server_at: AdminTimestamp.fromMillis(Date.now() - 3600000) }, { merge: true });
    await sleep(1500);
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('con el sello atrasado el cambio todavia no llega a un equipo con copia', txOf(a, 'm-00003').deleted, undefined);
    await a.close();
    const { recalcCondo } = require('../functions/src/finanzas/recalc.js');
    equal('la tarea diaria repone ese sello (y solo ese)', (await recalcCondo(CONDO, new Date(), { sweep: true })).stamped, 1);
    equal('en la siguiente pasada ya no hay nada que reponer', (await recalcCondo(CONDO, new Date(), { sweep: true })).stamped, 0);
    const deltasSweep = a.cache.stats.deltas;
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('y entonces llega', [txOf(a, 'm-00003').deleted, txOf(a, 'm-00003').deleted_reason], [true, 'sello atrasado']);
    record('los cambios tambien se piden por paginas (mas de una)', a.cache.stats.deltas - deltasSweep > PAGE && a.store.read('transactions').length === SEEDED + 2, `(${a.cache.stats.deltas - deltasSweep})`);
    equal('sin la opcion, el recalculo no toca sellos', (await recalcCondo(CONDO, new Date())).stamped, undefined);
    // Un vecino quitado del Sistema Financiero que figuraba moroso vuelve a estar al dia (antes este caso detenia el recalculo)
    await condoRef.collection('usuarios').doc('pn-3').update({ paymentStatus: 'moroso', morosoSince: later });
    await condoRef.collection('finanzas_residentes').doc('pn-3').set({ deleted: true }, { merge: true });
    const recalculated = await recalcCondo(CONDO, new Date());
    equal('el recalculo del condominio termina aunque haya un vecino quitado que figuraba moroso', [recalculated.active, (await condoRef.collection('usuarios').doc('pn-3').get()).data().paymentStatus], [true, 'al_dia']);
    await condoRef.collection('finanzas_residentes').doc('pn-3').set({ deleted: false }, { merge: true });

    // ───────── Sin conexion: lo pendiente sobrevive a cerrar la pagina ─────────
    console.log('\nCambios sin subir');
    await a.db.disableNetwork();
    oikosSet(a, 'transactions', (txs) => { txs.push({ id: 'pago-sin-red', date: new Date().toISOString(), type: 'income', amount: 200, concept: 'Abono', receiptNum: 'AU0002', resiId: 'pn-2' }); });
    await sleep(800);
    equal('sin conexion queda pendiente en el equipo', [a.sync.hasPending(), pendingOf(a), await cloudTx('pago-sin-red')], [true, ['transactions:pago-sin-red'], null]);
    await a.close();
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    record('al volver a abrir (con conexion) se muestra', !!txOf(a, 'pago-sin-red'));
    await a.sync.waitIdle(15000);
    equal('y se sube solo', [(await cloudTx('pago-sin-red')).amount, pendingOf(a)], [200, []]);
    equal('sin bajar todo de nuevo', a.cache.stats.resets, 1);

    // ───────── Lo que el usuario no puede hacer ─────────
    console.log('\nPrivilegios');
    const auditor = await open(AUDITOR_CODE, { can: (key) => PRIV.has('auditor', {}, key) });
    equal('quien solo consulta abre y ve todo', auditor.store.read('transactions').length, a.store.read('transactions').length);
    oikosSet(auditor, 'transactions', (txs) => { txs.push({ id: 'pago-auditor', date: new Date().toISOString(), type: 'income', amount: 1, concept: 'No deberia', resiId: 'pn-1' }); });
    await auditor.sync.waitIdle(10000);
    equal('si intenta registrar un pago se descarta: ni en su lista, ni pendiente, ni en la nube', [!!txOf(auditor, 'pago-auditor'), pendingOf(auditor), await cloudTx('pago-auditor'), auditor.events.blocked.map((x) => [x.kind, x.count])], [false, [], null, [['transactions', 1]]]);
    await auditor.close();
    const Timestamp = firebase.firestore.Timestamp;
    const clientTx = (id) => a.db.collection(`condominios/${CONDO}/finanzas_movimientos`).doc(id);
    await denied('un cliente no puede crear un movimiento con sello del servidor', () => clientTx('con-sello').set({ id: 'con-sello', type: 'income', amount: 5, concept: 'x', resiId: 'pn-1', server_at: Timestamp.now() }));
    await denied('ni adelantar el sello de uno existente', () => clientTx('pago-a-1').set({ server_at: new Timestamp(4102444800, 0), updated_at: new Date().toISOString() }, { merge: true }));
    await denied('ni cambiarlo por otro valor', () => clientTx('pago-a-1').set({ server_at: { seconds: 1, nanoseconds: 0 }, updated_at: new Date().toISOString() }, { merge: true }));
    // Reescribir el documento entero (sin el sello) se admite: el servidor lo repone
    const before = await cloudTx('m-00005');
    const { server_at: _stamp, ...withoutStamp } = before;
    let allowedFull = true;
    try { await clientTx('m-00005').set({ ...withoutStamp, deleted: true, deleted_reason: 'documento entero', updated_at: new Date().toISOString() }); } catch { allowedFull = false; }
    record('anular reescribiendo el documento entero sigue permitido', allowedFull);
    await waitFor('y el servidor le repone el sello', async () => isTimestamp((await cloudTx('m-00005')).server_at));

    // ───────── Copia de la version anterior (localStorage) ─────────
    console.log('\nCopia de la version anterior');
    const old = idsOf(a).slice(0, 3).map((id) => D.cloneJson(txOf(a, id)));
    const legacyStorage = memoryStorage({
        // La version anterior guardaba el sello del servidor pegado a cada movimiento (como objeto): no debe subirse
        [F.storageKey(CONDO, 'transactions')]: JSON.stringify([
            ...old.map((t, i) => (i === 0 ? { ...t, deleted: true, deleted_at: later, deleted_reason: 'anulado sin subir', updated_at: new Date().toISOString(), server_at: { seconds: 1, nanoseconds: 0 } } : { ...t, server_at: { seconds: 1, nanoseconds: 0 } })),
            { id: 'pago-viejo', date: later, type: 'income', amount: 300, concept: 'Abono', receiptNum: 'AU0003', resiId: 'pn-3', created_at: later, updated_at: later, server_at: { seconds: 1, nanoseconds: 0 } }
        ]),
        [F.storageKey(CONDO, 'residents')]: JSON.stringify(D.cloneJson(a.store.read('residents'))),
        [F.storageKey(CONDO, 'settings')]: JSON.stringify({ currency: 'GTQ', fee: 1, updated_at: iso(-10) }),
        [F.pendingKey(CONDO)]: '1'
    });
    const c = await open(ADMIN_CODE, { storage: legacyStorage });
    await c.sync.waitIdle(15000);
    equal('lo que habia quedado sin subir en la copia vieja se sube', (await cloudTx('pago-viejo') || {}).amount, 300);
    equal('sin quedar rechazado por el sello que la copia vieja traia pegado', c.events.status[c.events.status.length - 1], 'ok');
    equal('la anulacion que estaba sin subir tambien llega', await (async () => { const d = await cloudTx(old[0].id); return [d.deleted, d.deleted_reason]; })(), [true, 'anulado sin subir']);
    await waitFor('y el sello de esos movimientos sigue siendo el del servidor', async () => isTimestamp((await cloudTx('pago-viejo')).server_at) && isTimestamp((await cloudTx(old[0].id)).server_at));
    record('en OIKOS ningun movimiento trae el sello', c.store.read('transactions').every((t) => !('server_at' in t)));
    equal('la configuracion vieja no pisa la de la nube', [c.store.read('settings').fee, (await condoRef.collection('finanzas_config').doc('oikos_settings').get()).data().fee], [425, 425]);
    equal('y la copia vieja se borra del equipo', ['transactions', 'residents', 'settings'].map((k) => legacyStorage.getItem(F.storageKey(CONDO, k))), [null, null, null]);
    equal('la lista del equipo queda completa', c.store.read('transactions').length, a.store.read('transactions').length + (txOf(a, 'pago-viejo') ? 0 : 1));
    await c.close();

    // ───────── Rehacer la copia ─────────
    console.log('\nRehacer la copia del equipo');
    await a.close();
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage, reload: true });
    equal('a pedido (finanzas.html?recargar=1) se baja todo de nuevo', a.cache.stats.resets, 2);
    const total = a.store.read('transactions').length;
    equal('y queda igual que la nube', total, (await condoRef.collection('finanzas_movimientos').count().get()).data().count);
    await a.close();
    a.cache.state.info.loadedAt = new Date(Date.now() - F.MIRROR_MAX_AGE_MS - 60000).toISOString();
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('una copia de mas de 30 dias tambien se rehace sola', a.cache.stats.resets, 3);
    await a.close();
    // Carga interrumpida: quedo el primer bloque y hasta donde llego
    const firstChunk = a.cache.state.base.get(0);
    a.cache.state.base = new Map([[0, firstChunk]]);
    a.cache.state.delta.clear();
    a.cache.state.info = { schema: D.SCHEMA, complete: false, cursor: a.cache.state.info.cursor, loadedAt: new Date().toISOString(), lastId: firstChunk[firstChunk.length - 1].id, chunks: 1 };
    const chunksBefore = a.cache.stats.chunks;
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    equal('una carga interrumpida se retoma donde quedo (sin empezar de cero)', [a.cache.stats.resets, a.cache.stats.chunks - chunksBefore, a.cache.state.base.get(0) === firstChunk, a.store.read('transactions').length], [3, Math.ceil((total - firstChunk.length) / PAGE), true, total]);
    await a.close();
    // Muchos cambios sueltos: la copia se reescribe en bloques
    const loose = [...a.cache.state.base.values()].flat();
    a.cache.state.base.clear();
    loose.forEach((r) => a.cache.state.delta.set(F.docIdOf(r), r));
    const realLoad = a.cache.load.bind(a.cache);
    a.cache.load = async () => ({ ...(await realLoad()), deltaCount: D.COMPACT_AFTER + 1 });
    a = await open(ADMIN_CODE, { cache: a.cache, storage: a.storage });
    await waitFor('con muchos cambios sueltos la copia se compacta', () => a.cache.stats.compactions === 1 && a.cache.state.delta.size === 0);
    equal('sin perder ningun movimiento, y en orden de alta', [[...a.cache.state.base.values()].flat().length, JSON.stringify([...a.cache.state.base.values()].flat().map((r) => r.id)) === JSON.stringify(idsOf(a))], [total, true]);

    // ───────── Bitacora: el rastro de cada cambio, en el servidor ─────────
    console.log('\nBitacora');
    const logOf = async (collection, docId) => (await condoRef.collection('bitacora').where('docId', '==', docId).get()).docs.map((d) => d.data()).filter((e) => e.collection === collection);
    const actions = (entries) => entries.map((e) => e.action).sort();
    const paymentLog = await waitFor('el pago tiene anotado todo lo que le paso: alta, anulacion, devolucion y nueva anulacion', async () => { const e = await logOf('finanzas_movimientos', 'pago-a-1'); return JSON.stringify(actions(e)) === JSON.stringify(['anular', 'anular', 'crear', 'restaurar']) ? e : null; });
    if (paymentLog) {
        const created = paymentLog.find((e) => e.action === 'crear');
        // La primera anulacion trae el motivo; la segunda no lo cambia (ya estaba en el documento, como rastro)
        const annulledEntry = paymentLog.find((e) => e.action === 'anular' && e.changes.deleted_reason);
        const restoredEntry = paymentLog.find((e) => e.action === 'restaurar');
        equal('el alta guarda lo que se registro', [created.subject.amount, created.subject.resiId, created.changes.receiptNum.to, created.changes.amount], [425, 'pn-1', 'AU0001', { from: null, to: 425 }]);
        equal('la anulacion guarda el motivo y el valor de antes y de despues', [annulledEntry.changes.deleted.to, annulledEntry.changes.deleted_reason.to], [true, 'prueba']);
        equal('la devolucion guarda que dejo de estar anulado y cuando', [restoredEntry.changes.deleted, typeof restoredEntry.changes.restored_at.to], [{ from: true, to: false }, 'string']);
        record('cada anotacion lleva la hora del servidor y de quien vino el cambio', paymentLog.every((e) => isTimestamp(e.at) && typeof e.actorType === 'string' && 'actorId' in e && 'actorName' in e));
        record('el sello del servidor no genera anotaciones ni aparece en ellas', paymentLog.length === 4 && paymentLog.every((e) => !('server_at' in e.changes)));
    }
    const residentLog = await logOf('finanzas_residentes', 'pn-2');
    record('el residente: eliminado, devuelto, finiquitado y reactivado quedan anotados', actions(residentLog).filter((x) => x === 'anular').length >= 1 && actions(residentLog).includes('restaurar') && residentLog.some((e) => e.changes.status && e.changes.status.to === 'closed') && residentLog.some((e) => e.changes.status && e.changes.status.from === 'closed' && e.changes.status.to === 'active'), JSON.stringify(actions(residentLog)));
    const settingsLog = await logOf('finanzas_config', 'oikos_settings');
    record('el cambio de configuracion queda con el valor de antes y el de despues', settingsLog.some((e) => e.changes.graceDays && e.changes.graceDays.from === 5 && e.changes.graceDays.to === 7));
    const userLog = await waitFor('el estado de pago que cambia el servidor tambien queda anotado', async () => { const e = await logOf('usuarios', 'pn-3'); return e.some((x) => x.changes.paymentStatus && x.changes.paymentStatus.to === 'al_dia' && x.changes.paymentStatus.from === 'moroso') ? e : null; });
    record('y el alta de cada usuario', !!userLog && userLog.some((e) => e.action === 'crear' && e.subject.name === 'Rosa Tres'));
    // Un movimiento eliminado por un script deja su contenido completo
    await txRef('m-00010').delete();
    const deletedLog = await waitFor('lo eliminado queda anotado', async () => { const e = await logOf('finanzas_movimientos', 'm-00010'); return e.find((x) => x.action === 'eliminar') || null; });
    record('con su contenido completo', !!deletedLog && deletedLog.changes.amount.from === 100 && deletedLog.changes.amount.to === null && deletedLog.subject.concept === 'Cargo de prueba', JSON.stringify(deletedLog && deletedLog.subject));
    await txRef('m-00010').set({ id: 'm-00010', date: iso(10), type: 'charge', kind: 'extra', amount: 100, concept: 'Cargo de prueba', resiId: 'pn-2', created_at: iso(10), updated_at: iso(10) });

    // Nadie la escribe, la cambia ni la borra desde una pantalla; la leen el administrador y el auditor
    const anEntry = (await condoRef.collection('bitacora').limit(1).get()).docs[0];
    const clientLog = a.db.collection(`condominios/${CONDO}/bitacora`);
    await denied('el administrador no puede escribir en la bitacora', () => clientLog.doc('falsa').set({ action: 'crear', collection: 'usuarios', docId: 'x' }));
    await denied('ni cambiar una anotacion', () => clientLog.doc(anEntry.id).update({ actorName: 'Otro' }));
    await denied('ni borrarla', () => clientLog.doc(anEntry.id).delete());
    record('el administrador la puede leer', (await clientLog.where('docId', '==', 'pago-a-1').get()).size === 4);
    const reader = async (code) => {
        const app = firebase.initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'lector-' + code);
        app.auth().useEmulator(`http://${EMULATOR.auth}`, { disableWarnings: true });
        const db = app.firestore();
        db.useEmulator(EMULATOR.firestore.split(':')[0], Number(EMULATOR.firestore.split(':')[1]));
        const functions = app.functions('us-central1');
        functions.useEmulator(...EMULATOR.functions);
        await app.auth().signInWithCustomToken((await functions.httpsCallable('login')({ code })).data.token);
        return { db, close: () => app.delete() };
    };
    const auditorReader = await reader(AUDITOR_CODE);
    record('el auditor tambien', (await auditorReader.db.collection(`condominios/${CONDO}/bitacora`).where('docId', '==', 'pago-a-1').get()).size === 4);
    await auditorReader.close();
    const neighbor = await reader('PN9011');
    await denied('un vecino no la lee', () => neighbor.db.collection(`condominios/${CONDO}/bitacora`).limit(1).get());
    await neighbor.close();

    // Quien: en el emulador el evento no trae la sesion real, asi que se prueba la anotacion directamente
    const { record: writeEntry } = require('../functions/src/bitacora');
    const sample = (actorType, actorId) => ({ collection: 'usuarios', docId: 'prueba-quien', action: 'cambiar', actorType, actorId, subject: {}, changes: { phone: { from: '1', to: '2' } }, eventTime: null });
    const entryOf = async (id) => (await condoRef.collection('bitacora').doc(id).get()).data();
    equal('un usuario del condominio queda con su nombre y su rol', [await writeEntry(CONDO, 'quien-1', sample('unknown', 'u-pn-admin')), (await entryOf('quien-1')).actorName, (await entryOf('quien-1')).actorRole, (await entryOf('quien-1')).actorId], [true, 'Admin Prueba Nube', 'admin', 'u-pn-admin']);
    equal('el master queda como Master', [await writeEntry(CONDO, 'quien-2', sample('unknown', 'master')), (await entryOf('quien-2')).actorName], [true, 'Master']);
    equal('lo que hace el servidor queda como Servidor', [await writeEntry(CONDO, 'quien-3', sample('service_account', 'firebase-adminsdk@x.iam.gserviceaccount.com')), (await entryOf('quien-3')).actorName], [true, 'Servidor']);
    equal('un identificador desconocido queda tal como llego', [await writeEntry(CONDO, 'quien-4', sample('unknown', 'no-existe')), (await entryOf('quien-4')).actorId, (await entryOf('quien-4')).actorName], [true, 'no-existe', '']);
    await writeEntry(CONDO, 'quien-1', sample('unknown', 'u-pn-admin'));
    equal('el mismo evento dos veces se anota una sola vez', (await condoRef.collection('bitacora').where('docId', '==', 'prueba-quien').get()).size, 4);
    equal('de un condominio que no existe (o se esta eliminando) no se anota nada', [await writeEntry('condo-que-no-existe', 'quien-5', sample('unknown', 'x')), (await adminDb.collection('condominios/condo-que-no-existe/bitacora').get()).size], [false, 0]);

    // ───────── Restaurar una lista vaciada ─────────
    console.log('\nRestaurar');
    a.store.write('transactions', []);
    await waitFor('si OIKOS vacia la lista se restaura desde la nube (nada se borra alla)', () => a.store.read('transactions').length === total && a.events.remote.includes('restored'));
    equal('y la nube conserva todo', (await condoRef.collection('finanzas_movimientos').count().get()).data().count, total);
    await a.close();
}

run().catch((error) => { console.error(error); failures.push('error inesperado: ' + error.message); }).finally(async () => {
    await Promise.all(devices.map((d) => d.close().catch(() => {})));
    // El condominio de prueba no queda en el emulador
    try {
        await adminDb.recursiveDelete(condoRef);
        await sleep(1500);
        await adminDb.recursiveDelete(condoRef);
        const codes = await adminDb.collection('codigos').where('condominioId', '==', CONDO).get();
        const batch = adminDb.batch();
        codes.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    } catch (error) { console.error('No se pudo limpiar el condominio de prueba', error.message); }
    console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
    if (failures.length) failures.forEach((f) => console.log('  - ' + f));
    process.exit(failures.length ? 1 : 0);
});
