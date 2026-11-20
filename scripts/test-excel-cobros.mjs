// Pruebas del reemplazo con un libro de cobros y gastos (lib-excel-cobros.mjs): sin emuladores. Datos inventados.
// Uso: node test-excel-cobros.mjs
import { createRequire } from 'node:module';
import { readCobrosWorkbook, checkTotals, buildTarget, diffTarget, finalLedger, keyOfExisting, docText, cleanName, MONTHS, TARIFF } from './lib-excel-cobros.mjs';
import { cents } from './lib-saldos-reales.mjs';

const require = createRequire(import.meta.url);
const Reportes = require('../finanzas/sisdel-reportes.js');
const Cuotas = require('../finanzas/sisdel-cuotas.js');
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

// ── Un libro como lo entrega lib-xlsx: hojas con filas y celdas { v } (columnas sueltas) ──
const cellsOf = (map) => Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([c, v]) => [String(c), { v: String(v) }]));
const mk = (r, map) => ({ r, cells: cellsOf(map) });
const serial = (day) => Math.round((Date.UTC(...day.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) - Date.UTC(1899, 11, 30)) / 86400000);
// casa -> { name, y2025, m: { indice de mes: monto }, y2027, abono }
const HOUSES = [
    { casa: 1, name: 'ANA PRUEBA', m: { 0: 250, 1: 250, 2: 250, 3: 350, 4: 350, 5: 350, 6: 350, 7: 350, 8: 350, 9: 350, 10: 350, 11: 350 }, y2027: 700 },
    { casa: 2, name: 'BETO PRUEBA.', y2025: 1000, m: { 0: 250, 1: 250, 2: 250, 3: 350, 6: 300 } },
    { casa: 3, name: 'CARLA  PRUEBA', m: { 2: 250, 3: 350, 4: 350, 5: 350, 6: 350, 7: 350, 8: 350, 9: 350 } },
    { casa: 4, name: 'DORA PRUEBA', m: {}, abono: 150 }
];
const GASTOS = [
    { day: '2026-01-03', doc: '4.129377195E9', who: 'PROVEEDOR UNO', col: 9, amount: 115 },
    { day: '2026-01-20', doc: 'S/N', who: 'PROVEEDOR DOS', col: 7, amount: 3600 },
    { day: '2026-02-10', doc: '63.0', who: 'PROVEEDOR UNO', col: 9, amount: 115 },
    { day: '2026-02-10', doc: '64', who: 'PROVEEDOR UNO', col: 9, amount: 115 },
    { day: '2026-03-01', doc: '', who: 'SEGURIDAD SA', col: 3, amount: 8800 }
];
function workbook({ badTotal = false, extraHouse = null, over = null, noExpenses = false, futureExpense = false } = {}) {
    const houses = [...HOUSES, ...(extraHouse ? [extraHouse] : [])].map((h) => (over && over.casa === h.casa ? { ...h, m: { ...h.m, ...over.m } } : h));
    const head = mk(3, { 0: 'CASA', 1: 'NOMBRE', 2: '2025.0', ...Object.fromEntries(MONTHS.map((m, i) => [3 + i, m.toUpperCase()])), 15: '2027.0' });
    const rows = houses.map((h, i) => mk(4 + i, { 0: `${h.casa}.0`, 1: h.name, 2: h.y2025, ...Object.fromEntries(Object.entries(h.m || {}).map(([i2, v]) => [3 + Number(i2), v])), 15: h.y2027, 16: h.abono, 17: h.abono ? 'abonado' : '' }));
    const sumCol = (f) => houses.reduce((a, h) => a + f(h), 0);
    const totals = mk(4 + houses.length + 1, { 2: sumCol((h) => h.y2025 || 0) + (badTotal ? 1 : 0), ...Object.fromEntries(MONTHS.map((m, i) => [3 + i, sumCol((h) => (h.m || {})[i] || 0)])), 15: sumCol((h) => h.y2027 || 0) });
    const gHead = [mk(3, { 3: 'SEGURIDAD', 9: 'OTROS' }), mk(4, { 0: 'FECHA', 1: 'No. COMP.', 2: 'PROVEEDOR', 3: 'SEGURIDAD', 9: 'OTROS' })];
    const list = noExpenses ? [] : [...GASTOS, ...(futureExpense ? [{ day: '2027-05-01', doc: '1', who: 'FUTURO', col: 9, amount: 10 }] : [])];
    const gRows = list.map((g, i) => mk(5 + i, { 0: serial(g.day), 1: g.doc, 2: g.who, [g.col]: g.amount }));
    const cat = (col) => GASTOS.filter((g) => g.col === col).reduce((a, g) => a + g.amount, 0);
    const gTotals = noExpenses ? [] : [mk(5 + list.length + 1, { 3: cat(3), 7: cat(7), 9: cat(9) })];
    return { sheets: [
        { name: 'CUOTA MANTENIMIENTO', rows: [mk(1, { 0: 'AÑO 2026' }), head, ...rows, totals] },
        { name: 'GASTOS', rows: [...gHead, ...gRows, ...gTotals] },
        { name: 'RESUMEN', rows: [mk(2, { 0: 'RESUMEN' })] }
    ] };
}

console.log('\nLectura del libro');
equal('cifras de comprobante: numero de Excel, texto y S/N', [docText({ v: '4.129377195E9' }), docText({ v: '63.0' }), docText({ v: '1396o9711' }), docText({ v: '' })], ['4129377195', '63', '1396o9711', '']);
equal('nombres limpios (punto final y espacios), una sigla conserva su punto', [cleanName('BETO PRUEBA.'), cleanName('CARLA  PRUEBA'), cleanName('LUIS D.C.')], ['BETO PRUEBA', 'CARLA PRUEBA', 'LUIS D.C.']);
const book = readCobrosWorkbook(workbook(), { today: '2026-11-20' });
equal('sin problemas: casas y gastos', [book.problems, book.casas.length, book.expenses.length], [[], 4, 5]);
equal('la casa 2: nombre limpio, atraso de 2025 y meses', [book.casas[1].name, book.casas[1].y2025, book.casas[1].months.slice(0, 8)], ['BETO PRUEBA', 1000, [250, 250, 250, 350, 0, 0, 300, 0]]);
equal('adelantos de 2027 y abono suelto', [book.casas[0].y2027, book.casas[3].abono, book.casas[0].abono], [700, 150, 0]);
equal('los gastos traen categoria, proveedor y comprobante en cifras', [book.expenses[0].category, book.expenses[0].supplier, book.expenses[0].doc, book.expenses[1].doc, book.expenses[2].doc, book.expenses[4].doc], ['Otros', 'PROVEEDOR UNO', '4129377195', 'S/N', '63', '']);
yes('cuadra con las filas de totales del libro', checkTotals(book).ok);
yes('si un total del libro esta mal, no cuadra y dice cual', (() => { const t = checkTotals(readCobrosWorkbook(workbook({ badTotal: true }), {})); return !t.ok && t.rows.filter((r) => !r.ok).map((r) => r.label).join() === '2025'; })());
yes('una casa repetida es un problema', readCobrosWorkbook(workbook({ extraHouse: { casa: 4, name: 'REPETIDA', m: {} } }), {}).problems.some((p) => /repetida/.test(p)));
yes('pagar mas que la tarifa del mes es un problema', readCobrosWorkbook(workbook({ over: { casa: 1, m: { 0: 300 } } }), {}).problems.some((p) => /tarifa/.test(p)));
yes('un gasto con fecha futura es un problema', readCobrosWorkbook(workbook({ futureExpense: true }), { today: '2026-11-20' }).problems.some((p) => /despues de hoy/.test(p)));
yes('sin la hoja de cuotas el libro no sirve', readCobrosWorkbook({ sheets: [{ name: 'GASTOS', rows: [] }] }, {}).problems.some((p) => /CUOTA MANTENIMIENTO/.test(p)));

console.log('\nLo que debe haber en el sistema');
const options = { prefix: 'delco-', source: 'libro de prueba', nowIso: '2026-11-20T12:00:00.000Z', currentPeriod: '2026-11', sheetDay: '2026-11-16', year: 2026, reason: 'Reemplazado con el libro de prueba' };
const want = buildTarget(book, options);
const byKey = (k) => want.items.find((i) => i.key === k);
equal('una cuota por casa y mes hasta noviembre (4 x 11) y su tarifa', [want.items.filter((i) => i.key.startsWith('fee|')).length, byKey('fee|delco-1|2026-02').tx.amount, byKey('fee|delco-1|2026-04').tx.amount], [44, 250, 350]);
yes('no hay cuota de diciembre (aun no llega: la genera el sistema)', !byKey('fee|delco-1|2026-12'));
equal('un pago lleno y un abono (parcial) con su concepto', [byKey('pay|delco-2|2026-04').tx.concept, byKey('pay|delco-2|2026-07').tx.amount, /Abono.*\(parcial\)/.test(byKey('pay|delco-2|2026-07').tx.concept)], ['Pago de mantenimiento correspondiente a abril de 2026', 300, true]);
equal('el pago de diciembre es adelantado y va fechado el dia de la hoja', [/adelantado/.test(byKey('pay|delco-1|2026-12').tx.concept), byKey('pay|delco-1|2026-12').tx.date.slice(0, 10), byKey('pay|delco-1|2026-04').tx.date.slice(0, 10)], [true, '2026-11-16', '2026-04-15']);
equal('los atrasos de 2025: cargo y pago por el mismo monto', [byKey('arrears|delco-2').tx.amount, byKey('arrearspay|delco-2').tx.amount, byKey('arrears|delco-2').tx.kind], [1000, 1000, 'extra']);
equal('adelanto de 2027 y abono suelto como pagos', [byKey('ahead|delco-1').tx.amount, byKey('abono|delco-4').tx.amount], [700, 150]);
const exps = want.items.filter((i) => i.tx.type === 'expense').map((i) => i.tx);
equal('gastos: el concepto es la categoria, el proveedor va en observaciones y numero de referencia en orden', [exps[0].concept, exps[0].notes, exps[0].receiptNum, exps[4].receiptNum], ['Otros', 'Proveedor: PROVEEDOR UNO', 'EG0001', 'EG0005']);
equal('el comprobante S/N o vacio no se guarda como numero de documento', [exps.filter((e) => 'docNum' in e).length, exps[0].docNum], [3, '4129377195']);
yes('los movimientos de casas llevan serverGenerated y la fuente (sin importedFrom)', want.items.filter((i) => i.resiId).every((i) => i.tx.serverGenerated === true && i.tx.loadedFrom === 'libro de prueba' && !('importedFrom' in i.tx)));

console.log('\nComparar con lo que ya hay');
const diff0 = diffTarget(want, [], options);
equal('con la base vacia se crea todo y no se anula nada', [diff0.create.length, diff0.annul.length, diff0.keep.length, diff0.unknown.length], [want.items.length, 0, 0, 0]);
const base = finalLedger([], diff0);
const diff1 = diffTarget(buildTarget(book, options), base, options);
equal('volver a correr sobre lo ya cargado no cambia nada (idempotente)', [diff1.create.length, diff1.annul.length, diff1.keep.length], [0, 0, want.items.length]);
// Cambios en la base
const tamper = base.map((t) => ({ ...t }));
const idOf = (key) => diff0.create.find((t) => t.id === want.items.find((i) => i.key === key).tx.id).id;
tamper.find((t) => t.id === idOf('pay|delco-2|2026-07')).amount = 350;            // un pago con otro monto
tamper.splice(tamper.findIndex((t) => t.id === idOf('fee|delco-3|2026-05')), 1);   // una cuota que falta
tamper.push({ id: 'pago_delco-2_2026-05', resiId: 'delco-2', type: 'income', amount: 350, date: '2026-05-15T18:00:00.000Z', concept: 'de mas' }); // un pago que el libro no dice
tamper.push({ id: '1700000000000', resiId: 'delco-1', type: 'income', amount: 50, date: '2026-11-18T10:00:00.000Z', concept: 'pago registrado a mano' });
tamper.push({ ...base.find((t) => t.id === idOf('pay|delco-1|2026-01')), id: 'pago_delco-1_2026-01_r1' }); // un pago repetido
tamper.find((t) => t.id === idOf('fee|delco-4|2026-03')).deleted = true;           // una cuota anulada antes
const diff2 = diffTarget(buildTarget(book, options), tamper, options);
equal('un pago con otro monto: se anula el viejo y entra el nuevo con otro id', [diff2.annul.some((a) => a.id === idOf('pay|delco-2|2026-07')), diff2.create.find((t) => t.concept.includes('julio') && t.resiId === 'delco-2').id], [true, 'pago_delco-2_2026-07_r1']);
yes('una cuota que faltaba se crea', diff2.create.some((t) => t.id === 'fee_delco-3_2026-05'));
yes('una cuota anulada antes se vuelve a crear con otro id', diff2.create.some((t) => t.id === 'fee_delco-4_2026-03_r1'));
yes('un pago que el libro no dice se anula, con su motivo', diff2.annul.some((a) => a.id === 'pago_delco-2_2026-05' && a.reason === options.reason));
yes('un pago repetido (mismo mes) deja solo uno', diff2.annul.filter((a) => a.id === 'pago_delco-1_2026-01_r1' || a.id === idOf('pay|delco-1|2026-01')).length === 1);
yes('un pago registrado a mano no se reconoce y no se toca', diff2.unknown.length === 1 && diff2.unknown[0].id === '1700000000000' && !diff2.annul.some((a) => a.id === '1700000000000'));
const after2 = finalLedger(tamper, diff2);
const diff3 = diffTarget(buildTarget(book, options), after2, options);
equal('despues de aplicar la diferencia no queda nada por hacer', [diff3.create.length, diff3.annul.length, diff3.unknown.length], [0, 0, 1]);
equal('los gastos ya cargados se reconocen (con repetidos: mismo dia, monto, categoria y proveedor)', [keyOfExisting(exps[2], 'delco-', {}, new Map()) !== null, diff1.keep.filter((k) => k.key.startsWith('expense|')).length], [true, 5]);
yes('un gasto igual repetido el mismo dia se cuenta dos veces y no se pierde ninguno', (() => {
    const twice = { ...book, expenses: [...book.expenses, { ...book.expenses[0], row: 99 }] };
    const target2 = buildTarget(twice, options);
    const d = diffTarget(target2, base, options);
    return d.create.length === 1 && d.create[0].type === 'expense' && d.annul.length === 0;
})());

console.log('\nComo queda cada casa');
const ledger = finalLedger([], diff0);
const balanceOf = (id) => ledger.filter((t) => t.resiId === id).reduce((a, t) => a + (t.type === 'income' ? cents(t.amount) : -cents(t.amount)), 0) / 100;
equal('saldo de cada casa: a favor +, en contra -', [1, 2, 3, 4].map((c) => balanceOf('delco-' + c)), [1050, -2150, -850, -3400]);
// Con el motor de la Tabla general: lo debido por casa y los meses (los pagos cubren primero lo mas antiguo)
const residents = [1, 2, 3, 4].map((c) => ({ id: 'delco-' + c, name: 'Casa ' + c, unit: String(c) }));
const map = Reportes.paymentMap(residents, ledger, { today: '2026-11-20', dueOf: (p) => Cuotas.dueKey(p) });
const rowOf = (c) => map.rows.find((r) => r.resident.id === 'delco-' + c);
equal('lo que debe cada casa en la Tabla general (vencido + por vencer) coincide con el saldo', [1, 2, 3, 4].map((c) => Math.round((rowOf(c).lateTotal + rowOf(c).pendingTotal) * 100) / 100), [0, 2150, 850, 3400]);
const color = (c, p) => rowOf(c).cells[p].status;
equal('casa 1: todo en verde de enero a noviembre', MONTHS.slice(0, 11).map((_, i) => color(1, `2026-${String(i + 1).padStart(2, '0')}`)), Array(11).fill('paid'));
equal('casa 4: de enero a octubre en rojo y noviembre (en su plazo) en blanco', [color(4, '2026-01'), color(4, '2026-10'), color(4, '2026-11')], ['owed', 'owed', 'pending']);
equal('casa 2: enero a abril en verde y desde junio en rojo; hay meses en mora', [color(2, '2026-01'), color(2, '2026-04'), color(2, '2026-06'), color(2, '2026-10'), rowOf(2).lateMonths > 0], ['paid', 'paid', 'owed', 'owed', true]);
equal('casa 1: la columna de diciembre sale como adelantada solo si el saldo a favor la cubre (sin cobertura, no hay columna)', map.columns.some((c) => c.kind === 'ahead'), false);
yes('las tarifas del libro son las de la tabla (250 de enero a marzo y 350 despues)', TARIFF.slice(0, 4).join() === '250,250,250,350' && TARIFF.every((t, i) => (i < 3 ? t === 250 : t === 350)));

console.log(`\n${passed} pruebas bien, ${failures.length} fallas`);
if (failures.length) { console.log('Fallaron:\n - ' + failures.join('\n - ')); process.exit(1); }
