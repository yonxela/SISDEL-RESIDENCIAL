/* ═══════════════════════════════════════════════════════════════
   SISDEL - QR de panico por vecino (logica comun, UMD: navegador y Node)
   ───────────────────────────────────────────────────────────────
   Cada vecino tiene su QR (una tarjeta con el QR, el icono del boton de panico, su lote y su nombre) para pegarlo en la
   puerta de su casa o en su carro. Al escanearlo se abre panico.html, que pide primero la ubicacion y despues muestra el
   boton. Lo usan reportes-ui.js (imprimir y PDF de las tarjetas, en admin.html > Reportes) y panico.html (la llamada al
   servidor y lo que el telefono recuerda).

   SEGURIDAD: el QR solo lleva el condominio y el vecino (panico.html?c=<condominio>&v=<vecino>), nunca su codigo de
   acceso. Por si solo no deja hacer nada: el telefono se vincula una vez con el codigo del vecino (ver
   functions/src/panico-qr.js).

   El QR lo dibuja la libreria qrcode-generator 1.4.4 (vendor/, MIT, copia exacta del paquete de npm), en el navegador:
   nunca se manda a un servicio externo.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelPanicoQr = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const PROJECT_ID = 'sisdel-datacenter';
    const REGION = 'us-central1';
    const PUBLIC_ORIGIN = 'https://garita.app';
    const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
    const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const QR_LIB = 'vendor/qrcode-generator-1.4.4.js';

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const isLocal = (loc) => !!loc && LOCAL_HOSTS.includes(loc.hostname);

    // ── Enlace del QR ──
    // Las tarjetas impresas apuntan siempre a garita.app (tambien si se imprimen desde el espejo sisdel-datacenter.web.app);
    // en desarrollo, a la maquina local, para poder probarlas con los emuladores
    function publicOrigin(loc) { return isLocal(loc) ? loc.origin : PUBLIC_ORIGIN; }
    function panicUrl(origin, condoId, userId) {
        return `${origin}/panico.html?c=${encodeURIComponent(condoId)}&v=${encodeURIComponent(userId)}`;
    }
    // Lo que trae el QR: { c, v } o null si no es un QR valido
    function parsePanicQuery(search) {
        const params = new URLSearchParams(search || '');
        const c = params.get('c') || '';
        const v = params.get('v') || '';
        return ID_RE.test(c) && ID_RE.test(v) ? { c, v } : null;
    }

    // ── Servidor ──
    // panico.html llama a las funciones (callables) con fetch, sin el SDK de Firebase: en una emergencia la pagina tiene que
    // abrir rapido, tambien con poca senal. En la maquina local van a los emuladores (como firebase-client.js), salvo que se
    // pida la nube con localStorage sisdel_backend = 'prod'
    function functionUrl(loc, name, forceProd) {
        if (isLocal(loc) && !forceProd) return `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/${name}`;
        return `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${name}`;
    }
    // Protocolo de las funciones "callable" de Firebase: POST { data } -> { result } o { error: { message } }
    async function callFunction(url, data, fetchImpl) {
        const doFetch = fetchImpl || fetch;
        const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        if (!res.ok || !body || body.error) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
        return body.result;
    }
    // Lo que el telefono recuerda de cada QR que vinculo: { secret, name, casa, condoName, at }
    const storageKey = (c, v) => `sisdel_panico_qr_${c}_${v}`;

    // ── Lo que el telefono recuerda: la clave del vinculo, guardada en DOS lugares ──
    // Por ser un boton de panico, la clave NO se puede perder: el telefono se vincula una sola vez y despues escanear basta.
    // Se guarda en localStorage y tambien en IndexedDB: muchas cosas que pasan en un telefono (el navegador que libera espacio,
    // una "limpieza", un error) tocan uno y dejan el otro; al abrir, la copia que falte se repone con la que quedo. Ademas se pide
    // al navegador que no borre los datos de este sitio por su cuenta (navigator.storage.persist). LIMITE: Safari del iPhone
    // borra TODO lo que guarda una pagina que no se usa en una semana (y "borrar datos del sitio" tambien borra las dos copias):
    // contra eso solo sirve agregar el boton a la pantalla de inicio (panico.html lo explica) o volver a vincular.
    const SECRET_RE = /^[A-Za-z0-9_-]{40,64}$/;
    const IDB_NAME = 'sisdel-panico';
    const IDB_STORE = 'vinculos';
    const IDB_WAIT_MS = 1500; // IndexedDB que no responde (modo privado, navegador raro) no atrasa el boton

    const validLink = (l) => !!l && typeof l === 'object' && typeof l.secret === 'string' && SECRET_RE.test(l.secret);
    const parseLink = (text) => { try { const l = JSON.parse(text); return validLink(l) ? l : null; } catch (e) { return null; } };
    // Corta la espera de una promesa: si no responde a tiempo, resuelve con `fallback`
    const within = (promise, ms, fallback) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
    });

    // env: { localStorage, indexedDB, navigator } (los del navegador, o unos de mentira en las pruebas)
    function createKeeper(env, key) {
        const ls = env && env.localStorage;
        const idbFactory = env && env.indexedDB;
        const nav = env && env.navigator;
        const readLocal = () => { try { return ls ? parseLink(ls.getItem(key)) : null; } catch (e) { return null; } };
        const writeLocal = (link) => { try { if (!ls) return false; ls.setItem(key, JSON.stringify(link)); return true; } catch (e) { return false; } };
        const dropLocal = () => { try { if (ls) ls.removeItem(key); } catch (e) { /* nada que borrar */ } };

        // Una operacion sobre el almacen de IndexedDB (abre la base y la cierra al terminar)
        function idb(mode, run) {
            if (!idbFactory) return Promise.resolve(undefined);
            return new Promise((resolve) => {
                let request;
                try { request = idbFactory.open(IDB_NAME, 1); } catch (e) { resolve(undefined); return; }
                request.onupgradeneeded = () => { try { request.result.createObjectStore(IDB_STORE); } catch (e) { /* ya existe */ } };
                request.onerror = () => resolve(undefined);
                request.onblocked = () => resolve(undefined);
                request.onsuccess = () => {
                    const db = request.result;
                    try {
                        const tx = db.transaction(IDB_STORE, mode);
                        const op = run(tx.objectStore(IDB_STORE));
                        let value;
                        op.onsuccess = () => { value = op.result === undefined ? null : op.result; };
                        op.onerror = () => { value = undefined; };
                        tx.oncomplete = () => { try { db.close(); } catch (e) { /* ya cerrada */ } resolve(value === undefined ? (mode === 'readonly' ? null : true) : value); };
                        tx.onerror = tx.onabort = () => { try { db.close(); } catch (e) { /* ya cerrada */ } resolve(undefined); };
                    } catch (e) { try { db.close(); } catch (e2) { /* ya cerrada */ } resolve(undefined); }
                };
            });
        }
        const readIdb = async () => parseLink(await within(idb('readonly', (store) => store.get(key)).then((v) => (typeof v === 'string' ? v : v === null || v === undefined ? null : JSON.stringify(v))), IDB_WAIT_MS, null));
        const writeIdb = async (link) => (await within(idb('readwrite', (store) => store.put(JSON.stringify(link), key)), IDB_WAIT_MS, undefined)) !== undefined;
        const dropIdb = () => within(idb('readwrite', (store) => store.delete(key)), IDB_WAIT_MS, undefined);

        async function requestPersistence() {
            try {
                if (!nav || !nav.storage || typeof nav.storage.persist !== 'function') return null;
                if (typeof nav.storage.persisted === 'function' && await nav.storage.persisted()) return true;
                return !!(await within(nav.storage.persist(), IDB_WAIT_MS, false));
            } catch (e) { return null; }
        }

        return {
            // Lo guardado, de cualquiera de las dos copias; si falta una, la repone con la otra. { link, from, repaired }
            async load() {
                const local = readLocal();
                const fromIdb = await readIdb();
                const link = local || fromIdb;
                if (!link) return { link: null, from: null, repaired: false };
                let repaired = false;
                if (!local && writeLocal(link)) repaired = true;
                if (!fromIdb && await writeIdb(link)) repaired = true;
                return { link, from: local ? 'local' : 'idb', repaired };
            },
            // Lo que ya esta en localStorage, al instante (para no atrasar la pagina mientras se revisa IndexedDB)
            readLocal,
            // Guarda en las dos y pide que el navegador no lo borre. { local, idb, persistent }
            async save(link) {
                const local = writeLocal(link);
                const inIdb = await writeIdb(link);
                const persistent = await requestPersistence();
                return { local, idb: inIdb, persistent };
            },
            async drop() { dropLocal(); await dropIdb(); }
        };
    }

    // ── Lista de vecinos ──
    // "Lote 12" (el usuario lo pidio asi); si la casa ya dice "Casa 12" o "Lote 45", se deja como esta
    function unitLabel(casa) {
        const text = String(casa == null ? '' : casa).trim();
        if (!text) return '';
        return /^(lote|casa|apto|apartamento|depto|departamento|local|unidad|villa|torre)\b/i.test(text) ? text : `Lote ${text}`;
    }
    const natural = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { numeric: true, sensitivity: 'base' });
    // Vecinos activos, por lote (orden natural: A2 antes que A10) y nombre
    function neighbors(users) {
        return (users || []).filter((u) => u && u.role === 'vecino' && u.active !== false && ID_RE.test(String(u.id || '')))
            .sort((a, b) => natural(a.casa, b.casa) || natural(a.name, b.name));
    }
    // Las fases que existen (en orden natural); '' = sin fase
    function fases(list) {
        return [...new Set((list || []).map((u) => String(u.fase || '').trim()))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : natural(a, b)));
    }
    // A quienes se les imprime: todos, una fase o los elegidos (uno solo es una eleccion de uno)
    function select(list, opts = {}) {
        if (opts.mode === 'fase') return list.filter((u) => String(u.fase || '').trim() === String(opts.fase || '').trim());
        if (opts.mode === 'picked') { const ids = new Set(opts.ids || []); return list.filter((u) => ids.has(u.id)); }
        return list.slice();
    }
    function cardsFor(list, origin, condoId) {
        return list.map((u) => ({ id: u.id, name: String(u.name || '').trim(), unit: unitLabel(u.casa), fase: String(u.fase || '').trim(), url: panicUrl(origin, condoId, u.id) }));
    }

    // ── El QR ──
    // Correccion de errores Q (resiste hasta un 25 % de dano: una calcomania rayada o sucia sigue sirviendo); la libreria elige
    // el tamano. Un enlace de unos 80 caracteres da un QR de 45 x 45 modulos
    function qrMatrix(qrcodeLib, text) {
        const qr = qrcodeLib(0, 'Q');
        qr.addData(text, 'Byte');
        qr.make();
        const size = qr.getModuleCount();
        return { size, dark: (r, c) => qr.isDark(r, c) };
    }
    // Tramos horizontales de modulos oscuros: menos figuras que un cuadro por modulo (el PDF pesa menos y se ve igual)
    function qrRuns(m) {
        const runs = [];
        for (let r = 0; r < m.size; r++) {
            let start = -1;
            for (let c = 0; c <= m.size; c++) {
                const d = c < m.size && m.dark(r, c);
                if (d && start < 0) start = c;
                if (!d && start >= 0) { runs.push({ x: start, y: r, w: c - start }); start = -1; }
            }
        }
        return runs;
    }
    // SVG del QR con su margen blanco (4 modulos, el que pide la norma para que se lea bien)
    function qrSvg(m, quiet = 4) {
        const n = m.size + quiet * 2;
        const d = qrRuns(m).map((t) => `M${t.x + quiet} ${t.y + quiet}h${t.w}v1h-${t.w}z`).join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    }

    // Icono del boton de panico: un boton rojo de domo sobre su base, con el signo de admiracion. Va grande arriba de la tarjeta
    // (pedido del usuario el 2026-11-20: "en la parte superior debe llevar un icono de boton de panico, no solo una franja").
    // Son capas planas en un cuadro de 100 x 100: el SVG de la vista previa y el PDF dibujan las mismas, asi se ve igual
    const ICON_LAYERS = [
        { t: 'c', r: 50, f: '#ffffff' },      // aro blanco: lo separa de la franja roja
        { t: 'c', r: 46.5, f: '#1f2937' },    // base
        { t: 'c', r: 41, f: '#9ca3af' },      // aro metalico
        { t: 'c', r: 37.5, f: '#374151' },    // ranura
        { t: 'c', r: 34, f: '#991b1b' },      // borde del domo
        { t: 'c', r: 29.5, f: '#dc2626' },    // domo
        { t: 'c', r: 22, f: '#ef4444' },      // centro del domo
        { t: 'e', x: 36, y: 33, rx: 8, ry: 4.5, f: '#fca5a5' }, // brillo
        { t: 'r', x: 45.8, y: 36, w: 8.4, h: 17, rr: 4.2, f: '#ffffff' }, // signo de admiracion
        { t: 'c', x: 50, y: 62, r: 4.7, f: '#ffffff' }
    ];
    const layerSvg = (l) => (l.t === 'c' ? `<circle cx="${l.x == null ? 50 : l.x}" cy="${l.y == null ? 50 : l.y}" r="${l.r}" fill="${l.f}"/>`
        : l.t === 'e' ? `<ellipse cx="${l.x}" cy="${l.y}" rx="${l.rx}" ry="${l.ry}" fill="${l.f}"/>`
            : `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.rr}" fill="${l.f}"/>`);
    function panicIconSvg(size) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${ICON_LAYERS.map(layerSvg).join('')}</svg>`;
    }

    // ── Tarjetas y hojas (milimetros) ──
    const SIZES = {
        chica: { label: 'Chica, para el carro (5.4 x 7.5 cm)', w: 54, h: 75, qr: 36, k: 1 },
        mediana: { label: 'Mediana, para la puerta (8 x 10.2 cm)', w: 80, h: 102, qr: 47, k: 1.4 }
    };
    const PAPERS = {
        carta: { label: 'Carta', w: 215.9, h: 279.4 },
        oficio: { label: 'Oficio', w: 215.9, h: 330.2 }
    };
    // Parte de arriba de la tarjeta: el icono del boton (13 mm en la chica) con el titulo debajo, sobre la franja roja
    const headHeight = (k) => 2.2 * k + 13 * k + 0.5 * k + 3.2 * k;
    const MARGIN = 8;
    const GAP = 4;
    // Cuantas tarjetas caben por hoja y donde empieza la primera (centradas)
    function layout(paperId, sizeId) {
        const paper = PAPERS[paperId] || PAPERS.carta;
        const size = SIZES[sizeId] || SIZES.chica;
        const cols = Math.max(1, Math.floor((paper.w - 2 * MARGIN + GAP) / (size.w + GAP)));
        const rows = Math.max(1, Math.floor((paper.h - 2 * MARGIN + GAP) / (size.h + GAP)));
        const usedW = cols * size.w + (cols - 1) * GAP;
        const usedH = rows * size.h + (rows - 1) * GAP;
        return { paper, size, cols, rows, perPage: cols * rows, x0: (paper.w - usedW) / 2, y0: (paper.h - usedH) / 2 };
    }
    const pages = (total, perPage) => Math.max(1, Math.ceil(total / perPage));

    // Una tarjeta en HTML (la vista previa y la impresion). Todo lo que viene de la base va escapado
    function cardHtml(card, sizeId, svg, condoName) {
        const s = SIZES[sizeId] || SIZES.chica;
        return `<div class="pq-card" style="--k:${s.k};width:${s.w}mm;height:${s.h}mm;">
            <div class="pq-head">${panicIconSvg(`${(13 * s.k).toFixed(2)}mm`)}<span>BOTÓN DE PÁNICO</span></div>
            <div class="pq-qr" style="width:${s.qr}mm;height:${s.qr}mm;">${svg}</div>
            <div class="pq-scan">Escanee en una emergencia</div>
            ${card.unit ? `<div class="pq-unit">${esc(card.unit)}</div>` : ''}
            <div class="pq-name">${esc(card.name)}</div>
            <div class="pq-condo">${esc(condoName || '')}</div>
        </div>`;
    }
    // Estilos de la tarjeta (los mismos en la vista previa y en la impresion: lo que se ve es lo que sale)
    const CARD_CSS = `
        .pq-card { box-sizing:border-box; display:flex; flex-direction:column; align-items:center; background:#fff; color:#0f172a;
            border:0.3mm dashed #94a3b8; border-radius:3mm; overflow:hidden; font-family:Arial, Helvetica, sans-serif; text-align:center;
            -webkit-print-color-adjust:exact; print-color-adjust:exact; break-inside:avoid; page-break-inside:avoid; }
        .pq-head { width:100%; box-sizing:border-box; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:calc(0.5mm * var(--k));
            background:#dc2626; color:#fff; font-weight:900; letter-spacing:0.04em; font-size:calc(3.2mm * var(--k)); line-height:1; padding:calc(1.1mm * var(--k)) 1mm; }
        .pq-head svg { flex:none; }
        .pq-qr { margin-top:calc(1.6mm * var(--k)); flex:none; }
        .pq-qr svg { width:100%; height:100%; display:block; }
        .pq-scan { font-size:calc(2.2mm * var(--k)); color:#b91c1c; font-weight:700; margin-top:calc(0.6mm * var(--k)); }
        .pq-unit { font-size:calc(4.4mm * var(--k)); font-weight:900; line-height:1.1; margin-top:calc(1.1mm * var(--k)); padding:0 2mm; }
        .pq-name { font-size:calc(3mm * var(--k)); font-weight:700; line-height:1.15; margin-top:calc(0.6mm * var(--k)); padding:0 2.5mm;
            display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; }
        .pq-condo { font-size:calc(2mm * var(--k)); color:#64748b; margin-top:auto; margin-bottom:calc(1.4mm * var(--k)); padding:0 2mm;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; box-sizing:border-box; }`;

    // La hoja completa para imprimir (una ventana aparte): cada hoja con las tarjetas que caben, igual que el PDF
    function printHtml(cards, opts) {
        const L = layout(opts.paper, opts.size);
        const chunks = [];
        for (let i = 0; i < cards.length; i += L.perPage) chunks.push(cards.slice(i, i + L.perPage));
        const sheets = chunks.map((chunk) => `<section class="pq-sheet">${chunk.map((c) => cardHtml(c, opts.size, c.svg, opts.condoName)).join('')}</section>`).join('');
        return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${esc(opts.title || 'QR de pánico')}</title><style>
            @page { size: ${L.paper.w}mm ${L.paper.h}mm; margin: 0; }
            html, body { margin:0; padding:0; background:#fff; }
            .pq-sheet { box-sizing:border-box; width:${L.paper.w}mm; height:${L.paper.h}mm; padding:${L.y0.toFixed(2)}mm ${L.x0.toFixed(2)}mm;
                display:grid; grid-template-columns:repeat(${L.cols}, ${L.size.w}mm); grid-auto-rows:${L.size.h}mm; gap:${GAP}mm; align-content:start;
                break-after:page; page-break-after:always; overflow:hidden; }
            .pq-sheet:last-child { break-after:auto; page-break-after:auto; }
            ${CARD_CSS}
        </style></head><body>${sheets}</body></html>`;
    }

    // ── PDF (jsPDF de finanzas/vendor, en milimetros) ──
    // latin1: las fuentes del PDF son Latin-1 (los acentos y la enie si estan; lo demas se cambia por "?")
    const latin1 = (text) => String(text == null ? '' : text).replace(/[^\x00-\xff]/g, '?');
    const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // Dibuja el icono (las mismas capas que el SVG) en un cuadro de `size` mm con su esquina superior izquierda en (x, y)
    function drawPanicIcon(doc, x, y, size) {
        const u = size / 100;
        ICON_LAYERS.forEach((l) => {
            doc.setFillColor(...hexRgb(l.f));
            if (l.t === 'c') doc.circle(x + (l.x == null ? 50 : l.x) * u, y + (l.y == null ? 50 : l.y) * u, l.r * u, 'F');
            else if (l.t === 'e') doc.ellipse(x + l.x * u, y + l.y * u, l.rx * u, l.ry * u, 'F');
            else doc.roundedRect(x + l.x * u, y + l.y * u, l.w * u, l.h * u, l.rr * u, l.rr * u, 'F');
        });
    }
    function fitLines(doc, text, maxW, maxLines) {
        const lines = doc.splitTextToSize(text, maxW);
        if (lines.length <= maxLines) return lines;
        const kept = lines.slice(0, maxLines);
        let last = kept[maxLines - 1];
        while (last.length > 1 && doc.getTextWidth(`${last}...`) > maxW) last = last.slice(0, -1);
        kept[maxLines - 1] = `${last.trimEnd()}...`;
        return kept;
    }
    // Dibuja una tarjeta en (x, y). card.matrix es el QR (qrMatrix)
    function drawCard(doc, card, x, y, sizeId, condoName) {
        const s = SIZES[sizeId] || SIZES.chica;
        const k = s.k;
        const pt = (mm) => mm / 0.3528; // tamano de letra: de milimetros a puntos
        // Borde punteado para recortar
        doc.setDrawColor(148, 163, 184); doc.setLineWidth(0.3); doc.setLineDashPattern([1.2, 1], 0);
        doc.roundedRect(x, y, s.w, s.h, 3, 3, 'S');
        doc.setLineDashPattern([], 0);
        // Franja roja con el icono del boton de panico grande y el titulo debajo (como en la vista previa)
        const iconD = 13 * k;
        const headH = headHeight(k);
        doc.setFillColor(220, 38, 38);
        doc.roundedRect(x, y, s.w, headH, 3, 3, 'F');
        doc.rect(x, y + headH - 3, s.w, 3, 'F');
        drawPanicIcon(doc, x + (s.w - iconD) / 2, y + 1.1 * k, iconD);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(pt(3.2 * k)); doc.setTextColor(255, 255, 255);
        doc.text(latin1('BOTÓN DE PÁNICO'), x + s.w / 2, y + 1.1 * k + iconD + 0.5 * k + 3.2 * k / 2, { align: 'center', baseline: 'middle' });
        // QR (con su margen blanco)
        const m = card.matrix;
        const quiet = 4;
        const cell = s.qr / (m.size + quiet * 2);
        const qx = x + (s.w - s.qr) / 2;
        const qy = y + headH + 1.6 * k;
        doc.setFillColor(255, 255, 255); doc.rect(qx, qy, s.qr, s.qr, 'F');
        doc.setFillColor(0, 0, 0);
        // Un poco mas ancho que el modulo para que no queden rayas blancas entre tramos al ampliar el PDF
        qrRuns(m).forEach((t) => doc.rect(qx + (t.x + quiet) * cell, qy + (t.y + quiet) * cell, t.w * cell + 0.01, cell + 0.01, 'F'));
        // Textos
        const cx = x + s.w / 2;
        let ty = qy + s.qr + 0.6 * k + 2.2 * k * 0.8;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(pt(2.2 * k)); doc.setTextColor(185, 28, 28);
        doc.text('Escanee en una emergencia', cx, ty, { align: 'center' });
        doc.setTextColor(15, 23, 42);
        if (card.unit) {
            ty += 1.1 * k + 4.4 * k * 0.85;
            doc.setFontSize(pt(4.4 * k));
            doc.text(fitLines(doc, latin1(card.unit), s.w - 4, 1), cx, ty, { align: 'center' });
        }
        doc.setFontSize(pt(3 * k));
        const nameLines = fitLines(doc, latin1(card.name), s.w - 5, 2);
        ty += 0.6 * k + 3 * k * 0.85;
        nameLines.forEach((line, i) => doc.text(line, cx, ty + i * 3 * k * 1.15, { align: 'center' }));
        if (condoName) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(pt(2 * k)); doc.setTextColor(100, 116, 139);
            doc.text(fitLines(doc, latin1(condoName), s.w - 4, 1), cx, y + s.h - 1.4 * k - 0.4, { align: 'center' });
        }
    }
    // Todas las tarjetas, hoja por hoja (el documento ya viene creado con el tamano de la hoja, en mm)
    function drawPdf(doc, cards, opts) {
        const L = layout(opts.paper, opts.size);
        cards.forEach((card, i) => {
            const slot = i % L.perPage;
            if (i > 0 && slot === 0) doc.addPage([L.paper.w, L.paper.h], 'portrait');
            const col = slot % L.cols;
            const row = Math.floor(slot / L.cols);
            drawCard(doc, card, L.x0 + col * (L.size.w + GAP), L.y0 + row * (L.size.h + GAP), opts.size, opts.condoName);
        });
        return L;
    }

    return {
        QR_LIB, PUBLIC_ORIGIN, SIZES, PAPERS, MARGIN, GAP, CARD_CSS, ICON_LAYERS, headHeight,
        esc, publicOrigin, panicUrl, parsePanicQuery, functionUrl, callFunction, storageKey, createKeeper, validLink,
        unitLabel, neighbors, fases, select, cardsFor,
        qrMatrix, qrRuns, qrSvg, panicIconSvg, layout, pages, cardHtml, printHtml, latin1, drawCard, drawPdf
    };
});
