/* ═══════════════════════════════════════════════════════════════
   SISDEL - Mora por dia (Sistema Financiero)
   ───────────────────────────────────────────────────────────────
   Recargo por mora de un condominio que lo cobra (settings.moraRules). La mora NO se guarda como movimientos:
   se calcula cada vez a partir de las cuotas y los pagos, asi un pago anulado o una cuota corregida la
   recalculan solos y no hay nada que "poner al dia".

   Reglas (las de la asociacion de La Perla, configurables por condominio):
   - Solo las cuotas mensuales generan mora; un cargo extra no, y la mora nunca genera mora.
   - La cuota de un mes vence el ultimo dia de ese mes mas los dias de plazo (graceDays). Quien paga dentro del
     plazo no paga mora; pasado el plazo, la mora se cuenta desde el ultimo dia del mes.
     Ejemplo con 5 dias de plazo: noviembre pagado el 4 de diciembre, sin mora; pagado el 20 de diciembre,
     20 dias de mora.
   - Cada dia suma (porcentaje mensual / 30) sobre lo que falta pagar de esa cuota: con 3 % es 0.1 % diario,
     Q 0.30 al dia por una cuota de Q 300.
   - Al terminar de pagarse la cuota, su mora deja de crecer y queda como deuda hasta que se pague.
   - La mora no corre antes de que el cargo exista (una cuota de octubre cobrada en marzo cuenta desde marzo).

   settings.moraRules es un HISTORIAL: [{ from: 'AAAA-MM-DD', percent, graceDays, payFirst }]. Cada regla vale
   desde su fecha y hasta la siguiente, asi un cambio de porcentaje no recalcula lo que ya paso. Un porcentaje
   0 detiene la mora desde ese dia.

   payFirst es el UNICO lugar que decide a que se aplica un pago que no alcanza para todo:
     'fee'  -> primero las cuotas y cargos (del mas antiguo al mas nuevo) y despues la mora
     'mora' -> primero la mora y despues las cuotas y cargos
   Vale la regla vigente el dia del pago.

   Un cargo con moraFixed: true es mora que ya venia calculada de otro sistema (la carga inicial de un
   condominio): no crece, y a la hora de repartir un pago cuenta como mora y no como cuota.

   Lo carga OIKOS en el navegador y lo usa el servidor (functions/src/finanzas/mora.js) para decidir quien es
   moroso. functions/src/finanzas/mora-diaria.js es una COPIA IDENTICA de este archivo (la prueba
   scripts/test-finanzas-mora-diaria.mjs falla si difieren): al cambiar uno, copiarlo al otro.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelMora = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EPS = 0.005;
    const DAY_MS = 86400000;
    const UTC_OFFSET_HOURS = -6; // Guatemala: UTC-6 todo el ano
    const PAY_FIRST = ['fee', 'mora'];
    const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

    // ── Dias ──
    // Un dia es un numero entero (dias desde 1970-01-01) y su clave es 'AAAA-MM-DD'
    function dayOfKey(key) {
        const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
        if (!mt) return null;
        const ms = Date.UTC(parseInt(mt[1], 10), parseInt(mt[2], 10) - 1, parseInt(mt[3], 10));
        return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
    }
    function keyOfDay(day) {
        return new Date(day * DAY_MS).toISOString().slice(0, 10);
    }
    // Dia de Guatemala de una fecha (texto ISO o Date); un texto 'AAAA-MM-DD' se toma tal cual. null si no es una fecha
    function dayOf(value) {
        if (!(value instanceof Date)) {
            const literal = dayOfKey(value);
            if (literal !== null) return literal;
        }
        const ms = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
        return Number.isFinite(ms) ? Math.floor((ms + UTC_OFFSET_HOURS * 3600000) / DAY_MS) : null;
    }
    // Primer y ultimo dia del mes de un periodo 'AAAA-MM'; null si no es un periodo
    function periodDays(period) {
        const mt = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
        if (!mt) return null;
        const y = parseInt(mt[1], 10);
        const m = parseInt(mt[2], 10) - 1;
        if (m < 0 || m > 11) return null;
        return { first: Math.floor(Date.UTC(y, m, 1) / DAY_MS), last: Math.floor(Date.UTC(y, m + 1, 0) / DAY_MS) };
    }

    // Periodo de una cuota mensual (null si el movimiento no es una cuota). Los conceptos antiguos de OIKOS
    // ("Cuota - Noviembre 2026") tambien cuentan
    function feePeriod(t) {
        if (!t || t.type !== 'charge' || t.moraFixed === true) return null;
        if (t.kind && t.kind !== 'fee') return null;
        if (periodDays(t.period)) return t.period;
        const plain = String(t.concept || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        const mt = plain.match(/^cuota\s*[-–]\s*(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})$/);
        if (!mt) return null;
        let index = MONTHS_ES.indexOf(mt[1]);
        if (index < 0) index = MONTHS_EN.indexOf(mt[1]);
        return index < 0 ? null : `${mt[2]}-${String(index + 1).padStart(2, '0')}`;
    }

    // ── Reglas ──
    // Una regla limpia; null si no tiene fecha o porcentaje validos
    function cleanRule(raw) {
        const from = dayOfKey(raw && raw.from);
        const percent = parseFloat(raw && raw.percent);
        if (from === null || !Number.isFinite(percent) || percent < 0) return null;
        const grace = parseInt(raw.graceDays, 10);
        return {
            from: keyOfDay(from), fromDay: from, percent,
            graceDays: Number.isFinite(grace) && grace > 0 ? grace : 0,
            payFirst: PAY_FIRST.includes(raw.payFirst) ? raw.payFirst : 'fee'
        };
    }
    // El historial limpio y en orden; con dos reglas de la misma fecha vale la ultima escrita
    function rulesOf(settings) {
        const raw = settings && Array.isArray(settings.moraRules) ? settings.moraRules : [];
        const byDay = new Map();
        raw.forEach((r) => {
            const rule = cleanRule(r);
            if (rule) byDay.set(rule.fromDay, rule);
        });
        return [...byDay.values()].sort((a, b) => a.fromDay - b.fromDay);
    }
    // true si el condominio cobra mora con estas reglas (aunque hoy el porcentaje sea 0)
    function enabled(settings) {
        return rulesOf(settings).length > 0;
    }
    // La regla vigente un dia; null si ese dia aun no habia ninguna
    function ruleAt(rules, day) {
        let found = null;
        for (let i = 0; i < rules.length && rules[i].fromDay <= day; i++) found = rules[i];
        return found;
    }
    // El historial con una regla nueva, listo para guardar en settings.moraRules. Lo que ya paso no se recalcula:
    // con reglas ya guardadas, la nueva no puede empezar antes de hoy. La primera regla de un condominio si puede
    // empezar atras (la carga inicial de un condominio que ya cobraba mora).
    function withRule(settings, rule, today) {
        const current = rulesOf(settings);
        const next = cleanRule(rule);
        if (!next) throw new Error('La regla de mora necesita fecha (AAAA-MM-DD) y un porcentaje de 0 o mas.');
        const todayDay = dayOf(today);
        if (current.length && todayDay !== null && next.fromDay < todayDay) {
            throw new Error('Un cambio en la mora solo puede empezar hoy o despues: lo que ya paso no se recalcula.');
        }
        const out = current.filter((r) => r.fromDay !== next.fromDay).concat([next]).sort((a, b) => a.fromDay - b.fromDay);
        return out.map((r) => ({ from: r.from, percent: r.percent, graceDays: r.graceDays, payFirst: r.payFirst }));
    }

    // ── Calculo ──
    // Suma a la cuota la mora de los dias que faltan hasta `day`. Solo crece mientras quede capital y ya paso el plazo.
    function accrue(item, day, rules) {
        if (item.kind !== 'fee' || item.capital <= EPS || day <= item.base + item.grace || day <= item.accruedTo) return;
        const start = item.accruedTo + 1; // la mora cuenta los dias (accruedTo, day]
        for (let i = 0; i < rules.length; i++) {
            const lo = Math.max(start, rules[i].fromDay);
            const hi = Math.min(day, i + 1 < rules.length ? rules[i + 1].fromDay - 1 : day);
            if (hi >= lo && rules[i].percent > 0) item.moraRaw += item.capital * (hi - lo + 1) * rules[i].percent / 3000;
        }
        item.accruedTo = day;
    }
    const moraDue = (item) => round2(round2(item.moraRaw) - item.moraPaid);
    const isOpen = (item) => item.capital > EPS || moraDue(item) > EPS;
    // Del mas antiguo al mas nuevo; en el mismo dia, la cuota antes que el cargo extra
    const byAge = (a, b) => a.sortDay - b.sortDay || (a.kind === 'fee' ? 0 : 1) - (b.kind === 'fee' ? 0 : 1) || a.index - b.index;

    // Reparte `credit` entre lo que se debe el dia `day` y devuelve lo que sobra (saldo a favor).
    // AQUI se decide el orden de un pago que no alcanza para todo (payFirst de la regla vigente ese dia).
    function allocate(open, credit, day, rules) {
        const rule = ruleAt(rules, day);
        const first = rule ? rule.payFirst : 'fee';
        open.sort(byAge);
        open.forEach((item) => accrue(item, day, rules)); // la mora al dia antes de mover el capital
        const payCapital = () => open.forEach((item) => {
            if (credit <= EPS || item.capital <= EPS) return;
            const paid = Math.min(credit, item.capital);
            item.capital = round2(item.capital - paid);
            credit = round2(credit - paid);
        });
        const payMora = () => open.forEach((item) => {
            const due = moraDue(item);
            if (credit <= EPS || due <= EPS) return;
            const paid = Math.min(credit, due);
            item.moraPaid = round2(item.moraPaid + paid);
            credit = round2(credit - paid);
        });
        if (first === 'mora') { payMora(); payCapital(); } else { payCapital(); payMora(); }
        return credit;
    }

    function newItem(t, amount, day, index, rules) {
        const fixed = t.moraFixed === true;
        const period = feePeriod(t);
        const item = {
            id: t.id, kind: fixed ? 'mora' : period ? 'fee' : 'extra', period, amount, index,
            capital: fixed ? 0 : amount, moraRaw: fixed ? amount : 0, moraPaid: 0,
            base: null, grace: 0, accruedTo: null, sortDay: day
        };
        if (period) {
            const days = periodDays(period);
            item.base = Math.max(days.last, day); // la mora no corre antes de que el cargo exista
            const rule = ruleAt(rules, item.base) || rules[0] || null;
            item.grace = rule ? rule.graceDays : 0;
            item.accruedTo = item.base;
            item.sortDay = days.first;
        }
        return item;
    }

    // Estado de UN residente a partir de sus movimientos (ya filtrados), al dia `asOf`
    function compute(list, rules, asOf) {
        const events = [];
        list.forEach((t, index) => {
            if (!t || t.deleted || (t.type !== 'charge' && t.type !== 'income')) return;
            const amount = round2(parseFloat(t.amount));
            if (!(amount > 0)) return;
            const day = dayOf(t.date);
            events.push({ day: day === null ? 0 : day, order: t.type === 'charge' ? 0 : 1, index, amount, tx: t });
        });
        // Por fecha; en el mismo dia, los cargos antes que los pagos
        events.sort((a, b) => a.day - b.day || a.order - b.order || a.index - b.index);

        const items = [];
        let open = [];
        let credit = 0;
        events.forEach((e) => {
            if (e.day > asOf) return;
            if (e.order === 0) {
                const item = newItem(e.tx, e.amount, e.day, e.index, rules);
                items.push(item);
                open.push(item);
            } else {
                credit = round2(credit + e.amount);
            }
            if (credit > EPS && open.length) {
                credit = allocate(open, credit, e.day, rules);
                open = open.filter(isOpen);
            }
        });
        open.forEach((item) => accrue(item, asOf, rules));

        const totals = { capital: 0, overdueCapital: 0, mora: 0, moraAccrued: 0, moraPaid: 0 };
        const out = items.map((item) => {
            const accrued = round2(item.moraRaw);
            const pending = round2(accrued - item.moraPaid);
            const overdue = item.capital > EPS && (item.kind === 'extra' || (item.kind === 'fee' && asOf > item.base + item.grace));
            totals.capital += item.capital;
            totals.overdueCapital += overdue ? item.capital : 0;
            totals.mora += pending;
            totals.moraAccrued += accrued;
            totals.moraPaid += item.moraPaid;
            return {
                id: item.id, kind: item.kind, period: item.period, amount: item.amount, capital: item.capital,
                moraAccrued: accrued, moraPaid: item.moraPaid, mora: pending,
                dueDate: item.base === null ? null : keyOfDay(item.base + item.grace), overdue
            };
        });
        Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });
        // balance como en OIKOS: positivo = saldo a favor, negativo = debe (cuotas, cargos y mora)
        return { asOf: keyOfDay(asOf), ...totals, credit, balance: round2(credit - totals.capital - totals.mora), items: out };
    }

    const asOfDay = (asOf) => {
        const day = dayOf(asOf === undefined || asOf === null ? new Date() : asOf);
        return day === null ? dayOf(new Date()) : day;
    };

    // Estado de un residente: { asOf, capital, overdueCapital, mora, moraAccrued, moraPaid, credit, balance, items }
    //   capital         lo que falta pagar de cuotas y cargos
    //   overdueCapital  la parte ya vencida (lo que mira la garita: la mora no cuenta para bloquear)
    //   mora            la mora que se debe hoy
    function stateOf(residentId, txs, settings, asOf) {
        const id = String(residentId);
        return compute((txs || []).filter((t) => t && String(t.resiId) === id), rulesOf(settings), asOfDay(asOf));
    }
    // Lo mismo para todos los residentes con movimientos: { [idResidente]: estado }
    function statesByResident(txs, settings, asOf) {
        const rules = rulesOf(settings);
        const day = asOfDay(asOf);
        const groups = new Map();
        (txs || []).forEach((t) => {
            if (!t || t.resiId === undefined || t.resiId === null || t.resiId === '') return;
            const id = String(t.resiId);
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(t);
        });
        const out = {};
        groups.forEach((list, id) => { out[id] = compute(list, rules, day); });
        return out;
    }

    return { PAY_FIRST, dayOf, dayOfKey, keyOfDay, periodDays, feePeriod, rulesOf, enabled, ruleAt, withRule, stateOf, statesByResident };
});
