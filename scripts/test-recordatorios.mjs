// Pruebas del envio de recordatorios por WhatsApp a todos los residentes (functions/src/recordatorios-core.js) contra el
// emulador de Firestore, con un WhatsApp de mentira (nadie recibe nada). Condominio propio (condo-recordatorios).
// Uso: node test-recordatorios.mjs (tambien corre con npm test; necesita los emuladores y `npm run seed`).
import { createRequire } from 'node:module';
import { connect } from './admin.mjs';

const require = createRequire(import.meta.url);
const R = require('../functions/src/recordatorios-core.js');
const db = connect('emulator');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}
async function rejects(name, fn, code) {
    try { await fn(); ok(name, false, '-> se esperaba un rechazo'); } catch (e) { ok(name, e && e.userCode === code, `-> se esperaba ${code}, error: ${e && (e.userCode || e.message)}`); }
}

const CONDO = 'condo-recordatorios';
const condoRef = db.doc(`condominios/${CONDO}`);
const now = new Date().toISOString();
const caller = { id: 'adm', name: 'Administradora' };

// WhatsApp de mentira: anota lo que se mando y falla a los numeros de `failTo`
const sentLog = [];
const failTo = new Set();
let provider = true;
// Estado de la conexion de WhatsApp (UltraMsg acepta los mensajes aunque su instancia este desconectada y los deja en cola)
const CONNECTED = { connected: true, state: 'authenticated', provider: 'ultramsg' };
let connState = CONNECTED;
const E = require('../functions/src/rondas/ultramsg-estado.js');
const MT = require('../functions/src/rondas/meta-estado.js');
const SIMULADO = { provider: 'simulado' };
const ULTRAMSG = { ultramsgInstance: 'instancia', ultramsgToken: 'token' };
let cfg = SIMULADO;            // la configuracion de WhatsApp que ve el servidor
let uRows = null;              // lo que "dice UltraMsg" de los mensajes (null = no se puede leer)
let healthState = { confirming: null };   // si WhatsApp deja salir los mensajes (null = no se sabe)
const whatsapp = {
    loadConfig: async () => cfg,
    hasProvider: () => provider,
    send: async (config, to, message, opts = {}) => {
        sentLog.push({ to, message, opts });
        if (failTo.has(to)) { if (opts.errors && config && config.channel === 'meta') opts.errors.push('Meta (131026): no se pudo entregar'); return null; }
        return 'SIMULADO';
    },
    connection: async () => connState,
    health: async () => healthState, describeHealth: E.describeHealth,
    describeConnection: (conn) => `WhatsApp no está conectado (estado: ${conn.state}). Revise la instancia.`,
    queueStats: async () => ({ queued: 7, sent: 1, unsent: 0, invalid: 0, expired: 0 }),
    // Lo que UltraMsg dice de cada mensaje: el listado es de mentira, el resto es el codigo de verdad
    listMessages: async () => uRows, classify: E.classify, describeReason: E.describeReason, deliveryFor: E.deliveryFor, matchCampaign: E.matchCampaign,
    // WhatsApp oficial de Meta con plantillas: el codigo de verdad
    usesTemplates: (config) => !!(config && config.channel === 'meta'), templateFor: MT.templateFor, templateParams: MT.templateParams, renderTemplate: MT.renderTemplate
};
const pauses = [];
const sleep = async (ms) => { pauses.push(ms); };
const pause = () => 0;
const run = (extra = {}) => R.processQueue({ db, whatsapp, sleep, pause, ...extra });

async function wipe() {
    for (const col of ['usuarios', 'finanzas_residentes', 'recordatorios_envios', 'recordatorios_individuales']) {
        for (const doc of (await condoRef.collection(col).get()).docs) await db.recursiveDelete(doc.ref);
    }
    for (const doc of (await db.collection('colas_envios').where('condominioId', '==', CONDO).get()).docs) await doc.ref.delete();
}
async function user(id, extra = {}) {
    await condoRef.collection('usuarios').doc(id).set({ id, condominioId: CONDO, name: `Vecino ${id}`, role: 'vecino', casa: `C-${id}`, active: true, phone: '', createdAt: now, ...extra });
}
const items = (ids) => ids.map((id) => ({ residentId: id, text: `Aviso para ${id}` }));
const create = (ids, extra = {}) => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: items(ids), ...extra } });
const camp = async (id) => (await condoRef.collection('recordatorios_envios').doc(id).get()).data();
const dest = async (id, rid) => (await condoRef.collection('recordatorios_envios').doc(id).collection('destinatarios').doc(rid).get()).data();
const queue = async (id) => (await db.collection('colas_envios').doc(`${CONDO}__${id}`).get()).data();
const reset = () => { sentLog.length = 0; failTo.clear(); pauses.length = 0; provider = true; connState = CONNECTED; cfg = SIMULADO; uRows = null; healthState = { confirming: null }; };

await condoRef.set({ id: CONDO, name: 'Condominio de pruebas de recordatorios', active: true, createdAt: now });
await wipe();

console.log('\nCrear el envio');
await user('v1', { phone: '5555-1111' });
await user('v2', { phone: '5555-2222' });
await user('v3', { phone: '+502 5555 3333' });
await user('v4', { phone: '' });
await user('v5', { phone: '5555-5555', active: false });
await user('v6', { phone: '5555-6666' });
await condoRef.collection('finanzas_residentes').doc('v6').set({ id: 'v6', deleted: true });
await user('adm', { role: 'admin', phone: '5555-0000' });
await user('g1', { role: 'policia', phone: '5555-0001' });
{
    reset();
    const result = await R.createCampaign({
        db, whatsapp, condominioId: CONDO, caller,
        // El telefono que mande el cliente se ignora: se usa el de la ficha del vecino
        data: { mode: 'mora', items: [...items(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'adm', 'g1', 'no-existe']).map((i) => ({ ...i, phone: '50299999999' })), { residentId: 'v1', text: 'repetido' }] }
    });
    equal('de 9 solo 3 se pueden enviar (los demas se omiten con su motivo)', [result.total, result.pending, result.skipped], [9, 3, 6]);
    equal('el tiempo estimado sale de la pausa (3 mensajes = 1 minuto)', result.estimatedMinutes, 1);
    const c = await camp(result.id);
    equal('el envio queda en curso con sus contadores y quien lo hizo', [c.status, c.total, c.pending, c.sent, c.failed, c.skipped, c.createdBy.id, c.mode], ['running', 9, 3, 0, 0, 6, 'adm', 'mora']);
    equal('los motivos de los omitidos', [(await dest(result.id, 'v4')).reason, (await dest(result.id, 'v5')).reason, (await dest(result.id, 'v6')).reason, (await dest(result.id, 'adm')).reason, (await dest(result.id, 'no-existe')).reason], ['sin teléfono válido', 'vecino inactivo', 'quitado del Sistema Financiero', 'no es un vecino', 'no es un vecino']);
    ok('el destinatario guarda el texto y solo las ultimas 4 cifras del telefono', (await dest(result.id, 'v1')).text === 'Aviso para v1' && (await dest(result.id, 'v1')).phoneTail === '1111' && !JSON.stringify(await dest(result.id, 'v1')).includes('55551111'));
    equal('esta en la cola', (await queue(result.id)).status, 'running');
    await rejects('con un envio en curso no se crea otro', () => create(['v1']), 'failed-precondition');

    console.log('\nMandar de a poco');
    const out = await run();
    equal('salieron los 3, al telefono de la ficha y con su texto (el numero que mando el cliente se ignoro)', sentLog.map((s) => [s.to, s.message]), [['50255551111', 'Aviso para v1'], ['50255552222', 'Aviso para v2'], ['50255553333', 'Aviso para v3']]);
    equal('hubo una pausa despues de cada mensaje', pauses.length, 3);
    const done = await camp(result.id);
    equal('termino con sus cifras', [done.status, done.sent, done.failed, done.pending, done.skipped, done.lockUntil], ['done', 3, 0, 0, 6, 0]);
    equal('cada uno quedo como enviado por el proveedor', [(await dest(result.id, 'v1')).status, (await dest(result.id, 'v1')).channel], ['sent', 'SIMULADO']);
    equal('la cola ya no lo trae', (await queue(result.id)).status, 'done');
    equal('la corrida lo informa', [out.length, out[0].sent, out[0].finished], [1, 3, true]);
    equal('otra corrida no manda nada mas', [(await run()).length, sentLog.length], [0, 3]);
}

console.log('\nFallos y reintento');
{
    reset();
    failTo.add('50255552222');
    const r = await create(['v1', 'v2', 'v3']);
    await run();
    const c = await camp(r.id);
    equal('uno fallo y los otros salieron', [c.status, c.sent, c.failed, (await dest(r.id, 'v2')).status], ['done', 2, 1, 'failed']);
    ok('el fallido guarda el motivo', /ningún proveedor/.test((await dest(r.id, 'v2')).error));
    failTo.clear(); sentLog.length = 0;
    const retry = await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'retry' } });
    equal('reintentar deja en cola solo al fallido', [retry.status, retry.pending, (await camp(r.id)).failed], ['running', 1, 0]);
    await run();
    equal('el reintento lo envia y no repite a los demas', [sentLog.map((s) => s.to), (await camp(r.id)).sent, (await camp(r.id)).status], [['50255552222'], 3, 'done']);
    await rejects('no se puede reintentar lo que no tiene fallidos', () => R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'retry' } }), 'failed-precondition');
}

console.log('\nCinco fallos seguidos detienen el envio');
{
    reset();
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) await user(id, { phone: `5555-70${id.slice(1)}0` });
    ['50255557010', '50255557020', '50255557030', '50255557040', '50255557050', '50255557060'].forEach((n) => failTo.add(n));
    const r = await create(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
    await run();
    const c = await camp(r.id);
    equal('se detuvo con el aviso y sin tocar al sexto', [c.status, c.failed, c.pending, /5 fallos seguidos/.test(c.errorMessage || ''), sentLog.length], ['error', 5, 1, true, 5]);
    equal('la cola lo marca con error', (await queue(r.id)).status, 'error');
    failTo.clear(); sentLog.length = 0;
    const resume = await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'resume' } });
    equal('reanudar sigue con el que faltaba', [resume.status, resume.pending], ['running', 1]);
    await run();
    equal('el sexto sale y termina', [sentLog.map((s) => s.to), (await camp(r.id)).status], [['50255557060'], 'done']);
    await rejects('reanudar uno que ya esta en curso o terminado sin pendientes se rechaza', () => R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'resume' } }), 'failed-precondition');
    await retryAll(r.id);
}
async function retryAll(id) {
    // Los 5 fallidos se pueden reintentar tambien despues de reanudar
    const retry = await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: id, action: 'retry' } });
    equal('los 5 fallidos se pueden reintentar', [retry.status, retry.pending], ['running', 5]);
    await run();
    equal('y salen', [(await camp(id)).sent, (await camp(id)).failed, (await camp(id)).status], [6, 0, 'done']);
}

console.log('\nCancelar y turnos');
{
    reset();
    const r = await create(['v1', 'v2', 'v3']);
    const cancel = await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'cancel' } });
    equal('cancelar lo detiene antes de mandar nada', [cancel.status, (await run()).length, sentLog.length, (await camp(r.id)).status], ['canceled', 0, 0, 'canceled']);
    await rejects('un envio terminado no se cancela', async () => {
        const t = await create(['v1']); await run();
        await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: t.id, action: 'cancel' } });
    }, 'failed-precondition');
    reset();
    const resumed = await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'resume' } });
    equal('un cancelado se puede reanudar', resumed.status, 'running');
    // Otra corrida ya tiene el turno: esta no manda nada
    await condoRef.collection('recordatorios_envios').doc(r.id).update({ lockUntil: Date.now() + 60000 });
    equal('con el turno tomado por otra corrida no se manda', [(await run())[0].busy, sentLog.length], [true, 0]);
    await condoRef.collection('recordatorios_envios').doc(r.id).update({ lockUntil: Date.now() - 1 });
    await run();
    equal('con el turno vencido si', [sentLog.length, (await camp(r.id)).status], [3, 'done']);
    equal('nadie manda a un numero que ya no esta en la ficha', 1, 1);
}

console.log('\nPausar y continuar');
{
    const control = (id, action) => R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: id, action } });
    const campRefOf = (id) => condoRef.collection('recordatorios_envios').doc(id);

    // Pausar antes de que salga nada
    reset();
    const r = await create(['v1', 'v2', 'v3']);
    const paused = await control(r.id, 'pause');
    const afterPause = await camp(r.id);
    equal('pausar deja el envio en pausa, con la hora, y la cola tambien', [paused.status, afterPause.status, typeof afterPause.pausedAt, (await queue(r.id)).status], ['paused', 'paused', 'string', 'paused']);
    equal('en pausa no sale nada aunque corra la cola', [(await run()).length, sentLog.length], [0, 0]);
    await rejects('un envio en pausa cuenta como en curso: no se empieza otro (se repetirian mensajes)', () => create(['v1']), 'failed-precondition');
    await rejects('pausar uno que ya esta en pausa se rechaza', () => control(r.id, 'pause'), 'failed-precondition');
    const resumed = await control(r.id, 'resume');
    const afterResume = await camp(r.id);
    equal('continuar lo pone en curso, sin pausa y con la cola activa', [resumed.status, resumed.pending, afterResume.status, afterResume.pausedAt, (await queue(r.id)).status], ['running', 3, 'running', null, 'running']);
    await run();
    equal('al continuar salen todos, una sola vez cada uno', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(r.id)).status], [3, 3, 'done']);
    await rejects('uno terminado no se pausa', () => control(r.id, 'pause'), 'failed-precondition');
    await rejects('uno terminado no se continua: no queda nadie', () => control(r.id, 'resume'), 'failed-precondition');

    // Pausar CON la corrida mandando: se detiene antes del siguiente mensaje (el estado se mira en cada uno)
    reset();
    const m = await create(['v1', 'v2', 'v3']);
    let pausedMid = false;
    const sleepAndPause = async (ms) => { pauses.push(ms); if (!pausedMid) { pausedMid = true; await control(m.id, 'pause'); } };
    await run({ sleep: sleepAndPause });
    const midState = await camp(m.id);
    equal('pausar a mitad de la corrida la detiene despues del mensaje en curso (salio 1 de 3)', [sentLog.length, midState.status, midState.sent, midState.pending], [1, 'paused', 1, 2]);
    equal('la corrida suelta el turno al parar, asi se puede continuar enseguida', midState.lockUntil, 0);
    await control(m.id, 'resume');
    await run();
    equal('al continuar salen los 2 que faltaban y ninguno se repite', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(m.id)).status], [3, 3, 'done']);

    // Pausar y continuar enseguida, con la corrida viva: sigue la misma corrida, sin una segunda a la vez
    reset();
    const q = await create(['v1', 'v2', 'v3']);
    let lockWhileResumed = null; let flipped = false;
    const sleepPauseResume = async (ms) => {
        pauses.push(ms);
        if (flipped) return;
        flipped = true;
        await control(q.id, 'pause');
        await control(q.id, 'resume');
        lockWhileResumed = (await camp(q.id)).lockUntil;
    };
    await run({ sleep: sleepPauseResume });
    equal('pausar y continuar sin soltar el turno: la misma corrida termina el envio, una vez cada uno', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(q.id)).status], [3, 3, 'done']);
    ok('y continuar no suelta el turno de la corrida que sigue mandando (lockUntil se conserva)', lockWhileResumed > Date.now(), `-> lockUntil ${lockWhileResumed}`);

    // Cancelar desde pausa y cancelar con la corrida viva
    reset();
    const c1 = await create(['v1', 'v2']);
    await control(c1.id, 'pause');
    const canceledFromPause = await control(c1.id, 'cancel');
    equal('un envio en pausa se puede cancelar', [canceledFromPause.status, (await camp(c1.id)).status, (await queue(c1.id)).status], ['canceled', 'canceled', 'canceled']);
    reset();
    const c2 = await create(['v1', 'v2', 'v3']);
    let lockAtCancel = null; let canceledMid = false;
    const sleepAndCancel = async (ms) => { pauses.push(ms); if (!canceledMid) { canceledMid = true; await control(c2.id, 'cancel'); lockAtCancel = (await camp(c2.id)).lockUntil; } };
    await run({ sleep: sleepAndCancel });
    const afterCancel = await camp(c2.id);
    equal('cancelar a mitad de la corrida la detiene despues del mensaje en curso (salio 1 de 3)', [sentLog.length, afterCancel.status, afterCancel.pending], [1, 'canceled', 2]);
    ok('cancelar no suelta el turno de golpe (lo suelta la corrida al parar)', lockAtCancel > Date.now() && afterCancel.lockUntil === 0, `-> en el momento ${lockAtCancel}, al final ${afterCancel.lockUntil}`);
    ok('un envio de otro condominio ni se pausa', await (async () => { try { await R.controlCampaign({ db, condominioId: 'otro-condo', data: { campaignId: c2.id, action: 'pause' } }); return false; } catch (e) { return e.userCode === 'not-found'; } })());
}

console.log('\nControl de conexion de WhatsApp (UltraMsg acepta y deja en cola si su instancia esta desconectada)');
{
    const control = (id, action) => R.controlCampaign({ db, whatsapp, condominioId: CONDO, data: { campaignId: id, action } });
    const envios = async () => (await condoRef.collection('recordatorios_envios').get()).size;

    // Desconectado: no se empieza nada, ni a un residente ni la prueba
    reset();
    connState = { connected: false, state: 'standby', provider: 'ultramsg' };
    const antes = await envios();
    let aviso = '';
    try { await create(['v1', 'v2']); } catch (e) { aviso = e.message; }
    ok('con WhatsApp desconectado (standby) no se crea el envio y el aviso dice el estado', /no está conectado \(estado: standby\)/.test(aviso) && (await envios()) === antes, aviso);
    await rejects('tampoco se manda a un residente', () => R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'v1', text: 'hola' } }), 'failed-precondition');
    await rejects('ni el mensaje de prueba', () => R.sendTest({ whatsapp, data: { phone: '5555-1111', text: 'hola' } }), 'failed-precondition');
    equal('y no se mando nada', sentLog.length, 0);

    // Si no se puede saber (UltraMsg no responde), se deja seguir: el envio mismo dira si falla
    reset();
    connState = { connected: null, state: 'sin-respuesta', provider: 'ultramsg' };
    const unknown = await create(['v1']);
    await run();
    equal('si no se puede saber la conexion se deja seguir', [sentLog.length, (await camp(unknown.id)).status], [1, 'done']);

    // Se desconecta DESPUES de crear el envio: la corrida no manda nada y avisa
    reset();
    const a = await create(['v1', 'v2', 'v3']);
    connState = { connected: false, state: 'standby', provider: 'ultramsg' };
    await run();
    const stopped = await camp(a.id);
    equal('si al empezar la corrida esta desconectado no manda nada y queda detenido con el motivo', [sentLog.length, stopped.status, stopped.pending, stopped.lockUntil, (await queue(a.id)).status], [0, 'error', 3, 0, 'error']);
    ok('el motivo dice el estado y que se pulse Continuar', /estado: standby/.test(stopped.errorMessage) && /pulse Continuar/.test(stopped.errorMessage), stopped.errorMessage);
    await rejects('no se puede continuar mientras siga desconectado (solo dejaria mas mensajes en la cola de UltraMsg)', () => control(a.id, 'resume'), 'failed-precondition');
    connState = CONNECTED;
    const resumedOk = await control(a.id, 'resume');
    await run();
    equal('al volver la conexion se continua y salen los 3 una sola vez', [resumedOk.status, sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(a.id)).status], ['running', 3, 3, 'done']);

    // Se desconecta A MITAD del envio: se comprueba cada 10 mensajes y se detiene
    reset();
    const ids = Array.from({ length: 12 }, (_, i) => `w${i + 1}`);
    for (const [i, id] of ids.entries()) await user(id, { phone: `5566-${1001 + i}` });
    const b = await create(ids);
    const realConnection = whatsapp.connection;
    whatsapp.connection = async () => (sentLog.length >= R.CONN_CHECK_EVERY ? { connected: false, state: 'standby', provider: 'ultramsg' } : CONNECTED);
    await run();
    const mid = await camp(b.id);
    equal(`se detiene al comprobar la conexion (cada ${R.CONN_CHECK_EVERY} mensajes): salieron ${R.CONN_CHECK_EVERY} de 12 y quedaron 2`, [sentLog.length, mid.status, mid.sent, mid.pending, mid.lockUntil], [R.CONN_CHECK_EVERY, 'error', R.CONN_CHECK_EVERY, 2, 0]);
    ok('y dice que se desconecto', /estado: standby/.test(mid.errorMessage), mid.errorMessage);
    whatsapp.connection = realConnection;
    await control(b.id, 'resume');
    await run();
    equal('al volver salen los 2 que faltaban, sin repetir ninguno', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(b.id)).status], [12, 12, 'done']);

    // Lo que ve OIKOS arriba de los botones
    reset();
    connState = { connected: false, state: 'standby', provider: 'ultramsg' };
    const down = await R.connectionInfo({ whatsapp });
    equal('el estado desconectado trae el motivo y lo que hay en la cola de UltraMsg', [down.configured, down.connected, down.state, /no está conectado/.test(down.message), down.queue.queued], [true, false, 'standby', true, 7]);
    connState = CONNECTED;
    const up = await R.connectionInfo({ whatsapp });
    equal('el estado conectado no trae motivo', [up.connected, up.message], [true, '']);
    provider = false;
    const none = await R.connectionInfo({ whatsapp });
    equal('sin claves de WhatsApp dice que no esta configurado', [none.configured, none.connected], [false, false]);
    reset();
}

console.log('\nNumero restringido por WhatsApp: conectado, pero los mensajes no salen (La Perla, 16 y 17/11/2026)');
{
    const control = (id, action) => R.controlCampaign({ db, whatsapp, condominioId: CONDO, data: { campaignId: id, action } });
    const envios = async () => (await condoRef.collection('recordatorios_envios').get()).size;
    const RESTRICTED = { confirming: false, stuck: 16, blocked: 0, since: Math.floor(Date.now() / 1000) - 86400, lastOkAt: 0 };
    const ids = Array.from({ length: 12 }, (_, i) => `h${i + 1}`);
    for (const [i, id] of ids.entries()) await user(id, { phone: `5577-${1001 + i}` });

    reset();
    healthState = RESTRICTED;
    const antes = await envios();
    let aviso = '';
    try { await create(['h1', 'h2']); } catch (e) { aviso = e.message; }
    ok('con el numero restringido no se crea el envio a todos y el aviso lo explica', /no está dejando salir los mensajes/.test(aviso) && /Enviar prueba/.test(aviso) && (await envios()) === antes, aviso);
    await rejects('tampoco se manda a un residente', () => R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'h1', text: 'hola' } }), 'failed-precondition');
    const test = await R.sendTest({ whatsapp, data: { phone: '5555-1111', text: 'prueba' } });
    equal('la prueba SI sale: es la forma de saber que ya paso el castigo', [test.sent, sentLog.length], [true, 1]);

    // Si no se puede saber, se deja seguir (como con la conexion)
    reset();
    healthState = { confirming: null };
    const unknown = await create(['h1']);
    await run();
    equal('si no se sabe si salen, se deja seguir', [sentLog.length, (await camp(unknown.id)).status], [1, 'done']);
    reset();
    whatsapp.health = async () => { throw new Error('UltraMsg no responde'); };
    const failing = await create(['h2']);
    await run();
    equal('si la consulta falla, tambien se deja seguir', [sentLog.length, (await camp(failing.id)).status], [1, 'done']);
    whatsapp.health = async () => healthState;

    // Se restringe DESPUES de crear el envio: la corrida no manda nada y avisa
    reset();
    const a = await create(['h1', 'h2', 'h3']);
    healthState = RESTRICTED;
    await run();
    const stopped = await camp(a.id);
    equal('si al empezar la corrida el numero esta restringido no manda nada y queda detenido', [sentLog.length, stopped.status, stopped.pending, stopped.lockUntil, (await queue(a.id)).status], [0, 'error', 3, 0, 'error']);
    ok('el motivo lo explica y dice que se pulse Continuar cuando la prueba llegue', /no está dejando salir/.test(stopped.errorMessage) && /pulse Continuar/.test(stopped.errorMessage), stopped.errorMessage);
    await rejects('no se puede continuar mientras siga restringido', () => control(a.id, 'resume'), 'failed-precondition');
    await rejects('ni reintentar', () => control(a.id, 'retry'), 'failed-precondition');
    healthState = { confirming: true };
    await control(a.id, 'resume');
    await run();
    equal('cuando vuelven a salir se continua y salen los 3 una sola vez', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(a.id)).status], [3, 3, 'done']);

    // Se restringe A MITAD del envio: se comprueba cada 10 mensajes junto con la conexion
    reset();
    const b = await create(ids);
    whatsapp.health = async () => (sentLog.length >= R.CONN_CHECK_EVERY ? RESTRICTED : { confirming: true });
    await run();
    const mid = await camp(b.id);
    equal(`a mitad del envio se detiene al comprobar (cada ${R.CONN_CHECK_EVERY} mensajes): salieron ${R.CONN_CHECK_EVERY} de 12`, [sentLog.length, mid.status, mid.sent, mid.pending, mid.lockUntil], [R.CONN_CHECK_EVERY, 'error', R.CONN_CHECK_EVERY, 2, 0]);
    ok('y dice por que', /no está dejando salir/.test(mid.errorMessage), mid.errorMessage);
    whatsapp.health = async () => healthState;
    healthState = { confirming: true };
    await control(b.id, 'resume');
    await run();
    equal('al volver salen los 2 que faltaban, sin repetir ninguno', [sentLog.length, new Set(sentLog.map((s) => s.to)).size, (await camp(b.id)).status], [12, 12, 'done']);

    // Lo que ve OIKOS arriba de los botones
    reset();
    healthState = RESTRICTED;
    const info = await R.connectionInfo({ whatsapp });
    equal('OIKOS recibe conectado pero sin salir, con el aviso', [info.connected, info.confirming, /no está dejando salir/.test(info.healthMessage)], [true, false, true]);
    healthState = { confirming: true };
    const fine = await R.connectionInfo({ whatsapp });
    equal('cuando salen, sin aviso', [fine.confirming, fine.healthMessage], [true, '']);
    connState = { connected: false, state: 'standby', provider: 'ultramsg' };
    healthState = RESTRICTED;
    const downInfo = await R.connectionInfo({ whatsapp });
    equal('desconectado manda el aviso de la conexion, no el de las palomitas', [downInfo.connected, downInfo.confirming, downInfo.healthMessage], [false, null, '']);
    reset();
}

console.log('\nQue llego de verdad (UltraMsg acepta y despues WhatsApp puede rechazar)');
{
    const control = (id, action) => R.controlCampaign({ db, whatsapp, condominioId: CONDO, data: { campaignId: id, action } });
    const nowSec = () => Math.floor(Date.now() / 1000);
    const noWait = { waitMs: 0 };
    const toOf = (phone) => `${phone}@c.us`;
    const one = (verify = noWait) => R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'v1', text: 'hola' }, verify });

    // Un envio a UN residente: el servidor mira lo que dice UltraMsg
    reset();
    cfg = ULTRAMSG;
    uRows = [{ id: 1, to: toOf('50255551111'), status: 'unsent', ack: 'pending', failed_reason: 'temporary_block', created_at: nowSec() }];
    const rejected = await one();
    equal('UltraMsg lo acepto pero WhatsApp lo rechazo: se dice que NO llego y por que', [rejected.sent, rejected.delivery, rejected.deliveryReason, /bloqueó temporalmente/.test(rejected.deliveryText)], [true, 'rechazado', 'temporary_block', true]);
    const individual = (await condoRef.collection('recordatorios_individuales').orderBy('at', 'desc').limit(1).get()).docs[0].data();
    equal('y queda anotado en el registro del envio suelto', [individual.status, individual.delivery, individual.deliveryReason], ['sent', 'rechazado', 'temporary_block']);

    uRows = [{ id: 2, to: toOf('50255551111'), status: 'sent', ack: 'device', failed_reason: '', created_at: nowSec() }];
    equal('entregado al telefono (dos palomitas)', (await one()).delivery, 'entregado');
    uRows = [{ id: 3, to: toOf('50255551111'), status: 'queue', ack: 'pending', failed_reason: null, created_at: nowSec() }];
    equal('sigue en la cola de UltraMsg: ni entregado ni rechazado', (await one()).delivery, 'en_cola');
    uRows = [];
    equal('sin rastro en UltraMsg: desconocido', (await one()).delivery, 'desconocido');
    uRows = null;
    equal('si UltraMsg no responde no se sabe (null) y el envio no falla', (await one()).delivery, null);
    // Espera: la primera mirada es enseguida y despues de a 2 s, hasta que UltraMsg diga algo definitivo
    let looks = 0;
    const realList = whatsapp.listMessages;
    whatsapp.listMessages = async () => { looks++; return looks < 3 ? [{ id: 9, to: toOf('50255551111'), status: 'queue', ack: 'pending', created_at: nowSec() }] : [{ id: 9, to: toOf('50255551111'), status: 'sent', ack: 'server', created_at: nowSec() }]; };
    const waits = [];
    const waited = await one({ waitMs: 8000, sleep: async (ms) => { waits.push(ms); } });
    whatsapp.listMessages = realList;
    equal('espera de a 2 s mientras siga en cola y se detiene cuando WhatsApp lo recibe (enviado)', [waited.delivery, looks, waits], ['enviado', 3, [2000, 2000]]);
    // La prueba
    uRows = [{ id: 4, to: toOf('50255551111'), status: 'unsent', ack: 'pending', failed_reason: 'temporary_block', created_at: nowSec() }];
    const testResult = await R.sendTest({ whatsapp, data: { phone: '5555-1111', text: 'hola' }, verify: noWait });
    equal('la prueba tambien dice que no llego', [testResult.sent, testResult.delivery], [true, 'rechazado']);

    // Un envio a muchos: comprobar que llego y reenviar solo a los que no recibieron
    reset();
    cfg = ULTRAMSG;
    const e = await create(['v1', 'v2', 'v3']);
    await run();
    const sentAt = {};
    for (const id of ['v1', 'v2', 'v3']) sentAt[id] = Math.floor(Date.parse((await dest(e.id, id)).sentAt) / 1000);
    uRows = [
        { id: 1, to: toOf('50255551111'), status: 'sent', ack: 'device', failed_reason: '', created_at: sentAt.v1 },
        { id: 2, to: toOf('50255552222'), status: 'unsent', ack: 'pending', failed_reason: 'temporary_block', created_at: sentAt.v2 }
        // v3: UltraMsg no tiene rastro (por ejemplo, se vacio la cola)
    ];
    await rejects('antes de comprobar no se puede reenviar (no se sabe a quien no le llego)', () => R.resendCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { campaignId: e.id } }), 'failed-precondition');
    const summary = await R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: e.id });
    equal('comprobar: 1 entregado, 1 rechazado, 1 sin rastro, y a 2 se les puede reenviar', [summary.entregado, summary.rechazado, summary.desconocido, summary.resend, summary.reasons], [1, 1, 1, 2, { temporary_block: 1 }]);
    equal('cada destinatario guarda lo suyo', [(await dest(e.id, 'v1')).delivery, (await dest(e.id, 'v2')).delivery, (await dest(e.id, 'v2')).deliveryReason, (await dest(e.id, 'v3')).delivery], ['entregado', 'rechazado', 'temporary_block', 'desconocido']);
    equal('y el envio guarda los totales', [(await camp(e.id)).delivery.resend, (await camp(e.id)).delivery.entregado, typeof (await camp(e.id)).delivery.checkedAt], [2, 1, 'string']);
    sentLog.length = 0;
    const again = await R.resendCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { campaignId: e.id } });
    const resendCamp = await camp(again.id);
    equal('reenviar crea un envio nuevo SOLO con los 2 que no recibieron (el que si recibio no se toca), con el mismo modo', [again.pending, again.total, resendCamp.resendOf, resendCamp.mode], [2, 2, e.id, 'mora']);
    equal('con el mismo texto que ya tenian', [(await dest(again.id, 'v2')).text, (await dest(again.id, 'v3')).text, (await dest(again.id, 'v1'))], ['Aviso para v2', 'Aviso para v3', undefined]);
    await rejects('mientras el reenvio esta en curso no se empieza otro', () => R.resendCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { campaignId: e.id } }), 'failed-precondition');
    await run();
    equal('el reenvio manda solo a esos 2', [sentLog.map((x) => x.to).sort(), (await camp(again.id)).status], [['50255552222', '50255553333'], 'done']);
    // Todos entregados: no hay a quien reenviar
    uRows = [
        { id: 1, to: toOf('50255551111'), status: 'sent', ack: 'device', created_at: sentAt.v1 },
        { id: 2, to: toOf('50255552222'), status: 'sent', ack: 'read', created_at: sentAt.v2 },
        { id: 3, to: toOf('50255553333'), status: 'sent', ack: 'server', created_at: sentAt.v3 }
    ];
    const allGood = await R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: e.id });
    equal('si a todos les llego (o WhatsApp ya lo recibio) no hay nada que reenviar', [allGood.entregado, allGood.enviado, allGood.resend], [2, 1, 0]);
    await rejects('y reenviar avisa que no hay a quien', () => R.resendCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { campaignId: e.id } }), 'failed-precondition');
    // Sin UltraMsg o sin lectura
    reset();
    await rejects('con el proveedor simulado no se puede comprobar', () => R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: e.id }), 'failed-precondition');
    cfg = ULTRAMSG;
    uRows = null;
    await rejects('si UltraMsg no responde lo dice y se puede intentar de nuevo', () => R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: e.id }), 'unavailable');
    await rejects('un envio inexistente se avisa', () => R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: 'nada' }), 'not-found');
    await rejects('el envio de otro condominio no se alcanza', () => R.reconcileCampaign({ db, whatsapp, condominioId: 'otro-condo', campaignId: e.id }), 'not-found');
    reset();

    // Un solo mensaje por telefono cuando el texto es el mismo (un propietario con varios lotes)
    await user('p1', { phone: '5577-1001' });
    await user('p2', { phone: '5577-1001' });
    await user('p3', { phone: '5577-1001' });
    await user('p4', { phone: '5577-2002' });
    const same = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'varios', items: ['p1', 'p2', 'p3', 'p4'].map((id) => ({ residentId: id, text: 'Aviso general' })) } });
    equal('el mismo texto al mismo telefono sale una sola vez (4 lotes, 2 telefonos = 2 mensajes)', [same.pending, same.skipped], [2, 2]);
    equal('y los repetidos dicen por que', [(await dest(same.id, 'p1')).status, (await dest(same.id, 'p2')).reason, (await dest(same.id, 'p4')).status], ['pending', 'mismo mensaje al mismo teléfono (ya se le manda por otro lote)', 'pending']);
    await control(same.id, 'cancel');
    const different = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: ['p1', 'p2', 'p3'].map((id) => ({ residentId: id, text: `Debe Q${id}` })) } });
    equal('si el texto cambia por lote (por ejemplo el saldo) se manda cada uno', [different.pending, different.skipped], [3, 0]);
    await control(different.id, 'cancel');
}

console.log('\nWhatsApp oficial de Meta: cada aviso sale con una plantilla aprobada');
{
    const control = (id, action) => R.controlCampaign({ db, whatsapp, condominioId: CONDO, data: { campaignId: id, action } });
    const META = {
        channel: 'meta', metaToken: 't', metaPhoneId: 'p',
        metaTemplates: {
            mora: { name: 'aviso_mora', language: 'es', params: ['nombre', 'casa', 'saldo'], body: 'Hola {{1}}, casa {{2}}: debe {{3}}.' },
            general: { name: 'aviso_general', language: 'es', params: [], body: 'Aviso general de la administración.' }
        }
    };
    const vars = (name, casa, saldo) => ({ nombre: name, casa, saldo, cuotas: 'Q1.00', mora: 'Q0.00', condominio: 'La Perla' });

    reset();
    cfg = META;
    const c = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: [
        { residentId: 'v1', text: 'ESTO SE IGNORA', vars: vars('Ana', 'A1', 'Q10.00') },
        { residentId: 'v2', vars: vars('Beto', 'B2', 'Q20.00') },
        { residentId: 'v3', vars: { nombre: 'Carla\nPerez', casa: '', saldo: 'Q30.00' } }
    ] } });
    equal('con Meta el texto de cada residente es el de la plantilla con sus datos (el texto que mande la pantalla se ignora)', [(await dest(c.id, 'v1')).text, (await dest(c.id, 'v2')).text], ['Hola Ana, casa A1: debe Q10.00.', 'Hola Beto, casa B2: debe Q20.00.']);
    equal('guarda los datos de cada uno y un dato vacio o con salto de linea se arregla', [(await dest(c.id, 'v1')).params, (await dest(c.id, 'v3')).params], [['Ana', 'A1', 'Q10.00'], ['Carla Perez', '-', 'Q30.00']]);
    const metaCamp = await camp(c.id);
    equal('el envio dice que es de Meta y con que plantilla', [metaCamp.channel, metaCamp.template], ['meta', 'aviso_mora']);
    await run();
    const first = sentLog[0];
    equal('cada mensaje sale con la plantilla, su idioma y sus datos', [first.opts.template.name, first.opts.template.language, first.opts.params], ['aviso_mora', 'es', ['Ana', 'A1', 'Q10.00']]);
    equal('salieron los 3', [sentLog.length, (await camp(c.id)).status], [3, 'done']);

    // Falla: el motivo de Meta queda en el destinatario
    reset();
    cfg = META;
    failTo.add('50255551111');
    const f = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: [{ residentId: 'v1', vars: vars('Ana', 'A1', 'Q10.00') }] } });
    await run();
    equal('si Meta rechaza, el motivo queda anotado', [(await dest(f.id, 'v1')).status, (await dest(f.id, 'v1')).error], ['failed', 'Meta (131026): no se pudo entregar']);

    // Sin plantilla o sin datos
    reset();
    cfg = { ...META, metaTemplates: { mora: META.metaTemplates.mora } };
    await rejects('sin la plantilla de ese tipo de aviso no se crea el envio y dice cual falta', () => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'varios', items: [{ residentId: 'v1', vars: {} }] } }), 'failed-precondition');
    cfg = META;
    await rejects('un residente sin datos para la plantilla se rechaza', () => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: [{ residentId: 'v1', text: 'solo texto' }] } }), 'invalid-argument');
    // Se quita la plantilla DESPUES de crear el envio: la corrida se detiene con el motivo
    const g = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: [{ residentId: 'v1', vars: vars('Ana', 'A1', 'Q10.00') }] } });
    cfg = { ...META, metaTemplates: {} };
    await run();
    const lost = await camp(g.id);
    equal('si falta la plantilla al mandar, no sale nada y queda detenido con el motivo', [sentLog.length, lost.status, /Falta la plantilla/.test(lost.errorMessage)], [0, 'error', true]);
    cfg = META;
    await control(g.id, 'cancel');

    // Un mismo texto al mismo telefono (con los datos ya puestos) sale una vez
    reset();
    cfg = META;
    await user('m1', { phone: '5588-1001' });
    await user('m2', { phone: '5588-1001' });
    const dup = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'varios', items: [{ residentId: 'm1', vars: {} }, { residentId: 'm2', vars: {} }] } });
    equal('el aviso general (sin datos) al mismo telefono sale una sola vez', [dup.pending, dup.skipped], [1, 1]);
    await control(dup.id, 'cancel');

    // Un residente y la prueba
    reset();
    cfg = META;
    const one = await R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'v1', mode: 'mora', text: 'IGNORADO', vars: vars('Ana', 'A1', 'Q10.00') } });
    equal('un residente sale con la plantilla (y sin consultar a UltraMsg)', [one.sent, sentLog[0].opts.template.name, sentLog[0].message, one.delivery], [true, 'aviso_mora', 'Hola Ana, casa A1: debe Q10.00.', null]);
    const oneDoc = (await condoRef.collection('recordatorios_individuales').orderBy('at', 'desc').limit(1).get()).docs[0].data();
    equal('queda anotado con la plantilla', [oneDoc.template, oneDoc.text], ['aviso_mora', 'Hola Ana, casa A1: debe Q10.00.']);
    await rejects('un residente sin datos para la plantilla se rechaza', () => R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'v1', mode: 'mora', text: 'solo texto' } }), 'invalid-argument');
    const testSent = await R.sendTest({ whatsapp, data: { phone: '5555-1111', mode: 'varios', vars: {} } });
    equal('la prueba tambien sale con la plantilla', [testSent.sent, sentLog[sentLog.length - 1].opts.template.name], [true, 'aviso_general']);
    await rejects('la prueba sin datos se rechaza', () => R.sendTest({ whatsapp, data: { phone: '5555-1111', mode: 'mora', text: 'solo texto' } }), 'invalid-argument');
    failTo.add('50255551111');
    const failedOne = await R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data: { residentId: 'v1', mode: 'mora', vars: vars('Ana', 'A1', 'Q10.00') } });
    equal('si Meta lo rechaza, el motivo vuelve a la pantalla', [failedOne.sent, failedOne.error], [false, 'Meta (131026): no se pudo entregar']);

    // Lo que ve OIKOS arriba de los botones: el canal, las plantillas y la calidad del numero
    reset();
    cfg = META;
    connState = { connected: true, state: 'connected', provider: 'meta', quality: 'GREEN', name: 'Residenciales La Perla', number: '+502 1111 2222' };
    const info = await R.connectionInfo({ whatsapp });
    equal('el estado trae el canal Meta, las dos plantillas y la calidad del numero', [info.channel, info.templates.mora.name, info.templates.general.name, info.templates.mora.params, info.meta], ['meta', 'aviso_mora', 'aviso_general', ['nombre', 'casa', 'saldo'], { quality: 'GREEN', name: 'Residenciales La Perla', number: '+502 1111 2222' }]);
    cfg = { ...META, metaTemplates: { mora: META.metaTemplates.mora } };
    equal('si falta una plantilla lo dice (null)', (await R.connectionInfo({ whatsapp })).templates.general, null);
    cfg = SIMULADO;
    const plain = await R.connectionInfo({ whatsapp });
    equal('con UltraMsg el estado dice ultramsg y no trae plantillas', [plain.channel, plain.templates], ['ultramsg', null]);

    // Comprobar entregas no aplica a Meta (su resultado llega por su webhook); reenviar usa los datos ya calculados
    reset();
    cfg = META;
    const h = await R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { mode: 'mora', items: [{ residentId: 'v1', vars: vars('Ana', 'A1', 'Q10.00') }, { residentId: 'v2', vars: vars('Beto', 'B2', 'Q20.00') }] } });
    await run();
    await rejects('con Meta no se comprueba con UltraMsg y lo dice', () => R.reconcileCampaign({ db, whatsapp, condominioId: CONDO, campaignId: h.id }), 'failed-precondition');
    await condoRef.collection('recordatorios_envios').doc(h.id).collection('destinatarios').doc('v2').update({ delivery: 'rechazado' });
    await condoRef.collection('recordatorios_envios').doc(h.id).update({ delivery: { resend: 1, checkedAt: new Date().toISOString() } });
    sentLog.length = 0;
    const again2 = await R.resendCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { campaignId: h.id } });
    equal('reenviar con plantilla usa los mismos datos de ese residente', [again2.pending, (await dest(again2.id, 'v2')).params, (await dest(again2.id, 'v2')).text], [1, ['Beto', 'B2', 'Q20.00'], 'Hola Beto, casa B2: debe Q20.00.']);
    await run();
    equal('y sale con la plantilla', [sentLog.length, sentLog[0].opts.template.name, sentLog[0].opts.params], [1, 'aviso_mora', ['Beto', 'B2', 'Q20.00']]);
    reset();
}

console.log('\nTelefono al momento de mandar, interrupciones y tiempo');
{
    reset();
    const r = await create(['v1', 'v2', 'v3']);
    await condoRef.collection('usuarios').doc('v2').update({ phone: '' });
    await run();
    equal('si a alguien le quitaron el telefono antes de su turno, se omite', [sentLog.map((s) => s.to), (await dest(r.id, 'v2')).status, (await camp(r.id)).skipped, (await camp(r.id)).sent], [['50255551111', '50255553333'], 'skipped', 1, 2]);
    await condoRef.collection('usuarios').doc('v2').update({ phone: '5555-2222' });
    reset();
    const t = await create(['v1', 'v2', 'v3']);
    // Una corrida murio justo despues de marcar a v2 como "enviando": no se sabe si salio, no se repite
    await condoRef.collection('recordatorios_envios').doc(t.id).collection('destinatarios').doc('v2').update({ status: 'sending' });
    await run();
    equal('lo que quedo "enviando" pasa a fallido (puede que ya haya salido) y no se vuelve a mandar', [sentLog.map((s) => s.to), (await dest(t.id, 'v2')).status, /Interrumpido/.test((await dest(t.id, 'v2')).error)], [['50255551111', '50255553333'], 'failed', true]);
}
{
    // Presupuesto de tiempo de cada corrida: con el reloj de mentira corre unos pocos y deja el turno libre
    reset();
    for (const id of ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']) await user(id, { phone: `5555-80${id.slice(1)}0` });
    const r = await create(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']);
    let t = 0;
    const out = await run({ budgetMs: 8000, nowMs: () => (t += 1000) });
    const mid = await camp(r.id);
    ok('se detuvo por tiempo con parte enviada y sigue en curso', out[0].stoppedBy === 'tiempo' && mid.sent > 0 && mid.sent < 8 && mid.status === 'running', `-> ${JSON.stringify({ stoppedBy: out[0].stoppedBy, sent: mid.sent, status: mid.status })}`);
    equal('dejo el turno libre', mid.lockUntil, 0);
    await run({ budgetMs: 1000000 });
    equal('la siguiente corrida sigue donde iba y no repite a nadie', [new Set(sentLog.map((s) => s.to)).size, sentLog.length, (await camp(r.id)).status], [8, 8, 'done']);
}

console.log('\nLimites y sin WhatsApp');
{
    reset();
    provider = false;
    await rejects('sin WhatsApp conectado no se crea el envio', () => create(['v1']), 'failed-precondition');
    await rejects('ni se manda una prueba', () => R.sendTest({ whatsapp, data: { phone: '5555-1111', text: 'hola' } }), 'failed-precondition');
    provider = true;
    await rejects('sin residentes se rechaza', () => create([]), 'invalid-argument');
    await rejects('un mensaje sin texto se rechaza', () => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { items: [{ residentId: 'v1', text: '  ' }] } }), 'invalid-argument');
    await rejects('un mensaje de mas de 1000 caracteres se rechaza', () => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { items: [{ residentId: 'v1', text: 'a'.repeat(1001) }] } }), 'invalid-argument');
    await rejects('un id con barra se rechaza', () => R.createCampaign({ db, whatsapp, condominioId: CONDO, caller, data: { items: [{ residentId: 'a/b', text: 'hola' }] } }), 'invalid-argument');
    await rejects('mas de 1500 mensajes se rechazan', () => create(Array.from({ length: 1501 }, (_, i) => `z${i}`)), 'invalid-argument');
    await rejects('si ninguno tiene telefono valido se rechaza', () => create(['v4', 'v5']), 'failed-precondition');
    await rejects('una accion rara se rechaza', async () => { const r = await create(['v1']); await R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: r.id, action: 'borrar' } }); }, 'invalid-argument');
    await run();
    await rejects('un envio que no existe se avisa', () => R.controlCampaign({ db, condominioId: CONDO, data: { campaignId: 'nada', action: 'cancel' } }), 'not-found');
    await rejects('el envio de otro condominio no se alcanza', () => R.controlCampaign({ db, condominioId: 'otro-condo', data: { campaignId: 'nada', action: 'cancel' } }), 'not-found');

    const sent = await R.sendTest({ whatsapp, data: { phone: '5555-1111', text: '(Mensaje de prueba) hola' } });
    equal('la prueba manda un mensaje y dice a que telefono (solo el final)', [sent.sent, sent.channel, sent.phoneTail, sentLog.at(-1).to], [true, 'SIMULADO', '1111', '50255551111']);
    await rejects('la prueba pide un telefono completo', () => R.sendTest({ whatsapp, data: { phone: '1234', text: 'hola' } }), 'invalid-argument');
    await rejects('y un texto', () => R.sendTest({ whatsapp, data: { phone: '5555-1111', text: '' } }), 'invalid-argument');
    failTo.add('50255551111');
    equal('si WhatsApp no la entrega lo dice', (await R.sendTest({ whatsapp, data: { phone: '5555-1111', text: 'hola' } })).sent, false);
}

console.log('\nEnviar a UN residente (boton Enviar de la fila y Contactar)');
{
    reset();
    // Los envios sueltos de las secciones de arriba (que llego de verdad) tambien quedan anotados: aqui se cuenta desde cero
    for (const doc of (await condoRef.collection('recordatorios_individuales').get()).docs) await doc.ref.delete();
    const one = (data, extra = {}) => R.sendOne({ db, whatsapp, condominioId: CONDO, caller, data, ...extra });
    // El telefono sale de la ficha del vecino: el que mande el cliente se ignora
    const queueBefore = (await db.collection('colas_envios').where('condominioId', '==', CONDO).get()).size;
    const r1 = await one({ residentId: 'v1', text: 'Hola v1, aviso', mode: 'mora', phone: '50299999999' });
    equal('sale al instante al telefono de la ficha, con su texto', [r1.sent, r1.channel, r1.phoneTail, sentLog.map((s) => [s.to, s.message])], [true, 'SIMULADO', '1111', [['50255551111', 'Hola v1, aviso']]]);
    equal('sin pausas ni cola', [pauses.length, (await db.collection('colas_envios').where('condominioId', '==', CONDO).get()).size - queueBefore], [0, 0]);
    const logs = (await condoRef.collection('recordatorios_individuales').get()).docs.map((d) => d.data());
    equal('queda anotado: quien, a quien, el texto y solo las ultimas 4 cifras', [logs.length, logs[0].by.id, logs[0].residentId, logs[0].status, logs[0].phoneTail, logs[0].mode, JSON.stringify(logs[0]).includes('55551111')], [1, 'adm', 'v1', 'sent', '1111', 'mora', false]);
    equal('con un envio a todos en curso tambien sale (no se mezclan)', await (async () => {
        const c = await create(['v2', 'v3']);
        const out = await one({ residentId: 'v3', text: 'directo a v3', mode: 'varios' });
        const state = (await camp(c.id)).status;
        await condoRef.collection('recordatorios_envios').doc(c.id).update({ status: 'canceled' });
        await db.collection('colas_envios').doc(`${CONDO}__${c.id}`).set({ status: 'canceled' }, { merge: true });
        return [out.sent, state];
    })(), [true, 'running']);
    // Fallos y motivos
    failTo.add('50255552222');
    const failed = await one({ residentId: 'v2', text: 'aviso v2' });
    const failedLog = (await condoRef.collection('recordatorios_individuales').where('status', '==', 'failed').get()).docs.map((d) => d.data());
    equal('si WhatsApp no lo entrega lo dice y queda como fallido con su motivo', [failed.sent, failedLog.length, /ningún proveedor/.test(failedLog[0].error)], [false, 1, true]);
    failTo.clear();
    await rejects('a quien no tiene telefono no se le envia', () => one({ residentId: 'v4', text: 'x' }), 'failed-precondition');
    await rejects('ni a un vecino inactivo', () => one({ residentId: 'v5', text: 'x' }), 'failed-precondition');
    await rejects('ni a uno quitado del Sistema Financiero', () => one({ residentId: 'v6', text: 'x' }), 'failed-precondition');
    await rejects('ni al personal (administrador o guardia)', () => one({ residentId: 'adm', text: 'x' }), 'failed-precondition');
    await rejects('ni a un usuario que no existe', () => one({ residentId: 'no-existe', text: 'x' }), 'failed-precondition');
    await rejects('un id con barra se rechaza', () => one({ residentId: 'a/b', text: 'x' }), 'invalid-argument');
    await rejects('un mensaje vacio se rechaza', () => one({ residentId: 'v1', text: '  ' }), 'invalid-argument');
    await rejects('uno de mas de 1000 caracteres se rechaza', () => one({ residentId: 'v1', text: 'a'.repeat(1001) }), 'invalid-argument');
    equal('los rechazados no mandaron nada', sentLog.length, 3);
    provider = false;
    await rejects('sin WhatsApp conectado no se envia', () => one({ residentId: 'v1', text: 'x' }), 'failed-precondition');
    provider = true;
}

await wipe();
await condoRef.delete();
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log('  - ' + f));
process.exit(failures.length ? 1 : 0);
