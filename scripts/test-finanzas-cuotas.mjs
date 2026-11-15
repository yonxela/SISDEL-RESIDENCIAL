// Pruebas del desglose de la cuota mensual (finanzas/sisdel-cuotas.js y su integracion en OIKOS y en el servidor): sin emuladores.
// Uso: node test-finanzas-cuotas.mjs (tambien corre con npm test).
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const C = require('../finanzas/sisdel-cuotas.js');
const M = require('../functions/src/finanzas/mora.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

console.log('\nDescripcion de la cuota');
equal('el ejemplo del administrador: mantenimiento 400 y agua 100', C.describe({ maintenance: 400, water: 100 }, 'GTQ'), 'Por aporte para mantenimiento y servicio de agua Q 500.00');
equal('un solo concepto', C.describe({ maintenance: 500 }, 'GTQ'), 'Por aporte para mantenimiento Q 500.00');
equal('tres conceptos: comas y "y" al final', C.describe({ maintenance: 300, water: 100, garbage: 50 }, 'GTQ'), 'Por aporte para mantenimiento, servicio de agua y recolección de basura Q 450.00');
equal('los cinco conceptos', C.describe({ maintenance: 1, water: 2, garbage: 3, electricity: 4, other: 5 }, 'GTQ'), 'Por aporte para mantenimiento, servicio de agua, recolección de basura, servicio de electricidad y otros conceptos Q 15.00');
equal('solo se nombran los que tienen monto', C.describe({ maintenance: 0, water: '', garbage: 75.5, electricity: null, other: undefined }, 'GTQ'), 'Por aporte para recolección de basura Q 75.50');
equal('el orden es siempre el mismo, sin importar como llegan', C.describe({ other: 10, electricity: 20, maintenance: 30 }, 'GTQ'), 'Por aporte para mantenimiento, servicio de electricidad y otros conceptos Q 60.00');
equal('sin montos no hay descripcion', [C.describe({}, 'GTQ'), C.describe(null, 'GTQ'), C.describe({ maintenance: 0 }, 'GTQ')], [null, null, null]);
equal('montos invalidos o negativos cuentan como cero', C.describe({ maintenance: 'abc', water: -50, garbage: 100 }, 'GTQ'), 'Por aporte para recolección de basura Q 100.00');
equal('montos como texto (asi salen de los campos)', C.describe({ maintenance: '400', water: '100.50' }, 'GTQ'), 'Por aporte para mantenimiento y servicio de agua Q 500.50');
equal('miles con coma', C.describe({ maintenance: 1250 }, 'GTQ'), 'Por aporte para mantenimiento Q 1,250.00');
equal('el simbolo sigue a la moneda', [C.describe({ water: 5 }, 'USD'), C.describe({ water: 5 }, 'EUR'), C.describe({ water: 5 }, 'MXN'), C.describe({ water: 5 }, 'PEN'), C.describe({ water: 5 }, undefined)], ['Por aporte para servicio de agua $ 5.00', 'Por aporte para servicio de agua € 5.00', 'Por aporte para servicio de agua $ 5.00', 'Por aporte para servicio de agua PEN 5.00', 'Por aporte para servicio de agua Q 5.00']);
equal('centavos sin errores de redondeo', C.total({ maintenance: 0.1, water: 0.2 }), 0.3);
equal('lista de listas', [C.joinList([]), C.joinList(['a']), C.joinList(['a', 'b']), C.joinList(['a', 'b', 'c'])], ['', 'a', 'a y b', 'a, b y c']);

console.log('\nMes de la cuota');
equal('el periodo se nombra en palabras', [C.monthLabel('2026-10'), C.monthLabel('2026-01'), C.monthLabel('2027-12')], ['octubre de 2026', 'enero de 2026', 'diciembre de 2027']);
equal('un periodo invalido no se nombra', [C.monthLabel('2026-13'), C.monthLabel('2026-00'), C.monthLabel('2026-1'), C.monthLabel(''), C.monthLabel(null), C.monthLabel('octubre')], [null, null, null, null, null, null]);
equal('con periodo, la descripcion dice a que mes corresponde', C.describe({ maintenance: 300, water: 100, garbage: 25 }, 'GTQ', '2026-10'), 'Por aporte para mantenimiento, servicio de agua y recolección de basura correspondiente a octubre de 2026 Q 425.00');
equal('un solo concepto con su mes', C.describe({ maintenance: 500 }, 'GTQ', '2026-11'), 'Por aporte para mantenimiento correspondiente a noviembre de 2026 Q 500.00');
equal('sin periodo valido, la descripcion queda como antes (sin mes)', [C.describe({ maintenance: 500 }, 'GTQ'), C.describe({ maintenance: 500 }, 'GTQ', 'xx')], ['Por aporte para mantenimiento Q 500.00', 'Por aporte para mantenimiento Q 500.00']);
equal('sin montos no hay descripcion aunque haya periodo', C.describe({}, 'GTQ', '2026-10'), null);

console.log('\nDesglose y total');
equal('normalize deja siempre las cinco claves', C.normalize({ water: '100', basura: 5 }), { maintenance: 0, water: 100, garbage: 0, electricity: 0, other: 0 });
equal('la suma es la cuota', C.total({ maintenance: 400, water: 100, garbage: 25.25 }), 525.25);
equal('hay cinco conceptos con su nombre en pantalla', C.PARTS.map((p) => p.label), ['Mantenimiento', 'Agua', 'Recolección de basura', 'Electricidad', 'Otros']);
equal('detalle de un movimiento', C.listParts({ maintenance: 400, water: 100 }, 'GTQ'), 'Mantenimiento Q 400.00 · Agua Q 100.00');

console.log('\nConcepto de un cobro (feeInfo)');
const settings = { fee: 500, currency: 'GTQ', feeBreakdown: { maintenance: 400, water: 100, garbage: 0, electricity: 0, other: 0 } };
equal('con desglose: una sola linea y el desglose solo de lo que tiene monto', C.feeInfo(settings, 500), { concept: 'Por aporte para mantenimiento y servicio de agua Q 500.00', breakdown: { maintenance: 400, water: 100 } });
equal('el monto llega como texto (la cuota se guarda como texto en la configuracion)', C.feeInfo({ ...settings, fee: '500' }, '500').concept, 'Por aporte para mantenimiento y servicio de agua Q 500.00');
equal('si el cobro es de otro monto, conserva su concepto de siempre', C.feeInfo(settings, 350), null);
equal('sin desglose configurado no cambia nada', [C.feeInfo({ fee: 500 }, 500), C.feeInfo({ fee: 500, feeBreakdown: {} }, 500), C.feeInfo(null, 500)], [null, null, null]);
equal('un desglose con montos en cero no cuenta', C.feeInfo({ fee: 0, feeBreakdown: { maintenance: 0 } }, 0), null);
equal('la moneda de la configuracion decide el simbolo', C.feeInfo({ currency: 'USD', feeBreakdown: { water: 30 } }, 30).concept, 'Por aporte para servicio de agua $ 30.00');
equal('el cobro de un periodo lleva su mes y el mismo desglose', C.feeInfo(settings, 500, '2026-10'), { concept: 'Por aporte para mantenimiento y servicio de agua correspondiente a octubre de 2026 Q 500.00', breakdown: { maintenance: 400, water: 100 } });
equal('el mes es el del periodo, no el de hoy (una cuota atrasada o adelantada dice su mes)', [C.feeInfo(settings, 500, '2026-01').concept, C.feeInfo(settings, 500, '2026-12').concept], ['Por aporte para mantenimiento y servicio de agua correspondiente a enero de 2026 Q 500.00', 'Por aporte para mantenimiento y servicio de agua correspondiente a diciembre de 2026 Q 500.00']);
equal('con un monto distinto a la suma, el periodo no cambia nada: "Cuota - Mes Año"', C.feeInfo(settings, 350, '2026-10'), null);

console.log('\nServidor: cuotas del dia');
const residents = [{ id: 'r1', status: 'active', createdAt: '2020-01-01T00:00:00Z' }];
const now = M.gtDate(2026, 10, 7, 12);
const withBreakdown = M.missingFees(residents, [], { ...settings, chargeDay: 5, feeMode: 'auto' }, now);
const lastWith = withBreakdown[withBreakdown.length - 1];
equal('la cuota automatica del servidor lleva la misma descripcion que cobra OIKOS, con su mes', [lastWith.concept, lastWith.breakdown, lastWith.amount, lastWith.period], ['Por aporte para mantenimiento y servicio de agua correspondiente a noviembre de 2026 Q 500.00', { maintenance: 400, water: 100 }, 500, '2026-11']);
equal('cada cuota del ano del servidor dice su propio mes', withBreakdown.every((t) => t.concept === C.feeInfo(settings, 500, t.period).concept && t.amount === 500), true);
equal('la primera cuota del ano es la de enero', [withBreakdown[0].period, withBreakdown[0].concept], ['2026-01', 'Por aporte para mantenimiento y servicio de agua correspondiente a enero de 2026 Q 500.00']);
const legacy = M.missingFees(residents, [], { fee: 500, chargeDay: 5, feeMode: 'auto' }, now);
equal('sin desglose, el servidor sigue con "Cuota - Mes Año"', [legacy[legacy.length - 1].concept, 'breakdown' in legacy[legacy.length - 1]], ['Cuota - Noviembre 2026', false]);
const mismatch = M.missingFees(residents, [], { ...settings, fee: 600, chargeDay: 5, feeMode: 'auto' }, now);
equal('si el desglose no suma la cuota, el servidor conserva el concepto de siempre', mismatch[mismatch.length - 1].concept, 'Cuota - Noviembre 2026');
equal('el saldo y la mora usan el monto, no el texto', M.balanceOf(withBreakdown, 'r1'), -500 * withBreakdown.length);

console.log('\nAgua por lote (paja de agua)');
// Datos inventados: mantenimiento Q300 y la paja de agua a Q160 (media paja Q80)
const perLot = { fee: 300, currency: 'GTQ', feeBreakdown: { maintenance: 300 }, waterUnitPrice: 160 };
equal('la cuota del lote: sin casa Q300, media paja Q380, una paja Q460', [C.residentFee(perLot, {}), C.residentFee(perLot, { waterUnits: 0.5 }), C.residentFee(perLot, { waterUnits: 1 })], [300, 380, 460]);
equal('lo que paga de agua cada lote', [C.waterOf(perLot, {}), C.waterOf(perLot, { waterUnits: 0.5 }), C.waterOf(perLot, { waterUnits: 1 })], [0, 80, 160]);
equal('el agua guardada como texto tambien vale', [C.residentFee(perLot, { waterUnits: '0.5' }), C.residentFee(perLot, { waterUnits: '1' })], [380, 460]);
equal('solo valen nada, media paja o una paja: lo demas es sin agua', [C.waterUnits({ waterUnits: 2 }), C.waterUnits({ waterUnits: 0.25 }), C.waterUnits({ waterUnits: 'una' }), C.waterUnits({ waterUnits: -1 }), C.waterUnits({}), C.waterUnits(null)], [0, 0, 0, 0, 0, 0]);
equal('sin ficha del residente, la cuota es la del condominio', [C.residentFee(perLot, null), C.residentFee(perLot, undefined)], [300, 300]);
equal('sin precio de la paja nada cambia: todos pagan la cuota del condominio', [C.residentFee({ fee: 300 }, { waterUnits: 1 }), C.residentFee({ fee: '300', waterUnitPrice: '' }, { waterUnits: 0.5 })], [300, 300]);
equal('un condominio que no cobra cuota tampoco cobra agua', [C.residentFee({ fee: 0, waterUnitPrice: 160 }, { waterUnits: 1 }), C.residentFee(null, { waterUnits: 1 })], [0, 0]);
equal('la cuota de una paja nombra el agua y dice su mes', C.residentFeeInfo(perLot, { waterUnits: 1 }, 460, '2026-11'), { concept: 'Por aporte para mantenimiento y servicio de agua correspondiente a noviembre de 2026 Q 460.00', breakdown: { maintenance: 300, water: 160 } });
equal('la de media paja', C.residentFeeInfo(perLot, { waterUnits: 0.5 }, 380, '2026-11'), { concept: 'Por aporte para mantenimiento y servicio de agua correspondiente a noviembre de 2026 Q 380.00', breakdown: { maintenance: 300, water: 80 } });
equal('la de un lote sin casa no nombra el agua', C.residentFeeInfo(perLot, {}, 300, '2026-11'), { concept: 'Por aporte para mantenimiento correspondiente a noviembre de 2026 Q 300.00', breakdown: { maintenance: 300 } });
equal('si el condominio ya cobra agua a todos, la del lote se suma a ese concepto', C.residentFeeInfo({ ...perLot, fee: 320, feeBreakdown: { maintenance: 300, water: 20 } }, { waterUnits: 1 }, 480, '2026-11').breakdown, { maintenance: 300, water: 180 });
equal('sin desglose configurado, la cuota del lote conserva "Cuota - Mes Año"', C.residentFeeInfo({ fee: 300, waterUnitPrice: 160 }, { waterUnits: 1 }, 460, '2026-11'), null);
equal('un cobro de otro monto que la cuota del lote conserva su concepto de siempre', [C.residentFeeInfo(perLot, { waterUnits: 1 }, 300, '2026-11'), C.residentFeeInfo(perLot, {}, 460, '2026-11')], [null, null]);
equal('sin agua por lote, residentFeeInfo es feeInfo', C.residentFeeInfo(settings, { waterUnits: 1 }, 500, '2026-10'), C.feeInfo(settings, 500, '2026-10'));
equal('la configuracion no se toca al calcular', perLot.feeBreakdown, { maintenance: 300 });

const lots = [
    { id: 'a1', status: 'active', createdAt: '2020-01-01T00:00:00Z' },
    { id: 'b1', status: 'active', createdAt: '2020-01-01T00:00:00Z', waterUnits: 0.5 },
    { id: 'c1', status: 'active', createdAt: '2020-01-01T00:00:00Z', waterUnits: 1 }
];
const lotFees = M.missingFees(lots, [], { ...perLot, chargeDay: 5, feeMode: 'auto' }, now).filter((t) => t.period === '2026-11');
equal('el servidor cobra a cada lote su cuota', lotFees.map((t) => [t.resiId, t.amount]), [['a1', 300], ['b1', 380], ['c1', 460]]);
equal('y cada cuota lleva su desglose', lotFees.map((t) => t.breakdown), [{ maintenance: 300 }, { maintenance: 300, water: 80 }, { maintenance: 300, water: 160 }]);
equal('el concepto de cada una dice su monto', lotFees.map((t) => t.concept.slice(-8)), ['Q 300.00', 'Q 380.00', 'Q 460.00']);
equal('sin precio de la paja el servidor cobra lo mismo a todos', M.missingFees(lots, [], { fee: 300, feeBreakdown: { maintenance: 300 }, chargeDay: 5, feeMode: 'auto' }, now).filter((t) => t.period === '2026-11').map((t) => t.amount), [300, 300, 300]);
equal('con agua por lote y sin desglose, el servidor cobra el monto del lote con "Cuota - Mes Año"', M.missingFees(lots, [], { fee: 300, waterUnitPrice: 160, chargeDay: 5, feeMode: 'auto' }, now).filter((t) => t.period === '2026-11').map((t) => [t.amount, t.concept]), [[300, 'Cuota - Noviembre 2026'], [380, 'Cuota - Noviembre 2026'], [460, 'Cuota - Noviembre 2026']]);
equal('la garita compara con la cuota del lote: una cuota de Q460 vencida no bloquea', [
    M.moraOf('c1', [{ id: 'x', type: 'charge', kind: 'fee', period: '2026-10', amount: 460, resiId: 'c1', date: '2026-10-05T18:00:00.000Z' }], { ...perLot, chargeDay: 5 }, now, lots[2]).moroso,
    M.moraOf('c1', [{ id: 'x', type: 'charge', kind: 'fee', period: '2026-10', amount: 460, resiId: 'c1', date: '2026-10-05T18:00:00.000Z' }], { ...perLot, chargeDay: 5 }, now).moroso
], [false, true]);

console.log('\nCuotas de meses elegidos con algunos conceptos (ventana del vecino)');
const full = { fee: 355, currency: 'GTQ', feeBreakdown: { maintenance: 300, garbage: 25, electricity: 30 }, waterUnitPrice: 160 };
equal('conceptos de un lote con media paja', C.lotParts(full, { waterUnits: 0.5 }), [
    { key: 'maintenance', label: 'Mantenimiento', amount: 300 }, { key: 'water', label: 'Agua', amount: 80 },
    { key: 'garbage', label: 'Recolección de basura', amount: 25 }, { key: 'electricity', label: 'Electricidad', amount: 30 }
]);
equal('un lote sin casa no tiene agua', C.lotParts(full, {}).map((p) => p.key), ['maintenance', 'garbage', 'electricity']);
equal('el agua fija del desglose se suma a la de la paja', C.lotParts({ fee: 350, feeBreakdown: { maintenance: 300, water: 50 }, waterUnitPrice: 160 }, { waterUnits: 1 }).find((p) => p.key === 'water').amount, 210);
equal('sin desglose la cuota entera es mantenimiento', C.lotParts({ fee: 300 }, {}), [{ key: 'maintenance', label: 'Mantenimiento', amount: 300 }]);
equal('sin cuota no hay conceptos', C.lotParts({}, { waterUnits: 1 }), []);
equal('todos los conceptos', C.monthFee(full, { waterUnits: 0.5 }, ['maintenance', 'water', 'garbage', 'electricity'], '2026-10'), {
    amount: 435,
    concept: 'Por aporte para mantenimiento, servicio de agua, recolección de basura y servicio de electricidad correspondiente a octubre de 2026 Q 435.00',
    breakdown: { maintenance: 300, water: 80, garbage: 25, electricity: 30 }
});
equal('solo agua', C.monthFee(full, { waterUnits: 1 }, ['water'], '2025-03'), { amount: 160, concept: 'Por aporte para servicio de agua correspondiente a marzo de 2025 Q 160.00', breakdown: { water: 160 } });
equal('un concepto que el lote no tiene no cuenta', C.monthFee(full, {}, ['water'], '2026-10'), null);
equal('sin conceptos no hay cuota', C.monthFee(full, { waterUnits: 1 }, [], '2026-10'), null);
equal('sin desglose y la cuota entera: el concepto de siempre', C.monthFee({ fee: 300 }, {}, ['maintenance'], '2026-11'), { amount: 300, concept: 'Cuota - Noviembre 2026', breakdown: null });
equal('sin desglose con agua por paja: describe los dos', C.monthFee({ fee: 300, waterUnitPrice: 160 }, { waterUnits: 0.5 }, ['maintenance', 'water'], '2026-01').concept, 'Por aporte para mantenimiento y servicio de agua correspondiente a enero de 2026 Q 380.00');

console.log('\nIntegracion en OIKOS y copia del servidor');
yes('el servidor usa una copia IDENTICA del modulo', read('finanzas/sisdel-cuotas.js') === read('functions/src/finanzas/cuotas.js'));
const oikos = read('finanzas/index.html');
yes('OIKOS carga el modulo', /<script src="\.\/sisdel-cuotas\.js\?v=\w+"><\/script>/.test(oikos));
yes('OIKOS tiene los cinco campos del desglose en Configuracion', ['maintenance', 'water', 'garbage', 'electricity', 'other'].every((k) => new RegExp(`id="cfg-fee-${k}"[^>]*oninput="updateFeeTotal\\(\\)"`).test(oikos)));
yes('la cuota mensual es la suma y no se edita a mano', /id="cfg-fee" readonly/.test(oikos));
yes('hay una vista previa de la descripcion del cargo, con el mes actual de ejemplo', /id="cfg-fee-preview"/.test(oikos) && /SisdelCuotas\.describe\(breakdown, \(document\.getElementById\('cfg-curr'\) \|\| \{\}\)\.value, currentFeePeriod\(\)\)/.test(oikos));
yes('Configuracion muestra el desglose al abrir y lo guarda al guardar', /fillFeeBreakdown\(s\);/.test(oikos) && /feeBreakdown,\n/.test(oikos) && /fee: feeTotal,/.test(oikos));
yes('toda cuota (automatica, manual o por meses) pasa por createFeeCharge con el concepto del desglose y su mes', /const feeInfo = SisdelCuotas\.feeInfo\(Store\.get\('settings'\), fee, period\);/.test(oikos) && /concept: feeInfo \? feeInfo\.concept : feeConceptFor\(y, m\),/.test(oikos) && /\.\.\.\(feeInfo \? \{ breakdown: feeInfo\.breakdown \} : \{\}\)/.test(oikos));
yes('las cuatro vias de cobro llaman a createFeeCharge', (oikos.match(/createFeeCharge\(txs, /g) || []).length >= 4);
yes('el detalle de un movimiento muestra el desglose', /SisdelCuotas\.listParts\(tx\.breakdown/.test(oikos));
yes('el desglose es un privilegio de la cuota: el bloqueo de pantalla y el filtro de subida lo tratan como tal', /'#cfg-fee-maintenance'/.test(read('finanzas-bloqueo.js')) && /'feeBreakdown'/.test(read('finanzas-sync.js')) && /hasAny\(\['fee', 'feeBreakdown'/.test(read('firestore.rules')));

// El modulo cargado como script de navegador (sin module.exports) expone SisdelCuotas
const sandbox = { self: {} };
vm.createContext(sandbox);
vm.runInContext(read('finanzas/sisdel-cuotas.js'), sandbox);
yes('en el navegador queda como SisdelCuotas', sandbox.self.SisdelCuotas && typeof sandbox.self.SisdelCuotas.feeInfo === 'function');

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
