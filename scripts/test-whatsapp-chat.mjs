// Pruebas del chat de WhatsApp con los residentes (functions/src/whatsapp-chat-core.js y el aviso whatsappWebhook) contra
// los emuladores, con un WhatsApp de mentira (nadie recibe nada). Condominios propios (condo-chat-a y condo-chat-b), que
// se borran al empezar y al terminar.
// Uso: node test-whatsapp-chat.mjs (tambien corre con npm test; necesita los emuladores y `npm run seed`).
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { connect } from './admin.mjs';

const require = createRequire(import.meta.url);
const C = require('../functions/src/whatsapp-chat-core.js');
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

const A = 'condo-chat-a';
const B = 'condo-chat-b';
const caller = { id: 'adm-chat', name: 'Administradora' };
const now = new Date().toISOString();
const sec = Math.floor(Date.now() / 1000);
const jid = (p) => `${p}@c.us`;
const ME = '50243093379';
// Telefonos inventados: Ana en A; Beto en A con dos lotes (el mismo telefono); Carla en A y tambien en B
const ANA = '50244440101', BETO = '50244440202', CARLA = '50244440303', NADIE = '50244449999', SIN = 'sin-telefono';

async function cleanup() {
    for (const id of [A, B]) await db.recursiveDelete(db.doc(`condominios/${id}`));
    for (const p of [NADIE]) await db.recursiveDelete(db.doc(`whatsapp_sin_asignar/${p}`));
}
await cleanup();
const user = (condo, id, name, casa, phone, role = 'vecino') => db.doc(`condominios/${condo}/usuarios/${id}`).set({ id, name, casa, phone, role, active: true, createdAt: now });
await db.doc(`condominios/${A}`).set({ name: 'Chat A', active: true, createdAt: now });
await db.doc(`condominios/${B}`).set({ name: 'Chat B', active: true, createdAt: now });
await user(A, 'ana', 'Ana Prueba', 'C001', '4444-0101');
await user(A, 'beto1', 'Beto Ejemplo', 'C002', '+502 4444 0202');
await user(A, 'beto2', 'Beto Ejemplo', 'C003', '44440202');
await user(A, 'carla', 'Carla Demo', 'C004', '44440303');
await user(A, 'sinfono', 'Sin Telefono', 'C005', '');
await user(A, 'adm-chat', 'Administradora', '', '', 'admin');
await user(B, 'carla-b', 'Carla en B', 'L-9', '+50244440303');
C._resetIndex();

const chatA = (p) => db.doc(`condominios/${A}/whatsapp_chats/${p}`);
const msgsA = (p) => chatA(p).collection('wa_mensajes');
const allMsgs = async (ref) => (await ref.collection('wa_mensajes').orderBy('at').get()).docs.map((d) => ({ ...d.data(), _id: d.id }));
const inbound = (from, id, body, extra = {}) => ({ event_type: 'message_received', instanceId: 'instance1', data: { id, from: jid(from), to: jid(ME), pushname: 'Ana WA', type: 'chat', body, media: '', fromMe: false, ack: '', time: sec, ...extra } });
const outbound = (to, id, body, extra = {}) => ({ event_type: 'message_create', instanceId: 'instance1', data: { id, from: jid(ME), to: jid(to), type: 'chat', body, fromMe: true, ack: 'server', time: sec, ...extra } });
const ack = (to, id, value) => ({ event_type: 'message_ack', instanceId: 'instance1', data: { id, from: jid(ME), to: jid(to), fromMe: true, ack: value } });

console.log('\nLeer los avisos de UltraMsg');
equal('un mensaje que entra', (({ kind, phone, fromMe, body, pushname }) => ({ kind, phone, fromMe, body, pushname }))(C.parseWebhook(inbound(ANA, 'w1', 'Hola'))), { kind: 'message', phone: ANA, fromMe: false, body: 'Hola', pushname: 'Ana WA' });
equal('un mensaje que sale (desde SISDEL o el telefono) es del chat del destinatario', (({ kind, phone, fromMe, ack: a }) => ({ kind, phone, fromMe, ack: a }))(C.parseWebhook(outbound(ANA, 'w2', 'Buenas'))), { kind: 'message', phone: ANA, fromMe: true, ack: 'server' });
equal('una palomita', (({ kind, phone, ack: a }) => ({ kind, phone, ack: a }))(C.parseWebhook(ack(ANA, 'w2', 'read'))), { kind: 'ack', phone: ANA, ack: 'read' });
equal('grupos, estados y otros avisos no son chats de un residente', [C.parseWebhook(inbound('120363@g.us', 'g', 'x')).phone, C.phoneOfJid('status@broadcast'), C.parseWebhook({ event_type: 'instance_status' }).kind, C.phoneOfJid('1234@lid')], ['', '', 'ignore', '']);
equal('un numero de 8 cifras es de Guatemala y la hora viene en segundos', [C.phoneOfJid('44440101@c.us'), C.parseWebhook(inbound(ANA, 'w', 'x', { time: 1700000000 })).at], [ANA, '2023-11-14T22:13:20.000Z']);
equal('solo se guardan enlaces https de archivos', [C.parseWebhook(inbound(ANA, 'w', '', { type: 'image', media: 'https://cdn.ultramsg.com/a.jpg' })).media, C.parseWebhook(inbound(ANA, 'w', '', { type: 'image', media: 'javascript:alert(1)' })).media, C.parseWebhook(inbound(ANA, 'w', '', { media: 'http://x/a.jpg' })).media], ['https://cdn.ultramsg.com/a.jpg', '', '']);

console.log('\nMensajes que entran');
let r = await C.handleWebhook({ db, body: inbound(ANA, 'in-1', 'Hola, ya pague') });
equal('el mensaje de un residente va al chat de su condominio', r.condos, [A]);
let chat = (await chatA(ANA).get()).data();
equal('el chat trae su nombre, lote, telefono y un no leido', [chat.names, chat.units, chat.residentIds, chat.phone, chat.unread, chat.lastMessage.text, chat.lastPushname], [['Ana Prueba'], ['C001'], ['ana'], ANA, 1, 'Hola, ya pague', 'Ana WA']);
await C.handleWebhook({ db, body: inbound(ANA, 'in-1', 'Hola, ya pague') });
equal('el mismo aviso dos veces no duplica ni suma otro no leido', [(await allMsgs(chatA(ANA))).length, (await chatA(ANA).get()).data().unread], [1, 1]);
await C.handleWebhook({ db, body: inbound(ANA, 'in-2', 'Le mando el comprobante', { type: 'image', media: 'https://cdn.ultramsg.com/c.jpg', time: sec + 5 }) });
chat = (await chatA(ANA).get()).data();
equal('una imagen tambien es un mensaje; dos no leidos', [chat.unread, chat.lastMessage.type, (await allMsgs(chatA(ANA))).map((m) => m.type)], [2, 'image', ['chat', 'image']]);
r = await C.handleWebhook({ db, body: inbound(BETO, 'in-b', 'Soy Beto') });
chat = (await chatA(BETO).get()).data();
equal('un telefono de dos lotes es un solo chat con los dos', [chat.residentIds, chat.units], [['beto1', 'beto2'], ['C002', 'C003']]);
r = await C.handleWebhook({ db, body: inbound(CARLA, 'in-c', 'Hola') });
equal('un telefono que vive en dos condominios queda en los dos', [r.condos.sort(), (await db.doc(`condominios/${B}/whatsapp_chats/${CARLA}`).get()).data().names], [[A, B].sort(), ['Carla en B']]);
r = await C.handleWebhook({ db, body: inbound(NADIE, 'in-n', 'Quien es?') });
equal('un numero que no es de nadie queda aparte (solo lo ve el master)', [r.condos, (await db.doc(`whatsapp_sin_asignar/${NADIE}`).get()).exists], [[null], true]);
equal('los avisos de grupos no se guardan', (await C.handleWebhook({ db, body: inbound('120363@g.us', 'g-1', 'grupo') })).handled, 0);

console.log('\nEnviar desde OIKOS');
const sent = [];
let failNext = false;
const fakeWa = {
    loadConfig: async () => ({ provider: 'simulado' }),
    canChat: (cfg) => !!cfg,
    sendChat: async (cfg, phone, body, ref) => { sent.push({ phone, body, ref }); if (failNext) { failNext = false; return { ok: false, error: 'rechazado' }; } return { ok: true, id: `Q-${sent.length}` }; },
    chatHistory: async () => [
        { id: 'h-1', from: jid(ANA), to: jid(ME), body: 'Mensaje viejo', fromMe: false, type: 'chat', time: sec - 86400 },
        { id: 'h-2', from: jid(ME), to: jid(ANA), body: 'Respuesta vieja', fromMe: true, type: 'chat', ack: 'read', time: sec - 86000 },
        { id: 'in-1', from: jid(ANA), to: jid(ME), body: 'Hola, ya pague', fromMe: false, type: 'chat', time: sec }
    ]
};
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: 'Gracias, ya lo vemos' } });
equal('se envia al telefono del chat (no a uno que mande el navegador)', [r.ok, sent[0].phone, sent[0].body, r.chatId], [true, ANA, 'Gracias, ya lo vemos', ANA]);
let mine = (await msgsA(ANA).doc(r.id).get()).data();
equal('queda en cola, con quien lo envio', [mine.ack, mine.fromMe, mine.source, mine.sentByName, mine.waId], ['pending', true, 'sisdel', 'Administradora', null]);
await C.handleWebhook({ db, body: { ...outbound(ANA, 'wa-out-1', 'Gracias, ya lo vemos'), referenceId: r.id } });
mine = (await msgsA(ANA).doc(r.id).get()).data();
equal('el aviso de UltraMsg se junta con el mensaje enviado (por la referencia): no se duplica', [mine.waId, mine.ack, (await allMsgs(chatA(ANA))).filter((m) => m.fromMe).length], ['wa-out-1', 'server', 1]);
await C.handleWebhook({ db, body: ack(ANA, 'wa-out-1', 'device') });
await C.handleWebhook({ db, body: ack(ANA, 'wa-out-1', 'read') });
await C.handleWebhook({ db, body: ack(ANA, 'wa-out-1', 'device') });
mine = (await msgsA(ANA).doc(r.id).get()).data();
chat = (await chatA(ANA).get()).data();
equal('las palomitas suben (entregado, leido) y nunca bajan; la lista tambien lo muestra', [mine.ack, chat.lastMessage.ack], ['read', 'read']);
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: 'Otro aviso' } });
await C.handleWebhook({ db, body: outbound(ANA, 'wa-out-2', 'Otro aviso') });
equal('sin referencia, se reconoce por el mismo texto al mismo telefono', [(await msgsA(ANA).doc(r.id).get()).data().waId, (await allMsgs(chatA(ANA))).filter((m) => m.body === 'Otro aviso').length], ['wa-out-2', 1]);
await C.handleWebhook({ db, body: outbound(ANA, 'wa-tel-1', 'Contestado desde el telefono') });
equal('lo que se contesta desde el telefono tambien queda en el chat', (await allMsgs(chatA(ANA))).some((m) => m.waId === 'wa-tel-1' && m.fromMe && m.source === 'whatsapp'), true);
await C.handleWebhook({ db, body: ack(ANA, 'wa-early', 'device') });
await C.handleWebhook({ db, body: outbound(ANA, 'wa-early', 'Llego despues de su palomita') });
const early = (await msgsA(ANA).doc('wa-early').get()).data();
equal('una palomita que llega antes que su mensaje deja un borrador que despues se completa', [early.placeholder, early.body, early.ack], [false, 'Llego despues de su palomita', 'device']);
await C.handleWebhook({ db, body: { ...outbound(ANA, 'wa-out-1', 'Gracias, ya lo vemos'), referenceId: 'otra' } });
equal('el mismo aviso de un enviado otra vez no lo duplica', (await allMsgs(chatA(ANA))).filter((m) => m.body === 'Gracias, ya lo vemos').length, 1);
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: 'Palomita adelantada' } });
await C.handleWebhook({ db, body: ack(ANA, 'wa-out-3', 'device') });
await C.handleWebhook({ db, body: { ...outbound(ANA, 'wa-out-3', 'Palomita adelantada'), referenceId: r.id } });
const shown = (await allMsgs(chatA(ANA))).filter((m) => m.body === 'Palomita adelantada' && !m.duplicateOf);
equal('si la palomita de un enviado llega antes que su aviso, se ve una sola vez, con quien lo envio y su palomita', [shown.length, shown[0] && shown[0].sentByName, shown[0] && shown[0].ack, (await msgsA(ANA).doc(r.id).get()).data().duplicateOf], [1, 'Administradora', 'device', 'wa-out-3']);
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { residentId: 'beto2', text: 'Hola Beto' } });
equal('se le puede escribir a un residente por su ficha (va al chat de su telefono)', [r.chatId, sent[sent.length - 1].phone], [BETO, BETO]);
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: B, caller, data: { residentId: 'carla-b', text: 'Hola Carla' } });
equal('un chat nuevo por la ficha trae los residentes de ese condominio', [(await db.doc(`condominios/${B}/whatsapp_chats/${CARLA}`).get()).data().names], [['Carla en B']]);
failNext = true;
r = await C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: 'Este falla' } });
equal('si WhatsApp no lo acepta, queda marcado como no enviado (no se borra)', [r.ok, (await msgsA(ANA).doc(r.id).get()).data().ack, (await msgsA(ANA).doc(r.id).get()).data().error], [false, 'failed', 'rechazado']);
await rejects('no se envia un mensaje vacio', () => C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: '   ' } }), 'invalid-argument');
await rejects('ni uno demasiado largo', () => C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: ANA, text: 'x'.repeat(4097) } }), 'invalid-argument');
await rejects('ni a un residente sin telefono', () => C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { residentId: 'sinfono', text: 'Hola' } }), 'failed-precondition');
await rejects('ni a un chat de otro condominio (un numero cualquiera)', () => C.sendMessage({ db, whatsapp: fakeWa, condominioId: B, caller, data: { chatId: ANA, text: 'Hola' } }), 'not-found');
await rejects('ni a un numero que no es chat de nadie', () => C.sendMessage({ db, whatsapp: fakeWa, condominioId: A, caller, data: { chatId: '50299998888', text: 'Hola' } }), 'not-found');
await rejects('ni sin WhatsApp conectado', () => C.sendMessage({ db, whatsapp: { ...fakeWa, loadConfig: async () => null }, condominioId: A, caller, data: { chatId: ANA, text: 'Hola' } }), 'failed-precondition');

console.log('\nLeidos e historial');
equal('marcar como leido deja el chat en cero', [(await C.markRead({ db, condominioId: A, caller, data: { chatId: ANA } })).changed, (await chatA(ANA).get()).data().unread, (await chatA(ANA).get()).data().readBy], [true, 0, 'adm-chat']);
await rejects('no se marca un chat de otro condominio', () => C.markRead({ db, condominioId: B, caller, data: { chatId: ANA } }), 'not-found');
const before = (await allMsgs(chatA(ANA))).length;
r = await C.loadHistory({ db, whatsapp: fakeWa, condominioId: A, data: { chatId: ANA } });
chat = (await chatA(ANA).get()).data();
equal('traer los mensajes de antes agrega solo los que faltan, sin no leidos ni mover el chat', [r.saved, (await allMsgs(chatA(ANA))).length - before, chat.unread, chat.lastMessage.text !== 'Mensaje viejo', !!chat.historyLoadedAt], [2, 2, 0, true, true]);
r = await C.loadHistory({ db, whatsapp: fakeWa, condominioId: A, data: { chatId: ANA } });
equal('traerlos otra vez no duplica', r.saved, 0);

console.log('\nEl aviso por internet (funcion whatsappWebhook del emulador)');
const URL_FN = 'http://127.0.0.1:5001/sisdel-datacenter/us-central1/whatsappWebhook';
const token = crypto.randomBytes(12).toString('hex');
const cfgRef = db.doc('_privado/whatsapp');
const cfgBefore = (await cfgRef.get()).data() || {};
await cfgRef.set({ webhookTokenHash: crypto.createHash('sha256').update(token, 'utf8').digest('hex') }, { merge: true });
const post = (t, body) => fetch(`${URL_FN}?token=${encodeURIComponent(t)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let res = await post('clave-falsa', inbound(ANA, 'web-x', 'Falso'));
equal('sin la clave correcta se rechaza y no se guarda nada', [res.status, (await msgsA(ANA).doc('web-x').get()).exists], [403, false]);
res = await post(token, inbound(ANA, 'web-1', 'Por internet'));
equal('con la clave, el mensaje llega al chat', [res.status, (await msgsA(ANA).doc('web-1').get()).exists], [200, true]);
res = await fetch(`${URL_FN}?token=${encodeURIComponent(token)}`);
equal('solo acepta avisos POST', res.status, 405);
await cfgRef.set({ webhookTokenHash: cfgBefore.webhookTokenHash || null }, { merge: true });

await cleanup();
console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
