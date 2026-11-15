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
equal('el total de cada ano', all.years, [{ year: 2025, income: 200, expense: 0, balance: 200 }, { year: 2026, income: 1050.5, expense: 1120, balance: -69.5 }]);
equal('el total general', all.total, { income: 1250.5, expense: 1120, balance: 130.5 });
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

console.log('\nCopia en el navegador');
const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-reportes.js'), sandbox);
equal('en el navegador queda como SisdelReportesOikos y calcula lo mismo', JSON.stringify(sandbox.self.SisdelReportesOikos.monthBalance(txs, { dayKey: gtDay })), JSON.stringify(all));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
