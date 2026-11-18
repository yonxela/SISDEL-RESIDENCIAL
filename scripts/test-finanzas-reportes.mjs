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

console.log('\nTabla general en Excel y WhatsApp');
const mapReport = {
    title: 'Tabla general', summary: '1 en mora', headers: ['Residente', 'Oct 2026', 'Nov 2026', 'Meses en mora', 'En mora desde', 'Total en mora'],
    rows: [['A001 · Uno', 'Q300.00', 'Q300.00', '1', 'Oct 2026', 'Q300.00'], ['A002 · Dos', 'Pagado', '—', '0', '—', 'Q0.00']],
    cellStatus: [[null, 'owed', 'pending'], [null, 'paid', 'none']],
    totals: ['TOTAL EN MORA', 'Q300.00', '', '1', '', 'Q300.00'], numericCols: [3, 5],
    compact: { headers: ['Residente', 'Meses en mora', 'En mora desde', 'Total en mora'], rows: [['A001 · Uno', '1', 'Oct 2026', 'Q300.00']], totals: ['TOTAL', '1', '', 'Q300.00'], numericCols: [1, 3] }
};
const mapExcel = R.exportModel(mapReport, { at, excel: true });
equal('en Excel las celdas van con su color (rojo, amarillo, verde) y lo gris sin color', [mapExcel.tables[0].rows[0][1], mapExcel.tables[0].rows[0][2], mapExcel.tables[0].rows[1][1], mapExcel.tables[0].rows[1][2]], [{ v: 'Q300.00', s: 4 }, { v: 'Q300.00', s: 6 }, { v: 'Pagado', s: 5 }, '—']);
const mapBook = readXlsx(Buffer.from(X.buildXlsx(mapExcel)));
const mapRow = mapBook.sheets[0].rows.find((r) => r.cells[0] && r.cells[0].v === 'A001 · Uno');
equal('el .xlsx con colores se abre y cada celda guarda su estilo', mapRow ? [mapRow.cells[1].s, mapRow.cells[2].s] : null, ['4', '6']);
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

    // Octubre vencida (300, con 16 dias de mora: 16 x 0.3) y noviembre que aun no vence
    const base = [feeTx('2026-10'), feeTx('2026-11')];
    const ms = standing(base, '2026-11-16');
    const debt = R.accountDebt(ms);
    equal('cuotas pendientes + mora = total que debe, con lo vencido y lo que aun no vence', debt, { pending: 600, overdue: 300, upcoming: 300, mora: 4.8, total: 604.8, credit: 0 });
    equal('la suma de las tres cifras es exacta', sum3(debt), debt.total);
    equal('el total que debe es el saldo con mora de la lista de Residentes (libro menos la mora por dia)', debt.total, round2(-ms.total));
    const list = R.pendingRows(ms, { label: (item) => R.periodLabel(item.period), total: debt.total });
    equal('la tabla trae una fila por cuota pendiente, con su vencimiento y su mora', list.rows.map((r) => [r.label, r.capital, r.dueDate, r.overdue, r.mora, r.total]), [['Oct 2026', 300, '2026-11-05', true, 4.8, 304.8], ['Nov 2026', 300, '2026-12-05', false, 0, 300]]);
    equal('el total de la tabla es el total que debe (sin fila de ajuste)', [list.capital, list.mora, list.total, list.rows.some((r) => r.kind === 'ajuste')], [600, 4.8, 604.8, false]);

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
    equal('un cargo fechado despues de hoy cuenta en el total y la tabla lo muestra como ajuste', [futureDebt.pending, futureDebt.total, adjust && adjust.label, adjust && adjust.capital, futureList.total], [420, 424.8, 'Fechados despues de hoy', 120, 424.8]);

    // El mismo total que la regla de la lista de Residentes y de los reportes (sisdelOwedOf de OIKOS, en centavos):
    // pendiente = max(0, -libro); mora = max(0, mora por dia - max(0, libro)); total = pendiente + mora
    const owedOf = (m) => { const pend = Math.max(0, -Math.round(m.ledger * 100)); const mor = Math.max(0, Math.round(m.moraDaily * 100) - Math.max(0, Math.round(m.ledger * 100))); return (pend + mor) / 100; };
    const futureTx = { id: 'f2', type: 'charge', kind: 'extra', amount: 120, resiId: 'r1', date: at12('2026-12-20'), concept: 'Cargo futuro' };
    const scenarios = [ms, big, partial, future, standing([feeTx('2026-10'), { id: 'p2', type: 'income', amount: 1000, resiId: 'r1', date: at12('2026-10-10') }], '2026-11-16'), standing([feeTx('2026-10'), futureTx], '2026-11-16')];
    equal('el total que debe es el de la regla de Residentes y los reportes en todos los casos (rara vez cambia solo como se parte)', scenarios.map((m) => R.accountDebt(m).total), scenarios.map(owedOf));

    // Sin deuda: todo en cero y el saldo a favor aparte
    const credit = standing([feeTx('2026-10'), { id: 'p2', type: 'income', amount: 1000, resiId: 'r1', date: at12('2026-10-10') }], '2026-11-16');
    equal('con saldo a favor no debe nada y se informa el saldo a favor', R.accountDebt(credit), { pending: 0, overdue: 0, upcoming: 0, mora: 0, total: 0, credit: 700 });
    equal('un residente sin movimientos no tiene filas', R.pendingRows(standing([], '2026-11-16'), { total: 0 }).rows, []);
    equal('sin regla de mora no hay cifras (la pantalla usa el saldo de siempre)', [R.accountDebt(null), R.accountDebt(undefined)], [null, null]);
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

const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-reportes.js'), sandbox);
equal('en el navegador queda como SisdelReportesOikos y calcula lo mismo', JSON.stringify(sandbox.self.SisdelReportesOikos.monthBalance(txs, { dayKey: gtDay })), JSON.stringify(all));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
