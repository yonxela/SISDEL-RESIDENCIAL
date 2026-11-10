/* ═══════════════════════════════════════════════════════════════
   SISDEL - Acciones comunes de los reportes
   ───────────────────────────────────────────────────────────────
   Todos los reportes ofrecen lo mismo: Imprimir, Descargar PDF, Enviar por WhatsApp y Exportar a Excel.
   Cada reporte arma un "modelo" con sus datos en bruto (sin HTML) y este modulo lo convierte:

     model = {
       title: 'Visitas del periodo',          // titulo del reporte
       subtitle: '1 de noviembre al 7 de noviembre de 2026',
       condoName: 'Villa Ferrer', userName: 'Fernando', at: Date,
       kpis:   [{ label: 'Visitas dentro', value: 3 }],
       tables: [{ title: 'Visitas', headers: ['Fecha', 'Visitante'], rows: [['2026-11-01', 'Ana']], numeric: [1] }],
       excelExtra: [{ title, headers, rows }],  // hojas que solo van en el Excel (listados completos)
       fileName: 'visitas-villa-ferrer-2026-11-01'
     }

   - Excel: un .xlsx de verdad (se arma aqui mismo, sin librerias), una hoja por tabla.
   - PDF: jsPDF y AutoTable, los mismos que ya usa OIKOS (finanzas/vendor); se cargan al pulsar el boton.
   - WhatsApp: abre WhatsApp con un resumen en texto (WhatsApp no recibe archivos por enlace); el documento
     completo se baja con PDF o Excel.
   - Imprimir: window.print() (la pagina oculta todo menos el reporte).
   Puede cargarse en el navegador y en Node (las pruebas llaman buildXlsx, whatsappText y latin1).
   ═══════════════════════════════════════════════════════════════ */

const SisdelReportExport = (() => {
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const MAX_WA_ROWS = 12;      // filas por tabla en el mensaje de WhatsApp
    const MAX_WA_CHARS = 3400;   // el enlace de WhatsApp lleva el texto codificado: se mantiene corto
    const MAX_CELL_CHARS = 32000;

    const ICONS = {
        print: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
        pdf: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="18" x2="13" y2="18"/></svg>',
        whatsapp: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.5A8.5 8.5 0 1 1 21 11.5z"/><path d="M9 9.5c.3 2 2.5 4.2 4.7 4.8l1.3-1.3-1.8-1-.8.8a3.6 3.6 0 0 1-1.7-1.7l.8-.8-1-1.8z"/></svg>',
        excel: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="12" x2="16" y2="20"/><line x1="16" y1="12" x2="8" y2="20"/></svg>'
    };

    const pad = (n) => String(n).padStart(2, '0');
    const str = (value) => (value === null || value === undefined ? '' : String(value));
    const slug = (text) => str(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const fmtDate = (date) => { try { return new Date(date).toLocaleString('es-GT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
    const isNumeric = (value) => typeof value === 'number' ? Number.isFinite(value) : /^-?\d+(\.\d+)?$/.test(str(value).trim());

    // Texto apto para el PDF (jsPDF usa fuentes Latin-1): las flechas y demas simbolos se reemplazan
    function latin1(value) {
        return str(value)
            .replace(/[→⇒➔➜]/g, '->').replace(/[←⇐]/g, '<-').replace(/[–—−]/g, '-')
            .replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[•·]/g, '-')
            .replace(/[^\u0000-ÿ]/g, '?');
    }

    // ───────── ZIP (sin compresion) y XLSX ─────────
    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();
    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    // files: [{ name, data: Uint8Array }]. Entradas "stored" con la fecha fija 1980-01-01 (resultado repetible)
    function zip(files) {
        const encoder = new TextEncoder();
        const locals = [];
        const centrals = [];
        let offset = 0;
        files.forEach((file) => {
            const name = encoder.encode(file.name);
            const crc = crc32(file.data);
            const local = new Uint8Array(30 + name.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
            lv.setUint16(10, 0, true); lv.setUint16(12, 0x0021, true); lv.setUint32(14, crc, true);
            lv.setUint32(18, file.data.length, true); lv.setUint32(22, file.data.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
            local.set(name, 30);
            const central = new Uint8Array(46 + name.length);
            const cv = new DataView(central.buffer);
            cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
            cv.setUint16(12, 0, true); cv.setUint16(14, 0x0021, true); cv.setUint32(16, crc, true);
            cv.setUint32(20, file.data.length, true); cv.setUint32(24, file.data.length, true); cv.setUint16(28, name.length, true);
            cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
            central.set(name, 46);
            locals.push(local, file.data);
            centrals.push(central);
            offset += local.length + file.data.length;
        });
        const centralSize = centrals.reduce((n, c) => n + c.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
        ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
        const parts = [...locals, ...centrals, end];
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        parts.forEach((p) => { out.set(p, at); at += p.length; });
        return out;
    }

    const xml = (value) => str(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function colName(index) {
        let n = index + 1;
        let name = '';
        while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
        return name;
    }
    // Nombre de hoja valido en Excel: hasta 31 caracteres, sin [ ] : * ? / \ y sin repetirse
    function sheetName(title, used) {
        let base = str(title).replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Reporte';
        let name = base;
        let n = 2;
        while (used.has(name.toLowerCase())) { const suffix = ` ${n++}`; name = base.slice(0, 31 - suffix.length) + suffix; }
        used.add(name.toLowerCase());
        return name;
    }

    // Estilos de celda: 0 normal, 1 negrita, 2 encabezado de tabla, 3 titulo
    const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
        + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    // rows: [[{ v, s }|valor]] -> hoja. Las cadenas van como texto en linea (no se interpretan como formulas)
    function sheetXml(rows) {
        const widths = [];
        const body = rows.map((row, r) => {
            const cells = row.map((cell, c) => {
                const item = cell && typeof cell === 'object' && 'v' in cell ? cell : { v: cell };
                if (item.v === null || item.v === undefined || item.v === '') return '';
                const ref = colName(c) + (r + 1);
                const style = item.s ? ` s="${item.s}"` : '';
                // Los titulos y la linea de "generado por" no ensanchan la columna: el ancho lo dan la tabla y sus datos
                const length = typeof item.v === 'number' ? String(item.v).length : str(item.v).length;
                if (!item.nw) widths[c] = Math.max(widths[c] || 0, Math.min(length, 60));
                if (typeof item.v === 'number' && Number.isFinite(item.v)) return `<c r="${ref}"${style}><v>${item.v}</v></c>`;
                return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(str(item.v).slice(0, MAX_CELL_CHARS))}</t></is></c>`;
            }).join('');
            return `<row r="${r + 1}">${cells}</row>`;
        }).join('');
        const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, (w || 0) + 2)}" customWidth="1"/>`).join('');
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + (cols ? `<cols>${cols}</cols>` : '') + `<sheetData>${body}</sheetData></worksheet>`;
    }

    // Convierte los valores de una tabla: las columnas numericas pasan a numero
    function tableRows(table) {
        const numeric = new Set(table.numeric || []);
        return (table.rows || []).map((row) => row.map((value, i) => (numeric.has(i) && isNumeric(value) ? Number(value) : value)));
    }

    function buildXlsx(model) {
        const used = new Set();
        const sheets = [];
        const head = (table) => {
            const rows = [[{ v: model.title, s: 3, nw: true }]];
            if (model.subtitle) rows.push([{ v: model.subtitle, nw: true }]);
            const meta = [model.condoName, model.at ? `Generado el ${fmtDate(model.at)}` : '', model.userName ? `por ${model.userName}` : ''].filter(Boolean).join(' · ');
            if (meta) rows.push([{ v: meta, nw: true }]);
            rows.push([]);
            if (!sheets.length) {
                (model.kpis || []).forEach((k) => rows.push([{ v: k.label, s: 1 }, isNumeric(k.value) ? Number(k.value) : k.value]));
                if ((model.kpis || []).length) rows.push([]);
            }
            if (table.title) { rows.push([{ v: table.title, s: 1, nw: true }]); }
            return rows;
        };
        const tables = [...(model.tables || []), ...(model.excelExtra || [])];
        if (!tables.length) tables.push({ title: '', headers: [], rows: [] });
        tables.forEach((table) => {
            const rows = head(table);
            if ((table.headers || []).length) rows.push(table.headers.map((h) => ({ v: h, s: 2 })));
            tableRows(table).forEach((row) => rows.push(row));
            sheets.push({ name: sheetName(table.title || model.title, used), xml: sheetXml(rows) });
        });
        const encoder = new TextEncoder();
        const files = [
            { name: '[Content_Types].xml', data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
                + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
            { name: '_rels/.rels', data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
            { name: 'xl/workbook.xml', data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                + sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>') },
            { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
                + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
            { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
            ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: encoder.encode(s.xml) }))
        ];
        return zip(files);
    }

    // ───────── WhatsApp ─────────
    function whatsappText(model) {
        const lines = [];
        if (model.condoName) lines.push(`*${model.condoName}*`);
        lines.push(`*${model.title}*${model.subtitle ? ` - ${model.subtitle}` : ''}`);
        lines.push(`Generado: ${model.at ? fmtDate(model.at) : ''}${model.userName ? ` por ${model.userName}` : ''}`.trim());
        if ((model.kpis || []).length) {
            lines.push('');
            model.kpis.forEach((k) => lines.push(`- ${k.label}: *${k.value}*`));
        }
        (model.tables || []).forEach((table) => {
            lines.push('');
            if (table.title) lines.push(`*${table.title}*`);
            if (!(table.rows || []).length) { lines.push('Sin datos en el periodo.'); return; }
            if ((table.headers || []).length) lines.push(`(${table.headers.join(' | ')})`);
            table.rows.slice(0, MAX_WA_ROWS).forEach((row) => lines.push(row.map(str).filter((c) => c !== '' && c !== '—').join(' · ')));
            if (table.rows.length > MAX_WA_ROWS) lines.push(`... y ${table.rows.length - MAX_WA_ROWS} fila(s) más (vea el PDF o el Excel para el detalle completo)`);
        });
        lines.push('', '_Enviado desde SISDEL_');
        let text = lines.join('\n');
        if (text.length > MAX_WA_CHARS) text = `${text.slice(0, MAX_WA_CHARS - 50)}\n... (mensaje recortado, vea el PDF o el Excel)`;
        return text;
    }
    const whatsappUrl = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

    // ───────── PDF (jsPDF + AutoTable, los de OIKOS) ─────────
    const scriptLoads = new Map();
    function loadScript(src) {
        if (!scriptLoads.has(src)) {
            scriptLoads.set(src, new Promise((resolve, reject) => {
                const tag = document.createElement('script');
                tag.src = src;
                tag.onload = resolve;
                tag.onerror = () => { scriptLoads.delete(src); reject(new Error(`No se pudo cargar ${src}`)); };
                document.head.appendChild(tag);
            }));
        }
        return scriptLoads.get(src);
    }
    async function ensurePdfLibs(base = '') {
        if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript(`${base}finanzas/vendor/jspdf.umd.min.js`);
        if (!window.jspdf.jsPDF.API.autoTable) await loadScript(`${base}finanzas/vendor/jspdf.plugin.autotable.min.js`);
    }

    function makePdf(model) {
        const { jsPDF } = window.jspdf;
        const tables = model.tables || [];
        const landscape = tables.some((t) => (t.headers || []).length > 6);
        const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
        const margin = 36;
        const width = doc.internal.pageSize.getWidth();
        let y = 40;
        if (model.condoName) { doc.setFontSize(10); doc.setTextColor(100); doc.text(latin1(model.condoName), margin, y); y += 18; }
        doc.setFontSize(16); doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.text(latin1(model.title), margin, y); y += 16;
        doc.setFont('helvetica', 'normal');
        if (model.subtitle) { doc.setFontSize(10); doc.setTextColor(70); doc.text(latin1(model.subtitle), margin, y); y += 14; }
        doc.setFontSize(8); doc.setTextColor(110);
        doc.text(latin1(`Generado el ${model.at ? fmtDate(model.at) : ''}${model.userName ? ` por ${model.userName}` : ''}`), margin, y);
        y += 12;
        const headStyles = { fillColor: [51, 65, 85], textColor: 255, fontSize: 8 };
        if ((model.kpis || []).length) {
            doc.autoTable({
                startY: y, margin: { left: margin, right: margin }, theme: 'grid', styles: { fontSize: 9, cellPadding: 4 },
                head: [['Indicador', 'Valor']], body: model.kpis.map((k) => [latin1(k.label), latin1(k.value)]),
                headStyles, columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } }, tableWidth: Math.min(320, width - margin * 2)
            });
            y = doc.lastAutoTable.finalY + 14;
        }
        tables.forEach((table) => {
            if (table.title) {
                if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 40; }
                doc.setFontSize(11); doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.text(latin1(table.title), margin, y + 4); doc.setFont('helvetica', 'normal'); y += 10;
            }
            if (!(table.rows || []).length) {
                doc.setFontSize(9); doc.setTextColor(110); doc.text('Sin datos en el periodo.', margin, y + 12); y += 28;
                return;
            }
            const columnStyles = {};
            (table.numeric || []).forEach((i) => { columnStyles[i] = { halign: 'right' }; });
            doc.autoTable({
                startY: y, margin: { left: margin, right: margin }, theme: 'striped', styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
                head: [(table.headers || []).map(latin1)], body: table.rows.map((row) => row.map(latin1)), headStyles, columnStyles
            });
            y = doc.lastAutoTable.finalY + 16;
        });
        const pages = doc.internal.getNumberOfPages();
        const height = doc.internal.pageSize.getHeight();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i);
            doc.setFontSize(8); doc.setTextColor(120);
            doc.text(`Pagina ${i} de ${pages}`, width - margin, height - 20, { align: 'right' });
            doc.text('SISDEL', margin, height - 20);
        }
        return doc;
    }

    // ───────── Botones ─────────
    // allow: { print, pdf, whatsapp, excel } (cada uno segun el privilegio que lo permite)
    function actionsHtml(allow = {}) {
        const buttons = [
            ['print', 'Imprimir', 'btn btn-ghost btn-sm'],
            ['pdf', 'Descargar PDF', 'btn btn-ghost btn-sm'],
            ['whatsapp', 'Enviar por WhatsApp', 'btn btn-ghost btn-sm'],
            ['excel', 'Exportar a Excel', 'btn btn-primary btn-sm']
        ].filter(([id]) => allow[id]);
        if (!buttons.length) return '';
        return `<div class="rx-actions rp-noprint no-print" style="display:flex; flex-wrap:wrap; gap:0.5rem;">${buttons.map(([id, label, cls]) => `<button type="button" class="${cls}" data-rx="${id}">${ICONS[id]} ${label}</button>`).join('')}</div>`;
    }

    function download(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    const notify = (message, type) => { try { if (typeof SISDEL !== 'undefined') SISDEL.showToast(message, type || 'warning'); else alert(message); } catch { /* sin aviso */ } };

    // Conecta los botones de root con el reporte actual (getModel() devuelve el modelo o null)
    function bind(root, getModel, options = {}) {
        root.querySelectorAll('[data-rx]').forEach((button) => button.addEventListener('click', async () => {
            const model = getModel();
            if (!model) { notify('Genere el reporte primero.'); return; }
            const action = button.dataset.rx;
            const fileName = model.fileName || slug(model.title) || 'reporte';
            try {
                if (action === 'print') window.print();
                else if (action === 'excel') download(new Blob([buildXlsx(model)], { type: XLSX_MIME }), `${fileName}.xlsx`);
                else if (action === 'whatsapp') window.open(whatsappUrl(whatsappText(model)), '_blank', 'noopener,noreferrer');
                else if (action === 'pdf') {
                    button.disabled = true;
                    await ensurePdfLibs(options.base || '');
                    makePdf(model).save(`${fileName}.pdf`);
                }
            } catch (error) {
                console.error('reporte', action, error);
                notify('No se pudo generar el archivo. Intente de nuevo.', 'error');
            } finally {
                button.disabled = false;
            }
        }));
    }

    return { buildXlsx, whatsappText, whatsappUrl, makePdf, ensurePdfLibs, actionsHtml, bind, latin1, sheetName, zip, crc32, slug, ICONS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SisdelReportExport;
