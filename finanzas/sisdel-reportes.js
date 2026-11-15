/* ═══════════════════════════════════════════════════════════════
   SISDEL - Reportes de OIKOS: calculos y salidas (Sistema Financiero)
   ───────────────────────────────────────────────────────────────
   Funciones puras que usa la pantalla Reportes de OIKOS (finanzas/index.html). Se prueban en
   scripts/test-finanzas-reportes.mjs.

   - monthBalance: ingresos, egresos y saldo de cada mes, con el total de cada ano y el total general.
     Ingresos = pagos (type 'income'); egresos = gastos (type 'expense'). Los cargos y cuotas ('charge') no
     son dinero que entro: son lo que se cobra. Saldo = ingresos menos egresos del mes.
   - exportModel: convierte un reporte de OIKOS (encabezados, filas con texto ya formateado y totales) en el
     modelo de reportes-export.js (SisdelReportExport), que arma el Excel (.xlsx) y el mensaje de WhatsApp.
     Para el Excel las columnas de montos pasan a numero (se pueden sumar); para WhatsApp quedan con su formato.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelReportesOikos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // Mas de esto (20 anos) solo pasa con una fecha "Desde" mal escrita: se arranca en el primer mes con movimientos
    const MAX_MONTHS = 240;

    const cents = (amount) => Math.round((parseFloat(amount) || 0) * 100);
    const fromCents = (value) => value / 100;
    const monthOf = (dayKey) => String(dayKey || '').slice(0, 7);
    const validMonth = (key) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
    function nextMonth(key) {
        const year = Number(key.slice(0, 4));
        const month = Number(key.slice(5, 7));
        return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    }

    // txs: movimientos vivos de OIKOS. opts: { from, to } ('AAAA-MM-DD', opcionales) y dayKey(fecha ISO) -> dia
    // local 'AAAA-MM-DD' (el mismo criterio de los demas reportes de OIKOS).
    function monthBalance(txs, opts) {
        const options = opts || {};
        const dayKey = typeof options.dayKey === 'function' ? options.dayKey : (iso) => String(iso || '').slice(0, 10);
        const from = options.from || '';
        const to = options.to || '';
        const empty = { months: [], years: [], total: { income: 0, expense: 0, balance: 0 } };
        if (from && to && from > to) return empty;
        const sums = new Map();
        (txs || []).forEach((t) => {
            if (!t || t.deleted || (t.type !== 'income' && t.type !== 'expense') || !t.date) return;
            const day = dayKey(t.date);
            if (from && day < from) return;
            if (to && day > to) return;
            const key = monthOf(day);
            if (!validMonth(key)) return;
            if (!sums.has(key)) sums.set(key, { income: 0, expense: 0 });
            sums.get(key)[t.type] += cents(t.amount);
        });
        const keys = Array.from(sums.keys()).sort();
        let start = from ? monthOf(from) : keys[0];
        const end = to ? monthOf(to) : keys[keys.length - 1];
        if (!start || !end || !validMonth(start) || !validMonth(end) || start > end) return empty;
        // Todos los meses del rango, tambien los que no tuvieron movimientos (se ven en cero)
        let span = 0;
        for (let key = start; key <= end && span <= MAX_MONTHS; key = nextMonth(key)) span++;
        if (span > MAX_MONTHS) {
            if (!keys.length) return empty;
            start = keys[0];
        }
        const months = [];
        const years = new Map();
        const total = { income: 0, expense: 0 };
        for (let key = start; key <= end; key = nextMonth(key)) {
            const s = sums.get(key) || { income: 0, expense: 0 };
            const year = Number(key.slice(0, 4));
            months.push({ key, year, month: Number(key.slice(5, 7)), income: fromCents(s.income), expense: fromCents(s.expense), balance: fromCents(s.income - s.expense) });
            if (!years.has(year)) years.set(year, { income: 0, expense: 0 });
            years.get(year).income += s.income;
            years.get(year).expense += s.expense;
            total.income += s.income;
            total.expense += s.expense;
        }
        return {
            months,
            years: Array.from(years.entries()).map(([year, s]) => ({ year, income: fromCents(s.income), expense: fromCents(s.expense), balance: fromCents(s.income - s.expense) })),
            total: { income: fromCents(total.income), expense: fromCents(total.expense), balance: fromCents(total.income - total.expense) }
        };
    }

    // Texto de una celda que puede traer HTML (p. ej. el boton del No. de documento)
    function plain(value) {
        if (value === null || value === undefined) return '';
        const text = String(value);
        if (text.indexOf('<') < 0 && text.indexOf('&') < 0) return text.trim();
        return text.replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
            .trim();
    }

    // Monto con formato de OIKOS ('Q1,234.50', 'Q-50.00', '$0.00') o cantidad ('12') -> numero; null si no es un monto
    // (un texto como 'Lote 5' no lo es: el simbolo de la moneda tiene a lo mas tres letras)
    function moneyValue(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        const match = /^(-?)\s*[^\d\s.,-]{0,3}\s*(-?)(\d[\d,]*(?:\.\d+)?)$/.exec(plain(value));
        if (!match) return null;
        const number = Number(match[3].replace(/,/g, ''));
        if (!Number.isFinite(number)) return null;
        return match[1] === '-' || match[2] === '-' ? -number : number;
    }

    function slug(text) {
        return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    }

    // report: { title, summary, headers, rows, rowsMeta, totals, numericCols }. opts: { condoName, at, excel }
    function exportModel(report, opts) {
        const options = opts || {};
        const numeric = new Set(report.numericCols || []);
        const meta = report.rowsMeta || [];
        const at = options.at || new Date();
        const cell = (value, index, bold) => {
            const text = plain(value);
            let out = text;
            if (options.excel && numeric.has(index)) {
                const number = moneyValue(text);
                if (number !== null) out = number;
            }
            return bold ? { v: out, s: 1 } : out;
        };
        const rows = (report.rows || []).map((row, r) => row.map((value, i) => cell(value, i, !!(meta[r] && meta[r].kind === 'subtotal'))));
        const totals = report.totals ? report.totals.map((value, i) => cell(value, i, true)) : null;
        if (totals && options.excel) rows.push(totals);
        // Los totales van tambien como cifras de resumen: en WhatsApp se ven aunque la tabla se recorte
        const kpis = [];
        if (report.totals) {
            report.totals.forEach((value, i) => {
                if (i === 0 || !numeric.has(i) || plain(value) === '') return;
                const header = plain((report.headers || [])[i]);
                const label = /^total\b/i.test(header) ? header : `Total ${header.toLowerCase()}`;
                const number = moneyValue(value);
                kpis.push({ label, value: options.excel && number !== null ? number : plain(value) });
            });
        }
        const day = at instanceof Date && !Number.isNaN(at.getTime())
            ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
            : '';
        return {
            title: plain(report.title) || 'Reporte',
            subtitle: plain(report.summary),
            condoName: options.condoName || '',
            at,
            kpis,
            tables: [{ title: '', headers: (report.headers || []).map(plain), rows, numeric: [] }],
            fileName: slug([report.title, options.condoName, day].filter(Boolean).join(' ')) || 'reporte'
        };
    }

    return { MAX_MONTHS, monthBalance, plain, moneyValue, slug, exportModel };
});
