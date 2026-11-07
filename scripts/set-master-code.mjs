// Fija o cambia el codigo master. Solo se guarda su huella (hash), nunca el codigo.
// Uso:
//   node set-master-code.mjs --target=prod --generate   (genera uno nuevo y lo muestra una sola vez)
//   MASTER_CODE=... node set-master-code.mjs --target=prod
// En la nube tambien cierra las sesiones master abiertas con el codigo anterior.
import crypto from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { connect, parseArgs } from './admin.mjs';
import { sha256, normalizeCode } from './lib.mjs';

const MASTER_UID = 'master';
// El campo de acceso en index.html acepta hasta 12 caracteres
const MIN_LENGTH = 8;
const MAX_LENGTH = 12;

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';

// Codigo al azar sin caracteres que se confunden al escribirlo (0/O, 1/I/L)
function generateCode(length = 10) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

const code = normalizeCode(args.generate ? generateCode() : process.env.MASTER_CODE);
if (code.length < MIN_LENGTH || code.length > MAX_LENGTH) {
    console.error(`El codigo debe tener entre ${MIN_LENGTH} y ${MAX_LENGTH} caracteres. Use --generate o MASTER_CODE=...`);
    process.exit(1);
}

const db = connect(target);
const ref = db.doc('_privado/auth');
await ref.set({ masterCodeHash: sha256(code), updatedAt: new Date().toISOString() }, { merge: true });
const saved = (await ref.get()).data()?.masterCodeHash;
if (saved !== sha256(code)) {
    console.error('No se pudo verificar el codigo guardado. No se cambio nada mas.');
    process.exit(1);
}
console.log(`Codigo master guardado en ${target} (${code.length} caracteres).`);

// Las sesiones abiertas con el codigo anterior dejan de renovarse y vencen en menos de 1 hora
if (target === 'prod') {
    try {
        await getAuth().revokeRefreshTokens(MASTER_UID);
        console.log('Sesiones master anteriores cerradas: hay que entrar de nuevo con el codigo nuevo.');
    } catch (error) {
        console.error('No se pudieron cerrar las sesiones master:', error.code || error.message);
    }
}

if (args.generate) {
    console.log(`\nCodigo master nuevo: ${code}`);
    console.log('Guardelo ahora: no se vuelve a mostrar y en la base solo queda su huella.');
}
process.exit(0);
