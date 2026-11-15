/* ═══════════════════════════════════════════════════════════════
   SISDEL - Reportes de OIKOS: calculos y salidas (Sistema Financiero)
   ───────────────────────────────────────────────────────────────
   Funciones puras que usa la pantalla Reportes de OIKOS (finanzas/index.html). Se prueban en
   scripts/test-finanzas-reportes.mjs.

   - monthBalance: ingresos, egresos y saldo de cada mes, con el total de cada ano y el total general.
     Ingresos = pagos (type 'income'); egresos = gastos (type 'expense'). Los cargos y cuotas ('charge') no
     son dinero que entro: son lo que se cobra. Saldo = ingresos menos egresos del mes.
     Aparte (sin mezclarlo con la caja): cuotas y cargos emitidos en el mes y lo que queda por cobrar al cierre.
   - periodSummary: lo mismo para un periodo (la ventana "Reporte financiero").
   - Por cobrar al cierre = de cada vecino, sus cuotas y cargos menos sus pagos hasta ese dia (si pago de mas, cuenta
     cero, no resta lo de otros), sumado. Es el mismo total del reporte de Morosos (sin la mora por dia, que no se
     guarda como movimiento). Con opts.residents (ids de los vecinos vigentes) solo cuentan ellos, como en Morosos.
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

    const dayKeyOf = (options) => (typeof options.dayKey === 'function' ? options.dayKey : (iso) => String(iso || '').slice(0, 10));
    const zeroSums = () => ({ income: 0, expense: 0, charge: 0 });
    const totalsOf = (s, receivable) => ({
        income: fromCents(s.income), expense: fromCents(s.expense), balance: fromCents(s.income - s.expense),
        charges: fromCents(s.charge), receivable: fromCents(receivable)
    });

    // Lo que se debe al cierre de cada dia, avanzando en orden: advanceTo(dia) devuelve el total por cobrar (centavos)
    // con todas las cuotas, cargos y pagos de los vecinos hasta ese dia (de cualquier fecha anterior, aunque quede
    // antes del rango del reporte).
    function receivableTracker(txs, options) {
        const dayKey = dayKeyOf(options);
        const only = options.residents ? new Set(Array.from(options.residents, String)) : null;
        const ledger = [];
        (txs || []).forEach((t) => {
            if (!t || t.deleted || !t.date || (t.type !== 'income' && t.type !== 'charge')) return;
            if (t.resiId === undefined || t.resiId === null || t.resiId === '') return;
            const id = String(t.resiId);
            if (only && !only.has(id)) return;
            ledger.push({ day: dayKey(t.date), id, delta: t.type === 'charge' ? cents(t.amount) : -cents(t.amount) });
        });
        ledger.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
        const owed = new Map();
        let total = 0;
        let next = 0;
        return function advanceTo(cutoff) {
            while (next < ledger.length && (!cutoff || ledger[next].day <= cutoff)) {
                const e = ledger[next++];
                const before = owed.get(e.id) || 0;
                const after = before + e.delta;
                owed.set(e.id, after);
                total += Math.max(0, after) - Math.max(0, before);
            }
            return total;
        };
    }

    // Movimientos del rango sumados por mes (pagos, gastos y cargos)
    function sumsByMonth(txs, options) {
        const dayKey = dayKeyOf(options);
        const from = options.from || '';
        const to = options.to || '';
        const sums = new Map();
        (txs || []).forEach((t) => {
            if (!t || t.deleted || (t.type !== 'income' && t.type !== 'expense' && t.type !== 'charge') || !t.date) return;
            const day = dayKey(t.date);
            if (from && day < from) return;
            if (to && day > to) return;
            const key = monthOf(day);
            if (!validMonth(key)) return;
            if (!sums.has(key)) sums.set(key, zeroSums());
            sums.get(key)[t.type] += cents(t.amount);
        });
        return sums;
    }

    // Un periodo (dias 'AAAA-MM-DD', opcionales): { income, expense, balance, charges, receivable }. Por cobrar es al
    // cierre del periodo (sin 'to', con todo lo registrado).
    function periodSummary(txs, opts) {
        const options = opts || {};
        const s = zeroSums();
        if (!(options.from && options.to && options.from > options.to)) {
            sumsByMonth(txs, options).forEach((m) => { s.income += m.income; s.expense += m.expense; s.charge += m.charge; });
        }
        return totalsOf(s, receivableTracker(txs, options)(options.to || ''));
    }

    // txs: movimientos vivos de OIKOS. opts: { from, to } ('AAAA-MM-DD', opcionales), dayKey(fecha ISO) -> dia local
    // 'AAAA-MM-DD' (el mismo criterio de los demas reportes de OIKOS) y residents (ids de los vecinos vigentes).
    // Cada mes, ano y el total traen income, expense, balance, charges y receivable (por cobrar al cierre: el del
    // ultimo dia del mes, o el dia 'to' si el rango termina antes).
    function monthBalance(txs, opts) {
        const options = opts || {};
        const from = options.from || '';
        const to = options.to || '';
        const empty = { months: [], years: [], total: totalsOf(zeroSums(), 0) };
        if (from && to && from > to) return empty;
        const sums = sumsByMonth(txs, options);
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
        const advanceTo = receivableTracker(txs, options);
        const months = [];
        const years = new Map();
        const total = zeroSums();
        let receivable = 0;
        for (let key = start; key <= end; key = nextMonth(key)) {
            const s = sums.get(key) || zeroSums();
            const year = Number(key.slice(0, 4));
            // Cierre del mes: su ultimo dia ('-31' compara bien con cualquier dia del mes) o 'to' si cae antes
            receivable = advanceTo(to && monthOf(to) === key ? to : `${key}-31`);
            months.push({ key, year, month: Number(key.slice(5, 7)), ...totalsOf(s, receivable) });
            if (!years.has(year)) years.set(year, { s: zeroSums(), receivable: 0 });
            const y = years.get(year);
            ['income', 'expense', 'charge'].forEach((k) => { y.s[k] += s[k]; total[k] += s[k]; });
            y.receivable = receivable;
        }
        return {
            months,
            years: Array.from(years.entries()).map(([year, y]) => ({ year, ...totalsOf(y.s, y.receivable) })),
            total: totalsOf(total, receivable)
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

    // report: { title, summary, notice, headers, rows, rowsMeta, totals, numericCols }. opts: { condoName, at, excel }
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
            // El aviso (p. ej. que no hay pagos ni gastos en el periodo) tambien va al Excel y a WhatsApp
            subtitle: [plain(report.summary), plain(report.notice)].filter(Boolean).join(' · '),
            condoName: options.condoName || '',
            at,
            kpis,
            tables: [{ title: '', headers: (report.headers || []).map(plain), rows, numeric: [] }],
            fileName: slug([report.title, options.condoName, day].filter(Boolean).join(' ')) || 'reporte'
        };
    }

    return { MAX_MONTHS, monthBalance, periodSummary, plain, moneyValue, slug, exportModel };
});
