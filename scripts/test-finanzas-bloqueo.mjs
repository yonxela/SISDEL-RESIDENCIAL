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
equal('el administrador (todo) puede cualquier accion', ['openFeeRun()', "deleteTransaction('x')", 'History.undo()', "navigate('reports')"].map((a) => blocked(a, all)), [false, false, false, false]);
equal('sin privilegios se bloquea todo lo que escribe o exporta', ['openFeeRun()', "deleteTransaction('x')", 'History.undo()', 'printReport()', 'saveSettings()', "openModal('modal-income')"].map((a) => blocked(a, none)), [true, true, true, true, true, true]);
equal('cada boton exige su privilegio', [
    blocked("openModal('modal-income')", only('pagos_registrar')),
    blocked("openModal('modal-expense')", only('pagos_registrar')),
    blocked("openModal('modal-bulk-charge')", only('cargos_crear', 'saldos_modificar')),
    blocked('openFeeRun()', only('cuotas_mes')),
    blocked('openFeeRun()', only('cuotas_meses')),
    blocked("openResidentFeeMonths('u1')", only('cuotas_meses', 'saldos_modificar')),
    blocked('fixDuplicateFees()', only('cuotas_corregir', 'saldos_modificar')),
    blocked("openFiniquito('u1')", only('residentes_finiquitar')),
    blocked("deleteResident('u1')", only('residentes_eliminar')),
    blocked("editResident('u1')", only('residentes_editar')),
    blocked("editResident('u1')", only('residentes_crear')),
    blocked("openEstadoCuenta('u1')", only('residentes_estado')),
    blocked('openReminders()', only('residentes_contactar'))
], [false, true, false, false, true, false, false, false, false, false, true, false, false]);
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
    blocked("navigate('reports')", only('reportes_libro')), blocked("navigate('reports')", only('reportes_exportar')),
    blocked("navigate('settings')", only('config_ver')), blocked("navigate('accounting')", only('contabilidad_ver'))
], [false, true, false, true, false, false]);
equal('los reportes exigen el de cada uno', [
    blocked("selectReport('income')", only('reportes_ingresos')), blocked("selectReport('income')", only('reportes_morosos')),
    blocked("selectReport('morosos')", only('reportes_morosos')), blocked("selectReport('expense-cat')", only('reportes_gastos')),
    blocked("selectReport('account-statement')", only('reportes_libro')), blocked("openReportModal()", only('reportes_resumen'))
], [false, true, false, false, false, false]);
equal('imprimir y exportar exigen reportes_exportar', ['printReport()', 'downloadReportPDF()', 'exportReportCSV()', 'exportReportExcel()', 'exportResStatusPDF()', 'exportResStatusExcel()', 'printEstadoCuenta()', 'downloadEstadoCuentaPDF()', 'exportCSV()', 'shareCurrentReportWhatsApp()'].map((a) => blocked(a, only('reportes_ingresos', 'reportes_resumen', 'residentes_estado'))), Array(10).fill(true));
equal('con reportes_exportar se puede exportar', ['printReport()', 'exportCSV()', 'exportCurrentReportExcel()'].map((a) => blocked(a, only('reportes_exportar'))), [false, false, false]);
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
equal('"Crear nueva categoria" del Gasto: con registrar egresos o con editar los conceptos (las reglas dejan cualquiera de los dos)', [
    blocked('openNewExpCategory()', only('egresos_registrar')), blocked('saveNewExpCategory()', only('egresos_registrar')),
    blocked('saveNewExpCategory()', only('config_conceptos')), blocked('closeNewExpCategory()', only('config_conceptos')),
    blocked('saveNewExpCategory()', only('pagos_registrar')), blocked('openNewExpCategory()', none)
], [false, false, false, false, true, true]);

equal('placas del residente: agregar y quitar piden editar residentes y el bloque se oculta sin ese privilegio', [
    blocked('resAddPlate()', only('residentes_editar')), blocked('resRemovePlate(this.dataset.id)', only('residentes_editar')),
    blocked('resAddPlate()', only('residentes_crear')), blocked('resRemovePlate(this.dataset.id)', none),
    B.cssFor(only('residentes_ver')).includes('#res-plates-edit'), B.cssFor(only('residentes_editar')).includes('#res-plates-edit')
], [false, false, true, true, true, false]);

equal('Generar codigo boton de panico (menu del residente): todo pide contactar residentes y se oculta sin ese privilegio', [
    ...['openPanicQr(this.dataset.id)', "panicQrSetSize(this.value)", 'panicQrSetPaper(this.value)', 'panicQrCopyLink()', 'printPanicQr()', 'downloadPanicQrPDF()', 'sendPanicQrWhatsApp()'].map((a) => blocked(a, only('residentes_contactar'))),
    blocked('openPanicQr(this.dataset.id)', only('residentes_ver')), blocked('printPanicQr()', only('reportes_exportar')),
    B.cssFor(only('residentes_ver')).includes('openPanicQr(') && B.cssFor(only('residentes_ver')).includes('#modal-panico-qr'), B.cssFor(only('residentes_contactar')).includes('openPanicQr(')
], [false, false, false, false, false, false, false, true, true, true, false]);

console.log('\nPantallas');
equal('con todo, la primera pantalla es el tablero', B.firstView(all), 'dashboard');
equal('sin tablero se lleva a la primera permitida', [B.firstView(only('residentes_ver', 'contabilidad_ver')), B.firstView(only('config_ver')), B.firstView(only('reportes_gastos'))], ['residents', 'settings', 'reports']);
equal('sin ninguna no hay pantalla de inicio', B.firstView(none), null);
equal('Reportes se abre con cualquiera de sus cinco (el reporte financiero tambien: ahi esta el de ingresos y egresos por mes)', [B.viewAllowed('reports', only('reportes_libro')), B.viewAllowed('reports', only('reportes_resumen')), B.viewAllowed('reports', only('reportes_exportar'))], [true, true, false]);
equal('recordatorios: enviar pide contactar; guardar el mensaje para todos pide la configuracion general', [blocked('sendReminder(this.dataset.id)', only('residentes_contactar')), blocked('resetReminderMessages()', only('residentes_contactar')), blocked('saveReminderMessages()', only('residentes_contactar')), blocked('saveReminderMessages()', only('config_general')), B.cssFor(only('residentes_contactar')).includes('#rem-msg-save'), B.cssFor(only('residentes_contactar', 'config_general')).includes('#rem-msg-save')], [false, false, true, false, true, false]);
equal('recordatorios: enviar desde mi WhatsApp pide contactar (empezar, abrir, siguiente, saltar, terminar y cerrar)', ['remManualStart()', 'remManualOpen()', 'remManualNext()', 'remManualSkip()', 'remManualStop()', 'remManualClose()'].map((c) => [blocked(c, only('pagos_registrar')), blocked(c, only('residentes_contactar'))]), Array(6).fill([true, false]));
equal('Mi WhatsApp: el del menu y el de cada fila piden contactar; el del chat pide el chat; el del menu se oculta sin contactar', [blocked('contactMyWhatsApp(this.dataset.id)', only('residentes_ver')), blocked('contactMyWhatsApp(this.dataset.id)', only('residentes_contactar')), blocked('sendReminderMine(this.dataset.id)', only('residentes_ver')), blocked('sendReminderMine(this.dataset.id)', only('residentes_contactar')), blocked('chatSendFromMine()', only('residentes_contactar')), blocked('chatSendFromMine()', only('whatsapp_chat')), B.cssFor(only('residentes_ver')).includes('#residents-table-body .dropdown button[onclick^="contactMyWhatsApp("]'), B.cssFor(only('residentes_contactar')).includes('contactMyWhatsApp(')], [true, false, true, false, true, false, true, false]);
equal('recordatorios: elegir el mensaje (morosidad o varios) pide contactar', [blocked("setReminderMode('varios')", only('pagos_registrar')), blocked("setReminderMode('varios')", only('residentes_contactar'))], [true, false]);
// Selectores completos que oculta la hoja de estilos (no basta buscar el texto: un selector puede contener a otro)
const hidden = (can) => B.cssFor(can).split(/[,{}]/).map((x) => x.trim()).filter(Boolean);
equal('bancos: abrir cuentas, movimientos y anular piden cada uno su privilegio', [
    blocked('openBankAccountForm()', only('bancos_ver')), blocked('openBankAccountForm()', only('bancos_cuentas')),
    blocked('openBankMovement()', only('bancos_cuentas')), blocked('openBankMovement()', only('bancos_movimientos')),
    blocked('openBankTransfer()', only('bancos_movimientos')), blocked('openBankAnnul(this.dataset.id)', only('bancos_movimientos')),
    blocked('openBankAnnul(this.dataset.id)', only('bancos_anular')), blocked("bankExport('pdf')", only('bancos_ver')), blocked("bankExport('pdf')", only('reportes_exportar'))
], [true, false, true, false, false, true, false, true, false]);
equal('bancos: la pantalla se abre con ver bancos y sin el se ocultan menu, pantalla y tarjeta del tablero', [B.viewAllowed('banks', only('bancos_ver')), B.viewAllowed('banks', only('contabilidad_ver')), ['#nav-banks', '#view-banks', '#dash-bank'].every((sel) => hidden(only('contabilidad_ver')).includes(sel)), hidden(only('bancos_ver')).includes('#view-banks')], [true, false, true, false]);
equal('bancos: sin anular se oculta el boton de anular de cada movimiento; sin movimientos, registrar y transferir', [B.cssFor(only('bancos_ver', 'bancos_movimientos')).includes('openBankAnnul('), ['#btn-bank-move', '#btn-bank-transfer'].every((sel) => B.cssFor(only('bancos_ver')).includes(sel))], [true, true]);
equal('el mapa de pagos pide el de morosos (y se oculta sin el)', [blocked("selectReport('pay-map')", only('reportes_morosos')), blocked("selectReport('pay-map')", only('reportes_ingresos')), B.cssFor(only('reportes_ingresos')).includes('#rep-tab-pay-map'), B.cssFor(only('reportes_morosos')).includes('#rep-tab-pay-map')], [false, true, true, false]);
equal('el listado de vecinos con morosidad pide el de morosos (y se oculta sin el)', [blocked("selectReport('mora-list')", only('reportes_morosos')), blocked("selectReport('mora-list')", only('reportes_ingresos')), B.cssFor(only('reportes_ingresos')).includes('#rep-tab-mora-list'), B.cssFor(only('reportes_morosos')).includes('#rep-tab-mora-list')], [false, true, true, false]);
equal('la ventana de contactar pide contactar a los residentes: sus funciones se bloquean y sin el la ventana se oculta', [blocked('contactSendServer()', only('residentes_contactar')), blocked('contactSendServer()', only('residentes_ver')), blocked('contactSendMine()', only('residentes_ver')), blocked('openContact(this.dataset.id)', only('residentes_ver')), B.cssFor(only('residentes_ver')).includes('#modal-contact'), B.cssFor(only('residentes_contactar')).includes('#modal-contact')], [false, true, true, true, true, false]);
equal('el chat de WhatsApp pide su privilegio: sin el se ocultan menu, pantalla y el boton de cada residente', [B.viewAllowed('chats', only('whatsapp_chat')), B.viewAllowed('chats', only('residentes_contactar')), ['#nav-chats', '#view-chats', 'openResidentChat('].every((sel) => B.cssFor(only('residentes_ver')).includes(sel)), B.cssFor(only('whatsapp_chat')).includes('#view-chats'), blocked('openResidentChat(this.dataset.id)', only('residentes_ver')), blocked('openResidentChat(this.dataset.id)', only('whatsapp_chat')), blocked('sendChatFromInput()', only('residentes_contactar')), B.firstView(only('whatsapp_chat'))], [true, false, true, false, true, false, true, 'chats']);
equal('el listado de propietarios pide el de morosos (y se oculta sin el)', [blocked("selectReport('owners')", only('reportes_morosos')), blocked("selectReport('owners')", only('reportes_ingresos')), B.cssFor(only('reportes_ingresos')).includes('#rep-tab-owners'), B.cssFor(only('reportes_morosos')).includes('#rep-tab-owners'), B.firstReport(only('reportes_morosos'))], [false, true, true, false, 'morosos']);
equal('la impresion de marbetes pide su privilegio, abre Reportes aunque sea el unico y se oculta sin el; las calcomanias piden exportar', [blocked("selectReport('marbetes')", only('reportes_marbetes')), blocked("selectReport('marbetes')", only('reportes_morosos')), B.viewAllowed('reports', only('reportes_marbetes')), B.firstReport(only('reportes_marbetes')), B.cssFor(only('reportes_morosos')).includes('#rep-tab-marbetes'), B.cssFor(only('reportes_marbetes')).includes('#rep-tab-marbetes'), blocked('printMarbeteCards()', only('reportes_marbetes')), blocked('printMarbeteCards()', only('reportes_marbetes', 'reportes_exportar')), B.cssFor(only('reportes_marbetes')).includes('#rep-marbetes-print'), B.cssFor(only('reportes_marbetes', 'reportes_exportar')).includes('#rep-marbetes-print')], [false, true, true, 'marbetes', true, false, true, false, true, false]);
equal('Generar marbete (menu del residente): la ventana pide el reporte de marbetes; imprimir y PDF, exportar; WhatsApp, exportar o contactar; agregar la placa, editar residentes', [
    blocked('openMarbete(this.dataset.id)', only('reportes_marbetes')), blocked('openMarbete(this.dataset.id)', only('residentes_ver')),
    B.cssFor(only('residentes_ver')).includes('button[onclick^="openMarbete("]'), B.cssFor(only('reportes_marbetes')).includes('button[onclick^="openMarbete("]'),
    blocked('printResidentMarbete()', only('reportes_marbetes')), blocked('printResidentMarbete()', only('reportes_exportar')), blocked('downloadResidentMarbetePDF()', only('reportes_marbetes')),
    blocked('sendResidentMarbeteWhatsApp()', only('reportes_marbetes')), blocked('sendResidentMarbeteWhatsApp()', only('residentes_contactar')), blocked('sendResidentMarbeteWhatsApp()', only('reportes_exportar')),
    blocked('marbeteEditPlates(this.dataset.id)', only('reportes_marbetes')), blocked('marbeteEditPlates(this.dataset.id)', only('residentes_editar')),
    ['#mbm-print', '#mbm-pdf', '#mbm-wa', '#mbm-add-plate', '#modal-marbete'].map((sel) => B.cssFor(only('residentes_ver')).includes(sel)),
    ['#mbm-print', '#mbm-pdf', '#mbm-wa'].map((sel) => B.cssFor(only('reportes_marbetes', 'reportes_exportar')).includes(sel))
], [false, true, true, false, true, false, true, true, false, false, true, false, [true, true, true, true, true], [false, false, false]]);
equal('el reporte de ingresos, egresos y saldo por mes pide el del reporte financiero', [blocked("selectReport('month-balance')", only('reportes_resumen')), blocked("selectReport('month-balance')", only('reportes_ingresos', 'reportes_libro')), B.firstReport(only('reportes_resumen'))], [false, true, 'month-balance']);
equal('Imprimir, PDF, Excel y WhatsApp de la pantalla de Reportes piden exportar', ['printCurrentReport()', 'downloadCurrentReportPDF()', 'exportCurrentReportExcel()', 'shareCurrentReportWhatsApp()'].map((a) => [blocked(a, only('reportes_ingresos')), blocked(a, only('reportes_exportar'))]), [[true, false], [true, false], [true, false], [true, false]]);
equal('ver la grafica no pide exportar', [blocked('toggleReportChart()', only('reportes_ingresos')), blocked('toggleSummaryChart()', only('reportes_resumen'))], [false, false]);
equal('el primer reporte permitido', [B.firstReport(only('reportes_gastos', 'reportes_libro')), B.firstReport(none), B.firstReport(all)], ['expense-cat', null, 'income']);

console.log('\nHoja de estilos');
const cssAll = B.cssFor(all);
equal('con todos los privilegios no se oculta nada', cssAll, '');
const cssNone = B.cssFor(none);
equal('sin privilegios se ocultan las cinco pantallas', ['#nav-dashboard', '#nav-residents', '#nav-accounting', '#nav-reports', '#nav-settings'].every((s) => cssNone.includes(s)), true);
equal('sin privilegios se ocultan deshacer y rehacer', ['#btn-undo-header', '#btn-redo-header'].every((s) => cssNone.includes(s)), true);
const cashier = only('tablero_ver', 'residentes_ver', 'residentes_estado', 'contabilidad_ver', 'comprobantes', 'pagos_registrar', 'reportes_morosos');
const cssCashier = B.cssFor(cashier);
equal('un cajero ve el boton de pagos y no el de egresos ni el de cargos', [cssCashier.includes("modal-income"), cssCashier.includes("openModal('modal-expense')"), cssCashier.includes("openModal('modal-bulk-charge')")], [false, true, true]);
equal('un cajero no ve los datos personales ni la configuracion', [cssCashier.includes('#res-dpi'), cssCashier.includes('#nav-settings'), cssCashier.includes('#btn-save-cfg')], [true, true, true]);
equal('un cajero sigue viendo reportes de morosos y no exporta', [cssCashier.includes('#rep-tab-morosos'), cssCashier.includes('printReport()'), cssCashier.includes('#nav-reports')], [false, true, false]);
equal('en la lista de Reportes, cada reporte se oculta sin su privilegio (tambien el reporte financiero)',
    ['#rep-tab-income', '#rep-tab-expense-cat', '#rep-tab-account-statement', '#rep-tab-resumen'].map((s) => cssCashier.includes(s)).concat(B.cssFor(only('reportes_resumen', 'reportes_libro')).includes('#rep-tab-resumen')),
    [true, true, true, true, false]);
equal('sin exportar se ocultan los cuatro botones de la pantalla de Reportes (tambien WhatsApp)',
    ['printCurrentReport()', 'downloadCurrentReportPDF()', 'exportCurrentReportExcel()', 'shareCurrentReportWhatsApp()'].map((f) => cssCashier.includes(`#view-reports button[onclick="${f}"]`)), [true, true, true, true]);
equal('sin el reporte financiero tampoco se ve el de ingresos y egresos por mes', [cssCashier.includes('#rep-tab-month-balance'), B.cssFor(only('reportes_resumen')).includes('#rep-tab-month-balance')], [true, false]);
// Las graficas del tablero (2026-11-18): moverse de mes es parte de ver el tablero; "Ver el reporte" abre el reporte por mes
equal('"Ver el reporte" de las graficas del tablero pide el reporte por mes (se oculta y se bloquea sin el); las flechas no piden nada mas',
    [cssCashier.includes('#dash-months-report'), B.cssFor(only('reportes_resumen')).includes('#dash-months-report'), blocked('openDashMonthReport()', only('tablero_ver')), blocked('openDashMonthReport()', only('tablero_ver', 'reportes_resumen')), blocked('dashMonthsGo(-1)', only('tablero_ver')), blocked('dashMonthsGo(0)', only('tablero_ver'))],
    [true, false, true, false, false, false]);
// Contabilidad sin la lista (2026-11-20): "Ver los movimientos" abre el Estado de cuenta general, que pide reportes_libro
equal('"Ver los movimientos" de Contabilidad pide el Estado de cuenta general (se oculta y se bloquea sin el); el menu del celular no pide nada',
    [B.cssFor(only('contabilidad_ver')).includes('#acc-moves-note button[onclick="openMovementsReport()"]'), B.cssFor(only('contabilidad_ver', 'reportes_libro')).includes('openMovementsReport'), blocked('openMovementsReport()', only('contabilidad_ver')), blocked('openMovementsReport()', only('reportes_libro')), blocked('oikosMenu(true)', only('tablero_ver')), blocked('oikosMenu(false)', only())],
    [true, false, true, false, false, false]);
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
equal('Marcar tipo (lote o casa, en bloque) exige poder editar residentes y su boton se oculta sin eso', [blocked('openBulkType()', only('residentes_editar')), blocked("applyBulkType('lote')", only('residentes_editar')), blocked('openBulkType()', only('residentes_ver')), blocked("applyBulkType('casa')", only('residentes_ver')), B.cssFor(only('residentes_ver')).includes('#res-bulk-type-btn'), B.cssFor(only('residentes_ver', 'residentes_editar')).includes('#res-bulk-type-btn')], [false, false, true, true, true, false]);
equal('Fases por sector exige poder editar residentes y sus botones se ocultan sin eso', [blocked('openAssignFases()', only('residentes_editar')), blocked('applyAssignFases()', only('residentes_editar')), blocked('openAssignFases()', only('residentes_ver')), blocked('applyAssignFases()', only('residentes_ver')), ['#res-assign-fase-btn', '#rem-fase-assign', '#modal-assign-fases'].map((sel) => B.cssFor(only('residentes_ver')).includes(sel)), ['#res-assign-fase-btn', '#rem-fase-assign', '#modal-assign-fases'].map((sel) => B.cssFor(only('residentes_ver', 'residentes_editar')).includes(sel))], [false, false, true, true, [true, true, true], [false, false, false]]);
equal('el saldo del residente en el ingreso es parte del estado de cuenta: se oculta sin ese privilegio', [B.cssFor(only('pagos_registrar')).includes('#inc-balance-box'), B.cssFor(only('pagos_registrar', 'residentes_estado')).includes('#inc-balance-box')], [true, false]);
// Finiquitar y eliminar residentes: solo el administrador y a quien se le marque (pedido del dueno, 2026-11-17)
{
    const todoOp = new Set(['usuarios.ver', 'mensajes.recibir']);
    PRIV.toggle(todoOp, 'finanzas.usar', true, { children: true, role: 'operador' });
    const markedOp = new Set(todoOp);
    ['finanzas.residentes_finiquitar', 'finanzas.residentes_eliminar'].forEach((k) => PRIV.toggle(markedOp, k, true));
    const canAs = (role, set) => { const ov = set ? PRIV.toOverrides(role, set) : {}; return (key) => PRIV.has(role, ov, key); };
    const hides = (can) => { const css = B.cssFor(can); return [css.includes('button[onclick^="openFiniquito("]'), css.includes('button[onclick^="deleteResident("]')]; };
    equal('un operador con todo el Sistema Financiero no ve Finiquitar ni Eliminar en el menu del residente', hides(canAs('operador', todoOp)), [true, true]);
    equal('el administrador si los ve', hides(canAs('admin')), [false, false]);
    equal('un operador al que se le marcaron si los ve', hides(canAs('operador', markedOp)), [false, false]);
    equal('un administrador al que se le quitaron no los ve', hides((key) => PRIV.has('admin', { 'finanzas.residentes_finiquitar': false, 'finanzas.residentes_eliminar': false }, key)), [true, true]);
    equal('y sus acciones se bloquean igual aunque alguien las dispare', [blocked("openFiniquito('u1')", canAs('operador', todoOp)), blocked("deleteResident('u1')", canAs('operador', todoOp)), blocked("openFiniquito('u1')", canAs('admin')), blocked("deleteResident('u1')", canAs('admin'))], [true, true, false, false]);
}
equal('la pestana Detalle por concepto del ingreso (lo que debe, por concepto) tambien se oculta sin el estado de cuenta', ['#inc-tabs', '#inc-pane-detalle'].map((id) => [B.cssFor(only('pagos_registrar')).includes(id), B.cssFor(only('pagos_registrar', 'residentes_estado')).includes(id)]), [[true, false], [true, false]]);
equal('el boton Corregir telefono de No recibieron se oculta sin editar residentes (y su clic tambien se bloquea)', [B.cssFor(only('residentes_contactar')).includes('#rem-rec-list button[onclick^="editResident("]'), B.cssFor(only('residentes_contactar', 'residentes_editar')).includes('#rem-rec-list button[onclick^="editResident("]'), blocked('editResident(this.dataset.id)', only('residentes_contactar'))], [true, false, true]);
equal('Estado de cuenta: el Excel exige exportar; WhatsApp lo puede quien exporta o quien contacta', [blocked('exportEstadoCuentaExcel()', only('reportes_exportar')), blocked('exportEstadoCuentaExcel()', only('residentes_estado')), blocked('exportEstadoCuentaExcel()', only('residentes_contactar')), blocked('shareEstadoCuentaWhatsApp()', only('reportes_exportar')), blocked('shareEstadoCuentaWhatsApp()', only('residentes_contactar')), blocked('shareEstadoCuentaWhatsApp()', only('residentes_estado'))], [false, true, true, false, false, true]);
equal('Estado de cuenta: sin esos privilegios se ocultan sus botones; con contactar solo queda WhatsApp', (() => {
    const wa = '#modal-estado-cuenta button[onclick="shareEstadoCuentaWhatsApp()"]';
    const xl = '#modal-estado-cuenta button[onclick="exportEstadoCuentaExcel()"]';
    const css = (...names) => B.cssFor(only('residentes_estado', ...names));
    return [css().includes(wa), css().includes(xl), css('residentes_contactar').includes(wa), css('residentes_contactar').includes(xl), css('reportes_exportar').includes(wa), css('reportes_exportar').includes(xl)];
})(), [true, true, false, true, false, false]);
// El estado de cuenta desde el pago (boton "Estado de cuenta" del Ingreso y bloque del comprobante; pedido del usuario el 2026-11-18)
equal('Estado de cuenta desde el pago: todo pide ver estados de cuenta y cada salida su privilegio (el mismo de la ventana)', [
    blocked("ecQuickView('inc')", only('residentes_estado')), blocked("ecQuickView('inc')", only('pagos_registrar')), blocked('toggleEcQuickMenu()', only('pagos_registrar')),
    blocked("ecQuickPrint('inc')", only('residentes_estado', 'reportes_exportar')), blocked("ecQuickPrint('inc')", only('residentes_estado')), blocked("ecQuickPDF('voucher')", only('residentes_estado', 'residentes_contactar')), blocked("ecQuickPrint('inc')", only('reportes_exportar')),
    blocked("ecQuickWhatsApp('inc')", only('residentes_estado', 'residentes_contactar')), blocked("ecQuickWhatsApp('voucher')", only('residentes_estado', 'reportes_exportar')), blocked("ecQuickWhatsApp('inc')", only('residentes_estado')), blocked("ecQuickWhatsApp('inc')", only('residentes_contactar'))
], [false, true, true, false, true, true, true, false, false, true, true]);
equal('Estado de cuenta desde el pago: sin ver estados de cuenta no se ve; sin exportar ni contactar solo queda Mostrar', (() => {
    const css = (...names) => B.cssFor(only(...names));
    const has = (c) => ['.ec-quick', 'button[onclick^="ecQuickPrint("]', 'button[onclick^="ecQuickPDF("]', 'button[onclick^="ecQuickWhatsApp("]'].map((sel) => c.includes(sel));
    return [has(css('pagos_registrar')), has(css('residentes_estado')), has(css('residentes_estado', 'residentes_contactar')), has(css('residentes_estado', 'reportes_exportar'))];
})(), [[true, true, true, true], [false, true, true, true], [false, true, true, false], [false, false, false, false]]);
equal('la navegacion y el buscador del formulario del residente solo los ve quien puede editar residentes', [B.cssFor(only('residentes_crear')).includes('#res-nav'), B.cssFor(only('residentes_crear')).includes('#res-jump-wrap'), B.cssFor(only('residentes_editar')).includes('#res-nav'), B.cssFor(only('residentes_editar')).includes('#res-jump-wrap')], [true, true, false, false]);
equal('el precio del agua (paja completa y media paja) tambien queda bloqueado sin config_cuota y libre con ella', [B.cssFor(only('config_ver', 'config_general')).includes('#cfg-water-full'), B.cssFor(only('config_ver', 'config_general')).includes('#cfg-water-half'), B.cssFor(only('config_ver', 'config_cuota')).includes('#cfg-water-full'), B.cssFor(only('config_ver', 'config_cuota')).includes('#cfg-water-half')], [true, true, false, false]);
equal('los campos del precio del agua se deshabilitan igual que el desglose', B.DISABLE.config_cuota.includes('#cfg-water-full') && B.DISABLE.config_cuota.includes('#cfg-water-half'), true);
equal('los campos del desglose se deshabilitan (no se pueden quitar del DOM: saveSettings los lee)', B.DISABLE.config_cuota.includes('#cfg-fee-maintenance') && B.DISABLE.config_cuota.includes('#cfg-fee-other'), true);

// Privilegios de gerente (2026-11-18): cargos, cuotas por mes y corregir duplicadas cuelgan de "Modificar saldos"; la fecha
// del pago se oculta sin su privilegio
equal('sin Modificar saldos no se crean cargos, no se cargan meses ni se corrigen duplicadas (aunque tenga la accion)', ["openModal('modal-bulk-charge')", 'applyBulkCharge()', "openResidentFeeMonths('u1')", 'fixDuplicateFees()'].map((a) => blocked(a, only('cargos_crear', 'cuotas_meses', 'cuotas_corregir'))), [true, true, true, true]);
equal('la fecha del pago solo la ve quien puede cambiarla', [B.cssFor(only('pagos_registrar')).includes('#inc-date-wrap'), B.cssFor(only('pagos_registrar', 'pagos_fecha')).includes('#inc-date-wrap')], [true, false]);
equal('el nombre del residente queda de solo lectura al editar sin usuarios.vecinos_nombre (envuelve editResident y openModal)', /if \(!can\('usuarios\.vecinos_nombre'\)\) \{[\s\S]*?field\.readOnly = locked[\s\S]*?\['editResident', 'openModal'\]\.forEach/.test(require('node:fs').readFileSync(new URL('../finanzas-bloqueo.js', import.meta.url), 'utf8')), true);

console.log('\nDescontar mora y su reporte (pedido del dueno el 2026-11-18)');
equal('la pestana, las casillas y aplicar el descuento piden descontar mora', ["setIncTab('descuento')", 'discToggleAll(true)', 'discToggle(this)', 'discClear()', 'applyMoraDiscount()'].map((a) => [blocked(a, only('mora_descontar')), blocked(a, only('pagos_registrar', 'residentes_estado'))]), [[false, true], [false, true], [false, true], [false, true], [false, true]]);
equal('las otras pestanas del ingreso no lo piden', ["setIncTab('pago')", "setIncTab('detalle')"].map((a) => blocked(a, none)), [false, false]);
equal('el reporte de descuentos pide su privilegio y abre Reportes aunque sea el unico', [blocked("selectReport('mora-discounts')", only('reportes_descuentos')), blocked("selectReport('mora-discounts')", only('reportes_morosos')), B.viewAllowed('reports', only('reportes_descuentos')), B.firstReport(only('reportes_descuentos'))], [false, true, true, 'mora-discounts']);
equal('sin descontar mora se ocultan la pestana y su panel; sin el reporte, su boton y el enlace', [B.cssFor(only('pagos_registrar')).includes('#inc-tab-descuento'), B.cssFor(only('pagos_registrar')).includes('#inc-pane-descuento'), B.cssFor(only('mora_descontar')).includes('#inc-tab-descuento'), B.cssFor(only('mora_descontar')).includes('#rep-tab-mora-discounts'), B.cssFor(only('mora_descontar')).includes('#disc-report-link')], [true, true, false, true, true]);

console.log('\nCobertura del catalogo: ningun privilegio de OIKOS queda sin efecto en pantalla');
const names = PRIV.ITEMS.filter((i) => i.key.startsWith('finanzas.')).map((i) => i.key.slice('finanzas.'.length));
const referenced = new Set();
const collect = (list) => list.forEach((names) => names.forEach((n) => referenced.add(n)));
collect(B.ACTIONS.map(([, n]) => n));
collect(B.HIDE.map(([n]) => n));
collect(B.LOCK.map(([n]) => n));
collect(Object.values(B.VIEWS));
Object.keys(B.DISABLE).forEach((n) => referenced.add(n));
// finanzas.ver y finanzas.usar son el acceso (reglas y pagina); deshacer/etc. salen de las listas anteriores
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
    equal('fiscalizador: no ve botones de escribir ni guardar la configuracion', ["openModal('modal-income')", "openModal('modal-expense')", "openModal('modal-bulk-charge')", "openModal('modal-resident')", 'openFeeRun()', '#btn-save-cfg', '#btn-undo-header'].every((s) => css.includes(s)), true);
    equal('fiscalizador: no ve el DPI ni los recordatorios por WhatsApp', ['#res-dpi', 'openReminders()'].every((s) => css.includes(s)), true);
    equal('fiscalizador: puede ver estado de cuenta, comprobantes y exportar reportes', ['modal-estado-cuenta', 'modal-voucher-options', 'printReport()'].some((s) => css.includes(s)), false);
    equal('fiscalizador: ninguna accion de escribir pasa el bloqueo de clic', ["openModal('modal-income')", "deleteTransaction('x')", 'applyFeeRun()', 'saveSettings()', 'History.undo()'].every((a) => B.checkAttribute(a, fiscal) !== null), true);
}
equal('un administrador (acceso de siempre) no pierde nada en pantalla, salvo cargar cuotas por mes (empieza apagado)', B.cssFor((key) => PRIV.has('admin', {}, key)), '#res-retro-wrap,\n#residents-table-body .dropdown button[onclick^="openResidentFeeMonths("] { display: none !important; }');
equal('con cargar cuotas por mes marcado, el administrador no pierde nada en pantalla', B.cssFor((key) => PRIV.has('admin', { 'finanzas.cuotas_meses': true }, key)), '');
equal('sin cargar cuotas por mes no se abre la ventana de meses ni se marcan meses', ["openResidentFeeMonths('r1')", 'setAllResRetroMonths(true)'].map((a) => B.checkAttribute(a, (key) => PRIV.has('admin', {}, key)) !== null), [true, true]);
equal('un auditor ve las pantallas pero no puede usar el sistema financiero', B.firstView((key) => PRIV.has('auditor', {}, key)), null);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
