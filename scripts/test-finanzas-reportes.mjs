// Pruebas de los calculos y salidas de los reportes de OIKOS (finanzas/sisdel-reportes.js): ingresos, egresos y saldo
// por mes con el total de cada ano, y el paso de un reporte al Excel (.xlsx) y al mensaje de WhatsApp.
// Sin emuladores ni navegador. Uso: node test-finanzas-reportes.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib-xlsx.mjs';

const require = createRequire(import.meta.url);
const R = require('../finanzas/sisdel-reportes.js');
const X = require('../reportes-export.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const yes = (name, value) => equal(name, !!value, true);

// Dia local de Guatemala (UTC-6), como localDayKey de OIKOS en un equipo de alla
const gtDay = (iso) => new Date(new Date(iso).getTime() - 6 * 3600000).toISOString().slice(0, 10);
const tx = (id, type, date, amount, extra) => ({ id, type, date, amount, ...(extra || {}) });

console.log('\nIngresos, egresos y saldo por mes');
const txs = [
    tx('p1', 'income', '2026-01-10T15:00:00.000Z', 300),
    tx('p2', 'income', '2026-01-20T15:00:00.000Z', 450.5),
    tx('g1', 'expense', '2026-01-25T15:00:00.000Z', 120),
    tx('c1', 'charge', '2026-02-01T15:00:00.000Z', 300, { kind: 'fee', period: '2026-02' }),
    tx('p3', 'income', '2026-03-05T15:00:00.000Z', 300),
    tx('g2', 'expense', '2026-03-31T23:00:00.000Z', 1000),
    tx('p4', 'income', '2025-12-15T15:00:00.000Z', 200),
    tx('x1', 'income', '2026-01-11T15:00:00.000Z', 999, { deleted: true })
];
const all = R.monthBalance(txs, { dayKey: gtDay });
equal('una fila por mes, tambien los meses sin movimientos (febrero en cero)', all.months.map((m) => m.key), ['2025-12', '2026-01', '2026-02', '2026-03']);
equal('ingresos = pagos; egresos = gastos; los cargos y lo anulado no cuentan', all.months.map((m) => [m.income, m.expense, m.balance]), [[200, 0, 200], [750.5, 120, 630.5], [0, 0, 0], [300, 1000, -700]]);
equal('el total de cada ano', all.years, [{ year: 2025, income: 200, expense: 0, balance: 200, charges: 0, receivable: 0 }, { year: 2026, income: 1050.5, expense: 1120, balance: -69.5, charges: 300, receivable: 0 }]);
equal('el total general', all.total, { income: 1250.5, expense: 1120, balance: 130.5, charges: 300, receivable: 0 });
equal('un gasto del 31 de marzo a las 5 pm de Guatemala cae en marzo (dia local, no el UTC)', R.monthBalance([tx('g', 'expense', '2026-03-31T23:00:00.000Z', 10)], { dayKey: gtDay }).months.map((m) => m.key), ['2026-03']);
const ranged = R.monthBalance(txs, { from: '2026-01-15', to: '2026-04-30', dayKey: gtDay });
equal('el rango Desde-Hasta filtra por dia y muestra todos sus meses', ranged.months.map((m) => [m.key, m.income, m.expense]), [['2026-01', 450.5, 120], ['2026-02', 0, 0], ['2026-03', 300, 1000], ['2026-04', 0, 0]]);
equal('sin movimientos en el rango, los meses salen en cero', R.monthBalance([], { from: '2026-01-01', to: '2026-03-15' }).months.map((m) => [m.key, m.balance]), [['2026-01', 0], ['2026-02', 0], ['2026-03', 0]]);
equal('sin rango ni movimientos no hay filas', R.monthBalance([], {}).months, []);
equal('un rango al reves no da filas', R.monthBalance(txs, { from: '2026-05-01', to: '2026-01-01', dayKey: gtDay }).months, []);
equal('los centavos se suman sin errores de redondeo', R.monthBalance([0.1, 0.2, 0.3].map((a, i) => tx('c' + i, 'income', '2026-06-01T15:00:00.000Z', a)), {}).total.income, 0.6);
equal('montos escritos como texto tambien cuentan', R.monthBalance([tx('t', 'income', '2026-06-01T15:00:00.000Z', '125.25')], {}).total.income, 125.25);
const longAgo = R.monthBalance([tx('a', 'income', '2026-06-01T15:00:00.000Z', 10)], { from: '1900-01-01', to: '2026-06-30' });
equal('una fecha Desde mal escrita (1900) no llena la tabla: arranca en el primer mes con movimientos', [longAgo.months.length, longAgo.months[0].key], [1, '2026-06']);
equal('dos anos completos son 24 filas', R.monthBalance([], { from: '2025-01-01', to: '2026-12-31' }).months.length, 24);

// Las tres graficas del tablero (pedido del usuario, 2026-11-18): Ingresos, Gastos y Saldo del mes de 3 meses
console.log('\nTablero: ingresos, gastos y saldo de 3 meses (cashMonths)');
{
    const w = R.cashMonths(txs, { end: '2026-03', count: 3, dayKey: gtDay });
    equal('los 3 meses que terminan en el elegido, en orden y con su nombre corto', w.months.map((m) => [m.key, m.label]), [['2026-01', 'Ene 2026'], ['2026-02', 'Feb 2026'], ['2026-03', 'Mar 2026']]);
    equal('ingresos = pagos, gastos = egresos y saldo = ingresos menos gastos; los cargos y lo anulado no cuentan', w.months.map((m) => [m.income, m.expense, m.balance]), [[750.5, 120, 630.5], [0, 0, 0], [300, 1000, -700]]);
    equal('el total de los 3 meses', w.total, { income: 1050.5, expense: 1120, balance: -69.5 });
    equal('el primer y el ultimo mes con pagos o gastos (hasta donde se puede navegar)', [w.first, w.last, w.hasCash], ['2025-12', '2026-03', true]);
    const report = R.monthBalance(txs, { from: '2026-01-01', to: '2026-03-31', dayKey: gtDay });
    equal('dice lo mismo que el reporte "Ingresos, egresos y saldo por mes"', w.months.map((m) => [m.key, m.income, m.expense, m.balance]), report.months.map((m) => [m.key, m.income, m.expense, m.balance]));
    equal('un mes atras tambien cruza el cambio de ano', R.cashMonths(txs, { end: '2026-02', dayKey: gtDay }).months.map((m) => [m.key, m.income]), [['2025-12', 200], ['2026-01', 750.5], ['2026-02', 0]]);
    equal('sin pagos ni gastos en la ventana: todo en cero y hasCash falso', (() => { const z = R.cashMonths(txs, { end: '2026-07', dayKey: gtDay }); return [z.months.map((m) => m.key), z.total, z.hasCash, z.last]; })(), [['2026-05', '2026-06', '2026-07'], { income: 0, expense: 0, balance: 0 }, false, '2026-03']);
    equal('un condominio solo con cuotas y cargos no tiene meses con dinero', (() => { const z = R.cashMonths([tx('c', 'charge', '2026-02-01T15:00:00.000Z', 300)], { end: '2026-03' }); return [z.first, z.last, z.hasCash]; })(), [null, null, false]);
    equal('un gasto del 31 de marzo a las 5 pm de Guatemala cae en marzo (dia local)', R.cashMonths([tx('g', 'expense', '2026-03-31T23:00:00.000Z', 10)], { end: '2026-04', count: 2, dayKey: gtDay }).months.map((m) => [m.key, m.expense]), [['2026-03', 10], ['2026-04', 0]]);
    equal('un descuento de mora no es dinero', R.cashMonths([tx('d', 'mora_discount', '2026-03-10T15:00:00.000Z', 50)], { end: '2026-03', count: 1 }).months[0].income, 0);
    equal('la cantidad de meses va de 1 a 24 (3 por defecto)', [R.cashMonths([], { end: '2026-03' }).months.length, R.cashMonths([], { end: '2026-03', count: 99 }).months.length, R.cashMonths([], { end: '2026-03', count: -5 }).months.length], [3, 24, 1]);
    equal('sin un mes final valido no hay meses', R.cashMonths(txs, { end: '2026-13' }).months, []);
    equal('los centavos se suman sin errores de redondeo', R.cashMonths([0.1, 0.2, 0.3].map((a, i) => tx('c' + i, 'income', '2026-06-01T15:00:00.000Z', a)), { end: '2026-06', count: 1 }).total.income, 0.6);
}

console.log('\nCuotas y cargos emitidos y por cobrar (aparte de la caja)');
const fee = (id, resiId, date, amount) => tx(id, 'charge', date, amount, { resiId, kind: 'fee' });
const pay = (id, resiId, date, amount) => tx(id, 'income', date, amount, { resiId });
// Un condominio como La Perla al cargarlo: solo cuotas y cargos, ningun pago ni gasto
const onlyCharges = [
    fee('a1', 'a', '2026-08-01T15:00:00.000Z', 300), fee('a2', 'a', '2026-09-01T15:00:00.000Z', 300),
    fee('b1', 'b', '2026-09-01T15:00:00.000Z', 460), tx('m1', 'charge', '2026-09-15T15:00:00.000Z', 25.5, { resiId: 'b', moraFixed: true }),
    fee('c1', 'c', '2026-12-01T15:00:00.000Z', 380)
];
const perla = R.monthBalance(onlyCharges, { from: '2026-08-01', to: '2026-11-15', dayKey: gtDay });
equal('solo cargos: la caja en cero y los cargos emitidos de cada mes', perla.months.map((m) => [m.key, m.income, m.expense, m.balance, m.charges]), [['2026-08', 0, 0, 0, 300], ['2026-09', 0, 0, 0, 785.5], ['2026-10', 0, 0, 0, 0], ['2026-11', 0, 0, 0, 0]]);
equal('por cobrar crece con cada cargo y se arrastra a los meses siguientes', perla.months.map((m) => m.receivable), [300, 1085.5, 1085.5, 1085.5]);
equal('un cargo fechado despues del cierre (diciembre) no cuenta todavia', [perla.total.receivable, perla.total.charges], [1085.5, 1085.5]);
const paid = [...onlyCharges, pay('p1', 'a', '2026-10-05T15:00:00.000Z', 300), pay('p2', 'b', '2026-10-06T15:00:00.000Z', 1000)];
const withPays = R.monthBalance(paid, { from: '2026-08-01', to: '2026-10-31', dayKey: gtDay });
equal('los pagos bajan lo que se debe; quien pago de mas cuenta cero (no resta lo que deben otros)', withPays.months.map((m) => [m.key, m.income, m.receivable]), [['2026-08', 0, 300], ['2026-09', 0, 1085.5], ['2026-10', 1300, 300]]);
equal('el total del ano lleva lo que se debe al cierre del ano, no la suma de los meses', [withPays.years[0].receivable, withPays.years[0].charges], [300, 1085.5]);
const beforeRange = R.monthBalance(paid, { from: '2026-10-01', to: '2026-10-31', dayKey: gtDay });
equal('por cobrar cuenta tambien lo que venia de antes del rango', [beforeRange.months[0].charges, beforeRange.months[0].receivable], [0, 300]);
equal('con los vecinos vigentes, lo de un vecino que ya no esta no cuenta (como en Morosos)', R.monthBalance(onlyCharges, { from: '2026-09-01', to: '2026-09-30', dayKey: gtDay, residents: ['a'] }).months[0].receivable, 600);
equal('un pago sin vecino (otro ingreso) entra en la caja pero no baja lo que se debe', (() => { const m = R.monthBalance([...onlyCharges, tx('o', 'income', '2026-09-20T15:00:00.000Z', 50)], { from: '2026-09-01', to: '2026-09-30', dayKey: gtDay }).months[0]; return [m.income, m.receivable]; })(), [50, 1085.5]);
equal('lo anulado no cuenta ni en cargos ni en por cobrar', R.monthBalance([...onlyCharges, { ...fee('x', 'a', '2026-09-02T15:00:00.000Z', 999), deleted: true }], { from: '2026-09-01', to: '2026-09-30', dayKey: gtDay }).months[0].receivable, 1085.5);

// Saldo a favor inicial de una carga de saldos (La Perla, 2026-11-20): es un pago del residente pero no entro a la caja
console.log('\nSaldo a favor inicial (no es dinero de la caja)');
{
    const opening = tx('sf', 'income', '2026-11-09T18:00:00.000Z', 600, { resiId: 'a', openingCredit: true });
    const withOpening = [...onlyCharges, opening, pay('p9', 'b', '2026-11-10T15:00:00.000Z', 100)];
    const mb = R.monthBalance(withOpening, { from: '2026-11-01', to: '2026-11-30', dayKey: gtDay });
    equal('no entra en los ingresos del mes (solo el pago de verdad)', [mb.months[0].income, mb.total.balance], [100, 100]);
    equal('pero si baja lo que se debe (por cobrar)', mb.months[0].receivable, 1085.5 - 600 - 100);
    const cm = R.cashMonths([opening], { end: '2026-11', count: 3, dayKey: gtDay });
    equal('el tablero no lo cuenta ni lo toma como mes con dinero', [cm.total.income, cm.first, cm.hasCash], [0, null, false]);
    equal('la ventana del reporte financiero tampoco', R.periodSummary([opening], { from: '2026-11-01', to: '2026-11-30', dayKey: gtDay }).income, 0);
    // Un ajuste de saldo que baja lo que debe (Actualizar saldo, 2026-11-27) tampoco es dinero, pero si baja lo que se debe
    const adjust = tx('aj', 'income', '2026-11-09T18:00:00.000Z', 600, { resiId: 'a', saldoAjuste: true });
    const mbAdj = R.monthBalance([...onlyCharges, adjust, pay('p9', 'b', '2026-11-10T15:00:00.000Z', 100)], { from: '2026-11-01', to: '2026-11-30', dayKey: gtDay });
    equal('un ajuste de saldo que baja lo que debe no entra en los ingresos del mes pero si baja lo que se debe', [mbAdj.months[0].income, mbAdj.months[0].receivable, R.cashMonths([adjust], { end: '2026-11', count: 3, dayKey: gtDay }).total.income], [100, 1085.5 - 600 - 100, 0]);
    yes('el modulo dice que es un saldo a favor inicial', R.isOpeningCredit(opening) && !R.isOpeningCredit(pay('p', 'a', '2026-11-09T18:00:00.000Z', 1)) && !R.isOpeningCredit({ type: 'charge', openingCredit: true }));
    const oikos = read('finanzas/index.html');
    yes('OIKOS no lo cuenta como dinero (Contabilidad, caja, tablero, exportar y reportes de dinero usan isCashTx)', /function isCashTx\(t\) \{ return !!t && \(t\.type === 'income' \|\| t\.type === 'expense'\) && !isNonCashCredit\(t\); \}/.test(oikos) && /function isNonCashCredit\(t\) \{ return isOpeningCredit\(t\) \|\|/.test(oikos) && /if \(!isCashTx\(t\)\) return; if \(t\.type === 'income'\) inc \+=/.test(oikos) && /if \(t\.type !== 'income' \|\| isNonCashCredit\(t\)\) return false;/.test(oikos));
    // En el estado de cuenta es un Pago (suma, con su concepto "Saldo a favor al ..."): el signo de cada fila depende de tipo 'Pago'
    yes('el detalle lo llama "Saldo a favor inicial" y no dice que se le cambio la fecha', /: isOpeningCredit\(tx\) \? 'Saldo a favor inicial'/.test(oikos) && oikos.includes('tx-opening-note') && /return tx && tx\.type === 'income' && !isNonCashCredit\(tx\)/.test(oikos) && /if \(t\.type === 'income'\) \{ tipo = 'Pago'; monto = amt;/.test(oikos));
}

console.log('\nUn periodo (ventana del reporte financiero)');
equal('septiembre solo con cargos: caja en cero, cargos emitidos y por cobrar al cierre', R.periodSummary(onlyCharges, { from: '2026-09-01', to: '2026-09-31', dayKey: gtDay }), { income: 0, expense: 0, balance: 0, charges: 785.5, receivable: 1085.5 });
equal('octubre con pagos', R.periodSummary(paid, { from: '2026-10-01', to: '2026-10-31', dayKey: gtDay }), { income: 1300, expense: 0, balance: 1300, charges: 0, receivable: 300 });
equal('un periodo al reves no suma nada', R.periodSummary(paid, { from: '2026-10-31', to: '2026-10-01', dayKey: gtDay }).charges, 0);
equal('sin fin de periodo, por cobrar es con todo lo registrado', R.periodSummary(onlyCharges, { dayKey: gtDay }).receivable, 1465.5);

console.log('\nMontos y textos');
equal('lee montos con el formato de OIKOS', ['Q1,234.50', 'Q-50.00', '$0.00', 'Q300.00', '12', '—', '', 'Lote 5'].map(R.moneyValue), [1234.5, -50, 0, 300, 12, null, null, null]);
equal('quita el HTML de una celda (el boton del No. de documento)', R.plain('<button type="button" onclick="openTxDetail(\'a\')">R-0012</button>'), 'R-0012');
equal('devuelve los signos escapados', R.plain('Pago &amp; mora &lt;enero&gt;'), 'Pago & mora <enero>');

console.log('\nExcel y WhatsApp');
const report = {
    title: 'Ingresos, egresos y saldo por mes',
    summary: '2026-01-01 → 2026-03-31 · saldo = ingresos menos egresos',
    headers: ['Mes', 'Ingresos', 'Egresos', 'Saldo'],
    rows: [['Enero 2026', 'Q750.50', 'Q120.00', 'Q630.50'], ['Febrero 2026', 'Q0.00', 'Q0.00', 'Q0.00'], ['Total 2026', 'Q750.50', 'Q120.00', 'Q630.50']],
    rowsMeta: [null, null, { kind: 'subtotal' }],
    totals: ['TOTAL', 'Q750.50', 'Q120.00', 'Q630.50'],
    numericCols: [1, 2, 3]
};
const at = new Date(2026, 10, 15, 10, 30);
const excelModel = R.exportModel(report, { condoName: 'Residenciales La Perla', at, excel: true });
equal('nombre del archivo con el reporte, el condominio y el dia', excelModel.fileName, 'ingresos-egresos-y-saldo-por-mes-residenciales-la-perla-2026-11-15');
equal('para Excel los montos pasan a numero y el total de cada ano va en negrita', excelModel.tables[0].rows, [['Enero 2026', 750.5, 120, 630.5], ['Febrero 2026', 0, 0, 0], [{ v: 'Total 2026', s: 1 }, { v: 750.5, s: 1 }, { v: 120, s: 1 }, { v: 630.5, s: 1 }], [{ v: 'TOTAL', s: 1 }, { v: 750.5, s: 1 }, { v: 120, s: 1 }, { v: 630.5, s: 1 }]]);
equal('los totales van tambien arriba como cifras de resumen', excelModel.kpis, [{ label: 'Total ingresos', value: 750.5 }, { label: 'Total egresos', value: 120 }, { label: 'Total saldo', value: 630.5 }]);

const book = readXlsx(Buffer.from(X.buildXlsx(excelModel)));
const sheet = book.sheets[0];
const cellsOf = (row) => Object.keys(row.cells).sort((a, b) => a - b).map((c) => [row.cells[c].t === 'n' ? Number(row.cells[c].v) : row.cells[c].v]);
const header = sheet.rows.find((r) => r.cells[0] && r.cells[0].v === 'Mes');
const january = sheet.rows.find((r) => r.cells[0] && r.cells[0].v === 'Enero 2026');
equal('el .xlsx se abre y trae el titulo', sheet.rows[0].cells[0].v, 'Ingresos, egresos y saldo por mes');
equal('el .xlsx trae los encabezados', header ? cellsOf(header).flat() : null, ['Mes', 'Ingresos', 'Egresos', 'Saldo']);
equal('en el .xlsx los montos son numeros que Excel puede sumar', january ? Object.values(january.cells).map((c) => c.t) : null, ['inlineStr', 'n', 'n', 'n']);
equal('en el .xlsx el saldo de enero vale 630.5', january ? Number(january.cells[3].v) : null, 630.5);

const waModel = R.exportModel(report, { condoName: 'Residenciales La Perla', at });
const wa = X.whatsappText(waModel);
equal('para WhatsApp los montos quedan con su formato', waModel.tables[0].rows[0], ['Enero 2026', 'Q750.50', 'Q120.00', 'Q630.50']);
equal('el mensaje de WhatsApp trae el condominio, el titulo, los totales y las filas', [wa.includes('*Residenciales La Perla*'), wa.includes('*Ingresos, egresos y saldo por mes*'), wa.includes('- Total saldo: *Q630.50*'), wa.includes('Enero 2026 · Q750.50 · Q120.00 · Q630.50')], [true, true, true, true]);
const many = { ...report, rows: Array.from({ length: 40 }, (_, i) => [`Fila ${i + 1}`, 'Q1.00', 'Q0.00', 'Q1.00']), rowsMeta: [] };
const waMany = X.whatsappText(R.exportModel(many, { condoName: 'X', at }));
equal('con muchas filas, WhatsApp lleva las primeras y avisa del resto; los totales siempre van', [waMany.includes('Fila 12 ·'), waMany.includes('Fila 13 ·'), waMany.includes('28 fila(s) más'), waMany.includes('- Total saldo: *Q630.50*')], [true, false, true, true]);
const html = { headers: ['No. Documento', 'Monto'], rows: [['<button onclick="openTxDetail(\'a\')">R-1</button>', 'Q5.00']], totals: null, numericCols: [1], title: 'Libro' };
equal('una celda con HTML llega al Excel como texto limpio', R.exportModel(html, { excel: true }).tables[0].rows[0], ['R-1', 5]);
equal('sin totales no hay cifras de resumen', R.exportModel(html, {}).kpis, []);
// Las cifras grandes de un reporte (lo que deben, la mora...) van primero como indicadores; con kpisFromTotals false, solo ellas
const owedReport = { ...report, highlights: [{ tone: 'owed', value: '3', label: 'residentes deben' }, { tone: 'owed', value: 'Q40,201.66', label: 'cuotas y cargos pendientes' }, { tone: 'mora', value: 'Q121,452.24', label: 'mora a hoy' }, { tone: 'total', value: 'Q161,653.90', label: 'total que deben (cuotas + mora)' }] };
equal('las cifras grandes van como indicadores (numeros en el Excel) antes de los totales', R.exportModel(owedReport, { excel: true }).kpis.slice(0, 5), [{ label: 'Residentes deben', value: 3 }, { label: 'Cuotas y cargos pendientes', value: 40201.66 }, { label: 'Mora a hoy', value: 121452.24 }, { label: 'Total que deben (cuotas + mora)', value: 161653.9 }, { label: 'Total ingresos', value: 750.5 }]);
equal('con kpisFromTotals false solo van las cifras grandes', R.exportModel({ ...owedReport, kpisFromTotals: false }, {}).kpis.map((k) => k.value), ['3', 'Q40,201.66', 'Q121,452.24', 'Q161,653.90']);
equal('WhatsApp trae lo que deben con la mora', X.whatsappText(R.exportModel({ ...owedReport, kpisFromTotals: false }, { condoName: 'X', at })).includes('- Total que deben (cuotas + mora): *Q161,653.90*'), true);
equal('el aviso del reporte va al Excel y a WhatsApp junto al resumen', R.exportModel({ ...report, notice: 'No hay pagos ni gastos registrados en este período.' }, { at }).subtitle, '2026-01-01 → 2026-03-31 · saldo = ingresos menos egresos · No hay pagos ni gastos registrados en este período.');

console.log('\nTabla general (mapa de pagos por residente)');
const mfee = (id, resiId, period, amount) => ({ id, type: 'charge', kind: 'fee', period, resiId, amount, date: `${period}-01T15:00:00.000Z` });
const mpay = (id, resiId, date, amount) => ({ id, type: 'income', resiId, amount, date });
// Vence el ultimo dia del mes mas 5 dias (como La Perla)
const due = (period) => { const [y, m] = period.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)); last.setUTCDate(last.getUTCDate() + 5); return last.toISOString().slice(0, 10); };
const people = [{ id: 'a', unit: 'A001', name: 'Uno' }, { id: 'b', unit: 'A002', name: 'Dos' }, { id: 'c', unit: 'A003', name: 'Tres' }, { id: 'd', unit: 'A004', name: 'Cuatro' }, { id: 'e', unit: 'A005', name: 'Cinco' }];
const mapTxs = [
    // a: debe desde 2024 (no pago nada): 2024-11, 2024-12, 2025-01 ... 2026-11
    ...['2024-11', '2024-12', '2025-01', '2025-02', '2026-01', '2026-10', '2026-11'].map((p, i) => mfee('a' + i, 'a', p, 300)),
    // b: pago todo
    ...['2025-06', '2026-01', '2026-02'].map((p, i) => mfee('b' + i, 'b', p, 300)), mpay('bp', 'b', '2026-02-10T15:00:00.000Z', 900),
    // c: pago lo viejo; debe octubre (vencido) y noviembre (aun no vence)
    ...['2026-09', '2026-10', '2026-11'].map((p, i) => mfee('c' + i, 'c', p, 300)), mpay('cp', 'c', '2026-09-20T15:00:00.000Z', 300),
    // d: solo debe noviembre (aun no vence) y pago parte de octubre: octubre en rojo por Q100
    ...['2026-10', '2026-11'].map((p, i) => mfee('d' + i, 'd', p, 300)), mpay('dp', 'd', '2026-10-20T15:00:00.000Z', 200),
    // e: sin cuotas; un cargo suelto de mora fija en septiembre, pagado
    { id: 'e1', type: 'charge', resiId: 'e', amount: 45.5, concept: 'Mora', date: '2026-09-15T15:00:00.000Z' }, mpay('ep', 'e', '2026-09-20T15:00:00.000Z', 45.5),
    // una cuota de diciembre (aun no llega) no se muestra
    mfee('a-dic', 'a', '2026-12', 300)
];
const pm = R.paymentMap(people, mapTxs, { today: '2026-11-15', dayKey: gtDay, dueOf: due });
equal('columnas: los anos anteriores y los meses del ano en curso hasta hoy', pm.columns.map((c) => c.label), ['Año 2024', 'Año 2025', 'Ene 2026', 'Feb 2026', 'Mar 2026', 'Abr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Ago 2026', 'Sep 2026', 'Oct 2026', 'Nov 2026']);
const rowOf = (id) => pm.rows.find((r) => r.resident.id === id);
const statusOf = (id, keys) => keys.map((k) => rowOf(id).cells[k].status);
equal('quien no pago: rojo en sus anos y meses vencidos; noviembre aun no vence (amarillo); sin cuota, gris', statusOf('a', ['2024', '2025', '2026-01', '2026-02', '2026-10', '2026-11']), ['owed', 'owed', 'owed', 'none', 'owed', 'pending']);
equal('quien pago todo: verde', statusOf('b', ['2025', '2026-01', '2026-02', '2026-03']), ['paid', 'paid', 'paid', 'none']);
equal('los pagos cubren primero lo mas antiguo', statusOf('c', ['2026-09', '2026-10', '2026-11']), ['paid', 'owed', 'pending']);
equal('un pago parcial deja el mes en rojo por lo que falta', [rowOf('d').cells['2026-10'].status, rowOf('d').cells['2026-10'].owed], ['owed', 100]);
equal('un cargo suelto cuenta en el mes de su fecha', rowOf('e').cells['2026-09'].status, 'paid');
equal('meses en mora, desde cuando y cuanto (sin lo que aun no vence ni lo de diciembre)', ['a', 'c', 'd'].map((id) => [rowOf(id).lateMonths, rowOf(id).sinceLabel, rowOf(id).lateTotal]), [[6, 'Nov 2024', 1800], [1, 'Oct 2026', 300], [1, 'Oct 2026', 100]]);
equal('orden: mas meses en mora arriba; a igual, el que mas debe; al final los que estan al dia', pm.rows.map((r) => r.resident.id), ['a', 'c', 'd', 'b', 'e']);
equal('conteo: en mora, por vencer y al dia', [pm.late, pm.pending, pm.upToDate], [3, 0, 2]);
equal('total en mora por columna', [pm.totals['2024'], pm.totals['2025'], pm.totals['2026-10'], pm.totals['2026-11']], [600, 600, 700, 0]);
const solo = R.paymentMap([{ id: 'x' }], [mfee('x1', 'x', '2026-11', 300)], { today: '2026-11-15', dayKey: gtDay, dueOf: due });
equal('quien solo debe lo que aun no vence no esta en mora', [solo.late, solo.pending, solo.rows[0].lateMonths], [0, 1, 0]);
const old = R.paymentMap([{ id: 'x' }], [mfee('x1', 'x', '2012-03', 300)], { today: '2026-11-15', dayKey: gtDay, dueOf: due, maxYears: 6 });
equal('con muchos anos, los mas viejos se juntan en una columna', old.columns.slice(0, 2).map((c) => c.label), ['Antes de 2020', 'Año 2020']);
equal('y lo de esos anos se ve ahi', old.rows[0].cells.older.status, 'owed');
equal('un residente sin movimientos sale al dia y en gris', R.paymentMap([{ id: 'z' }], [], { today: '2026-11-15', dueOf: due }).rows[0].cells['2026-11'].status, 'none');

// Orden por el total con mora (el saldo de Residentes) y meses dados por pagados (carga inicial desde una cartera)
const withMora = R.paymentMap(people, mapTxs, { today: '2026-11-15', dayKey: gtDay, dueOf: due, totalOf: (r) => ({ a: 2400, c: 9000, d: 400 })[r.id] || 0, moraOf: (r) => (r.id === 'c' ? 8400 : 0) });
equal('arriba el que mas debe con la mora del dia, aunque lleve menos meses en mora', withMora.rows.map((r) => r.resident.id), ['c', 'a', 'd', 'b', 'e']);
equal('cada fila trae su total con mora y su mora a hoy', [withMora.rows[0].totalOwed, withMora.rows[0].mora, withMora.rows[1].mora], [9000, 8400, 0]);
equal('sin total con mora, el total es lo vencido mas lo por vencer (tambien lo de meses que aun no llegan)', R.paymentMap(people, mapTxs, { today: '2026-11-15', dayKey: gtDay, dueOf: due }).rows[0].totalOwed, 2400);
const loaded = [{ id: 'p', unit: 'A001', name: 'Pagado todo' }, { id: 'q', unit: 'A002', name: 'Debe desde junio' }, { id: 'n', unit: 'A003', name: 'Nuevo' }];
const cartera = [mfee('q6', 'q', '2026-06', 300), mfee('q7', 'q', '2026-07', 300), mfee('n1', 'n', '2026-11', 300)];
const fromBefore = { p: '2026-11', q: '2026-08', n: null };
const pmLoad = R.paymentMap(loaded, [...cartera, mfee('old', 'q', '2024-03', 300), mpay('qp', 'q', '2026-01-10T15:00:00.000Z', 300)], { today: '2026-11-15', dayKey: gtDay, dueOf: due, paidBefore: (r) => fromBefore[r.id] });
const rowL = (id) => pmLoad.rows.find((r) => r.resident.id === id);
equal('de la carga inicial: los meses antes de "cobrar desde" sin cuota salen pagados (verde)', ['2024', '2025', '2026-01', '2026-10'].map((k) => rowL('p').cells[k].status), ['paid', 'paid', 'paid', 'paid']);
equal('desde "cobrar desde" sin cuota, gris', rowL('p').cells['2026-11'].status, 'none');
equal('lo que si debe sigue en rojo; antes y entre las deudas, verde', ['2024', '2026-05', '2026-06', '2026-07'].map((k) => rowL('q').cells[k].status), ['paid', 'paid', 'owed', 'owed']);
equal('se marca que el verde salio de la cartera (no de un pago registrado)', [rowL('p').cells['2026-10'].assumed, rowL('q').cells['2024'].assumed, pmLoad.assumedPaid], [true, false, true]);
equal('un residente que entro despues: antes de entrar, gris (no se da por pagado)', ['2025', '2026-10'].map((k) => rowL('n').cells[k].status), ['none', 'none']);

// Una linea por vecino (La Perla, 2026-11-20): meses adelantados con el saldo a favor, la mora de cada mes y el orden por lote
console.log('\nTabla general: una linea por vecino');
{
    const vecinos = [{ id: 'f', unit: 'BA001', name: 'Adelantado' }, { id: 'g', unit: 'B053', name: 'Con mora' }, { id: 'h', unit: 'A010', name: 'Sin nada' }];
    const movs = [mfee('f1', 'f', '2026-11', 300), mpay('fp', 'f', '2026-11-09T18:00:00.000Z', 1250), mfee('g1', 'g', '2025-09', 200), mfee('g2', 'g', '2026-10', 300)];
    const cov = { f: R.creditCoverage(950, 300, '2026-12') };
    const moraBy = { g: new Map([['2025-09', 81], ['2026-10', 2.7]]) };
    const map = R.paymentMap(vecinos, movs, { today: '2026-11-20', dayKey: gtDay, dueOf: due, coverageOf: (r) => cov[r.id] || null, moraByPeriodOf: (r) => moraBy[r.id] || null });
    const keys = map.columns.map((c) => c.label);
    equal('despues de hoy solo salen los meses que alguien adelanto: diciembre y el ano siguiente junto', keys.slice(-3), ['Nov 2026', 'Dic 2026', 'Año 2027']);
    const f = map.rows.find((r) => r.resident.id === 'f');
    equal('noviembre pagado con el saldo a favor; diciembre "adelantado" en verde', [f.cells['2026-11'].status, f.cells['2026-12'].status, f.cells['2026-12'].advance], ['paid', 'paid', true]);
    equal('en el ano siguiente dice cuantos meses enteros cubre y cuanto en total', [f.cells['ahead-2027'].status, f.cells['ahead-2027'].advanceMonths, f.cells['ahead-2027'].advanceAmount], ['paid', 2, 650]);
    equal('la fila trae el saldo a favor y hasta cuando cubre', [f.credit, f.paidUntil], [950, 'hasta Feb 2027']);
    const g = map.rows.find((r) => r.resident.id === 'g');
    equal('cada celda trae la mora de las cuotas de ese periodo', [g.cells['2025'].mora, g.cells['2026-10'].mora, g.cells['2026-11'].mora], [81, 2.7, 0]);
    equal('y la columna suma la mora de todos', [map.moraTotals['2025'], map.moraTotals['2026-10']], [81, 2.7]);
    equal('quien no adelanto nada: en blanco despues de hoy', map.rows.find((r) => r.resident.id === 'h').cells['2026-12'].status, 'none');
    equal('sin saldos a favor no hay columnas despues de hoy', R.paymentMap(vecinos, movs.slice(2), { today: '2026-11-20', dayKey: gtDay, dueOf: due }).columns.slice(-1)[0].label, 'Nov 2026');
    equal('orden por lote, como la hoja (B antes que BA)', R.paymentMap(vecinos, movs, { today: '2026-11-20', dayKey: gtDay, dueOf: due, order: 'unit' }).rows.map((r) => r.resident.unit), ['A010', 'B053', 'BA001']);
    equal('orden por nombre', R.paymentMap(vecinos, movs, { today: '2026-11-20', dayKey: gtDay, dueOf: due, order: 'name' }).rows.map((r) => r.resident.name), ['Adelantado', 'Con mora', 'Sin nada']);
    const nov = R.paymentMap([{ id: 'k', unit: 'C1' }], [mpay('kp', 'k', '2026-11-09T18:00:00.000Z', 600)], { today: '2026-11-20', dayKey: gtDay, dueOf: due, coverageOf: () => R.creditCoverage(600, 300, '2026-11') });
    equal('un mes ya llegado sin cuota que el saldo a favor cubre sale pagado', [nov.rows[0].cells['2026-11'].status, nov.rows[0].cells['2026-11'].advance, nov.rows[0].cells['2026-12'].status], ['paid', true, 'paid']);
}

console.log('\nTabla general en Excel y WhatsApp');
const mapReport = {
    title: 'Tabla general', summary: '1 en mora', headers: ['Residente', 'Oct 2026', 'Nov 2026', 'Meses en mora', 'En mora desde', 'Total en mora'],
    rows: [['A001 · Uno', 'Q300.00', 'Q300.00', '1', 'Oct 2026', 'Q300.00'], ['A002 · Dos', 'Pagado', '—', '0', '—', 'Q0.00']],
    cellStatus: [[null, 'owed', 'pending'], [null, 'paid', 'none']],
    totals: ['TOTAL EN MORA', 'Q300.00', '', '1', '', 'Q300.00'], numericCols: [3, 5],
    compact: { headers: ['Residente', 'Meses en mora', 'En mora desde', 'Total en mora'], rows: [['A001 · Uno', '1', 'Oct 2026', 'Q300.00']], totals: ['TOTAL', '1', '', 'Q300.00'], numericCols: [1, 3] }
};
const mapExcel = R.exportModel(mapReport, { at, excel: true });
equal('en Excel las celdas van con su color (rojo y verde); la cuota en su plazo y lo gris, sin color', [mapExcel.tables[0].rows[0][1], mapExcel.tables[0].rows[0][2], mapExcel.tables[0].rows[1][1], mapExcel.tables[0].rows[1][2]], [{ v: 'Q300.00', s: 4 }, 'Q300.00', { v: 'Pagado', s: 5 }, '—']);
const mapBook = readXlsx(Buffer.from(X.buildXlsx(mapExcel)));
const mapRow = mapBook.sheets[0].rows.find((r) => r.cells[0] && r.cells[0].v === 'A001 · Uno');
equal('el .xlsx con colores se abre y cada celda guarda su estilo (la cuota en su plazo, ninguno)', mapRow ? [mapRow.cells[1].s, mapRow.cells[2].s] : null, ['4', null]);
const mapWa = R.exportModel(mapReport, { at });
equal('WhatsApp usa la version corta: residente, meses, desde y total', [mapWa.tables[0].headers, mapWa.tables[0].rows[0], mapWa.kpis], [['Residente', 'Meses en mora', 'En mora desde', 'Total en mora'], ['A001 · Uno', '1', 'Oct 2026', 'Q300.00'], [{ label: 'Total meses en mora', value: '1' }, { label: 'Total en mora', value: 'Q300.00' }]]);

console.log('\nEstado de cuenta: lo que debe el residente');
{
    const Mora = require('../finanzas/sisdel-mora.js');
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const at12 = (day) => `${day}T18:00:00.000Z`;
    const feeTx = (period, amount = 300) => ({ id: 'fee_r1_' + period, type: 'charge', kind: 'fee', period, amount, resiId: 'r1', date: at12(`${period}-05`) });
    const settings = { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] };
    // Lo mismo que hace OIKOS (sisdelMoraOf): el estado a hoy con el saldo del libro (todo lo registrado, tambien lo fechado despues)
    const standing = (txs, today) => {
        const state = Mora.stateOf('r1', txs, settings, today);
        const ledger = round2(txs.reduce((sum, t) => sum + (t.type === 'income' ? 1 : -1) * t.amount, 0));
        return Object.assign({}, state, { total: round2(ledger - state.moraDaily), ledger });
    };
    const sum3 = (d) => round2(d.pending + d.mora);

    // Octubre vencida (300, con el cargo de mora del 6 de noviembre: 3 % = Q 9) y noviembre que aun no vence
    const base = [feeTx('2026-10'), feeTx('2026-11')];
    const ms = standing(base, '2026-11-16');
    const debt = R.accountDebt(ms);
    equal('cuotas pendientes + mora = total que debe, con lo vencido y lo que aun no vence', debt, { pending: 600, overdue: 300, upcoming: 300, mora: 9, total: 609, credit: 0 });
    equal('la suma de las tres cifras es exacta', sum3(debt), debt.total);
    equal('el total que debe es el saldo con mora de la lista de Residentes (libro menos la mora calculada)', debt.total, round2(-ms.total));
    const list = R.pendingRows(ms, { label: (item) => R.periodLabel(item.period), total: debt.total });
    equal('la tabla trae una fila por cuota pendiente, con su vencimiento y su mora', list.rows.map((r) => [r.label, r.capital, r.dueDate, r.overdue, r.mora, r.total]), [['Oct 2026', 300, '2026-11-05', true, 9, 309], ['Nov 2026', 300, '2026-12-05', false, 0, 300]]);
    equal('el total de la tabla es el total que debe (sin fila de ajuste)', [list.capital, list.mora, list.total, list.rows.some((r) => r.kind === 'ajuste')], [600, 9, 609, false]);

    // Muchos anos sin pagar (como C070): siempre suma y la tabla cuadra con el total
    const years = [];
    for (let y = 2008; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 11) break; years.push(feeTx(`${y}-${String(m).padStart(2, '0')}`)); }
    const big = standing(years, '2026-11-16');
    const bigDebt = R.accountDebt(big);
    const bigList = R.pendingRows(big, { total: bigDebt.total });
    equal('con 227 cuotas sin pagar: pendiente = lo cargado, y pendiente + mora = total', [bigDebt.pending, sum3(bigDebt) === bigDebt.total, bigDebt.upcoming], [227 * 300, true, 300]);
    equal('con 227 cuotas sin pagar la tabla tiene 227 filas y suma el total que debe', [bigList.rows.length, bigList.total === bigDebt.total, round2(bigList.rows.reduce((s, r) => s + r.total, 0)) === bigDebt.total], [227, true, true]);
    equal('lo vencido + lo que no vence es lo pendiente', round2(bigDebt.overdue + bigDebt.upcoming), bigDebt.pending);

    // Pago que cubre las cuotas y parte de la mora: lo pendiente nunca sale negativo y todo suma
    const partial = standing([feeTx('2026-01'), feeTx('2026-02'), { id: 'p1', type: 'income', amount: 700, resiId: 'r1', date: at12('2026-11-16') }], '2026-11-16');
    const partialDebt = R.accountDebt(partial);
    equal('con parte de la mora pagada: no debe cuotas, solo mora, y suma', [partialDebt.pending, partialDebt.overdue, partialDebt.mora === partialDebt.total, partialDebt.total > 0, sum3(partialDebt) === partialDebt.total], [0, 0, true, true, true]);

    // Un cargo fechado despues de hoy no esta en el estado de mora pero si en el libro: una fila de ajuste cierra la diferencia
    const future = standing([feeTx('2026-10'), { id: 'f1', type: 'charge', kind: 'extra', amount: 120, resiId: 'r1', date: at12('2026-12-20'), concept: 'Cargo futuro' }], '2026-11-16');
    const futureDebt = R.accountDebt(future);
    const futureList = R.pendingRows(future, { total: futureDebt.total, adjustLabel: 'Fechados despues de hoy' });
    const adjust = futureList.rows.find((r) => r.kind === 'ajuste');
    equal('un cargo fechado despues de hoy cuenta en el total y la tabla lo muestra como ajuste', [futureDebt.pending, futureDebt.total, adjust && adjust.label, adjust && adjust.capital, futureList.total], [420, 429, 'Fechados despues de hoy', 120, 429]);

    // El mismo total que la regla de la lista de Residentes y de los reportes (sisdelOwedOf de OIKOS, en centavos):
    // pendiente = max(0, -libro); mora = max(0, mora calculada - max(0, libro)); total = pendiente + mora
    const owedOf = (m) => { const pend = Math.max(0, -Math.round(m.ledger * 100)); const mor = Math.max(0, Math.round(m.moraDaily * 100) - Math.max(0, Math.round(m.ledger * 100))); return (pend + mor) / 100; };
    const futureTx = { id: 'f2', type: 'charge', kind: 'extra', amount: 120, resiId: 'r1', date: at12('2026-12-20'), concept: 'Cargo futuro' };
    const scenarios = [ms, big, partial, future, standing([feeTx('2026-10'), { id: 'p2', type: 'income', amount: 1000, resiId: 'r1', date: at12('2026-10-10') }], '2026-11-16'), standing([feeTx('2026-10'), futureTx], '2026-11-16')];
    equal('el total que debe es el de la regla de Residentes y los reportes en todos los casos (rara vez cambia solo como se parte)', scenarios.map((m) => R.accountDebt(m).total), scenarios.map(owedOf));

    // Sin deuda: todo en cero y el saldo a favor aparte
    const credit = standing([feeTx('2026-10'), { id: 'p2', type: 'income', amount: 1000, resiId: 'r1', date: at12('2026-10-10') }], '2026-11-16');
    equal('con saldo a favor no debe nada y se informa el saldo a favor', R.accountDebt(credit), { pending: 0, overdue: 0, upcoming: 0, mora: 0, total: 0, credit: 700 });
    equal('un residente sin movimientos no tiene filas', R.pendingRows(standing([], '2026-11-16'), { total: 0 }).rows, []);
    equal('sin regla de mora no hay cifras (la pantalla usa el saldo de siempre)', [R.accountDebt(null), R.accountDebt(undefined)], [null, null]);

    // ── Vista "Cuotas pendientes" (2026-11-20): tambien sin regla de mora ──
    // Como el vecino 82 de Delco II: deuda de 2025 pagada en enero, enero a mayo pagados, Q100 de junio y nada despues
    const plain = [{ id: 'atr25', type: 'charge', kind: 'extra', amount: 1500, resiId: 'r1', date: at12('2025-12-31'), concept: 'Cuotas atrasadas de 2025' }];
    for (let m = 1; m <= 11; m++) { const p = `2026-${String(m).padStart(2, '0')}`; plain.push(feeTx(p, m < 4 ? 250 : 350)); }
    plain.push({ id: 'p25', type: 'income', amount: 1500, resiId: 'r1', date: at12('2026-01-15') });
    [1, 2, 3, 4, 5].forEach((m) => plain.push({ id: 'pm' + m, type: 'income', amount: m < 4 ? 250 : 350, resiId: 'r1', date: at12(`2026-0${m}-15`) }));
    plain.push({ id: 'pjun', type: 'income', amount: 100, resiId: 'r1', date: at12('2026-06-20') });
    const due35 = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01-05` : `${y}-${String(m + 1).padStart(2, '0')}-05`; };
    const raw = Mora.stateOf('r1', plain, {}, '2026-11-20');
    const dated = R.withDueDates(raw, due35, '2026-11-20');
    const plainLedger = round2(plain.reduce((sum, t) => sum + (t.type === 'income' ? 1 : -1) * t.amount, 0));
    const plainMs = Object.assign({}, dated, { total: plainLedger });
    const plainDebt = R.accountDebt(plainMs);
    const plainList = R.pendingRows(plainMs, { total: plainDebt.total });
    equal('sin regla de mora: lo pendiente es lo que dice el libro, sin mora, con noviembre aun en su plazo', plainDebt, { pending: 2000, overdue: 1650, upcoming: 350, mora: 0, total: 2000, credit: 0 });
    equal('sin regla de mora: una fila por cuota sin pagar (junio con su abono), con el vencimiento del dia 5 del mes siguiente', plainList.rows.map((r) => [r.period, r.amount, r.capital, r.dueDate, r.overdue, r.mora]),
        [['2026-06', 350, 250, '2026-07-05', true, 0], ['2026-07', 350, 350, '2026-08-05', true, 0], ['2026-08', 350, 350, '2026-09-05', true, 0], ['2026-09', 350, 350, '2026-10-05', true, 0], ['2026-10', 350, 350, '2026-11-05', true, 0], ['2026-11', 350, 350, '2026-12-05', false, 0]]);
    const early = Mora.stateOf('r1', [feeTx('2026-10')], {}, '2026-11-03');
    equal('sin el plazo de 35 dias el motor da la cuota por vencida al terminar su mes (por eso withDueDates)', [raw.items.find((i) => i.period === '2026-10').dueDate, early.overdueCapital, R.withDueDates(early, due35, '2026-11-03').overdueCapital], ['2026-10-31', 300, 0]);
    equal('withDueDates no cambia el estado que recibe ni toca los cargos que no son cuota', [raw.items[0].dueDate === dated.items[0].dueDate, raw.items.find((i) => i.period === '2026-11').dueDate], [true, '2026-11-30']);
    equal('el dia 5 todavia es plazo; el 6 ya vencio', [R.withDueDates(Mora.stateOf('r1', [feeTx('2026-10')], {}, '2026-11-05'), due35, '2026-11-05').overdueCapital, R.withDueDates(Mora.stateOf('r1', [feeTx('2026-10')], {}, '2026-11-06'), due35, '2026-11-06').overdueCapital], [0, 300]);
    equal('sin estado no hay nada que fechar', R.withDueDates(null, due35, '2026-11-20'), null);

    // Juntas por ano (WhatsApp): las 227 cuotas de C070 en a lo mas 12 lineas que suman lo mismo
    const byYear = R.pendingByYear(bigList);
    equal('por ano: una linea por ano, del mas antiguo al mas nuevo, con su cuenta', [byYear.length, byYear[0].label, byYear[0].count, byYear[18].label, byYear[18].count], [19, 'Cuotas de 2008 (12)', 12, 'Cuotas de 2026 (11)', 11]);
    const merged = R.pendingByYear(bigList, { max: 11 });
    equal('con max, los anos mas antiguos van juntos y la suma no cambia', [merged.length, merged[0].label, merged[0].count, round2(merged.reduce((s, g) => s + g.total, 0)) === bigList.total], [11, 'Cuotas de 2008 a 2016 (108)', 108, true]);
    const mixed = R.pendingByYear(futureList);
    equal('un cargo sin mes o el ajuste quedan aparte, como venian', mixed.map((g) => [g.kind, g.label, g.total]), [['year', 'Cuota de 2026 (1)', 309], ['ajuste', 'Fechados despues de hoy', 120]]);
    equal('pocas filas: max no junta nada', R.pendingByYear(list, { max: 11 }).length, 1);
}

console.log('\nCopia en el navegador');
// ───────── Listado general de propietarios ─────────
console.log('\nListado general de propietarios');
const own = [
    { id: 'a', name: 'Ana', unit: 'C002', contact: '+50211111111', fase: '1' },
    { id: 'b', name: 'Beto', unit: 'C001', contact: '', fase: '2' },
    { id: 'c', name: 'Carla', unit: 'C003', contact: '+50233333333', fase: '1' },
    { id: 'd', name: 'Dario', unit: 'C004', contact: '+50244444444' }
];
const ownTx = [];
['a', 'b', 'c', 'd'].forEach((id) => ['2026-01', '2026-02', '2026-03'].forEach((m) => ownTx.push({ id: `fee_${id}_${m}`, type: 'charge', kind: 'fee', period: m, resiId: id, amount: 300, date: `${m}-01T12:00:00.000Z` })));
ownTx.push({ id: 'x1', type: 'charge', kind: 'extra', resiId: 'c', amount: 100, date: '2026-02-15T12:00:00.000Z' });
ownTx.push({ id: 'p-a', type: 'income', resiId: 'a', amount: 300, date: '2026-03-10T12:00:00.000Z' });
ownTx.push({ id: 'p-b', type: 'income', resiId: 'b', amount: 900, date: '2026-03-10T12:00:00.000Z' });
ownTx.push({ id: 'p-d', type: 'income', resiId: 'd', amount: 600, date: '2026-03-10T12:00:00.000Z' });
ownTx.push({ id: 'gone', type: 'charge', kind: 'fee', period: '2026-04', resiId: 'a', amount: 999, date: '2026-04-01T12:00:00.000Z', deleted: true });
const owedTable = { a: { pending: 600, mora: 50.5, total: 650.5 }, b: { pending: 0, mora: 0, total: 0 }, c: { pending: 1000, mora: 120, total: 1120 }, d: { pending: 300, mora: 10, total: 310 } };
const owedOf = (r) => owedTable[r.id];
const moraItems = { a: [{ id: 'fee_a_2026-02', period: '2026-02', mora: 20 }, { id: 'fee_a_2026-03', period: '2026-03', mora: 10 }], c: [{ id: 'fee_c_2026-02', period: '2026-02', mora: 40 }, { id: 'x1', period: null, mora: 5 }, { id: 'fee_c_2026-03', period: '2026-03', mora: 0 }] };
const moraItemsOf = (r) => moraItems[r.id] || null;
const view = (o) => R.ownersList(own, ownTx, { owedOf, moraItemsOf, ...o });
const brief = (l) => l.rows.map((x) => [x.name, x.pending, x.mora, x.total]);

const todo = view({});
equal('por defecto muestra a todos, en orden alfabetico, con lo mismo que Residentes (owedOf)', brief(todo), [['Ana', 600, 50.5, 650.5], ['Beto', 0, 0, 0], ['Carla', 1000, 120, 1120], ['Dario', 300, 10, 310]]);
equal('las columnas del listado: lote, nombre y telefono', todo.rows.map((x) => [x.unit, x.name, x.phone]), [['C002', 'Ana', '+50211111111'], ['C001', 'Beto', ''], ['C003', 'Carla', '+50233333333'], ['C004', 'Dario', '+50244444444']]);
equal('totales: cuantos son, cuantos deben y la suma de cada columna (cuotas + mora = total)', todo.totals, { count: 4, owing: 3, pending: 1900, mora: 180.5, total: 2080.5 });
equal('en cada fila y en el total, cuotas + mora = total (centavos exactos)', [todo.rows.every((x) => Math.round(x.pending * 100) + Math.round(x.mora * 100) === Math.round(x.total * 100)), Math.round(todo.totals.pending * 100) + Math.round(todo.totals.mora * 100) === Math.round(todo.totals.total * 100)], [true, true]);
equal('de mayor a menor deuda (a igual deuda, por nombre)', view({ order: 'debt' }).rows.map((x) => x.name), ['Carla', 'Ana', 'Dario', 'Beto']);
equal('solo los que deben', view({ onlyDebt: true }).rows.map((x) => x.name), ['Ana', 'Carla', 'Dario']);
equal('el orden alfabetico no distingue acentos ni mayusculas y ordena los numeros como numeros', R.ownersList([{ id: '1', name: 'Zoila', unit: 'C10' }, { id: '2', name: 'álvaro', unit: 'C2' }, { id: '3', name: 'Alma', unit: 'C9' }, { id: '4', name: 'Alma', unit: 'C10' }], [], { owedOf: () => ({ pending: 0, mora: 0, total: 0 }) }).rows.map((x) => `${x.name} ${x.unit}`), ['Alma C9', 'Alma C10', 'álvaro C2', 'Zoila C10']);
equal('por fase: una fase, sin fase, y las fases que existen', [view({ fase: '1' }).rows.map((x) => x.name), view({ fase: R.NO_FASE }).rows.map((x) => x.name), view({ fase: '2' }).rows.map((x) => x.name), todo.fases, todo.withoutFase], [['Ana', 'Carla'], ['Dario'], ['Beto'], ['1', '2'], 1]);
equal('los totales siguen al filtro de fase', view({ fase: '1' }).totals, { count: 2, owing: 2, pending: 1600, mora: 170.5, total: 1770.5 });
// Por periodo: lo que falta pagar de las cuotas y cargos de esos meses (los pagos cubren primero lo mas antiguo) y su mora
const feb = view({ from: '2026-02', to: '2026-02' });
equal('por periodo (un mes): lo que falta pagar de ese mes y la mora de ese mes', brief(feb), [['Ana', 300, 20, 320], ['Beto', 0, 0, 0], ['Carla', 400, 45, 445], ['Dario', 0, 0, 0]]);
equal('un cargo suelto cae en el mes de su fecha, con su mora (renglon sin periodo)', [feb.rows[2].pending, feb.rows[2].mora], [400, 45]);
equal('por periodo: los totales y byPeriod', [feb.totals, feb.byPeriod, todo.byPeriod], [{ count: 4, owing: 2, pending: 700, mora: 65, total: 765 }, true, false]);
equal('por periodo con solo "desde": de ese mes en adelante', brief(view({ from: '2026-03' })), [['Ana', 300, 10, 310], ['Beto', 0, 0, 0], ['Carla', 300, 0, 300], ['Dario', 300, 0, 300]]);
equal('por periodo con solo "hasta": hasta ese mes', brief(view({ to: '2026-01' })), [['Ana', 0, 0, 0], ['Beto', 0, 0, 0], ['Carla', 300, 0, 300], ['Dario', 0, 0, 0]]);
equal('todos los meses del rango dan lo que se debe de cuotas (mismo reparto que la Tabla general)', brief(view({ from: '2026-01', to: '2026-12' })).map((x) => x[1]), [600, 0, 1000, 300]);
equal('un pago de mas en otro mes cubre lo mas antiguo (no el mes que se mira)', brief(view({ from: '2026-03', to: '2026-03', fase: '1' })).map((x) => [x[0], x[1]]), [['Ana', 300], ['Carla', 300]]);
equal('sin regla de mora (sin renglones) la mora por periodo es cero', R.ownersList(own, ownTx, { owedOf, from: '2026-02', to: '2026-02' }).rows.map((x) => x.mora), [0, 0, 0, 0]);
equal('un mes mal escrito se ignora (sigue el listado general)', brief(view({ from: '2026-13', to: 'x' })), brief(todo));
equal('por periodo y por fase, de mayor a menor deuda', view({ from: '2026-02', to: '2026-02', fase: '1', order: 'debt' }).rows.map((x) => [x.name, x.total]), [['Carla', 445], ['Ana', 320]]);
equal('los centavos se suman sin errores de redondeo', R.ownersList([{ id: 'z', name: 'Zeta', unit: 'C1' }], [], { owedOf: () => ({ pending: 0.1, mora: 0.2, total: 0.3 }) }).totals, { count: 1, owing: 1, pending: 0.1, mora: 0.2, total: 0.3 });
equal('sin residentes o sin datos de deuda, el listado sale vacio o en cero', [R.ownersList([], [], {}).rows, R.ownersList([{ id: 'q', name: 'Q', unit: 'C9' }], [], {}).rows.map((x) => x.total)], [[], [0]]);

// ───────── Listado de vecinos con morosidad (pedido del usuario el 2026-11-20) ─────────
console.log('\nListado de vecinos con morosidad');
const Cuotas = require('../finanzas/sisdel-cuotas.js');
const mlResidents = [
    { id: 'u1', name: 'Uno', unit: 'A002' }, { id: 'u2', name: 'Dos', unit: 'A001' },
    { id: 'u3', name: 'Tres', unit: 'A010' }, { id: 'u4', name: 'Cuatro', unit: 'A003' }
];
const mlTx = [];
const feeTx = (id, m, amount) => mlTx.push({ id: `fee_${id}_${m}`, type: 'charge', kind: 'fee', period: m, resiId: id, amount, date: `${m}-01T18:00:00.000Z` });
['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((m) => { feeTx('u1', m, 300); feeTx('u2', m, 300); });
['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].forEach((m) => feeTx('u3', m, 300));
feeTx('u2', '2026-11', 300);
mlTx.push({ id: 'old', type: 'charge', kind: 'extra', resiId: 'u1', amount: 500, date: '2025-06-10T18:00:00.000Z' });          // un cargo de otro ano, sin pagar
mlTx.push({ id: 'p2', type: 'income', resiId: 'u2', amount: 3300, date: '2026-11-10T18:00:00.000Z' });                          // u2 pago todo
mlTx.push({ id: 'p3', type: 'income', resiId: 'u3', amount: 2400, date: '2026-11-10T18:00:00.000Z' });                          // u3 cubre hasta agosto
const mlMap = R.paymentMap(mlResidents, mlTx, { today: '2026-11-20', dayKey: gtDay, dueOf: (p) => Cuotas.dueKey(p), order: 'unit' });
// OIKOS agrega a cada fila lo vencido (late) y la mora a hoy (owed.mora)
const mlMora = { u4: 5 };
mlMap.rows.forEach((x) => { x.late = x.lateTotal; x.owed = { mora: mlMora[x.resident.id] || 0, pending: x.lateTotal + x.pendingTotal, total: x.lateTotal + (mlMora[x.resident.id] || 0) }; });
const ml = R.moraList(mlMap);
equal('solo salen los vecinos con algo vencido (o mora), en el orden del mapa: A002, A003 (solo mora) y A010', ml.rows.map((x) => x.row.resident.unit), ['A002', 'A003', 'A010']);
equal('las columnas son solo los periodos que alguien debe: el ano anterior y de enero a octubre (noviembre sigue en su plazo)', ml.columns.map((c) => c.key), ['2025', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
equal('lo que debe cada vecino en cada columna (cero si no lo debe)', ml.rows.map((x) => x.amounts), [[500, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 300]]);
equal('meses adeudados: los de las cuotas; quien solo debe mora, cero', ml.rows.map((x) => x.months), [11, 0, 2]);
equal('el total de cada vecino es lo vencido mas la mora, y suma lo mismo que sus columnas (sin mora)', [ml.rows[0].total, ml.rows[0].amounts.reduce((a, b) => a + b, 0), ml.rows[1].total, ml.rows[2].total], [3500, 3500, 5, 600]);
equal('totales: por columna, meses, vencido, mora y total', [ml.totals.byColumn[0], ml.totals.byColumn[1], ml.totals.byColumn[9], ml.totals.months, ml.totals.late, ml.totals.mora, ml.totals.total], [500, 300, 600, 13, 4100, 5, 4105]);
equal('hay mora y se cuentan todos los vecinos del mapa', [ml.hasMora, ml.residents], [true, 4]);
const ml3 = R.moraList(mlMap, { minMonths: 3 });
equal('con "3 meses o mas" solo queda quien debe tantos meses (y ya no hay mora ni su columna del ano anterior sobra)', [ml3.rows.map((x) => x.row.resident.unit), ml3.hasMora, ml3.columns.length], [['A002'], false, 11]);
equal('con 12 meses o mas no sale nadie y no queda ninguna columna', [R.moraList(mlMap, { minMonths: 12 }).rows.length, R.moraList(mlMap, { minMonths: 12 }).columns.length], [0, 0]);
equal('un mapa sin morosos da un listado vacio', [R.moraList({ rows: mlMap.rows.filter((x) => x.resident.id === 'u2'), columns: mlMap.columns }).rows.length, R.moraList({ rows: [], columns: [] }).columns.length, R.moraList(null).rows.length], [0, 0, 0]);
equal('las celdas son las del mapa: lo que debe cada mes sale en rojo (status owed)', [mlMap.rows.find((x) => x.resident.id === 'u3').cells['2026-09'].status, mlMap.rows.find((x) => x.resident.id === 'u3').cells['2026-08'].status, mlMap.rows.find((x) => x.resident.id === 'u3').cells['2026-11'].status], ['owed', 'paid', 'pending']);
equal('en el navegador tambien existe moraList', typeof R.moraList, 'function');
// Orden del listado: lote, nombre, morosidad (meses) y total adeudado, ascendente o descendente
const mlOrder = (order, dir, minMonths) => R.moraList(mlMap, { order, dir, minMonths }).rows.map((x) => x.row.resident.unit);
equal('por lote de menor a mayor (natural: A2 antes que A10) y de mayor a menor', [mlOrder('unit', 'asc'), mlOrder('unit', 'desc')], [['A002', 'A003', 'A010'], ['A010', 'A003', 'A002']]);
equal('por nombre de A a Z y de Z a A', [mlOrder('name', 'asc'), mlOrder('name', 'desc')], [['A003', 'A010', 'A002'], ['A002', 'A010', 'A003']]);
equal('por morosidad (meses adeudados): de mayor a menor y de menor a mayor', [mlOrder('months', 'desc'), mlOrder('months', 'asc')], [['A002', 'A010', 'A003'], ['A003', 'A010', 'A002']]);
equal('por total adeudado: de mayor a menor y de menor a mayor', [mlOrder('debt', 'desc'), mlOrder('debt', 'asc')], [['A002', 'A010', 'A003'], ['A003', 'A010', 'A002']]);
// Empates: dos vecinos con los mismos meses se ordenan por su total (el mayor primero) y despues por lote, sin importar el sentido
const tie = { columns: [{ key: '2026-09', kind: 'month', label: 'Sep 2026' }], rows: [
    { resident: { id: 't1', name: 'Zeta', unit: 'B2' }, lateMonths: 1, late: 100, owed: { mora: 0 }, cells: { '2026-09': { status: 'owed', late: 100 } } },
    { resident: { id: 't2', name: 'Alfa', unit: 'B1' }, lateMonths: 1, late: 300, owed: { mora: 0 }, cells: { '2026-09': { status: 'owed', late: 300 } } },
    { resident: { id: 't3', name: 'Beta', unit: 'B3' }, lateMonths: 1, late: 100, owed: { mora: 0 }, cells: { '2026-09': { status: 'owed', late: 100 } } }
] };
const tieOrder = (order, dir) => R.moraList(tie, { order, dir }).rows.map((x) => x.row.resident.unit);
equal('empate en meses: el que mas debe primero, y a igual deuda por lote; igual en los dos sentidos', [tieOrder('months', 'desc'), tieOrder('months', 'asc')], [['B1', 'B2', 'B3'], ['B1', 'B2', 'B3']]);
equal('empate en dinero: el de mas meses primero y a igual, por lote', [tieOrder('debt', 'desc')], [['B1', 'B2', 'B3']]);
equal('sin pedir orden queda el del mapa, y un orden que no existe tambien', [R.moraList(tie).rows.map((x) => x.row.resident.unit), R.moraList(tie, { order: 'otro' }).rows.map((x) => x.row.resident.unit)], [['B2', 'B1', 'B3'], ['B2', 'B1', 'B3']]);
equal('ordenar no cambia las columnas ni los totales', [JSON.stringify(R.moraList(mlMap, { order: 'debt', dir: 'desc' }).totals), JSON.stringify(R.moraList(mlMap).totals)], [JSON.stringify(R.moraList(mlMap).totals), JSON.stringify(R.moraList(mlMap).totals)]);

// ───────── Saldo a favor (pedido del usuario el 2026-11-18) ─────────
console.log('\nSaldo a favor: a que cuotas se aplica');
const cov = (credit, fee, first) => R.creditCoverage(credit, fee, first);
equal('Q 700 con cuota de Q 350 desde diciembre: dos cuotas enteras', [cov(700, 350, '2026-12').text, cov(700, 350, '2026-12').until, cov(700, 350, '2026-12').fullMonths, cov(700, 350, '2026-12').partial], ['cubre las cuotas de diciembre de 2026 y enero de 2027', 'hasta Ene 2027', 2, null]);
equal('una cuota exacta', cov(350, 350, '2026-12').text, 'cubre la cuota de diciembre de 2026');
equal('menos de una cuota: cuanto cubre de la primera', [cov(200, 350, '2026-12').text, cov(200, 350, '2026-12').until], ['cubre Q200.00 de la cuota de diciembre de 2026 (Q350.00)', 'parte de Dic 2026']);
equal('una cuota y parte de la siguiente', cov(500, 350, '2026-12').text, 'cubre la cuota de diciembre de 2026 y Q150.00 de la de enero de 2027');
equal('tres o mas: el rango, cuantos meses y lo que sobra de la siguiente', cov(1100, 350, '2026-11').text, 'cubre las cuotas de noviembre de 2026 a enero de 2027 (3 meses), y Q50.00 de la de febrero de 2027');
equal('los meses uno por uno (el ultimo, parcial)', cov(750, 350, '2026-12').months, [{ period: '2026-12', amount: 350, full: true }, { period: '2027-01', amount: 350, full: true }, { period: '2027-02', amount: 50, full: false }]);
equal('cruza el ano', [cov(4200, 350, '2026-12').text, cov(4200, 350, '2026-12').lastFull], ['cubre las cuotas de diciembre de 2026 a noviembre de 2027 (12 meses)', '2027-11']);
equal('sin cuota mensual o sin mes de inicio: se aplica a lo que venga', [cov(100, 0, '2026-12').text, cov(100, 350, 'x').text], ['se aplica solo a sus próximas cuotas y cargos', 'se aplica solo a sus próximas cuotas y cargos']);
equal('sin saldo a favor no dice nada', [cov(0, 350, '2026-12').text, cov(-50, 350, '2026-12').text], ['', '']);
equal('el formato del dinero lo pone OIKOS', R.creditCoverage(200, 350, '2026-12', { money: (v) => `$ ${v}` }).text, 'cubre $ 200 de la cuota de diciembre de 2026 ($ 350)');
equal('en centavos, sin errores de redondeo', [cov(0.3, 0.1, '2026-12').fullMonths, cov(0.3, 0.1, '2026-12').partial], [3, null]);
equal('un saldo enorme no arma una lista sin fin (a lo mas MAX_MONTHS meses) pero dice hasta donde llega', [cov(350 * 1000, 350, '2026-12').months.length, cov(350 * 1000, 350, '2026-12').fullMonths, cov(350 * 1000, 350, '2026-12').lastFull], [R.MAX_MONTHS, 1000, '2110-03']);
equal('el mes que sigue', [R.addMonths('2026-12', 1), R.addMonths('2026-01', 23), R.addMonths('2026-05', 0)], ['2027-01', '2027-12', '2026-05']);
// La Tabla general reparte los pagos igual: un pago adelantado deja pagados los meses que se cargan despues
const prepaid = [
    tx('a1', 'charge', '2026-01-05T18:00:00.000Z', 300, { kind: 'fee', period: '2026-01', resiId: 'ad' }),
    tx('ap', 'income', '2026-01-10T18:00:00.000Z', 1000, { resiId: 'ad' }),
    tx('a2', 'charge', '2026-02-05T18:00:00.000Z', 300, { kind: 'fee', period: '2026-02', resiId: 'ad' }),
    tx('a3', 'charge', '2026-03-05T18:00:00.000Z', 300, { kind: 'fee', period: '2026-03', resiId: 'ad' }),
    tx('a4', 'charge', '2026-04-05T18:00:00.000Z', 300, { kind: 'fee', period: '2026-04', resiId: 'ad' })
];
const pmPrepaid = R.paymentMap([{ id: 'ad', name: 'Adelantado' }], prepaid, { today: '2026-05-20' });
equal('Tabla general: Q 1,000 en enero pagan enero, febrero y marzo enteros (verde) y Q 100 de abril, que sigue en rojo', ['2026-01', '2026-02', '2026-03', '2026-04'].map((k) => [pmPrepaid.rows[0].cells[k].status, pmPrepaid.rows[0].cells[k].owed]), [['paid', 0], ['paid', 0], ['paid', 0], ['owed', 200]]);

// ── Impresion de marbetes por fase (pedido del usuario el 2026-11-20) ──
const mbRes = [
    { id: 'r1', name: 'Zoila', unit: 'A10', fase: 'A' },
    { id: 'r2', name: 'Beto', unit: 'A2', fase: 'A' },
    { id: 'r3', name: 'Carla', unit: 'B1', fase: '2' },
    { id: 'r4', name: 'Dario', unit: 'C5', fase: '' },
    { id: 'r5', name: 'Elena', unit: 'B7', fase: '10' }
];
const mbVeh = [
    { id: 'v1', userId: 'r1', plate: 'p-200bbb', brand: 'Toyota', model: 'Hilux', color: 'Blanco', marbeteCode: 'MAR1' },
    { id: 'v2', userId: 'r1', plate: 'P-100AAA', brand: 'Kia', model: 'Rio', color: 'Rojo', marbeteCode: 'MAR2' },
    { id: 'v3', userId: 'r3', plate: 'M-300CCC', brand: 'Honda', model: '', color: '', marbeteCode: '' },
    { id: 'v4', userId: 'ya-no-esta', plate: 'P-999ZZZ', marbeteCode: 'MAR9' },
    { id: 'v5', userId: '', plate: 'P-000', marbeteCode: 'MAR0' }
];
const mb = (o) => R.marbetesList(mbRes, mbVeh, o);
const mbAll = mb();
equal('marbetes: una fase por grupo, en orden natural (2 antes que 10, letras despues) y "Sin fase" al final', mbAll.groups.map((g) => g.fase), ['2', '10', 'A', '']);
equal('marbetes: dentro de la fase, por lote o casa en orden natural (A2 antes que A10) y una fila por vehiculo, por placa', mbAll.groups[2].rows.map((x) => [x.n, x.resident.unit, x.vehicle && x.vehicle.plate]), [[1, 'A2', null], [2, 'A10', 'P-100AAA'], [3, 'A10', 'P-200BBB']]);
equal('marbetes: la placa en mayusculas y los datos del vehiculo con su codigo', mbAll.groups[2].rows[2].vehicle, { id: 'v1', plate: 'P-200BBB', brand: 'Toyota', model: 'Hilux', color: 'Blanco', code: 'MAR1' });
equal('marbetes: subtotales por fase (residentes, con vehiculo, vehiculos, sin vehiculo, con codigo)', mbAll.groups.map((g) => [g.residents, g.withVehicle, g.vehicles, g.without, g.withCode]), [[1, 1, 1, 0, 0], [1, 0, 0, 1, 0], [2, 1, 2, 1, 2], [1, 0, 0, 1, 0]]);
equal('marbetes: totales y los vehiculos de alguien que ya no esta (sin listar)', [mbAll.totals, mbAll.orphans], [{ groups: 4, residents: 5, withVehicle: 2, vehicles: 3, without: 3, withCode: 2 }, 1]);
equal('marbetes: las fases que existen y cuantos no tienen fase', [mbAll.fases, mbAll.withoutFase], [['2', '10', 'A'], 1]);
equal('marbetes: una fase, o solo los que no tienen fase', [mb({ fase: 'A' }).groups.map((g) => g.fase), mb({ fase: R.NO_FASE }).groups.map((g) => g.rows.map((x) => x.resident.name))], [['A'], [['Dario']]]);
equal('marbetes: solo con vehiculo o solo sin vehiculo', [mb({ show: 'with' }).groups.map((g) => g.rows.map((x) => x.resident.name)), mb({ show: 'without' }).totals], [[['Carla'], ['Zoila', 'Zoila']], { groups: 3, residents: 3, withVehicle: 0, vehicles: 0, without: 3, withCode: 0 }]);
equal('marbetes: por nombre dentro de la fase', mb({ order: 'name', fase: 'A' }).groups[0].rows.map((x) => x.resident.name), ['Beto', 'Zoila', 'Zoila']);
equal('marbetes: sin vehiculos registrados salen todos sin placa; sin residentes no hay grupos', [R.marbetesList(mbRes, []).totals.without, R.marbetesList([], mbVeh).groups.length, R.marbetesList(null, null).totals.residents], [5, 0, 0]);

// ─── Visitas autorizadas por residente (pedido del usuario el 2026-11-24) ───
console.log('\nVisitas autorizadas por residente');
{
    const res = [{ id: 'a', name: 'Ana García', unit: 'A2', fase: '1' }, { id: 'b', name: 'Beto Paz', unit: 'A10', fase: '1' }, { id: 'c', name: 'Carlos Ruiz', unit: 'B1', fase: '2' }];
    const visits = [
        // Un dia: entro a las 6:35 p. m. y salio a las 8:50 p. m. (hora de Guatemala, UTC-6)
        { id: 'v1', userId: 'a', visitorName: 'Roberto Herrera', vehiclePlate: 'p123abc', visitDate: '2026-11-20', visitTime: '18:30', enteredAt: '2026-11-21T00:35:00.000Z', exitedAt: '2026-11-21T02:50:00.000Z', createdAt: '2026-11-20T15:00:00Z' },
        // Temporal de 7 dias que sigue dentro
        { id: 'v2', userId: 'a', visitorName: 'Carla Méndez', visitDate: '2026-11-24', visitType: 'temporal', endDate: '2026-11-30', enteredAt: '2026-11-24T14:00:00Z' },
        // No llego (ya paso su dia)
        { id: 'v3', userId: 'b', visitorName: 'Diego López', visitDate: '2026-11-10', visitTime: '09:05' },
        // De un vecino que ya no esta en Residentes: va con la casa del pase; por llegar
        { id: 'v4', userId: 'zz', casa: 'Casa 9', visitorName: 'Eva Soto', visitDate: '2026-11-25' },
        // Fuera del rango
        { id: 'v5', userId: 'b', visitorName: 'Fuera', visitDate: '2026-09-01' },
        // Temporal que empezo antes del rango y sigue valiendo dentro: cuenta
        { id: 'v6', userId: 'c', visitorName: 'Fernando Paz', visitDate: '2026-10-28', visitType: 'temporal', endDate: '2026-11-03' },
        // Salida anotada antes del ingreso (un temporal que volvio a entrar): sigue dentro, sin salida
        { id: 'v7', userId: 'c', visitorName: 'Gaby', visitDate: '2026-11-15', enteredAt: '2026-11-15T20:00:00Z', exitedAt: '2026-11-15T19:00:00Z' }
    ];
    const opts = { from: '2026-11-01', to: '2026-11-30', today: '2026-11-24' };
    const r = R.visitsReport(visits, res, opts);
    const ids = (list) => list.map((x) => x.id);
    equal('solo los pases que valen algun dia del rango (un temporal que empezo antes cuenta)', ids(r.rows).sort(), ['v1', 'v2', 'v3', 'v4', 'v6', 'v7']);
    equal('por defecto, agrupados por vecino en orden de lote (A2 antes que A10) y el que ya no esta con la casa del pase',
        r.groups.map((g) => `${g.resident.unit}:${ids(g.rows).join(',')}`), ['A2:v2,v1', 'A10:v3', 'B1:v7,v6', 'Casa 9:v4']);
    equal('el estado: salio, dentro, no llego y por llegar (una salida anterior al ingreso no cuenta)',
        ['v1', 'v2', 'v3', 'v4', 'v6', 'v7'].map((id) => r.rows.find((x) => x.id === id).status), ['salio', 'dentro', 'no_llego', 'por_llegar', 'no_llego', 'dentro']);
    equal('los totales', r.totals, { visits: 6, residents: 4, entered: 3, inside: 2, out: 1, pending: 1, noShow: 2, temporal: 2 });
    const v1 = r.rows.find((x) => x.id === 'v1');
    equal('hora de Guatemala, tiempo dentro, placa en mayusculas y tiempo autorizado',
        [R.dayLabel(v1.day), R.hourLabel(v1.time), R.stampLabel(v1.entered), R.stampLabel(v1.exited), R.stayLabel(v1.stay), v1.plate, v1.authorized, r.rows.find((x) => x.id === 'v2').authorized],
        ['20/11/2026', '6:30 p. m.', '20/11/2026 6:35 p. m.', '20/11/2026 8:50 p. m.', '2 h 15 min', 'P123ABC', 'Un día (una entrada)', '7 días (24/11 al 30/11/2026)']);
    equal('el vecino que ya no esta se marca (no se inventa un nombre de Residentes)', [r.rows.find((x) => x.id === 'v4').resident.known, r.rows.find((x) => x.id === 'v1').resident.known], [false, true]);
    equal('por nombre del vecino', R.visitsReport(visits, res, { ...opts, order: 'name' }).groups.map((g) => g.resident.name), ['Ana García', 'Beto Paz', 'Carlos Ruiz', 'Vecino que ya no está en Residentes']);
    equal('por fecha, las mas recientes primero o las mas antiguas primero (sin grupos)',
        [ids(R.visitsReport(visits, res, { ...opts, order: 'date' }).rows), ids(R.visitsReport(visits, res, { ...opts, order: 'date', recent: false }).rows), R.visitsReport(visits, res, { ...opts, order: 'date' }).groups.length],
        [['v4', 'v2', 'v1', 'v7', 'v3', 'v6'], ['v6', 'v3', 'v7', 'v1', 'v2', 'v4'], 0]);
    equal('por nombre del visitante', R.visitsReport(visits, res, { ...opts, order: 'visitor' }).rows.map((x) => x.visitor), ['Carla Méndez', 'Diego López', 'Eva Soto', 'Fernando Paz', 'Gaby', 'Roberto Herrera']);
    equal('mostrar: las que ingresaron, siguen dentro, por llegar y no llegaron',
        ['entered', 'inside', 'pending', 'noshow'].map((show) => ids(R.visitsReport(visits, res, { ...opts, order: 'date', show }).rows)),
        [['v2', 'v1', 'v7'], ['v2', 'v7'], ['v4'], ['v3', 'v6']]);
    equal('horas: medianoche, mediodia y una hora mal escrita', [R.hourLabel('00:05'), R.hourLabel('12:00'), R.hourLabel('9:7'), R.hourLabel(''), R.stayLabel(45), R.stayLabel(3000)], ['12:05 a. m.', '12:00 p. m.', '', '', '45 min', '2 días 2 h']);
    equal('sin pases ni rango, vacio y sin errores', R.visitsReport(null, null, {}).totals.visits, 0);
}

// WhatsApp de un reporte con columnas en negrita (el nombre del vecino): antes salia "[object Object]"
{
    const rep = { title: 'M', headers: ['a', 'b', 'c'], rows: [['1', 'Ana', 'P1']], emphasisCols: [1, 2], compact: { headers: ['Vecino', 'Placa'], rows: [['Ana', 'P1']], numericCols: [] } };
    equal('en WhatsApp las celdas en negrita salen como texto; en el Excel siguen en negrita',
        [X.whatsappText(R.exportModel(rep, {})).includes('Ana · P1'), /object Object/.test(X.whatsappText(R.exportModel(rep, {}))), JSON.stringify(R.exportModel(rep, { excel: true })).includes('{"v":"Ana","s":1}')],
        [true, false, true]);
}

const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-reportes.js'), sandbox);
equal('en el navegador queda como SisdelReportesOikos y calcula lo mismo', JSON.stringify(sandbox.self.SisdelReportesOikos.monthBalance(txs, { dayKey: gtDay })), JSON.stringify(all));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
