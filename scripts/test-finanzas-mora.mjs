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
equal('vencida la gracia del mes, cuenta', [mora.overdue, mora.moroso], [1000, true]);
mora = M.moraOf('a', [charge('a', '2026-09'), charge('a', '2026-10'), pay('a', 600)], settings, at(2026, 10, 20));
equal('un pago parcial lo saca de mora', [mora.overdue, mora.moroso], [400, false]);
mora = M.moraOf('a', [charge('a', '2026-09'), charge('a', '2026-10', 500, { deleted: true })], settings, at(2026, 10, 20));
equal('un cargo anulado no cuenta', mora.moroso, false);
mora = M.moraOf('a', [charge('a', '2026-10', 120, { kind: 'fine', period: undefined, concept: 'Multa' })], { chargeDay: 1 }, at(2026, 10, 20));
equal('sin cuota configurada, cualquier deuda vencida es mora', mora.moroso, true);
mora = M.moraOf('a', [charge('b', '2026-09'), charge('b', '2026-10')], settings, at(2026, 10, 20));
equal('la deuda de otro vecino no cuenta', mora.moroso, false);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
