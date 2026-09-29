// Decide si una placa puede entrar: vecino permanente, visita programada o vecino temporal
const { db } = require('../firebase');
const { normalizePlate, localDate, daysAgo } = require('../util');

const PENDING_WINDOW_DAYS = 30;   // Una visita pendiente mas vieja ya no abre por camara
const MIN_PARTIAL_LENGTH = 4;     // Minimo de caracteres para aceptar coincidencia parcial

const RANK = { Authorized: 3, Reminder: 2, Denied: 1 };

function residentOutcome(owner, condo, now) {
    if (!owner || owner.active === false) return null;

    if (owner.paymentStatus !== 'moroso') {
        return { status: 'Authorized', reason: `Vecino permanente: ${owner.name}` };
    }
    if (condo.reminderEnabled !== true) {
        return { status: 'Denied', reason: `${owner.name} - MOROSO` };
    }

    const graceDays = condo.gracePeriodDays || 15;
    const since = owner.morosoSince ? new Date(owner.morosoSince) : now;
    const daysMoroso = Math.floor((now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000));
    const remaining = graceDays - daysMoroso;

    if (remaining > 0) {
        return { status: 'Reminder', reason: `${owner.name} - MOROSO (${remaining} días restantes para pagar)` };
    }
    return { status: 'Denied', reason: `${owner.name} - Período de gracia vencido` };
}

async function checkResident(condoRef, condo, plate, now) {
    const vehicles = await condoRef.collection('vehiculos').where('plateNorm', '==', plate).get();
    let best = null;
    for (const doc of vehicles.docs) {
        const userId = doc.data().userId;
        if (!userId) continue;
        const ownerSnap = await condoRef.collection('usuarios').doc(userId).get();
        const outcome = residentOutcome(ownerSnap.exists ? ownerSnap.data() : null, condo, now);
        if (outcome && (!best || RANK[outcome.status] > RANK[best.status])) best = outcome;
    }
    return best;
}

function platesMatch(visitPlate, plate) {
    const clean = normalizePlate(visitPlate);
    if (!clean) return false;
    if (clean === plate) return true;
    if (clean.length < MIN_PARTIAL_LENGTH || plate.length < MIN_PARTIAL_LENGTH) return false;
    return clean.includes(plate) || plate.includes(clean);
}

async function checkVisit(condoRef, plate, now) {
    const today = localDate(now);
    const cutoff = localDate(daysAgo(PENDING_WINDOW_DAYS, now));
    const visits = condoRef.collection('visitas');

    const [pending, temporal] = await Promise.all([
        visits.where('status', '==', 'pending').where('visitDate', '>=', cutoff).get(),
        visits.where('visitType', '==', 'temporal').where('endDate', '>=', today).get()
    ]);

    const candidates = new Map();
    [...pending.docs, ...temporal.docs].forEach((d) => candidates.set(d.id, { id: d.id, ...d.data() }));

    for (const visit of candidates.values()) {
        if (!['pending', 'entered'].includes(visit.status)) continue;
        if (!platesMatch(visit.vehiclePlate, plate)) continue;

        const isTemporal = visit.visitType === 'temporal' && visit.endDate;
        const valid = isTemporal ? today <= visit.endDate : visit.status === 'pending';
        if (!valid) continue;

        return {
            status: 'Authorized',
            reason: isTemporal
                ? `Vecino temporal: ${visit.visitorName} (hasta ${visit.endDate})`
                : `Visita programada: ${visit.visitorName}`,
            visitIdToMark: visit.status === 'pending' ? visit.id : null
        };
    }
    return null;
}

// Devuelve { status, reason, visitIdToMark }
async function decideAccess(condoRef, condo, plate, now = new Date()) {
    const resident = await checkResident(condoRef, condo, plate, now);
    if (resident && resident.status !== 'Denied') return { ...resident, visitIdToMark: null };

    const visit = await checkVisit(condoRef, plate, now);
    if (visit) return visit;

    return {
        status: 'Denied',
        reason: resident ? resident.reason : 'Placa no registrada',
        visitIdToMark: null
    };
}

module.exports = { decideAccess, platesMatch, residentOutcome };
