// Pruebas del estado de la conexion de UltraMsg (functions/src/rondas/ultramsg-estado.js) con un fetch de mentira:
// nada sale a internet. Corre sin emuladores.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../functions/src/rondas/ultramsg-estado.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

const config = { ultramsgInstance: 'instance123', ultramsgToken: 'TOKEN-SECRETO' };
const urls = [];
const reply = (body, status = 200) => async (url) => { urls.push(String(url)); return { ok: status < 400, status, json: async () => body }; };

console.log('\nConexion');
equal('authenticated = conectado', await E.connection(config, reply({ status: { accountStatus: { status: 'authenticated', substatus: 'normal' } } })), { connected: true, state: 'authenticated', provider: 'ultramsg' });
equal('standby = desconectado (el caso del 2026-11-16: UltraMsg aceptaba y dejaba en cola)', await E.connection(config, reply({ status: { accountStatus: { status: 'standby', substatus: 'normal' } } })), { connected: false, state: 'standby', provider: 'ultramsg' });
for (const state of ['qr', 'disconnected', 'loading', 'retrying', 'initialize']) {
    equal(`${state} = desconectado`, (await E.connection(config, reply({ status: { accountStatus: { status: state } } }))).connected, false);
}
equal('una respuesta sin estado no se sabe (null): se deja seguir', (await E.connection(config, reply({ error: 'token invalido' }, 401))).connected, null);
equal('un error de red tampoco se sabe', (await E.connection(config, async () => { throw new Error('red caida'); })).connected, null);
equal('una respuesta que no es json tampoco', (await E.connection(config, async () => ({ ok: true, json: async () => { throw new Error('no json'); } }))).connected, null);
equal('el proveedor simulado (emuladores) siempre esta conectado', (await E.connection({ provider: 'simulado' })).connected, true);
equal('sin configuracion: desconectado', (await E.connection(null)).connected, false);
equal('solo Meta: no se puede consultar (null)', (await E.connection({ metaToken: 'x', metaPhoneId: 'y' })).connected, null);
ok('se consulta la instancia y el token va en la direccion, nunca en el resultado', urls.length > 0 && urls[0].startsWith('https://api.ultramsg.com/instance123/instance/status?') && urls[0].includes('token=TOKEN-SECRETO'));
ok('el resultado no trae el token', !JSON.stringify(await E.connection(config, reply({ status: { accountStatus: { status: 'standby' } } }))).includes('TOKEN-SECRETO'));

console.log('\nCola de UltraMsg');
equal('cuenta lo que esta en cola', await E.queueStats(config, reply({ messages_statistics: { sent: 4, queue: 709, unsent: 0, invalid: 0, expired: 0 } })), { queued: 709, sent: 4, unsent: 0, invalid: 0, expired: 0 });
equal('sin datos no se sabe (null)', await E.queueStats(config, reply({})), null);
equal('un error de red no se sabe', await E.queueStats(config, async () => { throw new Error('red caida'); }), null);
equal('el proveedor simulado no tiene cola', await E.queueStats({ provider: 'simulado' }), null);

console.log('\nTexto para el usuario');
const standby = E.describeConnection({ state: 'standby' });
const qr = E.describeConnection({ state: 'qr' });
ok('empieza con "WhatsApp no está conectado" (la pantalla ofrece enviarlo a mano con wa.me) y dice el estado', standby.startsWith('WhatsApp no está conectado') && standby.includes('standby'));
ok('en standby manda a revisar el telefono y la vinculacion', /teléfono vinculado/.test(standby) && /Authentication/.test(standby));
ok('con qr manda a escanear el codigo', /escanee el código QR/.test(qr));
ok('sin estado conocido tambien avisa', E.describeConnection(null).includes('desconocido'));

console.log('\nQue paso de verdad con cada mensaje');
const row = (extra) => ({ id: 1, to: '50241001708@c.us', status: 'sent', ack: 'pending', created_at: 1000, failed_reason: '', ...extra });
equal('aceptado y sin confirmar = pendiente', E.classify(row({})).state, 'pendiente');
equal('ack server = enviado (llego a WhatsApp, una palomita)', E.classify(row({ ack: 'server' })).state, 'enviado');
for (const ack of ['device', 'read', 'played']) equal(`ack ${ack} = entregado`, E.classify(row({ ack })).state, 'entregado');
equal('en cola', E.classify(row({ status: 'queue' })).state, 'en_cola');
equal('rechazado por WhatsApp trae su motivo (temporary_block)', E.classify(row({ status: 'unsent', failed_reason: 'temporary_block' })), { state: 'rechazado', reason: 'temporary_block' });
equal('invalido = rechazado (numero sin WhatsApp)', E.classify(row({ status: 'invalid', failed_reason: '' })), { state: 'rechazado', reason: 'invalid' });
equal('vencido en la cola = rechazado', E.classify(row({ status: 'expired' })), { state: 'rechazado', reason: 'expired' });
equal('sin mensaje = desconocido', E.classify(null).state, 'desconocido');
ok('el motivo se explica en español', /bloqueó temporalmente/.test(E.describeReason('temporary_block')) && /no tiene WhatsApp/.test(E.describeReason('invalid')) && /venció/.test(E.describeReason('expired')));

console.log('\nUn envio suelto: el mensaje mas reciente a ese telefono');
const rows1 = [row({ id: 1, created_at: 500, status: 'sent', ack: 'device' }), row({ id: 2, created_at: 1000, status: 'unsent', failed_reason: 'temporary_block' }), row({ id: 3, to: '50299999999@c.us', created_at: 1001, status: 'sent', ack: 'read' })];
equal('toma el mas reciente de ese telefono, no el de otro ni uno viejo', E.deliveryFor(rows1, '50241001708', 998), { state: 'rechazado', reason: 'temporary_block', found: true });
equal('si no hay ninguno desde ese momento: desconocido', E.deliveryFor(rows1, '50241001708', 2000), { state: 'desconocido', reason: '', found: false });
equal('el telefono se compara por sus ultimos 8 digitos (con o sin 502)', E.deliveryFor(rows1, '41001708', 998).state, 'rechazado');

console.log('\nUn envio a muchos: a cada uno le toca su mensaje');
const mRows = [
    row({ id: 1, to: '50211110001@c.us', created_at: 1000, status: 'sent', ack: 'device' }),
    row({ id: 2, to: '50211110002@c.us', created_at: 1010, status: 'unsent', failed_reason: 'temporary_block' }),
    // un propietario con dos lotes: dos mensajes al mismo telefono
    row({ id: 3, to: '50211110003@c.us', created_at: 1020, status: 'sent', ack: 'device' }),
    row({ id: 4, to: '50211110003@c.us', created_at: 1030, status: 'unsent', failed_reason: 'temporary_block' }),
    row({ id: 5, to: '50211110099@c.us', created_at: 1040, status: 'sent', ack: 'read' })
];
const match = E.matchCampaign(mRows, [
    { id: 'a', phone: '50211110001', sentAtMs: 1000 * 1000 },
    { id: 'b', phone: '50211110002', sentAtMs: 1010 * 1000 },
    { id: 'c1', phone: '50211110003', sentAtMs: 1021 * 1000 },
    { id: 'c2', phone: '50211110003', sentAtMs: 1031 * 1000 },
    { id: 'd', phone: '50211110004', sentAtMs: 1050 * 1000 }
]);
equal('cada destinatario recibe SU mensaje (dos lotes con el mismo telefono: cada uno el suyo)', [...match.entries()].map(([id, r]) => [id, r ? r.id : null]), [['a', 1], ['b', 2], ['c1', 3], ['c2', 4], ['d', null]]);
equal('un mensaje de otro telefono no se le da a nadie', [...match.values()].filter((r) => r && r.id === 5).length, 0);
equal('uno viejo (fuera de la tolerancia de 5 minutos) no cuenta', E.matchCampaign([row({ created_at: 100 })], [{ id: 'x', phone: '50241001708', sentAtMs: 1000 * 1000 }]).get('x'), null);

console.log('\nLeer el listado de UltraMsg');
const pages = [];
const pager = (all) => async (url) => {
    const params = new URL(url).searchParams;
    pages.push(Number(params.get('page')));
    const page = Number(params.get('page'));
    const slice = all.slice((page - 1) * 100, page * 100);
    return { ok: true, status: 200, json: async () => ({ messages: slice }) };
};
const many = Array.from({ length: 250 }, (_, i) => row({ id: 250 - i, created_at: 5000 - i }));
const read = await E.listMessages(config, { maxPages: 12 }, pager(many));
equal('lee todas las paginas de 100 (3 paginas para 250)', [read.length, pages], [250, [1, 2, 3]]);
pages.length = 0;
const stopped = await E.listMessages(config, { sinceSec: 4950, maxPages: 12 }, pager(many));
equal('se detiene al llegar a mensajes mas viejos que el envio (no lee de mas)', [pages, stopped.length], [[1], 100]);
equal('con un error de red devuelve null', await E.listMessages(config, {}, async () => { throw new Error('red caida'); }), null);
equal('el proveedor simulado no tiene listado', await E.listMessages({ provider: 'simulado' }), null);
ok('el token va en la direccion del listado y no en el resultado', pages.length === 1 && !JSON.stringify(stopped).includes('TOKEN-SECRETO'));

console.log('\nNumero restringido por WhatsApp (los mensajes salen "enviados" y nunca reciben palomita)');
{
    const NOW = 1800000000;
    const old = (o = {}) => ({ status: 'sent', ack: 'pending', created_at: NOW - 600, to: '50255551111@c.us', ...o });
    const H = (rows) => E.healthFrom(rows, NOW);
    equal('el caso de La Perla (16 y 17/11/2026): 3 o mas sin palomita = no deja salir', H([old(), old({ created_at: NOW - 900 }), old({ created_at: NOW - 1200 })]).confirming, false);
    equal('desde cuando: el mas viejo de los atorados', H([old(), old({ created_at: NOW - 900 }), old({ created_at: NOW - 1200 })]).since, NOW - 1200);
    equal('un mensaje con una palomita (server) despues de los atorados = ya salen', H([old({ ack: 'server', created_at: NOW - 5 }), old(), old(), old()]).confirming, true);
    for (const ack of ['device', 'read', 'played']) equal(`la palomita ${ack} tambien cuenta como que salio`, H([old({ ack }), old(), old(), old()]).confirming, true);
    equal('lo de antes del ultimo bueno no importa', H([old({ ack: 'server', created_at: NOW - 100 }), ...Array.from({ length: 10 }, (_, i) => old({ created_at: NOW - 1000 - i }))]).stuck, 0);
    equal('dos atorados no bastan (puede ser algo suelto)', H([old(), old({ created_at: NOW - 700 }), old({ ack: 'server', created_at: NOW - 800 })]).confirming, true);
    equal('dos atorados sin ningun bueno: no se sabe (null), se deja seguir', H([old(), old({ created_at: NOW - 700 })]).confirming, null);
    equal('un mensaje de menos de 3 minutos todavia puede estar en camino: no cuenta', H([old({ created_at: NOW - 30 }), old({ created_at: NOW - 60 }), old({ created_at: NOW - 170 })]).confirming, null);
    equal('el bloqueo temporal (temporary_block) basta solo', H([{ status: 'unsent', failed_reason: 'temporary_block', ack: 'pending', created_at: NOW - 30 }]).confirming, false);
    equal('y lo dice como bloqueo', H([{ status: 'unsent', failed_reason: 'temporary_block', ack: 'pending', created_at: NOW - 30 }]).blocked, 1);
    equal('un numero sin WhatsApp (invalid) no dice nada del numero del condominio', H([old({ status: 'invalid' }), old({ status: 'invalid' }), old({ status: 'invalid' }), old({ ack: 'server', created_at: NOW - 900 })]).confirming, true);
    equal('lo que sigue en cola (eso lo ve la conexion) o vencio tampoco', H([old({ status: 'queue' }), old({ status: 'expired' }), old({ status: 'queue' })]).confirming, null);
    equal('lo de hace mas de 48 horas ya no cuenta', H([old({ created_at: NOW - 49 * 3600 }), old({ created_at: NOW - 50 * 3600 }), old({ created_at: NOW - 51 * 3600 })]).confirming, null);
    equal('sin mensajes no se sabe', H([]).confirming, null);
    equal('sin listado tampoco', E.healthFrom(null, NOW).confirming, null);
    const text = E.describeHealth(H([old(), old({ created_at: NOW - 900 }), old({ created_at: NOW - 1200 })]));
    ok('el aviso empieza como lo reconoce OIKOS y dice cuantos', text.startsWith('WhatsApp no está dejando salir los mensajes') && text.includes('los últimos 3 mensajes'));
    ok('el aviso dice que hacer: no enviar, mirar el telefono y probar', /no se envía nada/.test(text) && /WhatsApp Business/.test(text) && /Enviar prueba/.test(text));
    ok('el aviso del bloqueo temporal lo nombra', E.describeHealth({ confirming: false, blocked: 1 }).includes('temporary_block'));
    const fromApi = await E.health(config, reply({ messages: [old({ created_at: Math.floor(Date.now() / 1000) - 600 }), old({ created_at: Math.floor(Date.now() / 1000) - 700 }), old({ created_at: Math.floor(Date.now() / 1000) - 800 })] }));
    equal('health pregunta el listado de UltraMsg', fromApi.confirming, false);
    equal('health sin poder leer el listado: no se sabe', (await E.health(config, async () => { throw new Error('red caida'); })).confirming, null);
    equal('health del proveedor simulado: no se sabe', (await E.health({ provider: 'simulado' })).confirming, null);
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
