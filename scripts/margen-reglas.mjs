// Cuanto margen tienen las peticiones PERMITIDAS antes del limite de Firestore de 1000 expresiones de reglas por peticion.
//
// Firestore evalua como maximo 1000 expresiones por peticion y, si una peticion que deberia pasar llega a ese limite, la
// RECHAZA. Lo comprobado con el emulador el 2026-11-23 (scripts temporales, ver CLAUDE.md "LIMITE DE FIRESTORE"):
//   - Para DECIDIR, && y || cortan como se espera: una alternativa cara que no se alcanza no gasta nada, y una peticion
//     permitida solo paga el camino que recorre hasta su primer "si". Si ese camino pasa de 1000, se rechaza.
//   - Despues de RECHAZAR una actualizacion (update), el emulador vuelve a evaluar la regla para explicar el rechazo y en esa
//     segunda vuelta solo corta en lo que depende de request.auth o request.time: lo que depende de los datos (del documento,
//     de lo que llega o de get()) se evalua entero. Ahi aparece el aviso "maximum of 1000" de firestore-debug.log, cuando el
//     rechazo ya estaba decidido: no cambia ningun resultado (en produccion el rechazo no trae explicacion).
// Por eso contar avisos en firestore-debug.log no dice nada (casi todos son de rechazos) y lo que hay que vigilar es cuanto
// le falta a cada peticion permitida para llegar al limite. Esta herramienta lo mide asi: le pone a CADA regla (cada
// "allow ...: if X;") un relleno de N expresiones que siempre vale (margenReglas() && (X)), carga esas reglas en el emulador,
// corre las pruebas y vuelve a poner las reglas reales. Toda peticion permitida que de todos modos pasa tiene al menos N
// expresiones de margen; si una prueba que debe pasar falla, esa peticion tiene menos de N.
//
//   cd scripts && node margen-reglas.mjs --margen=200                 (test-emulator.mjs con 200 expresiones de margen)
//   cd scripts && node margen-reglas.mjs --margen=200 --prueba=test-emulator.mjs,test-finanzas-nube.mjs
//   cd scripts && node margen-reglas.mjs --margen=200 --reglas=/ruta/otras.rules   (comparar con otra version de las reglas)
//
// Necesita los emuladores encendidos (firebase emulators:start). Corre `npm run seed` antes de cada prueba. No toca
// firestore.rules en disco: carga las reglas con relleno directo en el emulador y al terminar (o con Ctrl+C) le devuelve el
// archivo real. La prueba de OIKOS en Chrome (test-finanzas-navegador.mjs) tambien sirve con --prueba.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'sisdel-datacenter';
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const MARGIN = Number(arg('margen', '200'));
const TESTS = arg('prueba', 'test-emulator.mjs').split(',').map((s) => s.trim()).filter(Boolean);
const REAL_FILE = path.join(HERE, '..', 'firestore.rules');
const RULES_FILE = arg('reglas', REAL_FILE);
if (!Number.isFinite(MARGIN) || MARGIN < 0 || MARGIN > 990) {
    console.error('--margen debe ser un numero de 0 a 990');
    process.exit(2);
}

// Una expresion que siempre vale y que el emulador no puede resolver de antemano (request.time cambia en cada peticion)
const UNIT = 'request.time != null';
// En grupos de 25: una cadena mas larga no compila ("Expression is too complex")
function pad(k) {
    const groups = [];
    for (let i = 0; i < k; i += 25) groups.push('(' + Array(Math.min(25, k - i)).fill(UNIT).join(' && ') + ')');
    return groups.length ? groups.join(' && ') : 'true';
}

async function loadRules(content) {
    const r = await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}:securityRules`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
    });
    if (!r.ok) throw new Error(`el emulador no acepto las reglas (${r.status}): ${(await r.text()).slice(0, 400)}`);
}

// Las reglas reales siempre vuelven al emulador, tambien con Ctrl+C
let restoring = null;
function restore() {
    if (!restoring) restoring = loadRules(fs.readFileSync(REAL_FILE, 'utf8')).then(() => console.log('Reglas reales repuestas en el emulador.'));
    return restoring;
}
process.on('SIGINT', () => { restore().finally(() => process.exit(130)); });

// Cuantas expresiones gasta una unidad del relleno: el mayor relleno que todavia pasa en una regla de prueba
let probe = 0;
async function passes(k) {
    await loadRules(`rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents {\n  function margenReglas() { return ${pad(k)}; }\n  match /zz_margen_reglas/{id} { allow create: if margenReglas(); }\n}}`);
    const r = await fetch(`http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/zz_margen_reglas/p${probe++}?currentDocument.exists=false`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { v: { integerValue: '1' } } }),
    });
    const text = await r.text();
    if (r.ok) return true;
    if (text.includes('maximum of 1000')) return false;
    throw new Error('respuesta inesperada al medir: ' + text.slice(0, 300));
}
async function unitCost() {
    let lo = 1, hi = 600;
    if (!(await passes(lo)) || (await passes(hi))) throw new Error('no se pudo medir el relleno');
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await passes(mid)) lo = mid; else hi = mid; }
    return 1000 / hi; // con hi unidades (mas la llamada a la funcion) ya se pasa
}

// margenReglas() && (X) en cada "allow ...: if X;" (cada X termina en el primer ';' y debe tener sus parentesis completos)
function withMargin(rules, k) {
    const head = 'match /databases/{database}/documents {';
    const at = rules.indexOf(head);
    if (at < 0) throw new Error('no encontre ' + head);
    let out = rules.slice(0, at + head.length) + `\n    function margenReglas() { return ${pad(k)}; }` + rules.slice(at + head.length);
    const re = /\ballow\s+[a-z, ]+:\s*if\s/g;
    let m, count = 0, result = '', last = 0;
    while ((m = re.exec(out))) {
        const start = m.index + m[0].length;
        const end = out.indexOf(';', start);
        const expr = out.slice(start, end);
        let depth = 0;
        for (const ch of expr) { if (ch === '(') depth++; else if (ch === ')') depth--; }
        if (depth !== 0) throw new Error('una regla no se pudo envolver (parentesis) cerca de: ' + expr.slice(0, 80));
        result += out.slice(last, start) + 'margenReglas() && (' + expr + ')';
        last = end;
        re.lastIndex = end;
        count++;
    }
    return { rules: result + out.slice(last), count };
}

function runNode(file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [file], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', () => {});
        child.on('close', (code) => resolve({ code, out }));
    });
}
function runSeed() {
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['run', '-s', 'seed'], { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('npm run seed fallo'))));
    });
}

try {
    await fetch(`http://${FIRESTORE}/`).catch(() => { throw new Error(`no responde el emulador de Firestore en ${FIRESTORE}`); });
    const unit = await unitCost();
    const k = Math.ceil(MARGIN / unit);
    const { rules, count } = withMargin(fs.readFileSync(RULES_FILE, 'utf8'), k);
    console.log(`Relleno: ${k} x "${UNIT}" (~${(k * unit).toFixed(0)} expresiones; cada una ~${unit.toFixed(1)}) en ${count} reglas`
        + (RULES_FILE === REAL_FILE ? '' : ` de ${RULES_FILE}`) + '.');
    let failed = 0;
    for (const test of TESTS) {
        await runSeed();
        await loadRules(rules);
        const { code, out } = await runNode(test);
        await restore(); restoring = null;
        const fails = out.split('\n').filter((l) => /^\s*FALLA\b/.test(l));
        const summary = (out.match(/Resultado:[^\n]*/g) || []).pop() || `termino con codigo ${code}`;
        console.log(`\n${test}: ${summary}`);
        for (const line of fails) console.log('  ' + line.trim());
        if (fails.length || code !== 0) failed++;
    }
    console.log(failed
        ? `\nCon ${MARGIN} expresiones de margen fallaron pruebas: esas peticiones permitidas estan a menos de ${MARGIN} del limite (o la prueba fallo por otra razon: correrla sin margen para comparar).`
        : `\nTodas pasaron: cada peticion permitida de estas pruebas tiene al menos ${MARGIN} expresiones de margen antes del limite.`);
    process.exitCode = failed ? 1 : 0;
} catch (e) {
    console.error(e.message || e);
    process.exitCode = 2;
} finally {
    await restore();
}
