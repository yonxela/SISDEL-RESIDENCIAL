// Limpieza diaria de rondas (datos con el formato de SISDEL RONDIN, ver rondin/js/sisdel-api.js):
// cierra turnos y rondas olvidados y borra posiciones y alertas viejas.
// Las fechas son 'AAAA-MM-DD HH:MM:SS' en UTC, como las guardaba RONDIN (SQLite).
// Las funciones de seleccion son puras (se prueban sin emulador en scripts/test-rondas-servidor.mjs).
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');

const SHIFT_MAX_HOURS = 16;
const ROUND_MAX_HOURS = 6;
const LIVE_MAX_HOURS = 24;
const HISTORY_DAYS = 30;
const ALERT_DAYS = 90;
const COMPLETE_SCORE = 80; // igual que RONDIN (routes/rounds.js)
const BATCH_SIZE = 400;
const HOUR = 3600 * 1000;

// Fecha de RONDIN <-> milisegundos
function toMs(value) {
    if (!value) return NaN;
    const text = String(value);
    return Date.parse(text.includes('T') ? text : text.replace(' ', 'T') + 'Z');
}
function sqlTime(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

const olderThan = (value, hours, nowMs) => {
    const t = toMs(value);
    return !Number.isFinite(t) || nowMs - t > hours * HOUR;
};

function isStaleShift(shift, nowMs) {
    return shift.status === 'ACTIVE' && olderThan(shift.actual_start || shift.scheduled_start, SHIFT_MAX_HOURS, nowMs);
}
function isStaleRound(round, nowMs) { return round.status === 'IN_PROGRESS' && olderThan(round.started_at, ROUND_MAX_HOURS, nowMs); }
function isStaleLive(live, nowMs) { return olderThan(live.timestamp, LIVE_MAX_HOURS, nowMs); }
function historyCutoff(nowMs) { return sqlTime(nowMs - HISTORY_DAYS * 24 * HOUR); }
function alertCutoff(nowMs) { return sqlTime(nowMs - ALERT_DAYS * 24 * HOUR); }

// Puntaje como RONDIN: % de puntos obligatorios visitados (sin contar visitas sospechosas); completa desde 80
function closingScore(checkpoints, visits) {
    const mandatory = (checkpoints || []).filter((c) => c.is_mandatory !== 0 && c.status !== 'INACTIVE');
    if (!mandatory.length) return { score: 0, status: 'INCOMPLETE' };
    const visited = new Set((visits || []).filter((v) => v.status !== 'SUSPICIOUS').map((v) => v.checkpoint_id));
    const count = mandatory.filter((c) => visited.has(c.id)).length;
    const score = Math.round((count / mandatory.length) * 1000) / 10;
    return { score, status: score >= COMPLETE_SCORE ? 'COMPLETED' : 'INCOMPLETE' };
}

async function commitInChunks(writes) {
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
        const batch = db.batch();
        writes.slice(i, i + BATCH_SIZE).forEach((w) => w(batch));
        await batch.commit();
    }
}

// Borra por tandas los documentos con field < cutoff
async function deleteOlder(collection, field, cutoff) {
    let deleted = 0;
    for (;;) {
        const old = await collection.where(field, '<', cutoff).limit(BATCH_SIZE).get();
        if (old.empty) break;
        await commitInChunks(old.docs.map((d) => (b) => b.delete(d.ref)));
        deleted += old.size;
        if (old.size < BATCH_SIZE) break;
    }
    return deleted;
}

async function cleanCondo(condoRef, now = new Date()) {
    const nowMs = now.getTime();
    const nowSql = sqlTime(nowMs);
    const [shifts, rounds, live] = await Promise.all([
        condoRef.collection('rondas_turnos').where('status', '==', 'ACTIVE').get(),
        condoRef.collection('rondas_rondas').where('status', '==', 'IN_PROGRESS').get(),
        condoRef.collection('rondas_en_vivo').get()
    ]);
    const writes = [];
    let closedShifts = 0;
    shifts.docs.filter((d) => isStaleShift(d.data(), nowMs)).forEach((d) => {
        closedShifts++;
        writes.push((b) => b.update(d.ref, { status: 'COMPLETED', actual_end: nowSql, notes: `Cerrado automáticamente: quedó abierto más de ${SHIFT_MAX_HOURS} horas` }));
    });

    // Rondas olvidadas: se cierran con el puntaje de los puntos que alcanzo a marcar
    const stale = rounds.docs.filter((d) => isStaleRound(d.data(), nowMs));
    const routes = new Map();
    for (const d of stale) {
        const round = d.data();
        if (!routes.has(round.route_id)) {
            const routeSnap = round.route_id ? await condoRef.collection('rondas_rutas').doc(String(round.route_id)).get() : null;
            routes.set(round.route_id, routeSnap && routeSnap.exists ? (routeSnap.data().checkpoints || []) : []);
        }
        const visits = await condoRef.collection('rondas_visitas').where('round_id', '==', d.id).get();
        const { score, status } = closingScore(routes.get(round.route_id), visits.docs.map((v) => v.data()));
        writes.push((b) => b.update(d.ref, { status, score, completed_at: nowSql, notes: 'Cerrada automáticamente' }));
    }
    live.docs.filter((d) => isStaleLive(d.data(), nowMs)).forEach((d) => writes.push((b) => b.delete(d.ref)));
    await commitInChunks(writes);

    const deletedLocations = await deleteOlder(condoRef.collection('rondas_ubicaciones'), 'timestamp', historyCutoff(nowMs));
    const deletedAlerts = await deleteOlder(condoRef.collection('rondas_alertas'), 'created_at', alertCutoff(nowMs));
    return { condoId: condoRef.id, closedShifts, closedRounds: stale.length, deletedLocations, deletedAlerts };
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

module.exports = { toMs, sqlTime, isStaleShift, isStaleRound, isStaleLive, historyCutoff, alertCutoff, closingScore, cleanCondo, cleanAll };
