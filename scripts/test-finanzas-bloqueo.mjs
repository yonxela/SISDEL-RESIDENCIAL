// Pruebas del bloqueo por privilegios dentro de OIKOS (finanzas-bloqueo.js): sin emuladores ni navegador.
// Las partes que dependen de la pagina viva (instalar en el iframe) se verifican en el navegador.
// Uso: node test-finanzas-bloqueo.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../finanzas-bloqueo.js').internals;
const PRIV = require('../privilegios.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const only = (...names) => (key) => names.map((n) => 'finanzas.' + n).includes(key);
const all = () => true;
const none = () => false;
const blocked = (attr, can) => B.checkAttribute(attr, can) !== null;

console.log('\nPrivilegio que exige cada accion de OIKOS');
equal('el administrador (todo) puede cualquier accion', ['openFeeRun()', "deleteTransaction('x')", 'clearDB()', 'History.undo()', "navigate('reports')"].map((a) => blocked(a, all)), [false, false, false, false, false]);
equal('sin privilegios se bloquea todo lo que escribe o exporta', ['openFeeRun()', "deleteTransaction('x')", 'clearDB()', 'History.undo()', 'printReport()', 'saveSettings()', "openModal('modal-income')"].map((a) => blocked(a, none)), [true, true, true, true, true, true, true]);
equal('cada boton exige su privilegio', [
    blocked("openModal('modal-income')", only('pagos_registrar')),
    blocked("openModal('modal-expense')", only('pagos_registrar')),
    blocked("openModal('modal-bulk-charge')", only('cargos_crear')),
    blocked('openFeeRun()', only('cuotas_mes')),
    blocked('openFeeRun()', only('cuotas_meses')),
    blocked("openResidentFeeMonths('u1')", only('cuotas_meses')),
    blocked('fixDuplicateFees()', only('cuotas_corregir')),
    blocked("openFiniquito('u1')", only('residentes_finiquitar')),
    blocked("deleteResident('u1')", only('residentes_eliminar')),
    blocked("editResident('u1')", only('residentes_editar')),
    blocked("editResident('u1')", only('residentes_crear')),
    blocked("openEstadoCuenta('u1')", only('residentes_estado')),
    blocked('openReminders()', only('residentes_contactar')),
    blocked('clearDB()', only('limpiar')),
    blocked('clearDB()', only('config_cuota'))
], [false, true, false, false, true, false, false, false, false, false, true, false, false, false, true]);
equal('anular cualquier movimiento exige alguna de las tres', [
    blocked("deleteTransaction('x')", only('pagos_anular')), blocked("deleteTransaction('x')", only('egresos_anular')),
    blocked("deleteTransaction('x')", only('cargos_anular')), blocked("deleteTransaction('x')", only('pagos_registrar', 'deshacer'))
], [false, false, false, true]);
equal('el boton Anular del detalle (cierra el modal y llama con retraso) tambien se detecta',
    blocked("closeModal('modal-tx-detail'); setTimeout(() => deleteTransaction('x'), 150)", none), true);
equal('una sentencia con stopPropagation no esconde la accion', blocked("event.stopPropagation(); deleteTransaction('x')", none), true);
equal('cerrar un modal o filtrar la lista no exige nada', ["closeModal('modal-income')", "setTxFilter('all')", "setEcPeriod('year')", "toggleMenu('m1')", 'renderCurrentReport()'].map((a) => blocked(a, none)), [false, false, false, false, false]);
equal('las pantallas del menu exigen su privilegio', [
    blocked("navigate('dashboard')", only('tablero_ver')), blocked("navigate('dashboard')", only('residentes_ver')),
    blocked("navigate('reports')", only('reportes_libro')), blocked("navigate('reports')", only('reportes_resumen')),
    blocked("navigate('settings')", only('config_ver')), blocked("navigate('accounting')", only('contabilidad_ver'))
], [false, true, false, true, false, false]);
equal('los reportes exigen el de cada uno', [
    blocked("selectReport('income')", only('reportes_ingresos')), blocked("selectReport('income')", only('reportes_morosos')),
    blocked("selectReport('morosos')", only('reportes_morosos')), blocked("selectReport('expense-cat')", only('reportes_gastos')),
    blocked("selectReport('account-statement')", only('reportes_libro')), blocked("openReportModal()", only('reportes_resumen'))
], [false, true, false, false, false, false]);
equal('imprimir y exportar exigen reportes_exportar', ['printReport()', 'downloadReportPDF()', 'exportReportCSV()', 'exportReportExcel()', 'exportResStatusPDF()', 'exportResStatusExcel()', 'printEstadoCuenta()', 'downloadEstadoCuentaPDF()', 'exportCSV()', 'exportToPDF()'].map((a) => blocked(a, only('reportes_ingresos', 'reportes_resumen', 'residentes_estado'))), Array(10).fill(true));
equal('con reportes_exportar se puede exportar', ['printReport()', 'exportCSV()', 'exportToPDF()'].map((a) => blocked(a, only('reportes_exportar'))), [false, false, false]);
equal('comprobantes', ["openVoucherOptions('x')", "viewReceiptImage('x')", 'downloadReceiptImage()', 'printVoucher()'].map((a) => blocked(a, only('comprobantes'))), [false, false, false, false]);
equal('el detalle de un movimiento se abre con cualquiera de sus pantallas', [
    blocked("openTxDetail('x')", only('contabilidad_ver')), blocked("openTxDetail('x')", only('residentes_estado')),
    blocked("openTxDetail('x')", only('reportes_libro')), blocked("openTxDetail('x')", only('tablero_ver'))
], [false, false, false, true]);
equal('guardar la configuracion exige alguna de las tres', [
    blocked('saveSettings()', only('config_general')), blocked('saveSettings()', only('config_cuota')), blocked('saveSettings()', only('config_conceptos')), blocked('saveSettings()', only('config_ver'))
], [false, false, false, true]);
equal('el modo de cobro es de la cuota', [blocked("setFeeMode('auto')", only('config_cuota')), blocked("setFeeMode('auto')", only('config_general'))], [false, true]);
equal('el formulario de pagos y el de egresos exigen cada uno el suyo', [
    blocked("handleTransactionSubmit(event, 'income')", only('pagos_registrar')), blocked("handleTransactionSubmit(event, 'income')", only('egresos_registrar')),
    blocked("handleTransactionSubmit(event, 'expense')", only('egresos_registrar')), blocked("handleTransactionSubmit(event, 'expense')", only('pagos_registrar'))
], [false, true, false, true]);

console.log('\nPantallas');
equal('con todo, la primera pantalla es el tablero', B.firstView(all), 'dashboard');
equal('sin tablero se lleva a la primera permitida', [B.firstView(only('residentes_ver', 'contabilidad_ver')), B.firstView(only('config_ver')), B.firstView(only('reportes_gastos'))], ['residents', 'settings', 'reports']);
equal('sin ninguna no hay pantalla de inicio', B.firstView(none), null);
equal('Reportes se abre con cualquiera de sus cuatro', [B.viewAllowed('reports', only('reportes_libro')), B.viewAllowed('reports', only('reportes_resumen'))], [true, false]);
equal('el primer reporte permitido', [B.firstReport(only('reportes_gastos', 'reportes_libro')), B.firstReport(none), B.firstReport(all)], ['expense-cat', null, 'income']);

console.log('\nHoja de estilos');
const cssAll = B.cssFor(all);
equal('con todos los privilegios no se oculta nada', cssAll, '');
const cssNone = B.cssFor(none);
equal('sin privilegios se ocultan las cinco pantallas', ['#nav-dashboard', '#nav-residents', '#nav-accounting', '#nav-reports', '#nav-settings'].every((s) => cssNone.includes(s)), true);
equal('sin privilegios se ocultan deshacer y limpiar', ['#btn-undo-header', '#btn-redo-header', '#btn-clear'].every((s) => cssNone.includes(s)), true);
const cashier = only('tablero_ver', 'residentes_ver', 'residentes_estado', 'contabilidad_ver', 'comprobantes', 'pagos_registrar', 'reportes_morosos');
const cssCashier = B.cssFor(cashier);
equal('un cajero ve el boton de pagos y no el de egresos ni el de cargos', [cssCashier.includes("modal-income"), cssCashier.includes("openModal('modal-expense')"), cssCashier.includes("openModal('modal-bulk-charge')")], [false, true, true]);
equal('un cajero no ve los datos personales ni la configuracion', [cssCashier.includes('#res-dpi'), cssCashier.includes('#nav-settings'), cssCashier.includes('#btn-save-cfg')], [true, true, true]);
equal('un cajero sigue viendo reportes de morosos y no exporta', [cssCashier.includes('#rep-tab-morosos'), cssCashier.includes('printReport()'), cssCashier.includes('#nav-reports')], [false, true, false]);
equal('sin estado de cuenta el nombre del residente deja de ser enlace', B.cssFor(only('residentes_ver')).includes('text-decoration: none'), true);
equal('con configuracion solo de lectura los campos quedan bloqueados', (() => {
    const css = B.cssFor(only('config_ver'));
    return ['#cfg-name', '#cfg-fee', '#cfg-feemode-auto', '#new-inc-concept', '#btn-save-cfg'].every((s) => css.includes(s));
})(), true);
equal('el desglose de la cuota (cinco campos) tambien queda bloqueado sin config_cuota', (() => {
    const css = B.cssFor(only('config_ver', 'config_general'));
    return ['maintenance', 'water', 'garbage', 'electricity', 'other'].every((k) => css.includes(`#cfg-fee-${k}`));
})(), true);
equal('con config_cuota el desglose no se bloquea', (() => {
    const css = B.cssFor(only('config_ver', 'config_cuota'));
    return ['maintenance', 'water', 'garbage', 'electricity', 'other'].some((k) => css.includes(`#cfg-fee-${k}`));
})(), false);
equal('los campos del desglose se deshabilitan (no se pueden quitar del DOM: saveSettings los lee)', B.DISABLE.config_cuota.includes('#cfg-fee-maintenance') && B.DISABLE.config_cuota.includes('#cfg-fee-other'), true);

console.log('\nCobertura del catalogo: ningun privilegio de OIKOS queda sin efecto en pantalla');
const names = PRIV.ITEMS.filter((i) => i.key.startsWith('finanzas.')).map((i) => i.key.slice('finanzas.'.length));
const referenced = new Set();
const collect = (list) => list.forEach((names) => names.forEach((n) => referenced.add(n)));
collect(B.ACTIONS.map(([, n]) => n));
collect(B.HIDE.map(([n]) => n));
collect(B.LOCK.map(([n]) => n));
collect(Object.values(B.VIEWS));
Object.keys(B.DISABLE).forEach((n) => referenced.add(n));
// finanzas.ver y finanzas.usar son el acceso (reglas y pagina); deshacer/limpiar/etc. salen de las listas anteriores
const unreferenced = names.filter((n) => !['ver', 'usar'].includes(n) && !referenced.has(n));
equal('toda clave finanzas.* (salvo el acceso) se usa en el bloqueo de pantalla', unreferenced, []);
const unknown = [...referenced].filter((n) => !names.includes(n));
equal('el bloqueo no menciona claves que no existen en el catalogo', unknown, []);
{
    // Fiscalizador: un vecino con el Sistema Financiero en solo lectura
    const fiscalOv = PRIV.toOverrides('vecino', PRIV.templateKeys(PRIV.templateById('sys-fiscalizador')));
    const fiscal = (key) => PRIV.has('vecino', fiscalOv, key);
    const css = B.cssFor(fiscal);
    equal('fiscalizador: abre el tablero y ve todas las pantallas de lectura', [B.firstView(fiscal), ['dashboard', 'residents', 'accounting', 'reports', 'settings'].every((v) => B.viewAllowed(v, fiscal))], ['dashboard', true]);
    equal('fiscalizador: no ve botones de escribir ni guardar la configuracion', ["openModal('modal-income')", "openModal('modal-expense')", "openModal('modal-bulk-charge')", "openModal('modal-resident')", 'openFeeRun()', '#btn-save-cfg', '#btn-undo-header', '#btn-clear'].every((s) => css.includes(s)), true);
    equal('fiscalizador: no ve el DPI ni los recordatorios por WhatsApp', ['#res-dpi', 'openReminders()'].every((s) => css.includes(s)), true);
    equal('fiscalizador: puede ver estado de cuenta, comprobantes y exportar reportes', ['modal-estado-cuenta', 'modal-voucher-options', 'printReport()'].some((s) => css.includes(s)), false);
    equal('fiscalizador: ninguna accion de escribir pasa el bloqueo de clic', ["openModal('modal-income')", "deleteTransaction('x')", 'applyFeeRun()', 'saveSettings()', 'clearDB()', 'History.undo()'].every((a) => B.checkAttribute(a, fiscal) !== null), true);
}
equal('un administrador (acceso de siempre) no pierde nada en pantalla', B.cssFor((key) => PRIV.has('admin', {}, key)), '');
equal('un auditor ve las pantallas pero no puede usar el sistema financiero', B.firstView((key) => PRIV.has('auditor', {}, key)), null);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
