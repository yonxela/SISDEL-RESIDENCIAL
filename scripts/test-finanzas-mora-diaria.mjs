// Pruebas de la mora (finanzas/sisdel-mora.js: se carga el dia 6 de cada mes) y su uso en el servidor: sin emuladores. Datos inventados.
// Uso: node test-finanzas-mora-diaria.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const D = require('../finanzas/sisdel-mora.js');
const M = require('../functions/src/finanzas/mora.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const yes = (name, value) => equal(name, !!value, true);
const throws = (name, fn) => { let failed = false; try { fn(); } catch (e) { failed = true; } equal(name, failed, true); };

// El mediodia de Guatemala de un dia 'AAAA-MM-DD', como lo guarda OIKOS (texto ISO en UTC)
const at = (day) => `${day}T18:00:00.000Z`;
// Una cuota del periodo, cobrada el dia 5 de su mes salvo que se diga otra fecha
const fee = (id, period, amount = 300, day = `${period}-05`, resiId = 'r1') => ({ id, type: 'charge', kind: 'fee', period, amount, resiId, date: at(day) });
const extra = (id, day, amount, more = {}) => ({ id, type: 'charge', kind: 'extra', amount, resiId: 'r1', date: at(day), concept: 'Cargo', ...more });
const pay = (id, day, amount, more = {}) => ({ id, type: 'income', amount, resiId: 'r1', date: at(day), ...more });
// La regla de la asociacion: 3 % al mes, 5 dias de plazo: la mora se carga el dia 6 de cada mes
const rule = (more = {}) => ({ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee', ...more });
const S = { fee: 300, moraRules: [rule()] };
const state = (txs, asOf, settings = S) => D.stateOf('r1', txs, settings, asOf);
// Lo que mas se mira de un estado
const brief = (txs, asOf, settings = S) => {
    const s = state(txs, asOf, settings);
    return { capital: s.capital, overdue: s.overdueCapital, mora: s.mora, balance: s.balance };
};

console.log('\nDias');
equal('un dia es un numero y su clave AAAA-MM-DD', [D.dayOfKey('1970-01-01'), D.dayOfKey('1970-01-02'), D.keyOfDay(D.dayOfKey('2026-11-30'))], [0, 1, '2026-11-30']);
equal('una hora ISO se lee en el dia de Guatemala (las 03:00 UTC del 1 de diciembre aun son 30 de noviembre)', [D.keyOfDay(D.dayOf('2026-12-01T03:00:00.000Z')), D.keyOfDay(D.dayOf('2026-12-01T06:00:00.000Z'))], ['2026-11-30', '2026-12-01']);
equal('un texto AAAA-MM-DD se toma tal cual', D.keyOfDay(D.dayOf('2026-12-01')), '2026-12-01');
equal('tambien acepta un Date', D.keyOfDay(D.dayOf(new Date('2026-12-01T03:00:00.000Z'))), '2026-11-30');
equal('lo que no es fecha no tiene dia', [D.dayOf('no es fecha'), D.dayOf(''), D.dayOf(null), D.dayOf(undefined), D.dayOfKey('2026-11')], [null, null, null, null, null]);
const monthEnds = (period) => { const p = D.periodDays(period); return p && [D.keyOfDay(p.first), D.keyOfDay(p.last)]; };
equal('primer y ultimo dia del mes, con febrero y bisiesto', [monthEnds('2026-11'), monthEnds('2027-02'), monthEnds('2028-02'), monthEnds('2026-12')], [['2026-11-01', '2026-11-30'], ['2027-02-01', '2027-02-28'], ['2028-02-01', '2028-02-29'], ['2026-12-01', '2026-12-31']]);
equal('un periodo invalido no tiene dias', [D.periodDays('2026-13'), D.periodDays('2026-00'), D.periodDays('2026'), D.periodDays(null)], [null, null, null, null]);

console.log('\nQue es una cuota mensual');
equal('una cuota con periodo', D.feePeriod({ type: 'charge', kind: 'fee', period: '2026-11' }), '2026-11');
equal('los conceptos antiguos de OIKOS tambien', [D.feePeriod({ type: 'charge', concept: 'Cuota - Noviembre 2026' }), D.feePeriod({ type: 'charge', concept: 'Cuota - Noviembre de 2026' }), D.feePeriod({ type: 'charge', concept: 'Cuota - November 2026' })], ['2026-11', '2026-11', '2026-11']);
equal('un cargo extra, una mora cargada, un pago o una multa no son cuotas', [
    D.feePeriod({ type: 'charge', kind: 'extra', period: '2026-11' }), D.feePeriod({ type: 'charge', kind: 'fee', period: '2026-11', moraFixed: true }),
    D.feePeriod({ type: 'income', period: '2026-11' }), D.feePeriod({ type: 'charge', concept: 'Multa por ruido' }), D.feePeriod(null)
], [null, null, null, null, null]);

console.log('\nReglas de mora del condominio');
const plain = (rules) => rules.map(({ fromDay, ...r }) => r);
equal('sin reglas el condominio no cobra mora', [D.rulesOf({}), D.rulesOf(null), D.enabled({}), D.enabled({ moraRules: 'x' }), D.enabled({ moraRules: [] })], [[], [], false, false, false]);
equal('el historial queda limpio y en orden; lo invalido se descarta', plain(D.rulesOf({ moraRules: [
    { from: '2027-01-01', percent: '6', graceDays: '10', payFirst: 'mora' }, { from: '2000-01-01', percent: 3 },
    { from: 'ayer', percent: 3 }, { from: '2026-01-01', percent: -1 }, { from: '2026-01-01' }, null
] })), [{ from: '2000-01-01', percent: 3, graceDays: 0, payFirst: 'fee' }, { from: '2027-01-01', percent: 6, graceDays: 10, payFirst: 'mora' }]);
equal('con dos reglas de la misma fecha vale la ultima escrita', plain(D.rulesOf({ moraRules: [rule({ percent: 3 }), rule({ percent: 4 })] })), [{ from: '2000-01-01', percent: 4, graceDays: 5, payFirst: 'fee' }]);
equal('un orden de pago desconocido es "primero la cuota"', D.rulesOf({ moraRules: [rule({ payFirst: 'otro' })] })[0].payFirst, 'fee');
equal('un porcentaje 0 sigue siendo una regla (la mora esta activa, detenida)', D.enabled({ moraRules: [rule({ percent: 0 })] }), true);
const history = D.rulesOf({ moraRules: [rule(), rule({ from: '2027-01-01', percent: 6 })] });
equal('la regla vigente cada dia', [D.ruleAt(history, D.dayOfKey('1999-12-31')), D.ruleAt(history, D.dayOfKey('2000-01-01')).percent, D.ruleAt(history, D.dayOfKey('2026-12-31')).percent, D.ruleAt(history, D.dayOfKey('2027-01-01')).percent], [null, 3, 3, 6]);
equal('solo hay dos ordenes de pago', D.PAY_FIRST, ['fee', 'mora']);

console.log('\nDias de cargo de la mora');
equal('con 5 dias de plazo el cargo es el dia 6: el ultimo y el siguiente', [D.chargeDates(S, '2026-11-19'), D.chargeDates(S, '2026-12-05'), D.chargeDates(S, '2026-12-06'), D.chargeDates(S, '2026-12-31')], [
    { dayOfMonth: 6, last: '2026-11-06', next: '2026-12-06' }, { dayOfMonth: 6, last: '2026-11-06', next: '2026-12-06' },
    { dayOfMonth: 6, last: '2026-12-06', next: '2027-01-06' }, { dayOfMonth: 6, last: '2026-12-06', next: '2027-01-06' }]);
equal('en enero el anterior es el de diciembre del ano pasado', D.chargeDates(S, '2027-01-02'), { dayOfMonth: 6, last: '2026-12-06', next: '2027-01-06' });
equal('sin regla de mora no hay dias de cargo; con 0 dias de plazo es el 1 y con 40, el 28', [D.chargeDates({}, '2026-11-19'), D.chargeDates({ moraRules: [rule({ graceDays: 0 })] }, '2026-11-19').dayOfMonth, D.chargeDates({ moraRules: [rule({ graceDays: 40 })] }, '2026-11-19').dayOfMonth, D.MAX_CHARGE_DAY], [null, 1, 28, 28]);

console.log('\nCambiar la mora (con confirmacion en pantalla)');
equal('la primera regla puede empezar atras (un condominio que ya cobraba mora)', D.withRule({}, { from: '2000-01-01', percent: 3, graceDays: 5 }, '2026-11-12'), [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }]);
equal('un cambio desde hoy se agrega al historial sin tocar lo anterior', D.withRule(S, { from: '2026-11-12', percent: 5, graceDays: 5 }, '2026-11-12'), [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }, { from: '2026-11-12', percent: 5, graceDays: 5, payFirst: 'fee' }]);
equal('un cambio a futuro tambien', D.withRule(S, { from: '2027-01-01', percent: 2, graceDays: 10, payFirst: 'mora' }, '2026-11-12')[1], { from: '2027-01-01', percent: 2, graceDays: 10, payFirst: 'mora' });
throws('un cambio no puede empezar antes de hoy: lo que ya paso no se recalcula', () => D.withRule(S, { from: '2026-11-11', percent: 5 }, '2026-11-12'));
equal('"hoy" es el dia de Guatemala', D.withRule(S, { from: '2026-11-12', percent: 5 }, '2026-11-13T03:00:00.000Z').length, 2);
equal('una regla de la misma fecha reemplaza a la que estaba', D.withRule({ moraRules: [rule(), rule({ from: '2027-01-01', percent: 6 })] }, { from: '2027-01-01', percent: 4 }, '2026-11-12').map((r) => r.percent), [3, 4]);
throws('una regla sin fecha no se guarda', () => D.withRule({}, { percent: 3 }, '2026-11-12'));
throws('una regla con porcentaje negativo o sin porcentaje no se guarda', () => D.withRule({}, { from: '2026-11-12', percent: -3 }, '2026-11-12'));
equal('lo que devuelve withRule es lo que se guarda (sin campos internos)', Object.keys(D.withRule({}, rule(), '2026-11-12')[0]), ['from', 'percent', 'graceDays', 'payFirst']);

console.log('\nUna cuota de noviembre de Q 300 (3 % al mes, cargado el dia 6; 5 dias de plazo)');
const nov = fee('f11', '2026-11');
equal('en noviembre se debe pero no esta vencida', brief([nov], '2026-11-20'), { capital: 300, overdue: 0, mora: 0, balance: -300 });
equal('el 5 de diciembre (ultimo dia de plazo) no hay mora', brief([nov], '2026-12-05'), { capital: 300, overdue: 0, mora: 0, balance: -300 });
equal('el 6 de diciembre se carga el 3 % del mes: Q 9.00', brief([nov], '2026-12-06'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
equal('el 20 de diciembre: sigue en Q 9.00 (no cambia dia a dia)', brief([nov], '2026-12-20'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
equal('solo cambia el dia de cargo: Q 9.00 del 6 de diciembre al 5 de enero, Q 18.00 el 6 de enero, Q 27.00 el 6 de febrero', [state([nov], '2026-12-30').mora, state([nov], '2026-12-31').mora, state([nov], '2027-01-05').mora, state([nov], '2027-01-06').mora, state([nov], '2027-02-05').mora, state([nov], '2027-02-06').mora], [9, 9, 9, 18, 18, 27]);
equal('la mora no genera mora: a un ano son 12 cargos de Q 9.00 sobre los Q 300', state([nov], '2027-11-30').mora, 108);
equal('un mes completo con el saldo constante: del 6 de diciembre al 5 de enero siempre Q 309', (() => { const out = new Set(); for (let d = D.dayOfKey('2026-12-06'); d <= D.dayOfKey('2027-01-05'); d++) out.add(state([nov], D.keyOfDay(d)).balance); return [...out]; })(), [-309]);
equal('y en noviembre, antes de vencer, siempre Q 300 (ningun dia cambia)', (() => { const out = new Set(); for (let d = D.dayOfKey('2026-11-05'); d <= D.dayOfKey('2026-12-05'); d++) out.add(state([nov], D.keyOfDay(d)).balance); return [...out]; })(), [-300]);
equal('el detalle de la cuota dice cuando vence', (({ id, kind, period, dueDate, overdue }) => ({ id, kind, period, dueDate, overdue }))(state([nov], '2026-12-06').items[0]), { id: 'f11', kind: 'fee', period: '2026-11', dueDate: '2026-12-05', overdue: true });
equal('el estado dice de que dia es', state([nov], '2026-12-06').asOf, '2026-12-06');
equal('un concepto antiguo ("Cuota - Noviembre 2026") genera mora igual', state([{ id: 'v', type: 'charge', concept: 'Cuota - Noviembre 2026', amount: 300, resiId: 'r1', date: at('2026-11-05') }], '2026-12-20').mora, 9);

console.log('\nPagos');
equal('pagada el 4 de diciembre (dentro del plazo): nunca tuvo mora', brief([nov, pay('p', '2026-12-04', 300)], '2027-03-01'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('pagada el 5 de diciembre (ultimo dia de plazo): tampoco', brief([nov, pay('p', '2026-12-05', 300)], '2027-03-01'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('pagada el 6 de diciembre: el cargo del dia entra antes que el pago y debe Q 9.00 de mora', brief([nov, pay('p', '2026-12-06', 300)], '2026-12-06'), { capital: 0, overdue: 0, mora: 9, balance: -9 });
equal('pagada el 7 de diciembre: la misma mora que el 6 (Q 9.00), no mas', brief([nov, pay('p', '2026-12-07', 300)], '2027-03-01'), { capital: 0, overdue: 0, mora: 9, balance: -9 });
equal('un pago con fecha del 5 registrado despues (finanzas.pagos_fecha) tambien evita la mora: cuenta la fecha del pago', brief([nov, pay('p', '2026-12-05', 300, { created_at: '2026-12-08T15:00:00.000Z' })], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('pagada el 20 de diciembre: la mora (Q 9.00) queda como deuda y deja de crecer', [brief([nov, pay('p', '2026-12-20', 300)], '2026-12-20'), brief([nov, pay('p', '2026-12-20', 300)], '2027-06-30')], [{ capital: 0, overdue: 0, mora: 9, balance: -9 }, { capital: 0, overdue: 0, mora: 9, balance: -9 }]);
const paidAll = state([nov, pay('p', '2026-12-20', 309)], '2027-01-15');
equal('pagando cuota y mora queda en cero', [paidAll.capital, paidAll.mora, paidAll.moraAccrued, paidAll.moraPaid, paidAll.credit, paidAll.balance], [0, 0, 9, 9, 0, 0]);
equal('lo que sobra queda a favor', [state([nov, pay('p', '2026-12-20', 310)], '2027-01-15').credit, state([nov, pay('p', '2026-12-20', 310)], '2027-01-15').balance], [1, 1]);
equal('abono de Q 100 dentro del plazo: el cargo del 6 de diciembre es sobre los Q 200 que quedaron', brief([nov, pay('p', '2026-12-03', 100)], '2026-12-20'), { capital: 200, overdue: 200, mora: 6, balance: -206 });
equal('abono de Q 100 el 10 de diciembre: el cargo del 6 ya fue sobre Q 300 y el del 6 de enero es sobre los Q 200', [brief([nov, pay('p', '2026-12-10', 100)], '2026-12-20'), brief([nov, pay('p', '2026-12-10', 100)], '2027-01-06')], [{ capital: 200, overdue: 200, mora: 9, balance: -209 }, { capital: 200, overdue: 200, mora: 15, balance: -215 }]);
equal('un pago anulado no cuenta: la mora vuelve sola', brief([nov, pay('p', '2026-12-04', 300, { deleted: true })], '2026-12-20'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
equal('una cuota anulada no debe nada', brief([{ ...nov, deleted: true }], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('un pago posterior al dia que se consulta todavia no existe', brief([nov, pay('p', '2026-12-25', 300)], '2026-12-20'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
equal('un pago adelantado cubre las cuotas que vienen', (({ capital, mora, credit, balance }) => ({ capital, mora, credit, balance }))(state([pay('p', '2026-10-01', 1000), fee('f10', '2026-10'), nov], '2026-12-20')), { capital: 0, mora: 0, credit: 400, balance: 400 });
// Pago de mas (pedido del usuario el 2026-11-18): quien debe y paga de mas deja el resto a favor, y el saldo a favor se
// descuenta SOLO de las cuotas que se cargan despues: no quedan pendientes ni generan mora aunque se consulte ya vencidas
const overpay = [nov, pay('p', '2026-12-20', 909)];   // debe Q 300 + Q 9 de mora y paga Q 909: Q 600 a favor
equal('pago de mas: cubre la cuota y su mora y deja el resto a favor', brief(overpay, '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 600 });
const covered = overpay.concat([fee('f12', '2026-12', 300, '2026-12-28'), fee('f01', '2027-01', 300, '2027-01-05')]);
equal('las cuotas de diciembre y enero se cargan despues y el saldo a favor las paga solo: nada pendiente ni mora, ya vencidas', brief(covered, '2027-03-15'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('la de febrero ya no la cubre: el 6 de marzo se le carga el 3 % (Q 9)', brief(covered.concat([fee('f02', '2027-02', 300, '2027-02-05')]), '2027-03-15'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
const halfCovered = [nov, pay('p', '2026-12-20', 759), fee('f12', '2026-12', 300, '2026-12-28'), fee('f01', '2027-01', 300, '2027-01-05')];
equal('Q 450 a favor: paga diciembre entero y Q 150 de enero; la mora se carga solo sobre los Q 150 que faltan (6 de febrero)', brief(halfCovered, '2027-02-20'), { capital: 150, overdue: 150, mora: 4.5, balance: -154.5 });
equal('el servidor tampoco lo marca moroso (con y sin regla de mora)', [M.moraOf('r1', covered, S, new Date('2027-03-15T18:00:00Z')).moroso, M.moraOf('r1', covered, { fee: 300 }, new Date('2027-03-15T18:00:00Z')).moroso, M.moraOf('r1', covered, { fee: 300 }, new Date('2027-03-15T18:00:00Z')).balance], [false, false, 9]);
equal('en el mismo dia, el cargo entra antes que el pago aunque llegue despues en la lista', brief([pay('p', '2026-12-10', 100), extra('e', '2026-12-10', 100)], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('montos invalidos o en cero no cuentan', brief([{ ...nov, amount: 'abc' }, pay('p', '2026-12-01', 0), pay('q', '2026-12-01', -50)], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });

console.log('\nVarias cuotas y el orden de un pago que no alcanza');
const oct = fee('f10', '2026-10');
equal('octubre y noviembre sin pagar al 20 de diciembre: octubre lleva dos cargos (6 de noviembre y 6 de diciembre) y noviembre uno', brief([oct, nov], '2026-12-20'), { capital: 600, overdue: 600, mora: 27, balance: -627 });
equal('varios meses atrasados: septiembre, octubre y noviembre al 6 de diciembre llevan 3, 2 y 1 cargos (Q 27 + Q 18 + Q 9)', [state([fee('f09', '2026-09'), oct, nov], '2026-12-06').items.map((i) => [i.period, i.mora]), state([fee('f09', '2026-09'), oct, nov], '2026-12-06').mora], [[['2026-09', 27], ['2026-10', 18], ['2026-11', 9]], 54]);
equal('cada cuota lleva su propia mora', state([nov, oct], '2026-12-20').items.map((i) => [i.period, i.mora]), [['2026-10', 18], ['2026-11', 9]]);
const feeFirst = state([oct, nov, pay('p', '2026-12-20', 400)], '2026-12-30');
equal('primero la cuota: Q 400 pagan octubre y Q 100 de noviembre; la mora queda pendiente', [feeFirst.capital, feeFirst.mora, feeFirst.moraPaid, feeFirst.items.map((i) => [i.capital, i.mora])], [200, 27, 0, [[0, 18], [200, 9]]]);
const moraFirstRules = { fee: 300, moraRules: [rule({ payFirst: 'mora' })] };
const moraFirst = state([oct, nov, pay('p', '2026-12-20', 400)], '2026-12-30', moraFirstRules);
equal('primero la mora: Q 27 de mora, octubre completo y Q 73 de noviembre', [moraFirst.capital, moraFirst.mora, moraFirst.moraPaid, moraFirst.items.map((i) => [i.capital, i.mora])], [227, 0, 27, [[0, 0], [227, 0]]]);
equal('el pago va siempre a la cuota mas antigua primero', state([nov, oct, pay('p', '2026-12-03', 300)], '2026-12-03').items.map((i) => [i.period, i.capital]), [['2026-10', 0], ['2026-11', 300]]);
const identity = state([oct, nov, extra('e', '2026-11-15', 50), pay('p', '2026-12-20', 400), pay('q', '2027-01-10', 120)], '2027-02-01', moraFirstRules);
equal('nada se pierde: pagos menos cargos = saldo a favor + mora pagada - lo que falta', Math.round((520 - 650) * 100), Math.round((identity.credit + identity.moraPaid - identity.capital) * 100));

console.log('\nCargos extra y mora ya calculada (carga inicial)');
equal('un cargo extra no genera mora y cuenta como vencido', brief([extra('e', '2026-11-10', 500)], '2027-06-01'), { capital: 500, overdue: 500, mora: 0, balance: -500 });
const fixed = extra('m', '2026-11-15', 45.5, { moraFixed: true });
equal('la mora cargada de otro sistema es mora (no capital) y no crece', [brief([fixed], '2026-11-20'), brief([fixed], '2028-01-01')], [{ capital: 0, overdue: 0, mora: 45.5, balance: -45.5 }, { capital: 0, overdue: 0, mora: 45.5, balance: -45.5 }]);
equal('primero la cuota: el pago cubre la cuota y lo que sobra baja la mora cargada', brief([fixed, nov, pay('p', '2026-12-03', 320)], '2026-12-03'), { capital: 0, overdue: 0, mora: 25.5, balance: -25.5 });
equal('primero la mora: el mismo pago cubre la mora cargada y deja parte de la cuota', brief([fixed, nov, pay('p', '2026-12-03', 320)], '2026-12-03', moraFirstRules), { capital: 25.5, overdue: 0, mora: 0, balance: -25.5 });
equal('la mora cargada no cuenta para la garita', M.moraOf('r1', [fixed, extra('m2', '2026-11-15', 900, { moraFixed: true })], S, M.gtDate(2026, 11, 20, 12)).overdue, 0);

console.log('\nCambios de porcentaje, plazos y fechas');
equal('cada cargo usa el porcentaje vigente ese dia: 3 % el 6 de diciembre y 6 % desde el 16 (el 6 de enero, Q 18)', [state([nov], '2026-12-20', { moraRules: [rule(), rule({ from: '2026-12-16', percent: 6 })] }).mora, state([nov], '2027-01-06', { moraRules: [rule(), rule({ from: '2026-12-16', percent: 6 })] }).mora], [9, 27]);
equal('un porcentaje 0 detiene la mora desde ese dia', [state([nov], '2026-12-31', { moraRules: [rule(), rule({ from: '2026-12-11', percent: 0 })] }).mora, state([nov], '2027-02-06', { moraRules: [rule(), rule({ from: '2026-12-11', percent: 0 })] }).mora], [9, 9]);
equal('la mora no se carga antes de la primera regla: el 6 de diciembre no hay cargo y el 6 de enero si', [state([nov], '2026-12-20', { moraRules: [rule({ from: '2026-12-11' })] }).mora, state([nov], '2027-01-06', { moraRules: [rule({ from: '2026-12-11' })] }).mora], [0, 9]);
equal('con 10 dias de plazo la cuota vence el 10 y el cargo es el dia 11', [state([nov], '2026-12-10', { moraRules: [rule({ graceDays: 10 })] }).mora, state([nov], '2026-12-11', { moraRules: [rule({ graceDays: 10 })] }).mora], [0, 9]);
equal('sin plazo, el cargo es el dia 1', [state([nov], '2026-11-30', { moraRules: [rule({ graceDays: 0 })] }).mora, state([nov], '2026-12-01', { moraRules: [rule({ graceDays: 0 })] }).mora], [0, 9]);
equal('con un plazo de 27 dias o mas el cargo es el 28 (existe en todos los meses): noviembre con 30 dias de plazo vence el 30 de diciembre y su primer cargo es el 28 de enero', [state([nov], '2027-01-27', { moraRules: [rule({ graceDays: 30 })] }).mora, state([nov], '2027-01-28', { moraRules: [rule({ graceDays: 30 })] }).mora], [0, 9]);
equal('el dia de cargo de cada mes sale del plazo vigente el primero de ese mes: 5 dias en diciembre (el 6) y 10 desde enero (el 11)', [6, 10, 11].map((d) => state([nov], `2027-01-${String(d).padStart(2, '0')}`, { moraRules: [rule(), rule({ from: '2027-01-01', graceDays: 10 })] }).mora), [9, 9, 18]);
equal('febrero: la cuota vence el 28 (o el 29) mas el plazo y lleva su cargo el 6 de marzo', [state([fee('f', '2027-02')], '2027-03-05').mora, state([fee('f', '2027-02')], '2027-03-06').mora, state([fee('f', '2028-02')], '2028-03-10').mora, state([fee('f', '2027-02')], '2027-03-10').items[0].dueDate, state([fee('f', '2028-02')], '2028-03-10').items[0].dueDate], [0, 9, 9, '2027-03-05', '2028-03-05']);
const late = fee('f10', '2026-10', 300, '2027-03-10');
equal('una cuota de octubre cobrada el 10 de marzo vence el 15 de marzo y su primer cargo es el 6 de abril', [state([late], '2027-03-15').mora, state([late], '2027-04-05').mora, state([late], '2027-04-06').mora, state([late], '2027-03-20').items[0].dueDate], [0, 0, 9, '2027-03-15']);
equal('centavos: media paja (Q 80), una cuota de Q 380 y una de Q 83.33', [state([fee('a', '2026-11', 80)], '2026-12-31').mora, state([fee('a', '2026-11', 380)], '2026-12-20').mora, state([fee('a', '2026-11', 83.33)], '2026-12-20').mora], [2.4, 11.4, 2.5]);
equal('una cuota cobrada con la fecha del fin de mes (como en la carga inicial): marzo vencio el 5 de abril y lleva 8 cargos al 15 de noviembre', state([fee('a', '2026-03', 300, '2026-03-31')], '2026-11-15').mora, 72);

console.log('\nSin reglas de mora');
equal('no hay mora y el saldo es pagos menos cargos, como siempre', brief([oct, nov, pay('p', '2026-12-20', 400)], '2027-06-01', { fee: 300 }), { capital: 200, overdue: 200, mora: 0, balance: -200 });
equal('el servidor sigue con su calculo de siempre (misma respuesta que antes)', Object.keys(M.moraOf('r1', [oct, nov], { fee: 300, chargeDay: 5 }, M.gtDate(2026, 11, 20, 12))), ['balance', 'debt', 'overdue', 'moroso']);

console.log('\nVarios residentes');
const many = D.statesByResident([nov, fee('g11', '2026-11', 460, '2026-11-05', 'r2'), pay('p', '2026-12-04', 300), { id: 'sin', type: 'income', amount: 10, date: at('2026-12-01') }], S, '2026-12-20');
equal('cada residente con lo suyo', [Object.keys(many).sort(), many.r1.balance, many.r2.capital, many.r2.mora], [['r1', 'r2'], 0, 460, 13.8]);
equal('los movimientos de otro residente no cuentan', brief([nov, fee('g11', '2026-11', 460, '2026-11-05', 'r2')], '2026-12-20'), { capital: 300, overdue: 300, mora: 9, balance: -309 });
equal('sin movimientos, todo en cero', (({ capital, mora, credit, balance, items }) => ({ capital, mora, credit, balance, items }))(D.stateOf('r1', [], S, '2026-12-20')), { capital: 0, mora: 0, credit: 0, balance: 0, items: [] });

console.log('\nMora calculada y saldo del libro');
const withFixed = D.stateOf('r1', [oct, nov, extra('m', '2026-10-31', 50, { moraFixed: true }), pay('p', '2026-12-20', 100)], S, '2026-12-30');
equal('moraDaily es solo la mora que calcula el modulo (sin la mora fija cargada)', [withFixed.moraDaily > 0, withFixed.moraDaily], [true, round2(withFixed.moraAccrued - 50)]);
const ahead = [nov, fee('d', '2026-12', 300, '2026-12-31')];
const aheadState = D.stateOf('r1', ahead, S, '2026-12-20');
equal('una cuota fechada despues de hoy no cuenta en el estado del dia', [aheadState.capital, aheadState.balance], [300, -309]);
equal('el saldo del libro (con todo) menos la mora calculada cuadra: Q 600 + Q 9', round2(-600 - aheadState.moraDaily), -609);

// Descuento de mora (pedido del dueno el 2026-11-18): quitar la mora de los meses que se elijan, o un total que se
// descuenta de los meses mas recientes con mora. No es dinero: solo baja la mora
console.log('\nDescuento de mora');
const disc = (id, day, items, more = {}) => ({ id, type: 'mora_discount', amount: round2(items.reduce((a, x) => a + x.amount, 0)), resiId: 'r1', date: at(day), moraItems: items, ...more });
const twoFees = [oct, nov];   // al 20 de diciembre: octubre Q 18.00 de mora (6 de noviembre y 6 de diciembre) y noviembre Q 9.00 (6 de diciembre)
const moraOfItems = (st) => st.items.map((i) => [i.id, i.mora, i.moraWaived]);
equal('sin descuento: Q 18 de octubre y Q 9 de noviembre', moraOfItems(state(twoFees, '2026-12-20')), [['f10', 18, 0], ['f11', 9, 0]]);
const octOff = twoFees.concat([disc('d1', '2026-12-20', [{ id: 'f10', amount: 18 }])]);
const octOffState = state(octOff, '2026-12-20');
equal('descontar toda la mora de octubre: queda solo la de noviembre; el capital no cambia', [brief(octOff, '2026-12-20'), octOffState.moraWaived, moraOfItems(octOffState)], [{ capital: 600, overdue: 600, mora: 9, balance: -609 }, 18, [['f10', 0, 18], ['f11', 9, 0]]]);
equal('si la cuota sigue sin pagarse, no cambia hasta el siguiente dia de cargo (6 de enero), cuando vuelve a llevar mora', [moraOfItems(state(octOff, '2026-12-21')), moraOfItems(state(octOff, '2027-01-06'))], [[['f10', 0, 18], ['f11', 9, 0]], [['f10', 9, 18], ['f11', 18, 0]]]);
equal('un descuento mayor que la mora de esa cuota solo quita lo que debe: nunca deja saldo a favor', (({ mora, moraWaived, credit, balance }) => ({ mora, moraWaived, credit, balance }))(state(twoFees.concat([disc('d', '2026-12-20', [{ id: 'f10', amount: 50 }])]), '2026-12-20')), { mora: 9, moraWaived: 18, credit: 0, balance: -609 });
equal('un descuento anulado no cuenta: la mora vuelve sola', brief(twoFees.concat([disc('d', '2026-12-20', [{ id: 'f10', amount: 18 }], { deleted: true })]), '2026-12-20'), { capital: 600, overdue: 600, mora: 27, balance: -627 });
equal('un descuento sin cuotas validas, o de una cuota que no existe, no hace nada', [brief(twoFees.concat([disc('d', '2026-12-20', [{ id: 'f10', amount: 0 }]), { id: 'e', type: 'mora_discount', amount: 5, resiId: 'r1', date: at('2026-12-20') }]), '2026-12-20').mora, brief(twoFees.concat([disc('d', '2026-12-20', [{ id: 'otra', amount: 18 }])]), '2026-12-20').mora], [27, 27]);
equal('el descuento va antes que un pago del mismo dia (aunque en la lista llegue despues y aunque se cobre primero la mora): pagando el capital queda en cero', [
    brief([oct, nov, pay('p', '2026-12-20', 600), disc('d', '2026-12-20', [{ id: 'f10', amount: 18 }, { id: 'f11', amount: 9 }])], '2026-12-20'),
    brief([oct, nov, pay('p', '2026-12-20', 600), disc('d', '2026-12-20', [{ id: 'f10', amount: 18 }, { id: 'f11', amount: 9 }])], '2026-12-20', moraFirstRules)
], [{ capital: 0, overdue: 0, mora: 0, balance: 0 }, { capital: 0, overdue: 0, mora: 0, balance: 0 }]);
equal('una cuota ya pagada que solo debe mora: el descuento la deja en cero', brief([oct, nov, pay('p', '2026-12-20', 600), disc('d', '2026-12-28', [{ id: 'f10', amount: 18 }, { id: 'f11', amount: 9 }])], '2027-01-15'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('un descuento el mismo dia de cargo quita tambien el cargo de ese dia; el mes siguiente vuelve a cargarse', [brief([nov, disc('d', '2026-12-06', [{ id: 'f11', amount: 9 }])], '2026-12-06').mora, brief([nov, disc('d', '2026-12-06', [{ id: 'f11', amount: 9 }])], '2027-01-06').mora], [0, 9]);
equal('un descuento fechado despues del dia que se consulta todavia no existe', brief(twoFees.concat([disc('d', '2026-12-25', [{ id: 'f10', amount: 18 }])]), '2026-12-20').mora, 27);
const fixedList = [oct, nov, extra('m', '2026-10-31', 50, { moraFixed: true }), pay('p', '2026-12-20', 100), disc('d', '2026-12-30', [{ id: 'm', amount: 50 }])];
const fixedOff = D.stateOf('r1', fixedList, S, '2026-12-30');
const ledgerOf = (list) => round2(list.reduce((a, t) => a + (t.deleted ? 0 : t.type === 'income' ? t.amount : t.type === 'charge' ? -t.amount : 0), 0));
equal('tambien se descuenta la mora fija cargada de otro sistema, y el saldo del libro menos la mora por dia mas lo descontado cuadra', [fixedOff.moraWaived, round2(ledgerOf(fixedList) - fixedOff.moraDaily + fixedOff.moraWaived), fixedOff.balance], [50, fixedOff.balance, round2(-fixedOff.capital - fixedOff.mora)]);
equal('el libro de OIKOS no cambia (el descuento no es un pago ni un cargo)', ledgerOf(octOff), -600);
console.log('\nComo se reparte un descuento de mora (discountPlan)');
const st20 = state(twoFees, '2026-12-20');
const planIds = D.discountPlan(st20, { ids: ['f10'] });
equal('meses marcados: toda la mora de cada uno', [planIds.items.map((x) => [x.id, x.period, x.amount]), planIds.total, planIds.left], [[['f10', '2026-10', 18]], 18, 0]);
equal('un total: primero los meses mas recientes con mora (noviembre) y despues los anteriores', (({ items, total, left }) => ({ items: items.map((x) => [x.id, x.amount]), total, left }))(D.discountPlan(st20, { amount: 10 })), { items: [['f11', 9], ['f10', 1]], total: 10, left: 0 });
equal('un total mayor que toda la mora: solo la mora que se debe, y dice lo que sobra', (({ items, total, left }) => ({ items: items.map((x) => [x.id, x.amount]), total, left }))(D.discountPlan(st20, { amount: 30 })), { items: [['f11', 9], ['f10', 18]], total: 27, left: 3 });
equal('meses sin mora, montos en cero o ids que no existen no entran', [D.discountPlan(state(twoFees, '2026-11-03'), { amount: 10 }).items.length, D.discountPlan(st20, { amount: 0 }).items.length, D.discountPlan(st20, { ids: ['nada'] }).items.length], [0, 0, 0]);
equal('la mora fija (la mas antigua) va al final de un total', D.discountPlan(D.stateOf('r1', [oct, nov, extra('m', '2026-10-31', 50, { moraFixed: true })], S, '2026-12-20'), { amount: 60 }).items.map((x) => [x.id, x.amount]), [['f11', 9], ['f10', 18], ['m', 33]]);
const applied = state(twoFees.concat([disc('d', '2026-12-20', D.discountPlan(st20, { amount: 10 }).items)]), '2026-12-20');
equal('guardar el reparto como descuento baja la mora exactamente ese total', [applied.mora, applied.moraWaived], [17, 10]);
equal('el servidor: el descuento baja lo que debe y la garita sigue mirando solo el capital', [(({ debt, mora, overdue, moroso }) => ({ debt, mora, overdue, moroso }))(M.moraOf('r1', octOff, S, M.gtDate(2026, 11, 20, 12)))], [{ debt: 609, mora: 9, overdue: 600, moroso: true }]);
equal('el servidor lee las cuotas de cada descuento (TX_FIELDS)', /'moraItems'/.test(read('functions/src/finanzas/recalc.js')), true);

console.log('\nServidor: quien es moroso para la garita');
const dec20 = M.gtDate(2026, 11, 20, 12);
equal('una cuota vencida con su mora: debe Q 309 pero la garita mira solo el capital (no bloquea)', M.moraOf('r1', [nov], S, dec20), { balance: -309, debt: 309, overdue: 300, moroso: false, capital: 300, mora: 9 });
equal('dos cuotas vencidas: moroso', (({ overdue, moroso, debt }) => ({ overdue, moroso, debt }))(M.moraOf('r1', [oct, nov], S, dec20)), { overdue: 600, moroso: true, debt: 627 });
equal('dentro del plazo la cuota del mes pasado aun no cuenta', (({ overdue, moroso }) => ({ overdue, moroso }))(M.moraOf('r1', [oct, nov], S, M.gtDate(2026, 11, 3, 12))), { overdue: 300, moroso: false });
equal('la mora sola (cuotas ya pagadas) nunca bloquea', (({ overdue, moroso, debt }) => ({ overdue, moroso, debt }))(M.moraOf('r1', [oct, nov, pay('p', '2026-12-20', 600)], S, dec20)), { overdue: 0, moroso: false, debt: 27 });
const lot = { id: 'r1', waterUnits: 1 };
const water = { fee: 300, waterUnitPrice: 160, moraRules: [rule()] };
equal('con agua por lote, "una cuota" es la del lote (Q 460)', [M.moraOf('r1', [fee('a', '2026-11', 460)], water, dec20, lot).moroso, M.moraOf('r1', [fee('a', '2026-10', 460), fee('b', '2026-11', 460)], water, dec20, lot).moroso], [false, true]);
equal('el dia del servidor es el de Guatemala', M.moraOf('r1', [nov], S, new Date('2026-12-06T03:00:00.000Z')).mora, 0);
equal('a la medianoche del 6 de diciembre en Guatemala ya se cargo la mora', M.moraOf('r1', [nov], S, new Date('2026-12-06T06:00:00.000Z')).mora, 9);

console.log('\nLo que se debe, por concepto');
// Una cuota con su desglose (Q 300 de mantenimiento y Q 80 de agua) y otra sin desglose
const feeB = (id, period, breakdown, day) => ({ ...fee(id, period, Object.values(breakdown).reduce((a, b) => a + b, 0), day), breakdown });
const octB = feeB('b10', '2026-10', { maintenance: 300, water: 80 });
const novB = feeB('b11', '2026-11', { maintenance: 300, water: 80 });
const partsOf = (txs, asOf, settings = S) => state(txs, asOf, settings).parts;
equal('cada cuota lleva sus conceptos y el estado suma lo que falta de cada uno', partsOf([octB, novB], '2026-11-20'), { maintenance: 600, water: 160 });
equal('una cuota sin desglose es "fee"; un cargo extra, "extra"; la mora cargada no es de ningun concepto', partsOf([nov, extra('e', '2026-11-10', 120), extra('m', '2026-11-10', 45.5, { moraFixed: true })], '2026-11-20'), { fee: 300, extra: 120 });
equal('un desglose que no suma el monto no se usa: la cuota entera es "fee"', partsOf([{ ...fee('x', '2026-11', 300), breakdown: { maintenance: 100, water: 50 } }], '2026-11-20'), { fee: 300 });
equal('un desglose con basura, electricidad y otros tambien', partsOf([feeB('b', '2026-11', { maintenance: 200, water: 50, garbage: 25, electricity: 15.5, other: 9.5 })], '2026-11-20'), { maintenance: 200, water: 50, garbage: 25, electricity: 15.5, other: 9.5 });
equal('un pago normal baja cada concepto de la cuota mas antigua en proporcion: Q 190 de Q 380', state([octB, pay('p', '2026-10-20', 190)], '2026-11-01').items[0].parts, { maintenance: 150, water: 40 });
equal('un pago normal que cubre una cuota entera la saca y sigue con la siguiente', partsOf([octB, novB, pay('p', '2026-11-20', 380)], '2026-11-20'), { maintenance: 300, water: 80 });
const parcial = state([octB, novB, pay('p', '2026-11-20', 500)], '2026-11-20');
equal('las partes siempre suman el capital (cuota por cuota y en total)', [parcial.items.every((i) => round2(Object.values(i.parts).reduce((a, b) => a + b, 0)) === i.capital), round2(Object.values(parcial.parts).reduce((a, b) => a + b, 0)), parcial.capital], [true, 260, 260]);

console.log('\nPago dirigido a conceptos (alloc)');
// Dos cuotas (octubre y noviembre) de Q 380 cada una, al 20 de diciembre; mora de octubre 2 cargos de Q 11.40 (6 de noviembre y 6 de diciembre) = Q 22.80 y de noviembre Q 11.40
const two = [octB, novB];
const dueMora = state(two, '2026-12-20').mora;
equal('lo que se debe al 20 de diciembre: Q 760 de cuotas y su mora', [state(two, '2026-12-20').capital, dueMora], [760, 34.2]);
const waterOnly = state([...two, pay('p', '2026-12-20', 160, { alloc: { water: 160 } })], '2026-12-20');
equal('pagar solo el agua de las dos cuotas: baja el agua y deja todo el mantenimiento y la mora', [waterOnly.parts, waterOnly.capital, waterOnly.mora], [{ maintenance: 600 }, 600, 34.2]);
const moraOnly = state([...two, pay('p', '2026-12-20', 34.2, { alloc: { mora: 34.2 } })], '2026-12-20');
equal('pagar solo la mora: no toca las cuotas aunque payFirst sea "la cuota primero"', [moraOnly.capital, moraOnly.mora, moraOnly.moraPaid, moraOnly.parts], [760, 0, 34.2, { maintenance: 600, water: 160 }]);
equal('el mismo pago SIN alloc se va primero a las cuotas (regla de siempre)', (({ capital, mora }) => ({ capital, mora }))(state([...two, pay('p', '2026-12-20', 34.2)], '2026-12-20')), { capital: 725.8, mora: 34.2 });
const mixed = state([...two, pay('p', '2026-12-20', 400, { alloc: { maintenance: 300, water: 80, mora: 20 } })], '2026-12-20');
equal('mantenimiento, agua y mora a la vez: lo mas antiguo primero en cada concepto', [mixed.items.map((i) => [i.period, i.capital, i.parts, i.mora]), mixed.capital, mixed.moraPaid], [[['2026-10', 0, {}, 2.8], ['2026-11', 380, { maintenance: 300, water: 80 }, 11.4]], 380, 20]);
equal('la mora se paga a la cuota mas antigua primero', moraOnly.items.map((i) => [i.period, i.moraPaid]), [['2026-10', 22.8], ['2026-11', 11.4]]);
equal('un alloc que no suma el pago se ignora: el pago se reparte normal', (({ capital, mora }) => ({ capital, mora }))(state([...two, pay('p', '2026-12-20', 100, { alloc: { water: 40 } })], '2026-12-20')), (({ capital, mora }) => ({ capital, mora }))(state([...two, pay('p', '2026-12-20', 100)], '2026-12-20')));
equal('un alloc con montos raros (texto, negativos, conceptos que no existen) se ignora', (({ capital, mora }) => ({ capital, mora }))(state([...two, pay('p', '2026-12-20', 100, { alloc: { water: 'x', foo: 100, maintenance: -5 } })], '2026-12-20')), (({ capital, mora }) => ({ capital, mora }))(state([...two, pay('p', '2026-12-20', 100)], '2026-12-20')));
const over = state([octB, pay('p', '2026-10-20', 150, { alloc: { water: 150 } })], '2026-10-20');
equal('pagar de mas un concepto: lo que sobra se reparte como un pago normal (el agua solo debia Q 80)', [over.parts, over.capital, over.credit], [{ maintenance: 230 }, 230, 0]);
equal('un pago dirigido sin nada que deber queda a favor entero', [state([pay('p', '2026-12-20', 100, { alloc: { water: 100 } })], '2026-12-20').credit, state([pay('p', '2026-12-20', 100, { alloc: { water: 100 } })], '2026-12-20').balance], [100, 100]);
equal('la mora de la cuota deja de crecer sobre lo que se pago: pagar el mantenimiento baja la mora de los cargos siguientes', (() => {
    const a = state([octB, pay('p', '2026-11-15', 300, { alloc: { maintenance: 300 } })], '2026-12-31').mora;
    const b = state([octB], '2026-12-31').mora;
    return a < b;
})(), true);
equal('un cargo extra tambien se paga con su concepto', (({ capital, parts }) => ({ capital, parts }))(state([nov, extra('e', '2026-11-10', 120), pay('p', '2026-11-20', 120, { alloc: { extra: 120 } })], '2026-11-20')), { capital: 300, parts: { fee: 300 } });
equal('una cuota sin desglose se paga con "fee"', (({ capital, parts }) => ({ capital, parts }))(state([nov, extra('e', '2026-11-10', 120), pay('p', '2026-11-20', 300, { alloc: { fee: 300 } })], '2026-11-20')), { capital: 120, parts: { extra: 120 } });
equal('un pago anulado no se aplica, tampoco su alloc', state([...two, pay('p', '2026-12-20', 160, { alloc: { water: 160 }, deleted: true })], '2026-12-20').parts, { maintenance: 600, water: 160 });
equal('el saldo no depende de como se dirija el pago: pagos menos cargos y mora', (() => {
    const a = state([...two, pay('p', '2026-12-20', 400, { alloc: { maintenance: 300, water: 80, mora: 20 } })], '2026-12-20').balance;
    return round2(a);
})(), round2(400 - 760 - 34.2));
equal('el servidor decide moroso con el pago dirigido: pagar solo la mora deja las dos cuotas vencidas', (({ overdue, moroso }) => ({ overdue, moroso }))(M.moraOf('r1', [...two, pay('p', '2026-12-20', 34.2, { alloc: { mora: 34.2 } })], S, dec20)), { overdue: 760, moroso: true });
equal('el mismo pago sin alloc (primero la cuota) deja menos vencido', M.moraOf('r1', [...two, pay('p', '2026-12-20', 34.2)], S, dec20).overdue, 725.8);

console.log('\nVista previa de un pago normal');
const preview = (amount, txs = two, settings = S, asOf = '2026-12-20') => D.previewPayment('r1', txs, settings, amount, asOf);
equal('Q 380 con primero la cuota: paga la cuota mas antigua entera y nada de mora', preview(380), { parts: { maintenance: 300, water: 80 }, mora: 0, credit: 0 });
equal('Q 100: en proporcion de la cuota mas antigua', preview(100), { parts: { maintenance: 78.95, water: 21.05 }, mora: 0, credit: 0 });
equal('con primero la mora, los primeros Q 34.20 van a la mora y los Q 5.80 que sobran a la cuota mas antigua, en proporcion', preview(40, two, { moraRules: [rule({ payFirst: 'mora' })] }), { parts: { maintenance: 4.58, water: 1.22 }, mora: 34.2, credit: 0 });
equal('un pago de mas: paga todo y lo que sobra queda a favor', preview(1000), { parts: { maintenance: 600, water: 160 }, mora: 34.2, credit: 205.8 });
equal('sin monto, nada', [preview(0), preview(''), preview(-5)], [{ parts: {}, mora: 0, credit: 0 }, { parts: {}, mora: 0, credit: 0 }, { parts: {}, mora: 0, credit: 0 }]);
equal('la vista previa no cambia el estado de verdad', [state(two, '2026-12-20').capital, (preview(500), state(two, '2026-12-20').capital)], [760, 760]);
equal('la vista previa de lo que se paga es exactamente lo que despues muestra el estado', (() => {
    const p = preview(500);
    const real = state([...two, pay('p', '2026-12-20', 500)], '2026-12-20');
    const before = state(two, '2026-12-20');
    return round2(before.capital - real.capital) === round2(Object.values(p.parts).reduce((a, b) => a + b, 0)) && round2(before.mora - real.mora) === p.mora;
})(), true);
equal('los conceptos que acepta un pago dirigido', [D.PART_KEYS, D.ALLOC_KEYS], [['maintenance', 'water', 'garbage', 'electricity', 'other'], ['maintenance', 'water', 'garbage', 'electricity', 'other', 'fee', 'extra', 'mora']]);

console.log('\nCopia del servidor y navegador');
yes('el servidor usa una copia IDENTICA del modulo', read('finanzas/sisdel-mora.js') === read('functions/src/finanzas/mora-diaria.js'));
const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-mora.js'), sandbox);
yes('en el navegador queda como SisdelMora', sandbox.self.SisdelMora && typeof sandbox.self.SisdelMora.stateOf === 'function');
equal('el navegador y el servidor calculan lo mismo', JSON.stringify(sandbox.self.SisdelMora.stateOf('r1', [oct, nov, pay('p', '2026-12-20', 400)], S, '2026-12-30')), JSON.stringify(feeFirst));

console.log('\nOIKOS y el recalculo del servidor');
const oikos = read('finanzas/index.html');
const recalc = read('functions/src/finanzas/recalc.js');
yes('OIKOS carga el modulo despues de las cuotas', /<script src="\.\/sisdel-mora\.js\?v=\w+"><\/script>/.test(oikos) && oikos.indexOf('<script src="./sisdel-cuotas.js') < oikos.indexOf('<script src="./sisdel-mora.js'));
yes('el saldo de cada residente es el del libro mas la mora a hoy', /const ms = sisdelMoraOf\(r\.id, r\.balance\);\s*return \{ ms, shown: ms \? ms\.total : r\.balance \};/.test(oikos) && /const shownBalance = balanceOf\.get\(r\.id\)\.shown;/.test(oikos) && /\(parseFloat\(ledgerBalance\) \|\| 0\) - \(ms\.moraDaily \|\| 0\)/.test(oikos));
yes('el estado de cuenta, el PDF, la impresion, el Excel y WhatsApp salen del mismo calculo (ecDebt: accountDebt del saldo con mora)', (oikos.match(/ecDebt\(\)/g) || []).length >= 5 && /const debt = SisdelReportesOikos\.accountDebt\(ms\);/.test(oikos) && !/-ms\.balance/.test(oikos) && !/Total con mora \$\{formatMoney/.test(oikos));
yes('la ventana del ingreso dice cuando se carga la proxima mora si no paga antes', oikos.includes('id="inc-bal-next"') && /function sisdelNextMoraCharge\(/.test(oikos) && /SisdelMora\.chargeDates\(settings, today\)/.test(oikos) && /const nextEl = document\.getElementById\('inc-bal-next'\)/.test(oikos));
yes('el texto de la regla dice el dia de cargo (ya no "por dia")', !/al mes por día/.test(oikos) && /cargado el día \$\{when \? when\.dayOfMonth/.test(oikos) && !/mora por d[ií]a/i.test(oikos));
yes('el estado de cuenta muestra capital vencido, mora y total a pagar', ['ec-mora-box', 'ec-overdue', 'ec-mora', 'ec-total-due'].every((id) => oikos.includes(`id="${id}"`)));
yes('el PDF y la impresion del estado de cuenta llevan la mora', (oikos.match(/sisdelMoraRuleText\(\)/g) || []).length >= 3);
yes('sin reglas de mora no se calcula nada (OIKOS como siempre)', /if \(typeof SisdelMora === 'undefined' \|\| !SisdelMora\.enabled\(s\)\) return null;/.test(oikos));
yes('el servidor lee la fecha de cada cargo y si es mora fija', /const TX_FIELDS = \[[^\]]*'date'[^\]]*'moraFixed'/.test(recalc));
yes('el servidor tambien lee los conceptos de cada cuota (breakdown) y a que conceptos se aplico cada pago (alloc)', /'moraFixed', 'breakdown', 'alloc'/.test(recalc));
yes('el servidor pasa la ficha del lote al decidir quien es moroso', /moraOf\(r\.id, txs, settings, now, r\)/.test(recalc) && /moraOf\(String\(residentId\), txSnap\.docs\.map\(txOf\), settings, now, extraSnap\.exists \? extraSnap\.data\(\) : null\)/.test(recalc));
yes('cambiar el desglose, el agua o la mora recalcula el condominio', /const FEE_SETTINGS = \[[^\]]*'feeBreakdown', 'waterUnitPrice', 'waterHalfPrice', 'moraRules'\]/.test(read('functions/src/finanzas/index.js')));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
