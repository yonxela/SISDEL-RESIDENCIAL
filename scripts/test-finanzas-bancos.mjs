// Pruebas de los calculos de Bancos del Sistema Financiero (finanzas/sisdel-bancos.js): que pago o gasto le toca a cada
// cuenta, la cuenta favorita en el tiempo, el libro con su saldo y los saldos de hoy. Sin emuladores ni navegador.
// Uso: node test-finanzas-bancos.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const B = require('../finanzas/sisdel-bancos.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const acc = (id, openedAt, openingBalance, extra) => ({ id, bankName: 'Banco ' + id, accountNumber: '00' + id, accountType: 'monetaria', currency: 'GTQ', openingBalance, openedAt, active: true, ...(extra || {}) });
const pay = (id, created, amount, extra) => ({ id, type: 'income', amount, date: created, created_at: created, concept: 'Pago', ...(extra || {}) });
const exp = (id, created, amount, extra) => ({ id, type: 'expense', amount, date: created, created_at: created, concept: 'Gasto', ...(extra || {}) });

console.log('\nCuenta favorita');
const A = acc('A', '2026-11-10T15:00:00.000Z', 1000);
const C = acc('C', '2026-11-12T15:00:00.000Z', 500);
equal('sin cuentas no hay favorita', B.favoriteAt([], [], '2026-11-15T00:00:00.000Z'), null);
equal('sin historial, la favorita es la primera cuenta que se abrio (desde que se abrio)', [B.favoriteAt([C, A], [], '2026-11-11T00:00:00.000Z'), B.favoriteAt([C, A], [], '2026-11-09T00:00:00.000Z'), B.currentFavorite([C, A], [])], ['A', null, 'A']);
const history = [{ accountId: 'A', from: A.openedAt }, { accountId: 'C', from: '2026-11-14T12:00:00.000Z' }];
equal('con historial, cada momento tiene su favorita', [B.favoriteAt([A, C], history, '2026-11-13T00:00:00.000Z'), B.favoriteAt([A, C], history, '2026-11-14T12:00:00.000Z'), B.currentFavorite([A, C], history)], ['A', 'C', 'C']);

console.log('\nPagos y gastos automaticos');
const txs = [
    pay('p0', '2026-11-09T15:00:00.000Z', 999),                       // antes de abrir la cuenta: no entra
    pay('p1', '2026-11-10T16:00:00.000Z', 300),                       // despues de abrir: entra a A
    exp('g1', '2026-11-11T16:00:00.000Z', 120),
    pay('p2', '2026-11-12T10:00:00.000Z', 450, { deleted: true }),    // anulado: no cuenta
    { id: 'c1', type: 'charge', amount: 300, created_at: '2026-11-12T10:00:00.000Z', date: '2026-11-01' }, // una cuota no es dinero
    pay('p3', '2026-11-15T09:00:00.000Z', 200)                        // despues del cambio de favorita: entra a C
];
const auto = B.automaticByAccount([A, C], history, txs);
equal('solo lo registrado despues de abrir; sin anulados ni cuotas', [(auto.get('A') || []).map((t) => t.id), (auto.get('C') || []).map((t) => t.id)], [['p1', 'g1'], ['p3']]);
equal('un pago registrado hoy con fecha de antes de abrir la cuenta tambien entra (cuenta la fecha de registro)', B.automaticByAccount([A], [], [pay('px', '2026-11-11T10:00:00.000Z', 50, { date: '2026-11-01T10:00:00.000Z' })]).get('A').map((t) => t.id), ['px']);

console.log('\nLibro de una cuenta');
const manual = [
    { id: 'm1', accountId: 'A', type: 'comision', direction: 'out', amount: 15, concept: 'Comision', date: '2026-11-11T20:00:00.000Z', created_at: '2026-11-11T20:00:00.000Z' },
    { id: 'm2', accountId: 'A', type: 'deposito', direction: 'in', amount: 80, concept: 'Deposito efectivo', reference: 'B-123', date: '2026-11-12T20:00:00.000Z', created_at: '2026-11-12T20:00:00.000Z' },
    { id: 'm3', accountId: 'A', type: 'retiro', direction: 'out', amount: 1000, concept: 'Error', date: '2026-11-12T21:00:00.000Z', created_at: '2026-11-12T21:00:00.000Z', deleted: true },
    { id: 't-out', accountId: 'A', type: 'transferencia_salida', direction: 'out', amount: 100, concept: 'A C', transferId: 't1', date: '2026-11-13T10:00:00.000Z', created_at: '2026-11-13T10:00:00.000Z' },
    { id: 't-in', accountId: 'C', type: 'transferencia_entrada', direction: 'in', amount: 100, concept: 'Desde A', transferId: 't1', date: '2026-11-13T10:00:00.000Z', created_at: '2026-11-13T10:00:00.000Z' }
];
const day = (v) => String(v).slice(0, 10);
const la = B.ledger(A, { accounts: [A, C], favorites: history, txs, manual }, { dayKey: day, residentName: () => 'Lote 1' });
equal('cada fila con su ingreso, egreso y saldo despues (apertura Q1,000)', la.rows.map((r) => [r.id, r.in, r.out, r.balance]), [['p1', 300, 0, 1300], ['g1', 0, 120, 1180], ['m1', 0, 15, 1165], ['m2', 80, 0, 1245], ['t-out', 0, 100, 1145]]);
equal('los pagos dicen de quien son; los movimientos a mano, su tipo y referencia', [la.rows[0].concept, la.rows[0].typeLabel, la.rows[3].typeLabel, la.rows[3].reference], ['Pago · Lote 1', 'Pago registrado', 'Depósito', 'B-123']);
equal('totales y saldo (lo anulado no cuenta)', [la.totalIn, la.totalOut, la.balance], [380, 235, 1145]);
const lc = B.ledger(C, { accounts: [A, C], favorites: history, txs, manual }, { dayKey: day });
equal('la otra cuenta: su apertura, la transferencia y lo que entro despues de ser favorita', [lc.rows.map((r) => r.id), lc.balance], [['t-in', 'p3'], 800]);
const ranged = B.ledger(A, { accounts: [A, C], favorites: history, txs, manual }, { dayKey: day, from: '2026-11-12', to: '2026-11-12' });
equal('con rango: saldo anterior, solo las filas del rango y su saldo al cierre', [ranged.previous, ranged.rows.map((r) => r.id), ranged.closing], [1165, ['m2'], 1245]);
equal('los centavos se suman sin errores de redondeo', B.ledger(acc('Z', '2026-01-01T00:00:00.000Z', 0.1), { accounts: [acc('Z', '2026-01-01T00:00:00.000Z', 0.1)], favorites: [], txs: [pay('a', '2026-02-01T00:00:00.000Z', 0.2)], manual: [] }).balance, 0.3);

console.log('\nSaldos de hoy');
const bal = B.balances([A, C], history, txs, manual);
equal('el saldo de cada cuenta se calcula (nunca se guarda)', [bal.get('A'), bal.get('C')], [1145, 800]);

console.log('\nTipos');
equal('el sentido de cada movimiento a mano', ['deposito', 'retiro', 'comision', 'intereses', 'cheque_emitido', 'transferencia_entrada'].map(B.directionOf), ['in', 'out', 'out', 'in', 'out', 'in']);
equal('el nombre de un tipo de cuenta (y el personalizado)', [B.accountTypeLabel('monetaria'), B.accountTypeLabel('otro', 'Fideicomiso')], ['Monetaria', 'Fideicomiso']);

console.log('\nServidor y navegador');
const server = require('../functions/src/bancos.js');
equal('el servidor decide la favorita igual que la pantalla', [server.currentFavorite([C, A], []), server.currentFavorite([A, C], history)], [B.currentFavorite([C, A], []), B.currentFavorite([A, C], history)]);
const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-bancos.js'), sandbox);
equal('en el navegador queda como SisdelBancos y calcula lo mismo', JSON.stringify([...sandbox.self.SisdelBancos.balances([A, C], history, txs, manual)]), JSON.stringify([...bal]));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
