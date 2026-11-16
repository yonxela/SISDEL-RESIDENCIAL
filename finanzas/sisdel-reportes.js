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

    // ───────── Mapa de pagos por residente ─────────
    // Por cada residente, cada ano anterior y cada mes del ano en curso (hasta hoy):
    //   'owed'    = debe algo de ese periodo y ya vencio (rojo)
    //   'pending' = debe algo de ese periodo pero aun no vence (amarillo; no es mora)
    //   'paid'    = tuvo cuotas o cargos y estan pagados (verde)
    //   'none'    = no tuvo cuotas ni cargos (gris)
    // Los pagos de cada residente cubren sus cuotas y cargos del mas antiguo al mas nuevo (el mismo reparto del reporte
    // de Morosos de OIKOS): una cuota por su mes (period) y un cargo suelto por el mes de su fecha.
    // opts: { today 'AAAA-MM-DD', dayKey, feePeriodOf(t) -> 'AAAA-MM' o null, dueOf(period) -> ultimo dia 'AAAA-MM-DD'
    // para pagar sin estar en mora, maxYears (columnas de anos; los anteriores se juntan en "Antes de ..."),
    // totalOf(r) -> lo que debe en total (con la mora del dia: el saldo de Residentes), moraOf(r) -> la mora a hoy,
    // paidBefore(r) -> 'AAAA-MM' o null: los meses anteriores sin cuota cuentan como pagados (un condominio cargado
    // desde una cartera que solo traia lo que se debe: lo que no aparece, estaba pagado) }.
    // Orden: de mayor a menor total que debe (con totalOf, el saldo con mora; si no, lo vencido mas lo por vencer); a
    // igual, mas meses en mora; al final los que estan al dia, en su orden.
    const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const periodLabel = (period) => `${MONTHS_SHORT[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

    function paymentMap(residents, txs, opts) {
        const options = opts || {};
        const dayKey = dayKeyOf(options);
        const today = options.today || dayKey(new Date().toISOString());
        const curMonth = monthOf(today);
        const curYear = Number(today.slice(0, 4));
        const maxYears = options.maxYears || 6;
        const feePeriodOf = typeof options.feePeriodOf === 'function' ? options.feePeriodOf : (t) => (t.kind === 'fee' && validMonth(String(t.period || '')) ? t.period : null);
        const dueOf = typeof options.dueOf === 'function' ? options.dueOf : (period) => `${period}-31`;
        const statusOf = (period, owed) => (owed > 0 ? (today > dueOf(period) ? 'owed' : 'pending') : 'paid');

        const byResident = new Map();
        (txs || []).forEach((t) => {
            if (!t || t.deleted || (t.type !== 'charge' && t.type !== 'income')) return;
            if (t.resiId === undefined || t.resiId === null || t.resiId === '') return;
            const id = String(t.resiId);
            if (!byResident.has(id)) byResident.set(id, []);
            byResident.get(id).push(t);
        });

        let firstYear = curYear;
        const computed = (residents || []).map((r, index) => {
            let credit = 0;
            const charges = [];
            (byResident.get(String(r.id)) || []).forEach((t) => {
                if (t.type === 'income') { credit += cents(t.amount); return; }
                const fee = feePeriodOf(t);
                const day = t.date ? dayKey(t.date) : '';
                const period = fee || monthOf(day);
                if (!validMonth(period)) return;
                charges.push({ period, sort: fee ? `${period}-00` : day, amount: cents(t.amount) });
            });
            // Del mas antiguo al mas nuevo (sort es estable: a igual fecha, en su orden)
            charges.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
            const periods = new Map();
            charges.forEach((c) => {
                const paid = Math.min(Math.max(credit, 0), c.amount);
                credit -= paid;
                const p = periods.get(c.period) || { charged: 0, owed: 0 };
                p.charged += c.amount;
                p.owed += c.amount - paid;
                periods.set(c.period, p);
            });
            let lateMonths = 0;
            let lateTotal = 0;
            let pendingTotal = 0;
            let since = null;
            periods.forEach((p, period) => {
                // Cuotas de meses que aun no llegan: no se muestran, pero lo que deben va con lo por vencer
                if (period > curMonth) { pendingTotal += p.owed; return; }
                firstYear = Math.min(firstYear, Number(period.slice(0, 4)));
                const status = statusOf(period, p.owed);
                if (status === 'owed') {
                    lateMonths++;
                    lateTotal += p.owed;
                    if (!since || period < since) since = period;
                } else if (status === 'pending') pendingTotal += p.owed;
            });
            return { resident: r, index, periods, lateMonths, lateTotal, pendingTotal, since };
        });

        // Columnas: los anos anteriores (los mas viejos juntos) y los meses del ano en curso hasta hoy
        const columns = [];
        const lastYear = curYear - 1;
        const fromYear = Math.max(firstYear, lastYear - maxYears + 1);
        if (firstYear < fromYear) columns.push({ key: 'older', kind: 'years', label: `Antes de ${fromYear}`, years: [firstYear, fromYear - 1] });
        for (let y = fromYear; y <= lastYear; y++) columns.push({ key: String(y), kind: 'years', label: `Año ${y}`, years: [y, y] });
        for (let key = `${curYear}-01`; key <= curMonth; key = nextMonth(key)) columns.push({ key, kind: 'month', label: periodLabel(key) });

        const totals = {};
        columns.forEach((c) => { totals[c.key] = 0; });
        let anyAssumed = false;
        computed.forEach((x) => {
            const raw = typeof options.paidBefore === 'function' ? String(options.paidBefore(x.resident) || '').slice(0, 7) : '';
            x.paidBefore = validMonth(raw) ? raw : null;
        });
        const rows = computed.map((x) => {
            const cells = {};
            columns.forEach((c) => {
                let charged = 0;
                let late = 0;
                let pending = 0;
                x.periods.forEach((p, period) => {
                    if (period > curMonth) return;
                    const inColumn = c.kind === 'month' ? period === c.key : (Number(period.slice(0, 4)) >= c.years[0] && Number(period.slice(0, 4)) <= c.years[1]);
                    if (!inColumn) return;
                    charged += p.charged;
                    const status = statusOf(period, p.owed);
                    if (status === 'owed') late += p.owed;
                    else if (status === 'pending') pending += p.owed;
                });
                // Meses dados por pagados: anteriores a paidBefore, ya llegados y sin ninguna cuota ni cargo
                let assumed = 0;
                if (x.paidBefore) {
                    const fromKey = c.kind === 'month' ? c.key : `${c.years[0]}-01`;
                    const toKey = c.kind === 'month' ? c.key : `${c.years[1]}-12`;
                    for (let key = fromKey; key <= toKey && key <= curMonth && key < x.paidBefore; key = nextMonth(key)) {
                        if (!x.periods.has(key)) assumed++;
                    }
                }
                const status = late > 0 ? 'owed' : pending > 0 ? 'pending' : (charged > 0 || assumed > 0) ? 'paid' : 'none';
                cells[c.key] = { status, owed: fromCents(late + pending), late: fromCents(late), assumed: status === 'paid' && charged === 0 };
                if (assumed > 0) anyAssumed = true;
                totals[c.key] += late;
            });
            const fallback = fromCents(x.lateTotal + x.pendingTotal);
            const total = typeof options.totalOf === 'function' ? Number(options.totalOf(x.resident)) : fallback;
            const mora = typeof options.moraOf === 'function' ? Number(options.moraOf(x.resident)) : 0;
            return {
                resident: x.resident, cells, lateMonths: x.lateMonths, lateTotal: fromCents(x.lateTotal),
                pendingTotal: fromCents(x.pendingTotal), since: x.since, sinceLabel: x.since ? periodLabel(x.since) : '', index: x.index,
                mora: Number.isFinite(mora) && mora > 0 ? fromCents(cents(mora)) : 0,
                totalOwed: Number.isFinite(total) && total > 0 ? fromCents(cents(total)) : 0
            };
        });
        // De mayor a menor lo que debe en total; a igual, mas meses en mora y mas vencido; despues, en su orden
        rows.sort((a, b) => (b.totalOwed - a.totalOwed) || (b.lateMonths - a.lateMonths) || (b.lateTotal - a.lateTotal) || (a.index - b.index));
        Object.keys(totals).forEach((k) => { totals[k] = fromCents(totals[k]); });
        return {
            columns,
            rows,
            totals,
            assumedPaid: anyAssumed,
            late: rows.filter((r) => r.lateMonths > 0).length,
            pending: rows.filter((r) => r.lateMonths === 0 && r.pendingTotal > 0).length,
            upToDate: rows.filter((r) => r.lateMonths === 0 && r.pendingTotal === 0).length
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

    // Estilos del Excel de reportes-export.js para las celdas de color del mapa de pagos
    const STATUS_STYLE = { owed: 4, paid: 5, pending: 6 };

    // report: { title, summary, notice, headers, rows, rowsMeta, totals, numericCols, cellStatus, compact }.
    // cellStatus[fila][columna] = 'owed' | 'paid' | 'pending' | 'none' pinta la celda en el Excel (rojo, verde, amarillo).
    // compact = { headers, rows, numericCols }: version corta para WhatsApp (el mapa de pagos tiene demasiadas columnas).
    // opts: { condoName, at, excel }
    function exportModel(fullReport, opts) {
        const options = opts || {};
        const report = !options.excel && fullReport.compact ? { ...fullReport, ...fullReport.compact, rowsMeta: [], cellStatus: null } : fullReport;
        const numeric = new Set(report.numericCols || []);
        const meta = report.rowsMeta || [];
        const status = report.cellStatus || [];
        const at = options.at || new Date();
        const cell = (value, index, bold, fill) => {
            const text = plain(value);
            let out = text;
            if (options.excel && numeric.has(index)) {
                const number = moneyValue(text);
                if (number !== null) out = number;
            }
            if (options.excel && fill) return { v: out, s: fill };
            return bold ? { v: out, s: 1 } : out;
        };
        const rows = (report.rows || []).map((row, r) => row.map((value, i) => cell(value, i, !!(meta[r] && meta[r].kind === 'subtotal'), STATUS_STYLE[(status[r] || [])[i]])));
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

    return { MAX_MONTHS, monthBalance, periodSummary, paymentMap, periodLabel, plain, moneyValue, slug, exportModel };
});
