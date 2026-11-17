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

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
