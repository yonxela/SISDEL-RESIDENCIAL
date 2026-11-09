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

console.log('\nServidor: cuotas del dia');
const residents = [{ id: 'r1', status: 'active', createdAt: '2020-01-01T00:00:00Z' }];
const now = M.gtDate(2026, 10, 7, 12);
const withBreakdown = M.missingFees(residents, [], { ...settings, chargeDay: 5, feeMode: 'auto' }, now);
const lastWith = withBreakdown[withBreakdown.length - 1];
equal('la cuota automatica del servidor lleva la misma descripcion que cobra OIKOS', [lastWith.concept, lastWith.breakdown, lastWith.amount, lastWith.period], ['Por aporte para mantenimiento y servicio de agua Q 500.00', { maintenance: 400, water: 100 }, 500, '2026-11']);
equal('todas las cuotas del ano del servidor la llevan', withBreakdown.every((t) => t.concept === lastWith.concept && t.amount === 500), true);
const legacy = M.missingFees(residents, [], { fee: 500, chargeDay: 5, feeMode: 'auto' }, now);
equal('sin desglose, el servidor sigue con "Cuota - Mes Año"', [legacy[legacy.length - 1].concept, 'breakdown' in legacy[legacy.length - 1]], ['Cuota - Noviembre 2026', false]);
const mismatch = M.missingFees(residents, [], { ...settings, fee: 600, chargeDay: 5, feeMode: 'auto' }, now);
equal('si el desglose no suma la cuota, el servidor conserva el concepto de siempre', mismatch[mismatch.length - 1].concept, 'Cuota - Noviembre 2026');
equal('el saldo y la mora usan el monto, no el texto', M.balanceOf(withBreakdown, 'r1'), -500 * withBreakdown.length);

console.log('\nIntegracion en OIKOS y copia del servidor');
yes('el servidor usa una copia IDENTICA del modulo', read('finanzas/sisdel-cuotas.js') === read('functions/src/finanzas/cuotas.js'));
const oikos = read('finanzas/index.html');
yes('OIKOS carga el modulo', /<script src="\.\/sisdel-cuotas\.js\?v=\w+"><\/script>/.test(oikos));
yes('OIKOS tiene los cinco campos del desglose en Configuracion', ['maintenance', 'water', 'garbage', 'electricity', 'other'].every((k) => new RegExp(`id="cfg-fee-${k}"[^>]*oninput="updateFeeTotal\\(\\)"`).test(oikos)));
yes('la cuota mensual es la suma y no se edita a mano', /id="cfg-fee" readonly/.test(oikos));
yes('hay una vista previa de la descripcion del cargo', /id="cfg-fee-preview"/.test(oikos));
yes('Configuracion muestra el desglose al abrir y lo guarda al guardar', /fillFeeBreakdown\(s\);/.test(oikos) && /feeBreakdown,\n/.test(oikos) && /fee: feeTotal,/.test(oikos));
yes('toda cuota (automatica, manual o por meses) pasa por createFeeCharge con el concepto del desglose', /const feeInfo = SisdelCuotas\.feeInfo\(Store\.get\('settings'\), fee\);/.test(oikos) && /concept: feeInfo \? feeInfo\.concept : feeConceptFor\(y, m\),/.test(oikos) && /\.\.\.\(feeInfo \? \{ breakdown: feeInfo\.breakdown \} : \{\}\)/.test(oikos));
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
