// Limpieza total: elimina TODOS los condominios con sus usuarios, codigos de acceso, camara, Sistema Financiero, rondas y
// cuentas de acceso. Es IRREVERSIBLE, asi que tiene tres seguros: por defecto solo muestra que borraria (simulacro),
// antes de borrar guarda un respaldo FUERA del repo, y exige escribir una frase de confirmacion.
//
// Uso (lo corre una persona en su terminal; en produccion hace falta `gcloud auth application-default login`):
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node purgar-condominios.mjs --target=prod
//       -> simulacro: lista lo que se borraria y lo que NO se toca. No cambia nada.
//   ... --target=prod --respaldo
//       -> ademas guarda el respaldo en ~/Desktop/RESPALDO SISDEL <fecha> (o --carpeta=/ruta). No borra nada.
//   ... --target=prod --eliminar --confirmo="ELIMINAR TODOS LOS CONDOMINIOS"
//       -> guarda el respaldo y borra. Con --excepto=id1,id2 deja esos condominios; con --solo=id1,id2 borra solo esos.
//   --espera=SEGUNDOS: pausa antes de la segunda pasada de limpieza de cada condominio (30 por defecto; en el emulador, 0).
//
// NO toca: _privado (clave master, WhatsApp, claves de camara de otros), mensajes_globales, camera_logs_huerfanos, _diag
// ni la cuenta "master". El respaldo trae datos personales y codigos de acceso: no lo suba al repo (es publico);
// el script se niega a guardarlo dentro de una carpeta con git.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { getAuth } from 'firebase-admin/auth';
import { connect, parseArgs } from './admin.mjs';
import { EMULATOR, PROJECT_ID } from './lib.mjs';

const require = createRequire(import.meta.url);
const { purgeCondominio } = require('../functions/src/purga.js');

const PHRASE = 'ELIMINAR TODOS LOS CONDOMINIOS';
const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
if (target === 'emulator') process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || EMULATOR.auth;
const db = connect(target);
const auth = getAuth();

const only = args.solo ? String(args.solo).split(',').map((s) => s.trim()).filter(Boolean) : null;
const except = args.excepto ? String(args.excepto).split(',').map((s) => s.trim()).filter(Boolean) : [];
const waitSeconds = args.espera !== undefined ? Math.max(0, Number(args.espera) || 0) : (target === 'prod' ? 30 : 0);
const doDelete = !!args.eliminar;
const doBackup = !!args.respaldo || doDelete;

function stampNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
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
function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.on('close', () => resolve(''));
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    });
}

// Un documento con todas sus subcolecciones, listo para JSON (las fechas de Firestore pasan a texto)
function plain(value) {
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
}
async function dump(ref) {
    const snap = await ref.get();
    const subcolecciones = {};
    for (const col of await ref.listCollections()) {
        subcolecciones[col.id] = [];
        for (const doc of (await col.get()).docs) subcolecciones[col.id].push(await dump(doc.ref));
    }
    return { id: ref.id, data: plain(snap.data() || {}), subcolecciones };
}

// ───────── 1. Que hay ─────────
console.log(`\n${target === 'prod' ? `PRODUCCION (${PROJECT_ID})` : 'EMULADOR local'}: ${doDelete ? 'ELIMINACION' : doBackup ? 'respaldo (no borra nada)' : 'simulacro (no cambia nada)'}\n`);
const all = (await db.collection('condominios').get()).docs;
const chosen = all.filter((d) => (!only || only.includes(d.id)) && !except.includes(d.id));
const kept = all.filter((d) => !chosen.includes(d));
if (!all.length) { console.log('No hay condominios.'); process.exit(0); }

const summary = [];
for (const doc of chosen) {
    const ref = doc.ref;
    const users = (await ref.collection('usuarios').select('role').get()).docs.map((d) => d.data().role || '?');
    const roles = users.reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {});
    const subs = {};
    for (const col of await ref.listCollections()) subs[col.id] = (await col.count().get()).data().count;
    const codigos = (await db.collection('codigos').where('condominioId', '==', doc.id).count().get()).data().count;
    summary.push({ id: doc.id, nombre: doc.data().name || '(sin nombre)', activo: doc.data().active !== false, usuarios: users.length, roles, subs, codigos });
}
console.log(`Condominios que se ELIMINARIAN (${chosen.length}):`);
for (const c of summary) {
    const roles = Object.entries(c.roles).map(([r, n]) => `${n} ${r}`).join(', ');
    const rest = Object.entries(c.subs).filter(([k]) => k !== 'usuarios').map(([k, n]) => `${k}: ${n}`).join(', ');
    console.log(`  - ${c.nombre} (${c.id})${c.activo ? '' : ' [inactivo]'}: ${c.usuarios} usuarios${roles ? ` (${roles})` : ''}, ${c.codigos} codigos${rest ? `; ${rest}` : ''}`);
}
if (kept.length) console.log(`\nSe CONSERVAN (${kept.length}): ${kept.map((d) => `${d.data().name || d.id} (${d.id})`).join(', ')}`);
const keptTop = {};
for (const name of ['mensajes_globales', 'camera_logs_huerfanos', '_diag']) keptTop[name] = (await db.collection(name).count().get()).data().count;
const keptPrivate = (await db.collection('_privado').listDocuments()).map((d) => d.id);
console.log(`\nNO se toca: _privado (${keptPrivate.join(', ') || 'vacio'}), ${Object.entries(keptTop).map(([k, n]) => `${k}: ${n}`).join(', ')} y la cuenta master.`);
const orphanCodes = (await db.collection('codigos').get()).docs.filter((d) => !all.some((c) => c.id === d.data().condominioId));
if (orphanCodes.length) console.log(`Codigos sueltos (de condominios que ya no existen): ${orphanCodes.length}; no se tocan.`);

if (!doBackup && !doDelete) {
    console.log('\nSimulacro terminado: no se cambio nada. Para guardar un respaldo agregue --respaldo; para borrar, --eliminar --confirmo="' + PHRASE + '".');
    process.exit(0);
}

// ───────── 2. Respaldo (fuera del repo) ─────────
const folder = path.resolve(args.carpeta && args.carpeta !== true ? String(args.carpeta) : path.join(os.homedir(), 'Desktop', `RESPALDO SISDEL ${stampNow()}`));
if (insideGit(folder)) { console.error(`\nNo se guarda el respaldo en ${folder}: esta dentro de un repositorio (es publico y el respaldo trae codigos y datos personales). Elija otra carpeta con --carpeta=...`); process.exit(1); }
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const written = [];
for (const doc of chosen) {
    const file = path.join(folder, `condominio-${doc.id}.json`);
    fs.writeFileSync(file, JSON.stringify(await dump(doc.ref), null, 2), { mode: 0o600 });
    written.push(file);
}
const codeDocs = [];
for (const doc of chosen) for (const c of (await db.collection('codigos').where('condominioId', '==', doc.id).get()).docs) codeDocs.push({ id: c.id, ...plain(c.data()) });
fs.writeFileSync(path.join(folder, 'codigos.json'), JSON.stringify(codeDocs, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(folder, 'LEEME.txt'), `Respaldo de SISDEL (${target}) del ${new Date().toISOString()}\nCondominios: ${chosen.map((d) => `${d.data().name || d.id} (${d.id})`).join(', ')}\nTrae datos personales y codigos de acceso: guardelo en un lugar privado y NO lo suba al repositorio.\nUn JSON por condominio (documento y subcolecciones) y codigos.json.\n`, { mode: 0o600 });
console.log(`\nRespaldo guardado en: ${folder}\n  ${written.length} condominio(s) y ${codeDocs.length} codigo(s).`);
if (!doDelete) { console.log('\nNo se borro nada.'); process.exit(0); }

// ───────── 3. Confirmacion y borrado ─────────
const typed = args.confirmo === true ? '' : String(args.confirmo || '');
if (typed !== PHRASE) {
    console.error(`\nFalta la confirmacion. Para borrar escriba exactamente --confirmo="${PHRASE}". No se borro nada.`);
    process.exit(1);
}
if (target === 'prod' && process.stdin.isTTY) {
    const again = await ask(`\nVa a ELIMINAR ${chosen.length} condominio(s) de PRODUCCION. Escriba el numero ${chosen.length} para continuar: `);
    if (again !== String(chosen.length)) { console.error('No coincide. No se borro nada.'); process.exit(1); }
}
console.log(`\nEliminando ${chosen.length} condominio(s)... (cada uno espera ${waitSeconds} s para la segunda pasada de limpieza)`);
let totalUsers = 0; let totalCodes = 0; let totalAccounts = 0;
for (const c of summary) {
    const result = await purgeCondominio({ db, auth }, c.id, { settleMs: waitSeconds * 1000 });
    totalUsers += result.usuarios; totalCodes += result.codigos; totalAccounts += result.cuentas;
    console.log(`  eliminado: ${c.nombre} (${c.id}) - ${result.usuarios} usuarios, ${result.codigos} codigos, ${result.cuentas} cuentas de acceso`);
}

// ───────── 4. Comprobacion ─────────
const ids = chosen.map((d) => d.id);
const remaining = (await db.collection('condominios').get()).docs.map((d) => d.id).filter((id) => ids.includes(id));
const strayUsers = (await db.collectionGroup('usuarios').get()).docs.filter((d) => ids.some((id) => d.ref.path.startsWith(`condominios/${id}/`))).length;
let strayCodes = 0;
for (const id of ids) strayCodes += (await db.collection('codigos').where('condominioId', '==', id).count().get()).data().count;
console.log(`\nComprobacion: condominios que siguen: ${remaining.length}, usuarios sueltos: ${strayUsers}, codigos sueltos: ${strayCodes}.`);
if (remaining.length || strayUsers || strayCodes) { console.error('Quedaron restos: vuelva a correr el comando para limpiarlos.'); process.exit(2); }
console.log(`Listo: ${chosen.length} condominio(s), ${totalUsers} usuarios, ${totalCodes} codigos y ${totalAccounts} cuentas de acceso eliminados. El respaldo esta en ${folder}`);
process.exit(0);
