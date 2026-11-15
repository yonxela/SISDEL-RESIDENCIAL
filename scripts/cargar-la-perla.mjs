// Carga de RESIDENCIALES LA PERLA desde la lista de propietarios y la cartera de saldos (ver lib-carga-perla.mjs).
//
//   node cargar-la-perla.mjs --propietarios=RUTA.xlsx --cartera=RUTA.xlsx [--target=emulator|prod] [--condo=ID]
//        [--carpeta=DIR] [--aplicar] [--confirmo="CARGAR LA PERLA"] [--continuar]
//
// Sin --aplicar es un SIMULACRO: lee los dos archivos, arma la carga y la cuadra contra la cartera, sin tocar la base.
// Siempre deja un informe (resumen, lote por lote y lo que hay que revisar) en una carpeta FUERA de cualquier
// repositorio (por omision ~/Desktop/CARGA LA PERLA <fecha>): trae datos personales. En pantalla solo salen conteos.
//
// Con --aplicar escribe: los 90 dias de gracia de la garita, cada vecino con su codigo y su ficha, las cuotas y por
// ultimo la configuracion de la cuota (eso dispara el recalculo de la mora del condominio en el servidor). En la nube
// (--target=prod) pide ademas --confirmo="CARGAR LA PERLA". No carga encima de vecinos que ya existan: con
// --continuar retoma una carga cortada (salta lo que ya esta).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readXlsx } from './lib-xlsx.mjs';
import { parseOwners, parseCartera, buildPlan, carteraTotals, accessCodeFor, SOURCE } from './lib-carga-perla.mjs';
import { connect, parseArgs } from './admin.mjs';

const require = createRequire(import.meta.url);
const SisdelMora = require('../finanzas/sisdel-mora.js');

const LA_PERLA = 'UikIeRIBWRsdPKpxk7N2';
const CUT_DAY = '2026-11-15'; // "A la fecha 15/11/26" del reporte de la asociacion
const CONFIRM = 'CARGAR LA PERLA';
// La cuota y la mora de La Perla (decisiones del 2026-11-12): mantenimiento Q300, paja de agua Q160, mora 3 % al mes
// por dia con 5 dias de plazo, la mora no genera mora y un abono paga primero la cuota
const SETTINGS = {
    fee: 300, currency: 'GTQ', waterUnitPrice: 160,
    feeBreakdown: { maintenance: 300, water: 0, garbage: 0, electricity: 0, other: 0 },
    moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }]
};
const GARITA = { reminderEnabled: true, gracePeriodDays: 90 };

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const condoId = args.condo || LA_PERLA;
const apply = args.aplicar === true;
if (!args.propietarios || !args.cartera) {
    console.error('Uso: node cargar-la-perla.mjs --propietarios=RUTA.xlsx --cartera=RUTA.xlsx [--target=emulator|prod] [--aplicar]');
    process.exit(1);
}

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
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const gtNow = () => new Date(Date.now() - 6 * 3600 * 1000);
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, header, rows) => fs.writeFileSync(file, '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', { mode: 0o600 });

// ── 1. Leer y armar ──
const owners = parseOwners(readXlsx(args.propietarios));
const accounts = parseCartera(readXlsx(args.cartera));
const nowIso = new Date().toISOString();
const currentPeriod = gtNow().toISOString().slice(0, 7);
const plan = buildPlan(owners.owners, accounts, { condoId, nowIso, currentPeriod, currency: SETTINGS.currency });

// ── 2. Cuadre contra la cartera ──
const totals = carteraTotals(accounts);
const loaded = {
    capital: round2(plan.lots.reduce((s, l) => s + l.check.capital, 0)),
    moraFixed: round2(plan.lots.reduce((s, l) => s + l.check.moraFixed, 0)),
    interest: round2(plan.lots.reduce((s, l) => s + l.check.interest, 0))
};
const orphan = carteraTotals(plan.orphanAccounts);
// Mora que calculara el sistema al dia del reporte (3 % al mes, por dia, desde el fin de mes mas 5 dias de plazo)
const moraState = new Map();
const byResident = new Map();
plan.charges.forEach((c) => { if (!byResident.has(c.resiId)) byResident.set(c.resiId, []); byResident.get(c.resiId).push(c); });
let moraComputed = 0;
let moraCarteraOnDebt = 0;
plan.lots.forEach((lot) => {
    const state = SisdelMora.stateOf(lot.id, byResident.get(lot.id) || [], SETTINGS, CUT_DAY);
    const accrued = round2(state.items.filter((i) => i.kind === 'fee').reduce((s, i) => s + i.mora, 0));
    const cartera = round2((byResident.get(lot.id) || []).filter((c) => c.kind === 'fee').reduce((s, c) => s + (c._moraOnDebt || 0), 0));
    moraState.set(lot.id, { accrued, cartera, balance: state.balance });
    moraComputed += accrued;
    moraCarteraOnDebt += cartera;
});
moraComputed = round2(moraComputed);
moraCarteraOnDebt = round2(moraCarteraOnDebt);
const diffCapital = round2(totals.capital - loaded.capital - orphan.capital);
const reconciled = Math.abs(diffCapital) < 0.01
    && Math.abs(totals.moraOnPaid - loaded.moraFixed - orphan.moraOnPaid) < 0.01
    && Math.abs(totals.interest - loaded.interest - orphan.interest) < 0.01;

// ── 3. Informe (fuera del repositorio) ──
const stamp = gtNow().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
const folder = path.resolve(args.carpeta || path.join(os.homedir(), 'Desktop', `CARGA LA PERLA ${stamp}`));
if (insideGit(folder)) { console.error(`No se guarda el informe en ${folder}: esta dentro de un repositorio y trae datos personales. Use --carpeta=...`); process.exit(1); }
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });

const waterCount = { 0: 0, 0.5: 0, 1: 0 };
plan.lots.forEach((l) => { waterCount[l.ficha.waterUnits] = (waterCount[l.ficha.waterUnits] || 0) + 1; });
const count = (fn) => plan.lots.filter(fn).length;
const summary = [
    `Carga de RESIDENCIALES LA PERLA (${apply ? 'APLICADA en ' + target : 'SIMULACRO, nada escrito'}) - ${new Date().toLocaleString('es-GT')}`,
    `Fuente: ${SOURCE}`,
    '',
    `Lista de propietarios: ${owners.owners.length} lotes (${owners.issues.length} filas con problemas)`,
    `Cartera: ${accounts.length} cuentas, ${totals.quotas} filas de cuota`,
    `Vecinos a crear: ${plan.lots.length} (con su codigo de acceso y su ficha)`,
    `Lotes que no se cargan: ${plan.skipped.length} (${plan.skipped.map((s) => s.lot + ': ' + s.reason).join('; ')})`,
    `Cuentas de la cartera sin lote en la lista: ${plan.orphanAccounts.length}`,
    `Cargos a crear: ${plan.charges.length} (cuotas ${plan.charges.filter((c) => c.kind === 'fee').length}, mora fija ${plan.charges.filter((c) => c.moraFixed).length}, interes ${plan.charges.filter((c) => c.interestPeriod).length})`,
    '',
    'CUADRE CONTRA LA CARTERA',
    `  Capital (cuotas pendientes): cartera ${money(totals.capital)} | cargado ${money(loaded.capital)} | sin lote ${money(orphan.capital)} | diferencia ${money(diffCapital)}`,
    `  Mora de cuotas ya pagadas (cargo fijo): cartera ${money(totals.moraOnPaid)} | cargado ${money(loaded.moraFixed)}`,
    `  Interes: cartera ${money(totals.interest)} | cargado ${money(loaded.interest)}`,
    `  Mora de lo que se debe: cartera ${money(moraCarteraOnDebt)} | la calcula el sistema al ${CUT_DAY}: ${money(moraComputed)} | diferencia ${money(round2(moraComputed - moraCarteraOnDebt))}`,
    `  Total cartera (filas): ${money(totals.capital + totals.interest + totals.mora)}`,
    `  ${reconciled ? 'CUADRA: capital, mora fija e interes coinciden con la cartera.' : 'NO CUADRA: revisar antes de cargar.'}`,
    '',
    'DATOS',
    `  Agua: sin agua ${waterCount[0] || 0} | media paja ${waterCount[0.5] || 0} | una paja ${waterCount[1] || 0} | agua supuesta (sin monto visible) ${count((l) => l.check.water.unsure)}`,
    `  NIT con numero ${count((l) => l.ficha.ownerGroup)} | C/F ${count((l) => l.ficha.nit === 'C/F')} | sin NIT ${count((l) => !l.ficha.nit)}`,
    `  Telefono: sin telefono ${count((l) => l.check.noPhone)} | con otros numeros (van a observaciones) ${count((l) => l.check.phoneOthers)} | raros ${count((l) => l.check.phoneOdd)}`,
    `  Correo: sin correo ${count((l) => l.check.noEmail)} | mal escritos (van a observaciones) ${count((l) => l.check.badEmail)}`,
    `  Lotes donde la cartera trae otro nombre: ${count((l) => l.check.differentOwner.length)} (se carga el de la lista de propietarios)`,
    '',
    'CONDOMINIO',
    `  Garita: ${GARITA.gracePeriodDays} dias de gracia para morosos (reminderEnabled)`,
    `  Cuota: mantenimiento ${money(SETTINGS.fee)}, paja de agua ${money(SETTINGS.waterUnitPrice)}, mora ${SETTINGS.moraRules[0].percent} % al mes por dia con ${SETTINGS.moraRules[0].graceDays} dias de plazo`
];
fs.writeFileSync(path.join(folder, 'resumen.txt'), summary.join('\n') + '\n', { mode: 0o600 });
writeCsv(path.join(folder, 'lotes.csv'),
    ['Lote', 'Id', 'Nombre', 'NIT', 'Direccion', 'Telefono', 'Correo', 'Agua (paja)', 'Origen del agua', 'Cobrar desde', 'Cargos', 'Capital pendiente', 'Mora fija', 'Interes', 'Mora calculada al 15/11/2026', 'Mora de la cartera', 'Observaciones', 'Nombre en la cartera'],
    plan.lots.map((l) => {
        const m = moraState.get(l.id);
        return [l.label, l.id, l.user.name, l.ficha.nit || '', l.ficha.direccion || '', l.user.phone, l.user.email, l.ficha.waterUnits, l.check.water.source,
            l.ficha.feeFrom, l.check.charges, l.check.capital, l.check.moraFixed, l.check.interest, m.accrued, m.cartera, l.ficha.notes || '', l.check.cartera.join(' | ')];
    }));
const reviewRows = [];
plan.lots.forEach((l) => {
    if (l.check.differentOwner.length) reviewRows.push([l.label, 'Otro nombre en la cartera', `Lista: ${l.user.name} | Cartera: ${l.check.differentOwner.join(' | ')}`]);
    if (l.check.water.unsure) reviewRows.push([l.label, 'Agua supuesta', l.check.water.source]);
    if (l.check.phoneOdd) reviewRows.push([l.label, 'Telefono raro', l.user.phone]);
    if (l.check.noPhone && l.check.noEmail) reviewRows.push([l.label, 'Sin telefono ni correo', '']);
    if (l.check.badEmail) reviewRows.push([l.label, 'Correo mal escrito', l.ficha.notes || '']);
    if (!l.check.accounts) reviewRows.push([l.label, 'Sin cuenta en la cartera', 'Se carga con su codigo y sin saldo']);
});
plan.skipped.forEach((s) => reviewRows.push([s.lot, 'No se carga', s.reason]));
plan.orphanAccounts.forEach((a) => reviewRows.push([a.code, 'Cuenta sin lote en la lista', `${a.quotas.length} cuotas`]));
owners.issues.forEach((i) => reviewRows.push([i.lot || `fila ${i.row}`, 'Lista de propietarios', i.issue]));
writeCsv(path.join(folder, 'revisar.csv'), ['Lote', 'Que revisar', 'Detalle'], reviewRows);

console.log(summary.filter((line) => !/Lotes que no se cargan/.test(line)).join('\n'));
console.log(`Lotes que no se cargan: ${plan.skipped.map((s) => s.lot).join(', ') || 'ninguno'}`);
console.log(`\nInforme: ${folder}`);

if (!apply) { console.log('\nSIMULACRO: no se escribio nada en la base. Para cargar: --aplicar'); process.exit(reconciled ? 0 : 2); }
if (!reconciled) { console.error('\nNo se carga: el simulacro no cuadra con la cartera.'); process.exit(2); }
if (target === 'prod' && args.confirmo !== CONFIRM) { console.error(`\nEn la nube hace falta --confirmo="${CONFIRM}".`); process.exit(1); }

// ── 4. Carga ──
const db = connect(target);
const condoRef = db.doc(`condominios/${condoId}`);
// Solo en el emulador: --crear-condominio arma un condominio de prueba con un administrador (codigo --codigo-admin)
// para revisar la carga en pantalla
if (target !== 'prod' && args['crear-condominio'] === true && !(await condoRef.get()).exists) {
    const adminCode = String(args['codigo-admin'] || 'LP900').toUpperCase();
    await condoRef.set({ id: condoId, name: 'RESIDENCIALES LA PERLA (PRUEBA)', active: true, phone: '', serviceExpiry: null, createdAt: nowIso });
    await condoRef.collection('usuarios').doc('perla-admin').set({ id: 'perla-admin', condominioId: condoId, name: 'Administrador de prueba', role: 'admin', casa: '', phone: '', email: '', paymentStatus: null, morosoSince: null, active: true, createdAt: nowIso });
    await db.doc(`codigos/${adminCode}`).set({ condominioId: condoId, userId: 'perla-admin', role: 'admin', createdAt: nowIso });
    console.log('Emulador: condominio de prueba creado con su administrador.');
}
const condoSnap = await condoRef.get();
if (!condoSnap.exists) { console.error(`\nNo existe el condominio ${condoId} en ${target}.`); process.exit(1); }
const condo = condoSnap.data();
console.log(`\nCondominio: ${condo.name} (${condoId}) en ${target}`);
const users = condoRef.collection('usuarios');
const existingVecinos = (await users.where('role', '==', 'vecino').get()).docs;
const ours = new Set(existingVecinos.map((d) => d.id).filter((id) => plan.lots.some((l) => l.id === id)));
const foreign = existingVecinos.filter((d) => !ours.has(d.id));
if (foreign.length) { console.error(`\nNo se carga: el condominio ya tiene ${foreign.length} vecinos que no son de esta carga.`); process.exit(1); }
if (ours.size && args.continuar !== true) { console.error(`\nYa hay ${ours.size} vecinos de esta carga. Para retomar una carga cortada: --continuar`); process.exit(1); }

// 4.1 Garita: 90 dias de gracia antes de que el recalculo marque morosos
await condoRef.set(GARITA, { merge: true });
console.log(`Garita: ${GARITA.gracePeriodDays} dias de gracia para morosos.`);

// 4.2 Vecinos con su codigo y su ficha (los codigos son globales: se evitan los que ya existen)
const taken = new Set((await db.collection('codigos').listDocuments()).map((d) => d.id));
const pendingLots = plan.lots.filter((l) => !ours.has(l.id));
const LOTS_PER_BATCH = 130; // 3 escrituras por lote
let created = 0;
for (let i = 0; i < pendingLots.length; i += LOTS_PER_BATCH) {
    const batch = db.batch();
    pendingLots.slice(i, i + LOTS_PER_BATCH).forEach((lot) => {
        const code = accessCodeFor(condo.name, lot.user.name, taken);
        batch.create(db.doc(`codigos/${code}`), { condominioId: condoId, userId: lot.id, role: 'vecino', createdAt: nowIso });
        batch.create(users.doc(lot.id), lot.user);
        batch.set(condoRef.collection('finanzas_residentes').doc(lot.id), lot.ficha, { merge: true });
    });
    await batch.commit();
    created += Math.min(LOTS_PER_BATCH, pendingLots.length - i);
    process.stdout.write(`\rVecinos: ${created} de ${pendingLots.length}`);
}
console.log('');

// 4.3 Cuotas, mora fija e interes (con serverGenerated: el servidor las sella sin recalcular una por una)
const movements = condoRef.collection('finanzas_movimientos');
const existingCharges = new Set((await movements.listDocuments()).map((d) => d.id));
const pendingCharges = plan.charges.filter((c) => !existingCharges.has(c.id)).map(({ _moraOnDebt, ...c }) => c);
for (let i = 0; i < pendingCharges.length; i += 400) {
    const batch = db.batch();
    pendingCharges.slice(i, i + 400).forEach((c) => batch.create(movements.doc(c.id), c));
    await batch.commit();
    process.stdout.write(`\rCargos: ${Math.min(i + 400, pendingCharges.length)} de ${pendingCharges.length}`);
}
console.log('');

// 4.4 Configuracion de la cuota al final: dispara el recalculo de la mora de todo el condominio. El modo de cobro,
// el dia de cobro y los dias de gracia de OIKOS se respetan; si no hay modo se deja MANUAL (sin modo, el servidor
// lo toma como automatico y cobraria solo la cuota del mes a todos)
const settingsRef = condoRef.collection('finanzas_config').doc('oikos_settings');
const currentSettings = (await settingsRef.get()).data() || {};
await settingsRef.set({
    id: 'oikos_settings', ...SETTINGS, ...(currentSettings.feeMode ? {} : { feeMode: 'manual' }), updated_at: new Date().toISOString()
}, { merge: true });
console.log('Configuracion de la cuota guardada (el servidor recalcula la mora del condominio).');

// 4.5 Comprobacion
const check = {
    vecinos: (await users.where('role', '==', 'vecino').count().get()).data().count,
    fichas: (await condoRef.collection('finanzas_residentes').count().get()).data().count,
    cargos: (await movements.count().get()).data().count,
    codigos: (await db.collection('codigos').where('condominioId', '==', condoId).where('role', '==', 'vecino').count().get()).data().count
};
console.log(`Comprobacion: ${check.vecinos} vecinos, ${check.fichas} fichas, ${check.cargos} cargos, ${check.codigos} codigos de vecino.`);
fs.appendFileSync(path.join(folder, 'resumen.txt'), `\nCARGA APLICADA en ${target} (${new Date().toLocaleString('es-GT')}): ${JSON.stringify(check)}\n`);
process.exit(0);
