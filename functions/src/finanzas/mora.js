// Cuotas y mora del Sistema Financiero, calculadas en el servidor.
// Replica la logica de OIKOS (finanzas/index.html): feePeriodKey, parseFeePeriod,
// txFeePeriod, isResidentActive, residentCreatedAfterPeriod, feeAutoSkips,
// createFeeCharge y el saldo derivado de Store. Si OIKOS cambia esas funciones,
// hay que actualizar este archivo (y scripts/test-finanzas-mora.mjs).
//
// Regla de SISDEL: la garita trata como moroso solo a quien debe MAS de una cuota
// vencida. OIKOS muestra "en mora" desde la primera cuota vencida.

const TIME_ZONE = 'America/Guatemala';
const UTC_OFFSET_HOURS = 6; // Guatemala: UTC-6 todo el ano, sin horario de verano
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const EPS = 0.005;

const deacc = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function periodKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function periodParts(period) {
    const p = String(period || '').split('-');
    return { y: parseInt(p[0], 10), m: parseInt(p[1], 10) - 1 };
}
function feeConcept(y, m) { return `Cuota - ${MONTHS_ES[m]} ${y}`; }

// Conceptos antiguos: "Cuota - Noviembre 2026", "Cuota - Noviembre de 2026", "Cuota - November 2026"
function parseFeePeriod(concept) {
    const mt = deacc(concept).match(/^cuota\s*[-–]\s*(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})$/);
    if (!mt) return null;
    let idx = MONTHS_ES.map(deacc).indexOf(mt[1]);
    if (idx < 0) idx = MONTHS_EN.indexOf(mt[1]);
    if (idx < 0) return null;
    return periodKey(parseInt(mt[2], 10), idx);
}

// Periodo de cuota de un movimiento (null si no es una cuota mensual)
function txFeePeriod(t) {
    if (!t || t.type !== 'charge') return null;
    if (t.period) return t.period;
    if (t.kind && t.kind !== 'fee') return null;
    return parseFeePeriod(t.concept);
}

// Fecha y hora de Guatemala como instante UTC
function gtDate(y, m, d, h = 0, min = 0, s = 0) { return new Date(Date.UTC(y, m, d, h + UTC_OFFSET_HOURS, min, s)); }

// Ano, mes (0-11) y dia en Guatemala
function localParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(now)
        .reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10) - 1, d: parseInt(parts.day, 10) };
}

function isActive(r) { return !!r && r.status !== 'closed'; }

// true si el residente se creo despues de terminado ese mes (no se le cobra en automatico)
function createdAfterPeriod(r, period) {
    if (!r.createdAt) return false;
    const { y, m } = periodParts(period);
    const endOfMonth = gtDate(y, m + 1, 0, 23, 59, 59).getTime();
    const created = Date.parse(r.createdAt);
    return Number.isFinite(created) && created > endOfMonth;
}

const cuotas = require('./cuotas');
const moraDiaria = require('./mora-diaria');

function autoSkips(r, period) {
    if (!isActive(r)) return true;
    if (createdAfterPeriod(r, period)) return true;
    if (r.feeFrom && period < r.feeFrom) return true;
    return false;
}

// Cuota existente (viva o anulada) de un residente en un periodo: una anulada no se resucita
function hasFeeCharge(txs, residentId, period) {
    return txs.some((t) => t && String(t.resiId) === String(residentId) && txFeePeriod(t) === period);
}

function feeAmount(settings) {
    const fee = parseFloat(settings && settings.fee);
    return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

// Cuotas automaticas que faltan, igual que checkMonthlyFees de OIKOS:
// de enero al mes actual del ano en curso (el mes actual a partir del dia de cobro).
function missingFees(residents, txs, settings, now = new Date(), nowIso = now.toISOString()) {
    const s = settings || {};
    if ((s.feeMode || 'auto') === 'manual') return [];
    if (!feeAmount(s) || !s.chargeDay) return [];
    const chargeDay = Math.min(28, Math.max(1, parseInt(s.chargeDay, 10) || 1));
    const { y, m: curMonth, d } = localParts(now);
    const ids = new Set(txs.map((t) => String(t.id)));
    const all = txs.slice();
    const created = [];
    for (let m = 0; m <= curMonth; m++) {
        if (m === curMonth && d < chargeDay) continue;
        const period = periodKey(y, m);
        residents.forEach((r) => {
            if (autoSkips(r, period) || hasFeeCharge(all, r.id, period)) return;
            // La cuota es la del lote: la del condominio mas su agua, si el condominio cobra el agua por paja.
            // Con desglose configurado lleva la misma descripcion que cobra OIKOS, con su mes (ver finanzas/sisdel-cuotas.js)
            const fee = cuotas.residentFee(s, r);
            const info = cuotas.residentFeeInfo(s, r, fee, period);
            let id = `fee_${r.id}_${period}`;
            let n = 1;
            while (ids.has(id)) id = `fee_${r.id}_${period}_r${n++}`;
            const tx = {
                id, date: gtDate(y, m, chargeDay, 6).toISOString(), type: 'charge', kind: 'fee', period,
                amount: fee, concept: info ? info.concept : feeConcept(y, m), resiId: r.id, auto: true, serverGenerated: true,
                ...(info ? { breakdown: info.breakdown } : {}),
                created_at: nowIso, updated_at: nowIso
            };
            ids.add(id);
            all.push(tx);
            created.push(tx);
        });
    }
    return created;
}

// Saldo como en OIKOS: pagos menos cargos vivos (positivo = a favor, negativo = debe)
function balanceOf(txs, residentId) {
    let balance = 0;
    txs.forEach((t) => {
        if (!t || t.deleted || String(t.resiId) !== String(residentId)) return;
        const amount = parseFloat(t.amount) || 0;
        if (t.type === 'income') balance += amount;
        else if (t.type === 'charge') balance -= amount;
    });
    return round2(balance);
}

// Mora del residente. La cuota de un mes cuenta como vencida pasados 35 dias: el mes completo mas hasta el dia 5 del
// siguiente (cuotas.dueKey; como checkIsMoroso de OIKOS). El dia de cobro y los dias de gracia de OIKOS ya no cuentan.
// `resident` (opcional) es su ficha financiera: con agua por lote, "una cuota" es la de su lote.
//
// En un condominio con recargo por mora (settings.moraRules) decide el modulo de mora por dia: cada cuota
// vence al terminar su mes mas los dias de plazo y la garita mira solo el capital vencido (el recargo se debe,
// pero no bloquea). `balance` y `debt` incluyen el recargo.
function moraOf(residentId, txs, settings, now = new Date(), resident = null) {
    const s = settings || {};
    const fee = resident ? cuotas.residentFee(s, resident) : feeAmount(s);
    if (moraDiaria.enabled(s)) {
        const today = localParts(now);
        const asOf = `${today.y}-${String(today.m + 1).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`;
        const state = moraDiaria.stateOf(residentId, txs, s, asOf);
        return {
            balance: state.balance, debt: round2(state.capital + state.mora), overdue: state.overdueCapital,
            moroso: state.overdueCapital > fee + EPS, capital: state.capital, mora: state.mora
        };
    }
    const balance = balanceOf(txs, residentId);
    const debt = balance < -EPS ? -balance : 0;
    if (!debt) return { balance, debt: 0, overdue: 0, moroso: false };
    // La cuota de cada mes se paga sin atraso durante ese mes y hasta el dia 5 del siguiente (cuotas.dueKey, 35 dias:
    // pedido del dueno el 2026-11-19 para todos los condominios): lo que aun esta en su plazo no cuenta como vencido.
    const { y, m, d } = localParts(now);
    const today = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    let notDue = 0;
    txs.forEach((t) => {
        if (!t || t.deleted || String(t.resiId) !== String(residentId)) return;
        const period = txFeePeriod(t);
        if (period && String(cuotas.dueKey(period) || '') >= today) notDue += parseFloat(t.amount) || 0;
    });
    const overdue = round2(Math.max(0, debt - notDue));
    return { balance, debt: round2(debt), overdue, moroso: overdue > fee + EPS };
}

module.exports = {
    TIME_ZONE, periodKey, periodParts, feeConcept, parseFeePeriod, txFeePeriod, gtDate, localParts,
    isActive, createdAfterPeriod, autoSkips, hasFeeCharge, feeAmount, missingFees, balanceOf, moraOf
};
