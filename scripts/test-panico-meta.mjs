// Pruebas de las alertas de panico por el WhatsApp oficial de Meta (functions/src/rondas/panico-meta.js y whatsapp.sendPanic) con un
// Meta y un UltraMsg de mentira: nada sale a internet. Corre sin emuladores.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import url from 'node:url';

const require = createRequire(import.meta.url);
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sisdel-datacenter';
const P = require('../functions/src/rondas/panico-meta.js');
const M = require('../functions/src/rondas/meta-estado.js');
const A = require('../functions/src/rondas/avisos.js');
const here = url.fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(here + f, 'utf8');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

const base = { metaToken: 'TOKEN-SECRETO', metaPhoneId: '1449161771620256', central: '50243093379', ultramsgInstance: 'instancia', ultramsgToken: 'U-SECRETO' };
const withTemplates = { ...base, panicChannel: 'meta', metaTemplates: { ...P.DEFAULT_TEMPLATES } };

console.log('\nCanal y plantillas');
ok('solo es Meta con panicChannel meta y las claves de Meta', P.usesPanicMeta(withTemplates) && !P.usesPanicMeta(base) && !P.usesPanicMeta({ panicChannel: 'meta' }) && !P.usesPanicMeta(null));
ok('el canal de los recordatorios (channel) no cambia el del panico', !P.usesPanicMeta({ ...base, channel: 'meta' }) && !M.usesMeta({ ...withTemplates }));
for (const key of P.PANIC_KINDS) {
    const tpl = P.panicTemplate(withTemplates, key);
    ok(`${key}: la plantilla es valida`, !!tpl);
    equal(`${key}: tantos datos como huecos tiene el texto`, M.bodyParamCount(tpl.body), tpl.params.length);
    equal(`${key}: en espanol (es)`, tpl.language, 'es');
}
equal('nombres de las plantillas enviadas a Meta', P.PANIC_KINDS.map((k) => P.DEFAULT_TEMPLATES[k].name), ['alerta_panico', 'alerta_panico_familia', 'prueba_sin_novedad']);
equal('sin la plantilla es null', P.panicTemplate({ ...base, metaTemplates: {} }, 'panico'), null);
ok('los datos del panico no valen para una plantilla de residentes (y al reves)', M.normalizeTemplate({ name: 'x', params: ['ubicacion'] }) === null && !!M.normalizeTemplate({ name: 'x', params: ['ubicacion'] }, P.PANIC_VARIABLES) && M.normalizeTemplate({ name: 'x', params: ['saldo'] }, P.PANIC_VARIABLES) === null);

console.log('\nHora de Guatemala');
equal('16:35 UTC son las 10:35 AM', P.gtTime('2026-11-25T16:35:00.000Z'), '10:35 AM');
equal('04:05 UTC del dia siguiente son las 10:05 PM', P.gtTime('2026-11-26T04:05:00.000Z'), '10:05 PM');
equal('medianoche: 12:00 AM', P.gtTime('2026-11-25T06:00:00.000Z'), '12:00 AM');
equal('mediodia: 12:00 PM', P.gtTime('2026-11-25T18:00:00.000Z'), '12:00 PM');
ok('sin fecha, la hora de ahora', /^\d{1,2}:\d{2} [AP]M$/.test(P.gtTime()));

console.log('\nDatos de la alerta');
const vecino = { source: 'vecino', userName: 'Ana García', casa: 'Lote A012', phone: '5555-5678', lat: 14.542, lng: -90.453, createdAt: '2026-11-25T16:35:00.000Z' };
let v = P.panicVars({ alert: vecino, condoName: 'La Perla', garitaPhone: '50244440001' });
equal('vecino con GPS', v, { condominio: 'La Perla', nombre: 'Ana García', lote: 'A012', hora: '10:35 AM', ubicacion: 'https://maps.google.com/?q=14.542,-90.453', telefono: '5555-5678', contacto: '5555-5678' });
v = P.panicVars({ alert: { ...vecino, lat: null, lng: null, phone: '' }, condoName: 'La Perla', garitaPhone: '50244440001' });
equal('sin GPS lo dice', v.ubicacion, 'no disponible (el teléfono no envió su GPS)');
equal('sin telefono del vecino: no registrado', v.telefono, 'no registrado');
equal('sin telefono del vecino, el familiar llama a la garita', v.contacto, '4444-0001');
equal('ni vecino ni garita: el numero de la garita', P.panicVars({ alert: { ...vecino, phone: '' }, condoName: 'X' }).contacto, 'número de la garita');
v = P.panicVars({ alert: { source: 'guardia', userName: 'Pedro', casa: '' }, condoName: 'La Perla' });
equal('guardia: se dice que es un guardia', [v.nombre, v.lote], ['Guardia Pedro', 'sin lote (alerta de un guardia)']);
equal('vecino sin lote', P.panicVars({ alert: { ...vecino, casa: '' } }).lote, 'sin lote registrado');
equal('sin nombre del condominio', P.panicVars({ alert: vecino }).condominio, 'su condominio');
equal('"Casa 12" se deja como esta', P.loteOf('Casa 12'), 'Casa 12');
equal('telefono de otro pais', P.displayPhone('525512345678'), '+525512345678');
const tPan = P.panicTemplate(withTemplates, 'panico');
equal('alerta: el texto que llega a la garita', M.renderTemplate(tPan, M.templateParams(tPan, P.panicVars({ alert: vecino, condoName: 'La Perla' }))),
    'ALERTA DE PÁNICO en La Perla. Ana García, del lote A012, presionó el botón de pánico a las 10:35 AM. Ubicación: https://maps.google.com/?q=14.542,-90.453. Teléfono del vecino: 5555-5678. Por favor atienda la emergencia de inmediato.');
const tFam = P.panicTemplate(withTemplates, 'panicoFamilia');
equal('familiares: el orden de los datos', M.templateParams(tFam, P.panicVars({ alert: vecino, condoName: 'La Perla' })), ['La Perla', 'Ana García', '10:35 AM', 'https://maps.google.com/?q=14.542,-90.453', '5555-5678']);
const tPru = P.panicTemplate(withTemplates, 'prueba');
equal('prueba: el orden de los datos', M.templateParams(tPru, P.panicVars({ alert: vecino, condoName: 'La Perla' })), ['Ana García', 'A012', 'La Perla', '10:35 AM']);
equal('un nombre con salto de linea no rompe la plantilla (Meta los rechaza)', M.templateParams(tPru, P.panicVars({ alert: { ...vecino, userName: 'Ana\nGarcía' } }))[0], 'Ana García');
const tv = P.testVars('La Perla');
equal('mensaje de prueba de Configuracion: sin datos de un vecino', [tv.nombre, tv.lote, tv.condominio], ['La administración', 'de prueba', 'La Perla']);

console.log('\nA que plantilla va cada destinatario (avisos.js)');
const baseRec = { alert: vecino, condoName: 'La Perla', central: '50243093379', contacts: [{ name: 'Luis', phone: '5555-1111' }], staff: [{ name: 'Fernando', phone: '5555-1234' }], config: { phones: [{ kind: 'garita', name: 'Garita', phone: '4444-0001' }, { kind: 'pnc', name: 'PNC', phone: '4444-0002' }] } };
equal('alerta: central, garita, PNC y personal la alerta; familiares su aviso', A.recipientsFor(baseRec).map((r) => [r.nombre, r.tipo]),
    [['Central SISDEL', 'panico'], ['Garita', 'panico'], ['PNC', 'panico'], ['Fernando', 'panico'], ['Luis', 'panicoFamilia']]);
equal('prueba: central, garitas y el propio vecino, todos la plantilla de prueba', A.recipientsFor({ ...baseRec, alert: { ...vecino, simulacro: true } }).map((r) => [r.nombre, r.tipo]),
    [['Central SISDEL', 'prueba'], ['Garita', 'prueba'], ['Ana García', 'prueba']]);
ok('panico-avisos.js (navegador) sigue siendo copia identica', read('panico-avisos.js') === read('functions/src/rondas/avisos.js'));

console.log('\nEnviar (con un Meta y un UltraMsg de mentira)');
function fakes(metaResult) {
    const calls = { template: [], legacy: [] };
    return {
        calls,
        deps: {
            sendTemplate: async (config, to, tpl, params) => {
                calls.template.push({ to, name: tpl.name, params });
                if (metaResult === 'throw') throw new Error('red caida');
                return metaResult;
            },
            legacy: async (config, to, message) => { calls.legacy.push({ to, message }); return 'ULTRAMSG'; }
        }
    };
}
const vars = P.panicVars({ alert: vecino, condoName: 'La Perla' });
{
    const f = fakes({ ok: true });
    const canal = await P.sendPanicMessage(base, '50244440001', 'texto libre', { tipo: 'panico', vars, errors: [] }, f.deps);
    equal('sin panicChannel: el camino de siempre, sin tocar Meta', [canal, f.calls.template.length, f.calls.legacy.length, f.calls.legacy[0].message], ['ULTRAMSG', 0, 1, 'texto libre']);
}
{
    const f = fakes({ ok: true, id: 'wamid.1' });
    const errors = [];
    const canal = await P.sendPanicMessage(withTemplates, '50244440001', 'texto libre', { tipo: 'panico', vars, errors }, f.deps);
    equal('con Meta: sale la plantilla y no UltraMsg', [canal, f.calls.template[0].name, f.calls.legacy.length, errors.length], ['META', 'alerta_panico', 0, 0]);
    equal('con sus datos en orden', f.calls.template[0].params, ['La Perla', 'Ana García', 'A012', '10:35 AM', 'https://maps.google.com/?q=14.542,-90.453', '5555-5678']);
}
{
    const f = fakes({ ok: false, code: 132001, error: 'Template name does not exist in the translation' });
    const errors = [];
    const canal = await P.sendPanicMessage(withTemplates, '50255551111', 'aviso libre', { tipo: 'panicoFamilia', vars, errors }, f.deps);
    equal('alerta de verdad que Meta rechaza: se intenta por UltraMsg', [canal, f.calls.template[0].name, f.calls.legacy.length], ['ULTRAMSG', 'alerta_panico_familia', 1]);
    equal('y queda el motivo de Meta', errors, ['Meta (132001): Template name does not exist in the translation']);
}
{
    const f = fakes({ ok: false, code: 131056, error: 'pair rate limit hit' });
    const errors = [];
    const canal = await P.sendPanicMessage(withTemplates, '50255555678', 'prueba libre', { tipo: 'prueba', vars, errors, drill: true }, f.deps);
    equal('una PRUEBA que Meta rechaza NO cae a UltraMsg', [canal, f.calls.legacy.length, errors.length], [null, 0, 1]);
}
{
    const f = fakes({ ok: true });
    const errors = [];
    const sinPlantilla = { ...withTemplates, metaTemplates: { panico: P.DEFAULT_TEMPLATES.panico } };
    const canal = await P.sendPanicMessage(sinPlantilla, '50255551111', 'aviso libre', { tipo: 'panicoFamilia', vars, errors }, f.deps);
    equal('alerta sin su plantilla: el camino de siempre y lo anota', [canal, f.calls.template.length, errors[0]], ['ULTRAMSG', 0, 'Falta la plantilla de Meta para "panicoFamilia"']);
    const f2 = fakes({ ok: true });
    const canal2 = await P.sendPanicMessage(sinPlantilla, '50255555678', 'x', { tipo: 'prueba', vars, errors: [], drill: true }, f2.deps);
    equal('prueba sin su plantilla: no sale (no cae a UltraMsg)', [canal2, f2.calls.legacy.length], [null, 0]);
}
{
    const f = fakes('throw');
    const errors = [];
    const canal = await P.sendPanicMessage(withTemplates, '50244440001', 'x', { tipo: 'panico', vars, errors }, f.deps);
    equal('si Meta falla de golpe: se intenta por UltraMsg y se anota', [canal, errors[0]], ['ULTRAMSG', 'Meta (0): Meta no respondió']);
}

console.log('\nwhatsapp.sendPanic de punta a punta (fetch de mentira)');
{
    const W = require('../functions/src/rondas/whatsapp.js');
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (u, init) => {
        seen.push({ url: String(u), body: init && init.body ? String(init.body) : '', auth: init && init.headers ? init.headers.Authorization : '' });
        if (String(u).includes('graph.facebook.com')) return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ sent: 'true' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const canal = await W.sendPanic(withTemplates, '50244440001', 'texto libre', { tipo: 'panico', vars, errors: [] });
        const payload = JSON.parse(seen[0].body);
        equal('sale por Meta al numero oficial', [canal, seen.length, seen[0].url], ['META', 1, 'https://graph.facebook.com/v21.0/1449161771620256/messages']);
        equal('como plantilla alerta_panico en es', [payload.type, payload.template.name, payload.template.language.code, payload.to], ['template', 'alerta_panico', 'es', '50244440001']);
        equal('con los 6 datos en el cuerpo', payload.template.components[0].parameters.map((x) => x.text), ['La Perla', 'Ana García', 'A012', '10:35 AM', 'https://maps.google.com/?q=14.542,-90.453', '5555-5678']);
        ok('el token va solo en la cabecera, nunca en el cuerpo', seen[0].auth === 'Bearer TOKEN-SECRETO' && !seen[0].body.includes('TOKEN-SECRETO'));
        seen.length = 0;
        const canal2 = await W.sendPanic(base, '50244440001', 'texto libre', { tipo: 'panico', vars, errors: [] });
        equal('sin panicChannel: sale por UltraMsg como siempre', [canal2, seen.length, seen[0].url.includes('api.ultramsg.com')], ['ULTRAMSG', 1, true]);
        equal('en el emulador (simulado) no sale nada', await W.sendPanic({ provider: 'simulado', ...withTemplates }, '50244440001', 'x', { tipo: 'panico', vars }), 'SIMULADO');
    } finally {
        globalThis.fetch = realFetch;
    }
}

console.log('\nConexiones');
const idx = read('functions/src/rondas/index.js');
ok('onPanicCreated manda cada aviso con sendPanic, su tipo y los datos de la alerta', /whatsapp\.sendPanic\(config, r\.telefono, r\.mensaje, \{ tipo: r\.tipo, vars, errors, drill: isDrill\(alert\) \}\)/.test(idx) && !/whatsapp\.send\(config, r\.telefono/.test(idx));
ok('el motivo de lo que no salio queda en cada destinatario', /error: errors\.join/.test(idx));
const cfgFn = read('functions/src/panico-config.js');
ok('la prueba de Configuracion usa la plantilla de prueba y no cae a UltraMsg', /sendPanic\(config, p\.phone, text, \{ tipo: 'prueba', vars, errors: \[\], drill: true \}\)/.test(cfgFn));
const script = read('scripts/set-whatsapp-plantillas.mjs');
ok('el script carga las plantillas (--panico) y cambia el canal (--canal-panico)', script.includes("args.panico") && script.includes("args['canal-panico']") && script.includes('delete next.panicChannel'));
ok('activar el canal exige el token y las 3 plantillas', /faltan plantillas de panico/.test(script) && /falta el token o el numero de Meta/.test(script));

console.log(`\n${passed} pruebas pasaron${failures.length ? `, ${failures.length} fallaron:\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
