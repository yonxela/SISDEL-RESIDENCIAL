// Pruebas de la bitacora (functions/src/bitacora/entrada.js): como se arma el rastro de cada cambio. Sin emuladores.
// Lo que pasa en el servidor (que se anota de verdad, que nadie la puede escribir) se prueba en test-finanzas-nube.mjs.
// Uso: node test-bitacora.mjs (tambien corre con npm test).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../functions/src/bitacora/entrada.js');
const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function yes(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    yes(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';
// Una fecha del servidor como las de Firestore
const serverTime = (iso) => ({ toDate: () => new Date(iso), toMillis: () => Date.parse(iso) });
const payment = { id: 'p1', type: 'income', amount: 425, concept: 'Cuota - Noviembre 2026', resiId: 'r1', receiptNum: 'AB0001', created_at: T1, updated_at: T1 };
const entry = (before, after, extra = {}) => B.buildEntry({ collection: 'finanzas_movimientos', docId: 'p1', before, after, authType: 'unknown', authId: 'u-admin', eventTime: T2, ...extra });

console.log('\nQue se anota');
{
    let e = entry(null, payment);
    equal('un pago nuevo: "crear", con todo su contenido', [e.action, e.changes.amount, e.changes.resiId, Object.keys(e.changes).length], ['crear', { from: null, to: 425 }, { from: null, to: 'r1' }, Object.keys(payment).length]);
    equal('con lo necesario para reconocerlo sin abrirlo', e.subject, { type: 'income', amount: 425, concept: 'Cuota - Noviembre 2026', resiId: 'r1', receiptNum: 'AB0001' });
    equal('quien y cuando vienen del evento', [e.actorType, e.actorId, e.eventTime, e.collection, e.docId], ['unknown', 'u-admin', T2, 'finanzas_movimientos', 'p1']);

    const annulled = { ...payment, deleted: true, deleted_at: T2, deleted_reason: 'Duplicado', updated_at: T2 };
    e = entry(payment, annulled);
    equal('anular: "anular", con el motivo y solo lo que cambio', [e.action, e.changes.deleted, e.changes.deleted_reason, Object.keys(e.changes).sort()], ['anular', { from: null, to: true }, { from: null, to: 'Duplicado' }, ['deleted', 'deleted_at', 'deleted_reason', 'updated_at']]);
    e = entry(annulled, { ...annulled, deleted: false, restored_at: T2 });
    equal('devolver una anulacion: "restaurar"', [e.action, e.changes.deleted, e.changes.restored_at], ['restaurar', { from: true, to: false }, { from: null, to: T2 }]);
    e = entry(payment, null);
    equal('eliminar: queda el contenido completo de lo eliminado', [e.action, e.changes.amount, e.changes.concept, e.subject.amount], ['eliminar', { from: 425, to: null }, { from: 'Cuota - Noviembre 2026', to: null }, 425]);
    e = entry(payment, { ...payment, amount: 500 });
    equal('un cambio cualquiera: "cambiar", con el valor de antes y el de despues', [e.action, e.changes], ['cambiar', { amount: { from: 425, to: 500 } }]);

    equal('si solo cambia el sello del servidor no se anota nada', entry(payment, { ...payment, server_at: serverTime(T2) }), null);
    equal('ni si se escribe lo mismo', entry(payment, { ...payment }), null);
    equal('ni si no hay documento antes ni despues', entry(null, null), null);
    e = entry(payment, { ...payment, deleted: true, server_at: serverTime(T2) });
    yes('el sello del servidor nunca aparece entre los cambios', e.action === 'anular' && !('server_at' in e.changes));
}

console.log('\nValores');
{
    const photo = B.plainValue('data:image/jpeg;base64,' + 'A'.repeat(60000));
    yes('una foto de comprobante no se anota entera: el principio, su tamano y su huella', photo.length < 400 && photo.startsWith('data:image/jpeg;base64,AAAA') && /\[60023 letras, huella [0-9a-f]{10}\]$/.test(photo), photo.slice(-50));
    const long1 = B.buildEntry({ collection: 'finanzas_residentes', docId: 'r1', before: { id: 'r1', notes: 'a'.repeat(400) }, after: { id: 'r1', notes: 'a'.repeat(399) + 'b' }, authType: 'unknown', authId: 'u' });
    yes('dos textos largos del mismo tamano pero distintos SI dejan anotacion, con huellas distintas', !!long1 && long1.changes.notes.from !== long1.changes.notes.to);
    equal('un dato binario se anota por su tamano', B.plainValue(Buffer.alloc(30000, 7)).replace(/huella \w+/, 'huella X'), '[binario de 30000 bytes, huella X]');
    equal('una referencia a otro documento se anota por su ruta, sin datos internos', B.plainValue({ path: 'condominios/c1/usuarios/u1', firestore: { _settings: { secreto: 'x' } } }), '[referencia condominios/c1/usuarios/u1]');
    equal('un objeto raro se anota por su nombre', B.plainValue(new (class GeoRaro {})()), '[GeoRaro]');
    equal('un numero que no es numero no rompe la anotacion', [B.plainValue(NaN), B.plainValue(Infinity)], ['NaN', 'Infinity']);
    equal('un texto normal se anota tal cual', B.plainValue('Paga por transferencia'), 'Paga por transferencia');
    equal('una fecha del servidor se anota como texto', B.plainValue(serverTime(T1)), T1);
    equal('mapas y listas se anotan completos, con las claves en orden', B.plainValue({ b: [1, { z: 1, a: 2 }], a: null }), { a: null, b: [1, { a: 2, z: 1 }] });
    equal('lo que no existe es null', [B.plainValue(undefined), B.plainValue(null)], [null, null]);
    const e = B.buildEntry({ collection: 'usuarios', docId: 'u1', before: { name: 'Ana', privilegios: { 'finanzas.usar': true } }, after: { name: 'Ana', privilegios: { 'finanzas.usar': false, 'usuarios.crear': true } }, authType: 'unknown', authId: 'u-admin' });
    equal('un cambio de privilegios muestra solo las claves que cambiaron, con su valor de antes y de despues', e.changes, { privilegios: { from: { 'finanzas.usar': true, 'usuarios.crear': null }, to: { 'finanzas.usar': false, 'usuarios.crear': true } } });
    const same = B.buildEntry({ collection: 'usuarios', docId: 'u1', before: { privilegios: { a: true, b: false } }, after: { privilegios: { b: false, a: true } }, authType: 'unknown', authId: 'u' });
    equal('el mismo mapa en otro orden no es un cambio', same, null);
    equal('y a quien se le cambiaron', e.subject, { name: 'Ana' });
    equal('un residente: se reconoce por su id', B.subjectOf('finanzas_residentes', { id: 'r1', dpi: '123' }), { id: 'r1' });
    equal('un vehiculo: por su placa y su dueno', B.subjectOf('vehiculos', { plate: 'P-123ABC', userId: 'r1', color: 'Rojo' }), { plate: 'P-123ABC', userId: 'r1' });
}

console.log('\nAnotaciones grandes');
{
    const junk = {};
    for (let i = 0; i < 9000; i++) junk['k' + i] = 'v'.repeat(60);
    const big = B.buildEntry({ collection: 'usuarios', docId: 'u1', before: { name: 'Ana', junk, privilegios: { a: true } }, after: { name: 'Ana', junk: {}, privilegios: { a: false } }, authType: 'unknown', authId: 'u-admin' });
    yes('un cambio enorme se resume y queda marcado, pero el cambio de privilegios que venia con el se conserva entero', big.truncated === true && JSON.stringify(big).length < 5000 && JSON.stringify(big.changes.privilegios) === JSON.stringify({ from: { a: true }, to: { a: false } }) && /valor grande: \d+ letras, huella/.test(big.changes.junk.from));
    yes('la anotacion queda dentro de lo que Firestore admite', JSON.stringify(big).length <= B.MAX_ENTRY_CHARS && B.leaves(big.changes) <= B.MAX_LEAVES);
    const wide = {};
    for (let i = 0; i < 3000; i++) wide['campo' + i] = i;
    const many = B.buildEntry({ collection: 'vehiculos', docId: 'v1', before: null, after: { plate: 'P-1', ...wide }, authType: 'unknown', authId: 'u' });
    yes('con miles de campos se anota cuantos y cuales cambiaron (resumido)', many.truncated === true && Object.keys(many.changes).length === 1 && /^3001 campos cambiaron: /.test(many.changes['(campos)'].to) && B.leaves(many.changes) < 10);
    const blob = B.buildEntry({ collection: 'vehiculos', docId: 'v1', before: null, after: { plate: 'P-1', blob: Buffer.alloc(100000, 1) }, authType: 'unknown', authId: 'u' });
    yes('un binario grande no infla la anotacion', JSON.stringify(blob).length < 1000 && blob.truncated === undefined);
    const normal = B.buildEntry({ collection: 'usuarios', docId: 'u1', before: null, after: { name: 'Ana', privilegios: Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['clave.' + i, false])) }, authType: 'unknown', authId: 'u' });
    yes('un usuario con 300 privilegios cabe entero, sin resumir', normal.truncated === undefined && Object.keys(normal.changes.privilegios.to).length === 300);
    const minimal = B.minimalEntry(big, 'INVALID_ARGUMENT: demasiado grande');
    equal('si aun asi Firestore la rechaza, queda lo minimo: documento, accion, quien y que campos', [minimal.collection, minimal.docId, minimal.action, minimal.actorId, minimal.changes['(campos)'].to, minimal.truncated, minimal.note], ['usuarios', 'u1', 'cambiar', 'u-admin', 'junk, privilegios', true, 'INVALID_ARGUMENT: demasiado grande']);
    const subject = B.subjectOf('finanzas_movimientos', { concept: 'x'.repeat(5000), amount: 5 });
    yes('lo que identifica al registro tambien va resumido', JSON.stringify(subject).length < 600 && subject.amount === 5);
}

console.log('\nQuien');
{
    equal('un usuario del condominio se busca por su id', B.userIdOf('unknown', 'u-admin'), 'u-admin');
    equal('el servidor y lo que no es un id de usuario no se buscan', [B.userIdOf('service_account', 'firebase-adminsdk@x.iam.gserviceaccount.com'), B.userIdOf('unknown', 'alguien@correo.com'), B.userIdOf('unknown', 'a/b'), B.userIdOf('system', 'x'), B.userIdOf('unknown', null)], [null, null, null, null, null]);
    equal('"master" tambien se busca: si hay una ficha con ese id, es ese usuario y no el Master', [B.userIdOf('unknown', 'master'), B.actorOf({ actorType: 'unknown', actorId: 'master' }, { name: 'Impostor', role: 'vecino' })], ['master', { actorName: 'Impostor', actorRole: 'vecino' }]);
    equal('usuario encontrado: su nombre y su rol', B.actorOf({ actorType: 'unknown', actorId: 'u-admin' }, { name: 'Fernando López', role: 'admin' }), { actorName: 'Fernando López', actorRole: 'admin' });
    equal('el master', B.actorOf({ actorType: 'unknown', actorId: 'master' }, null), { actorName: 'Master', actorRole: 'master' });
    equal('el servidor (cuotas del dia, mora, cargas por script)', B.actorOf({ actorType: 'service_account', actorId: 'firebase-adminsdk@x.iam.gserviceaccount.com' }, null), { actorName: 'Servidor', actorRole: 'servidor' });
    equal('si no se reconoce, queda el identificador tal como llego', [B.actorOf({ actorType: 'unknown', actorId: 'raro' }, null), entry(null, payment, { authId: 'raro' }).actorId], [{ actorName: '', actorRole: '' }, 'raro']);
    equal('sin datos de quien: queda como desconocido, pero se anota', [entry(null, payment, { authType: undefined, authId: undefined }).actorType, entry(null, payment, { authType: undefined, authId: undefined }).actorId], ['unknown', null]);
}

console.log('\nConexiones');
{
    const index = read('functions/src/bitacora/index.js');
    const main = read('functions/index.js');
    const rules = read('firestore.rules');
    equal('colecciones con rastro', Object.keys(B.AUDITED).sort(), ['finanzas_bancos', 'finanzas_bancos_movs', 'finanzas_config', 'finanzas_movimientos', 'finanzas_residentes', 'panico_config', 'usuarios', 'vecino_config', 'vehiculos']);
    yes('cada una tiene su disparador publicado', ['auditUsers', 'auditVehicles', 'auditFinanceResidents', 'auditFinanceMovements', 'auditFinanceSettings', 'auditPanicConfig', 'auditVecinoConfig'].every((name) => new RegExp(`\\b${name}\\b`).test(main) && new RegExp(`${name}: audit\\(`).test(index)));
    yes('quien hizo el cambio sale del evento del servidor, no de un dato del navegador', /onDocumentWrittenWithAuthContext/.test(index) && /authType: event\.authType, authId: event\.authId/.test(index));
    yes('la hora es la del servidor', /at: FieldValue\.serverTimestamp\(\)/.test(index));
    yes('si no se pudo anotar, se reintenta; y el mismo evento no se anota dos veces', /retry: true/.test(index) && /doc\(entryId\)/.test(index) && /event\.id/.test(index));
    yes('no se anota nada de un condominio que ya no existe o que se esta eliminando', /if \(!condoSnap\.exists \|\| condoSnap\.get\('purging'\) === true\) return false;/.test(index));
    yes('al eliminar un condominio lo primero es marcarlo, antes de borrar nada', (() => { const purga = read('functions/src/purga.js'); return purga.indexOf("condoRef.update({ purging: true })") > 0 && purga.indexOf("condoRef.update({ purging: true })") < purga.indexOf('db.recursiveDelete(condoRef)'); })());
    yes('una anotacion rechazada por Firestore no se reintenta sin fin: se guarda lo minimo', /if \(isTransient\(error\)\) throw error;/.test(index) && /minimalEntry\(entry, error\.message\)/.test(index));
    yes('para leerla hay que poder ver todo lo que anota: usuarios, vehiculos y finanzas', /pUsuariosVer\(condoId\) && pVehiculosVer\(condoId\) && pFinanzasVer\(condoId\)/.test(rules));
    yes('nadie puede crear un usuario con el id reservado del master', /userId != 'master' && validUser\(\)/.test(rules));
    yes('las reglas no dejan escribir, cambiar ni borrar la bitacora', /match \/bitacora\/\{entryId\} \{\s*allow read: [^;]+;\s*allow write: if false;\s*\}/.test(rules));
    yes('la bitacora no tiene disparador propio (no se anota a si misma)', !/audit\('bitacora'\)/.test(index) && !('bitacora' in B.AUDITED));
    yes('los codigos de acceso no se anotan (no estan entre las colecciones con rastro)', !('codigos' in B.AUDITED));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
