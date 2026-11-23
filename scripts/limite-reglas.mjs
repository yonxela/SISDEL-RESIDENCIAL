// Que paso de una prueba hace que una peticion llegue al limite de Firestore de 1000 expresiones por peticion (las reglas).
//
// Firestore evalua como maximo 1000 expresiones de reglas por peticion y, si se pasa, la RECHAZA (aunque deberia pasar). El
// emulador lo anota en firestore-debug.log ("maximum of 1000") sin decir que documento ni que prueba (y a ratos deja de
// escribir ese registro), y casi todos esos avisos son de peticiones que de todos modos se rechazan: al negar, Firestore evalua
// todas las alternativas y el emulador arma su explicacion del rechazo, y ahi se acaban las 1000. Lo que importa es que
// ninguna peticion PERMITIDA llegue al limite.
// Esta herramienta se carga antes de una prueba y mira el error que la propia prueba recibe del emulador (el SDK de Firebase
// lo escribe en la consola antes de que la prueba imprima su paso): debajo de cada paso cuyo rechazo trajo el aviso pone
// "^ LIMITE" con las lineas de firestore.rules:
//   cd scripts && npm run seed && node --import ./limite-reglas.mjs test-emulator.mjs | grep -B1 'LIMITE'
// Si cae en un paso que DEBE pasar (allowed, "puede", "permite"...), las reglas de esa coleccion se volvieron demasiado caras:
// revisar las funciones que agregan niveles (ver CLAUDE.md, "LIMITE DE FIRESTORE"). No cambia los tiempos de la prueba.
const MARK = /maximum of 1000/;
let pending = [];

function look(text) {
    const s = String(text == null ? '' : text);
    if (!MARK.test(s)) return;
    const where = (s.match(/maximum of 1000[^,\n]*for '\w+' @ L\d+/g) || []).map((m) => m.match(/for '\w+' @ L\d+/)[0]);
    pending.push(where.length ? where.join(', ') : 'sin linea');
}

// El SDK escribe sus errores por console.warn / console.error o directo en stderr
for (const name of ['warn', 'error']) {
    const original = console[name].bind(console);
    console[name] = (...args) => { args.forEach((a) => look(a && a.message ? a.message : a)); original(...args); };
}
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { look(chunk); return stderrWrite(chunk, ...rest); };

const log = console.log.bind(console);
console.log = (...args) => {
    log(...args);
    if (!pending.length) return;
    const where = [...new Set(pending.join(', ').split(', '))];
    log(`  ^ LIMITE (${pending.length}): ${where.join(', ')} de firestore.rules`);
    pending = [];
};
