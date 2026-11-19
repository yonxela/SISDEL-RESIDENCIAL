// Pruebas de cuotas y mora del servidor (functions/src/finanzas/mora.js): sin emuladores.
// Uso: node test-finanzas-mora.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../functions/src/finanzas/mora.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

// "Ahora" fijo en Guatemala (UTC-6)
const at = (y, m, d, h = 12) => M.gtDate(y, m, d, h);
const settings = { fee: 500, chargeDay: 5, graceDays: 3, feeMode: 'auto' };
const charge = (resiId, period, amount = 500, extra = {}) => ({ id: `c_${resiId}_${period}_${amount}`, type: 'charge', kind: 'fee', period, amount, resiId, ...extra });
const pay = (resiId, amount, id = `p_${resiId}_${amount}`) => ({ id, type: 'income', amount, resiId });

console.log('\nPeriodos y fechas');
equal('periodo de cuota', M.periodKey(2026, 10), '2026-11');
equal('concepto de cuota igual a OIKOS', M.feeConcept(2026, 10), 'Cuota - Noviembre 2026');
equal('concepto antiguo en espanol', M.parseFeePeriod('Cuota - Noviembre 2026'), '2026-11');
equal('concepto antiguo con "de"', M.parseFeePeriod('cuota – de noviembre de 2026'), '2026-11');
equal('concepto antiguo en ingles', M.parseFeePeriod('Cuota - November 2026'), '2026-11');
equal('un pago no es cuota', M.txFeePeriod({ type: 'income', period: '2026-11' }), null);
equal('una multa no es cuota', M.txFeePeriod({ type: 'charge', kind: 'fine', concept: 'Multa' }), null);
equal('fecha en Guatemala cerca de medianoche UTC', M.localParts(new Date('2026-12-01T03:00:00Z')), { y: 2026, m: 10, d: 30 });

console.log('\nCuotas automaticas (como OIKOS)');
const viejo = { id: 'r1', createdAt: '2025-06-01T00:00:00.000Z' };
let fees = M.missingFees([viejo], [], settings, at(2026, 10, 10));
equal('vecino antiguo: de enero a noviembre', [fees.length, fees[0].period, fees[10].period], [11, '2026-01', '2026-11']);
equal('cuota con el mismo formato que OIKOS', (({ id, date, type, kind, amount, concept, resiId, auto }) => ({ id, date, type, kind, amount, concept, resiId, auto }))(fees[10]),
    { id: 'fee_r1_2026-11', date: '2026-11-05T12:00:00.000Z', type: 'charge', kind: 'fee', amount: 500, concept: 'Cuota - Noviembre 2026', resiId: 'r1', auto: true });
fees = M.missingFees([viejo], [], settings, at(2026, 10, 3));
equal('antes del dia de cobro no se cobra el mes actual', fees.map((f) => f.period).pop(), '2026-10');
fees = M.missingFees([{ ...viejo, feeFrom: '2026-11' }], [], settings, at(2026, 10, 10));
equal('vecino que entra al sistema se cobra desde ese mes', fees.map((f) => f.period), ['2026-11']);
fees = M.missingFees([{ id: 'r2', createdAt: '2026-10-20T15:00:00.000Z' }], [], settings, at(2026, 10, 10));
equal('vecino nuevo no paga meses anteriores a su alta', fees.map((f) => f.period), ['2026-10', '2026-11']);
fees = M.missingFees([{ ...viejo, status: 'closed' }], [], settings, at(2026, 10, 10));
equal('vecino finiquitado no recibe cuotas', fees.length, 0);
fees = M.missingFees([viejo], [], { ...settings, feeMode: 'manual' }, at(2026, 10, 10));
equal('modo manual no genera cuotas', fees.length, 0);
fees = M.missingFees([viejo], [], { ...settings, fee: 0 }, at(2026, 10, 10));
equal('sin cuota configurada no genera cuotas', fees.length, 0);
fees = M.missingFees([{ ...viejo, feeFrom: '2026-11' }], [charge('r1', '2026-11', 500, { id: 'fee_r1_2026-11', deleted: true })], settings, at(2026, 10, 10));
equal('una cuota anulada no se vuelve a cobrar', fees.length, 0);
fees = M.missingFees([{ ...viejo, feeFrom: '2026-10' }], [{ id: 'fee_r1_2026-10', type: 'income', amount: 1, resiId: 'x' }], settings, at(2026, 10, 10));
equal('id ocupado: se usa otro', fees.map((f) => f.id), ['fee_r1_2026-10_r1', 'fee_r1_2026-11']);

console.log('\nSaldo y mora (regla: mas de una cuota vencida)');
equal('saldo: pagos menos cargos vivos', M.balanceOf([charge('a', '2026-10'), charge('a', '2026-11'), pay('a', 300), charge('a', '2026-09', 500, { deleted: true })], 'a'), -700);
let mora = M.moraOf('a', [], settings, at(2026, 10, 20));
equal('sin movimientos esta al dia', mora.moroso, false);
mora = M.moraOf('a', [charge('a', '2026-10')], settings, at(2026, 10, 20));
equal('una cuota vencida: al dia para la garita', [mora.overdue, mora.moroso], [500, false]);
mora = M.moraOf('a', [charge('a', '2026-09'), charge('a', '2026-10')], settings, at(2026, 10, 20));
equal('dos cuotas vencidas: moroso', [mora.overdue, mora.moroso], [1000, true]);
mora = M.moraOf('a', [charge('a', '2026-10'), charge('a', '2026-11')], settings, at(2026, 10, 6));
equal('la cuota del mes en periodo de gracia no cuenta', [mora.debt, mora.overdue, mora.moroso], [1000, 500, false]);
mora = M.moraOf('a', [charge('a', '2026-10'), charge('a', '2026-11')], settings, at(2026, 10, 8));
equal('la cuota del mes sigue en su plazo todo el mes: solo la de octubre esta vencida (ya no pasa el dia de cobro mas la gracia)', [mora.debt, mora.overdue, mora.moroso], [1000, 500, false]);

console.log('\nPlazo de pago de 35 dias (el mes completo y hasta el dia 5 del siguiente; pedido del dueno el 2026-11-19)');
const trio = [charge('a', '2026-09'), charge('a', '2026-10'), charge('a', '2026-11')];
equal('el 4 de noviembre octubre todavia esta en su plazo (hasta el 5): solo septiembre esta vencido', [M.moraOf('a', trio, settings, at(2026, 10, 4)).overdue], [500]);
equal('el 5 de noviembre octubre aun esta en su plazo (el dia 5 cuenta)', [M.moraOf('a', trio, settings, at(2026, 10, 5)).overdue], [500]);
equal('el 6 de noviembre octubre ya vencio: septiembre y octubre', [M.moraOf('a', trio, settings, at(2026, 10, 6)).overdue], [1000]);
mora = M.moraOf('a', [charge('a', '2026-11')], settings, at(2026, 11, 5));
equal('noviembre se puede pagar hasta el 5 de diciembre sin ser moroso', [mora.debt, mora.overdue, mora.moroso], [500, 0, false]);
mora = M.moraOf('a', [charge('a', '2026-11')], settings, at(2026, 11, 6));
equal('el 6 de diciembre noviembre ya vencio (una cuota vencida: al dia para la garita, pero ya es deuda vencida)', [mora.overdue, mora.moroso], [500, false]);
mora = M.moraOf('a', [charge('a', '2026-10'), charge('a', '2026-11')], settings, at(2026, 11, 6));
equal('el 6 de diciembre quien debe octubre y noviembre es moroso (dos cuotas vencidas)', [mora.overdue, mora.moroso], [1000, true]);
mora = M.moraOf('a', [charge('a', '2026-12')], settings, at(2027, 0, 5));
equal('el cambio de ano: diciembre se paga hasta el 5 de enero', [mora.overdue, mora.moroso], [0, false]);
equal('el dia de cobro y los dias de gracia de Configuracion ya no cambian nada', [M.moraOf('a', trio, { ...settings, chargeDay: 20, graceDays: 0 }, at(2026, 10, 6)).overdue, M.moraOf('a', trio, { ...settings, chargeDay: 1, graceDays: 25 }, at(2026, 10, 6)).overdue], [1000, 1000]);
equal('una multa (no es cuota mensual) cuenta como vencida de una vez', M.moraOf('a', [charge('a', '2026-10', 120, { kind: 'fine', period: undefined, concept: 'Multa' })], { ...settings, fee: 100 }, at(2026, 10, 20)).moroso, true);

mora = M.moraOf('a', [charge('a', '2026-09'), charge('a', '2026-10'), pay('a', 600)], settings, at(2026, 10, 20));
equal('un pago parcial lo saca de mora', [mora.overdue, mora.moroso], [400, false]);
mora = M.moraOf('a', [charge('a', '2026-09'), charge('a', '2026-10', 500, { deleted: true })], settings, at(2026, 10, 20));
equal('un cargo anulado no cuenta', mora.moroso, false);
mora = M.moraOf('a', [charge('a', '2026-10', 120, { kind: 'fine', period: undefined, concept: 'Multa' })], { chargeDay: 1 }, at(2026, 10, 20));
equal('sin cuota configurada, cualquier deuda vencida es mora', mora.moroso, true);
mora = M.moraOf('a', [charge('b', '2026-09'), charge('b', '2026-10')], settings, at(2026, 10, 20));
equal('la deuda de otro vecino no cuenta', mora.moroso, false);

console.log('\nCon regla de mora: la mora se carga el dia 6 de cada mes (la misma que OIKOS)');
// 3 % al mes con 5 dias de plazo; noviembre de Q 300 sin pagar
const rules = { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] };
const nov = { id: 'f11', type: 'charge', kind: 'fee', period: '2026-11', amount: 300, resiId: 'a', date: '2026-11-01T18:00:00.000Z' };
const payOn = (day, amount) => ({ id: 'p' + day, type: 'income', amount, resiId: 'a', date: `${day}T18:00:00.000Z` });
equal('hasta el 5 de diciembre no hay mora; el 6, Q 9.00, y no cambia hasta el 6 de enero (Q 18.00)', [[11, 5], [11, 6], [11, 31], [0, 5], [0, 6]].map(([m, d]) => M.moraOf('a', [nov], rules, at(m === 0 ? 2027 : 2026, m, d)).mora), [0, 9, 9, 9, 18]);
equal('pagada el 5, el 6 y el 7 de diciembre: sin mora, Q 9.00 y Q 9.00 (lo que queda debiendo al 10 de enero)', ['2026-12-05', '2026-12-06', '2026-12-07'].map((day) => M.moraOf('a', [nov, payOn(day, 300)], rules, at(2027, 0, 10)).debt), [0, 9, 9]);
equal('la mora no cambia quien es moroso: la garita mira el capital vencido', (({ overdue, moroso }) => ({ overdue, moroso }))(M.moraOf('a', [nov], rules, at(2027, 0, 10))), { overdue: 300, moroso: false });

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
