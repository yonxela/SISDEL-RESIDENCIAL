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

   Lo que se debe, por concepto (pedido del dueno el 2026-11-17): cada cuota lleva sus conceptos (mantenimiento, agua,
   basura, electricidad y otros: movimiento.breakdown; sin desglose cuenta como "fee", y un cargo extra como "extra") y
   el estado dice cuanto falta de cada uno (`parts`, aparte de la mora). Un pago normal reparte lo que falta de cada
   cuota en proporcion. Un pago con `alloc` ({ maintenance: 300, water: 80, mora: 20 }: lo que quien cobra anoto en la
   ventana del ingreso) se aplica EXACTAMENTE a esos conceptos, del mas antiguo al mas nuevo, sin importar payFirst: es la
   unica excepcion a payFirst. Solo vale si suma lo mismo que el pago; lo que sobra de un concepto (pago de mas) se
   reparte como un pago normal. Sin alloc nada cambia respecto a antes.

   Descuento de mora (pedido del dueno el 2026-11-18): un movimiento type 'mora_discount' quita mora de cuotas concretas
   (`moraItems: [{ id: <id del cargo>, amount }]`): el dia del descuento, a cada cuota se le descuenta hasta lo que debe de
   mora ese dia (lo de mas no va a ningun lado: un descuento nunca es saldo a favor). No es dinero ni esta en el libro de
   OIKOS: solo baja la mora (`moraWaived` de la cuota y del total). Va antes que los pagos del mismo dia (asi un pago que
   llega el mismo dia no se lleva primero la mora que se descontaba). Si la cuota sigue sin pagarse, su mora vuelve a correr
   desde el dia siguiente. Anulado (deleted) no cuenta. `discountPlan` dice como se reparte un descuento.

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
    const DISCOUNT_TYPE = 'mora_discount';
    // Los conceptos de una cuota (los mismos de sisdel-cuotas.js) y los que acepta un pago dirigido (alloc)
    const PART_KEYS = ['maintenance', 'water', 'garbage', 'electricity', 'other'];
    const ALLOC_KEYS = PART_KEYS.concat(['fee', 'extra', 'mora']);
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
    const moraDue = (item) => round2(round2(item.moraRaw) - item.moraPaid - item.moraWaived);
    const isOpen = (item) => item.capital > EPS || moraDue(item) > EPS;
    // Del mas antiguo al mas nuevo; en el mismo dia, la cuota antes que el cargo extra
    const byAge = (a, b) => a.sortDay - b.sortDay || (a.kind === 'fee' ? 0 : 1) - (b.kind === 'fee' ? 0 : 1) || a.index - b.index;

    // Lo que falta de cada concepto de una cuota baja en proporcion cuando se le paga `paid` sin decir a que concepto
    // (item.capital todavia es el de antes). Las partes siempre suman el capital.
    function shrinkParts(item, paid) {
        const before = item.capital;
        const after = round2(before - paid);
        const keys = Object.keys(item.parts);
        if (!keys.length) return;
        if (after <= EPS) { item.parts = {}; return; }
        let sum = 0;
        let big = null;
        keys.forEach((k) => {
            const v = round2(item.parts[k] * after / before);
            item.parts[k] = v;
            sum = round2(sum + v);
            if (big === null || v > item.parts[big]) big = k;
        });
        item.parts[big] = Math.max(0, round2(item.parts[big] + after - sum));
        keys.forEach((k) => { if (item.parts[k] <= EPS) delete item.parts[k]; });
    }

    // Aplica un pago dirigido (alloc) a lo que se debe el dia `day`: cada concepto a las cuotas que lo deben, de la mas
    // antigua a la mas nueva, y la mora a la mora de cada una. Devuelve lo que no tuvo a donde ir (un concepto pagado de
    // mas), que se reparte como un pago normal. NO mira payFirst: quien cobra eligio a que se aplica.
    function applyAlloc(open, alloc, day, rules) {
        open.sort(byAge);
        open.forEach((item) => accrue(item, day, rules)); // la mora al dia antes de pagarla
        let left = 0;
        ALLOC_KEYS.forEach((key) => {
            let rest = alloc[key] || 0;
            if (rest <= EPS) return;
            open.forEach((item) => {
                if (rest <= EPS) return;
                if (key === 'mora') {
                    const due = moraDue(item);
                    if (due <= EPS) return;
                    const paid = Math.min(rest, due);
                    item.moraPaid = round2(item.moraPaid + paid);
                    rest = round2(rest - paid);
                } else {
                    const have = item.parts[key] || 0;
                    if (have <= EPS) return;
                    const paid = Math.min(rest, have, item.capital);
                    item.parts[key] = round2(have - paid);
                    if (item.parts[key] <= EPS) delete item.parts[key];
                    item.capital = round2(item.capital - paid);
                    rest = round2(rest - paid);
                }
            });
            left = round2(left + rest);
        });
        return left;
    }

    // Lo que dice un pago que se dirige a conceptos: { maintenance: 300, mora: 20 }, o null si no trae nada valido.
    // Solo vale si suma lo mismo que el pago (al centavo); si no, el pago se reparte como uno normal.
    function allocOf(t, amount) {
        const raw = t && t.alloc && typeof t.alloc === 'object' ? t.alloc : null;
        if (!raw) return null;
        const out = {};
        let sum = 0;
        ALLOC_KEYS.forEach((k) => {
            const v = round2(parseFloat(raw[k]));
            if (v > 0) { out[k] = v; sum = round2(sum + v); }
        });
        return sum > 0 && Math.abs(sum - amount) < EPS ? out : null;
    }

    // Las cuotas de un descuento de mora y cuanto se le quita a cada una: [{ id, amount }] (solo montos mayores que cero),
    // o null si no trae ninguna valida
    function discountOf(t) {
        const raw = t && Array.isArray(t.moraItems) ? t.moraItems : [];
        const out = [];
        raw.forEach((x) => {
            const amount = round2(parseFloat(x && x.amount));
            if (x && x.id !== undefined && x.id !== null && x.id !== '' && amount > 0) out.push({ id: String(x.id), amount });
        });
        return out.length ? out : null;
    }

    // Aplica un descuento de mora el dia `day`: a cada cuota, hasta la mora que debe ese dia. No devuelve nada: lo que no tuvo
    // de donde descontarse (la cuota ya no debia tanta mora, o esta anulada) se pierde, nunca es saldo a favor.
    function applyDiscount(open, list, day, rules) {
        list.forEach((entry) => {
            const item = open.find((x) => String(x.id) === entry.id);
            if (!item) return;
            accrue(item, day, rules); // la mora al dia antes de descontarla
            const due = moraDue(item);
            if (due <= EPS) return;
            item.moraWaived = round2(item.moraWaived + Math.min(entry.amount, due));
        });
    }

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
            shrinkParts(item, paid);
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

    // Los conceptos de un cargo y cuanto lleva de cada uno: una cuota con desglose (movimiento.breakdown, que debe sumar
    // el monto) lleva los suyos; una cuota sin desglose es "fee"; un cargo extra es "extra"; la mora cargada no tiene
    function partsOf(t, amount, kind) {
        if (kind === 'mora') return {};
        if (kind === 'extra') return { extra: amount };
        const raw = t.breakdown && typeof t.breakdown === 'object' ? t.breakdown : null;
        if (raw) {
            const parts = {};
            let sum = 0;
            let big = null;
            PART_KEYS.forEach((k) => {
                const v = round2(parseFloat(raw[k]));
                if (!(v > 0)) return;
                parts[k] = v;
                sum = round2(sum + v);
                if (big === null || v > parts[big]) big = k;
            });
            if (big !== null && Math.abs(sum - amount) < 0.01) {
                parts[big] = round2(parts[big] + amount - sum); // el redondeo no deja que las partes se separen del monto
                return parts;
            }
        }
        return { fee: amount };
    }

    function newItem(t, amount, day, index, rules) {
        const fixed = t.moraFixed === true;
        const period = feePeriod(t);
        const item = {
            id: t.id, kind: fixed ? 'mora' : period ? 'fee' : 'extra', period, amount, index,
            capital: fixed ? 0 : amount, moraRaw: fixed ? amount : 0, moraPaid: 0, moraWaived: 0,
            base: null, grace: 0, accruedTo: null, sortDay: day
        };
        item.parts = partsOf(t, amount, item.kind);
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
            if (!t || t.deleted || (t.type !== 'charge' && t.type !== 'income' && t.type !== DISCOUNT_TYPE)) return;
            const amount = round2(parseFloat(t.amount));
            if (!(amount > 0)) return;
            const day = dayOf(t.date);
            const discount = t.type === DISCOUNT_TYPE ? discountOf(t) : null;
            if (t.type === DISCOUNT_TYPE && !discount) return;
            events.push({
                day: day === null ? 0 : day, order: t.type === 'charge' ? 0 : t.type === DISCOUNT_TYPE ? 1 : 2, index, amount, tx: t,
                alloc: t.type === 'income' ? allocOf(t, amount) : null, discount
            });
        });
        // Por fecha; en el mismo dia, los cargos primero, despues los descuentos de mora y al final los pagos
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
            } else if (e.discount) {
                // Un descuento de mora no es dinero: no paga capital ni deja saldo a favor
                applyDiscount(open, e.discount, e.day, rules);
                open = open.filter(isOpen);
                return;
            } else if (e.alloc && open.length) {
                // Un pago dirigido a conceptos: se aplica a ellos, y solo lo que no tuvo a donde ir se reparte como uno normal
                credit = round2(credit + applyAlloc(open, e.alloc, e.day, rules));
                open = open.filter(isOpen);
            } else {
                credit = round2(credit + e.amount);
            }
            if (credit > EPS && open.length) {
                credit = allocate(open, credit, e.day, rules);
                open = open.filter(isOpen);
            }
        });
        open.forEach((item) => accrue(item, asOf, rules));

        // moraDaily: la mora por dia que se acumulo (sin la mora fija cargada como movimiento). No esta en el libro de
        // OIKOS: el saldo del libro (con TODOS sus movimientos, tambien los fechados despues de hoy) menos moraDaily es lo
        // que se debe con mora, pagado o no lo que toque (los pagos ya estan en el libro). moraWaived: la mora descontada
        // (descuentos de mora, tambien de la mora fija, que si esta en el libro): lo que se debe con mora es el libro menos
        // moraDaily mas moraWaived.
        const totals = { capital: 0, overdueCapital: 0, mora: 0, moraAccrued: 0, moraPaid: 0, moraWaived: 0, moraDaily: 0 };
        const parts = {}; // lo que falta de cada concepto entre todas las cuotas y cargos
        const out = items.map((item) => {
            const accrued = round2(item.moraRaw);
            const pending = round2(accrued - item.moraPaid - item.moraWaived);
            const overdue = item.capital > EPS && (item.kind === 'extra' || (item.kind === 'fee' && asOf > item.base + item.grace));
            totals.capital += item.capital;
            totals.overdueCapital += overdue ? item.capital : 0;
            totals.mora += pending;
            totals.moraAccrued += accrued;
            Object.keys(item.parts).forEach((k) => { parts[k] = round2((parts[k] || 0) + item.parts[k]); });
            totals.moraPaid += item.moraPaid;
            totals.moraWaived += item.moraWaived;
            if (item.kind !== 'mora') totals.moraDaily += accrued;
            return {
                id: item.id, kind: item.kind, period: item.period, amount: item.amount, capital: item.capital, parts: { ...item.parts },
                moraAccrued: accrued, moraPaid: item.moraPaid, moraWaived: item.moraWaived, mora: pending,
                dueDate: item.base === null ? null : keyOfDay(item.base + item.grace), overdue
            };
        });
        Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });
        // balance como en OIKOS: positivo = saldo a favor, negativo = debe (cuotas, cargos y mora)
        return { asOf: keyOfDay(asOf), ...totals, credit, balance: round2(credit - totals.capital - totals.mora), parts, items: out };
    }

    const asOfDay = (asOf) => {
        const day = dayOf(asOf === undefined || asOf === null ? new Date() : asOf);
        return day === null ? dayOf(new Date()) : day;
    };

    // Estado de un residente: { asOf, capital, overdueCapital, mora, moraAccrued, moraPaid, moraDaily, credit, balance, items }
    // (solo con los movimientos hasta `asOf`: un pago o cargo fechado despues todavia no existe)
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

    // Como se aplicaria hoy un pago NORMAL de `amount` (sin alloc) segun lo que se debe y las reglas de mora: lo que cubre de
    // cada concepto y de la mora, y lo que sobra como saldo a favor. Es la misma cuenta del motor (con un pago de mentira
    // fechado hoy), asi la ventana del ingreso muestra lo mismo que despues dice el estado de cuenta.
    // { parts: { maintenance: 300, water: 80 }, mora, credit }
    function previewPayment(residentId, txs, settings, amount, asOf) {
        const day = asOfDay(asOf);
        const id = String(residentId);
        const money = round2(parseFloat(amount));
        const own = (txs || []).filter((t) => t && String(t.resiId) === id);
        const rules = rulesOf(settings);
        const before = compute(own, rules, day);
        if (!(money > 0)) return { parts: {}, mora: 0, credit: 0 };
        const after = compute(own.concat([{ id: '__vista__', type: 'income', amount: money, resiId: id, date: keyOfDay(day) }]), rules, day);
        const parts = {};
        Object.keys(before.parts).forEach((k) => {
            const paid = round2(before.parts[k] - (after.parts[k] || 0));
            if (paid > EPS) parts[k] = paid;
        });
        return { parts, mora: Math.max(0, round2(before.mora - after.mora)), credit: Math.max(0, round2(after.credit - before.credit)) };
    }

    // Como se reparte un descuento de mora sobre el estado de un residente (stateOf): solo cuotas con mora pendiente.
    //   { ids: [...] }   -> toda la mora de esas cuotas (los meses que se marcaron)
    //   { amount: 100 }  -> ese total, empezando por las cuotas MAS RECIENTES que tienen mora (la mora fija cargada de otro
    //                       sistema, que es la mas antigua, va al final); hasta la mora que se debe
    // Devuelve { items: [{ id, period, kind, mora, amount }], total, left } (left: lo que no tuvo de donde descontarse)
    function discountPlan(state, opts) {
        const options = opts || {};
        const withMora = ((state && state.items) || []).map((item, index) => ({ item, index })).filter((x) => x.item.mora > EPS);
        const row = (item, amount) => ({ id: String(item.id), period: item.period || null, kind: item.kind, mora: round2(item.mora), amount: round2(amount) });
        let items;
        let left = 0;
        if (Array.isArray(options.ids)) {
            const wanted = new Set(options.ids.map(String));
            items = withMora.filter((x) => wanted.has(String(x.item.id))).map((x) => row(x.item, x.item.mora));
        } else {
            let rest = Math.max(0, round2(parseFloat(options.amount) || 0));
            const newestFirst = withMora.slice().sort((a, b) => {
                const pa = a.item.period || '';
                const pb = b.item.period || '';
                return pa !== pb ? (pa < pb ? 1 : -1) : b.index - a.index;
            });
            items = [];
            newestFirst.forEach((x) => {
                if (rest <= EPS) return;
                const take = Math.min(rest, round2(x.item.mora));
                items.push(row(x.item, take));
                rest = round2(rest - take);
            });
            left = rest;
        }
        const total = round2(items.reduce((sum, x) => sum + x.amount, 0));
        return { items, total, left };
    }

    return { PAY_FIRST, PART_KEYS, ALLOC_KEYS, DISCOUNT_TYPE, discountPlan, previewPayment, dayOf, dayOfKey, keyOfDay, periodDays, feePeriod, rulesOf, enabled, ruleAt, withRule, stateOf, statesByResident };
});
