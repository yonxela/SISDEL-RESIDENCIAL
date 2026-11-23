/* ═══════════════════════════════════════════════════════════════
   SISDEL - Privilegios dentro del Sistema Financiero (OIKOS)
   ───────────────────────────────────────────────────────────────
   OIKOS (finanzas/index.html) se usa tal cual, sin modificar. Este archivo corre en
   la pagina contenedora (finanzas.html) y, sobre el iframe de OIKOS (mismo origen),
   aplica los privilegios finanzas.* del usuario:

     1. Oculta o deshabilita lo que el usuario no puede usar (hoja de estilos inyectada).
     2. Bloquea, en fase de captura, los clics, envios de formulario y atajos de
        teclado que ejecutarian una accion sin privilegio, y envuelve las pocas
        funciones de OIKOS que escriben sin clic (cuotas automaticas, anular...).
     3. Redirige a la primera pantalla permitida (OIKOS siempre arranca en el tablero).

   IMPORTANTE: esto es ayuda de pantalla, no seguridad. El iframe es del mismo origen
   y desde la consola del navegador se puede saltar. Lo que de verdad se garantiza es
   lo que cambia datos: finanzas-sync.js descarta lo que el usuario no puede escribir
   y firestore.rules lo rechaza (por coleccion, tipo de movimiento y campos). Ocultar
   pantallas de LECTURA (tablero, DPI, reportes...) es solo de pantalla: las reglas
   dejan leer los datos financieros a quien tiene finanzas.ver.

   Las funciones puras (que privilegio exige cada accion, que CSS corresponde) se
   prueban en scripts/test-finanzas-bloqueo.mjs.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelFinanzasBloqueo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PREFIX = 'finanzas.';
    // SISDEL: el reporte financiero (reportes_resumen) tambien abre Reportes: ahi estan el de ingresos, egresos y saldo
    // por mes y el acceso a su ventana
    const REPORT_KEYS = ['reportes_ingresos', 'reportes_morosos', 'reportes_gastos', 'reportes_libro', 'reportes_resumen', 'reportes_descuentos', 'reportes_marbetes'];
    const ANNUL_KEYS = ['pagos_anular', 'egresos_anular', 'cargos_anular', 'mora_descontar'];
    const CONFIG_WRITE_KEYS = ['config_general', 'config_cuota', 'config_conceptos'];

    // Pantallas del menu y el privilegio (basta uno) que abre cada una
    const VIEWS = {
        dashboard: ['tablero_ver'],
        residents: ['residentes_ver'],
        accounting: ['contabilidad_ver'],
        banks: ['bancos_ver'],
        chats: ['whatsapp_chat'],
        reports: REPORT_KEYS,
        settings: ['config_ver']
    };
    const VIEW_ORDER = ['dashboard', 'residents', 'chats', 'accounting', 'banks', 'reports', 'settings'];

    const REPORT_TABS = { income: 'reportes_ingresos', morosos: 'reportes_morosos', 'expense-cat': 'reportes_gastos', 'account-statement': 'reportes_libro', 'month-balance': 'reportes_resumen', 'mora-list': 'reportes_morosos', 'pay-map': 'reportes_morosos', owners: 'reportes_morosos', marbetes: 'reportes_marbetes', 'mora-discounts': 'reportes_descuentos' };
    const REPORT_TAB_ORDER = ['income', 'expense-cat', 'month-balance', 'morosos', 'mora-list', 'pay-map', 'owners', 'marbetes', 'mora-discounts', 'account-statement'];

    // Atributo onclick / onsubmit (cada sentencia) -> privilegios de los que basta UNO.
    const ACTIONS = [
        [/^navigate\('dashboard'\)/, VIEWS.dashboard],
        [/^navigate\('residents'\)/, VIEWS.residents],
        [/^navigate\('accounting'\)/, VIEWS.accounting],
        [/^navigate\('reports'\)/, VIEWS.reports],
        [/^navigate\('settings'\)/, VIEWS.settings],
        [/^History\.(undo|redo)\(/, ['deshacer']],
        [/^(openFeeRun|applyFeeRun)\(/, ['cuotas_mes']],
        [/^(openResidentFeeMonths|toggleResRetro|shiftResRetroYear|setAllResRetroMonths)\(/, ['cuotas_meses']],
        [/^openModal\('modal-resident'\)/, ['residentes_crear']],
        [/^editResident\(/, ['residentes_editar']],
        [/^(openBulkType|applyBulkType|openAssignFases|applyAssignFases)\(/, ['residentes_editar']],
        [/^(openFiniquito|reactivateResident|handleFiniquitoSubmit)\(/, ['residentes_finiquitar']],
        [/^deleteResident\(/, ['residentes_eliminar']],
        [/^openEstadoCuenta\(/, ['residentes_estado']],
        // Chat de WhatsApp con los residentes (la pantalla Chats WhatsApp y el boton del menu de cada residente)
        [/^(openResidentChat|openChat|startChatWith|toggleChatNew|setChatFilter|sendChatFromInput|chatSendFromMine|loadChatHistoryNow)\(/, ['whatsapp_chat']],
        [/^(openReminders|renderRemindersList|setReminderMode|renderReminderPreview|contactWhatsApp|contactSingleWhatsApp|sendReminder|resetReminderMessages|sendRemindersToAll|sendReminderTest|controlRemCampaign|checkRemConnection|reconcileRemCampaign|resendRemCampaign|setRemFase|showRemRecipients|hideRemRecipients|setRemRecTab|renderRemRecipients|contactMyWhatsApp|openContact|contactSetKind|contactResetText|contactTextChanged|contactSendMine|contactSendServer|contactOpenStatement|sendReminderMine|remManualStart|remManualOpen|remManualNext|remManualSkip|remManualStop|remManualClose|remManualSetDest|remTogglePick|remPickAll|remClearPicks|remToggleOnlySelected)\(/, ['residentes_contactar']],
        // Guardar el mensaje de los recordatorios para todos cambia la configuracion del condominio (settings.reminderMessages)
        [/^saveReminderMessages\(/, ['config_general']],
        // Bancos: abrir y editar cuentas, registrar movimientos y transferencias, anular. La cuenta favorita la decide el
        // servidor (solo el administrador, con su codigo); aqui basta con poder abrir cuentas para ver el boton.
        [/^(openBankAccountForm|saveBankAccount)\(/, ['bancos_cuentas']],
        [/^(openBankMovement|saveBankMovement|openBankTransfer|saveBankTransfer)\(/, ['bancos_movimientos']],
        [/^(openBankAnnul|saveBankAnnul)\(/, ['bancos_anular']],
        [/^(openBankFavorite|saveBankFavorite)\(/, ['bancos_cuentas']],
        [/^bankExport\(/, ['reportes_exportar']],
        [/^fixDuplicateFees\(/, ['cuotas_corregir']],
        [/^(openModal\('modal-bulk-charge'\)|applyBulkCharge\()/, ['cargos_crear']],
        // Cargos, cuotas por mes y corregir duplicadas cambian lo que debe un residente: cuelgan de "Modificar saldos de
        // residentes" (privilegio de gerente); sin el, ninguno vale aunque este marcado
        [/^(openModal\('modal-bulk-charge'\)|applyBulkCharge\(|fixDuplicateFees\(|openResidentFeeMonths\(|toggleResRetro\(|setAllResRetroMonths\()/, ['saldos_modificar']],
        [/^(openModal\('modal-income'\)|handleTransactionSubmit\(\s*event\s*,\s*'income'\s*\))/, ['pagos_registrar']],
        [/^(openModal\('modal-expense'\)|handleTransactionSubmit\(\s*event\s*,\s*'expense'\s*\))/, ['egresos_registrar']],
        [/deleteTransaction\(/, ANNUL_KEYS],
        [/^openTxDetail\(/, ['contabilidad_ver', 'residentes_estado', 'reportes_libro', 'reportes_ingresos']],
        [/^(openVoucherOptions|printVoucher|downloadVoucher|viewReceiptImage|downloadReceiptImage)\(/, ['comprobantes']],
        [/^selectReport\('income'\)/, ['reportes_ingresos']],
        [/^selectReport\('morosos'\)/, ['reportes_morosos']],
        [/^selectReport\('mora-list'\)/, ['reportes_morosos']],
        [/^selectReport\('pay-map'\)/, ['reportes_morosos']],
        [/^selectReport\('owners'\)/, ['reportes_morosos']],
        [/^selectReport\('expense-cat'\)/, ['reportes_gastos']],
        [/^selectReport\('account-statement'\)/, ['reportes_libro']],
        // El boton "Ver los movimientos" de Contabilidad abre ese mismo reporte
        [/^openMovementsReport\(/, ['reportes_libro']],
        [/^selectReport\('month-balance'\)/, ['reportes_resumen']],
        // "Ver el reporte" de las graficas del tablero abre ese mismo reporte
        [/^openDashMonthReport\(/, ['reportes_resumen']],
        [/^selectReport\('mora-discounts'\)/, ['reportes_descuentos']],
        // Impresion de marbetes por fase: el reporte y sus filtros; las calcomanias se imprimen con Exportar e imprimir
        [/^selectReport\('marbetes'\)/, ['reportes_marbetes']],
        [/^printMarbeteCards\(/, ['reportes_exportar']],
        // "Generar marbete" del menu de cada residente: la ventana pide el reporte de marbetes; imprimir y PDF, exportar; WhatsApp,
        // exportar o contactar residentes (como el estado de cuenta); "Agregar la placa en su ficha", editar residentes
        [/^openMarbete\(/, ['reportes_marbetes']],
        [/^(printResidentMarbete|downloadResidentMarbetePDF)\(/, ['reportes_exportar']],
        [/^sendResidentMarbeteWhatsApp\(/, ['reportes_exportar', 'residentes_contactar']],
        // Generar codigo boton de panico (menu de cada residente): la tarjeta del QR, su enlace y mandarselo por WhatsApp (el privilegio de
        // contactar residentes)
        [/^(openPanicQr|panicQrSetSize|panicQrSetPaper|panicQrCopyLink|printPanicQr|downloadPanicQrPDF|sendPanicQrWhatsApp|panicDeliveryArm|panicDeliveryCancel|panicDeliveryLoad)\(/, ['residentes_contactar']],
        // Enviar clave de acceso (menu de cada residente): mandar un mensaje al residente; la opcion solo sale si el usuario ve las claves
        // (el puente de claves pide usuarios.codigos) y el servidor lo vuelve a pedir al mandarla desde el numero del condominio
        [/^(openSendCode|sendCodeMine|sendCodeServer|copyCodeMessage)\(/, ['residentes_contactar']],
        [/^marbeteEditPlates\(/, ['residentes_editar']],
        // Descuento de mora (pestana Descontar mora del Ingreso): marcar meses, escribir un total y aplicarlo
        [/^(setIncTab\('descuento'\)|(discToggle|discToggleAll|discClear|applyMoraDiscount)\()/, ['mora_descontar']],
        [/^openMonthIncomes\(/, ['reportes_ingresos']],
        [/^openResidentStatusReport\(/, ['reportes_morosos']],
        [/^(openReportModal|shareReportWhatsApp|setReportMode)\(/, ['reportes_resumen']],
        [/^(printReport|downloadReportPDF|exportReportCSV|exportReportExcel|printCurrentReport|downloadCurrentReportPDF|exportCurrentReportExcel|shareCurrentReportWhatsApp|exportResStatusPDF|exportResStatusExcel|printEstadoCuenta|downloadEstadoCuentaPDF|exportEstadoCuentaExcel|exportCSV)\(/, ['reportes_exportar']],
        // Enviar el estado de cuenta por WhatsApp: lo puede quien exporta o quien contacta a los residentes
        [/^shareEstadoCuentaWhatsApp\(/, ['reportes_exportar', 'residentes_contactar']],
        // El estado de cuenta desde el pago (boton del Ingreso y bloque del comprobante): todo pide ver estados de cuenta y
        // cada salida su privilegio, el mismo de la ventana Estado de cuenta
        [/^(toggleEcQuickMenu|ecQuickView|ecQuickWhatsApp|ecQuickPrint|ecQuickPDF)\(/, ['residentes_estado']],
        [/^(ecQuickPrint|ecQuickPDF)\(/, ['reportes_exportar']],
        [/^ecQuickWhatsApp\(/, ['reportes_exportar', 'residentes_contactar']],
        [/^saveSettings\(/, CONFIG_WRITE_KEYS],
        [/^setFeeMode\(/, ['config_cuota']],
        [/^(addCustomConcept|removeCustomConcept)\(/, ['config_conceptos']],
        // "Crear nueva categoria" del Gasto: las reglas dejan agregar a customExpenseConcepts a quien registra egresos o
        // a quien edita los conceptos (basta uno)
        [/^(openNewExpCategory|saveNewExpCategory|closeNewExpCategory)\(/, ['egresos_registrar', 'config_conceptos']],
    ];

    // Privilegios (basta uno) que dejan ver un bloque; sin ninguno se oculta con estos selectores.
    const HIDE = [
        [VIEWS.dashboard, ['#nav-dashboard', '#view-dashboard']],
        [VIEWS.residents, ['#nav-residents', '#view-residents']],
        [VIEWS.accounting, ['#nav-accounting', '#view-accounting']],
        [VIEWS.banks, ['#nav-banks', '#view-banks']],
        [VIEWS.chats, ['#nav-chats', '#view-chats', '#residents-table-body .dropdown button[onclick^="openResidentChat("]']],
        [VIEWS.reports, ['#nav-reports', '#view-reports']],
        [VIEWS.settings, ['#nav-settings', '#view-settings']],
        [['deshacer'], ['#btn-undo-header', '#btn-redo-header']],
        [['residentes_datos'], [
            '#view-residents thead th:nth-child(3)', '#residents-table-body td:nth-child(3)',
            '#view-residents thead th:nth-child(5)', '#residents-table-body td:nth-child(5)',
            'div:has(> #res-dpi)', 'div:has(> #res-lot)', 'div:has(> #res-notes)',
            // Pestana Propietario del formulario de residente (nombre del dueno, NIT, direccion, DPI, observaciones)
            '#res-tab-owner', '#form-resident [data-res-pane="owner"]'
        ]],
        [['residentes_estado'], ['#residents-table-body .dropdown button[onclick^="openEstadoCuenta("]', '#modal-estado-cuenta', '#inc-balance-box', '#inc-tabs', '#inc-pane-detalle', '.ec-quick']],
        [['residentes_crear'], ['#view-residents button[onclick="openModal(\'modal-resident\')"]']],
        [['residentes_editar'], ['#residents-table-body button[onclick^="editResident("]', '#res-nav', '#res-jump-wrap', '#res-bulk-type-btn', '#modal-bulk-type', '#res-assign-fase-btn', '#rem-fase-assign', '#modal-assign-fases', '#rem-rec-list button[onclick^="editResident("]']],
        [['cuotas_meses'], ['#res-retro-wrap', '#residents-table-body .dropdown button[onclick^="openResidentFeeMonths("]']],
        [['residentes_finiquitar'], ['#residents-table-body .dropdown button[onclick^="openFiniquito("]', '#residents-table-body .dropdown button[onclick^="reactivateResident("]', '#modal-finiquito']],
        [['residentes_eliminar'], ['#residents-table-body .dropdown button[onclick^="deleteResident("]']],
        [['residentes_contactar'], ['#view-residents button[onclick="openReminders()"]', '#residents-table-body .dropdown button[onclick^="contactWhatsApp("]', '#residents-table-body .dropdown button[onclick^="contactMyWhatsApp("]', '#residents-table-body .dropdown button[onclick^="openPanicQr("]', '#modal-panico-qr', '#residents-table-body .dropdown button[onclick^="openSendCode("]', '#modal-clave', '#modal-reminders', '#modal-contact']],
        [['cuotas_mes'], ['#view-residents button[onclick="openFeeRun()"]', '#modal-fee-run']],
        [['cuotas_corregir'], ['.dup-fee-banner button[onclick="fixDuplicateFees()"]']],
        [['cargos_crear'], ['#view-accounting button[onclick="openModal(\'modal-bulk-charge\')"]', '#modal-bulk-charge']],
        [['pagos_registrar'], ['#view-accounting button[onclick="openModal(\'modal-income\')"]', '#modal-income']],
        // La fecha del pago (privilegio de gerente): sin el, el pago queda con la fecha y la hora en que se registra
        [['pagos_fecha'], ['#inc-date-wrap']],
        [['egresos_registrar'], ['#view-accounting button[onclick="openModal(\'modal-expense\')"]', '#modal-expense']],
        [ANNUL_KEYS, ['#tx-detail-footer button[onclick*="deleteTransaction("]', '#ec-table-body button[onclick*="deleteTransaction("]']],
        [['contabilidad_ver'], ['#view-accounting > div:has(#accounting-table-body)', '#filter-all', '#filter-income', '#filter-expense']],
        [['comprobantes'], [
            '#tx-detail-footer button[onclick*="openVoucherOptions("]', '#modal-voucher-options', '#btn-voucher-print', '#btn-voucher-download',
            '#modal-receipt-viewer button[onclick="downloadReceiptImage()"]', '#tx-detail-body img[onclick^="viewReceiptImage("]'
        ]],
        [['reportes_ingresos'], ['#rep-tab-income']],
        [['reportes_morosos'], [
            '#rep-tab-morosos', '#rep-tab-mora-list', '#rep-tab-pay-map', '#rep-tab-owners', '#view-residents button[onclick="openResidentStatusReport(\'aldia\')"]',
            '#view-residents button[onclick="openResidentStatusReport(\'morosos\')"]', '#modal-res-status'
        ]],
        [['reportes_gastos'], ['#rep-tab-expense-cat']],
        [['reportes_libro'], ['#rep-tab-account-statement', '#acc-moves-note button[onclick="openMovementsReport()"]']],
        [['reportes_descuentos'], ['#rep-tab-mora-discounts', '#disc-report-link']],
        [['reportes_marbetes'], ['#rep-tab-marbetes', 'button[onclick^="openMarbete("]', '#modal-marbete']],
        [['reportes_exportar'], ['#mbm-print', '#mbm-pdf']],
        [['reportes_exportar', 'residentes_contactar'], ['#mbm-wa']],
        [['residentes_editar'], ['#mbm-add-plate']],
        [['mora_descontar'], ['#inc-tab-descuento', '#inc-pane-descuento']],
        [['reportes_resumen'], ['#rep-tab-resumen', '#rep-tab-month-balance', '#modal-report', '#btn-rep-share', '#dash-months-report']],
        [['reportes_exportar'], [
            '#view-reports button[onclick="printCurrentReport()"]', '#view-reports button[onclick="downloadCurrentReportPDF()"]',
            '#view-reports button[onclick="exportCurrentReportExcel()"]', '#view-reports button[onclick="shareCurrentReportWhatsApp()"]',
            '#modal-report button[onclick="downloadReportPDF()"]', '#modal-report button[onclick="exportReportExcel()"]', '#modal-report button[onclick="printReport()"]',
            '#modal-res-status button[onclick="exportResStatusPDF()"]', '#modal-res-status button[onclick="exportResStatusExcel()"]',
            '#modal-estado-cuenta button[onclick="printEstadoCuenta()"]', '#modal-estado-cuenta button[onclick="downloadEstadoCuentaPDF()"]', '#modal-estado-cuenta button[onclick="exportEstadoCuentaExcel()"]',
            'button[onclick^="ecQuickPrint("]', 'button[onclick^="ecQuickPDF("]',
            '#rep-marbetes-print',
            '#btn-export', 'button[onclick="exportCSV()"]'
        ]],
        [['reportes_exportar', 'residentes_contactar'], ['#modal-estado-cuenta button[onclick="shareEstadoCuentaWhatsApp()"]', 'button[onclick^="ecQuickWhatsApp("]']],
        [['config_conceptos'], ['#view-settings div:has(> #lbl-set-concepts)']],
        [CONFIG_WRITE_KEYS, ['#btn-save-cfg']],
        [['config_general'], ['#rem-msg-save']],
        [['bancos_ver'], ['#dash-bank']],
        [['bancos_cuentas'], ['#btn-bank-new', '#btn-bank-edit', '#btn-bank-favorite', '#modal-bank-account', '#modal-bank-favorite']],
        [['bancos_movimientos'], ['#btn-bank-move', '#btn-bank-transfer', '#modal-bank-move', '#modal-bank-transfer']],
        [['bancos_anular'], ['#bank-rows button[onclick^="openBankAnnul("]', '#modal-bank-annul']],
        [['reportes_exportar'], ['#view-banks button[onclick^="bankExport("]']]
    ];

    // Lo que no se oculta pero tampoco debe tocarse (el nombre del residente abre su estado de cuenta, etc.)
    const LOCK = [
        [['residentes_estado'], ['#residents-table-body button[onclick^="openEstadoCuenta("]', '#rep-tbody tr[onclick^="openEstadoCuenta("]']],
        [['config_general'], ['#cfg-name', '#cfg-lang', '#cfg-curr', '#cfg-theme']],
        [['config_cuota'], ['#cfg-fee', '#cfg-fee-maintenance', '#cfg-fee-water', '#cfg-fee-garbage', '#cfg-fee-electricity', '#cfg-fee-other', '#cfg-water-full', '#cfg-water-half', '#cfg-day', '#cfg-grace', '#cfg-feemode-auto', '#cfg-feemode-manual']],
        [['config_conceptos'], ['#new-inc-concept', '#new-exp-concept']]
    ];
    // Campos que ademas se deshabilitan (el boton de guardar de OIKOS lee sus valores: no se pueden quitar del DOM)
    const DISABLE = {
        config_general: ['#cfg-name', '#cfg-lang', '#cfg-curr', '#cfg-theme'],
        config_cuota: ['#cfg-fee', '#cfg-fee-maintenance', '#cfg-fee-water', '#cfg-fee-garbage', '#cfg-fee-electricity', '#cfg-fee-other', '#cfg-water-full', '#cfg-water-half', '#cfg-day', '#cfg-grace']
    };

    const hasAny = (can, names) => names.some((n) => can(PREFIX + n));

    // Sentencias de un atributo onclick/onsubmit: "event.stopPropagation(); deleteTransaction('x')" -> dos
    function statementsOf(attr) {
        return String(attr || '').split(';').map((s) => s.trim()).filter(Boolean);
    }

    // Privilegios que exige un atributo: lista de listas (de cada una basta una); [] si no exige ninguno
    function requiredKeys(attr) {
        const needs = [];
        statementsOf(attr).forEach((statement) => {
            ACTIONS.forEach(([pattern, names]) => { if (pattern.test(statement)) needs.push(names); });
        });
        return needs;
    }

    // ¿Puede el usuario ejecutar este atributo? Devuelve null si si; si no, los privilegios que le faltan
    function checkAttribute(attr, can) {
        const missing = requiredKeys(attr).find((names) => !hasAny(can, names));
        return missing || null;
    }

    function viewAllowed(view, can) { return !VIEWS[view] || hasAny(can, VIEWS[view]); }
    function firstView(can) { return VIEW_ORDER.find((v) => viewAllowed(v, can)) || null; }
    function reportAllowed(tab, can) { return !REPORT_TABS[tab] || can(PREFIX + REPORT_TABS[tab]); }
    function firstReport(can) { return REPORT_TAB_ORDER.find((t) => reportAllowed(t, can)) || null; }

    // Hoja de estilos con lo que el usuario no puede usar
    function cssFor(can) {
        const rules = [];
        HIDE.forEach(([names, selectors]) => {
            if (!hasAny(can, names)) rules.push(selectors.map((s) => s).join(',\n') + ' { display: none !important; }');
        });
        LOCK.forEach(([names, selectors]) => {
            if (!hasAny(can, names)) rules.push(selectors.join(',\n') + ' { pointer-events: none !important; }');
        });
        LOCK.forEach(([names, selectors]) => {
            if (!hasAny(can, names) && names[0].startsWith('config_')) rules.push(selectors.join(',\n') + ' { opacity: 0.55 !important; }');
        });
        // Sin "residentes_estado" el nombre del residente deja de verse como enlace
        if (!hasAny(can, ['residentes_estado'])) rules.push('#residents-table-body button[onclick^="openEstadoCuenta("] { text-decoration: none !important; cursor: default !important; }');
        return rules.join('\n');
    }

    // Todo lo anterior mas lo que depende de la pagina viva
    function install(win, can, options = {}) {
        const doc = win.document;
        const notify = options.notify || ((message) => { try { win.showToast ? win.showToast(message) : win.alert(message); } catch (e) { /* ignorar */ } });
        const DENIED = 'Su usuario no tiene el privilegio para hacer esto.';
        const deny = () => notify(DENIED);

        // 1. Estilos
        let style = doc.getElementById('sisdel-privilegios');
        if (!style) { style = doc.createElement('style'); style.id = 'sisdel-privilegios'; doc.head.appendChild(style); }
        // (el nombre bloqueado de un residente se ve atenuado: ver "Nombre del residente" abajo)
        style.textContent = cssFor(can) + '\n#res-name.sisdel-name-locked { opacity: 0.7 !important; cursor: not-allowed !important; }';

        // 2. Campos de configuracion sin permiso
        Object.entries(DISABLE).forEach(([name, selectors]) => {
            if (can(PREFIX + name)) return;
            selectors.forEach((selector) => doc.querySelectorAll(selector).forEach((el) => { el.disabled = true; }));
        });

        // 3. Clics y envios en fase de captura: corren antes que los onclick/onsubmit de OIKOS
        function blockedBy(element) {
            // Los ancestros con onclick tambien se ejecutarian al burbujear, salvo que uno detenga la propagacion
            for (let el = element; el && el.nodeType === 1; el = el.parentElement) {
                const attr = el.getAttribute && el.getAttribute('onclick');
                if (!attr) continue;
                const missing = checkAttribute(attr, can);
                if (missing) return missing;
                if (/stopPropagation\(\)/.test(attr)) return null;
            }
            return null;
        }
        doc.addEventListener('click', (event) => {
            const missing = blockedBy(event.target);
            if (!missing) return;
            event.stopPropagation();
            event.preventDefault();
            deny();
        }, true);
        doc.addEventListener('submit', (event) => {
            const form = event.target && event.target.closest && event.target.closest('form[onsubmit]');
            if (!form) return;
            let missing = checkAttribute(form.getAttribute('onsubmit'), can);
            if (!missing && /^handleResidentSubmit\(/.test(form.getAttribute('onsubmit').trim())) {
                const editing = win.eval('typeof residentBeingEditedId !== "undefined" && residentBeingEditedId !== null');
                const key = editing ? 'residentes_editar' : 'residentes_crear';
                if (!can(PREFIX + key)) missing = [key];
            }
            if (!missing) return;
            event.stopPropagation();
            event.preventDefault();
            deny();
        }, true);

        // 4. Deshacer / rehacer con el teclado
        win.addEventListener('keydown', (event) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            const key = String(event.key || '').toLowerCase();
            if (key !== 'z' && key !== 'y') return;
            const tag = event.target && event.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (can(PREFIX + 'deshacer')) return;
            event.stopImmediatePropagation();
            event.preventDefault();
        }, true);

        // 5. Funciones de OIKOS: se reemplazan por una que revisa antes de actuar
        function wrap(name, guard) {
            const original = win[name];
            if (typeof original !== 'function') return;
            win[name] = function sisdelGuarded(...args) {
                const result = guard(args);
                if (result === false) return undefined;
                if (result && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
                return original.apply(this, args);
            };
        }
        // OIKOS arranca siempre en el tablero: sin ese privilegio se lleva a la primera pantalla permitida
        wrap('navigate', (args) => {
            if (viewAllowed(args[0], can)) return true;
            const next = firstView(can);
            if (next) args[0] = next; else return { value: undefined };
            return true;
        });
        wrap('selectReport', (args) => {
            if (reportAllowed(args[0], can)) return true;
            const next = firstReport(can);
            if (next) args[0] = next; else return { value: undefined };
            return true;
        });
        // Anular: el tipo de movimiento decide el privilegio
        wrap('deleteTransaction', (args) => {
            let type = null;
            try {
                const tx = win.eval('Store').getRaw('transactions').find((t) => t && String(t.id) === String(args[0]));
                type = tx && tx.type;
            } catch (e) { /* ignorar */ }
            const key = type === 'income' ? 'pagos_anular' : type === 'expense' ? 'egresos_anular' : type === 'mora_discount' ? 'mora_descontar' : 'cargos_anular';
            if (can(PREFIX + key)) return true;
            deny();
            return false;
        });
        // Nombre del residente: solo lo cambia quien tiene "Cambiar el nombre de los residentes" (privilegio de gerente,
        // usuarios.vecinos_nombre; no es finanzas.*). Al editar a uno que ya existe el campo queda de solo lectura; al
        // registrar uno nuevo se escribe. finanzas-sync.js y las reglas tambien lo exigen.
        if (!can('usuarios.vecinos_nombre')) {
            const NAME_LOCKED = 'Su usuario no tiene el privilegio para cambiar el nombre de un residente.';
            const lockName = (locked) => {
                const field = doc.getElementById('res-name');
                if (!field) return;
                field.readOnly = locked;
                field.title = locked ? NAME_LOCKED : '';
                field.classList.toggle('sisdel-name-locked', locked);
            };
            const editing = () => { try { return win.eval('typeof residentBeingEditedId !== "undefined" && residentBeingEditedId !== null'); } catch (e) { return false; } };
            ['editResident', 'openModal'].forEach((name) => {
                const original = win[name];
                if (typeof original !== 'function') return;
                win[name] = function sisdelNameLock(...args) {
                    const result = original.apply(this, args);
                    if (name === 'editResident' || args[0] === 'modal-resident') lockName(editing());
                    return result;
                };
            });
        }
        // Cuotas por mes de un residente y cuotas automaticas: silenciosas (no son una accion del usuario)
        wrap('applyRetroactiveChargesToResident', () => (can(PREFIX + 'cuotas_meses') ? true : { value: 0 }));
        wrap('checkMonthlyFees', () => (can(PREFIX + 'cuotas_mes') ? true : false));
        wrap('saveSettings', () => {
            if (hasAny(can, CONFIG_WRITE_KEYS)) return true;
            deny();
            return false;
        });
        try {
            const history = win.eval('History');
            ['undo', 'redo'].forEach((method) => {
                const original = history[method];
                if (typeof original !== 'function') return;
                history[method] = function sisdelGuarded(...args) {
                    if (!can(PREFIX + 'deshacer')) { deny(); return undefined; }
                    return original.apply(this, args);
                };
            });
        } catch (e) { /* OIKOS cambio: la hoja y la captura siguen protegiendo la pantalla */ }

        // 6. Pantalla de inicio permitida (o aviso si no tiene ninguna)
        const first = firstView(can);
        if (first) {
            if (typeof win.navigate === 'function') win.navigate(first === 'dashboard' ? 'dashboard' : first);
        } else {
            const notice = doc.createElement('div');
            notice.id = 'sisdel-sin-pantallas';
            notice.setAttribute('style', 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#334155;font:600 16px sans-serif;text-align:center;padding:24px');
            notice.textContent = 'Su usuario no tiene pantallas del Sistema Financiero asignadas. Pida al administrador que le asigne privilegios.';
            doc.body.appendChild(notice);
        }
        return { firstView: first };
    }

    return {
        install,
        internals: {
            ACTIONS, HIDE, LOCK, DISABLE, VIEWS, VIEW_ORDER, REPORT_TABS,
            requiredKeys, checkAttribute, viewAllowed, firstView, reportAllowed, firstReport, cssFor, statementsOf
        }
    };
});
