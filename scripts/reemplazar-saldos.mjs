// Reemplaza los saldos de un condominio con una hoja de "saldos reales" (ver lib-saldos-reales.mjs). Se hizo para La Perla
// (2026-11-20): "la base de datos que se subio tiene muchos errores; subela completa reemplazando la que ya esta".
//
//   node reemplazar-saldos.mjs --archivo=RUTA.xlsx --condo=ID --prefijo=perla- --corte=2026-11-09 --fuente="saldos reales al 9/11/2026"
//        [--target=emulator|prod] [--carpeta=DIR] [--hoy=AAAA-MM-DD] [--aplicar] [--confirmo="REEMPLAZAR SALDOS <NOMBRE>"]
//
// Sin --aplicar es un SIMULACRO: lee la hoja y la base, arma el reemplazo, lo cuadra lote por lote contra la hoja y deja el
// informe, sin escribir nada. El libro (nombres de personas) y el informe van FUERA de cualquier repositorio (el repo es
// publico).
// Con --aplicar: primero guarda un RESPALDO de lo que hay (movimientos, fichas, vecinos y configuracion) en la carpeta del
// informe; despues escribe fichas (cobra desde este mes, tipo, agua, notas) y fases, y lote por lote las cuotas pendientes,
// el saldo a favor y las cuotas de este mes que falten, y ANULA (nunca borra) lo de la carga anterior con su motivo. Al final
// vuelve a leer la base y comprueba que cada lote diga lo mismo que la hoja. En la nube pide --confirmo con el nombre del
// condominio. Se puede volver a correr: lo que ya esta hecho no se repite (retoma una carga cortada).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readXlsx } from './lib-xlsx.mjs';
import { readSaldosWorkbook, buildReplacement, simulate, cents, fromCents } from './lib-saldos-reales.mjs';
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const apply = args.aplicar === true;
const need = ['archivo', 'condo', 'prefijo', 'corte', 'fuente'];
if (need.some((k) => !args[k] || args[k] === true) || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.corte))) {
    console.error('Uso: node reemplazar-saldos.mjs --archivo=RUTA.xlsx --condo=ID --prefijo=perla- --corte=AAAA-MM-DD --fuente="texto" [--target=emulator|prod] [--aplicar] [--confirmo="REEMPLAZAR SALDOS <NOMBRE>"]');
    process.exit(1);
}
const condoId = String(args.condo);
const prefix = String(args.prefijo);
const cut = String(args.corte);
const source = String(args.fuente);

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

if (insideGit(path.dirname(path.resolve(args.archivo)))) { console.error('El libro trae nombres de personas: no debe estar dentro de un repositorio.'); process.exit(1); }

// ── 1. La hoja ──
const sheet = readSaldosWorkbook(readXlsx(path.resolve(args.archivo)));
if (sheet.problems.length) { console.error('La hoja tiene problemas:\n - ' + sheet.problems.join('\n - ')); process.exit(1); }

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
const today = /^\d{4}-\d{2}-\d{2}$/.test(String(args.hoy || '')) ? String(args.hoy) : gtNow().toISOString().slice(0, 10);
const currentPeriod = today.slice(0, 7);
const nowIso = new Date().toISOString();
const buildPlan = (ex) => buildReplacement({ sheet, existing: ex, settings: ex.settings, prefix, cut, source, nowIso, currentPeriod });
let plan = buildPlan(existing);
if (plan.problems.length) { console.error('No se puede armar el reemplazo:\n - ' + plan.problems.join('\n - ')); process.exit(1); }
const fichaAfter = (ex, p) => { const m = new Map(ex.fichas.map((f) => [f.id, f])); p.fichas.forEach((u) => m.set(u.id, { ...(m.get(u.id) || {}), ...u.data })); return m; };
let after = fichaAfter(existing, plan);
const sim = simulate(plan, existing.movements, existing.settings, { cut, asOf: today, sheet, prefix, fichaOf: (id) => after.get(id) });

// Nombres: la hoja y la base deben hablar del mismo propietario (si no, se avisa; no se cambia ningun nombre)
const usersById = new Map(existing.users.map((u) => [u.id, u]));
const otherName = [...sheet.lots.values()].filter((l) => usersById.has(prefix + l.lot) && plainName(usersById.get(prefix + l.lot).name) !== plainName(l.name)).map((l) => l.lot);

// ── 3. Informe (fuera del repositorio) ──
const stamp = gtNow().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
const folder = path.resolve(args.carpeta || path.join(os.homedir(), 'Desktop', `SALDOS ${condoName} ${stamp}`));
if (insideGit(folder)) { console.error(`No se guarda el informe en ${folder}: esta dentro de un repositorio y trae datos personales. Use --carpeta=...`); process.exit(1); }
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const st = plan.stats;
const sum = (rows, k) => fromCents(rows.reduce((a, r) => a + cents(r[k]), 0));
const summary = [
    `Reemplazo de saldos de ${condoName} (${apply ? 'APLICADO en ' + target : 'SIMULACRO en ' + target + ', nada escrito'}) - ${new Date().toLocaleString('es-GT')}`,
    `Hoja: ${path.basename(args.archivo)} | corte ${cut} | fuente "${source}" | hoy ${today}`,
    '',
    `HOJA: ${sheet.lots.size} lotes | cuotas pendientes ${money(sheet.totals.pend)} + mora ${money(sheet.totals.mora)} = ${money(sheet.totals.total)} | saldo a favor ${money(sheet.totals.favor)} | por aclarar (no se carga) ${money(sheet.totals.aclarar)}`,
    '',
    'LO QUE SE ESCRIBE',
    `  Cuotas pendientes (una por lote y mes, con su mora al corte): ${st.cuotas} (${money(fromCents(st.cuotasAmount))}, mora ${money(fromCents(st.mora))}; ${st.exempt} con la mora exonerada)`,
    `  Saldos a favor (no son dinero de la caja): ${st.credits} (${money(fromCents(st.creditAmount))})`,
    `  Cuotas de este mes o siguientes que faltaban (o cambian por el agua): ${st.newFees} (${money(fromCents(st.newFeesAmount))})`,
    `  Se ANULAN (con motivo, nada se borra): ${st.annulled} movimientos (${money(fromCents(st.annulledAmount))})`,
    `  Fichas: ${plan.fichas.length} (tipo ${st.types}, agua ${st.waters}, notas ${st.notes}; todas cobran desde ${currentPeriod}) | fases: ${st.fases}`,
    `  Ya hecho antes (no se repite): ${st.skippedExisting}`,
    '',
    'CUADRE CONTRA LA HOJA (al corte, solo las cuotas de la hoja)',
    `  Cuotas ${money(sum(sim.rows, 'cutCapital'))} | mora ${money(sum(sim.rows, 'cutMora'))} | lotes que no dan lo de la hoja: ${sim.mismatches} ${sim.mismatches ? '(REVISAR antes de cargar)' : '(CUADRA lote por lote)'}`,
    '',
    `COMO QUEDA EL SISTEMA HOY (${today}, con la cuota de ${currentPeriod} y los saldos a favor)`,
    `  Cuotas y cargos que deben ${money(sum(sim.rows, 'capital'))} | mora ${money(sum(sim.rows, 'mora'))} | saldo a favor que queda ${money(sum(sim.rows, 'credit'))} en ${sim.rows.filter((r) => r.credit > 0.004).length} lotes`,
    `  Morosos para la garita (deben mas de una cuota vencida): ${sim.rows.filter((r) => r.moroso).length} | deben algo: ${sim.rows.filter((r) => r.balance < -0.004).length}`,
    ...(otherName.length ? ['', `AVISO: ${otherName.length} lotes tienen otro nombre en la base (no se cambia ningun nombre): ${otherName.join(' ')}`] : []),
    ''
];
fs.writeFileSync(path.join(folder, 'resumen.txt'), summary.join('\n'), { mode: 0o600 });
writeCsv(path.join(folder, 'lotes.csv'), ['Lote', 'Hoja: cuotas', 'Hoja: mora', 'Hoja: saldo a favor', 'Al corte: cuotas', 'Al corte: mora', 'Igual a la hoja', 'Hoy: cuotas y cargos', 'Hoy: vencido', 'Hoy: mora', 'Hoy: saldo a favor', 'Moroso (garita)'],
    sim.rows.map((r) => [r.lot, r.sheetPend, r.sheetMora, r.sheetFavor, r.cutCapital, r.cutMora, r.same ? 'si' : 'NO', r.capital, r.overdue, r.mora, r.credit, r.moroso ? 'si' : 'no']));
console.log(summary.join('\n'));
console.log(`Informe: ${folder}`);
if (!apply) { console.log('SIMULACRO: no se escribio nada. Para escribir: --aplicar' + (target === 'prod' ? ` --confirmo="REEMPLAZAR SALDOS ${condoName}"` : '')); process.exit(0); }
if (sim.mismatches) { console.error('No se aplica: hay lotes que no dan lo de la hoja.'); process.exit(1); }
if (target === 'prod' && args.confirmo !== `REEMPLAZAR SALDOS ${condoName}`) { console.error(`En la nube hay que confirmar con --confirmo="REEMPLAZAR SALDOS ${condoName}".`); process.exit(1); }

// ── 4. Respaldo de lo que hay (antes de tocar nada) ──
const backupFile = path.join(folder, `respaldo-${condoId}-antes.json`);
fs.writeFileSync(backupFile, JSON.stringify({ condo: condoId, name: condoName, at: nowIso, target, ...existing }), { mode: 0o600 });
console.log(`Respaldo: ${backupFile}`);

// ── 5. Escribir ──
const movRef = (id) => condoRef.collection('finanzas_movimientos').doc(id);
async function commitAll(ops, label) {
    for (let i = 0; i < ops.length; i += 450) {
        const batch = db.batch();
        ops.slice(i, i + 450).forEach((op) => op(batch));
        await batch.commit();
    }
    if (label) console.log(label);
}
// 5.1 Fichas y fases primero: el recalculo del servidor lee la ficha del lote (su agua y desde cuando cobra)
await commitAll(plan.fichas.map((f) => (b) => b.set(condoRef.collection('finanzas_residentes').doc(f.id), f.data, { merge: true })), `Fichas: ${plan.fichas.length}`);
await commitAll(plan.users.map((u) => (b) => b.update(condoRef.collection('usuarios').doc(u.id), u.data)), `Fases: ${plan.users.length}`);
// 5.2 Lote por lote: primero lo nuevo y despues las anulaciones (que disparan el recalculo de ese vecino con todo ya escrito)
const lots = [...new Set([...plan.creates.map((t) => t.resiId), ...plan.annuls.map((a) => a.resiId)])];
let done = 0;
for (const id of lots) {
    const ops = plan.creates.filter((t) => t.resiId === id).map((t) => (b) => b.create(movRef(t.id), t))
        .concat(plan.annuls.filter((a) => a.resiId === id).map((a) => (b) => b.update(movRef(a.id), { deleted: true, deleted_at: nowIso, deleted_reason: a.reason, updated_at: nowIso })));
    await commitAll(ops);
    if (++done % 50 === 0) console.log(`  ${done} de ${lots.length} lotes`);
}
console.log(`Movimientos: ${plan.creates.length} creados y ${plan.annuls.length} anulados en ${lots.length} lotes.`);

// ── 6. Comprobar con lo que quedo en la base ──
existing = await readAll();
plan = buildPlan(existing);
after = fichaAfter(existing, plan);
const check = simulate({ ...plan, creates: [], annuls: [] }, existing.movements, existing.settings, { cut, asOf: today, sheet, prefix, fichaOf: (id) => after.get(id) });
const pendingWork = plan.creates.length + plan.annuls.length + plan.fichas.length + plan.users.length;
const result = [
    '',
    `COMPROBADO EN LA BASE (${target}): lotes que no dan lo de la hoja: ${check.mismatches} | trabajo pendiente: ${pendingWork}`,
    `  Cuotas al corte ${money(sum(check.rows, 'cutCapital'))} | mora al corte ${money(sum(check.rows, 'cutMora'))}`,
    `  Hoy: deben ${money(sum(check.rows, 'capital'))} + mora ${money(sum(check.rows, 'mora'))} | saldo a favor ${money(sum(check.rows, 'credit'))} | morosos ${check.rows.filter((r) => r.moroso).length}`,
    '  (el servidor recalcula a cada vecino en unos minutos; quien es moroso lo escribe el servidor)'
];
fs.appendFileSync(path.join(folder, 'resumen.txt'), result.join('\n') + '\n');
console.log(result.join('\n'));
process.exit(check.mismatches || pendingWork ? 1 : 0);
