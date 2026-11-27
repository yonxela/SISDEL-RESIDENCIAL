// Pruebas de la parte de servidor de rondas (avisos de WhatsApp y limpieza diaria): sin emuladores.
// Uso: node test-rondas-servidor.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../functions/src/rondas/avisos.js');
// mantenimiento.js carga firebase-admin al importarse; las funciones de seleccion no lo usan
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sisdel-datacenter';
const M = require('../functions/src/rondas/mantenimiento.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

console.log('\nTelefonos');
equal('8 digitos se toma como Guatemala', A.normalizePhone('5555-1234'), '50255551234');
equal('con codigo de pais se respeta', A.normalizePhone('+52 55 1234 5678'), '525512345678');
equal('numero incompleto se descarta', A.normalizePhone('1234'), '');

console.log('\nDestinatarios');
const vecino = { source: 'vecino', userName: 'Ana García', casa: 'Casa 12', phone: '5555-5678', lat: 14.542, lng: -90.453 };
let rec = A.recipientsFor({
    alert: vecino, condoName: 'Villa Ferrer', central: '50243093379',
    contacts: [{ name: 'Luis', phone: '5555-1111' }, { name: 'Sin numero', phone: '' }, { name: 'Repetido', phone: '+502 5555 1111' }],
    staff: [{ name: 'Fernando', phone: '5555-1234' }]
});
equal('vecino: central, personal y familiares, sin repetidos', rec.map((r) => [r.nombre, r.telefono]), [['Central SISDEL', '50243093379'], ['Fernando', '50255551234'], ['Luis', '50255551111']]);
equal('el mensaje a familiares lleva el mapa', /maps\.google\.com\/\?q=14\.542,-90\.453/.test(rec[2].mensaje), true);
equal('el mensaje a la central dice a quien se aviso', /Familiares avisados: Luis/.test(rec[0].mensaje), true);
equal('los mensajes no llevan emojis', rec.every((r) => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(r.mensaje)), true);
rec = A.recipientsFor({ alert: { ...vecino, source: 'guardia', userName: 'Pedro' }, condoName: 'Villa Ferrer', central: '50243093379', contacts: [{ name: 'Luis', phone: '5555-1111' }], staff: [] });
equal('guardia: no se avisa a familiares de nadie', rec.map((r) => r.nombre), ['Central SISDEL']);
equal('guardia: el mensaje lo identifica', /GUARDIA/.test(rec[0].mensaje), true);
rec = A.recipientsFor({ alert: { ...vecino, lat: null, lng: null }, condoName: 'X', central: '', contacts: [], staff: [] });
equal('sin central ni contactos: nadie', rec.length, 0);
equal('sin GPS lo dice', /Ubicacion no disponible/.test(A.familyMessage({ ...vecino, lat: null }, 'X')), true);

console.log('\nConfiguracion del boton de panico (Configuracion > Boton de panico de admin.html)');
{
    const fs = await import('node:fs');
    const url = await import('node:url');
    const here = url.fileURLToPath(new URL('..', import.meta.url));
    equal('panico-avisos.js (navegador) es copia identica de functions/src/rondas/avisos.js', fs.readFileSync(here + 'panico-avisos.js', 'utf8') === fs.readFileSync(here + 'functions/src/rondas/avisos.js', 'utf8'), true);
    const base = { alert: vecino, condoName: 'Villa Ferrer', central: '50243093379', contacts: [{ name: 'Luis', phone: '5555-1111' }], staff: [{ name: 'Fernando', phone: '5555-1234' }] };
    const sinCfg = A.recipientsFor(base);
    equal('sin configuracion: lo mismo que con una configuracion vacia', A.recipientsFor({ ...base, config: {} }), sinCfg);
    equal('sin configuracion: el aviso de siempre', sinCfg[0].mensaje.split('\n')[0], '*ALERTA DE PANICO (VECINO) - SISDEL*');
    const cfg = {
        phones: [{ kind: 'garita', name: 'Garita principal', phone: '4444-0001' }, { kind: 'pnc', name: 'PNC Villa Nueva', phone: '+502 4444 0002' }, { kind: 'pnc', name: 'Repetido', phone: '44440002' }, { kind: 'raro', name: '', phone: '4444-0003' }, { kind: 'otro', name: 'Corto', phone: '123' }],
        staffTitle: 'EMERGENCIA EN  LA PERLA', staffNote: 'Diríjase al lote.\nLlame al 110.', familyNote: 'Ya avisamos a la garita y a la PNC.', signature: 'Garita La Perla'
    };
    const clean = A.cleanConfig(cfg);
    equal('telefonos: se normalizan, sin repetidos ni incompletos; un tipo desconocido es Otro', clean.phones, [{ kind: 'garita', name: 'Garita principal', phone: '50244440001' }, { kind: 'pnc', name: 'PNC Villa Nueva', phone: '50244440002' }, { kind: 'otro', name: 'Otro', phone: '50244440003' }]);
    equal('el titulo queda en una sola linea', clean.staffTitle, 'EMERGENCIA EN LA PERLA');
    equal('las indicaciones conservan sus renglones', clean.staffNote, 'Diríjase al lote.\nLlame al 110.');
    equal('se avisa al personal si no se dice lo contrario', clean.notifyStaff, true);
    equal('textos largos se recortan a su limite', [A.cleanConfig({ staffNote: 'x'.repeat(900) }).staffNote.length, A.cleanConfig({ signature: 'y'.repeat(200) }).signature.length], [600, 60]);
    equal('hasta 10 telefonos', A.cleanConfig({ phones: Array.from({ length: 14 }, (_, i) => ({ kind: 'otro', phone: '4444' + String(1000 + i) })) }).phones.length, 10);
    equal('basura en lugar de configuracion no rompe nada', [A.cleanConfig('hola').phones, A.cleanConfig({ phones: 'x' }).phones, A.cleanConfig({ phones: [null, 5] }).phones], [[], [], []]);
    let r = A.recipientsFor({ ...base, config: cfg });
    equal('con telefonos: central, garita, PNC, personal y familiares', r.map((x) => [x.nombre, x.telefono]), [['Central SISDEL', '50243093379'], ['Garita principal', '50244440001'], ['PNC Villa Nueva', '50244440002'], ['Otro', '50244440003'], ['Fernando', '50255551234'], ['Luis', '50255551111']]);
    equal('la garita y la PNC reciben el mismo aviso que la central', r[1].mensaje === r[0].mensaje && r[2].mensaje === r[0].mensaje, true);
    const staffMsg = r[1].mensaje;
    equal('el aviso lleva el titulo del condominio', staffMsg.split('\n')[0], '*EMERGENCIA EN LA PERLA (VECINO) - SISDEL*');
    equal('el aviso SIEMPRE lleva lo esencial: quien, lugar, telefono, GPS y mapa', [/Nombre: \*Ana García\*/, /Lugar: Casa 12/, /Tel: 5555-5678/, /GPS: 14\.54200, -90\.45300/, /maps\.google\.com\/\?q=14\.542,-90\.453/].every((re) => re.test(staffMsg)), true);
    equal('el aviso lleva las indicaciones y la firma', /Diríjase al lote\.\nLlame al 110\./.test(staffMsg) && /_Garita La Perla_$/.test(staffMsg), true);
    equal('el aviso no deja dos renglones en blanco seguidos', /\n\n\n/.test(staffMsg), false);
    const famMsg = r[5].mensaje;
    equal('los familiares reciben su nota y la firma', /Ya avisamos a la garita y a la PNC\./.test(famMsg) && /_Garita La Perla_$/.test(famMsg) && /maps\.google/.test(famMsg), true);
    r = A.recipientsFor({ ...base, config: { ...cfg, notifyStaff: false } });
    equal('sin avisar al personal: el personal no recibe nada', r.map((x) => x.nombre), ['Central SISDEL', 'Garita principal', 'PNC Villa Nueva', 'Otro', 'Luis']);
    r = A.recipientsFor({ ...base, central: '', staff: [], contacts: [], config: { phones: [{ kind: 'garita', name: 'Garita', phone: '5555-1234' }] } });
    equal('sin central: los telefonos del condominio igual reciben', r.map((x) => x.nombre), ['Garita']);
    r = A.recipientsFor({ ...base, staff: [{ name: 'Fernando', phone: '4444-0001' }], config: cfg });
    equal('un telefono que es de la garita y del personal recibe un solo aviso', r.filter((x) => x.telefono === '50244440001').map((x) => x.nombre), ['Garita principal']);
    r = A.recipientsFor({ ...base, alert: { ...vecino, source: 'guardia', userName: 'Pedro' }, config: cfg });
    equal('alerta de un guardia: garita y PNC si, familiares no', r.map((x) => x.nombre), ['Central SISDEL', 'Garita principal', 'PNC Villa Nueva', 'Otro', 'Fernando']);
    const test = A.testMessage('Villa Ferrer', cfg);
    equal('el mensaje de prueba dice que no es una emergencia y como llegara el aviso', /^\*PRUEBA - NO ES UNA EMERGENCIA\*/.test(test) && /EMERGENCIA EN LA PERLA/.test(test) && /Villa Ferrer/.test(test), true);
    equal('los mensajes configurados no llevan emojis del sistema', [staffMsg, famMsg, test].every((m) => !/[\u{1F300}-\u{1FAFF}]/u.test(m.replace(/Diríjase|García/g, ''))), true);
}

console.log('\nSimulacro (prueba del boton sin avisar a los familiares)');
{
    const drill = { ...vecino, simulacro: true };
    const cfg = { phones: [{ kind: 'garita', name: 'Garita principal', phone: '4444-0001' }, { kind: 'garita', name: 'Garita 2', phone: '4444-0002' }, { kind: 'pnc', name: 'PNC', phone: '4444-0110' }, { kind: 'otro', name: 'Otro', phone: '4444-0999' }] };
    const base = { alert: drill, condoName: 'Villa Ferrer', central: '50243093379', contacts: [{ name: 'Luis', phone: '5555-1111' }, { name: 'Marta', phone: '5555-2222' }], staff: [{ name: 'Fernando', phone: '5555-1234' }], config: cfg };
    const r = A.recipientsFor(base);
    equal('simulacro: solo la central, las garitas y el propio vecino (ni PNC, ni otros, ni personal, ni familiares)', r.map((x) => x.nombre), ['Central SISDEL', 'Garita principal', 'Garita 2', 'Ana García']);
    equal('el aviso dice primero que es una prueba, todo sin novedad, y no una emergencia, a la garita y al vecino', r.every((x) => x.mensaje.startsWith('*PRUEBA - TODO SIN NOVEDAD (no es una emergencia)*')), true);
    equal('a la garita: que la pantalla la recibe sola (ya no hay que marcarla a mano)', /La pantalla de la garita la recibe sola/.test(r[1].mensaje) && !/Marquela como atendida/.test(r[1].mensaje), true);
    equal('a la garita le llegan los datos de una alerta (lote, telefono, GPS y mapa) y que no hay que ir', [/Lugar: Casa 12/, /Tel: 5555-5678/, /GPS: 14\.54200/, /maps\.google\.com/, /No hay que ir al lugar/].every((re) => re.test(r[1].mensaje)), true);
    equal('dice a quienes se avisaria en una emergencia real, sin nombres', /En una emergencia real tambien se avisaria a: 2 contactos de emergencia, la PNC, los demas telefonos del condominio y la administracion\./.test(r[1].mensaje) && !/Luis|Marta/.test(r[1].mensaje), true);
    equal('al vecino: su boton funciona y llevo su ubicacion', /su boton de panico funciona/.test(r[3].mensaje) && /Llevo su ubicacion GPS/.test(r[3].mensaje), true);
    const noGps = A.recipientsFor({ ...base, alert: { ...drill, lat: null, lng: null } });
    equal('sin GPS el vecino se entera de que debe activar la ubicacion', /No llevo su ubicacion: active la ubicacion/.test(noGps[3].mensaje), true);
    equal('sin telefono del vecino no hay copia para el', A.recipientsFor({ ...base, alert: { ...drill, phone: '' } }).map((x) => x.nombre), ['Central SISDEL', 'Garita principal', 'Garita 2']);
    equal('sin familiares ni nada mas que avisar, le sugiere registrarlos', /Registre sus contactos de emergencia/.test(A.recipientsFor({ ...base, contacts: [], staff: [], config: { phones: [] } })[1].mensaje), true);
    equal('una alerta de verdad no cambia (simulacro solo si viene en true)', A.recipientsFor({ ...base, alert: { ...vecino, simulacro: 'si' } }).map((x) => x.nombre), A.recipientsFor({ ...base, alert: vecino }).map((x) => x.nombre));
    equal('el tope del dia: 20 simulacros con WhatsApp por condominio y 2 por vecino', A.DRILL_LIMITS, { perDay: 20, perUser: 2 });
}

console.log('\nTope propio de pruebas de un vecino (A006 de La Perla, 2026-11-27: 20 al dia)');
{
    const T = require('../functions/src/rondas/pruebas-tope.js');
    const cfg = { vecinos: { a006: 20, raro: 'veinte', cero: 0, mucho: 500 } };
    equal('el vecino anotado tiene su tope', T.personalDrillLimit(cfg, 'a006'), 20);
    equal('los demas no (y un valor que no sirve tampoco)', [T.personalDrillLimit(cfg, 'otro'), T.personalDrillLimit(cfg, 'raro'), T.personalDrillLimit(cfg, 'cero'), T.personalDrillLimit(null, 'a006')], [null, null, null, null]);
    equal('nunca mas de 50', T.personalDrillLimit(cfg, 'mucho'), 50);
    // Sin tope propio: lo de siempre (2 por vecino y 20 en el condominio)
    let day = {};
    for (let i = 0; i < 2; i++) day = T.drillSlot(day, 'v1', null).next;
    equal('un vecino comun: la tercera no lleva WhatsApp', [T.drillSlot(day, 'v1', null).ok, /ya hizo 2 simulacros/.test(T.drillSlot(day, 'v1', null).reason)], [false, true]);
    // Con tope propio: 20 y no gasta el cupo del condominio
    day = { count: 1, users: { a006: 1 } };   // ya hizo una prueba hoy, antes de tener su tope
    for (let i = 0; i < 19; i++) { const s = T.drillSlot(day, 'a006', 20); if (!s.ok) break; day = s.next; }
    equal('A006 llega a 20 en el dia', day.users.a006, 20);
    equal('la 21 ya no lleva WhatsApp', [T.drillSlot(day, 'a006', 20).ok, /ya hizo 20 simulacros/.test(T.drillSlot(day, 'a006', 20).reason)], [false, true]);
    equal('sus pruebas no gastan los 20 del condominio', [day.count, day.special], [1, 19]);
    equal('los demas vecinos siguen con sus 2', T.drillSlot(day, 'v2', null).ok, true);
    const full = { count: 20, users: {} };
    equal('con los 20 del condominio usados, A006 todavia puede (tiene su propio tope)', [T.drillSlot(full, 'a006', 20).ok, T.drillSlot(full, 'v3', null).ok], [true, false]);
}

console.log('\nLimpieza diaria (formato de RONDIN: fechas AAAA-MM-DD HH:MM:SS en UTC)');
const now = Date.parse('2026-11-08T12:00:00Z');
const h = (n) => M.sqlTime(now - n * 3600 * 1000);
equal('fecha de RONDIN a milisegundos', M.toMs('2026-11-08 12:00:00'), now);
equal('fecha ISO tambien se entiende', M.toMs('2026-11-08T12:00:00.000Z'), now);
equal('turno de 17 h abierto se cierra', M.isStaleShift({ status: 'ACTIVE', actual_start: h(17) }, now), true);
equal('turno de 10 h sigue', M.isStaleShift({ status: 'ACTIVE', actual_start: h(10) }, now), false);
equal('turno sin check-in usa la hora programada', M.isStaleShift({ status: 'ACTIVE', actual_start: null, scheduled_start: h(20) }, now), true);
equal('turno ya cerrado no se toca', M.isStaleShift({ status: 'COMPLETED', actual_start: h(40) }, now), false);
equal('ronda de 7 h en curso se cierra', M.isStaleRound({ status: 'IN_PROGRESS', started_at: h(7) }, now), true);
equal('ronda de 2 h sigue', M.isStaleRound({ status: 'IN_PROGRESS', started_at: h(2) }, now), false);
equal('posicion de 2 dias se borra', M.isStaleLive({ timestamp: h(48) }, now), true);
equal('posicion de hace 1 h se queda', M.isStaleLive({ timestamp: h(1) }, now), false);
equal('historial: corte a 30 dias', M.historyCutoff(now), '2026-10-09 12:00:00');
equal('alertas: corte a 90 dias', M.alertCutoff(now), '2026-08-10 12:00:00');
const cps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'x', is_mandatory: 0 }];
equal('ronda cerrada sola: puntaje con lo marcado', M.closingScore(cps, [{ checkpoint_id: 'a' }, { checkpoint_id: 'b' }, { checkpoint_id: 'b' }]), { score: 50, status: 'INCOMPLETE' });
equal('los puntos opcionales no cuentan', M.closingScore(cps, [{ checkpoint_id: 'a' }, { checkpoint_id: 'b' }, { checkpoint_id: 'c' }, { checkpoint_id: 'x' }]), { score: 75, status: 'INCOMPLETE' });
equal('las visitas sospechosas no cuentan', M.closingScore(cps, ['a', 'b', 'c', 'd'].map((id) => ({ checkpoint_id: id, status: id === 'd' ? 'SUSPICIOUS' : 'VALID' }))), { score: 75, status: 'INCOMPLETE' });
equal('desde 80 % la ronda queda completa', M.closingScore(cps.slice(0, 4).concat({ id: 'e' }), ['a', 'b', 'c', 'd'].map((id) => ({ checkpoint_id: id }))), { score: 80, status: 'COMPLETED' });
equal('ruta sin puntos: incompleta', M.closingScore([], []), { score: 0, status: 'INCOMPLETE' });

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
