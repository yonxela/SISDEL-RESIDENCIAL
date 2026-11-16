// Prueba de confirmOwnCode (functions/src/auth.js): confirmar la PROPIA clave antes de una accion delicada (aplicar la
// cuota del mes en cobro manual). Corre la funcion de verdad con una base de datos simulada en memoria: sin emuladores.
// Las mismas comprobaciones corren contra los emuladores en test-emulator.mjs (seccion "Confirmar la propia clave").
// Uso: node test-confirmar-clave.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// La funcion registra cada intento (nunca el codigo) con el logger de Firebase; aqui se silencia para leer la salida
const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (/^\{"[\s\S]*"severity"/.test(String(chunk)) ? true : writeOut(chunk, ...rest));

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

// ── Base de datos simulada (solo lo que usan auth.js, master.js y rateLimit.js) ──
const store = new Map();
const docRef = (path) => ({
    path,
    get: async () => ({ exists: store.has(path), data: () => store.get(path), id: path.split('/').pop() }),
    delete: async () => { store.delete(path); },
    set: async (data) => { store.set(path, { ...data }); },
    update: async (data) => { store.set(path, { ...store.get(path), ...data }); }
});
const fakeDb = {
    doc: docRef,
    runTransaction: async (fn) => fn({
        get: async (ref) => ref.get(),
        set: (ref, data) => store.set(ref.path, { ...data }),
        update: (ref, data) => store.set(ref.path, { ...store.get(ref.path), ...data })
    })
};
const firebasePath = require.resolve('../functions/src/firebase.js');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: fakeDb, auth: {} } };

const { confirmOwnCode } = require('../functions/src/auth.js');
const call = (uid, token, code) => confirmOwnCode.run({ auth: uid === null ? null : { uid, token }, data: { code }, rawRequest: { headers: {}, ip: '127.0.0.1' } });
const outcome = async (promise) => { try { return (await promise).ok; } catch (e) { return e.code || String(e.message); } };

function seed() {
    store.clear();
    const person = (condo, id, code, role, extra = {}) => {
        store.set(`codigos/${code}`, { condominioId: condo, userId: id });
        store.set(`condominios/${condo}/usuarios/${id}`, { name: id, role, ...extra });
    };
    store.set('condominios/c1', { name: 'Condominio Uno' });
    store.set('condominios/c2', { name: 'Condominio Dos' });
    person('c1', 'u-admin', 'VF100', 'admin');
    person('c1', 'u-ana', 'VA101', 'vecino');
    person('c1', 'u-guardia', 'VP103', 'policia');
    person('c1', 'u-baja', 'VB104', 'admin', { active: false });
    person('c2', 'u-otro', 'VO200', 'admin');
    store.set('_privado/auth', { masterCodeHash: sha256('MASTER1') });
}
const admin = ['u-admin', { condominioId: 'c1', role: 'admin' }];
const ana = ['u-ana', { condominioId: 'c1', role: 'vecino' }];
const guardia = ['u-guardia', { condominioId: 'c1', role: 'policia' }];

console.log('\nConfirmar la propia clave');
seed();
equal('la clave propia vale, sin importar mayusculas ni espacios', [await outcome(call(...admin, 'VF100')), await outcome(call(...admin, ' vf100 '))], [true, true]);
seed();
equal('el codigo de otra persona del mismo condominio NO vale', [await outcome(call(...admin, 'VA101')), await outcome(call(...ana, 'VF100'))], [false, false]);
seed();
equal('una clave inventada, vacia o rara tampoco', [await outcome(call(...admin, 'ZZZ999')), await outcome(call(...admin, '')), await outcome(call(...admin, '   ')), await outcome(call(...admin, null)), await outcome(call(...admin, 'a/b'))], [false, false, false, false, false]);
seed();
equal('el codigo de otro condominio no vale', await outcome(call(...admin, 'VO200')), false);
seed();
equal('el guardia confirma su codigo y no el del administrador', [await outcome(call(...guardia, 'VP103')), await outcome(call(...guardia, 'VF100'))], [true, false]);
equal('un usuario dado de baja no confirma ni con su propio codigo', await outcome(call('u-baja', { condominioId: 'c1', role: 'admin' }, 'VB104')), false);
seed();
equal('el master confirma su clave master y no el codigo de un condominio', [await outcome(call('master', { role: 'master' }, 'master1')), await outcome(call('master', { role: 'master' }, 'VF100'))], [true, false]);
equal('sin sesion se rechaza', await outcome(call(null, null, 'VF100')), 'unauthenticated');
equal('una sesion sin condominio y que no es master no confirma nada', await outcome(call('x', {}, 'VF100')), 'permission-denied');

console.log('\nLimite de intentos');
seed();
for (let i = 0; i < 4; i++) await call(...ana, 'MALA' + i);
equal('con 4 fallos todavia puede confirmar su clave (y eso reinicia la cuenta)', await outcome(call(...ana, 'VA101')), true);
for (let i = 0; i < 5; i++) await call(...ana, 'MALA' + i);
equal('al quinto fallo seguido se bloquea', await outcome(call(...ana, 'MALA9')), 'resource-exhausted');
equal('ya bloqueado, ni la clave correcta pasa', await outcome(call(...ana, 'VA101')), 'resource-exhausted');
equal('el bloqueo es de ese usuario: el administrador sigue confirmando', await outcome(call(...admin, 'VF100')), true);
// Pasada la ventana (10 minutos) vuelve a poder
for (const [path, data] of store) if (path.startsWith('_privado/rate/confirm/')) store.set(path, { ...data, windowStart: Date.now() - 11 * 60 * 1000 });
equal('pasados 10 minutos puede intentar de nuevo', await outcome(call(...ana, 'VA101')), true);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
