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
    const REPORT_KEYS = ['reportes_ingresos', 'reportes_morosos', 'reportes_gastos', 'reportes_libro'];
    const ANNUL_KEYS = ['pagos_anular', 'egresos_anular', 'cargos_anular'];
    const CONFIG_WRITE_KEYS = ['config_general', 'config_cuota', 'config_conceptos'];

    // Pantallas del menu y el privilegio (basta uno) que abre cada una
    const VIEWS = {
        dashboard: ['tablero_ver'],
        residents: ['residentes_ver'],
        accounting: ['contabilidad_ver'],
        reports: REPORT_KEYS,
        settings: ['config_ver']
    };
    const VIEW_ORDER = ['dashboard', 'residents', 'accounting', 'reports', 'settings'];

    const REPORT_TABS = { income: 'reportes_ingresos', morosos: 'reportes_morosos', 'expense-cat': 'reportes_gastos', 'account-statement': 'reportes_libro' };
    const REPORT_TAB_ORDER = ['income', 'morosos', 'expense-cat', 'account-statement'];

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
        [/^(openFiniquito|reactivateResident|handleFiniquitoSubmit)\(/, ['residentes_finiquitar']],
        [/^deleteResident\(/, ['residentes_eliminar']],
        [/^openEstadoCuenta\(/, ['residentes_estado']],
        [/^(openReminders|renderRemindersList|contactWhatsApp|contactSingleWhatsApp)\(/, ['residentes_contactar']],
        [/^fixDuplicateFees\(/, ['cuotas_corregir']],
        [/^(openModal\('modal-bulk-charge'\)|applyBulkCharge\()/, ['cargos_crear']],
        [/^(openModal\('modal-income'\)|handleTransactionSubmit\(\s*event\s*,\s*'income'\s*\))/, ['pagos_registrar']],
        [/^(openModal\('modal-expense'\)|handleTransactionSubmit\(\s*event\s*,\s*'expense'\s*\))/, ['egresos_registrar']],
        [/deleteTransaction\(/, ANNUL_KEYS],
        [/^openTxDetail\(/, ['contabilidad_ver', 'residentes_estado', 'reportes_libro', 'reportes_ingresos']],
        [/^(openVoucherOptions|printVoucher|downloadVoucher|viewReceiptImage|downloadReceiptImage)\(/, ['comprobantes']],
        [/^selectReport\('income'\)/, ['reportes_ingresos']],
        [/^selectReport\('morosos'\)/, ['reportes_morosos']],
        [/^selectReport\('expense-cat'\)/, ['reportes_gastos']],
        [/^selectReport\('account-statement'\)/, ['reportes_libro']],
        [/^openMonthIncomes\(/, ['reportes_ingresos']],
        [/^openResidentStatusReport\(/, ['reportes_morosos']],
        [/^(openReportModal|shareReportWhatsApp|setReportMode)\(/, ['reportes_resumen']],
        [/^(printReport|downloadReportPDF|exportReportCSV|exportReportExcel|exportResStatusPDF|exportResStatusExcel|printEstadoCuenta|downloadEstadoCuentaPDF|exportCSV|exportToPDF)\(/, ['reportes_exportar']],
        [/^saveSettings\(/, CONFIG_WRITE_KEYS],
        [/^setFeeMode\(/, ['config_cuota']],
        [/^(addCustomConcept|removeCustomConcept)\(/, ['config_conceptos']],
        [/^clearDB\(/, ['limpiar']]
    ];

    // Privilegios (basta uno) que dejan ver un bloque; sin ninguno se oculta con estos selectores.
    const HIDE = [
        [VIEWS.dashboard, ['#nav-dashboard', '#view-dashboard']],
        [VIEWS.residents, ['#nav-residents', '#view-residents']],
        [VIEWS.accounting, ['#nav-accounting', '#view-accounting']],
        [VIEWS.reports, ['#nav-reports', '#view-reports']],
        [VIEWS.settings, ['#nav-settings', '#view-settings']],
        [['deshacer'], ['#btn-undo-header', '#btn-redo-header']],
        [['residentes_datos'], [
            '#view-residents thead th:nth-child(3)', '#residents-table-body td:nth-child(3)',
            '#view-residents thead th:nth-child(5)', '#residents-table-body td:nth-child(5)',
            'div:has(> #res-dpi)', 'div:has(> #res-lot)', 'div:has(> #res-notes)'
        ]],
        [['residentes_estado'], ['#residents-table-body .dropdown button[onclick^="openEstadoCuenta("]', '#modal-estado-cuenta']],
        [['residentes_crear'], ['#view-residents button[onclick="openModal(\'modal-resident\')"]']],
        [['residentes_editar'], ['#residents-table-body button[onclick^="editResident("]']],
        [['cuotas_meses'], ['#res-retro-wrap', '#residents-table-body .dropdown button[onclick^="openResidentFeeMonths("]']],
        [['residentes_finiquitar'], ['#residents-table-body .dropdown button[onclick^="openFiniquito("]', '#residents-table-body .dropdown button[onclick^="reactivateResident("]', '#modal-finiquito']],
        [['residentes_eliminar'], ['#residents-table-body .dropdown button[onclick^="deleteResident("]']],
        [['residentes_contactar'], ['#view-residents button[onclick="openReminders()"]', '#residents-table-body .dropdown button[onclick^="contactWhatsApp("]', '#modal-reminders']],
        [['cuotas_mes'], ['#view-residents button[onclick="openFeeRun()"]', '#modal-fee-run']],
        [['cuotas_corregir'], ['.dup-fee-banner button[onclick="fixDuplicateFees()"]']],
        [['cargos_crear'], ['#view-accounting button[onclick="openModal(\'modal-bulk-charge\')"]', '#modal-bulk-charge']],
        [['pagos_registrar'], ['#view-accounting button[onclick="openModal(\'modal-income\')"]', '#modal-income']],
        [['egresos_registrar'], ['#view-accounting button[onclick="openModal(\'modal-expense\')"]', '#modal-expense']],
        [ANNUL_KEYS, ['#tx-detail-footer button[onclick*="deleteTransaction("]', '#ec-table-body button[onclick*="deleteTransaction("]']],
        [['contabilidad_ver'], ['#view-accounting > div:has(#accounting-table-body)', '#filter-all', '#filter-income', '#filter-expense']],
        [['comprobantes'], [
            '#tx-detail-footer button[onclick*="openVoucherOptions("]', '#modal-voucher-options', '#btn-voucher-print', '#btn-voucher-download',
            '#modal-receipt-viewer button[onclick="downloadReceiptImage()"]', '#tx-detail-body img[onclick^="viewReceiptImage("]'
        ]],
        [['reportes_ingresos'], ['#rep-tab-income']],
        [['reportes_morosos'], [
            '#rep-tab-morosos', '#view-residents button[onclick="openResidentStatusReport(\'aldia\')"]',
            '#view-residents button[onclick="openResidentStatusReport(\'morosos\')"]', '#modal-res-status'
        ]],
        [['reportes_gastos'], ['#rep-tab-expense-cat']],
        [['reportes_libro'], ['#rep-tab-account-statement']],
        [['reportes_resumen'], ['#view-accounting button[onclick="openReportModal()"]', '#modal-report', '#btn-rep-share']],
        [['reportes_exportar'], [
            '#view-reports button[onclick="printReport()"]', '#view-reports button[onclick="downloadReportPDF()"]', '#view-reports button[onclick="exportReportCSV()"]',
            '#modal-report button[onclick="downloadReportPDF()"]', '#modal-report button[onclick="exportReportExcel()"]', '#modal-report button[onclick="printReport()"]',
            '#modal-res-status button[onclick="exportResStatusPDF()"]', '#modal-res-status button[onclick="exportResStatusExcel()"]',
            '#modal-estado-cuenta button[onclick="printEstadoCuenta()"]', '#modal-estado-cuenta button[onclick="downloadEstadoCuentaPDF()"]',
            '#btn-export', 'button[onclick="exportCSV()"]', '#view-accounting button[onclick="exportToPDF()"]'
        ]],
        [['config_conceptos'], ['#view-settings div:has(> #lbl-set-concepts)']],
        [['limpiar'], ['#btn-clear']],
        [CONFIG_WRITE_KEYS, ['#btn-save-cfg']]
    ];

    // Lo que no se oculta pero tampoco debe tocarse (el nombre del residente abre su estado de cuenta, etc.)
    const LOCK = [
        [['residentes_estado'], ['#residents-table-body button[onclick^="openEstadoCuenta("]', '#rep-tbody tr[onclick^="openEstadoCuenta("]']],
        [['residentes_contactar'], ['#dash-debt-alert']],
        [['config_general'], ['#cfg-name', '#cfg-lang', '#cfg-curr', '#cfg-theme']],
        [['config_cuota'], ['#cfg-fee', '#cfg-day', '#cfg-grace', '#cfg-feemode-auto', '#cfg-feemode-manual']],
        [['config_conceptos'], ['#new-inc-concept', '#new-exp-concept']]
    ];
    // Campos que ademas se deshabilitan (el boton de guardar de OIKOS lee sus valores: no se pueden quitar del DOM)
    const DISABLE = {
        config_general: ['#cfg-name', '#cfg-lang', '#cfg-curr', '#cfg-theme'],
        config_cuota: ['#cfg-fee', '#cfg-day', '#cfg-grace']
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
        style.textContent = cssFor(can);

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
            const key = type === 'income' ? 'pagos_anular' : type === 'expense' ? 'egresos_anular' : 'cargos_anular';
            if (can(PREFIX + key)) return true;
            deny();
            return false;
        });
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
