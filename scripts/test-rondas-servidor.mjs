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
