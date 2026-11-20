// Pruebas del reemplazo de saldos con una hoja de "saldos reales" (lib-saldos-reales.mjs): sin emuladores. Datos inventados.
// Uso: node test-saldos-reales.mjs
import { createRequire } from 'node:module';
import { readSaldosWorkbook, buildReplacement, simulate, waterFromSepOct, excelDay, sectorOf, cents } from './lib-saldos-reales.mjs';

const require = createRequire(import.meta.url);
const Mora = require('../finanzas/sisdel-mora.js');
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

// Un libro como lo entrega lib-xlsx: hojas con filas y celdas { v }
const row = (r, values) => ({ r, cells: Object.fromEntries(values.map((v, i) => [String(i), v === undefined || v === null ? undefined : { v: String(v) }]).filter(([, c]) => c)) });
const serial = (day) => Math.round((Date.UTC(...day.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) - Date.UTC(1899, 11, 30)) / 86400000);
// Mora de la hoja: 0.1 % diario desde el vencimiento hasta el corte (9/11/2026)
const CUT = '2026-11-09';
const daysTo = (day) => Math.round((Date.UTC(2026, 10, 9) - Date.UTC(...day.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))) / 86400000);
const det = (lot, concept, due, pend, exempt = false) => ({ lot, concept, due, pend, days: daysTo(due), mora: exempt ? 0 : Math.round(pend * daysTo(due) * 0.001 * 100) / 100 });
function book(lots, detail, opts = {}) {
    const sum = (k) => Math.round(lots.reduce((a, l) => a + (l[k] || 0) * 100, 0)) / 100;
    const lotRows = lots.map((l, i) => row(i + 2, [l.lot, l.name, l.type, l.pend, l.mora, Math.round((l.pend + l.mora) * 100) / 100, l.favor || 0, l.aclarar || 0, l.obs || '']));
    const total = opts.badTotal ? sum('pend') + 1 : sum('pend');
    return {
        sheets: [
            { name: 'Resumen', rows: [row(1, ['Saldos'])] },
            { name: 'Para subir al sistema', rows: [row(1, ['Lote', 'Propietario', 'Casa o lote', 'Cuotas pendientes al 9/11 (Q)', 'Mora al 9/11 (Q)', 'Total adeudado (Q)', 'Saldo a favor (Q)', 'Pagos por aclarar (Q)', 'Observación']), ...lotRows,
                row(lots.length + 2, ['Total', '', '', total, sum('mora'), Math.round((total + sum('mora')) * 100) / 100, sum('favor'), sum('aclarar')])] },
            { name: 'Detalle por cuota', rows: [row(1, ['Lote', 'Propietario', 'Concepto', 'Vencimiento', 'Pendiente al 9/11 (Q)', 'Días de atraso', 'Mora al 9/11 (Q)', 'Origen']),
                ...detail.map((d, i) => row(i + 2, [d.lot, '', d.concept, serial(d.due), d.pend, d.days, d.mora, 'Cartera']))] },
            { name: 'Cuadre por lote', rows: [row(1, ['Lote', 'Propietario', 'Mantenimiento al 31/08', 'Agua anterior', 'Cuotas sept. y oct. (Q)']), ...lots.map((l, i) => row(i + 2, [l.lot, '', 0, 0, l.sepOct]))] }
        ]
    };
}
const S = { fee: 300, feeBreakdown: { maintenance: 300 }, waterUnitPrice: 160, waterHalfPrice: 80, chargeDay: 1, moraRules: [{ from: '2000-01-01', percent: 3, graceDays: 5, payFirst: 'fee' }] };

console.log('\nLectura de la hoja');
equal('fechas de Excel y sector del lote', [excelDay(46295), excelDay(46326), sectorOf('BA039'), sectorOf('A001'), sectorOf('d12')], ['2026-09-30', '2026-10-31', 'BA', 'A', 'D']);
equal('agua por lo cobrado en septiembre y octubre', [600, 760, 920, 700].map((a) => waterFromSepOct(a, S)), [0, 0.5, 1, null]);
const detail = [
    det('A001', 'Mantenimiento', '2025-09-30', 200), det('A001', 'Mantenimiento', '2026-10-31', 300), det('A001', 'Agua', '2026-10-31', 80),
    det('B002', 'Mantenimiento', '2026-09-30', 300, true), det('B002', 'Agua', '2026-09-30', 80),
    det('BA003', 'Mantenimiento', '2026-08-31', 125.54), det('BA003', 'Mantenimiento', '2026-08-31', 300)
];
const lotSums = (lot) => { const rows = detail.filter((d) => d.lot === lot); return { pend: Math.round(rows.reduce((a, d) => a + d.pend * 100, 0)) / 100, mora: Math.round(rows.reduce((a, d) => a + d.mora * 100, 0)) / 100 }; };
const lots = [
    { lot: 'A001', name: 'Ana Prueba', type: 'Casa', ...lotSums('A001'), sepOct: 760, obs: 'Agua anterior tomada de la cartera manual' },
    { lot: 'B002', name: 'Beto Prueba', type: 'Casa', ...lotSums('B002'), sepOct: 760, obs: 'Mora exonerada en mantenimiento 09/2026' },
    { lot: 'BA003', name: 'Carla Prueba', type: 'Lote', ...lotSums('BA003'), sepOct: 600 },
    { lot: 'C004', name: 'Dora Prueba', type: 'Lote', pend: 0, mora: 0, favor: 600, sepOct: 600 },
    { lot: 'D005', name: 'Eli Prueba', type: 'Lote', pend: 0, mora: 0, aclarar: 80, sepOct: 600 }
];
const sheet = readSaldosWorkbook(book(lots, detail));
equal('sin problemas: lotes y filas del detalle', [sheet.problems, sheet.lots.size, sheet.detail.length], [[], 5, 7]);
equal('cada lote con su tipo, agua cobrada y observacion', ['A001', 'C004'].map((l) => [sheet.lots.get(l).type, sheet.lots.get(l).sepOct, sheet.lots.get(l).favor]), [['casa', 760, 0], ['lote', 600, 600]]);
equal('el concepto se lee como mantenimiento o agua', sheet.detail.map((d) => d.concept).slice(0, 3), ['maintenance', 'maintenance', 'water']);
yes('una fila de Total que no cuadra se rechaza', readSaldosWorkbook(book(lots, detail, { badTotal: true })).problems.some((p) => p.includes('fila de Total')));
yes('un detalle que no da lo del lote se rechaza', readSaldosWorkbook(book(lots, detail.slice(1))).problems.some((p) => p.includes('El detalle de A001')));
yes('un libro sin las hojas esperadas se rechaza', readSaldosWorkbook({ sheets: [{ name: 'Otra', rows: [] }] }).problems.length === 1);

console.log('\nEl reemplazo');
const iso = (d) => `${d}T18:00:00.000Z`;
const users = lots.map((l) => ({ id: `t-${l.lot}`, name: l.name, role: 'vecino', fase: l.lot === 'A001' ? 'fase 1' : '' }));
const fichas = [{ id: 't-A001', waterUnits: 0.5, feeFrom: '2026-11' }, { id: 't-B002', waterUnits: 0, feeFrom: '2027-01', notes: 'Nota vieja' }, { id: 't-BA003', waterUnits: 0, feeFrom: '2026-11' }, { id: 't-C004', waterUnits: 0, feeFrom: '2026-12' }, { id: 't-D005', waterUnits: 0, feeFrom: '2026-11' }];
const OLD = 'cartera vieja';
const movements = [
    // La carga anterior: cuotas, mora fija y una cuota de diciembre
    { id: 'fee_t-A001_2025-09', type: 'charge', kind: 'fee', period: '2025-09', amount: 200, resiId: 't-A001', date: iso('2025-09-30'), importedFrom: OLD },
    { id: 'mora_t-A001_2025-05', type: 'charge', kind: 'extra', moraFixed: true, amount: 50, resiId: 't-A001', date: iso('2025-05-31'), importedFrom: OLD },
    { id: 'fee_t-B002_2026-12', type: 'charge', kind: 'fee', period: '2026-12', amount: 300, resiId: 't-B002', date: iso('2026-12-31'), importedFrom: OLD },
    { id: 'fee_t-B002_2026-11', type: 'charge', kind: 'fee', period: '2026-11', amount: 300, resiId: 't-B002', date: iso('2026-11-30'), importedFrom: OLD },
    // La cuota de noviembre que ya cobro el sistema: A001 bien (380), BA003 con agua que ya no tiene (380 -> 300); C004 anulada
    { id: 'fee_t-A001_2026-11', type: 'charge', kind: 'fee', period: '2026-11', amount: 380, resiId: 't-A001', date: '2026-11-01T12:00:00.000Z', auto: true },
    { id: 'fee_t-BA003_2026-11', type: 'charge', kind: 'fee', period: '2026-11', amount: 380, resiId: 't-BA003', date: '2026-11-01T12:00:00.000Z', auto: true },
    { id: 'fee_t-C004_2026-11', type: 'charge', kind: 'fee', period: '2026-11', amount: 300, resiId: 't-C004', date: '2026-11-01T12:00:00.000Z', auto: true, deleted: true },
    { id: 'fee_t-D005_2026-11', type: 'charge', kind: 'fee', period: '2026-11', amount: 300, resiId: 't-D005', date: '2026-11-01T12:00:00.000Z', auto: true }
];
const SRC = 'saldos reales al 9/11/2026';
const base = { sheet, settings: S, prefix: 't-', cut: CUT, source: SRC, nowIso: '2026-11-20T20:00:00.000Z', currentPeriod: '2026-11' };
const plan = buildReplacement({ ...base, existing: { users, fichas, movements } });
equal('sin problemas', plan.problems, []);
const created = (id) => plan.creates.find((t) => t.id === id);
const a25 = created('sr_t-A001_2025-09');
equal('cada cuota pendiente entra en su mes con su mora al corte', [a25.amount, a25.period, a25.moraOpening, a25.moraOpeningAt, a25.importedFrom, a25.date], [200, '2025-09', Math.round(200 * daysTo('2025-09-30') * 0.001 * 100) / 100, CUT, SRC, iso('2025-09-30')]);
const aOct = created('sr_t-A001_2026-10');
equal('mantenimiento y agua del mismo mes van en una cuota con su desglose', [aOct.amount, aOct.breakdown, aOct.moraOpening], [380, { maintenance: 300, water: 80 }, 3.42]);
equal('una cuota con la mora exonerada va aparte y marcada; el agua del mismo mes lleva su mora', [created('sr_t-B002_2026-09_exo').moraExempt, created('sr_t-B002_2026-09_exo').amount, created('sr_t-B002_2026-09').amount, created('sr_t-B002_2026-09').moraExempt], [true, 300, 80, undefined]);
equal('dos filas del mismo mes y concepto se juntan', created('sr_t-BA003_2026-08').amount, 425.54);
const fav = created('sf_t-C004');
equal('el saldo a favor es un pago al corte que no es dinero de la caja', [fav.type, fav.amount, fav.openingCredit, fav.date], ['income', 600, true, iso(CUT)]);
equal('los pagos por aclarar no se cargan', plan.creates.filter((t) => t.resiId === 't-D005').length, 0);
equal('se anula todo lo de la carga anterior y la cuota de noviembre que no corresponde al agua', plan.annuls.map((a) => a.id).sort(), ['fee_t-A001_2025-09', 'fee_t-B002_2026-11', 'fee_t-B002_2026-12', 'fee_t-BA003_2026-11', 'mora_t-A001_2025-05']);
yes('la anulacion dice por que', plan.annuls.every((a) => a.reason.startsWith(`Reemplazado por la carga de ${SRC}`)));
const fees = plan.creates.filter((t) => t.id.startsWith('fee_')).map((t) => [t.id, t.amount]).sort();
equal('la cuota de este mes que falta se crea (tambien sobre una anulada) y la de diciembre anulada se repone', fees, [['fee_t-B002_2026-11_r1', 380], ['fee_t-B002_2026-12_r1', 380], ['fee_t-BA003_2026-11_r1', 300], ['fee_t-C004_2026-11_r1', 300]]);
equal('la cuota de noviembre que ya estaba bien se queda', plan.annuls.some((a) => a.id === 'fee_t-A001_2026-11') || plan.creates.some((t) => t.resiId === 't-A001' && t.period === '2026-11'), false);
yes('lo nuevo lleva serverGenerated, salvo el ultimo de un lote que no anula nada (dispara su recalculo)', plan.creates.filter((t) => !t.serverGenerated).map((t) => t.resiId).sort().join() === 't-C004');
const ficha = (id) => (plan.fichas.find((f) => f.id === id) || { data: {} }).data;
equal('fichas: cobra desde este mes, tipo de la hoja, agua de lo cobrado', [ficha('t-B002').feeFrom, ficha('t-B002').unitType, ficha('t-B002').waterUnits, ficha('t-BA003').unitType, ficha('t-A001').waterUnits], ['2026-11', 'casa', 0.5, 'lote', undefined]);
equal('la observacion va a las notas sin borrar lo que habia', ficha('t-B002').notes, `Nota vieja\nHoja de ${SRC}: Mora exonerada en mantenimiento 09/2026`);
equal('fase = las letras del lote (se corrige la escrita a mano)', plan.users.map((u) => [u.id, u.data.fase]), [['t-A001', 'A'], ['t-B002', 'B'], ['t-BA003', 'BA'], ['t-C004', 'C'], ['t-D005', 'D']]);
equal('los totales del plan dan los de la hoja', [cents(plan.stats.cuotasAmount) / 100 === 0 ? 0 : plan.stats.cuotasAmount / 100, plan.stats.mora / 100, plan.stats.creditAmount / 100], [sheet.totals.pend, sheet.totals.mora, 600]);
yes('sin vecino en el sistema no se carga (esta carga no crea vecinos)', buildReplacement({ ...base, existing: { users: users.slice(1), fichas, movements } }).problems.some((p) => p.includes('A001')));

console.log('\nCuadre y como queda');
const sim = simulate(plan, movements, S, { cut: CUT, asOf: '2026-11-20', sheet, prefix: 't-', fichaOf: (id) => ({ ...fichas.find((f) => f.id === id), ...ficha(id) }) });
equal('al corte cada lote da EXACTO lo de la hoja (cuotas y mora)', [sim.mismatches, sim.rows.map((r) => r.same)], [0, [true, true, true, true, true]]);
const r = (lot) => sim.rows.find((x) => x.lot === lot);
equal('hoy: el saldo a favor pago noviembre y queda la mitad a favor', [r('C004').capital, r('C004').credit], [0, 300]);
equal('la mora exonerada no crece; la del agua si al 6 de diciembre', (() => { const txs = plan.creates.filter((t) => t.resiId === 't-B002' && t.period === '2026-09'); return [Mora.stateOf('t-B002', txs, S, '2026-11-20').mora, Mora.stateOf('t-B002', txs, S, '2026-12-06').mora]; })(), [created('sr_t-B002_2026-09').moraOpening, Math.round((created('sr_t-B002_2026-09').moraOpening + 2.4) * 100) / 100]);
equal('quien debe mas de una cuota vencida es moroso para la garita', sim.rows.filter((x) => x.moroso).map((x) => x.lot), ['A001', 'BA003']);

console.log('\nVolver a correrlo');
const done = movements.map((m) => (plan.annuls.some((a) => a.id === m.id) ? { ...m, deleted: true } : m)).concat(plan.creates);
const fichasAfter = fichas.map((f) => ({ ...f, ...ficha(f.id) }));
const usersAfter = users.map((u) => ({ ...u, ...((plan.users.find((x) => x.id === u.id) || {}).data || {}) }));
const again = buildReplacement({ ...base, existing: { users: usersAfter, fichas: fichasAfter, movements: done } });
equal('con todo ya hecho no queda nada por hacer', [again.creates.length, again.annuls.length, again.fichas.length, again.users.length], [0, 0, 0, 0]);
const half = movements.concat(plan.creates.slice(0, 3));
equal('una carga cortada retoma sin repetir lo que ya se escribio', buildReplacement({ ...base, existing: { users, fichas, movements: half } }).creates.length, plan.creates.length - 3);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
