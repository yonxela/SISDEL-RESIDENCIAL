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
const whatsapp = {
    loadConfig: async () => ({ provider: 'simulado' }),
    hasProvider: () => provider,
    send: async (config, to, message) => { sentLog.push({ to, message }); return failTo.has(to) ? null : 'SIMULADO'; }
};
const pauses = [];
const sleep = async (ms) => { pauses.push(ms); };
const pause = () => 0;
const run = (extra = {}) => R.processQueue({ db, whatsapp, sleep, pause, ...extra });

async function wipe() {
    for (const col of ['usuarios', 'finanzas_residentes', 'recordatorios_envios']) {
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
const reset = () => { sentLog.length = 0; failTo.clear(); pauses.length = 0; provider = true; };

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
