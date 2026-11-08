// Limpieza diaria de rondas: cierra turnos y rondas olvidados y borra el historial
// de posiciones viejo. Las funciones de seleccion son puras (se prueban sin emulador).
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');

const SHIFT_MAX_HOURS = 16;
const ROUND_MAX_HOURS = 6;
const LIVE_MAX_HOURS = 24;
const HISTORY_DAYS = 30;
const COMPLETE_SCORE = 80; // igual que rondas-logic.js
const BATCH_SIZE = 400;
const HOUR = 3600 * 1000;

const olderThan = (iso, hours, nowMs) => {
    const t = Date.parse(iso || '');
    return !Number.isFinite(t) || nowMs - t > hours * HOUR;
};

function isStaleShift(shift, nowMs) { return shift.status === 'ACTIVE' && olderThan(shift.startedAt, SHIFT_MAX_HOURS, nowMs); }
function isStaleRound(round, nowMs) { return round.status === 'IN_PROGRESS' && olderThan(round.startedAt, ROUND_MAX_HOURS, nowMs); }
function isStaleLive(live, nowMs) { return olderThan(live.at, LIVE_MAX_HOURS, nowMs); }
function historyCutoff(nowMs) { return new Date(nowMs - HISTORY_DAYS * 24 * HOUR).toISOString(); }

// Puntaje de una ronda que se cierra sola: con los puntos que alcanzo a marcar
function closingScore(round) {
    const total = Number(round.totalCheckpoints) || 0;
    const visited = Array.isArray(round.visited) ? new Set(round.visited).size : 0;
    const score = total ? Math.round((Math.min(visited, total) / total) * 1000) / 10 : 0;
    return { score, status: score >= COMPLETE_SCORE ? 'COMPLETED' : 'INCOMPLETE' };
}

async function commitInChunks(writes) {
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
        const batch = db.batch();
        writes.slice(i, i + BATCH_SIZE).forEach((w) => w(batch));
        await batch.commit();
    }
}

async function cleanCondo(condoRef, now = new Date()) {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const [shifts, rounds, live] = await Promise.all([
        condoRef.collection('rondas_turnos').where('status', '==', 'ACTIVE').get(),
        condoRef.collection('rondas_rondas').where('status', '==', 'IN_PROGRESS').get(),
        condoRef.collection('rondas_en_vivo').get()
    ]);
    const writes = [];
    let closedShifts = 0;
    let closedRounds = 0;
    shifts.docs.filter((d) => isStaleShift(d.data(), nowMs)).forEach((d) => {
        closedShifts++;
        writes.push((b) => b.update(d.ref, { status: 'CLOSED_AUTO', endedAt: nowIso, notes: `Cerrado automaticamente: quedo abierto mas de ${SHIFT_MAX_HOURS} horas` }));
    });
    rounds.docs.filter((d) => isStaleRound(d.data(), nowMs)).forEach((d) => {
        closedRounds++;
        const { score, status } = closingScore(d.data());
        writes.push((b) => b.update(d.ref, { status, score, completedAt: nowIso, notes: 'Cerrada automaticamente' }));
    });
    live.docs.filter((d) => isStaleLive(d.data(), nowMs)).forEach((d) => writes.push((b) => b.delete(d.ref)));
    await commitInChunks(writes);

    // Historial de posiciones de mas de 30 dias, por tandas
    let deleted = 0;
    const cutoff = historyCutoff(nowMs);
    for (;;) {
        const old = await condoRef.collection('rondas_ubicaciones').where('at', '<', cutoff).limit(BATCH_SIZE).get();
        if (old.empty) break;
        await commitInChunks(old.docs.map((d) => (b) => b.delete(d.ref)));
        deleted += old.size;
        if (old.size < BATCH_SIZE) break;
    }
    return { condoId: condoRef.id, closedShifts, closedRounds, deletedLocations: deleted };
}

async function cleanAll(now = new Date()) {
    const condos = await db.collection('condominios').get();
    const results = [];
    for (const condo of condos.docs) {
        try { results.push(await cleanCondo(condo.ref, now)); } catch (error) {
            logger.error('rondas: limpieza fallida', { condoId: condo.id, message: error.message });
        }
    }
    return results;
}

module.exports = { isStaleShift, isStaleRound, isStaleLive, historyCutoff, closingScore, cleanCondo, cleanAll };
