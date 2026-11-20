// Decide si una placa puede entrar: vecino permanente, visita programada o vecino temporal
const { db } = require('../firebase');
const { normalizePlate, localDate, daysAgo } = require('../util');

const PENDING_WINDOW_DAYS = 30;   // Una visita pendiente mas vieja ya no abre por camara
const MIN_PARTIAL_LENGTH = 6;     // Minimo de caracteres para aceptar coincidencia parcial (una placa de Guatemala tiene 7)

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

// Quien es la persona de la lectura, para el registro de ingresos y salidas (accesos.js): el vecino dueño del vehiculo
// o, en una visita, la visita y el vecino que la autoriza
function subjectOf(kind, ownerId, owner, extra) {
    return {
        kind, userId: ownerId || '', name: (owner && owner.name) || '', casa: (owner && owner.casa) || '', fase: (owner && owner.fase) || '',
        moroso: !!owner && owner.paymentStatus === 'moroso', ...extra
    };
}

async function checkResident(condoRef, condo, plate, now) {
    const vehicles = await condoRef.collection('vehiculos').where('plateNorm', '==', plate).get();
    let best = null;
    for (const doc of vehicles.docs) {
        const userId = doc.data().userId;
        if (!userId) continue;
        const ownerSnap = await condoRef.collection('usuarios').doc(userId).get();
        const owner = ownerSnap.exists ? ownerSnap.data() : null;
        const outcome = residentOutcome(owner, condo, now);
        if (outcome && (!best || RANK[outcome.status] > RANK[best.status])) {
            best = { ...outcome, subject: subjectOf('vehiculo', userId, owner, { vehicleId: doc.id }) };
        }
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

async function checkVisit(condoRef, condo, plate, now) {
    const today = localDate(now);
    const cutoff = localDate(daysAgo(PENDING_WINDOW_DAYS, now));
    const visits = condoRef.collection('visitas');

    const [pending, temporal] = await Promise.all([
        visits.where('status', '==', 'pending').where('visitDate', '>=', cutoff).get(),
        visits.where('visitType', '==', 'temporal').where('endDate', '>=', today).get()
    ]);

    const candidates = new Map();
    [...pending.docs, ...temporal.docs].forEach((d) => candidates.set(d.id, { id: d.id, ...d.data() }));

    let deniedByOwner = null;
    let deniedSubject = null;
    for (const visit of candidates.values()) {
        if (!['pending', 'entered'].includes(visit.status)) continue;
        if (!platesMatch(visit.vehiclePlate, plate)) continue;

        const isTemporal = visit.visitType === 'temporal' && visit.endDate;
        const valid = isTemporal ? (today <= visit.endDate && (!visit.visitDate || visit.visitDate <= today)) : visit.status === 'pending';
        if (!valid) continue;

        // El pase vale lo que vale su vecino: uno eliminado, desactivado o moroso sin gracia no abre ni con un pase
        // (si no, un moroso registraria su propia placa como "visita")
        const ownerSnap = visit.userId ? await condoRef.collection('usuarios').doc(String(visit.userId)).get() : null;
        const owner = ownerSnap && ownerSnap.exists ? ownerSnap.data() : null;
        const ownerOutcome = residentOutcome(owner, condo, now);
        const subject = subjectOf('visita', visit.userId ? String(visit.userId) : '', owner, {
            visitId: visit.id, visitorName: visit.visitorName || '', visitType: isTemporal ? 'temporal' : '', casa: visit.casa || (owner && owner.casa) || ''
        });
        if (!ownerOutcome || ownerOutcome.status === 'Denied') {
            deniedByOwner = ownerOutcome ? `Visita de ${visit.visitorName} no entra: ${ownerOutcome.reason}` : `Visita de ${visit.visitorName} no entra: vecino inactivo`;
            deniedSubject = subject;
            continue;
        }

        const who = isTemporal ? `Vecino temporal: ${visit.visitorName} (hasta ${visit.endDate})` : `Visita programada: ${visit.visitorName}`;
        return {
            status: ownerOutcome.status === 'Reminder' ? 'Reminder' : 'Authorized',
            reason: ownerOutcome.status === 'Reminder' ? `${who} - ${ownerOutcome.reason}` : who,
            visitIdToMark: visit.status === 'pending' ? visit.id : null,
            subject
        };
    }
    return deniedByOwner ? { status: 'Denied', reason: deniedByOwner, visitIdToMark: null, subject: deniedSubject } : null;
}

// Devuelve { status, reason, visitIdToMark, subject } (subject: quien es, para el registro de accesos; null si la placa no es de nadie)
async function decideAccess(condoRef, condo, plate, now = new Date()) {
    const resident = await checkResident(condoRef, condo, plate, now);
    if (resident && resident.status !== 'Denied') return { ...resident, visitIdToMark: null };

    const visit = await checkVisit(condoRef, condo, plate, now);
    if (visit) return visit;

    return {
        status: 'Denied',
        reason: resident ? resident.reason : 'Placa no registrada',
        visitIdToMark: null,
        subject: resident ? resident.subject : null
    };
}

module.exports = { decideAccess, platesMatch, residentOutcome };
