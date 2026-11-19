// Carga de un condominio desde una hoja de cobros (ver lib-hoja-cobros.mjs). Se uso con Residenciales Delco II.
//
//   node cargar-hoja-cobros.mjs --datos=RUTA.json --condo=ID [--target=emulator|prod] [--carpeta=DIR]
//        [--pendientes] [--aplicar] [--confirmo="CARGAR <NOMBRE DEL CONDOMINIO>"] [--continuar] [--crear-condominio]
//
// Sin --aplicar es un SIMULACRO: arma la carga, la cuadra contra los totales de la hoja y deja el informe, sin tocar la base.
// El archivo de datos (nombres de personas) y el informe van FUERA de cualquier repositorio (el repo es publico).
//
// Con --aplicar escribe: cada vecino con su codigo y su ficha, sus cuotas y pagos y, por ultimo, la configuracion de la
// cuota (eso dispara el recalculo del condominio en el servidor). En la nube (--target=prod) pide ademas --confirmo con el
// nombre del condominio y comprueba que sea el mismo de la base. No carga encima de vecinos que no sean de esta carga;
// con --continuar retoma una carga cortada (salta lo que ya esta). No toca la garita, la mora ni la clave de nadie.
// Con --pendientes, ademas, cada mes ya vencido sin pago (y sin duda) se carga como cuota pendiente: se ve en rojo y quien
// debe mas de una cuota pasa a moroso (el resumen dice cuantos). Para sumarlas a una carga ya hecha: --pendientes --continuar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSheet, buildPlan, reconcile, morosos, accessCodeFor, MONTHS } from './lib-hoja-cobros.mjs';
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const apply = args.aplicar === true;
if (!args.datos || !args.condo) {
    console.error('Uso: node cargar-hoja-cobros.mjs --datos=RUTA.json --condo=ID [--target=emulator|prod] [--aplicar]');
    process.exit(1);
}
const condoId = String(args.condo);

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
const plain = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

if (insideGit(path.dirname(path.resolve(args.datos)))) { console.error('El archivo de datos trae nombres de personas: no debe estar dentro de un repositorio.'); process.exit(1); }
const sheet = JSON.parse(fs.readFileSync(args.datos, 'utf8'));
const problems = validateSheet(sheet);
if (problems.length) { console.error('El archivo de datos tiene problemas:\n - ' + problems.join('\n - ')); process.exit(1); }

// ── 1. Armar y cuadrar ──
const nowIso = new Date().toISOString();
const currentPeriod = gtNow().toISOString().slice(0, 7);
const withPending = args.pendientes === true;
const plan = buildPlan(sheet, { condoId, nowIso, currentPeriod, currency: 'GTQ', pendientes: withPending });
const rec = reconcile(sheet, plan);
const paidCharges = plan.movements.filter((t) => t.type === 'charge' && !t.pendiente);
const pendingCharges = plan.movements.filter((t) => t.pendiente);
const count = (type) => (type === 'charge' ? paidCharges : plan.movements.filter((t) => t.type === type)).length;
const sumOf = (type) => (type === 'charge' ? paidCharges : plan.movements.filter((t) => t.type === type)).reduce((s, t) => s + t.amount, 0);
const moroseHouses = withPending ? morosos(plan, { fee: Number(sheet.cuotaActual) }, new Date()) : [];
const advance = plan.movements.filter((t) => t.type === 'income' && t.id.slice(-7) > currentPeriod);

// ── 2. Informe (fuera del repositorio) ──
const stamp = gtNow().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
const folder = path.resolve(args.carpeta || path.join(os.homedir(), 'Desktop', `CARGA ${sheet.condominio} ${stamp}`));
if (insideGit(folder)) { console.error(`No se guarda el informe en ${folder}: esta dentro de un repositorio y trae datos personales. Use --carpeta=...`); process.exit(1); }
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const summary = [
    `Carga de ${sheet.condominio} (${apply ? 'APLICADA en ' + target : 'SIMULACRO, nada escrito'}) - ${new Date().toLocaleString('es-GT')}`,
    `Fuente: ${sheet.fuente || '(sin nombre)'}`,
    '',
    `Vecinos a crear: ${plan.houses.length} (con su codigo de acceso y su ficha; sin telefono ni correo)`,
    `Cuotas a crear: ${count('charge')} (${money(sumOf('charge'))}) | Pagos a crear: ${count('income')} (${money(sumOf('income'))}, de ellos ${advance.length} adelantados: ${money(advance.reduce((s, t) => s + t.amount, 0))})`,
    ...(withPending ? [`Cuotas PENDIENTES a crear (meses vencidos sin pago): ${pendingCharges.length} (${money(pendingCharges.reduce((s, t) => s + t.amount, 0))}) en ${new Set(pendingCharges.map((t) => t.resiId)).size} casas; quedarian morosas (deben mas de una cuota): ${moroseHouses.length}`] : []),
    `Celdas que NO se cargan por no ser la tarifa del mes o por estar en duda: ${plan.skippedCells.length}`,
    `Columna anterior al ano (no se carga): ${Object.keys(sheet.columnaAnterior || {}).length} casas, ${money(Object.values(sheet.columnaAnterior || {}).reduce((s, n) => s + n, 0))}`,
    '',
    'CUADRE CONTRA LOS TOTALES DE LA HOJA (cargado + lo que no se carga = total de la hoja)',
    ...rec.rows.map((r) => `  ${r.mes.padEnd(4)} cargado ${money(r.loaded).padStart(11)} | no se carga ${money(r.excluded).padStart(9)} | total de la hoja ${r.total == null ? '(ilegible)'.padStart(11) : money(r.total).padStart(11)} ${r.ok === null ? '' : r.ok ? 'OK' : 'NO CUADRA'}`),
    `  ${rec.ok ? `CUADRA: los ${rec.checked} meses con total legible coinciden.` : 'NO CUADRA: revisar antes de cargar.'}`,
    '',
    'CONDOMINIO',
    `  Cuota actual: mantenimiento ${money(sheet.cuotaActual)} al mes, sin mora; cobro manual; cada casa se cobra desde ${currentPeriod}`
];
fs.writeFileSync(path.join(folder, 'resumen.txt'), summary.join('\n') + '\n', { mode: 0o600 });
writeCsv(path.join(folder, 'casas.csv'), ['Casa', 'Id', 'Nombre', 'Cuotas cargadas', 'Pagos cargados', 'Adelantados', 'Total pagado', 'Cuotas pendientes', 'Quedaria moroso', 'Nota'],
    plan.houses.map((h) => [h.casa, h.id, h.name, h.check.charges, h.check.payments, h.check.advance, h.check.paid, h.check.pending, moroseHouses.includes(h.casa) ? 'si' : '', h.check.nota]));
writeCsv(path.join(folder, 'revisar.csv'), ['Casa', 'Mes', 'Monto', 'Por que no se carga'],
    plan.skippedCells.map((s) => [s.casa, s.mes, s.monto, s.motivo]));
console.log(summary.join('\n'));
console.log(`\nInforme: ${folder}`);

if (!apply) { console.log('\nSIMULACRO: no se escribio nada en la base. Para cargar: --aplicar'); process.exit(rec.ok ? 0 : 2); }
if (!rec.ok) { console.error('\nNo se carga: el simulacro no cuadra con la hoja.'); process.exit(2); }
const CONFIRM = `CARGAR ${sheet.condominio}`;
if (target === 'prod' && args.confirmo !== CONFIRM) { console.error(`\nEn la nube hace falta --confirmo="${CONFIRM}".`); process.exit(1); }

// ── 3. Carga ──
const db = connect(target);
const condoRef = db.doc(`condominios/${condoId}`);
const nowStr = new Date().toISOString();
if (target !== 'prod' && args['crear-condominio'] === true && !(await condoRef.get()).exists) {
    const adminCode = String(args['codigo-admin'] || 'DA900').toUpperCase();
    await condoRef.set({ id: condoId, name: sheet.condominio, active: true, phone: '', serviceExpiry: null, createdAt: nowStr });
    await condoRef.collection('usuarios').doc('hoja-admin').set({ id: 'hoja-admin', condominioId: condoId, name: 'Administrador de prueba', role: 'admin', casa: '', phone: '', email: '', paymentStatus: null, morosoSince: null, active: true, createdAt: nowStr });
    await db.doc(`codigos/${adminCode}`).set({ condominioId: condoId, userId: 'hoja-admin', role: 'admin', createdAt: nowStr });
    console.log('Emulador: condominio de prueba creado con su administrador.');
}
const condoSnap = await condoRef.get();
if (!condoSnap.exists) { console.error(`\nNo existe el condominio ${condoId} en ${target}.`); process.exit(1); }
const condo = condoSnap.data();
if (plain(condo.name) !== plain(sheet.condominio)) { console.error(`\nEl condominio ${condoId} se llama "${condo.name}", no "${sheet.condominio}": no se carga.`); process.exit(1); }
console.log(`\nCondominio: ${condo.name} (${condoId}) en ${target}`);
const users = condoRef.collection('usuarios');
const existingVecinos = (await users.where('role', '==', 'vecino').get()).docs;
const ours = new Set(existingVecinos.map((d) => d.id).filter((id) => plan.houses.some((h) => h.id === id)));
const foreign = existingVecinos.filter((d) => !ours.has(d.id));
if (foreign.length) { console.error(`\nNo se carga: el condominio ya tiene ${foreign.length} vecinos que no son de esta carga.`); process.exit(1); }
if (ours.size && args.continuar !== true) { console.error(`\nYa hay ${ours.size} vecinos de esta carga. Para retomar una carga cortada: --continuar`); process.exit(1); }

// 3.1 Vecinos con su codigo y su ficha (los codigos son globales: se evitan los que ya existen)
const taken = new Set((await db.collection('codigos').listDocuments()).map((d) => d.id));
const pendingHouses = plan.houses.filter((h) => !ours.has(h.id));
const PER_BATCH = 130; // 3 escrituras por casa
let created = 0;
for (let i = 0; i < pendingHouses.length; i += PER_BATCH) {
    const batch = db.batch();
    pendingHouses.slice(i, i + PER_BATCH).forEach((h) => {
        const code = accessCodeFor(condo.name, h.name, taken);
        batch.create(db.doc(`codigos/${code}`), { condominioId: condoId, userId: h.id, role: 'vecino', createdAt: nowStr });
        batch.create(users.doc(h.id), h.user);
        batch.set(condoRef.collection('finanzas_residentes').doc(h.id), h.ficha, { merge: true });
    });
    await batch.commit();
    created += Math.min(PER_BATCH, pendingHouses.length - i);
    process.stdout.write(`\rVecinos: ${created} de ${pendingHouses.length}`);
}
console.log('');

// 3.2 Cuotas y pagos (con serverGenerated: el servidor los sella sin recalcular uno por uno)
const movements = condoRef.collection('finanzas_movimientos');
const existing = new Set((await movements.listDocuments()).map((d) => d.id));
const pending = plan.movements.filter((t) => !existing.has(t.id));
for (let i = 0; i < pending.length; i += 400) {
    const batch = db.batch();
    pending.slice(i, i + 400).forEach((t) => batch.create(movements.doc(t.id), t));
    await batch.commit();
    process.stdout.write(`\rMovimientos: ${Math.min(i + 400, pending.length)} de ${pending.length}`);
}
console.log('');

// 3.3 La configuracion de la cuota al final: dispara el recalculo del condominio. Sin mora; si no hay modo de cobro se
// deja MANUAL (sin modo, el servidor lo toma como automatico y cobraria solo la cuota del mes a todos)
const settingsRef = condoRef.collection('finanzas_config').doc('oikos_settings');
const currentSettings = (await settingsRef.get()).data() || {};
await settingsRef.set({
    id: 'oikos_settings', fee: Number(sheet.cuotaActual), currency: 'GTQ',
    feeBreakdown: { maintenance: Number(sheet.cuotaActual), water: 0, garbage: 0, electricity: 0, other: 0 },
    ...(currentSettings.feeMode ? {} : { feeMode: 'manual' }), updated_at: new Date().toISOString()
}, { merge: true });
console.log('Configuracion de la cuota guardada (el servidor recalcula el condominio).');

// 3.4 Comprobacion
const check = {
    vecinos: (await users.where('role', '==', 'vecino').count().get()).data().count,
    fichas: (await condoRef.collection('finanzas_residentes').count().get()).data().count,
    movimientos: (await movements.count().get()).data().count,
    codigos: (await db.collection('codigos').where('condominioId', '==', condoId).where('role', '==', 'vecino').count().get()).data().count
};
console.log(`Comprobacion: ${check.vecinos} vecinos, ${check.fichas} fichas, ${check.movimientos} movimientos, ${check.codigos} codigos de vecino.`);
fs.appendFileSync(path.join(folder, 'resumen.txt'), `\nCARGA APLICADA en ${target} (${new Date().toLocaleString('es-GT')}): ${JSON.stringify(check)}\n`);
process.exit(0);
