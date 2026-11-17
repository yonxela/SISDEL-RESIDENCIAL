// Pruebas del WhatsApp oficial de Meta con plantillas (functions/src/rondas/meta-estado.js) con un fetch de mentira: nada sale
// a internet. Corre sin emuladores.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../functions/src/rondas/meta-estado.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

const config = { channel: 'meta', metaToken: 'TOKEN-SECRETO', metaPhoneId: '123456', metaTemplates: {
    mora: { name: 'aviso_mora', language: 'es', params: ['nombre', 'casa', 'saldo'], body: 'Hola {{1}}, casa {{2}}: debe {{3}}.' },
    general: { name: 'aviso_general', language: 'es', params: [], body: 'Aviso general de la administración.' }
} };

console.log('\nCanal y plantillas');
ok('solo es Meta con channel meta y sus claves', M.usesMeta(config) && !M.usesMeta({ ...config, channel: 'ultramsg' }) && !M.usesMeta({ channel: 'meta' }) && !M.usesMeta(null));
equal('la plantilla de mora (mensaje por morosidad)', M.templateFor(config, 'mora').name, 'aviso_mora');
equal('la de mensajes varios', M.templateFor(config, 'varios').name, 'aviso_general');
equal('sin plantilla configurada es null', M.templateFor({ ...config, metaTemplates: {} }, 'varios'), null);
equal('un nombre invalido no se acepta (solo minusculas, numeros y guion bajo)', M.normalizeTemplate({ name: 'Aviso Mora', params: [] }), null);
equal('un dato que no existe tampoco', M.normalizeTemplate({ name: 'aviso', params: ['nombre', 'telefono'] }), null);
equal('el idioma por defecto es es', M.normalizeTemplate({ name: 'aviso', params: ['nombre'] }).language, 'es');
equal('los datos se normalizan (mayusculas y espacios)', M.normalizeTemplate({ name: 'aviso', params: [' Nombre ', 'CASA'] }).params, ['nombre', 'casa']);

console.log('\nDatos de cada residente');
equal('los datos van en el orden de los huecos', M.templateParams(M.templateFor(config, 'mora'), { nombre: 'Ana', casa: 'A1', saldo: 'Q10.00', cuotas: 'Q9.00' }), ['Ana', 'A1', 'Q10.00']);
equal('un dato vacio o faltante pasa a un guion (Meta rechaza parametros vacios)', M.templateParams(M.templateFor(config, 'mora'), { nombre: '', casa: null }), ['-', '-', '-']);
equal('sin saltos de linea, tabuladores ni espacios repetidos (Meta los rechaza)', M.cleanParam('Ana\nPérez\t  López   Soto'), 'Ana Pérez López Soto');
equal('un dato muy largo se corta', M.cleanParam('x'.repeat(2000)).length, 1000);
equal('el texto que le llega al residente es el de la plantilla con sus datos', M.renderTemplate(M.templateFor(config, 'mora'), ['Ana', 'A1', 'Q10.00']), 'Hola Ana, casa A1: debe Q10.00.');
equal('cuenta los huecos de un texto', [M.bodyParamCount('Hola {{1}} y {{2}}'), M.bodyParamCount('sin huecos'), M.bodyParamCount('{{3}} {{1}}')], [2, 0, 3]);

console.log('\nEnviar con plantilla');
const calls = [];
const reply = (body, status = 200) => async (url, init) => { calls.push({ url: String(url), init }); return { ok: status < 400, status, json: async () => body }; };
const payload = M.buildTemplatePayload('50241001708', M.templateFor(config, 'mora'), ['Ana', 'A1', 'Q10.00']);
equal('el mensaje lleva la plantilla, el idioma y los datos', [payload.type, payload.template.name, payload.template.language.code, payload.template.components[0].type, payload.template.components[0].parameters.map((p) => p.text)], ['template', 'aviso_mora', 'es', 'body', ['Ana', 'A1', 'Q10.00']]);
equal('una plantilla sin huecos no lleva componentes', M.buildTemplatePayload('502', M.templateFor(config, 'varios'), []).template.components, []);
const sent = await M.sendTemplate(config, '50241001708', M.templateFor(config, 'mora'), ['Ana', 'A1', 'Q10.00'], reply({ messages: [{ id: 'wamid.ABC' }] }));
equal('Meta acepta: devuelve el id del mensaje', sent, { ok: true, id: 'wamid.ABC' });
ok('va a la API del numero con el token en la cabecera (no en la direccion)', calls[0].url === 'https://graph.facebook.com/v21.0/123456/messages' && calls[0].init.headers.Authorization === 'Bearer TOKEN-SECRETO' && !calls[0].url.includes('TOKEN'));
ok('y el cuerpo es el de la plantilla', JSON.parse(calls[0].init.body).template.name === 'aviso_mora');
const refused = await M.sendTemplate(config, '502', M.templateFor(config, 'mora'), ['a', 'b', 'c'], reply({ error: { code: 132001, message: 'Template name does not exist in the translation' } }, 404));
equal('Meta rechaza (plantilla no aprobada o no existe): devuelve el motivo y su codigo', [refused.ok, refused.code, /Template name/.test(refused.error)], [false, 132001, true]);
equal('sin respuesta de Meta no truena', (await M.sendTemplate(config, '502', M.templateFor(config, 'mora'), [], async () => { throw new Error('red caida'); })).ok, false);
ok('el resultado nunca trae el token', !JSON.stringify([sent, refused]).includes('TOKEN-SECRETO'));
equal('un texto libre tambien sale (solo llega a quien escribio en las ultimas 24 h)', (await M.sendText(config, '502', 'hola', reply({ messages: [{ id: 'wamid.X' }] }))).ok, true);

console.log('\nConexion del numero');
equal('CONNECTED = conectado, con la calidad del numero', await M.connection(config, reply({ status: 'CONNECTED', quality_rating: 'GREEN', verified_name: 'Residenciales La Perla', display_phone_number: '+502 1111 2222' })), { connected: true, state: 'connected', provider: 'meta', quality: 'GREEN', name: 'Residenciales La Perla', number: '+502 1111 2222' });
equal('FLAGGED (calidad baja) todavia puede enviar', (await M.connection(config, reply({ status: 'FLAGGED' }))).connected, true);
for (const status of ['RESTRICTED', 'DISCONNECTED', 'PENDING']) equal(`${status} = no se puede enviar`, (await M.connection(config, reply({ status }))).connected, false);
equal('un token vencido (codigo 190) se dice', await M.connection(config, reply({ error: { code: 190, message: 'Error validating access token' } }, 401)), { connected: false, state: 'token-invalido', provider: 'meta' });
equal('si Meta no responde no se sabe (null): se deja seguir', (await M.connection(config, async () => { throw new Error('red caida'); })).connected, null);
equal('sin claves de Meta no se sabe', (await M.connection({ channel: 'ultramsg' })).connected, null);
ok('el texto del estado empieza como siempre (la pantalla ofrece enviarlo a mano)', M.describeConnection({ state: 'restricted' }).startsWith('WhatsApp no está conectado') && /token de acceso/.test(M.describeConnection({ state: 'token-invalido' })));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
