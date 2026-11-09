// Genera en firestore.rules el bloque de funciones pXxx de los privilegios a partir de privilegios.js
// (una funcion por clave que las reglas usan). Uso: node generar-reglas-privilegios.mjs
//   (sin argumentos reescribe el bloque en ../firestore.rules; con --check solo comprueba que este al dia)
// El bloque queda entre las marcas BEGIN/END; todo lo demas de las reglas se escribe a mano.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../privilegios.js');
const file = new URL('../firestore.rules', import.meta.url);

const BEGIN = '    // ── BEGIN privilegios generados (scripts/generar-reglas-privilegios.mjs) ──';
const END = '    // ── END privilegios generados ──';

// 'usuarios.pagos_ver' -> 'pUsuariosPagosVer'
export const fnName = (key) => 'p' + key.split(/[._]/).map((s) => s[0].toUpperCase() + s.slice(1)).join('');

export function buildBlock() {
    // Las reglas necesitan las claves que ellas aplican (enforce: 'reglas') y los paraguas de esas claves
    const need = new Set();
    P.ITEMS.filter((i) => i.enforce === 'reglas').forEach((i) => {
        need.add(i.key);
        let up = i;
        while (up.parent) { up = P.itemOf(up.parent); need.add(up.key); }
    });
    const lines = [BEGIN, '    // Raiz: lo que diga el mapa del usuario o, si no lo menciona, el rol. Accion: el paraguas activo y la accion no quitada.'];
    let last = null;
    P.ITEMS.filter((i) => need.has(i.key)).forEach((i) => {
        if (i.groupTitle !== last) { lines.push(`    // ${i.groupTitle}`); last = i.groupTitle; }
        const body = i.parent
            ? `${fnName(i.parent)}(c) && childOk(c, '${i.key}')`
            : `can(c, '${i.key}', [${i.roles.map((r) => `'${r}'`).join(', ')}])`;
        lines.push(`    function ${fnName(i.key)}(c) { return ${body}; }`);
    });
    lines.push(END);
    return lines.join('\n');
}

export function currentBlock(text) {
    const a = text.indexOf(BEGIN);
    const b = text.indexOf(END);
    if (a < 0 || b < 0) return null;
    return text.slice(a, b + END.length);
}

export function replaceBlock(text, block) {
    const a = text.indexOf(BEGIN);
    const b = text.indexOf(END);
    if (a < 0 || b < 0) throw new Error('firestore.rules no tiene las marcas BEGIN/END de los privilegios generados');
    return text.slice(0, a) + block + text.slice(b + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const text = fs.readFileSync(file, 'utf8');
    const block = buildBlock();
    if (process.argv.includes('--check')) {
        if (currentBlock(text) !== block) { console.error('El bloque de privilegios de firestore.rules no esta al dia: corra npm run reglas'); process.exit(1); }
        console.log('Bloque de privilegios al dia');
    } else {
        fs.writeFileSync(file, replaceBlock(text, block));
        console.log(`firestore.rules: ${block.split('\n').length - 2} funciones de privilegios generadas`);
    }
}
