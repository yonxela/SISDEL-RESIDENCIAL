// Pruebas de la mora por dia (finanzas/sisdel-mora.js y su uso en el servidor): sin emuladores. Datos inventados.
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
// La regla de la asociacion: 3 % al mes (0.1 % diario) y 5 dias de plazo
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

console.log('\nUna cuota de noviembre de Q 300 (3 % al mes, 5 dias de plazo)');
const nov = fee('f11', '2026-11');
equal('en noviembre se debe pero no esta vencida', brief([nov], '2026-11-20'), { capital: 300, overdue: 0, mora: 0, balance: -300 });
equal('el 5 de diciembre (ultimo dia de plazo) no hay mora', brief([nov], '2026-12-05'), { capital: 300, overdue: 0, mora: 0, balance: -300 });
equal('el 6 de diciembre ya corre, contada desde el 30 de noviembre: 6 dias, Q 1.80', brief([nov], '2026-12-06'), { capital: 300, overdue: 300, mora: 1.8, balance: -301.8 });
equal('el 20 de diciembre: 20 dias, Q 6.00', brief([nov], '2026-12-20'), { capital: 300, overdue: 300, mora: 6, balance: -306 });
equal('Q 0.30 cada dia', [state([nov], '2026-12-30').mora, state([nov], '2026-12-31').mora, state([nov], '2027-01-01').mora], [9, 9.3, 9.6]);
equal('la mora no genera mora: a un ano son 365 dias sobre los Q 300', state([nov], '2027-11-30').mora, 109.5);
equal('el detalle de la cuota dice cuando vence', (({ id, kind, period, dueDate, overdue }) => ({ id, kind, period, dueDate, overdue }))(state([nov], '2026-12-06').items[0]), { id: 'f11', kind: 'fee', period: '2026-11', dueDate: '2026-12-05', overdue: true });
equal('el estado dice de que dia es', state([nov], '2026-12-06').asOf, '2026-12-06');
equal('un concepto antiguo ("Cuota - Noviembre 2026") genera mora igual', state([{ id: 'v', type: 'charge', concept: 'Cuota - Noviembre 2026', amount: 300, resiId: 'r1', date: at('2026-11-05') }], '2026-12-20').mora, 6);

console.log('\nPagos');
equal('pagada el 4 de diciembre (dentro del plazo): nunca tuvo mora', brief([nov, pay('p', '2026-12-04', 300)], '2027-03-01'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('pagada el 5 de diciembre: tampoco', brief([nov, pay('p', '2026-12-05', 300)], '2027-03-01'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('pagada el 6 de diciembre: debe los 6 dias de mora', brief([nov, pay('p', '2026-12-06', 300)], '2026-12-06'), { capital: 0, overdue: 0, mora: 1.8, balance: -1.8 });
equal('pagada el 20 de diciembre: la mora (Q 6.00) queda como deuda y deja de crecer', [brief([nov, pay('p', '2026-12-20', 300)], '2026-12-20'), brief([nov, pay('p', '2026-12-20', 300)], '2027-06-30')], [{ capital: 0, overdue: 0, mora: 6, balance: -6 }, { capital: 0, overdue: 0, mora: 6, balance: -6 }]);
const paidAll = state([nov, pay('p', '2026-12-20', 306)], '2027-01-15');
equal('pagando cuota y mora queda en cero', [paidAll.capital, paidAll.mora, paidAll.moraAccrued, paidAll.moraPaid, paidAll.credit, paidAll.balance], [0, 0, 6, 6, 0, 0]);
equal('lo que sobra queda a favor', [state([nov, pay('p', '2026-12-20', 310)], '2027-01-15').credit, state([nov, pay('p', '2026-12-20', 310)], '2027-01-15').balance], [4, 4]);
equal('abono de Q 100 dentro del plazo: la mora corre solo sobre los Q 200 que quedaron', brief([nov, pay('p', '2026-12-03', 100)], '2026-12-20'), { capital: 200, overdue: 200, mora: 4, balance: -204 });
equal('abono de Q 100 el 10 de diciembre: 10 dias sobre 300 y 10 dias sobre 200', brief([nov, pay('p', '2026-12-10', 100)], '2026-12-20'), { capital: 200, overdue: 200, mora: 5, balance: -205 });
equal('un pago anulado no cuenta: la mora vuelve sola', brief([nov, pay('p', '2026-12-04', 300, { deleted: true })], '2026-12-20'), { capital: 300, overdue: 300, mora: 6, balance: -306 });
equal('una cuota anulada no debe nada', brief([{ ...nov, deleted: true }], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('un pago posterior al dia que se consulta todavia no existe', brief([nov, pay('p', '2026-12-25', 300)], '2026-12-20'), { capital: 300, overdue: 300, mora: 6, balance: -306 });
equal('un pago adelantado cubre las cuotas que vienen', (({ capital, mora, credit, balance }) => ({ capital, mora, credit, balance }))(state([pay('p', '2026-10-01', 1000), fee('f10', '2026-10'), nov], '2026-12-20')), { capital: 0, mora: 0, credit: 400, balance: 400 });
equal('en el mismo dia, el cargo entra antes que el pago aunque llegue despues en la lista', brief([pay('p', '2026-12-10', 100), extra('e', '2026-12-10', 100)], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });
equal('montos invalidos o en cero no cuentan', brief([{ ...nov, amount: 'abc' }, pay('p', '2026-12-01', 0), pay('q', '2026-12-01', -50)], '2026-12-20'), { capital: 0, overdue: 0, mora: 0, balance: 0 });

console.log('\nVarias cuotas y el orden de un pago que no alcanza');
const oct = fee('f10', '2026-10');
equal('octubre y noviembre sin pagar al 20 de diciembre: 50 dias y 20 dias', brief([oct, nov], '2026-12-20'), { capital: 600, overdue: 600, mora: 21, balance: -621 });
equal('cada cuota lleva su propia mora', state([nov, oct], '2026-12-20').items.map((i) => [i.period, i.mora]), [['2026-10', 15], ['2026-11', 6]]);
const feeFirst = state([oct, nov, pay('p', '2026-12-20', 400)], '2026-12-30');
equal('primero la cuota: Q 400 pagan octubre y Q 100 de noviembre; la mora queda pendiente', [feeFirst.capital, feeFirst.mora, feeFirst.moraPaid, feeFirst.items.map((i) => [i.capital, i.mora])], [200, 23, 0, [[0, 15], [200, 8]]]);
const moraFirstRules = { fee: 300, moraRules: [rule({ payFirst: 'mora' })] };
const moraFirst = state([oct, nov, pay('p', '2026-12-20', 400)], '2026-12-30', moraFirstRules);
equal('primero la mora: Q 21 de mora, octubre completo y Q 79 de noviembre', [moraFirst.capital, moraFirst.mora, moraFirst.moraPaid, moraFirst.items.map((i) => [i.capital, i.mora])], [221, 2.21, 21, [[0, 0], [221, 2.21]]]);
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
equal('3 % hasta el 15 de diciembre y 6 % desde el 16: 15 dias a 0.1 % y 5 dias a 0.2 %', state([nov], '2026-12-20', { moraRules: [rule(), rule({ from: '2026-12-16', percent: 6 })] }).mora, 7.5);
equal('un porcentaje 0 detiene la mora desde ese dia', state([nov], '2026-12-31', { moraRules: [rule(), rule({ from: '2026-12-11', percent: 0 })] }).mora, 3);
equal('la mora no corre antes de la primera regla', state([nov], '2026-12-20', { moraRules: [rule({ from: '2026-12-11' })] }).mora, 3);
equal('el plazo es el de la regla vigente cuando termina el mes de la cuota', [state([nov], '2026-12-10', { moraRules: [rule({ graceDays: 10 })] }).mora, state([nov], '2026-12-11', { moraRules: [rule({ graceDays: 10 })] }).mora], [0, 3.3]);
equal('sin plazo, la mora corre desde el dia siguiente al fin de mes', [state([nov], '2026-11-30', { moraRules: [rule({ graceDays: 0 })] }).mora, state([nov], '2026-12-01', { moraRules: [rule({ graceDays: 0 })] }).mora], [0, 0.3]);
equal('febrero: la cuota vence el 28 (o el 29) mas el plazo', [state([fee('f', '2027-02')], '2027-03-10').mora, state([fee('f', '2028-02')], '2028-03-10').mora, state([fee('f', '2027-02')], '2027-03-10').items[0].dueDate, state([fee('f', '2028-02')], '2028-03-10').items[0].dueDate], [3, 3, '2027-03-05', '2028-03-05']);
const late = fee('f10', '2026-10', 300, '2027-03-10');
equal('una cuota de octubre cobrada en marzo cuenta desde marzo', [state([late], '2027-03-15').mora, state([late], '2027-03-20').mora, state([late], '2027-03-20').items[0].dueDate], [0, 3, '2027-03-15']);
equal('centavos: media paja (Q 80) con 31 dias, y una cuota de Q 380 con 20', [state([fee('a', '2026-11', 80)], '2026-12-31').mora, state([fee('a', '2026-11', 380)], '2026-12-20').mora], [2.48, 7.6]);
equal('una cuota cobrada con la fecha del fin de mes (como en la carga inicial)', state([fee('a', '2026-03', 300, '2026-03-31')], '2026-11-15').mora, 68.7);

console.log('\nSin reglas de mora');
equal('no hay mora y el saldo es pagos menos cargos, como siempre', brief([oct, nov, pay('p', '2026-12-20', 400)], '2027-06-01', { fee: 300 }), { capital: 200, overdue: 200, mora: 0, balance: -200 });
equal('el servidor sigue con su calculo de siempre (misma respuesta que antes)', Object.keys(M.moraOf('r1', [oct, nov], { fee: 300, chargeDay: 5 }, M.gtDate(2026, 11, 20, 12))), ['balance', 'debt', 'overdue', 'moroso']);

console.log('\nVarios residentes');
const many = D.statesByResident([nov, fee('g11', '2026-11', 460, '2026-11-05', 'r2'), pay('p', '2026-12-04', 300), { id: 'sin', type: 'income', amount: 10, date: at('2026-12-01') }], S, '2026-12-20');
equal('cada residente con lo suyo', [Object.keys(many).sort(), many.r1.balance, many.r2.capital, many.r2.mora], [['r1', 'r2'], 0, 460, 9.2]);
equal('los movimientos de otro residente no cuentan', brief([nov, fee('g11', '2026-11', 460, '2026-11-05', 'r2')], '2026-12-20'), { capital: 300, overdue: 300, mora: 6, balance: -306 });
equal('sin movimientos, todo en cero', (({ capital, mora, credit, balance, items }) => ({ capital, mora, credit, balance, items }))(D.stateOf('r1', [], S, '2026-12-20')), { capital: 0, mora: 0, credit: 0, balance: 0, items: [] });

console.log('\nMora por dia y saldo del libro');
const withFixed = D.stateOf('r1', [oct, nov, extra('m', '2026-10-31', 50, { moraFixed: true }), pay('p', '2026-12-20', 100)], S, '2026-12-30');
equal('moraDaily es solo la mora por dia (sin la mora fija cargada)', [withFixed.moraDaily > 0, withFixed.moraDaily], [true, round2(withFixed.moraAccrued - 50)]);
const ahead = [nov, fee('d', '2026-12', 300, '2026-12-31')];
const aheadState = D.stateOf('r1', ahead, S, '2026-12-20');
equal('una cuota fechada despues de hoy no cuenta en el estado del dia', [aheadState.capital, aheadState.balance], [300, -306]);
equal('el saldo del libro (con todo) menos la mora por dia cuadra: Q 600 + Q 6', round2(-600 - aheadState.moraDaily), -606);

console.log('\nServidor: quien es moroso para la garita');
const dec20 = M.gtDate(2026, 11, 20, 12);
equal('una cuota vencida con su mora: debe Q 306 pero la garita mira solo el capital (no bloquea)', M.moraOf('r1', [nov], S, dec20), { balance: -306, debt: 306, overdue: 300, moroso: false, capital: 300, mora: 6 });
equal('dos cuotas vencidas: moroso', (({ overdue, moroso, debt }) => ({ overdue, moroso, debt }))(M.moraOf('r1', [oct, nov], S, dec20)), { overdue: 600, moroso: true, debt: 621 });
equal('dentro del plazo la cuota del mes pasado aun no cuenta', (({ overdue, moroso }) => ({ overdue, moroso }))(M.moraOf('r1', [oct, nov], S, M.gtDate(2026, 11, 3, 12))), { overdue: 300, moroso: false });
equal('la mora sola (cuotas ya pagadas) nunca bloquea', (({ overdue, moroso, debt }) => ({ overdue, moroso, debt }))(M.moraOf('r1', [oct, nov, pay('p', '2026-12-20', 600)], S, dec20)), { overdue: 0, moroso: false, debt: 21 });
const lot = { id: 'r1', waterUnits: 1 };
const water = { fee: 300, waterUnitPrice: 160, moraRules: [rule()] };
equal('con agua por lote, "una cuota" es la del lote (Q 460)', [M.moraOf('r1', [fee('a', '2026-11', 460)], water, dec20, lot).moroso, M.moraOf('r1', [fee('a', '2026-10', 460), fee('b', '2026-11', 460)], water, dec20, lot).moroso], [false, true]);
equal('el dia del servidor es el de Guatemala', M.moraOf('r1', [nov], S, new Date('2026-12-06T03:00:00.000Z')).mora, 0);

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
yes('el saldo de cada residente es el del libro mas la mora del dia', /const ms = sisdelMoraOf\(r\.id, r\.balance\);/.test(oikos) && /const shownBalance = ms \? ms\.total : r\.balance;/.test(oikos) && /\(parseFloat\(ledgerBalance\) \|\| 0\) - \(ms\.moraDaily \|\| 0\)/.test(oikos));
yes('el estado de cuenta, el PDF y la impresion usan el mismo total con mora', (oikos.match(/formatMoney\(Math\.max\(0, -ms\.total\)\)/g) || []).length === 3 && !/-ms\.balance/.test(oikos));
yes('el estado de cuenta muestra capital vencido, mora y total a pagar', ['ec-mora-box', 'ec-overdue', 'ec-mora', 'ec-total-due'].every((id) => oikos.includes(`id="${id}"`)));
yes('el PDF y la impresion del estado de cuenta llevan la mora', (oikos.match(/sisdelMoraRuleText\(\)/g) || []).length >= 3);
yes('sin reglas de mora no se calcula nada (OIKOS como siempre)', /if \(typeof SisdelMora === 'undefined' \|\| !SisdelMora\.enabled\(s\)\) return null;/.test(oikos));
yes('el servidor lee la fecha de cada cargo y si es mora fija', /const TX_FIELDS = \[[^\]]*'date'[^\]]*'moraFixed'/.test(recalc));
yes('el servidor pasa la ficha del lote al decidir quien es moroso', /moraOf\(r\.id, txs, settings, now, r\)/.test(recalc) && /moraOf\(String\(residentId\), txSnap\.docs\.map\(txOf\), settings, now, extraSnap\.exists \? extraSnap\.data\(\) : null\)/.test(recalc));
yes('cambiar el desglose, el agua o la mora recalcula el condominio', /const FEE_SETTINGS = \[[^\]]*'feeBreakdown', 'waterUnitPrice', 'moraRules'\]/.test(read('functions/src/finanzas/index.js')));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
