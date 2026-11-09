/* ═══════════════════════════════════════════════════════════════
   SISDEL - Panel de Reportes del administrador (admin.html, boton "Reportes")
   ───────────────────────────────────────────────────────────────
   Un solo lugar para los reportes del condominio:
   - Garita: ingresos y salidas de vecinos y de visitas por periodo, visitas dentro, horas pico, placas y visitas por casa
     (se construye aqui con los datos de camera_logs, visitas y salidas).
   - Morosos: el listado de vecinos en mora a la fecha.
   - Finanzas: accesos directos a los reportes de OIKOS (ingresos, gastos, morosos con meses adeudados, estado de cuenta y
     reporte financiero). La contabilidad no se vuelve a calcular aqui: asi las cifras son siempre las de OIKOS.
   - Rondas: acceso directo al panel y al reporte semanal de RONDIN.

   Cada seccion pide su privilegio (reportes.*) y los de lectura de los datos que muestra. Exportar a CSV e imprimir son
   el privilegio reportes.exportar. Requiere privilegios.js, sisdel-core.js y styles.css.
   ═══════════════════════════════════════════════════════════════ */

const SisdelReportes = (() => {
    const MAX_LOGS = 5000;
    const MAX_DAYS = 366;
    const SHOWN_ROWS = 150;

    // Reportes de OIKOS a los que se llega desde aqui (la clave de cada uno es su privilegio en Finanzas)
    const FIN_REPORTS = [
        { id: 'income', key: 'finanzas.reportes_ingresos', title: 'Ingresos por período', text: 'Lo cobrado cada mes (cuotas, cargos y otros ingresos) con el detalle de cada pago.' },
        { id: 'expense-cat', key: 'finanzas.reportes_gastos', title: 'Gastos por período y categoría', text: 'En qué se gasta el dinero del condominio en el período que elija.' },
        { id: 'morosos', key: 'finanzas.reportes_morosos', title: 'Morosos y meses adeudados', text: 'Cada residente en mora con los meses que debe y el total; también la lista de los que están al día.' },
        { id: 'account-statement', key: 'finanzas.reportes_libro', title: 'Estado de cuenta general', text: 'El libro de ingresos y egresos con el saldo acumulado y el saldo anterior al período.' },
        { id: 'resumen', key: 'finanzas.reportes_resumen', title: 'Reporte financiero mensual o por período', text: 'Ingresos netos, gastos y balance, con el resumen listo para enviar por WhatsApp.' }
    ];

    const SECTIONS = [
        { id: 'garita', label: 'Garita', allowed: (can) => can('reportes.garita') && can('usuarios.ver') && can('visitas.ver') && can('garita.camara') },
        { id: 'morosos', label: 'Morosos', allowed: (can) => can('reportes.morosos') && can('usuarios.ver') && can('usuarios.pagos_ver') },
        { id: 'finanzas', label: 'Finanzas', allowed: (can) => can('reportes.finanzas') && can('finanzas.usar') && FIN_REPORTS.some((r) => can(r.key)) },
        { id: 'rondas', label: 'Rondas', allowed: (can) => can('reportes.rondas') && can('rondas.panel_ver') }
    ];

    const ICONS = {
        download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        print: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
        open: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
    };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const parseYmd = (text) => { const [y, m, d] = String(text).split('-').map(Number); return new Date(y, m - 1, d); };
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    // SISDEL es una constante global de sisdel-core.js (no cuelga de window)
    const sisdel = () => (typeof SISDEL !== 'undefined' ? SISDEL : window.SISDEL);
    const today = () => parseYmd(sisdel().localToday());
    const longDate = (text) => parseYmd(text).toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' });
    const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('es-GT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' }) : '');
    // Fecha y hora ordenable para los CSV
    const stamp = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    function stay(visit) {
        if (!visit.enteredAt || !visit.exitedAt || visit.exitedAt < visit.enteredAt) return '';
        const minutes = Math.round((new Date(visit.exitedAt) - new Date(visit.enteredAt)) / 60000);
        return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min` : `${minutes} min`;
    }

    // CSV para Excel: UTF-8 con BOM. Las celdas que empiezan con = + - @ no se interpretan como formulas
    function csvCell(value) {
        let text = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text)) text = "'" + text;
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }
    function downloadCsv(filename, header, rows) {
        const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // De donde viene cada lectura de la camara o de la garita: visita, vecino o placa que no esta registrada
    function logKind(log) {
        if (/^visita/i.test(log.reason || '')) return 'visita';
        if (log.status === 'Error' || /^placa no registrada/i.test(log.reason || '')) return 'desconocido';
        return 'vecino';
    }
    const isAllowed = (log) => log.status === 'Authorized' || log.status === 'Reminder';

    function countBy(items, keyOf) {
        const map = new Map();
        items.forEach((item) => { const key = keyOf(item); if (key) map.set(key, (map.get(key) || 0) + 1); });
        return map;
    }
    function table(headers, rows, numericCols = []) {
        if (!rows.length) return '<p class="text-sm text-muted">Sin datos en el período.</p>';
        const th = headers.map((h, i) => `<th class="${numericCols.includes(i) ? 'num' : ''}">${esc(h)}</th>`).join('');
        const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numericCols.includes(i) ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('');
        return `<div class="rp-wrap"><table class="rp-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    const kpi = (label, value, color) => `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value" style="color:${color}">${esc(value)}</div></div>`;
    const note = (text, warn) => `<p class="rp-note${warn ? ' warn' : ''}">${esc(text)}</p>`;
    const emptyState = (text) => `<p class="text-center text-muted card" style="padding:2rem;">${esc(text)}</p>`;

    function injectStyles() {
        if (document.getElementById('rpStyles')) return;
        const style = document.createElement('style');
        style.id = 'rpStyles';
        style.textContent = `
        .rp-presets { display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem; }
        .rp-preset { padding:0.4rem 0.85rem; border-radius:var(--radius-full); border:1px solid var(--border-strong); background:var(--bg-surface); color:var(--text-secondary); font-size:0.8rem; font-weight:600; cursor:pointer; }
        .rp-preset.active { background:var(--primary); border-color:var(--primary); color:#fff; }
        .rp-filter { display:flex; flex-wrap:wrap; align-items:flex-end; gap:0.75rem; margin-bottom:1.25rem; }
        .rp-field { display:flex; flex-direction:column; gap:0.35rem; min-width:140px; }
        .rp-field label { font-size:0.75rem; font-weight:600; color:var(--text-muted); }
        .rp-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; margin-bottom:1.25rem; }
        .rp-head h3 { font-size:1.15rem; margin:0; }
        .rp-actions { display:flex; flex-wrap:wrap; gap:0.5rem; }
        .rp-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:0.75rem; margin-bottom:1.25rem; }
        .rp-kpis .stat-label { font-size:0.85rem; color:var(--text-muted); }
        .rp-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:1.25rem; margin-bottom:1.25rem; }
        .rp-card { padding:1.25rem; }
        .rp-card h4 { font-size:0.95rem; margin:0 0 0.75rem; }
        .rp-wrap { overflow-x:auto; }
        .rp-table { width:100%; border-collapse:collapse; font-size:0.85rem; }
        .rp-table th, .rp-table td { padding:0.55rem 0.6rem; text-align:left; border-bottom:1px solid var(--border-strong); }
        .rp-table th { color:var(--text-muted); font-weight:600; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; }
        .rp-table td.num, .rp-table th.num { text-align:right; font-variant-numeric:tabular-nums; }
        .rp-table tr:last-child td { border-bottom:none; }
        .rp-plate { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:700; letter-spacing:0.04em; }
        .rp-note { font-size:0.8rem; color:var(--text-muted); margin:0 0 0.75rem; }
        .rp-note.warn { color:var(--warning); }
        .rp-bar { display:inline-block; height:0.55rem; border-radius:3px; background:var(--primary-light); vertical-align:middle; min-width:2px; }
        .rp-links { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:1.25rem; }
        .rp-link { padding:1.25rem; display:flex; flex-direction:column; gap:0.5rem; text-decoration:none; color:inherit; }
        .rp-link h4 { margin:0; font-size:1rem; }
        .rp-link p { margin:0; font-size:0.85rem; color:var(--text-muted); flex:1; }
        .rp-link .btn { align-self:flex-start; gap:0.4rem; }
        .rp-printonly { display:none; }
        @media (max-width:640px) {
            .rp-grid { grid-template-columns:1fr; }
            .rp-kpis { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0.5rem; }
        }
        /* Impresion (Guardar como PDF): solo el reporte, en claro */
        @media print {
            body, body.light-mode {
                --bg-app:#fff; --bg-surface:#fff; --bg-surface-solid:#fff; --bg-item:#eee;
                --text-primary:#000; --text-secondary:#222; --text-muted:#555;
                --border-strong:#ccc; --border-subtle:#ddd;
                background:#fff;
            }
            .bg-decor, .top-bar, .app-footer, #panelMain, .rp-noprint, .modal-overlay { display:none !important; }
            .page-content { padding:0; }
            .card, .stat-card { box-shadow:none !important; backdrop-filter:none !important; break-inside:avoid; }
            .rp-printonly { display:block !important; }
        }`;
        document.head.appendChild(style);
    }

    // Que secciones puede ver el usuario actual (el boton Reportes aparece solo si hay al menos una)
    function available() {
        const can = (key) => sisdel().can(key);
        if (!can('reportes.ver')) return [];
        return SECTIONS.filter((s) => s.allowed(can)).map((s) => s.id);
    }

    function mount(container, opts) {
        injectStyles();
        const S = sisdel();
        const can = (key) => S.can(key);
        const condoId = opts.condominioId;
        const condoName = opts.condoName || 'Condominio';
        const slug = condoName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'condominio';
        const sections = SECTIONS.filter((s) => available().includes(s.id));
        const canExport = can('reportes.exportar');
        let current = null;
        let report = null;
        let seq = 0; // descarta respuestas de un reporte anterior si el usuario cambio de rango o de pestana

        container.innerHTML = `
            <div class="tabs rp-noprint" id="rpTabs">${sections.map((s) => `<button class="tab" data-rp="${s.id}">${esc(s.label)}</button>`).join('')}</div>
            <div id="rpBody"></div>`;
        const body = container.querySelector('#rpBody');
        container.querySelectorAll('#rpTabs .tab').forEach((t) => t.addEventListener('click', () => { location.hash = `#reportes/${t.dataset.rp}`; }));

        const usersMap = () => new Map((opts.getUsers ? opts.getUsers() : []).map((u) => [u.id, u]));
        const userName = (map, id) => (map.get(id) ? map.get(id).name : '');

        // ── Garita ──
        function garitaShell() {
            body.innerHTML = `
                <div class="rp-noprint">
                    <div class="rp-presets" id="rpPresets">
                        <button class="rp-preset" data-preset="today">Hoy</button>
                        <button class="rp-preset" data-preset="7d">Últimos 7 días</button>
                        <button class="rp-preset" data-preset="30d">Últimos 30 días</button>
                        <button class="rp-preset" data-preset="month">Este mes</button>
                        <button class="rp-preset" data-preset="lastMonth">Mes anterior</button>
                    </div>
                    <div class="rp-filter">
                        <div class="rp-field"><label for="rpFrom">Desde</label><input type="date" class="form-input" id="rpFrom"></div>
                        <div class="rp-field"><label for="rpTo">Hasta</label><input type="date" class="form-input" id="rpTo"></div>
                        <button class="btn btn-primary btn-sm" id="rpGenerate">Generar reporte</button>
                    </div>
                </div>
                <div id="rpOut"></div>`;
            const setPreset = (name) => {
                const t = today();
                let from = t;
                let to = t;
                if (name === '7d') from = addDays(t, -6);
                else if (name === '30d') from = addDays(t, -29);
                else if (name === 'month') from = new Date(t.getFullYear(), t.getMonth(), 1);
                else if (name === 'lastMonth') { from = new Date(t.getFullYear(), t.getMonth() - 1, 1); to = new Date(t.getFullYear(), t.getMonth(), 0); }
                body.querySelector('#rpFrom').value = ymd(from);
                body.querySelector('#rpTo').value = ymd(to);
                body.querySelectorAll('.rp-preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
            };
            body.querySelectorAll('.rp-preset').forEach((b) => b.addEventListener('click', () => { setPreset(b.dataset.preset); buildGarita(); }));
            ['rpFrom', 'rpTo'].forEach((id) => body.querySelector(`#${id}`).addEventListener('input', () => body.querySelectorAll('.rp-preset').forEach((b) => b.classList.remove('active'))));
            body.querySelector('#rpGenerate').addEventListener('click', buildGarita);
            setPreset('7d');
            buildGarita();
        }

        async function buildGarita() {
            const from = body.querySelector('#rpFrom').value;
            const to = body.querySelector('#rpTo').value;
            const out = body.querySelector('#rpOut');
            if (!from || !to || from > to) { S.showToast('Elija un rango de fechas válido.', 'warning'); return; }
            if ((parseYmd(to) - parseYmd(from)) / 86400000 + 1 > MAX_DAYS) { S.showToast(`El rango no puede pasar de ${MAX_DAYS} días.`, 'warning'); return; }
            const mine = ++seq;
            out.innerHTML = emptyState('Generando reporte...');

            const fromIso = parseYmd(from).toISOString();
            const toIso = addDays(parseYmd(to), 1).toISOString();
            const [logs, visits, exits] = await Promise.all([
                S.getCameraLogsBetween(condoId, fromIso, toIso, MAX_LOGS),
                S.getVisitsBetween(condoId, from, to),
                S.getExitsBetween(condoId, fromIso, toIso, MAX_LOGS)
            ]);
            if (mine !== seq) return;
            if (!logs || !visits) { report = null; out.innerHTML = emptyState('No se pudo cargar la información. Revise su conexión e intente de nuevo.'); return; }
            const exitsOk = exits !== null;
            const users = usersMap();

            const logsIn = logs.filter(isAllowed);
            const neighborIn = logsIn.filter((l) => logKind(l) === 'vecino');
            const denied = logs.filter((l) => !isAllowed(l));
            const reminders = logs.filter((l) => l.status === 'Reminder').length;
            const neighborOut = exitsOk ? exits : [];
            const visitsIn = visits.filter((v) => v.enteredAt);
            const visitsOut = visits.filter((v) => v.exitedAt);
            const inside = visits.filter((v) => S.isVisitInside(v));
            const noShow = visits.filter((v) => !v.enteredAt).length;

            // Movimiento por dia (fecha local de cada evento)
            const days = new Map();
            for (let d = parseYmd(from); d <= parseYmd(to); d = addDays(d, 1)) days.set(ymd(d), { nIn: 0, vIn: 0, nOut: 0, vOut: 0, den: 0 });
            const bump = (iso, field) => { const row = days.get(ymd(new Date(iso))); if (row) row[field]++; };
            neighborIn.forEach((l) => bump(l.createdAt, 'nIn'));
            visitsIn.forEach((v) => bump(v.enteredAt, 'vIn'));
            neighborOut.forEach((x) => bump(x.createdAt, 'nOut'));
            visitsOut.forEach((v) => bump(v.exitedAt, 'vOut'));
            denied.forEach((l) => bump(l.createdAt, 'den'));
            const dayEntries = [...days.entries()].reverse().filter(([, r]) => r.nIn + r.vIn + r.nOut + r.vOut + r.den > 0);

            // Horas con mas ingresos
            const hours = Array.from({ length: 24 }, () => ({ n: 0, v: 0 }));
            neighborIn.forEach((l) => { hours[new Date(l.createdAt).getHours()].n++; });
            visitsIn.forEach((v) => { hours[new Date(v.enteredAt).getHours()].v++; });
            const peak = Math.max(1, ...hours.map((h) => h.n + h.v));
            const hourRows = hours.map((h, i) => [i, h]).filter(([, h]) => h.n + h.v > 0)
                .map(([i, h]) => [`${pad(i)}:00`, h.n, h.v, `<span class="rp-bar" style="width:${Math.round(((h.n + h.v) / peak) * 100)}px"></span> ${h.n + h.v}`]);

            // Placas
            const plateStats = new Map();
            logs.forEach((l) => {
                if (!l.plate || l.plate === 'RESIDENTE') return;
                const s = plateStats.get(l.plate) || { total: 0, denied: 0, last: '', reason: '' };
                if (isAllowed(l)) s.total++;
                else { s.denied++; if (!s.reason) s.reason = l.reason || ''; }
                if (l.createdAt > s.last) s.last = l.createdAt;
                plateStats.set(l.plate, s);
            });
            const topPlates = [...plateStats.entries()].filter(([, s]) => s.total > 0).sort((a, b) => b[1].total - a[1].total).slice(0, 10)
                .map(([p, s]) => [`<span class="rp-plate">${esc(p)}</span>`, s.total, esc(dateTime(s.last))]);
            const deniedPlates = [...plateStats.entries()].filter(([, s]) => s.denied > 0).sort((a, b) => b[1].denied - a[1].denied).slice(0, 10)
                .map(([p, s]) => [`<span class="rp-plate">${esc(p)}</span>`, s.denied, esc(s.reason)]);
            const byHouse = [...countBy(visits, (v) => v.casa || 'Sin casa').entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => [esc(c), n]);

            // Detalle de movimientos de vecinos (ingresos, salidas y denegados), del mas nuevo al mas viejo
            const movements = [
                ...logs.filter((l) => logKind(l) !== 'visita').map((l) => ({
                    at: l.createdAt, type: isAllowed(l) ? (l.status === 'Reminder' ? 'Ingreso con aviso de mora' : 'Ingreso') : 'Denegado',
                    plate: l.plate === 'RESIDENTE' ? '' : l.plate, who: l.reason || '', casa: ''
                })),
                ...neighborOut.map((x) => ({
                    at: x.createdAt, type: 'Salida', plate: x.plate || '', who: x.name || x.reason || '', casa: x.casa || ''
                }))
            ].sort((a, b) => (a.at < b.at ? 1 : -1));
            const visitRows = [...visits].sort((a, b) => ((b.enteredAt || b.visitDate) > (a.enteredAt || a.visitDate) ? 1 : -1)).map((v) => ({
                date: v.visitDate, name: v.visitorName, casa: v.casa || '', owner: userName(users, v.userId), plate: v.vehiclePlate || '',
                in: v.enteredAt || '', out: v.exitedAt && v.exitedAt >= (v.enteredAt || '') ? v.exitedAt : '', stay: stay(v),
                state: !v.enteredAt ? 'Sin ingreso' : (S.isVisitInside(v) ? 'Dentro' : 'Salió')
            }));

            report = { from, to, movements, visitRows, days: dayEntries, at: new Date() };
            const rangeText = from === to ? longDate(from) : `${longDate(from)} al ${longDate(to)}`;
            const capped = logs.length >= MAX_LOGS || (exitsOk && exits.length >= MAX_LOGS);
            const moreMovements = movements.length > SHOWN_ROWS;
            const moreVisits = visitRows.length > SHOWN_ROWS;

            out.innerHTML = `
                <div class="rp-head">
                    <div>
                        <p class="rp-printonly text-sm text-muted">${esc(condoName)} · Reporte de garita</p>
                        <h3>Garita: ${esc(rangeText)}</h3>
                        <p class="text-xs text-muted">Generado el ${esc(dateTime(report.at.toISOString()))} por ${esc(opts.userName || 'Administrador')}</p>
                        ${capped ? note(`El período tiene más de ${MAX_LOGS} registros; los totales cubren solo los más recientes. Reduzca el rango para un total exacto.`, true) : ''}
                        ${exitsOk ? '' : note('No se pudieron leer las salidas de vecinos; el reporte las muestra en cero.', true)}
                    </div>
                    ${canExport ? `<div class="rp-actions rp-noprint">
                        <button class="btn btn-ghost btn-sm" data-rp-export="days">${ICONS.download} Resumen por día (CSV)</button>
                        <button class="btn btn-ghost btn-sm" data-rp-export="neighbors">${ICONS.download} Vecinos (CSV)</button>
                        <button class="btn btn-ghost btn-sm" data-rp-export="visits">${ICONS.download} Visitas (CSV)</button>
                        <button class="btn btn-primary btn-sm" data-rp-export="print">${ICONS.print} Imprimir / PDF</button>
                    </div>` : ''}
                </div>
                <div class="rp-kpis">
                    ${kpi('Ingresos de vecinos', neighborIn.length, 'var(--success)')}
                    ${kpi('Salidas de vecinos', neighborOut.length, 'var(--primary-light)')}
                    ${kpi('Ingresos de visitas', visitsIn.length, 'var(--success)')}
                    ${kpi('Salidas de visitas', visitsOut.length, 'var(--primary-light)')}
                    ${kpi('Visitas dentro', inside.length, 'var(--accent)')}
                    ${kpi('Visitas sin ingreso', noShow, 'var(--text-muted)')}
                    ${kpi('Con aviso de mora', reminders, 'var(--warning)')}
                    ${kpi('Denegados', denied.length, 'var(--danger)')}
                </div>
                <div class="rp-grid">
                    <div class="card rp-card"><h4>Movimiento por día</h4>
                        ${table(['Fecha', 'Ingresos vecinos', 'Ingresos visitas', 'Salidas vecinos', 'Salidas visitas', 'Denegados'],
                            dayEntries.map(([d, r]) => [esc(S.formatDate(d)), r.nIn, r.vIn, r.nOut, r.vOut, r.den]), [1, 2, 3, 4, 5])}</div>
                    <div class="card rp-card"><h4>Horas con más ingresos</h4>
                        ${table(['Hora', 'Vecinos', 'Visitas', 'Total'], hourRows, [1, 2])}</div>
                    <div class="card rp-card"><h4>Visitas por casa</h4>${table(['Casa', 'Visitas'], byHouse, [1])}</div>
                    <div class="card rp-card"><h4>Placas con más ingresos</h4>${table(['Placa', 'Ingresos', 'Último'], topPlates, [1])}</div>
                    <div class="card rp-card"><h4>Placas denegadas</h4>${table(['Placa', 'Veces', 'Motivo'], deniedPlates, [1])}</div>
                </div>
                <div class="card rp-card" style="margin-bottom:1.25rem;"><h4>Ingresos y salidas de vecinos</h4>
                    ${moreMovements ? note(`Se muestran los ${SHOWN_ROWS} más recientes de ${movements.length}; el CSV trae todos.`) : ''}
                    ${table(['Fecha y hora', 'Movimiento', 'Placa', 'Vecino / detalle', 'Casa'],
                        movements.slice(0, SHOWN_ROWS).map((m) => [esc(dateTime(m.at)), esc(m.type), `<span class="rp-plate">${esc(m.plate)}</span>`, esc(m.who), esc(m.casa)]))}</div>
                <div class="card rp-card"><h4>Visitas del período</h4>
                    ${moreVisits ? note(`Se muestran las ${SHOWN_ROWS} más recientes de ${visitRows.length}; el CSV trae todas.`) : ''}
                    ${table(['Fecha', 'Visitante', 'Casa', 'Autoriza', 'Placa', 'Ingresó', 'Salió', 'Estancia', 'Estado'],
                        visitRows.slice(0, SHOWN_ROWS).map((v) => [esc(S.formatDate(v.date)), esc(v.name), esc(v.casa), esc(v.owner), `<span class="rp-plate">${esc(v.plate)}</span>`,
                            esc(hm(v.in)), esc(hm(v.out)), esc(v.stay), esc(v.state)]))}</div>`;
            out.querySelectorAll('[data-rp-export]').forEach((b) => b.addEventListener('click', () => exportGarita(b.dataset.rpExport)));
        }

        function exportGarita(kind) {
            if (!canExport) return;
            if (kind === 'print') { window.print(); return; }
            if (!report) return;
            const suffix = report.from === report.to ? report.from : `${report.from}_a_${report.to}`;
            if (kind === 'days') {
                downloadCsv(`garita-por-dia-${slug}-${suffix}.csv`, ['Fecha', 'Ingresos de vecinos', 'Ingresos de visitas', 'Salidas de vecinos', 'Salidas de visitas', 'Denegados'],
                    report.days.map(([d, r]) => [d, r.nIn, r.vIn, r.nOut, r.vOut, r.den]));
            } else if (kind === 'neighbors') {
                downloadCsv(`vecinos-ingresos-salidas-${slug}-${suffix}.csv`, ['Fecha y hora', 'Movimiento', 'Placa', 'Vecino o detalle', 'Casa'],
                    report.movements.map((m) => [stamp(m.at), m.type, m.plate, m.who, m.casa]));
            } else if (kind === 'visits') {
                downloadCsv(`visitas-${slug}-${suffix}.csv`, ['Fecha', 'Visitante', 'Casa', 'Autoriza', 'Placa', 'Ingresó', 'Salió', 'Estancia', 'Estado'],
                    report.visitRows.map((v) => [v.date, v.name, v.casa, v.owner, v.plate, stamp(v.in), stamp(v.out), v.stay, v.state]));
            }
        }

        // ── Morosos a la fecha ──
        function renderMorosos() {
            const users = (opts.getUsers ? opts.getUsers() : []).filter((u) => u.role === S.ROLES.VECINO);
            const days = (u) => (u.morosoSince ? Math.max(0, Math.floor((Date.now() - new Date(u.morosoSince).getTime()) / 86400000)) : null);
            const morosos = users.filter((u) => u.paymentStatus === S.PAYMENT_STATUS.MOROSO).sort((a, b) => (days(b) || 0) - (days(a) || 0));
            const withPhone = can('usuarios.contacto');
            const finLink = can('finanzas.usar') && can('finanzas.reportes_morosos');
            const rate = users.length ? Math.round((morosos.length / users.length) * 100) : 0;
            const at = new Date();
            report = { morosos, withPhone, days };
            body.innerHTML = `
                <div class="rp-head">
                    <div>
                        <p class="rp-printonly text-sm text-muted">${esc(condoName)} · Listado de morosos</p>
                        <h3>Morosos a la fecha</h3>
                        <p class="text-xs text-muted">Al ${esc(dateTime(at.toISOString()))} · estado de pago calculado por el Sistema Financiero</p>
                    </div>
                    <div class="rp-actions rp-noprint">
                        ${finLink ? `<a class="btn btn-ghost btn-sm" href="finanzas.html#reportes/morosos">${ICONS.open} Meses adeudados en Finanzas</a>` : ''}
                        ${canExport ? `<button class="btn btn-ghost btn-sm" data-rp-export="morosos">${ICONS.download} Morosos (CSV)</button>
                        <button class="btn btn-primary btn-sm" data-rp-export="print">${ICONS.print} Imprimir / PDF</button>` : ''}
                    </div>
                </div>
                <div class="rp-kpis">
                    ${kpi('Vecinos', users.length, 'var(--primary-light)')}
                    ${kpi('Al día', users.length - morosos.length, 'var(--success)')}
                    ${kpi('Morosos', morosos.length, 'var(--danger)')}
                    ${kpi('Morosidad', `${rate} %`, 'var(--warning)')}
                </div>
                <div class="card rp-card">
                    ${table(['Nombre', 'Casa', 'Desde', 'Días', ...(withPhone ? ['Teléfono'] : [])],
                        morosos.map((u) => [esc(u.name), esc(u.casa || ''), esc(u.morosoSince ? S.formatDate(u.morosoSince) : '—'), days(u) ?? '—', ...(withPhone ? [esc(u.phone || '')] : [])]), [3])}
                </div>`;
            body.querySelectorAll('[data-rp-export]').forEach((b) => b.addEventListener('click', () => {
                if (!canExport) return;
                if (b.dataset.rpExport === 'print') { window.print(); return; }
                downloadCsv(`morosos-${slug}-${ymd(at)}.csv`, ['Nombre', 'Casa', 'Moroso desde', 'Días', ...(withPhone ? ['Teléfono'] : [])],
                    morosos.map((u) => [u.name, u.casa || '', u.morosoSince ? ymd(new Date(u.morosoSince)) : '', days(u) ?? '', ...(withPhone ? [u.phone || ''] : [])]));
            }));
        }

        // ── Finanzas y Rondas: accesos directos (los reportes viven en OIKOS y en RONDIN) ──
        function renderFinanzas() {
            body.innerHTML = `
                <p class="rp-note">Estos reportes los calcula el Sistema Financiero (OIKOS) con la contabilidad del condominio, así que las cifras son siempre las mismas. Se abren ahí; para volver use "Regresar al panel principal".</p>
                <div class="rp-links">${FIN_REPORTS.filter((r) => can(r.key)).map((r) => `
                    <div class="card rp-link"><h4>${esc(r.title)}</h4><p>${esc(r.text)}</p>
                        <a class="btn btn-primary btn-sm" href="finanzas.html#reportes/${esc(r.id)}">${ICONS.open} Abrir reporte</a></div>`).join('')}</div>`;
        }
        function renderRondas() {
            body.innerHTML = `
                <p class="rp-note">El control de guardias vive en RONDIN: se abre en su panel principal.</p>
                <div class="rp-links">
                    <div class="card rp-link"><h4>Panel y reporte semanal de Rondas</h4>
                        <p>Cumplimiento de rondas por guardia, incidentes, alertas y el reporte semanal del Director General para imprimir.</p>
                        <a class="btn btn-primary btn-sm" href="rondin/">${ICONS.open} Abrir RONDIN</a></div>
                </div>`;
        }

        function show(id) {
            const section = sections.find((s) => s.id === id) || sections[0];
            if (!section) { body.innerHTML = emptyState('Su usuario no tiene reportes disponibles. Pídale al administrador que se los asigne.'); return null; }
            current = section.id;
            seq++;
            report = null;
            container.querySelectorAll('#rpTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.rp === current));
            if (current === 'garita') garitaShell();
            else if (current === 'morosos') renderMorosos();
            else if (current === 'finanzas') renderFinanzas();
            else renderRondas();
            return current;
        }

        return { show, ids: sections.map((s) => s.id), current: () => current, refresh: () => show(current) };
    }

    return { available, mount, logKind, FIN_REPORTS };
})();
