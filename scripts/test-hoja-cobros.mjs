// Pruebas del plan de carga desde una hoja de cobros (scripts/lib-hoja-cobros.mjs) con datos INVENTADOS: sin emuladores.
//   node scripts/test-hoja-cobros.mjs
import { createRequire } from 'node:module';
import { MONTHS, cleanName, validateSheet, buildPlan, reconcile, accessCodeFor } from './lib-hoja-cobros.mjs';

const require = createRequire(import.meta.url);
const SisdelMora = require('../finanzas/sisdel-mora.js');
const Reportes = require('../finanzas/sisdel-reportes.js');

const failures = [];
let passed = 0;
function equal(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failures.push(name);
    console.log(`  FALLA  ${name}\n         esperado ${e}\n         obtuvo   ${a}`);
}
const yes = (name, value) => equal(name, !!value, true);

const upTo = (m) => Object.fromEntries(MONTHS.slice(0, MONTHS.indexOf(m) + 1).map((k) => [k, k === 'EN' || k === 'FEB' || k === 'MZ' ? 100 : 150]));
const sheet = () => ({
    condominio: 'RESIDENCIALES DE PRUEBA', fuente: 'hoja inventada', anio: 2026, fechaHoja: '2026-11-16', cuotaActual: 150, prefijoId: 'prueba-',
    tarifas: Object.fromEntries(MONTHS.map((m) => [m, m === 'EN' || m === 'FEB' || m === 'MZ' ? 100 : 150])),
    casas: [
        { casa: 1, nombre: 'ANA PRUEBA', pagos: upTo('DC') },                                           // todo el ano, con diciembre adelantado
        { casa: 2, nombre: 'BETO EJEMPLO.', pagos: upTo('JN') },                                         // hasta junio
        { casa: 3, nombre: 'CARLA MUESTRA', pagos: { EN: 100, MZ: 100, AB: 150, MY: 150 } },              // con un hueco (febrero)
        { casa: 4, nombre: 'ARRENDAMIENTOS D.C.', pagos: { ...upTo('MZ'), AB: 50 } },                    // abril por la mitad: no es la tarifa
        { casa: 5, nombre: 'DORA SIN PAGOS', pagos: {}, dudas: [{ mes: 'JL', monto: 99, motivo: 'anotacion a mano' }], nota: 'tachon al lado del nombre' }
    ],
    totales: { EN: 400, FEB: 300, MZ: 400, JL: 150 + 99, DC: 150 }   // DC y JL incluyen lo que no se carga
});
const options = { condoId: 'condo-prueba', nowIso: '2026-11-19T12:00:00.000Z', currentPeriod: '2026-11', currency: 'GTQ' };

console.log('\nNombres y archivo de datos');
equal('una sigla conserva su punto final; el punto de cierre se quita', [cleanName('ARRENDAMIENTOS D.C.'), cleanName('LUIS RODAS CIFUENTES.'), cleanName('  LUIS   ANTONIO  MEZA ')], ['ARRENDAMIENTOS D.C.', 'LUIS RODAS CIFUENTES', 'LUIS ANTONIO MEZA']);
equal('un archivo bien formado no trae problemas', validateSheet(sheet()), []);
yes('detecta casas repetidas, sin nombre, meses raros y tarifas faltantes', (() => {
    const s = sheet();
    s.casas.push({ casa: 1, nombre: 'REPETIDA', pagos: {} }, { casa: 9, nombre: ' ', pagos: { XX: 5 } });
    delete s.tarifas.OCT;
    const p = validateSheet(s).join(' | ');
    return /casa 1: repetida/.test(p) && /casa 9: sin nombre/.test(p) && /mes desconocido XX/.test(p) && /tarifa de OCT/.test(p);
})());

console.log('\nEl plan');
const sh = sheet();
const plan = buildPlan(sh, options);
equal('un vecino por casa, con id, casa y nombre limpio', plan.houses.map((h) => [h.id, h.user.casa, h.name]), [['prueba-1', '1', 'ANA PRUEBA'], ['prueba-2', '2', 'BETO EJEMPLO'], ['prueba-3', '3', 'CARLA MUESTRA'], ['prueba-4', '4', 'ARRENDAMIENTOS D.C.'], ['prueba-5', '5', 'DORA SIN PAGOS']]);
equal('el vecino es de su condominio, al dia, activo, sin telefono ni correo', [plan.houses[0].user.condominioId, plan.houses[0].user.role, plan.houses[0].user.paymentStatus, plan.houses[0].user.active, plan.houses[0].user.phone, plan.houses[0].user.email], ['condo-prueba', 'vecino', 'al_dia', true, '', '']);
equal('la ficha dice casa con lote y que se cobra desde el mes en curso', [plan.houses[0].ficha.unitType, plan.houses[0].ficha.feeFrom], ['casa', '2026-11']);
const ofHouse = (id) => plan.movements.filter((t) => t.resiId === id);
equal('casa 1: 11 cuotas (enero a noviembre) y 12 pagos (diciembre adelantado)', [ofHouse('prueba-1').filter((t) => t.type === 'charge').length, ofHouse('prueba-1').filter((t) => t.type === 'income').length], [11, 12]);
equal('casa 2: la cuota y el pago de cada mes, hasta junio', [ofHouse('prueba-2').length, ofHouse('prueba-2').filter((t) => t.type === 'charge').map((t) => t.period).join(',')], [12, '2026-01,2026-02,2026-03,2026-04,2026-05,2026-06']);
equal('casa 3: el mes en blanco no se inventa', ofHouse('prueba-3').filter((t) => t.type === 'charge').map((t) => t.period), ['2026-01', '2026-03', '2026-04', '2026-05']);
equal('casa 4: abril por la mitad no se carga y queda en la lista de dudas con su motivo', [ofHouse('prueba-4').filter((t) => t.type === 'income').length, plan.skippedCells.filter((s) => s.casa === 4)], [3, [{ casa: 4, mes: 'AB', monto: 50, motivo: 'no es la tarifa del mes (150)' }]]);
equal('casa 5: sin pagos no tiene movimientos, y su anotacion a mano queda en dudas', [ofHouse('prueba-5').length, plan.skippedCells.filter((s) => s.casa === 5)], [0, [{ casa: 5, mes: 'JL', monto: 99, motivo: 'anotacion a mano' }]]);
equal('la cuota y el pago de un mes valen la tarifa de ese mes', [ofHouse('prueba-1').filter((t) => t.period === '2026-01' || t.id === 'pago_prueba-1_2026-01').map((t) => t.amount), ofHouse('prueba-1').find((t) => t.id === 'fee_prueba-1_2026-05').amount], [[100, 100], 150]);
const fee = ofHouse('prueba-1').find((t) => t.id === 'fee_prueba-1_2026-05');
equal('la cuota es como las de OIKOS: id fee_<vecino>_<mes>, cargo de mantenimiento con su concepto y fecha del dia 1', [fee.type, fee.kind, fee.period, fee.breakdown, fee.date, fee.manual, fee.auto, fee.retro], ['charge', 'fee', '2026-05', { maintenance: 150 }, '2026-05-01T18:00:00.000Z', true, false, true]);
yes('el concepto de la cuota dice el mes', /mayo de 2026/i.test(fee.concept));
equal('la cuota del mes en curso no es retroactiva', ofHouse('prueba-1').find((t) => t.id === 'fee_prueba-1_2026-11').retro, false);
equal('el pago cae el 15 del mes de su cuota (a mediodia de Guatemala)', ofHouse('prueba-1').find((t) => t.id === 'pago_prueba-1_2026-05').date, '2026-05-15T18:00:00.000Z');
equal('el pago de un mes que aun no llega (adelantado) se fecha el dia de la hoja, y no trae cuota', [ofHouse('prueba-1').find((t) => t.id === 'pago_prueba-1_2026-12').date, ofHouse('prueba-1').some((t) => t.id === 'fee_prueba-1_2026-12')], ['2026-11-16T18:00:00.000Z', false]);
yes('el pago adelantado lo dice en su concepto', /adelantado/.test(ofHouse('prueba-1').find((t) => t.id === 'pago_prueba-1_2026-12').concept));
equal('el pago de noviembre (el 15) no se pasa del dia de la hoja', ofHouse('prueba-1').find((t) => t.id === 'pago_prueba-1_2026-11').date, '2026-11-15T18:00:00.000Z');
yes('todos los movimientos son del vecino, llevan sus fechas y no traen importedFrom (la Tabla general no debe dar por pagados los meses en blanco)', plan.movements.every((t) => t.created_at === options.nowIso && t.updated_at === options.nowIso && t.serverGenerated === true && t.loadedFrom === 'hoja inventada' && !('importedFrom' in t)));
equal('no hay ids repetidos', new Set(plan.movements.map((t) => t.id)).size, plan.movements.length);

console.log('\nCuadre contra los totales de la hoja');
const rec = reconcile(sh, plan);
equal('cada mes con total: lo cargado mas lo que no se carga es el total de la hoja', rec.rows.filter((r) => r.total != null).map((r) => [r.mes, r.loaded, r.excluded, r.total, r.ok]), [['EN', 400, 0, 400, true], ['FEB', 300, 0, 300, true], ['MZ', 400, 0, 400, true], ['JL', 150, 99, 249, true], ['DC', 150, 0, 150, true]]);
equal('cuadra y comprobo 5 meses', [rec.ok, rec.checked], [true, 5]);
const broken = sheet();
broken.totales.EN = 500;
equal('si un total no cuadra, lo dice', reconcile(broken, buildPlan(broken, options)).ok, false);
equal('un mes sin total legible no se compara', reconcile(sh, plan).rows.find((r) => r.mes === 'AB').ok, null);

console.log('\nLo que ve el sistema');
const SETTINGS = { fee: 150, currency: 'GTQ', feeBreakdown: { maintenance: 150 } };
const stateOf = (id) => SisdelMora.stateOf(id, plan.movements.filter((t) => t.resiId === id), SETTINGS, '2026-11-19');
equal('una casa que pago todo lo cargado no debe nada (capital vencido 0), y el diciembre adelantado le queda a favor (saldo del libro y saldo a favor, Q150)', [stateOf('prueba-1').capital, stateOf('prueba-1').balance, stateOf('prueba-1').credit], [0, 150, 150]);
equal('quien pago hasta junio no debe nada ni tiene saldo a favor (no se le inventaron cuotas)', [stateOf('prueba-2').capital, stateOf('prueba-2').balance, stateOf('prueba-2').credit], [0, 0, 0]);
const monthly = Reportes.monthBalance(plan.movements, { from: '2026-01-01', to: '2026-12-31' });
equal('Ingresos por mes: lo cargado de cada mes (el adelantado de diciembre cuenta en noviembre, cuando se cobro)', monthly.months.filter((m) => m.income).map((m) => [m.key, m.income]).slice(0, 3), [['2026-01', 400], ['2026-02', 300], ['2026-03', 400]]);

console.log('\nCodigos de acceso');
const taken = new Set(['DA001']);
const codes = plan.houses.map((h) => accessCodeFor('RESIDENCIALES DE PRUEBA', h.name, taken));
yes('cada codigo es inicial del condominio + inicial del nombre + 3 cifras, y no se repiten', codes.every((c) => /^R[A-Z]\d{3}$/.test(c)) && new Set(codes).size === codes.length);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
