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

// ── Privilegios exigidos por cada escritura (espejo de firestore.rules) ──
const allow = (...keys) => (key) => keys.includes(key);
const ok = (needs, ...keys) => F.satisfied(needs, allow(...keys));

console.log('\nPrivilegios: movimientos');
const income = { id: 'p1', type: 'income', amount: 500, resiId: 'u1', updated_at: T1 };
equal('registrar un pago exige pagos_registrar', [ok(F.movementNeeds(income, null), 'finanzas.pagos_registrar'), ok(F.movementNeeds(income, null), 'finanzas.egresos_registrar')], [true, false]);
const expense = { id: 'e1', type: 'expense', amount: 90, concept: 'Luz', updated_at: T1 };
equal('registrar un egreso exige egresos_registrar', [ok(F.movementNeeds(expense, null), 'finanzas.egresos_registrar'), ok(F.movementNeeds(expense, null), 'finanzas.pagos_registrar')], [true, false]);
equal('un movimiento nuevo en cero, negativo o con monto como texto no se sube (las reglas lo rechazan)', [ok(F.movementNeeds({ ...income, amount: 0 }, null), 'finanzas.pagos_registrar'), ok(F.movementNeeds({ ...income, amount: -5 }, null), 'finanzas.pagos_registrar'), ok(F.movementNeeds({ ...income, amount: '500' }, null), 'finanzas.pagos_registrar')], [false, false, false]);
const autoFee = { id: 'fee_u1_2026-11', type: 'charge', kind: 'fee', period: '2026-11', auto: true, amount: 300, resiId: 'u1', updated_at: T1 };
equal('la cuota automatica exige cuota del mes', [ok(F.movementNeeds(autoFee, null), 'finanzas.cuotas_mes'), ok(F.movementNeeds(autoFee, null), 'finanzas.cuotas_meses', 'finanzas.cargos_crear')], [true, false]);
const manualFee = { ...autoFee, auto: false, manual: true };
equal('la cuota manual la cobra cualquiera de las tres vias', [ok(F.movementNeeds(manualFee, null), 'finanzas.cuotas_mes'), ok(F.movementNeeds(manualFee, null), 'finanzas.cuotas_meses'), ok(F.movementNeeds(manualFee, null), 'finanzas.cargos_crear'), ok(F.movementNeeds(manualFee, null), 'finanzas.pagos_registrar')], [true, true, true, false]);
const extraCharge = { id: 'c1', type: 'charge', kind: 'extra', amount: 100, concept: 'Multa', resiId: 'u1', updated_at: T1 };
equal('un cargo especial exige cargos_crear', [ok(F.movementNeeds(extraCharge, null), 'finanzas.cargos_crear'), ok(F.movementNeeds(extraCharge, null), 'finanzas.cuotas_mes')], [true, false]);
equal('un tipo desconocido no se acepta', ok(F.movementNeeds({ id: 'x', type: 'otro' }, null), 'finanzas.pagos_registrar', 'finanzas.cargos_crear'), false);
const annulled = (tx, extra = {}) => ({ ...tx, deleted: true, deleted_at: T2, deleted_reason: 'error', updated_at: T2, ...extra });
const hoy = new Date().toISOString();
const reciente = { ...income, created_at: hoy };
equal('anular un pago exige anular pagos o deshacer (quitar un alta reciente)', [ok(F.movementNeeds(annulled(reciente), reciente), 'finanzas.pagos_anular'), ok(F.movementNeeds(annulled(reciente), reciente), 'finanzas.deshacer'), ok(F.movementNeeds(annulled(reciente), reciente), 'finanzas.egresos_anular', 'finanzas.cargos_anular')], [true, true, false]);
const viejo = { ...income, created_at: '2026-01-01T10:00:00.000Z' };
equal('deshacer no anula un movimiento viejo (pasaron mas de 2 horas)', [ok(F.movementNeeds(annulled(viejo), viejo), 'finanzas.deshacer'), ok(F.movementNeeds(annulled(viejo), viejo), 'finanzas.pagos_anular')], [false, true]);
equal('deshacer sin fecha de alta no anula (los movimientos sin created_at no son recientes)', ok(F.movementNeeds(annulled(income), income), 'finanzas.deshacer'), false);
equal('la ventana de deshacer se mide con la hora dada', [ok(F.movementNeeds(annulled(reciente), reciente, Date.parse(hoy) + 60 * 60 * 1000), 'finanzas.deshacer'), ok(F.movementNeeds(annulled(reciente), reciente, Date.parse(hoy) + 3 * 60 * 60 * 1000), 'finanzas.deshacer')], [true, false]);
equal('anular un egreso exige su propio privilegio', [ok(F.movementNeeds(annulled(expense), expense), 'finanzas.egresos_anular'), ok(F.movementNeeds(annulled(expense), expense), 'finanzas.pagos_anular', 'finanzas.cargos_anular')], [true, false]);
equal('anular un cargo especial exige anular cargos', [ok(F.movementNeeds(annulled(extraCharge), extraCharge), 'finanzas.cargos_anular'), ok(F.movementNeeds(annulled(extraCharge), extraCharge), 'finanzas.cuotas_corregir', 'finanzas.pagos_anular')], [true, false]);
equal('corregir cuotas duplicadas alcanza para anular una cuota', ok(F.movementNeeds(annulled(autoFee), autoFee), 'finanzas.cuotas_corregir'), true);
const anuladoHoy = { ...income, deleted: true, deleted_at: hoy, deleted_reason: 'x', updated_at: hoy };
equal('devolver una anulacion reciente es deshacer', [ok(F.movementNeeds(income, anuladoHoy), 'finanzas.deshacer'), ok(F.movementNeeds(income, anuladoHoy), 'finanzas.pagos_anular')], [true, false]);
equal('una anulacion vieja ya no se devuelve', ok(F.movementNeeds(income, annulled(income)), 'finanzas.deshacer'), false);
equal('cambiar el monto de un movimiento no lo permite nadie', ok(F.movementNeeds({ ...income, amount: 5000, updated_at: T2 }, income), 'finanzas.deshacer', 'finanzas.pagos_registrar', 'finanzas.pagos_anular'), false);
equal('solo la fecha de modificacion no pide nada', F.movementNeeds({ ...income, updated_at: T2 }, income), []);
const legacyCharge = { id: 'old', type: 'charge', amount: 100, concept: 'Cuota - Enero 2026', updated_at: T1 };
equal('migrar periodo y tipo de un cargo viejo no pide nada', F.movementNeeds({ ...legacyCharge, period: '2026-01', kind: 'fee', updated_at: T2 }, legacyCharge), []);
equal('reasignar el periodo de una cuota que ya lo tiene no lo permite nadie', ok(F.movementNeeds({ ...autoFee, period: '2026-05', updated_at: T2 }, autoFee), 'finanzas.deshacer', 'finanzas.cuotas_corregir', 'finanzas.pagos_registrar'), false);

console.log('\nPrivilegios: residentes');
const resNow = { id: 'u1', name: 'Ana', unit: 'Casa 1', contact: '+50255555678', dpi: '111', status: 'active', feeFrom: '2026-11', createdAt: T1, updated_at: T1 };
equal('registrar un residente nuevo exige residentes_crear y crear usuarios (crea al vecino)', [ok(F.residentNeeds(resNow, null, false), 'finanzas.residentes_crear', 'usuarios.crear'), ok(F.residentNeeds(resNow, null, false), 'finanzas.residentes_crear'), ok(F.residentNeeds(resNow, null, false), 'finanzas.residentes_editar', 'usuarios.crear')], [true, false, false]);
equal('cambiar el DPI exige residentes_editar', [ok(F.residentNeeds({ ...resNow, dpi: '222', updated_at: T2 }, resNow, true), 'finanzas.residentes_editar'), ok(F.residentNeeds({ ...resNow, dpi: '222', updated_at: T2 }, resNow, true), 'finanzas.residentes_finiquitar')], [true, false]);
equal('cambiar el nombre (vive en SISDEL) exige residentes_editar y editar usuarios', [ok(F.residentNeeds({ ...resNow, name: 'Ana M.', updated_at: T2 }, resNow, true), 'finanzas.residentes_editar', 'usuarios.editar'), ok(F.residentNeeds({ ...resNow, name: 'Ana M.', updated_at: T2 }, resNow, true), 'finanzas.residentes_editar'), ok(F.residentNeeds({ ...resNow, name: 'Ana M.', updated_at: T2 }, resNow, true), 'finanzas.residentes_finiquitar')], [true, false, false]);
equal('cambiar solo el DPI no exige editar usuarios', ok(F.residentNeeds({ ...resNow, dpi: '333', updated_at: T2 }, resNow, true), 'finanzas.residentes_editar'), true);

console.log('\nEscrituras por campo y vecinos eliminados');
equal('changedFields: solo lo que cambio mas id y sello', F.changedFields({ id: '1', a: 1, b: 2, updated_at: T2 }, { id: '1', a: 1, b: 1, updated_at: T1 }).sort(), ['b', 'id', 'updated_at']);
equal('pick toma solo esas claves', F.pick({ id: '1', a: 1, b: 2, c: 3 }, ['b', 'id', 'z']), { b: 2, id: '1' });
equal('un finiquito de otro equipo no se pisa: el "toque" de este equipo solo sube el sello', F.changedFields({ id: 'u1', status: 'active', dpi: '1', updated_at: T2 }, { id: 'u1', status: 'active', dpi: '1', updated_at: T1 }).sort(), ['id', 'updated_at']);
equal('un residente local que la nube ya conocio y ya no esta se descarta (lo eliminaron)', F.dropResurrected([{ id: 'u-viejo' }, { id: 'u-nuevo' }, { id: 'u-ana' }], cloudMap([{ id: 'u-ana' }]), new Set(['u-viejo', 'u-ana'])).map((r) => r.id), ['u-nuevo', 'u-ana']);
equal('sin memoria de la nube, lo local-solo se conserva', F.dropResurrected([{ id: 'u-x' }], cloudMap([]), new Set()).map((r) => r.id), ['u-x']);
const closed = { ...resNow, status: 'closed', closedAt: T2, closeReason: 'Mudanza', closeNotes: '', updated_at: T2 };
equal('finiquitar exige residentes_finiquitar y no residentes_editar', [ok(F.residentNeeds(closed, resNow, true), 'finanzas.residentes_finiquitar'), ok(F.residentNeeds(closed, resNow, true), 'finanzas.residentes_editar')], [true, false]);
const reactivated = { ...closed, status: 'active', reactivatedAt: T2, feeFrom: '2026-12', updated_at: T2 };
equal('reactivar tambien es de finiquitar', ok(F.residentNeeds(reactivated, closed, true), 'finanzas.residentes_finiquitar'), true);
equal('eliminar un residente exige residentes_eliminar', [ok(F.residentNeeds({ ...resNow, deleted: true, updated_at: T2 }, resNow, true), 'finanzas.residentes_eliminar'), ok(F.residentNeeds({ ...resNow, deleted: true, updated_at: T2 }, resNow, true), 'finanzas.residentes_editar')], [true, false]);
equal('solo la fecha de modificacion no pide nada', F.residentNeeds({ ...resNow, updated_at: T2 }, resNow, true), []);
equal('el saldo no cuenta como cambio', F.residentNeeds({ ...resNow, balance: -300 }, resNow, true), []);

console.log('\nPrivilegios: configuracion');
const settingsNow = { currency: 'GTQ', lang: 'es', name: 'Condo', theme: 'light', fee: 300, chargeDay: 1, graceDays: 5, feeMode: 'manual', chargedMonths: [], updated_at: T1 };
equal('cambiar la cuota exige config_cuota', [ok(F.settingsNeeds({ ...settingsNow, fee: 350, updated_at: T2 }, settingsNow), 'finanzas.config_cuota'), ok(F.settingsNeeds({ ...settingsNow, fee: 350, updated_at: T2 }, settingsNow), 'finanzas.config_general')], [true, false]);
equal('cambiar el desglose de la cuota exige config_cuota', [ok(F.settingsNeeds({ ...settingsNow, feeBreakdown: { maintenance: 400, water: 100 }, updated_at: T2 }, settingsNow), 'finanzas.config_cuota'), ok(F.settingsNeeds({ ...settingsNow, feeBreakdown: { maintenance: 400, water: 100 }, updated_at: T2 }, settingsNow), 'finanzas.config_general', 'finanzas.config_conceptos')], [true, false]);
equal('cambiar el modo de cobro tambien es de la cuota', ok(F.settingsNeeds({ ...settingsNow, feeMode: 'auto', updated_at: T2 }, settingsNow), 'finanzas.config_general'), false);
equal('cambiar moneda, idioma, nombre o tema exige config_general', [ok(F.settingsNeeds({ ...settingsNow, currency: 'USD', updated_at: T2 }, settingsNow), 'finanzas.config_general'), ok(F.settingsNeeds({ ...settingsNow, theme: 'dark', updated_at: T2 }, settingsNow), 'finanzas.config_cuota')], [true, false]);
equal('un concepto de ingresos lo puede agregar quien crea cargos', [ok(F.settingsNeeds({ ...settingsNow, customIncomeConcepts: ['Parqueo'] }, settingsNow), 'finanzas.cargos_crear'), ok(F.settingsNeeds({ ...settingsNow, customIncomeConcepts: ['Parqueo'] }, settingsNow), 'finanzas.config_conceptos'), ok(F.settingsNeeds({ ...settingsNow, customIncomeConcepts: ['Parqueo'] }, settingsNow), 'finanzas.egresos_registrar')], [true, true, false]);
equal('un concepto de egresos lo puede agregar quien registra egresos', [ok(F.settingsNeeds({ ...settingsNow, customExpenseConcepts: ['Jardin'] }, settingsNow), 'finanzas.egresos_registrar'), ok(F.settingsNeeds({ ...settingsNow, customExpenseConcepts: ['Jardin'] }, settingsNow), 'finanzas.cargos_crear')], [true, false]);
equal('el contador de recibos y los meses cobrados los mueve operar', F.settingsNeeds({ ...settingsNow, receiptCounter: 7, chargedMonths: ['2026-11'], updated_at: T2 }, settingsNow), []);
equal('una clave desconocida se trata como configuracion general', ok(F.settingsNeeds({ ...settingsNow, nueva: 1 }, settingsNow), 'finanzas.config_conceptos'), false);
equal('la primera configuracion de un condominio no pide nada', F.settingsNeeds(settingsNow, null), []);
equal('claves cambiadas: ignora undefined frente a null', F.changedKeys({ a: undefined, b: 1 }, { a: null, b: 1 }), []);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
