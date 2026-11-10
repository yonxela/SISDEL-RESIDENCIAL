/* ═══════════════════════════════════════════════════════════════
   SISDEL - Panel de Reportes del administrador (admin.html, boton "Reportes")
   ───────────────────────────────────────────────────────────────
   Catalogo en acordeon (como el modulo de Reportes de MULTISYS): las categorias arrancan cerradas, al pulsar una se
   ven sus reportes y al elegir uno se abre con "Volver al catalogo".
   - Garita y accesos: resumen por dia, ingresos y salidas de vecinos, visitas del periodo, horas pico, placas con mas
     ingresos, placas denegadas y visitas por casa (con datos de camera_logs, visitas y salidas).
   - Morosos: el listado de vecinos en mora a la fecha.
   - Finanzas (OIKOS): accesos directos a sus reportes (ingresos, gastos, morosos con meses adeudados, estado de cuenta y
     reporte financiero). La contabilidad no se vuelve a calcular aqui: asi las cifras son siempre las de OIKOS, que ya
     trae sus propios botones de imprimir, PDF, WhatsApp y Excel.
   - Rondas (RONDIN): acceso directo al panel y al reporte semanal.

   Cada reporte propio ofrece Imprimir, Descargar PDF, Enviar por WhatsApp y Exportar a Excel (reportes-export.js) con el
   privilegio reportes.exportar. Cada categoria pide su privilegio (reportes.*) y los de lectura de los datos que muestra.
   Requiere privilegios.js, sisdel-core.js, reportes-export.js y styles.css.
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

    // Reportes de garita: todos usan el mismo rango de fechas y los mismos datos
    const GARITA_REPORTS = [
        { id: 'garita-resumen', label: 'Resumen de garita por día', text: 'Ingresos, salidas y denegados de vecinos y visitas, día por día.' },
        { id: 'garita-vecinos', label: 'Ingresos y salidas de vecinos', text: 'Cada ingreso, salida o acceso denegado de los vecinos, con su placa.' },
        { id: 'garita-visitas', label: 'Visitas del período', text: 'Las visitas del rango: quién las autorizó, cuándo entraron y salieron y cuánto estuvieron.' },
        { id: 'garita-horas', label: 'Horas con más ingresos', text: 'En qué horas del día entran más vecinos y visitas.' },
        { id: 'garita-placas', label: 'Placas con más ingresos', text: 'Las 10 placas que más entraron.' },
        { id: 'garita-denegadas', label: 'Placas denegadas', text: 'Las placas a las que más veces se les negó el paso y por qué.' },
        { id: 'garita-casas', label: 'Visitas por casa', text: 'Las casas que más visitas reciben.' }
    ];

    // Categorias del catalogo. `allowed` decide si el usuario la ve; `reports(can)` da lo que puede abrir en ella.
    // Los reportes con href se abren en OIKOS o en RONDIN; los demas se arman aqui.
    const SECTIONS = [
        { id: 'garita', label: 'Garita y accesos', icon: 'gate', allowed: (can) => can('reportes.garita') && can('usuarios.ver') && can('visitas.ver') && can('garita.camara'), reports: () => GARITA_REPORTS },
        { id: 'morosos', label: 'Morosos', icon: 'alert', allowed: (can) => can('reportes.morosos') && can('usuarios.ver') && can('usuarios.pagos_ver'),
            reports: () => [{ id: 'morosos-fecha', label: 'Morosos a la fecha', text: 'Los vecinos en mora hoy, con su casa y los días de atraso.' }] },
        { id: 'finanzas', label: 'Finanzas (OIKOS)', icon: 'money', allowed: (can) => can('reportes.finanzas') && can('finanzas.usar') && FIN_REPORTS.some((r) => can(r.key)),
            reports: (can) => FIN_REPORTS.filter((r) => can(r.key)).map((r) => ({ id: `fin-${r.id}`, label: r.title, text: r.text, href: `finanzas.html#reportes/${r.id}` })) },
        { id: 'rondas', label: 'Rondas (RONDIN)', icon: 'route', allowed: (can) => can('reportes.rondas') && can('rondas.panel_ver'),
            reports: () => [{ id: 'rondas-panel', label: 'Panel y reporte semanal de Rondas', text: 'Cumplimiento de rondas por guardia, incidentes, alertas y el reporte semanal del Director General.', href: 'rondin/' }] }
    ];

    const svg = (inner, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const ICONS = {
        gate: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
        alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
        money: svg('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
        route: svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
        down: svg('<polyline points="6 9 12 15 18 9"/>', 16),
        up: svg('<polyline points="18 15 12 9 6 15"/>', 16),
        back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 15),
        open: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h11"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', 15)
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
    const hm = (iso) => (iso ? `${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}` : '');
    // Fecha y hora ordenable para los CSV
    const stamp = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    function stay(visit) {
        if (!visit.enteredAt || !visit.exitedAt || visit.exitedAt < visit.enteredAt) return '';
        const minutes = Math.round((new Date(visit.exitedAt) - new Date(visit.enteredAt)) / 60000);
        return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min` : `${minutes} min`;
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
        .rp-hint { color:var(--text-muted); font-size:0.9rem; margin:0 0 1rem; }
        .rp-acc { display:flex; flex-direction:column; gap:0.5rem; }
        .rp-acc-group { background:var(--bg-surface); border:1px solid var(--border-strong); border-radius:0.75rem; overflow:hidden; transition:border-color 0.15s; }
        .rp-acc-group.open { border-color:var(--primary); }
        .rp-acc-header { display:flex; align-items:center; gap:0.75rem; width:100%; padding:0.9rem 1rem; background:transparent; border:none; cursor:pointer; font:inherit; font-size:0.95rem; font-weight:700; color:var(--text-primary); text-align:left; }
        .rp-acc-header:hover, .rp-acc-group.open .rp-acc-header { background:rgba(148,163,184,0.12); }
        .rp-acc-group.open .rp-acc-header { border-bottom:1px solid var(--border-strong); }
        .rp-acc-title { flex:1; }
        .rp-acc-count { font-size:0.7rem; font-weight:700; color:var(--text-muted); border:1px solid var(--border-strong); border-radius:var(--radius-full); padding:0.1rem 0.55rem; min-width:1.5rem; text-align:center; }
        .rp-acc-group.open .rp-acc-count { color:var(--primary-light); border-color:var(--primary); }
        .rp-acc-items { list-style:none; margin:0; padding:0.4rem; }
        .rp-acc-item { display:flex; align-items:center; justify-content:space-between; width:100%; padding:0.6rem 0.75rem; background:transparent; border:none; border-radius:0.5rem; cursor:pointer; font:inherit; font-size:0.85rem; font-weight:500; color:var(--text-primary); text-align:left; text-decoration:none; }
        .rp-acc-item:hover { background:rgba(148,163,184,0.12); color:var(--primary-light); }
        .rp-acc-label { flex:1; }
        .rp-acc-arrow { color:var(--text-muted); font-size:1.15rem; line-height:1; }
        .rp-back { margin-bottom:1rem; }
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

    // Que categorias puede ver el usuario actual (el boton Reportes aparece solo si hay al menos una)
    function available() {
        const can = (key) => sisdel().can(key);
        if (!can('reportes.ver')) return [];
        return SECTIONS.filter((s) => s.allowed(can)).map((s) => s.id);
    }

    // Catalogo: categorias con los reportes que el usuario puede abrir (sin DOM: se prueba en Node)
    function catalogFor(can) {
        if (!can('reportes.ver')) return [];
        return SECTIONS.filter((s) => s.allowed(can))
            .map((s) => ({ id: s.id, label: s.label, icon: s.icon, items: s.reports(can) }))
            .filter((c) => c.items.length);
    }

    // Acciones comunes (reportes-export.js)
    const exporter = () => (typeof SisdelReportExport !== 'undefined' ? SisdelReportExport : window.SisdelReportExport);

    // Tabla del modelo -> HTML. Los datos van escapados; `plate` pone la placa en letra monoespaciada y `bar` dibuja una barra
    function tableHtml(t) {
        const rows = t.limit ? t.rows.slice(0, t.limit) : t.rows;
        const peak = t.bar !== undefined ? Math.max(1, ...t.rows.map((r) => Number(r[t.bar]) || 0)) : 1;
        const cell = (value, i) => {
            if (t.plate && t.plate.includes(i)) return `<span class="rp-plate">${esc(value)}</span>`;
            if (t.bar === i) { const n = Number(value) || 0; return `<span class="rp-bar" style="width:${Math.round((n / peak) * 100)}px"></span> ${n}`; }
            return esc(value);
        };
        return table(t.headers, rows.map((r) => r.map(cell)), t.numeric || []);
    }
    function modelHtml(m) {
        const kpis = (m.kpis || []).length ? `<div class="rp-kpis">${m.kpis.map((k) => kpi(k.label, k.value, k.color)).join('')}</div>` : '';
        const tables = (m.tables || []).map((t) => `
            <div class="card rp-card" style="margin-bottom:1.25rem;">
                ${t.title && t.title !== m.title ? `<h4>${esc(t.title)}</h4>` : ''}
                ${t.limit && t.rows.length > t.limit ? note(`En pantalla se muestran los ${t.limit} más recientes de ${t.rows.length}; el PDF y el Excel traen todos.`) : ''}
                ${tableHtml(t)}
            </div>`).join('');
        return kpis + tables;
    }

    function mount(container, opts) {
        injectStyles();
        const S = sisdel();
        const RX = exporter();
        const can = (key) => S.can(key);
        const condoId = opts.condominioId;
        const condoName = opts.condoName || 'Condominio';
        const userName = opts.userName || 'Administrador';
        const slug = condoName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'condominio';
        const catalogs = catalogFor(can);
        const canExport = can('reportes.exportar');
        // Imprimir, PDF, WhatsApp y Excel sacan datos del sistema: los da un solo privilegio (reportes.exportar)
        const actions = () => (RX ? RX.actionsHtml({ print: canExport, pdf: canExport, whatsapp: canExport, excel: canExport }) : '');
        let current = '';   // reporte abierto ('' = catalogo)
        let openCat = null; // categoria desplegada: al entrar todas arrancan cerradas
        let report = null;  // modelo del reporte en pantalla (lo usan los botones)
        let seq = 0;        // descarta respuestas de un reporte anterior si el usuario cambio de rango o de reporte
        let range = null;   // ultimo rango de fechas: se conserva al pasar de un reporte de garita a otro

        container.innerHTML = `
            <div id="rpCatalog"></div>
            <div id="rpView" style="display:none;">
                <div class="rp-back rp-noprint"><button type="button" class="btn btn-ghost btn-sm" id="rpBackCatalog" style="border:1px solid var(--border-strong);">${ICONS.back} Volver al catálogo</button></div>
                <div id="rpBody"></div>
            </div>`;
        const catalogEl = container.querySelector('#rpCatalog');
        const viewEl = container.querySelector('#rpView');
        const body = container.querySelector('#rpBody');
        container.querySelector('#rpBackCatalog').addEventListener('click', () => { location.hash = '#reportes'; });

        const usersMap = () => new Map((opts.getUsers ? opts.getUsers() : []).map((u) => [u.id, u]));
        const userLabel = (map, id) => (map.get(id) ? map.get(id).name : '');
        const findReport = (id) => {
            for (const c of catalogs) { const def = c.items.find((i) => i.id === id && !i.href); if (def) return def; }
            return null;
        };

        // Cabecera del reporte con las cuatro acciones
        function reportHead(m, extra) {
            return `
                <div class="rp-head">
                    <div>
                        <p class="rp-printonly text-sm text-muted">${esc(m.condoName)} · ${esc(m.title)}</p>
                        <h3>${esc(m.title)}${m.subtitle ? `: ${esc(m.subtitle)}` : ''}</h3>
                        <p class="text-xs text-muted">Generado el ${esc(dateTime(m.at.toISOString()))} por ${esc(m.userName)}</p>
                        ${(m.notes || []).map((n) => note(n)).join('')}
                        ${(m.warnings || []).map((w) => note(w, true)).join('')}
                    </div>
                    <div class="rp-actions rp-noprint">${extra || ''}${actions()}</div>
                </div>`;
        }
        function paint(target, m, extra) {
            report = m;
            target.innerHTML = reportHead(m, extra) + modelHtml(m);
            if (RX) RX.bind(target, () => report);
        }

        // ── Catalogo en acordeon ──
        function renderCatalog() {
            if (!catalogs.length) { catalogEl.innerHTML = emptyState('Su usuario no tiene reportes disponibles. Pídale al administrador que se los asigne.'); return; }
            catalogEl.innerHTML = `
                <p class="rp-hint">Click en una categoría para ver sus reportes.</p>
                <div class="rp-acc">${catalogs.map((c) => {
                    const open = openCat === c.id;
                    return `<div class="rp-acc-group${open ? ' open' : ''}">
                        <button type="button" class="rp-acc-header" data-rp-cat="${c.id}" aria-expanded="${open}">
                            ${ICONS[c.icon]}<span class="rp-acc-title">${esc(c.label)}</span><span class="rp-acc-count">${c.items.length}</span>${open ? ICONS.up : ICONS.down}
                        </button>
                        ${open ? `<ul class="rp-acc-items">${c.items.map((r) => (r.href
                            ? `<li><a class="rp-acc-item" href="${esc(r.href)}" title="${esc(r.text)}"><span class="rp-acc-label">${esc(r.label)}</span><span class="rp-acc-arrow">›</span></a></li>`
                            : `<li><button type="button" class="rp-acc-item" data-rp-open="${esc(r.id)}" title="${esc(r.text)}"><span class="rp-acc-label">${esc(r.label)}</span><span class="rp-acc-arrow">›</span></button></li>`)).join('')}</ul>` : ''}
                    </div>`;
                }).join('')}</div>`;
            catalogEl.querySelectorAll('[data-rp-cat]').forEach((b) => b.addEventListener('click', () => { openCat = openCat === b.dataset.rpCat ? null : b.dataset.rpCat; renderCatalog(); }));
            catalogEl.querySelectorAll('[data-rp-open]').forEach((b) => b.addEventListener('click', () => { location.hash = `#reportes/${b.dataset.rpOpen}`; }));
        }

        // ── Garita: un rango de fechas y un reporte distinto sobre los mismos datos ──
        function garitaShell(def) {
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
            body.querySelectorAll('.rp-preset').forEach((b) => b.addEventListener('click', () => { setPreset(b.dataset.preset); buildGarita(def); }));
            ['rpFrom', 'rpTo'].forEach((id) => body.querySelector(`#${id}`).addEventListener('input', () => body.querySelectorAll('.rp-preset').forEach((b) => b.classList.remove('active'))));
            body.querySelector('#rpGenerate').addEventListener('click', () => buildGarita(def));
            if (range) { body.querySelector('#rpFrom').value = range.from; body.querySelector('#rpTo').value = range.to; }
            else setPreset('7d');
            buildGarita(def);
        }

        async function buildGarita(def) {
            const from = body.querySelector('#rpFrom').value;
            const to = body.querySelector('#rpTo').value;
            const out = body.querySelector('#rpOut');
            if (!from || !to || from > to) { S.showToast('Elija un rango de fechas válido.', 'warning'); return; }
            if ((parseYmd(to) - parseYmd(from)) / 86400000 + 1 > MAX_DAYS) { S.showToast(`El rango no puede pasar de ${MAX_DAYS} días.`, 'warning'); return; }
            range = { from, to };
            const mine = ++seq;
            report = null;
            out.innerHTML = emptyState('Generando reporte...');

            const fromIso = parseYmd(from).toISOString();
            const toIso = addDays(parseYmd(to), 1).toISOString();
            const [logs, visits, exits] = await Promise.all([
                S.getCameraLogsBetween(condoId, fromIso, toIso, MAX_LOGS),
                S.getVisitsBetween(condoId, from, to),
                S.getExitsBetween(condoId, fromIso, toIso, MAX_LOGS)
            ]);
            if (mine !== seq) return;
            if (!logs || !visits) { out.innerHTML = emptyState('No se pudo cargar la información. Revise su conexión e intente de nuevo.'); return; }
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
            const dayRows = [...days.entries()].reverse().filter(([, r]) => r.nIn + r.vIn + r.nOut + r.vOut + r.den > 0)
                .map(([d, r]) => [d, r.nIn, r.vIn, r.nOut, r.vOut, r.den]);

            // Horas con mas ingresos
            const hours = Array.from({ length: 24 }, () => ({ n: 0, v: 0 }));
            neighborIn.forEach((l) => { hours[new Date(l.createdAt).getHours()].n++; });
            visitsIn.forEach((v) => { hours[new Date(v.enteredAt).getHours()].v++; });
            const hourRows = hours.map((h, i) => [i, h]).filter(([, h]) => h.n + h.v > 0).map(([i, h]) => [`${pad(i)}:00`, h.n, h.v, h.n + h.v]);

            // Placas
            const plateStats = new Map();
            logs.forEach((l) => {
                if (!l.plate || l.plate === 'RESIDENTE') return;
                const st = plateStats.get(l.plate) || { total: 0, denied: 0, last: '', reason: '' };
                if (isAllowed(l)) st.total++;
                else { st.denied++; if (!st.reason) st.reason = l.reason || ''; }
                if (l.createdAt > st.last) st.last = l.createdAt;
                plateStats.set(l.plate, st);
            });
            const plateRows = [...plateStats.entries()].filter(([, st]) => st.total > 0).sort((a, b) => b[1].total - a[1].total).slice(0, 10)
                .map(([p, st]) => [p, st.total, stamp(st.last)]);
            const deniedRows = [...plateStats.entries()].filter(([, st]) => st.denied > 0).sort((a, b) => b[1].denied - a[1].denied).slice(0, 10)
                .map(([p, st]) => [p, st.denied, st.reason]);
            const houseRows = [...countBy(visits, (v) => v.casa || 'Sin casa').entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

            // Detalle de movimientos de vecinos (ingresos, salidas y denegados), del mas nuevo al mas viejo
            const movements = [
                ...logs.filter((l) => logKind(l) !== 'visita').map((l) => ({
                    at: l.createdAt, type: isAllowed(l) ? (l.status === 'Reminder' ? 'Ingreso con aviso de mora' : 'Ingreso') : 'Denegado',
                    plate: l.plate === 'RESIDENTE' ? '' : l.plate, who: l.reason || '', casa: ''
                })),
                ...neighborOut.map((x) => ({ at: x.createdAt, type: 'Salida', plate: x.plate || '', who: x.name || x.reason || '', casa: x.casa || '' }))
            ].sort((a, b) => (a.at < b.at ? 1 : -1));
            const movementRows = movements.map((m) => [stamp(m.at), m.type, m.plate, m.who, m.casa]);
            const visitRows = [...visits].sort((a, b) => ((b.enteredAt || b.visitDate) > (a.enteredAt || a.visitDate) ? 1 : -1)).map((v) => [
                v.visitDate, v.visitorName, v.casa || '', userLabel(users, v.userId), v.vehiclePlate || '', hm(v.enteredAt),
                v.exitedAt && v.exitedAt >= (v.enteredAt || '') ? hm(v.exitedAt) : '', stay(v), !v.enteredAt ? 'Sin ingreso' : (S.isVisitInside(v) ? 'Dentro' : 'Salió')
            ]);

            const tables = {
                'garita-resumen': { title: 'Movimiento por día', headers: ['Fecha', 'Ingresos vecinos', 'Ingresos visitas', 'Salidas vecinos', 'Salidas visitas', 'Denegados'], rows: dayRows, numeric: [1, 2, 3, 4, 5] },
                'garita-vecinos': { title: def.label, headers: ['Fecha y hora', 'Movimiento', 'Placa', 'Vecino / detalle', 'Casa'], rows: movementRows, plate: [2], limit: SHOWN_ROWS },
                'garita-visitas': { title: def.label, headers: ['Fecha', 'Visitante', 'Casa', 'Autoriza', 'Placa', 'Ingresó', 'Salió', 'Estancia', 'Estado'], rows: visitRows, plate: [4], limit: SHOWN_ROWS },
                'garita-horas': { title: def.label, headers: ['Hora', 'Vecinos', 'Visitas', 'Total'], rows: hourRows, numeric: [1, 2, 3], bar: 3 },
                'garita-placas': { title: def.label, headers: ['Placa', 'Ingresos', 'Último ingreso'], rows: plateRows, plate: [0], numeric: [1] },
                'garita-denegadas': { title: def.label, headers: ['Placa', 'Veces', 'Motivo'], rows: deniedRows, plate: [0], numeric: [1] },
                'garita-casas': { title: def.label, headers: ['Casa', 'Visitas'], rows: houseRows, numeric: [1] }
            };
            const kpis = def.id === 'garita-resumen' ? [
                { label: 'Ingresos de vecinos', value: neighborIn.length, color: 'var(--success)' },
                { label: 'Salidas de vecinos', value: neighborOut.length, color: 'var(--primary-light)' },
                { label: 'Ingresos de visitas', value: visitsIn.length, color: 'var(--success)' },
                { label: 'Salidas de visitas', value: visitsOut.length, color: 'var(--primary-light)' },
                { label: 'Visitas dentro', value: inside.length, color: 'var(--accent)' },
                { label: 'Visitas sin ingreso', value: noShow, color: 'var(--text-muted)' },
                { label: 'Con aviso de mora', value: reminders, color: 'var(--warning)' },
                { label: 'Denegados', value: denied.length, color: 'var(--danger)' }
            ] : [];
            const suffix = from === to ? from : `${from}_a_${to}`;
            const warnings = [];
            if (logs.length >= MAX_LOGS || (exitsOk && exits.length >= MAX_LOGS)) warnings.push(`El período tiene más de ${MAX_LOGS} registros; los totales cubren solo los más recientes. Reduzca el rango para un total exacto.`);
            if (!exitsOk) warnings.push('No se pudieron leer las salidas de vecinos; el reporte las muestra en cero.');
            paint(out, {
                title: def.label, subtitle: from === to ? longDate(from) : `${longDate(from)} al ${longDate(to)}`, condoName, userName, at: new Date(),
                kpis, tables: [tables[def.id]], warnings, fileName: `${def.id}-${slug}-${suffix}`
            });
        }

        // ── Morosos a la fecha ──
        function renderMorosos(def) {
            const users = (opts.getUsers ? opts.getUsers() : []).filter((u) => u.role === S.ROLES.VECINO);
            const days = (u) => (u.morosoSince ? Math.max(0, Math.floor((Date.now() - new Date(u.morosoSince).getTime()) / 86400000)) : null);
            const morosos = users.filter((u) => u.paymentStatus === S.PAYMENT_STATUS.MOROSO).sort((a, b) => (days(b) || 0) - (days(a) || 0));
            const withPhone = can('usuarios.contacto');
            const finLink = can('finanzas.usar') && can('finanzas.reportes_morosos');
            const rate = users.length ? Math.round((morosos.length / users.length) * 100) : 0;
            const at = new Date();
            paint(body, {
                title: def.label, subtitle: `al ${dateTime(at.toISOString())}`, condoName, userName, at,
                notes: ['El estado de pago de cada vecino lo calcula el Sistema Financiero.'],
                kpis: [
                    { label: 'Vecinos', value: users.length, color: 'var(--primary-light)' },
                    { label: 'Al día', value: users.length - morosos.length, color: 'var(--success)' },
                    { label: 'Morosos', value: morosos.length, color: 'var(--danger)' },
                    { label: 'Morosidad', value: `${rate} %`, color: 'var(--warning)' }
                ],
                tables: [{
                    title: def.label, headers: ['Nombre', 'Casa', 'Desde', 'Días', ...(withPhone ? ['Teléfono'] : [])],
                    rows: morosos.map((u) => [u.name, u.casa || '', u.morosoSince ? ymd(new Date(u.morosoSince)) : '—', days(u) ?? '—', ...(withPhone ? [u.phone || ''] : [])]), numeric: [3]
                }],
                fileName: `morosos-${slug}-${ymd(at)}`
            }, finLink ? `<a class="btn btn-ghost btn-sm" href="finanzas.html#reportes/morosos">${ICONS.open} Meses adeudados en Finanzas</a>` : '');
        }

        function showCatalog(openId) {
            current = '';
            seq++;
            report = null;
            openCat = openId || null;
            viewEl.style.display = 'none';
            catalogEl.style.display = '';
            renderCatalog();
        }

        // show('') abre el catalogo; show('garita') lo abre con esa categoria desplegada (direcciones de antes); show('garita-visitas') abre ese reporte
        function show(id) {
            const category = catalogs.find((c) => c.id === id);
            if (category) { showCatalog(category.id); return ''; }
            const def = id ? findReport(id) : null;
            if (!def) { showCatalog(); return ''; }
            current = def.id;
            seq++;
            report = null;
            catalogEl.style.display = 'none';
            viewEl.style.display = '';
            if (def.id === 'morosos-fecha') renderMorosos(def);
            else garitaShell(def);
            return current;
        }

        return { show, ids: SECTIONS.filter((s) => available().includes(s.id)).map((s) => s.id), current: () => current, refresh: () => show(current) };
    }

    return { available, catalogFor, mount, logKind, FIN_REPORTS, GARITA_REPORTS };
})();
