// Pruebas de la logica de rondas (rondas-logic.js): sin emuladores.
// Uso: node test-rondas-logic.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../rondas-logic.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const route = {
    checkpoints: [
        { id: 'c2', name: 'Parque', lat: 14.5426, lng: -90.4524, radius: 25, order: 2 },
        { id: 'c1', name: 'Garita', lat: 14.5420, lng: -90.4530, radius: 25, order: 1 },
        { id: 'c3', name: 'Muro norte', lat: 14.5431, lng: -90.4533, radius: 25, order: 3 },
        { id: 'c4', name: 'Bodega', lat: 14.5435, lng: -90.4520, radius: 25, order: 4, mandatory: false },
        { id: 'c5', name: 'Viejo', lat: 14.5440, lng: -90.4510, radius: 25, order: 5, active: false }
    ]
};
const visit = (checkpointId, status = 'VALID') => ({ checkpointId, status });

console.log('\nDistancias y puntos');
equal('distancia de 1 grado de latitud ~111 km', Math.round(L.haversine(14, -90, 15, -90) / 1000), 111);
equal('puntos activos en orden', L.activeCheckpoints(route).map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
equal('obligatorios sin el opcional', L.mandatoryCheckpoints(route).map((c) => c.id), ['c1', 'c2', 'c3']);
equal('punto mas cercano', L.nearestCheckpoint(route, { lat: 14.54202, lng: -90.45301 }).checkpoint.id, 'c1');
equal('dentro del radio', L.withinRadius({ radius: 25 }, 20, 5), true);
equal('fuera del radio, aun con margen de GPS', L.withinRadius({ radius: 25 }, 45, 30), false);
equal('el margen del GPS se limita a 15 m', L.withinRadius({ radius: 25 }, 39, 50), true);
equal('visita por GPS lejos es sospechosa', L.visitStatus({ radius: 25 }, 80, 'GPS', 5), 'SUSPICIOUS');
equal('visita por codigo cerca es valida', L.visitStatus({ radius: 25 }, 80, 'CODIGO', 5), 'VALID');
equal('visita por codigo muy lejos es sospechosa', L.visitStatus({ radius: 25 }, 300, 'CODIGO', 5), 'SUSPICIOUS');

console.log('\nPuntaje de la ronda (como RONDIN)');
equal('sin visitas', L.roundScore(route, []).score, 0);
equal('2 de 3 obligatorios: incompleta', [L.roundScore(route, [visit('c1'), visit('c2')]).score, L.roundScore(route, [visit('c1'), visit('c2')]).status], [66.7, 'INCOMPLETE']);
equal('todos: completa', [L.roundScore(route, [visit('c1'), visit('c2'), visit('c3')]).score, L.roundScore(route, [visit('c1'), visit('c2'), visit('c3')]).status], [100, 'COMPLETED']);
equal('una visita sospechosa no cuenta', L.roundScore(route, [visit('c1'), visit('c2'), visit('c3', 'SUSPICIOUS')]).visited, 2);
equal('puntos que faltan', L.roundScore(route, [visit('c2')]).missing.map((c) => c.id), ['c1', 'c3']);
equal('se cierra sola con todos los obligatorios', L.isRoundDone(route, [visit('c3'), visit('c1'), visit('c2')]), true);
equal('siguiente punto en orden', L.nextCheckpoint(route, [visit('c1')]).id, 'c2');
equal('ruta sin puntos: incompleta', L.roundScore({ checkpoints: [] }, []).status, 'INCOMPLETE');
const route5 = { checkpoints: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, lat: 0, lng: 0, order: n })) };
equal('4 de 5 = 80: completa', L.roundScore(route5, ['p1', 'p2', 'p3', 'p4'].map((id) => visit(id))).status, 'COMPLETED');

console.log('\nEnvio de la posicion');
const t0 = Date.parse('2026-11-08T10:00:00Z');
equal('primera posicion se manda siempre', L.locationDue(null, { lat: 14.542, lng: -90.453 }, t0), { live: true, history: true });
const last = { lat: 14.542, lng: -90.453, atMs: t0, historyAtMs: t0 };
equal('10 s quieto: no se manda', L.locationDue(last, { lat: 14.542, lng: -90.453 }, t0 + 10000), { live: false, history: false });
equal('30 s: se manda en vivo', L.locationDue(last, { lat: 14.542, lng: -90.453 }, t0 + 30000).live, true);
equal('se movio 50 m: se manda aunque pasen 5 s', L.locationDue(last, { lat: 14.54245, lng: -90.453 }, t0 + 5000).live, true);
equal('historial cada 60 s', L.locationDue(last, { lat: 14.542, lng: -90.453 }, t0 + 61000).history, true);
equal('desconectado despues de 5 min', [L.isStale('2026-11-08T10:00:00Z', t0 + 4 * 60000), L.isStale('2026-11-08T10:00:00Z', t0 + 6 * 60000)], [false, true]);

console.log('\nAsignaciones y horarios');
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m);
const dia = { dateStart: '2026-11-01', dateEnd: '2026-11-30', hourStart: '08:00', hourEnd: '20:00' };
equal('turno de dia dentro del horario', L.assignmentActiveAt(dia, at(8, 10)), true);
equal('turno de dia fuera del horario', L.assignmentActiveAt(dia, at(8, 21)), false);
equal('fuera del rango de fechas', L.assignmentActiveAt(dia, at(31 + 1, 10)), false);
const noche = { dateStart: '2026-11-08', dateEnd: '2026-11-08', hourStart: '20:00', hourEnd: '08:00' };
equal('turno nocturno a las 23:00', L.assignmentActiveAt(noche, at(8, 23)), true);
equal('la madrugada pertenece al turno del dia anterior', L.assignmentActiveAt(noche, at(9, 3)), true);
equal('la madrugada del primer dia no cuenta', L.assignmentActiveAt(noche, at(8, 3)), false);
equal('asignacion desactivada', L.assignmentActiveAt({ ...dia, status: 'INACTIVE' }, at(8, 10)), false);

console.log('\nCodigos y reportes');
equal('codigo de 6 caracteres sin letras confusas', /^[A-HJ-NP-Z2-9]{6}$/.test(L.checkpointCode()), true);
equal('codigo escrito con espacios y minusculas', L.normalizeCode(' ab-c 12 '), 'ABC12');
const summary = L.summarize([
    { guardId: 'g1', guardName: 'Pedro', routeId: 'r1', routeName: 'Perimetro', status: 'COMPLETED', score: 100 },
    { guardId: 'g1', guardName: 'Pedro', routeId: 'r1', routeName: 'Perimetro', status: 'INCOMPLETE', score: 50 },
    { guardId: 'g2', guardName: 'Ramiro', routeId: 'r1', routeName: 'Perimetro', status: 'IN_PROGRESS', score: 0 }
], [{ status: 'OPEN' }, { status: 'RESOLVED' }], [{ status: 'RESOLVED' }, { status: 'CANCELLED' }]);
equal('resumen general', [summary.rounds, summary.completed, summary.incomplete, summary.avgScore, summary.openIncidents, summary.panics], [2, 1, 1, 75, 1, 1]);
equal('resumen por guardia', summary.byGuard.map((g) => [g.name, g.rounds, g.avgScore]), [['Pedro', 2, 75]]);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
