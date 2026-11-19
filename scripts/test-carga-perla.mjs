// Pruebas del plan de carga de La Perla (scripts/lib-carga-perla.mjs) con datos INVENTADOS: sin emuladores.
//   node scripts/test-carga-perla.mjs
import { createRequire } from 'node:module';
import {
    lotKey, lotLabel, parsePhones, parseEmails, normalizeNit, ownerGroupOf, parseOwners, parseDate, parseCartera,
    waterUnitsOf, buildPlan, carteraTotals, accessCodeFor
} from './lib-carga-perla.mjs';

const require = createRequire(import.meta.url);
const SisdelMora = require('../finanzas/sisdel-mora.js');

const failures = [];
let passed = 0;
function equal(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; return; }
    failures.push(name);
    console.log(`  FALLA  ${name}\n         esperado ${e}\n         obtuvo   ${a}`);
}
const yes = (name, value) => equal(name, !!value, true);

// Libro como lo devuelve lib-xlsx: filas con celdas por columna (texto)
const row = (r, values) => ({ r, hidden: false, cells: Object.fromEntries(Object.entries(values).map(([c, v]) => [c, { v: String(v), t: 's', s: null, f: null }])) });
const book = (rows) => ({ sheets: [{ name: 'Hoja', state: 'visible', rows, merges: [] }] });

console.log('\nLotes');
equal('clave del lote', [lotKey('A001'), lotKey('ba-12'), lotKey(' D 124 '), lotKey('Casa 5')], ['A1', 'BA12', 'D124', null]);
equal('etiqueta como la escribe la asociacion', [lotLabel('A1'), lotLabel('BA12'), lotLabel('D124')], ['A001', 'BA012', 'D124']);

console.log('\nTelefonos');
equal('8 cifras de Guatemala', parsePhones('5555-1234'), { phone: '+50255551234', others: [], odd: false });
equal('con 502 adelante', parsePhones('(502) 5555 1234').phone, '+50255551234');
equal('Estados Unidos con 001', parsePhones('001 305 555 1234').phone, '+13055551234');
equal('Estados Unidos con 10 cifras', parsePhones('305-555-1234').phone, '+13055551234');
equal('dos numeros separados por /', parsePhones('5555-1234 / 4444-5678'), { phone: '+50255551234', others: ['+50244445678'], odd: false });
equal('Guatemala y Estados Unidos solo con espacios', parsePhones('5555-1234 001 305 555-1234'), { phone: '+50255551234', others: ['+13055551234'], odd: false });
equal('dos de Guatemala seguidos', parsePhones('5555-1234 - 4444-5678').others, ['+50244445678']);
equal('con y', parsePhones('5555 1234 y 4444 5678').others, ['+50244445678']);
equal('vacio o un guion', [parsePhones('').phone, parsePhones('-').phone], ['', '']);
equal('le falta una cifra: queda como vino y se avisa', parsePhones('5555123'), { phone: '5555123', others: [], odd: true });

console.log('\nCorreos y NIT');
equal('correo valido en minusculas', parseEmails(' Ana.Prueba@Ejemplo.TEST '), { email: 'ana.prueba@ejemplo.test', others: [], bad: [] });
equal('varios correos', parseEmails('a@ejemplo.test; b@ejemplo.test').others, ['b@ejemplo.test']);
equal('correo mal escrito', parseEmails('ana@ejemplo').bad, ['ana@ejemplo']);
equal('C/F en sus formas', ['C/F', 'cf', 'C.F.', ' c / f '].map(normalizeNit), ['C/F', 'C/F', 'C/F', 'C/F']);
equal('grupo del mismo dueno por NIT', [ownerGroupOf('1234567-8'), ownerGroupOf('123456-K'), ownerGroupOf('C/F'), ownerGroupOf('')], ['nit:12345678', 'nit:123456K', '', '']);

console.log('\nLista de propietarios');
const ownersBook = book([
    row(1, { 1: 'BASE DE DATOS' }),
    row(4, { 0: 'No.', 1: '# LOTE', 2: 'NIT', 3: 'PROPIETARIO', 4: 'DIRECCION', 5: 'TELEFONO', 6: 'CORREO' }),
    row(5, { 0: '1', 1: 'A001', 2: '1234567-8', 3: 'ANA PRUEBA INVENTADA.-', 4: ' Calle  Inventada 1 ', 5: '5555-1234 / 4444-5678', 6: 'ana@ejemplo.test' }),
    row(6, { 0: '2', 1: 'A002', 2: '1234567-8', 3: 'ANA PRUEBA INVENTADA', 4: 'Calle Inventada 1', 5: '', 6: 'ana@ejemplo' }),
    row(7, { 0: '3', 1: 'A003', 2: 'C/F', 3: 'POZO MECANICO', 4: '', 5: '', 6: '' }),
    row(8, { 0: '4', 1: 'D124', 2: 'C/F', 3: 'LUIS INVENTADO', 4: '', 5: '001 305 555 1234', 6: '' }),
    row(9, { 0: '5', 1: 'D124', 2: 'C/F', 3: 'LUIS INVENTADO', 4: '', 5: '', 6: '' }),
    row(10, { 0: '6', 1: 'B007', 2: '9876543-2', 3: 'PEDRO INVENTADO', 4: '', 5: '5555-0000', 6: '' })
]);
const owners = parseOwners(ownersBook);
equal('lee los lotes desde la fila 5', owners.owners.map((o) => o.key), ['A1', 'A2', 'A3', 'D124', 'D125', 'B7']);
equal('la segunda D124 es D125', owners.owners.find((o) => o.key === 'D125').row, 9);

console.log('\nCartera');
equal('fecha esperada', [parseDate('30/09/26'), parseDate('31/12/2025'), parseDate('31/02/26'), parseDate('x')], ['2026-09-30', '2025-12-31', null, null]);
const carteraBook = book([
    row(1, { 1: 'ADMINISTRADORA INVENTADA' }),
    row(10, { 1: 'A001-M26', 2: 'ANA PRUEBA INVENTADA', 3: '2400', 6: '1200' }),
    row(11, { 2: '9', 3: '30/09/26', 4: '300', 5: '0', 6: '17.4', 7: '317.4' }),
    row(12, { 2: '10', 3: '31/10/26', 4: '300', 5: '0', 6: '0', 7: '300' }),
    row(13, { 1: 'Cuotas Vencidas', 2: 'x' }),
    row(14, { 2: '8', 3: '31/08/26', 4: '0', 5: '0', 6: '25.5', 7: '25.5' }),
    row(15, { 2: '7', 3: '31/07/26', 4: '150', 5: '100', 6: '30', 7: '280' }),
    row(20, { 1: 'A001-A26', 2: 'ANA PRUEBA INVENTADA', 3: '800', 6: '160' }),
    row(21, { 2: '9', 3: '30/09/26', 4: '80', 5: '0', 6: '4.64', 7: '84.64' }),
    row(22, { 2: '11', 3: '30/11/26', 4: '0', 5: '0', 6: '0', 7: '0' }),
    row(30, { 1: 'B007-A26', 2: 'OTRO NOMBRE DISTINTO', 3: '960', 6: '960' }),
    row(31, { 2: '12', 3: '31/12/26', 4: '80', 5: '0', 6: '0', 7: '80' }),
    row(40, { 1: 'F099-M26', 2: 'SIN LOTE EN LA LISTA', 3: '0', 6: '300' }),
    row(41, { 2: '10', 3: '31/10/26', 4: '300', 5: '0', 6: '5', 7: '305' })
]);
const accounts = parseCartera(carteraBook);
equal('cuentas con su tipo y ano', accounts.map((a) => [a.key, a.type, a.year, a.quotas.length]), [['A1', 'M', 2026, 4], ['A1', 'A', 2026, 2], ['B7', 'A', 2026, 1], ['F99', 'M', 2026, 1]]);
equal('una fila con texto (subtotal) no cierra la cuenta', accounts[0].quotas.map((q) => q.period), ['2026-09', '2026-10', '2026-08', '2026-07']);
equal('totales de la cartera', carteraTotals(accounts), { quotas: 8, capital: 1210, interest: 100, mora: 82.54, moraOnDebt: 57.04, moraOnPaid: 25.5 });

console.log('\nAgua del lote');
equal('Q80 al mes es media paja', waterUnitsOf('A1', accounts), { units: 0.5, source: 'Q80 al mes' });
equal('sector B (fase 2) es una paja aunque la cartera diga Q80', waterUnitsOf('B7', accounts).units, 1);
equal('sin cuenta de agua no paga agua', waterUnitsOf('A2', accounts), { units: 0, source: 'sin cuenta de agua' });
const unseen = parseCartera(book([row(1, { 1: 'C005-A26', 2: 'X', 3: '0', 6: '0' }), row(2, { 2: '1', 3: '31/01/26', 4: '0', 5: '0', 6: '0', 7: '0' })]));
equal('cuenta de agua al dia sin monto: media paja por omision y se avisa', [waterUnitsOf('C5', unseen).units, waterUnitsOf('C5', unseen).unsure], [0.5, true]);

console.log('\nPlan');
const plan = buildPlan(owners.owners, accounts, { condoId: 'condo-x', nowIso: '2026-11-15T15:00:00.000Z', currentPeriod: '2026-11' });
equal('el pozo no recibe cuenta ni codigo', [plan.lots.map((l) => l.label), plan.skipped.map((s) => s.lot)], [['A001', 'A002', 'D124', 'D125', 'B007'], ['A003']]);
const ana = plan.lots.find((l) => l.label === 'A001');
equal('vecino de SISDEL', ana.user, {
    id: 'perla-A001', condominioId: 'condo-x', name: 'ANA PRUEBA INVENTADA', role: 'vecino', casa: 'A001', phone: '+50255551234', email: 'ana@ejemplo.test',
    paymentStatus: 'al_dia', morosoSince: null, active: true, createdAt: '2026-11-15T15:00:00.000Z', updatedAt: '2026-11-15T15:00:00.000Z', importedFrom: 'cartera La Perla al 15/11/2026'
});
equal('ficha del Sistema Financiero', ana.ficha, {
    id: 'perla-A001', feeFrom: '2026-12', createdAt: '2026-11-15T15:00:00.000Z', updated_at: '2026-11-15T15:00:00.000Z', waterUnits: 0.5,
    nit: '1234567-8', ownerGroup: 'nit:12345678', direccion: 'Calle Inventada 1', notes: 'Otros teléfonos: +50244445678'
});
equal('el mismo NIT une los lotes A001 y A002', plan.lots.filter((l) => l.ficha.ownerGroup === 'nit:12345678').map((l) => l.label), ['A001', 'A002']);
equal('el correo mal escrito va a las observaciones', plan.lots.find((l) => l.label === 'A002').ficha.notes, 'Correo como venía en la lista (revisar): ana@ejemplo');
equal('un C/F no agrupa', 'ownerGroup' in plan.lots.find((l) => l.label === 'D124').ficha, false);
const anaCharges = plan.charges.filter((c) => c.resiId === 'perla-A001');
equal('cargos de A001', anaCharges.map((c) => [c.id, c.kind, c.amount]), [
    ['fee_perla-A001_2026-07', 'fee', 150], ['interes_perla-A001_2026-07', 'extra', 100], ['mora_perla-A001_2026-08', 'extra', 25.5], ['fee_perla-A001_2026-09', 'fee', 380], ['fee_perla-A001_2026-10', 'fee', 300]
]);
const sept = anaCharges.find((c) => c.id === 'fee_perla-A001_2026-09');
equal('mantenimiento y agua del mismo mes en una cuota', [sept.breakdown, sept.concept, sept.period, sept.date], [{ maintenance: 300, water: 80 }, 'Por aporte para mantenimiento y servicio de agua correspondiente a septiembre de 2026 Q 380.00', '2026-09', '2026-09-30T18:00:00.000Z']);
equal('marcas de la carga', [sept.serverGenerated, sept.manual, sept.auto, sept.retro, sept.importedFrom], [true, true, false, true, 'cartera La Perla al 15/11/2026']);
equal('la mora de una cuota ya pagada queda fija', (({ moraFixed, moraPeriod, concept }) => ({ moraFixed, moraPeriod, concept }))(anaCharges.find((c) => c.moraFixed)), { moraFixed: true, moraPeriod: '2026-08', concept: 'Mora pendiente de la cuota de agosto de 2026 (cartera La Perla al 15/11/2026)' });
equal('un pago a medias carga lo que falta', anaCharges.find((c) => c.id === 'fee_perla-A001_2026-07').concept, 'Por aporte para mantenimiento correspondiente a julio de 2026 Q 150.00');
equal('se cobra desde el mes siguiente al ultimo de la cartera', [ana.ficha.feeFrom, plan.lots.find((l) => l.label === 'B007').ficha.feeFrom, plan.lots.find((l) => l.label === 'A002').ficha.feeFrom], ['2026-12', '2027-01', '2026-11']);
equal('la cuenta sin lote en la lista se avisa', plan.orphanAccounts.map((a) => a.code), ['F099-M26']);
equal('otro nombre en la cartera se avisa', plan.lots.find((l) => l.label === 'B007').check.differentOwner, ['OTRO NOMBRE DISTINTO']);
const loaded = plan.charges.filter((c) => c.kind === 'fee').reduce((s, c) => s + c.amount, 0);
equal('cuadre: capital cargado + sin lote = capital de la cartera', loaded + carteraTotals(plan.orphanAccounts).capital, carteraTotals(accounts).capital);
equal('cuadre: mora fija = mora de cuotas pagadas', plan.charges.filter((c) => c.moraFixed).reduce((s, c) => s + c.amount, 0), 25.5);

console.log('\nMora que calculara el sistema');
const settings = { fee: 300, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] };
const state = SisdelMora.stateOf('perla-A001', anaCharges, settings, '2026-11-15');
// Un cargo de 3 % el dia 6 de cada mes despues de vencer: julio Q150 (6 de agosto, septiembre, octubre y noviembre) -> 4 x 4.50 = 18.00;
// septiembre Q380 (6 de octubre y de noviembre) -> 2 x 11.40 = 22.80; octubre Q300 (6 de noviembre) -> 9.00
equal('mora al 15/11/2026 de las cuotas cargadas (un cargo el dia 6 de cada mes)', state.items.filter((i) => i.kind === 'fee').map((i) => [i.period, i.mora]), [['2026-07', 18], ['2026-09', 22.8], ['2026-10', 9]]);
equal('la mora fija no crece', state.items.find((i) => i.kind === 'mora').mora, 25.5);

console.log('\nCodigos de acceso');
const taken = new Set(['RA000']);
let seq = 0;
const fixed = () => [0, 0, 0.123, 0.5][seq++ % 4];
equal('formato SISDEL y sin repetir los que ya existen', [accessCodeFor('RESIDENCIALES LA PERLA', 'Ana', taken, fixed), accessCodeFor('RESIDENCIALES LA PERLA', 'Ana', taken, fixed)], ['RA123', 'RA500']);
yes('los codigos usados quedan apartados', taken.has('RA123') && taken.has('RA500'));
equal('nombre con acento', accessCodeFor('RESIDENCIALES LA PERLA', 'Ángel', new Set(), () => 0.042), 'RA042');

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) console.log(`Fallas:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length ? 1 : 0);
