// Fija o cambia el codigo master. Solo se guarda su huella (hash), nunca el codigo.
// Uso:
//   MASTER_CODE=... node set-master-code.mjs --target=prod
//   node set-master-code.mjs --target=prod --from-git     (toma el codigo del sistema anterior)
import { execSync } from 'node:child_process';
import { connect, parseArgs } from './admin.mjs';
import { sha256, normalizeCode } from './lib.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';

function previousCode() {
    const source = execSync('git show cd545cc:sisdel-core.js', { encoding: 'utf8' });
    const match = source.match(/MASTER_CODE = '([^']+)'/);
    return match ? match[1] : '';
}

const code = normalizeCode(args['from-git'] ? previousCode() : process.env.MASTER_CODE);
if (!code || code.length < 4) {
    console.error('Falta el codigo. Use MASTER_CODE=... o --from-git');
    process.exit(1);
}

const db = connect(target);
await db.doc('_privado/auth').set({ masterCodeHash: sha256(code), updatedAt: new Date().toISOString() }, { merge: true });
console.log(`Codigo master guardado en ${target} (${code.length} caracteres)`);
process.exit(0);
