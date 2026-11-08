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
    const fee = feeAmount(s);
    if (!fee || !s.chargeDay) return [];
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
            let id = `fee_${r.id}_${period}`;
            let n = 1;
            while (ids.has(id)) id = `fee_${r.id}_${period}_r${n++}`;
            const tx = {
                id, date: gtDate(y, m, chargeDay, 6).toISOString(), type: 'charge', kind: 'fee', period,
                amount: fee, concept: feeConcept(y, m), resiId: r.id, auto: true, serverGenerated: true,
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

// Mora del residente. La cuota del mes actual cuenta como vencida a partir del
// dia de cobro mas los dias de gracia (como checkIsMoroso de OIKOS).
function moraOf(residentId, txs, settings, now = new Date()) {
    const s = settings || {};
    const balance = balanceOf(txs, residentId);
    const debt = balance < -EPS ? -balance : 0;
    const fee = feeAmount(s);
    if (!debt) return { balance, debt: 0, overdue: 0, moroso: false };
    const { y, m, d } = localParts(now);
    const current = periodKey(y, m);
    let currentFee = 0;
    txs.forEach((t) => {
        if (!t || t.deleted || String(t.resiId) !== String(residentId)) return;
        if (txFeePeriod(t) === current) currentFee += parseFloat(t.amount) || 0;
    });
    const chargeDay = parseInt(s.chargeDay, 10) || 1;
    const graceDays = parseInt(s.graceDays, 10) || 0;
    const inGrace = d < chargeDay + graceDays;
    const overdue = round2(inGrace ? Math.max(0, debt - currentFee) : debt);
    return { balance, debt: round2(debt), overdue, moroso: overdue > fee + EPS };
}

module.exports = {
    TIME_ZONE, periodKey, periodParts, feeConcept, parseFeePeriod, txFeePeriod, gtDate, localParts,
    isActive, createdAfterPeriod, autoSkips, hasFeeCharge, feeAmount, missingFees, balanceOf, moraOf
};
