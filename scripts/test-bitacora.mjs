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
    equal('una foto de comprobante se anota por su tamano, no entera', B.plainValue('data:image/jpeg;base64,' + 'A'.repeat(60000)), '[texto de 60023 letras]');
    equal('un texto normal se anota tal cual', B.plainValue('Paga por transferencia'), 'Paga por transferencia');
    equal('una fecha del servidor se anota como texto', B.plainValue(serverTime(T1)), T1);
    equal('mapas y listas se anotan completos, con las claves en orden', B.plainValue({ b: [1, { z: 1, a: 2 }], a: null }), { a: null, b: [1, { a: 2, z: 1 }] });
    equal('lo que no existe es null', [B.plainValue(undefined), B.plainValue(null)], [null, null]);
    const e = B.buildEntry({ collection: 'usuarios', docId: 'u1', before: { name: 'Ana', privilegios: { 'finanzas.usar': true } }, after: { name: 'Ana', privilegios: { 'finanzas.usar': false, 'usuarios.crear': true } }, authType: 'unknown', authId: 'u-admin' });
    equal('un cambio de privilegios muestra el mapa de antes y el de despues', e.changes, { privilegios: { from: { 'finanzas.usar': true }, to: { 'finanzas.usar': false, 'usuarios.crear': true } } });
    equal('y a quien se le cambiaron', e.subject, { name: 'Ana' });
    equal('un residente: se reconoce por su id', B.subjectOf('finanzas_residentes', { id: 'r1', dpi: '123' }), { id: 'r1' });
    equal('un vehiculo: por su placa y su dueno', B.subjectOf('vehiculos', { plate: 'P-123ABC', userId: 'r1', color: 'Rojo' }), { plate: 'P-123ABC', userId: 'r1' });
}

console.log('\nQuien');
{
    equal('un usuario del condominio se busca por su id', B.userIdOf('unknown', 'u-admin'), 'u-admin');
    equal('el master, el servidor y lo que no es un id de usuario no se buscan', [B.userIdOf('unknown', 'master'), B.userIdOf('service_account', 'firebase-adminsdk@x.iam.gserviceaccount.com'), B.userIdOf('unknown', 'alguien@correo.com'), B.userIdOf('unknown', 'a/b'), B.userIdOf('system', 'x'), B.userIdOf('unknown', null)], [null, null, null, null, null, null]);
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
    equal('colecciones con rastro', Object.keys(B.AUDITED).sort(), ['finanzas_config', 'finanzas_movimientos', 'finanzas_residentes', 'usuarios', 'vehiculos']);
    yes('cada una tiene su disparador publicado', ['auditUsers', 'auditVehicles', 'auditFinanceResidents', 'auditFinanceMovements', 'auditFinanceSettings'].every((name) => new RegExp(`\\b${name}\\b`).test(main) && new RegExp(`${name}: audit\\(`).test(index)));
    yes('quien hizo el cambio sale del evento del servidor, no de un dato del navegador', /onDocumentWrittenWithAuthContext/.test(index) && /authType: event\.authType, authId: event\.authId/.test(index));
    yes('la hora es la del servidor', /at: FieldValue\.serverTimestamp\(\)/.test(index));
    yes('si no se pudo anotar, se reintenta; y el mismo evento no se anota dos veces', /retry: true/.test(index) && /doc\(entryId\)/.test(index) && /event\.id/.test(index));
    yes('no se anota nada de un condominio que ya no existe (se esta eliminando)', /if \(!condoSnap\.exists\) return false;/.test(index));
    yes('las reglas no dejan escribir, cambiar ni borrar la bitacora', /match \/bitacora\/\{entryId\} \{\s*allow read: [^;]+;\s*allow write: if false;\s*\}/.test(rules));
    yes('la bitacora no tiene disparador propio (no se anota a si misma)', !/audit\('bitacora'\)/.test(index) && !('bitacora' in B.AUDITED));
    yes('los codigos de acceso no se anotan (no estan entre las colecciones con rastro)', !('codigos' in B.AUDITED));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
