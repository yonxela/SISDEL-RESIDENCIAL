// Fija, muestra o quita la clave secreta de la camara LPR de un condominio. Solo se guarda su huella (hash) en
// _privado/camaras/claves/{condominioId}: la clave se muestra una sola vez y va en la URL que se configura en la camara.
// Mientras un condominio no tenga clave, su camara sigue funcionando como antes (sin clave).
// Uso:
//   node set-camera-key.mjs --condo=<id> --target=prod --generate      (clave nueva al azar, se muestra una vez)
//   CAMERA_KEY=... node set-camera-key.mjs --condo=<id> --target=prod   (clave elegida, 16 a 64 caracteres)
//   node set-camera-key.mjs --condo=<id> --target=prod --ver            (dice si tiene clave y desde cuando)
//   node set-camera-key.mjs --condo=<id> --target=prod --quitar         (la camara vuelve a entrar sin clave)
// Con GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter para --target=prod.
import crypto from 'node:crypto';
import { connect, parseArgs } from './admin.mjs';
import { sha256 } from './lib.mjs';

const MIN_LENGTH = 16;
const MAX_LENGTH = 64;
const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const condoId = String(args.condo || '').trim();
if (!condoId || condoId.includes('/')) {
    console.error('Falta --condo=<id del condominio>');
    process.exit(1);
}

// Clave al azar sin caracteres que se confunden al escribirla (0/O, 1/I/L)
function generateKey(length = 24) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

const db = connect(target);
const ref = db.doc(`_privado/camaras/claves/${condoId}`);
const condo = await db.doc(`condominios/${condoId}`).get();
if (!condo.exists) {
    console.error(`El condominio ${condoId} no existe en ${target}.`);
    process.exit(1);
}

if (args.ver) {
    const snap = await ref.get();
    console.log(snap.exists ? `${condoId}: la camara exige clave desde ${snap.data().updatedAt}.` : `${condoId}: la camara entra sin clave.`);
    process.exit(0);
}
if (args.quitar) {
    await ref.delete();
    console.log(`${condoId}: clave quitada. La camara vuelve a entrar sin clave.`);
    process.exit(0);
}

const key = String(args.generate ? generateKey() : process.env.CAMERA_KEY || '').trim();
if (key.length < MIN_LENGTH || key.length > MAX_LENGTH || /[^A-Za-z0-9_-]/.test(key)) {
    console.error(`La clave debe tener entre ${MIN_LENGTH} y ${MAX_LENGTH} caracteres (letras, numeros, - y _). Use --generate o CAMERA_KEY=...`);
    process.exit(1);
}
await ref.set({ condominioId: condoId, keyHash: sha256(key), updatedAt: new Date().toISOString() });
const saved = (await ref.get()).data()?.keyHash;
if (saved !== sha256(key)) {
    console.error('No se pudo verificar la clave guardada.');
    process.exit(1);
}
console.log(`Clave de la camara de ${condo.data().name || condoId} guardada en ${target}.`);
console.log(`\nConfigure en la camara esta URL (la clave no se vuelve a mostrar):`);
console.log(`  https://garita.app/api/lpr?condominioId=${encodeURIComponent(condoId)}&key=${key}`);
console.log('Desde este momento la camara de este condominio solo entra con esa clave (--quitar la vuelve a abrir).');
process.exit(0);
