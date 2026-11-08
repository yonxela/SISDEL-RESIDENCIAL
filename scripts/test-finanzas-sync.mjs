// Pruebas de la mezcla del Sistema Financiero (finanzas-sync.js): sin emuladores.
// Uso: node test-finanzas-sync.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { internals: F } = require('../finanzas-sync.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-02T10:00:00.000Z';
const NOW = '2026-11-07T12:00:00.000Z';
const cloudMap = (items) => new Map(items.map((x) => [F.docIdOf(x), x]));
const syncedMap = (items) => new Map(items.map((x) => [F.docIdOf(x), F.canon(x)]));

console.log('\nClaves');
equal('clave de OIKOS por condominio', F.storageKey('condo-a', 'transactions'), 'oikos_multisys-condo-a_transactions');
equal('id de documento sin barras', F.docIdOf({ id: 'a/b/c' }), 'a_b_c');
equal('id numerico se vuelve texto', F.docIdOf({ id: 1730000000001 }), '1730000000001');
equal('lista ilegible se trata como vacia', F.parseArray('{roto'), []);
equal('lista inexistente es null', F.parseArray(null), null);

console.log('\nComparacion estable');
equal('el orden de las claves no cuenta como cambio', F.canon({ b: 1, a: { d: 2, c: 3 } }) === F.canon({ a: { c: 3, d: 2 }, b: 1 }), true);
equal('el saldo no cuenta como cambio', F.canon({ id: '1', balance: -500 }) === F.canon({ id: '1', balance: 0 }), true);
equal('periodo de cuota', F.periodOf(new Date(2026, 0, 15)), '2026-01');

console.log('\nVecino de SISDEL <-> residente de OIKOS');
equal('telefono local recibe codigo de Guatemala', F.toContact('5555-5678'), '+50255555678');
equal('telefono con codigo se respeta', F.toContact('+52 55 1234'), '+52 55 1234');
equal('sin telefono queda vacio', F.toContact(''), '');
const vecino = { id: 'u-ana', name: 'Ana García', casa: 'Casa 12', phone: '5555-5678', role: 'vecino', paymentStatus: 'al_dia', createdAt: T1 };
let res = F.toResident(vecino, { id: 'u-ana', dpi: '123', feeFrom: '2026-11', updated_at: T2 });
equal('residente toma nombre, casa y telefono del vecino', [res.id, res.name, res.unit, res.contact], ['u-ana', 'Ana García', 'Casa 12', '+50255555678']);
equal('residente conserva sus datos financieros', [res.dpi, res.feeFrom, res.createdAt], ['123', '2026-11', T1]);
equal('residente usa el sello mas reciente', res.updated_at, T2);
equal('el residente no lleva datos de acceso del vecino', ['role', 'paymentStatus', 'phone', 'casa'].some((k) => k in res), false);
res = F.toResident({ ...vecino, updatedAt: '2026-11-05T00:00:00.000Z' }, { id: 'u-ana', updated_at: T1 });
equal('una edicion en SISDEL tambien cuenta como cambio', res.updated_at, '2026-11-05T00:00:00.000Z');
let split = F.splitResident({ id: 'u-ana', name: 'Ana García', unit: 'Casa 12', contact: '+50255555678', dpi: '123', balance: -500, updated_at: T2 }, vecino);
equal('sin cambios de nombre, casa ni telefono no se toca el vecino', split.changes, {});
equal('el DPI va a los datos financieros, sin nombre ni saldo', [split.extra.dpi, 'name' in split.extra, 'balance' in split.extra], ['123', false, false]);
split = F.splitResident({ id: 'u-ana', name: 'Ana G. López', unit: 'Casa 14', contact: '+50299990000' }, vecino);
equal('cambios en OIKOS actualizan el vecino', split.changes, { name: 'Ana G. López', casa: 'Casa 14', phone: '+50299990000' });
split = F.splitResident({ id: '1731', name: ' Nuevo ', unit: '013', contact: '' }, null);
equal('residente nuevo trae los datos para crear el vecino', [split.changes, split.core], [null, { name: 'Nuevo', casa: '013', phone: '' }]);
equal('condominio nuevo arranca en quetzales y cobro manual', [F.INITIAL_SETTINGS.currency, F.INITIAL_SETTINGS.feeMode], ['GTQ', 'manual']);

console.log('\nMezcla al abrir');
let r = F.mergeList([{ id: '1', v: 'local', updated_at: T2 }], cloudMap([{ id: '1', v: 'nube', updated_at: T1 }]));
equal('gana lo local si es mas nuevo y se sube', [r.merged[0].v, r.toPush.length], ['local', 1]);
r = F.mergeList([{ id: '1', v: 'local', updated_at: T1 }], cloudMap([{ id: '1', v: 'nube', updated_at: T2 }]));
equal('gana la nube si es mas nueva', [r.merged[0].v, r.toPush.length], ['nube', 0]);
r = F.mergeList([{ id: '1', v: 'local', updated_at: T1 }], cloudMap([{ id: '1', v: 'nube', updated_at: T1 }]));
equal('en empate gana la nube', r.merged[0].v, 'nube');
r = F.mergeList([], cloudMap([{ id: '1', updated_at: T1 }, { id: '2', updated_at: T1 }]));
equal('equipo nuevo recibe todo de la nube', r.merged.map((x) => x.id), ['1', '2']);
r = F.mergeList([{ id: '9', updated_at: T1 }], cloudMap([]));
equal('lo que solo esta local se sube', r.toPush.map((x) => x.id), ['9']);
r = F.mergeList([{ id: '9', updated_at: T1 }], cloudMap([]), false);
equal('vecino eliminado en SISDEL no se revive desde la copia local', [r.merged.length, r.toPush.length], [0, 0]);
r = F.mergeList([{ id: '1', updated_at: T1 }, { id: '1', updated_at: T2 }], cloudMap([]));
equal('ids repetidos quedan una vez', r.merged.length, 1);
r = F.mergeList([{ id: '1', updated_at: T1 }], cloudMap([{ id: '1', deleted: true, updated_at: T2 }]));
equal('una anulacion de otro equipo se respeta', r.merged[0].deleted, true);
r = F.mergeList([{ id: 'b', updated_at: T1 }], cloudMap([{ id: 'a', updated_at: T1, created_at: T2 }, { id: 'c', updated_at: T1, created_at: T1 }]));
equal('orden: local primero, luego la nube por fecha de alta', r.merged.map((x) => x.id), ['b', 'c', 'a']);

console.log('\nCambios mientras OIKOS esta abierto');
const base = [{ id: '1', amount: 100, updated_at: T1 }, { id: '2', amount: 200, updated_at: T1 }];
let d = F.diffList(base, syncedMap(base), NOW);
equal('sin cambios no se sube nada', [d.changed.length, d.rewrite], [0, false]);
d = F.diffList([{ id: '1', amount: 150, updated_at: T2 }, base[1]], syncedMap(base), NOW);
equal('cambio con sello nuevo se sube tal cual', [d.changed.map((x) => x.amount), d.rewrite], [[150], false]);
d = F.diffList([{ id: '1', amount: 150, updated_at: T1 }, base[1]], syncedMap(base), NOW);
equal('cambio sin sello nuevo se sella ahora', [d.changed[0].updated_at, d.rewrite, d.items[0].updated_at], [NOW, true, NOW]);
d = F.diffList([base[0], base[1], { id: '3', amount: 50, updated_at: T2 }], syncedMap(base), NOW);
equal('registro nuevo se sube', d.changed.map((x) => x.id), ['3']);
d = F.diffList([base[0]], syncedMap(base), NOW);
equal('registro que desaparece ("deshacer") se anula', [d.changed[0].id, d.changed[0].deleted, d.changed[0].updated_at, d.rewrite], ['2', true, NOW, true]);
equal('la anulacion tambien queda en la lista local', d.items.map((x) => [x.id, !!x.deleted]), [['1', false], ['2', true]]);
const withTomb = [base[0], { id: '2', amount: 200, deleted: true, updated_at: T2 }];
d = F.diffList([base[0]], syncedMap(withTomb), NOW);
equal('lo ya anulado no se vuelve a anular', d.changed.length, 0);
d = F.diffList([base[0], { id: '2', amount: 200, updated_at: T1 }], syncedMap(withTomb), NOW);
equal('"rehacer" revive el registro con sello nuevo', [d.changed[0].deleted, d.changed[0].updated_at], [undefined, NOW]);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
