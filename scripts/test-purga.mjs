// Pruebas del borrado total de un condominio (functions/src/purga.js) y del script scripts/purgar-condominios.mjs
// contra los emuladores. Usan condominios propios (condo-purga-*) para no tocar los datos de las demas pruebas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAuth } from 'firebase-admin/auth';
import { connect } from './admin.mjs';
import { EMULATOR } from './lib.mjs';

process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || EMULATOR.auth;
const require = createRequire(import.meta.url);
const P = require('../functions/src/purga.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const db = connect('emulator');
const auth = getAuth();

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

const now = new Date().toISOString();
async function makeCondo(id, name) {
    const ref = db.doc(`condominios/${id}`);
    await ref.set({ id, name, active: true, createdAt: now });
    for (const [uid, role] of [[`${id}-admin`, 'admin'], [`${id}-vecino`, 'vecino'], [`${id}-guardia`, 'policia']]) {
        await ref.collection('usuarios').doc(uid).set({ id: uid, condominioId: id, name: `Usuario ${role}`, role, active: true, createdAt: now });
        await db.doc(`codigos/${id.slice(-3).toUpperCase()}${role.slice(0, 2).toUpperCase()}`).set({ condominioId: id, userId: uid, role, createdAt: now });
        await auth.createUser({ uid }).catch(() => {});
    }
    for (let i = 1; i <= 3; i++) await ref.collection('finanzas_movimientos').doc(`mov-${i}`).set({ id: `mov-${i}`, type: 'income', amount: 100 * i, resiId: `${id}-vecino`, date: now });
    await ref.collection('visitas').doc('vis-1').set({ id: 'vis-1', userId: `${id}-vecino`, visitorName: 'Visita', status: 'pending' });
    await ref.collection('rondas_rutas').doc('ruta-1').set({ id: 'ruta-1', name: 'Ruta', checkpoints: [] });
    await db.doc(`_privado/camaras/claves/${id}`).set({ hash: 'x', updatedAt: now });
}
const exists = async (pathName) => (await db.doc(pathName).get()).exists;
const countOf = async (id, sub) => (await db.collection(`condominios/${id}/${sub}`).count().get()).data().count;
const codesOf = async (id) => (await db.collection('codigos').where('condominioId', '==', id).count().get()).data().count;
const accountExists = async (uid) => { try { await auth.getUser(uid); return true; } catch { return false; } };

// Limpieza previa (por si una corrida anterior fallo a medias)
for (const id of ['condo-purga-1', 'condo-purga-2', 'condo-purga-3']) await P.purgeCondominio({ db, auth }, id);

console.log('\nNombres y validacion');
equal('el nombre se compara sin acentos, mayusculas ni espacios de mas', [P.normalizeName('  Residenciales   Delco II '), P.normalizeName('RESIDENCIALES DELCO ii'), P.normalizeName('Cañada Árbol')], ['residenciales delco ii', 'residenciales delco ii', 'canada arbol']);
equal('nombres distintos no coinciden', P.normalizeName('Delco I') === P.normalizeName('Delco II'), false);
let invalid = 0;
for (const bad of ['', '   ', 'a/b', '..', null]) { try { P.validId(bad); } catch { invalid++; } }
equal('un id vacio o con barras se rechaza', invalid, 5);

console.log('\nDescribir un condominio');
await makeCondo('condo-purga-1', 'Condominio Purga Uno');
await makeCondo('condo-purga-2', 'Condominio Purga Dos');
const info = await P.describeCondominio({ db }, 'condo-purga-1');
equal('describe cuenta lo que hay', [info.existe, info.nombre, info.subcolecciones.usuarios, info.subcolecciones.finanzas_movimientos, info.subcolecciones.visitas, info.subcolecciones.rondas_rutas, info.codigos], [true, 'Condominio Purga Uno', 3, 3, 1, 1, 3]);
equal('un condominio que no existe se describe como tal', (await P.describeCondominio({ db }, 'condo-no-existe')).existe, false);

console.log('\nBorrado total');
const result = await P.purgeCondominio({ db, auth }, 'condo-purga-1', { settleMs: 200 });
equal('el resultado cuenta usuarios, codigos y cuentas', [result.usuarios, result.codigos, result.cuentas], [3, 3, 3]);
ok('el documento del condominio ya no existe', !(await exists('condominios/condo-purga-1')));
equal('sus subcolecciones quedan vacias', [await countOf('condo-purga-1', 'usuarios'), await countOf('condo-purga-1', 'finanzas_movimientos'), await countOf('condo-purga-1', 'visitas'), await countOf('condo-purga-1', 'rondas_rutas')], [0, 0, 0, 0]);
equal('sus codigos de acceso se eliminan', await codesOf('condo-purga-1'), 0);
ok('la clave de su camara se elimina', !(await exists('_privado/camaras/claves/condo-purga-1')));
equal('las cuentas de acceso de sus usuarios se eliminan', [await accountExists('condo-purga-1-admin'), await accountExists('condo-purga-1-vecino'), await accountExists('condo-purga-1-guardia')], [false, false, false]);
console.log('\nLo que no se toca');
ok('el otro condominio sigue completo', (await exists('condominios/condo-purga-2')) && (await countOf('condo-purga-2', 'usuarios')) === 3 && (await countOf('condo-purga-2', 'finanzas_movimientos')) === 3);
equal('los codigos y la camara del otro condominio siguen', [await codesOf('condo-purga-2'), await exists('_privado/camaras/claves/condo-purga-2')], [3, true]);
ok('las cuentas de acceso del otro condominio siguen', await accountExists('condo-purga-2-admin'));
ok('la clave master (_privado/auth) sigue', await exists('_privado/auth'));
const again = await P.purgeCondominio({ db, auth }, 'condo-purga-1');
equal('borrar de nuevo lo que ya no existe no falla ni cuenta nada', [again.usuarios, again.codigos, again.cuentas], [0, 0, 0]);

console.log('\nScript purgar-condominios.mjs');
const script = path.join(here, 'purgar-condominios.mjs');
const run = (...extra) => spawnSync('node', [script, ...extra], { encoding: 'utf8', cwd: here, timeout: 120000 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sisdel-purga-'));
const sim = run('--solo=condo-purga-2');
ok('el simulacro lista el condominio y no cambia nada', sim.status === 0 && /Condominio Purga Dos \(condo-purga-2\)/.test(sim.stdout) && /3 usuarios/.test(sim.stdout) && /no se cambio nada/i.test(sim.stdout), sim.stderr);
ok('el simulacro dice que no toca la clave master ni los mensajes globales', /NO se toca: _privado/.test(sim.stdout) && /mensajes_globales/.test(sim.stdout));
ok('despues del simulacro el condominio sigue', await exists('condominios/condo-purga-2'));
const noPhrase = run('--solo=condo-purga-2', '--eliminar', `--carpeta=${path.join(tmp, 'a')}`, '--espera=0');
ok('eliminar sin la frase de confirmacion no borra nada', noPhrase.status === 1 && /Falta la confirmacion/.test(noPhrase.stderr) && (await exists('condominios/condo-purga-2')), noPhrase.stdout + noPhrase.stderr);
const wrongPhrase = run('--solo=condo-purga-2', '--eliminar', '--confirmo=borrar todo', `--carpeta=${path.join(tmp, 'b')}`, '--espera=0');
ok('con otra frase tampoco borra', wrongPhrase.status === 1 && (await exists('condominios/condo-purga-2')));
const inRepo = run('--solo=condo-purga-2', '--respaldo', `--carpeta=${path.join(here, '..', 'respaldo-prueba')}`);
ok('el respaldo no se guarda dentro del repositorio', inRepo.status === 1 && /dentro de un repositorio/.test(inRepo.stderr) && !fs.existsSync(path.join(here, '..', 'respaldo-prueba')));
const backupOnly = run('--solo=condo-purga-2', '--respaldo', `--carpeta=${path.join(tmp, 'solo-respaldo')}`);
ok('--respaldo guarda el respaldo y no borra', backupOnly.status === 0 && fs.existsSync(path.join(tmp, 'solo-respaldo', 'condominio-condo-purga-2.json')) && (await exists('condominios/condo-purga-2')), backupOnly.stderr);
await makeCondo('condo-purga-3', 'Condominio Purga Tres');
const real = run('--solo=condo-purga-2', '--eliminar', `--confirmo=ELIMINAR TODOS LOS CONDOMINIOS`, `--carpeta=${path.join(tmp, 'real')}`, '--espera=0');
ok('con la frase correcta elimina el condominio elegido', real.status === 0 && /Comprobacion: condominios que siguen: 0/.test(real.stdout) && !(await exists('condominios/condo-purga-2')), real.stdout + real.stderr);
ok('y deja los demas', await exists('condominios/condo-purga-3'));
const backupFile = path.join(tmp, 'real', 'condominio-condo-purga-2.json');
const backup = fs.existsSync(backupFile) ? JSON.parse(fs.readFileSync(backupFile, 'utf8')) : null;
ok('el respaldo trae el condominio con sus usuarios y movimientos', !!backup && backup.data.name === 'Condominio Purga Dos' && backup.subcolecciones.usuarios.length === 3 && backup.subcolecciones.finanzas_movimientos.length === 3);
const codes = fs.existsSync(path.join(tmp, 'real', 'codigos.json')) ? JSON.parse(fs.readFileSync(path.join(tmp, 'real', 'codigos.json'), 'utf8')) : [];
equal('el respaldo trae sus codigos de acceso', codes.length, 3);
ok('el respaldo solo lo puede leer su dueño (permisos 600)', fs.existsSync(backupFile) && (fs.statSync(backupFile).mode & 0o777) === 0o600);
const excepto = run('--excepto=condo-purga-3', '--solo=condo-purga-3');
ok('--excepto conserva ese condominio (no queda nada que eliminar)', excepto.status === 0 && /ELIMINARIAN \(0\)/.test(excepto.stdout) && /Se CONSERVAN/.test(excepto.stdout) && (await exists('condominios/condo-purga-3')), excepto.stdout + excepto.stderr);

// Limpieza final
for (const id of ['condo-purga-1', 'condo-purga-2', 'condo-purga-3']) await P.purgeCondominio({ db, auth }, id);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
