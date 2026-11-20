// Reemplaza los datos de cobros y gastos de un condominio con SU libro de Excel (ver lib-excel-cobros.mjs). Se hizo para
// Residenciales Delco II (2026-11-20): "reemplazar con los datos del archivo todos los datos... que en la Tabla general esten en
// verde los meses pagados y en rojo los meses en mora".
//
//   node reemplazar-cobros-excel.mjs --archivo=RUTA.xlsx --condo=ID [--prefijo=delco-] [--dia-hoja=AAAA-MM-DD]
//        [--target=emulator|prod] [--carpeta=DIR] [--hoy=AAAA-MM-DD] [--aplicar] [--confirmo="REEMPLAZAR DATOS <NOMBRE>"]
//
// Sin --aplicar es un SIMULACRO: lee el libro y la base, compara y deja el informe, sin escribir nada. El libro (nombres de
// personas, proveedores) y el informe van FUERA de cualquier repositorio (el repo es publico).
// Con --aplicar: primero guarda un RESPALDO de lo que hay; despues escribe, casa por casa, las cuotas y pagos que faltan o
// cambiaron (y ANULA con su motivo, nunca borra, lo que ya no coincide), los gastos y los nombres que cambiaron; avisa al
// servidor para que recalcule a cada vecino y, al final, vuelve a leer la base y comprueba que diga lo mismo que el libro. En la
// nube pide --confirmo con el nombre del condominio. Se puede volver a correr: lo que ya esta hecho no se repite.
// Lo que no se reconoce (por ejemplo un pago registrado a mano en OIKOS) no se toca.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readXlsx } from './lib-xlsx.mjs';
import { readCobrosWorkbook, checkTotals, buildTarget, diffTarget, finalLedger, MONTHS, TARIFF } from './lib-excel-cobros.mjs';
import { cents, fromCents } from './lib-saldos-reales.mjs';
import { connect, parseArgs } from './admin.mjs';

const require = createRequire(import.meta.url);
const serverMora = require('../functions/src/finanzas/mora.js');

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const apply = args.aplicar === true;
if (!args.archivo || args.archivo === true || !args.condo || args.condo === true) {
    console.error('Uso: node reemplazar-cobros-excel.mjs --archivo=RUTA.xlsx --condo=ID [--prefijo=delco-] [--dia-hoja=AAAA-MM-DD] [--target=emulator|prod] [--aplicar] [--confirmo="REEMPLAZAR DATOS <NOMBRE>"]');
    process.exit(1);
}
const condoId = String(args.condo);
const prefix = String(args.prefijo && args.prefijo !== true ? args.prefijo : 'delco-');
const year = Number(args.anio) || 2026;

function insideGit(folder) {
    let dir = path.resolve(folder);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}
const money = (n) => 'Q' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gtNow = () => new Date(Date.now() - 6 * 3600 * 1000);
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, header, rows) => fs.writeFileSync(file, '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', { mode: 0o600 });
const plainName = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const sumBy = (list, f) => fromCents(list.reduce((a, t) => a + cents(f(t)), 0));

if (insideGit(path.dirname(path.resolve(args.archivo)))) { console.error('El libro trae nombres de personas: no debe estar dentro de un repositorio.'); process.exit(1); }

const today = /^\d{4}-\d{2}-\d{2}$/.test(String(args.hoy || '')) ? String(args.hoy) : gtNow().toISOString().slice(0, 10);
const currentPeriod = today.slice(0, 7);
const sheetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(args['dia-hoja'] || '')) ? String(args['dia-hoja']) : '2026-11-16';
if (sheetDay > today) { console.error(`--dia-hoja (${sheetDay}) no puede ser despues de hoy (${today}).`); process.exit(1); }
const source = `libro de cobros y gastos ${year} (${sheetDay})`;
const reason = `Reemplazado con el libro de cobros y gastos ${year} (${today})`;

// ── 1. El libro ──
const book = readCobrosWorkbook(readXlsx(path.resolve(args.archivo)), { year, today });
if (book.problems.length) { console.error('El libro tiene problemas:\n - ' + book.problems.join('\n - ')); process.exit(1); }
const totals = checkTotals(book);
if (!totals.ok) { console.error('El libro no cuadra con sus propios totales:\n' + totals.rows.filter((r) => !r.ok).map((r) => `  ${r.label}: suma ${r.got}, la hoja dice ${r.expected}`).join('\n')); process.exit(1); }

// ── 2. La base (solo lectura) ──
const db = connect(target);
const condoRef = db.doc(`condominios/${condoId}`);
const condoSnap = await condoRef.get();
if (!condoSnap.exists) { console.error(`No existe el condominio ${condoId} en ${target}.`); process.exit(1); }
const condoName = condoSnap.get('name') || condoId;
const docsOf = async (col) => (await condoRef.collection(col).get()).docs.map((d) => ({ ...d.data(), id: d.id }));
const readAll = async () => ({
    users: (await docsOf('usuarios')).filter((u) => u.role === 'vecino'),
    fichas: await docsOf('finanzas_residentes'),
    movements: await docsOf('finanzas_movimientos'),
    settings: ((await condoRef.collection('finanzas_config').doc('oikos_settings').get()).data()) || {}
});
let existing = await readAll();
const nowIso = new Date().toISOString();
const planOptions = { prefix, source, nowIso, currentPeriod, sheetDay, year, reason };
const plan = (ex) => { const t = buildTarget(book, planOptions); return { target: t, diff: diffTarget(t, ex.movements, planOptions) }; };
let { target: want, diff } = plan(existing);

// Casas del libro y vecinos de la base deben ser los mismos
const usersById = new Map(existing.users.map((u) => [u.id, u]));
const missing = want.houses.filter((h) => !usersById.has(h.id)).map((h) => h.casa);
const notInBook = existing.users.filter((u) => String(u.id).startsWith(prefix) && !want.houses.some((h) => h.id === u.id)).map((u) => u.casa || u.id);
if (missing.length || notInBook.length) {
    console.error(`El libro y la base no tienen las mismas casas. En el libro y no en la base: ${missing.join(' ') || '(ninguna)'}. En la base y no en el libro: ${notInBook.join(' ') || '(ninguna)'}. No se escribe nada: decidir antes que hacer con ellas.`);
    process.exit(1);
}
const nameChanges = want.houses.filter((h) => plainName(usersById.get(h.id).name) !== plainName(h.name)).map((h) => ({ id: h.id, casa: h.casa, before: usersById.get(h.id).name, after: h.name }));

// ── 3. Como quedaria cada casa ──
const finalTxs = finalLedger(existing.movements, diff);
const now = new Date();
const settingsForMora = existing.settings;
const houseRows = book.casas.map((c) => {
    const id = prefix + c.casa;
    const txs = finalTxs.filter((t) => String(t.resiId) === id);
    const fees = txs.filter((t) => t.type === 'charge' && t.kind === 'fee' && t.period <= currentPeriod);
    const extraCharges = txs.filter((t) => t.type === 'charge' && t.kind !== 'fee');
    const incomes = txs.filter((t) => t.type === 'income');
    const feesTotal = sumBy(fees, (t) => t.amount);
    const owedTotal = feesTotal + sumBy(extraCharges, (t) => t.amount);
    const paid = sumBy(incomes, (t) => t.amount);
    const balance = Math.round((paid - owedTotal) * 100) / 100;
    const excelPaid = fromCents(cents(c.y2025) + c.months.reduce((a, m) => a + cents(m), 0) + cents(c.y2027) + cents(c.abono));
    const excelFees = fromCents(TARIFF.reduce((a, tarifa, i) => a + (`${year}-${String(i + 1).padStart(2, '0')}` <= currentPeriod ? cents(tarifa) : 0), 0));
    const blanks = MONTHS.map((_, i) => i).filter((i) => `${year}-${String(i + 1).padStart(2, '0')}` <= currentPeriod && c.months[i] === 0).length;
    const moroso = serverMora.moraOf(id, txs.map((t) => ({ ...t })), settingsForMora, now, null).moroso;
    return { casa: c.casa, id, name: c.name, paid, excelPaid, fees: feesTotal, excelFees, balance, blanks, moroso, same: Math.abs(paid - excelPaid) < 0.005 && Math.abs(feesTotal - excelFees) < 0.005 };
});
const differing = houseRows.filter((r) => !r.same);
const expensesFinal = finalTxs.filter((t) => t.type === 'expense' && t.loadedFrom === source);
const expensesBook = sumBy(book.expenses, (x) => x.amount);

// ── 4. Informe (fuera del repositorio) ──
const stamp = gtNow().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
const folder = path.resolve(args.carpeta || path.join(os.homedir(), 'Desktop', `DELCO II reemplazo ${stamp}`));
if (insideGit(folder)) { console.error(`No se guarda el informe en ${folder}: esta dentro de un repositorio y trae datos personales. Use --carpeta=...`); process.exit(1); }
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const st = diff.stats;
const money2 = (list, f) => money(sumBy(list, f));
const summary = [
    `Reemplazo de datos de ${condoName} (${apply ? 'APLICADO en ' + target : 'SIMULACRO en ' + target + ', nada escrito'}) - ${new Date().toLocaleString('es-GT')}`,
    `Libro: ${path.basename(args.archivo)} | hoy ${today} | pagos adelantados fechados ${sheetDay}`,
    '',
    `LIBRO: ${book.casas.length} casas | cuotas pagadas 2026 ${money(book.casas.reduce((a, c) => a + c.months.reduce((x, y) => x + y, 0), 0))} + atrasos de 2025 ${money(book.casas.reduce((a, c) => a + c.y2025, 0))} + adelantos 2027 ${money(book.casas.reduce((a, c) => a + c.y2027, 0))} + abonos sueltos ${money(book.casas.reduce((a, c) => a + c.abono, 0))} | ${book.expenses.length} gastos por ${money(expensesBook)}`,
    `  Cuadra con las filas de totales del propio libro: SI (${totals.rows.length} totales)`,
    '',
    'LO QUE SE ESCRIBE',
    `  Ya estaba igual (se deja): ${st.keep}`,
    `  Se CREAN: ${st.create} movimientos (cuotas ${money2(diff.create.filter((t) => t.type === 'charge'), (t) => t.amount)} | pagos ${money2(diff.create.filter((t) => t.type === 'income'), (t) => t.amount)} | gastos ${money2(diff.create.filter((t) => t.type === 'expense'), (t) => t.amount)})`,
    `  Se ANULAN (con motivo, nada se borra): ${st.annul} movimientos (${money2(diff.annul, (t) => t.amount)})`,
    `  Vivos que no se reconocen y NO se tocan: ${st.unknown}${st.unknown ? ' (' + diff.unknown.map((t) => `${t.id}:${t.amount}`).slice(0, 8).join(' ') + ')' : ''}`,
    `  Nombres que cambian (el libro manda): ${nameChanges.length}`,
    '',
    `COMO QUEDA (hoy ${today}, cuotas de enero a ${currentPeriod})`,
    `  Pagos que quedan: ${money(sumBy(houseRows, (r) => r.paid))} | cuotas y cargos: ${money(sumBy(houseRows, (r) => r.fees))} | gastos: ${money(sumBy(expensesFinal, (t) => t.amount))} (${expensesFinal.length}; el libro dice ${money(expensesBook)})`,
    `  Casas con saldo en contra: ${houseRows.filter((r) => r.balance < -0.004).length} (${money(-sumBy(houseRows.filter((r) => r.balance < -0.004), (r) => r.balance))}) | con saldo a favor: ${houseRows.filter((r) => r.balance > 0.004).length} (${money(sumBy(houseRows.filter((r) => r.balance > 0.004), (r) => r.balance))}) | al dia: ${houseRows.filter((r) => Math.abs(r.balance) <= 0.004).length}`,
    `  Morosos para la garita (deben mas de una cuota vencida): ${houseRows.filter((r) => r.moroso).length}`,
    `  CASAS QUE NO DAN LO DEL LIBRO (pagado o cuotas): ${differing.length}${differing.length ? ' -> ' + differing.map((r) => r.casa).join(' ') : ' (cuadran todas)'}`,
    ''
];
fs.writeFileSync(path.join(folder, 'resumen.txt'), summary.join('\n'), { mode: 0o600 });
writeCsv(path.join(folder, 'casas.csv'), ['Casa', 'Nombre', 'Libro: pagado', 'Queda: pagado', 'Cuotas hasta hoy', 'Saldo (a favor +, en contra -)', 'Meses en blanco', 'Moroso (garita)', 'Cuadra'],
    houseRows.map((r) => [r.casa, r.name, r.excelPaid, r.paid, r.fees, r.balance, r.blanks, r.moroso ? 'si' : 'no', r.same ? 'si' : 'NO']));
writeCsv(path.join(folder, 'cambios.csv'), ['Accion', 'Id', 'Casa', 'Tipo', 'Monto', 'Concepto'],
    [...diff.create.map((t) => ['crear', t.id, String(t.resiId || '').replace(prefix, ''), t.type, t.amount, t.concept]),
        ...diff.annul.map((t) => ['anular', t.id, String(t.resiId || '').replace(prefix, ''), t.type, t.amount, t.concept]),
        ...nameChanges.map((n) => ['nombre', n.id, n.casa, 'nombre', '', `${n.before} -> ${n.after}`])]);
console.log(summary.join('\n'));
console.log(`Informe: ${folder}`);
if (!apply) { console.log('SIMULACRO: no se escribio nada. Para escribir: --aplicar' + (target === 'prod' ? ` --confirmo="REEMPLAZAR DATOS ${condoName}"` : '')); process.exit(0); }
if (differing.length) { console.error('No se aplica: hay casas que no dan lo del libro.'); process.exit(1); }
if (target === 'prod' && args.confirmo !== `REEMPLAZAR DATOS ${condoName}`) { console.error(`En la nube hay que confirmar con --confirmo="REEMPLAZAR DATOS ${condoName}".`); process.exit(1); }

// ── 5. Respaldo de lo que hay (antes de tocar nada) ──
const backupFile = path.join(folder, `respaldo-${condoId}-antes.json`);
fs.writeFileSync(backupFile, JSON.stringify({ condo: condoId, name: condoName, at: nowIso, target, ...existing }), { mode: 0o600 });
console.log(`Respaldo: ${backupFile}`);

// ── 6. Escribir ──
const movRef = (id) => condoRef.collection('finanzas_movimientos').doc(id);
async function commitAll(ops, label) {
    for (let i = 0; i < ops.length; i += 400) {
        const batch = db.batch();
        ops.slice(i, i + 400).forEach((op) => op(batch));
        await batch.commit();
    }
    if (label) console.log(label);
}
const annulOp = (a) => (b) => b.update(movRef(a.id), { deleted: true, deleted_at: nowIso, deleted_reason: a.reason, updated_at: nowIso });
// 6.1 Casa por casa: primero lo nuevo y las anulaciones en la misma tanda (el servidor recalcula a ese vecino con todo ya escrito)
const houseIds = [...new Set([...diff.create.map((t) => t.resiId), ...diff.annul.map((a) => a.resiId)].filter(Boolean))];
let done = 0;
for (const id of houseIds) {
    await commitAll(diff.create.filter((t) => t.resiId === id).map((t) => (b) => b.create(movRef(t.id), t)).concat(diff.annul.filter((a) => a.resiId === id).map(annulOp)));
    if (++done % 20 === 0) console.log(`  ${done} de ${houseIds.length} casas`);
}
// 6.2 Gastos (sin casa)
await commitAll(diff.create.filter((t) => !t.resiId).map((t) => (b) => b.create(movRef(t.id), t)).concat(diff.annul.filter((a) => !a.resiId).map(annulOp)), `Gastos: ${diff.create.filter((t) => !t.resiId).length} creados, ${diff.annul.filter((a) => !a.resiId).length} anulados`);
// 6.3 Nombres
await commitAll(nameChanges.map((n) => (b) => b.update(condoRef.collection('usuarios').doc(n.id), { name: n.after, updatedAt: nowIso })), `Nombres cambiados: ${nameChanges.length}`);
console.log(`Movimientos: ${diff.create.length} creados y ${diff.annul.length} anulados en ${houseIds.length} casas.`);

// 6.4 Avisar al servidor: los movimientos nuevos llevan serverGenerated (no disparan el recalculo uno por uno), asi que
// se toca una vez el sello de actualizacion de un movimiento de cada casa cambiada y el servidor la recalcula completa
let kicked = 0;
for (const id of houseIds) {
    const target1 = diff.create.find((t) => t.resiId === id);
    if (!target1) continue;
    await movRef(target1.id).update({ updated_at: new Date().toISOString() });
    kicked++;
}
console.log(`Servidor avisado para ${kicked} casas (recalcula quien es moroso).`);

// ── 7. Comprobar con lo que quedo en la base ──
existing = await readAll();
({ target: want, diff } = plan(existing));
const pendingWork = diff.create.length + diff.annul.length;
const check = [
    '',
    `COMPROBADO EN LA BASE (${target}): trabajo pendiente: ${pendingWork} (debe ser 0) | movimientos vivos: ${existing.movements.filter((t) => !t.deleted).length}`,
    `  Pagos ${money(sumBy(existing.movements.filter((t) => !t.deleted && t.type === 'income'), (t) => t.amount))} | gastos ${money(sumBy(existing.movements.filter((t) => !t.deleted && t.type === 'expense'), (t) => t.amount))}`,
    '  (el servidor recalcula a cada vecino en unos minutos; quien es moroso lo escribe el servidor)'
];
fs.appendFileSync(path.join(folder, 'resumen.txt'), check.join('\n') + '\n');
console.log(check.join('\n'));
process.exit(pendingWork ? 1 : 0);
