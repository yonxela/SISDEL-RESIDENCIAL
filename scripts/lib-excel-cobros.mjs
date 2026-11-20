// Reemplazo de los datos de un condominio con SU libro de Excel de cobros y gastos (Residenciales Delco II, 2026-11-20:
// "reemplazar con los datos del archivo todos los datos de condominio Delco II... que en la Tabla general esten en verde los
// meses pagados y en rojo los meses en mora"). Logica pura (sin base de datos): la usan reemplazar-cobros-excel.mjs y la
// prueba test-excel-cobros.mjs con datos inventados.
//
// El libro trae (entre otras hojas que NO se cargan: Resumen, Aportaciones y Asesoria juridica):
//   - "CUOTA MANTENIMIENTO": una fila por casa: CASA, NOMBRE, "2025" (lo que pago en 2026 de atrasos de 2025), ENERO a
//     DICIEMBRE (lo que pago cada mes: un monto menor que la tarifa es un ABONO), "2027" (pagos adelantados de 2027) y a veces
//     un abono suelto con la palabra "abonado" al lado. Al final, una fila de totales por columna.
//   - "GASTOS": una fila por gasto: FECHA (fecha de Excel), No. COMP., PROVEEDOR y el monto en la columna de su categoria
//     (Seguridad, Luz de la garita, Utiles de oficina, Material electrico y/o mano de obra, Jardin, Productos de jardineria,
//     Otros y Asamblea). Al final, una fila de totales por categoria.
//
// Lo que se carga (como La Perla: lo pagado en verde y lo atrasado en rojo en la Tabla general):
//   - Cada casa es un vecino (id `<prefijo><casa>`, ya existente). Cada mes de enero al mes en curso tiene su CUOTA por la
//     tarifa de ese mes (250 de enero a marzo y 350 despues) y cada monto de la hoja entra como un PAGO ese mes. Un mes en
//     blanco es una cuota que se debe (en rojo); uno pagado a medias deja lo que falta; un mes que aun no llega (diciembre y
//     2027) queda como saldo a favor que cubre esa cuota cuando se genere ("Adelantado").
//   - "2025": un cargo "Cuotas atrasadas de 2025" por ese monto y su pago (la hoja solo dice lo que pagaron: no se inventan
//     los meses de 2025 ni lo que dejaron de pagar).
//   - Los gastos entran como egresos: el concepto es la categoria (asi el reporte "Gastos por categoria" los agrupa), el
//     proveedor va en las observaciones y el numero de comprobante en el numero de documento.
//   - Todo se compara con lo que ya esta cargado: lo que ya dice lo mismo se deja; lo que no coincide se ANULA con su motivo
//     (nada se borra) y entra lo nuevo. Lo que no se reconoce (un pago hecho a mano en OIKOS) no se toca.
import { excelDay, cents, fromCents } from './lib-saldos-reales.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SisdelCuotas = require('../finanzas/sisdel-cuotas.js');

export const SHEET_FEES = 'CUOTA MANTENIMIENTO';
export const SHEET_EXPENSES = 'GASTOS';
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// La tarifa de cada mes de 2026 (decidida con el usuario: 250 de enero a marzo y 350 desde abril)
export const TARIFF = [250, 250, 250, 350, 350, 350, 350, 350, 350, 350, 350, 350];
// Categorias de los gastos: columna de la hoja -> nombre
export const EXPENSE_COLUMNS = { 3: 'Seguridad', 4: 'Luz de la garita', 5: 'Útiles de oficina', 6: 'Material eléctrico y/o mano de obra', 7: 'Jardín y áreas verdes', 8: 'Material y/o productos de jardinería', 9: 'Otros', 10: 'Asamblea' };

const raw = (cell) => (cell === undefined || cell === null ? null : (typeof cell === 'object' && 'v' in cell ? cell.v : cell));
const text = (cell) => { const v = raw(cell); return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim(); };
const number = (cell) => { const n = parseFloat(String(raw(cell) ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const has = (cell) => { const v = raw(cell); return v !== null && v !== undefined && String(v).trim() !== ''; };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const rowsOf = (sheet) => (sheet.rows || []).map((row) => ({ r: row.r, c: row.cells || row.c || {} }));
const periodOf = (year, monthIndex) => `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
const noonGt = (day) => `${day}T18:00:00.000Z`;

// Un numero de comprobante que Excel guardo como numero ("4.129377195E9", "63.0") se escribe como cifras; el texto se deja
export function docText(cell) {
    const s = text(cell);
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) { const n = Number(s); if (Number.isSafeInteger(n)) return String(n); }
    return s;
}

// "LUIS RODAS CIFUENTES." -> "LUIS RODAS CIFUENTES" (una sigla como D.C. conserva su punto final)
export function cleanName(rawName) {
    const name = String(rawName || '').replace(/\s+/g, ' ').trim();
    return /\b[A-Z]\.[A-Z]\.$/.test(name) ? name : name.replace(/[.\-,;]+$/, '').trim();
}

// Lee el libro (resultado de readXlsx). Devuelve { casas, feeTotals, expenses, expenseTotals, problems }
export function readCobrosWorkbook(wb, opts = {}) {
    const year = opts.year || 2026;
    const today = opts.today || '9999-12-31';
    const problems = [];
    const sheets = new Map((wb.sheets || []).map((s) => [norm(s.name), s]));
    const feeSheet = sheets.get(norm(SHEET_FEES));
    const expSheet = sheets.get(norm(SHEET_EXPENSES));
    if (!feeSheet) problems.push(`El libro debe traer la hoja "${SHEET_FEES}".`);
    if (!expSheet) problems.push(`El libro debe traer la hoja "${SHEET_EXPENSES}".`);
    if (problems.length) return { casas: [], feeTotals: null, expenses: [], expenseTotals: null, problems };

    // ── Cuotas ──
    const F = rowsOf(feeSheet);
    const head = F.find((r) => norm(text(r.c['0'])) === 'casa');
    if (!head) problems.push(`"${SHEET_FEES}": no se encontro el encabezado CASA.`);
    const monthCol = {};
    let col2025 = -1;
    let col2027 = -1;
    if (head) {
        Object.entries(head.c).forEach(([c, cell]) => {
            const mi = MONTHS.indexOf(norm(text(cell)));
            if (mi >= 0) monthCol[mi] = Number(c);
            else if (Math.round(number(cell)) === year - 1) col2025 = Number(c);
            else if (Math.round(number(cell)) === year + 1) col2027 = Number(c);
        });
        MONTHS.forEach((m, i) => { if (monthCol[i] === undefined) problems.push(`"${SHEET_FEES}": falta la columna de ${m}.`); });
    }
    const casas = [];
    let feeTotals = null;
    const seen = new Set();
    if (head && !problems.length) {
        const lastCol = Math.max(col2027, ...Object.values(monthCol));
        F.filter((r) => r.r > head.r).forEach((row) => {
            const name = cleanName(text(row.c['1']));
            const isCasa = /^\d+(\.0+)?$/.test(text(row.c['0'])) && number(row.c['0']) > 0;
            if (!isCasa) {
                // La fila de totales: sin casa ni nombre y con montos en las columnas de los meses
                if (!feeTotals && !has(row.c['0']) && !name && MONTHS.some((_, i) => number(row.c[String(monthCol[i])]) > 0)) {
                    feeTotals = { y2025: col2025 >= 0 ? number(row.c[String(col2025)]) : 0, months: MONTHS.map((_, i) => number(row.c[String(monthCol[i])])), y2027: col2027 >= 0 ? number(row.c[String(col2027)]) : 0 };
                }
                return;
            }
            const casaNumber = Math.round(number(row.c['0']));
            if (seen.has(casaNumber)) problems.push(`"${SHEET_FEES}": la casa ${casaNumber} esta repetida.`);
            seen.add(casaNumber);
            if (!name) problems.push(`"${SHEET_FEES}": la casa ${casaNumber} no tiene nombre.`);
            const months = MONTHS.map((_, i) => number(row.c[String(monthCol[i])]));
            months.forEach((amount, i) => {
                if (amount < 0) problems.push(`"${SHEET_FEES}": la casa ${casaNumber} trae un monto negativo en ${MONTHS[i]}.`);
                if (amount > TARIFF[i] + 0.004) problems.push(`"${SHEET_FEES}": la casa ${casaNumber} pago ${amount} en ${MONTHS[i]} y la tarifa es ${TARIFF[i]}.`);
            });
            // Un abono suelto: un monto despues de la ultima columna con la palabra "abonado" en la siguiente
            let abono = 0;
            Object.entries(row.c).forEach(([c, cell]) => {
                if (Number(c) > lastCol && has(cell) && number(cell) > 0 && /abon/.test(norm(text(row.c[String(Number(c) + 1)])))) abono = number(cell);
            });
            casas.push({ casa: casaNumber, name, y2025: col2025 >= 0 ? number(row.c[String(col2025)]) : 0, months, y2027: col2027 >= 0 ? number(row.c[String(col2027)]) : 0, abono });
        });
    }
    if (!casas.length && !problems.length) problems.push(`"${SHEET_FEES}": no se encontro ninguna casa.`);
    if (!feeTotals && !problems.length) problems.push(`"${SHEET_FEES}": no se encontro la fila de totales.`);

    // ── Gastos ──
    const expenses = [];
    let expenseTotals = null;
    rowsOf(expSheet).forEach((row) => {
        const serial = number(row.c['0']);
        const day = serial > 40000 ? excelDay(serial) : null;
        const columns = Object.keys(EXPENSE_COLUMNS).filter((c) => number(row.c[c]) > 0);
        if (day && columns.length) {
            columns.forEach((c) => expenses.push({ row: row.r, day, doc: docText(row.c['1']), supplier: text(row.c['2']), category: EXPENSE_COLUMNS[c], amount: number(row.c[c]) }));
        } else if (!has(row.c['0']) && !has(row.c['2']) && columns.length && !expenseTotals) {
            expenseTotals = Object.fromEntries(Object.keys(EXPENSE_COLUMNS).map((c) => [EXPENSE_COLUMNS[c], number(row.c[c])]));
        }
    });
    if (!expenses.length) problems.push(`"${SHEET_EXPENSES}": no se encontro ningun gasto.`);
    expenses.forEach((x) => { if (x.day > today) problems.push(`"${SHEET_EXPENSES}": el gasto de la fila ${x.row} tiene fecha de ${x.day}, despues de hoy.`); });
    return { casas, feeTotals, expenses, expenseTotals, problems };
}

// Cuadre de la hoja contra sus propias filas de totales (centavos): { ok, rows }
export function checkTotals(book) {
    const rows = [];
    const add = (label, got, expected) => rows.push({ label, got: fromCents(got), expected, ok: expected === null || Math.abs(got - cents(expected)) <= 1 });
    if (book.feeTotals) {
        add('2025', book.casas.reduce((a, c) => a + cents(c.y2025), 0), book.feeTotals.y2025);
        MONTHS.forEach((m, i) => add(m, book.casas.reduce((a, c) => a + cents(c.months[i]), 0), book.feeTotals.months[i]));
        add('2027', book.casas.reduce((a, c) => a + cents(c.y2027), 0), book.feeTotals.y2027);
    }
    if (book.expenseTotals) Object.keys(book.expenseTotals).forEach((cat) => add('Gastos: ' + cat, book.expenses.filter((x) => x.category === cat).reduce((a, x) => a + cents(x.amount), 0), book.expenseTotals[cat]));
    return { ok: rows.every((r) => r.ok), rows };
}

// Clave de un gasto para reconocerlo (dia, monto, categoria y proveedor); si se repite, lleva su numero de repeticion
const expenseKey = (day, amount, category, supplier) => `expense|${day}|${cents(amount)}|${category}|${supplier}`;

// El plan: lo que DEBE haber en el sistema segun el libro.
// options: { prefix, source, nowIso, currentPeriod, sheetDay, year }
export function buildTarget(book, options) {
    const { prefix, source, nowIso, currentPeriod, sheetDay } = options;
    const year = options.year || 2026;
    const base = (resiId) => ({ resiId, created_at: nowIso, updated_at: nowIso, loadedFrom: source, serverGenerated: true });
    const houses = [];
    const items = [];
    book.casas.forEach((c) => {
        const id = prefix + c.casa;
        houses.push({ id, casa: c.casa, name: c.name });
        MONTHS.forEach((_, i) => {
            const period = periodOf(year, i);
            const tariff = TARIFF[i];
            const paid = c.months[i];
            if (period <= currentPeriod) {
                const breakdown = { maintenance: tariff };
                items.push({
                    key: `fee|${id}|${period}`, resiId: id,
                    tx: { ...base(id), id: `fee_${id}_${period}`, type: 'charge', kind: 'fee', manual: true, auto: false, period, date: noonGt(`${period}-01`), amount: tariff, concept: SisdelCuotas.describe(breakdown, 'GTQ', period), breakdown, retro: period < currentPeriod }
                });
            }
            if (paid > 0) {
                const day = `${period}-15` <= sheetDay ? `${period}-15` : sheetDay;
                const partial = paid < tariff - 0.004;
                items.push({
                    key: `pay|${id}|${period}`, resiId: id,
                    tx: { ...base(id), id: `pago_${id}_${period}`, type: 'income', amount: paid, date: noonGt(day), concept: `${partial ? 'Abono' : 'Pago'} de mantenimiento correspondiente a ${SisdelCuotas.monthLabel(period) || period}${partial ? ' (parcial)' : ''}${period > currentPeriod ? ' (adelantado)' : ''}` }
                });
            }
        });
        if (c.y2025 > 0) {
            items.push({ key: `arrears|${id}`, resiId: id, tx: { ...base(id), id: `atrasado${year - 1}_${id}`, type: 'charge', kind: 'extra', manual: true, auto: false, date: noonGt(`${year - 1}-12-31`), amount: c.y2025, concept: `Cuotas atrasadas de ${year - 1} (pagadas en ${year})` } });
            items.push({ key: `arrearspay|${id}`, resiId: id, tx: { ...base(id), id: `pago${year - 1}_${id}`, type: 'income', date: noonGt(`${year}-01-15` <= sheetDay ? `${year}-01-15` : sheetDay), amount: c.y2025, concept: `Pago de cuotas atrasadas de ${year - 1}` } });
        }
        if (c.y2027 > 0) items.push({ key: `ahead|${id}`, resiId: id, tx: { ...base(id), id: `pago${year + 1}_${id}`, type: 'income', date: noonGt(sheetDay), amount: c.y2027, concept: `Pago adelantado de cuotas de ${year + 1}` } });
        if (c.abono > 0) items.push({ key: `abono|${id}`, resiId: id, tx: { ...base(id), id: `abono_${id}`, type: 'income', date: noonGt(sheetDay), amount: c.abono, concept: 'Abono a cuotas pendientes' } });
    });
    // Gastos: del mas antiguo al mas nuevo, con su numero de referencia (EG0001...)
    const seenExpense = new Map();
    [...book.expenses].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.row - b.row)).forEach((x, n) => {
        const k = expenseKey(x.day, x.amount, x.category, x.supplier);
        const times = (seenExpense.get(k) || 0) + 1;
        seenExpense.set(k, times);
        items.push({
            key: `${k}|#${times}`, resiId: null,
            tx: {
                id: `gasto_${year}_${String(n + 1).padStart(3, '0')}`, type: 'expense', amount: x.amount, date: noonGt(x.day), concept: x.category,
                ...(x.supplier ? { notes: `Proveedor: ${x.supplier}` } : {}),
                ...(x.doc && !/^s\/?n$/i.test(x.doc) ? { docNum: x.doc } : {}),
                receiptNum: 'EG' + String(n + 1).padStart(4, '0'), created_at: nowIso, updated_at: nowIso, loadedFrom: source
            }
        });
    });
    return { houses, items };
}

// La clave con que se reconoce un movimiento que ya esta en la base (los de una carga anterior y los de la cuota automatica).
// `counts` lleva la cuenta de gastos repetidos. Devuelve null si no se reconoce (p. ej. un pago hecho a mano en OIKOS).
export function keyOfExisting(t, prefix, options = {}, counts = new Map()) {
    if (!t || t.deleted) return null;
    const year = options.year || 2026;
    const id = String(t.id || '');
    const owner = String(t.resiId || '');
    if (t.type === 'charge' && t.kind === 'fee' && /^\d{4}-\d{2}$/.test(String(t.period || '')) && owner.startsWith(prefix)) return `fee|${owner}|${t.period}`;
    const pay = /^pago_(.+)_(\d{4}-\d{2})(?:_r\d+)?$/.exec(id);
    if (t.type === 'income' && pay && owner === pay[1]) return `pay|${pay[1]}|${pay[2]}`;
    const arrears = /^atrasado\d{4}_(.+?)(?:_r\d+)?$/.exec(id);
    if (t.type === 'charge' && arrears && owner === arrears[1]) return `arrears|${owner}`;
    const yearly = /^pago(\d{4})_(.+?)(?:_r\d+)?$/.exec(id);
    if (t.type === 'income' && yearly && owner === yearly[2]) return Number(yearly[1]) < year ? `arrearspay|${owner}` : `ahead|${owner}`;
    const abono = /^abono_(.+?)(?:_r\d+)?$/.exec(id);
    if (t.type === 'income' && abono && owner === abono[1]) return `abono|${owner}`;
    if (t.type === 'expense' && /^gasto_/.test(id)) {
        const supplier = String(t.notes || '').replace(/^Proveedor:\s*/, '');
        const k = expenseKey(String(t.date || '').slice(0, 10), t.amount, t.concept, supplier);
        const times = (counts.get(k) || 0) + 1;
        counts.set(k, times);
        return `${k}|#${times}`;
    }
    return null;
}

// Compara lo que debe haber con lo que ya hay. existing: movimientos de la base (con id).
// Devuelve { keep, create, annul, unknown, stats }: `unknown` son movimientos vivos que no se reconocen (no se tocan).
export function diffTarget(target, existing, options) {
    const { prefix, reason } = options;
    const live = existing.filter((t) => !t.deleted).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const byKey = new Map();
    const unknown = [];
    const counts = new Map();
    live.forEach((t) => {
        const key = keyOfExisting(t, prefix, options, counts);
        if (!key) { unknown.push(t); return; }
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(t);
    });
    const usedIds = new Set(existing.map((t) => t.id));
    const brief = (t) => ({ id: t.id, resiId: t.resiId || null, amount: t.amount, type: t.type, concept: t.concept || '', reason });
    const create = [];
    const keep = [];
    const annul = [];
    const wanted = new Set();
    target.items.forEach((item) => {
        wanted.add(item.key);
        const found = byKey.get(item.key) || [];
        const same = found.find((t) => cents(t.amount) === cents(item.tx.amount));
        found.forEach((t) => { if (t !== same) annul.push(brief(t)); });
        if (same) { keep.push({ key: item.key, id: same.id }); return; }
        // Entra el nuevo, con otro id si el suyo ya esta ocupado por uno anulado o distinto
        let id = item.tx.id;
        let n = 1;
        while (usedIds.has(id)) id = `${item.tx.id}_r${n++}`;
        usedIds.add(id);
        create.push({ ...item.tx, id });
    });
    // Lo que ya esta y el libro no dice
    byKey.forEach((list, key) => { if (!wanted.has(key)) list.forEach((t) => annul.push(brief(t))); });
    return { keep, create, annul, unknown, stats: { keep: keep.length, create: create.length, annul: annul.length, unknown: unknown.length } };
}

// Lo que quedaria vivo: los que se dejan, los nuevos y los que no se reconocen
export function finalLedger(existing, diff) {
    const gone = new Set(diff.annul.map((a) => a.id));
    return existing.filter((t) => !t.deleted && !gone.has(t.id)).concat(diff.create);
}
