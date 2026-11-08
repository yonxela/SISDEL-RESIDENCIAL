/* ═══════════════════════════════════════════════════════════════
   SISDEL - Rondas: logica pura (sin Firebase ni pantalla)
   ───────────────────────────────────────────────────────────────
   Traida de SISDEL RONDIN (routes/rounds.js y public/js/app.js) y adaptada.
   La usan rondin.html (app del guardia) y rondas.html (panel); se prueba en
   scripts/test-rondas-logic.mjs.
   ═══════════════════════════════════════════════════════════════ */

const SisdelRondasLogic = (() => {
    // Puntaje minimo para que una ronda cuente como completa (igual que RONDIN)
    const COMPLETE_SCORE = 80;
    // Distancia maxima para aceptar un punto marcado con su codigo impreso
    const CODE_MAX_DISTANCE = 100;
    // Cada cuanto se manda la posicion en vivo y cada cuanto se guarda en el historial
    const LIVE_MIN_SECONDS = 20;
    const LIVE_MIN_METERS = 25;
    const HISTORY_MIN_SECONDS = 60;
    // Un guardia sin señal por mas de esto se muestra como desconectado
    const STALE_MINUTES = 5;

    const SHIFT_TYPES = {
        '12H_DIA': { label: 'Día (08:00 a 20:00)', start: '08:00', end: '20:00' },
        '12H_NOCHE': { label: 'Noche (20:00 a 08:00)', start: '20:00', end: '08:00' },
        '24H': { label: '24 horas', start: '00:00', end: '23:59' },
        'PERSONALIZADO': { label: 'Horario personalizado', start: '', end: '' }
    };

    const INCIDENT_TYPES = ['Robo', 'Vandalismo', 'Persona sospechosa', 'Vehículo sospechoso', 'Daño a instalaciones', 'Emergencia médica', 'Ruido o disturbio', 'Otro'];
    const SEVERITIES = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

    // Distancia en metros entre dos coordenadas
    function haversine(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function activeCheckpoints(route) {
        return ((route && route.checkpoints) || [])
            .filter((c) => c && c.active !== false)
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    function mandatoryCheckpoints(route) {
        return activeCheckpoints(route).filter((c) => c.mandatory !== false);
    }

    // Punto mas cercano a una posicion: { checkpoint, distance }
    function nearestCheckpoint(route, pos) {
        let best = null;
        activeCheckpoints(route).forEach((c) => {
            const distance = haversine(pos.lat, pos.lng, c.lat, c.lng);
            if (!best || distance < best.distance) best = { checkpoint: c, distance };
        });
        return best;
    }

    // Puede marcar el punto por GPS: dentro del radio (con un margen por la precision del GPS, maximo 15 m)
    function withinRadius(checkpoint, distance, accuracy) {
        const radius = Number(checkpoint.radius) || 25;
        const margin = Math.min(Math.max(Number(accuracy) || 0, 0), 15);
        return distance <= radius + margin;
    }

    // Estado de la visita: VALID o SUSPICIOUS (como RONDIN), segun como se marco el punto
    function visitStatus(checkpoint, distance, method, accuracy) {
        if (method === 'CODIGO') return distance <= CODE_MAX_DISTANCE ? 'VALID' : 'SUSPICIOUS';
        return withinRadius(checkpoint, distance, accuracy) ? 'VALID' : 'SUSPICIOUS';
    }

    // Ids de los puntos obligatorios visitados de forma valida en una ronda
    function validVisitedIds(visits) {
        return new Set((visits || []).filter((v) => v && v.status === 'VALID').map((v) => v.checkpointId));
    }

    // Puntaje: porcentaje de puntos obligatorios visitados (RONDIN: COMPLETED desde 80)
    function roundScore(route, visits) {
        const mandatory = mandatoryCheckpoints(route);
        if (!mandatory.length) return { score: 0, visited: 0, total: 0, missing: [], status: 'INCOMPLETE' };
        const done = validVisitedIds(visits);
        const missing = mandatory.filter((c) => !done.has(c.id));
        const visited = mandatory.length - missing.length;
        const score = Math.round((visited / mandatory.length) * 1000) / 10;
        return { score, visited, total: mandatory.length, missing, status: score >= COMPLETE_SCORE ? 'COMPLETED' : 'INCOMPLETE' };
    }

    // La ronda se cierra sola cuando estan todos los puntos obligatorios
    function isRoundDone(route, visits) {
        const r = roundScore(route, visits);
        return r.total > 0 && r.visited === r.total;
    }

    // Siguiente punto esperado en una ruta de orden secuencial
    function nextCheckpoint(route, visits) {
        const done = validVisitedIds(visits);
        return mandatoryCheckpoints(route).find((c) => !done.has(c.id)) || null;
    }

    // ¿Corresponde mandar la posicion? (cada 20 s o al moverse 25 m; historial cada 60 s)
    function locationDue(last, pos, nowMs) {
        if (!last) return { live: true, history: true };
        const seconds = (nowMs - last.atMs) / 1000;
        const moved = haversine(last.lat, last.lng, pos.lat, pos.lng);
        const historySeconds = (nowMs - (last.historyAtMs || 0)) / 1000;
        return {
            live: seconds >= LIVE_MIN_SECONDS || moved >= LIVE_MIN_METERS,
            history: historySeconds >= HISTORY_MIN_SECONDS
        };
    }

    function minutesOf(hhmm) {
        const [h, m] = String(hhmm || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
        return h * 60 + m;
    }

    function ymd(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    // ¿La asignacion cubre este momento? Soporta turnos que cruzan la medianoche (20:00 a 08:00)
    function assignmentActiveAt(assignment, now) {
        if (!assignment || assignment.status === 'INACTIVE') return false;
        const start = minutesOf(assignment.hourStart);
        const end = minutesOf(assignment.hourEnd);
        const minute = now.getHours() * 60 + now.getMinutes();
        const overnight = end <= start;
        // En un turno nocturno, la madrugada pertenece al turno que empezo el dia anterior
        let shiftDay = new Date(now);
        if (overnight && minute < end) shiftDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const day = ymd(shiftDay);
        if ((assignment.dateStart && day < assignment.dateStart) || (assignment.dateEnd && day > assignment.dateEnd)) return false;
        if (!overnight) return minute >= start && minute <= end;
        return minute >= start || minute < end;
    }

    // ¿El guardia sigue conectado?
    function isStale(atIso, nowMs) {
        const t = Date.parse(atIso || '');
        return !Number.isFinite(t) || nowMs - t > STALE_MINUTES * 60000;
    }

    // Codigo corto e impreso para marcar un punto sin GPS (sin letras que se confunden)
    function checkpointCode() {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
        return code;
    }

    function normalizeCode(code) { return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

    // Resumen para reportes (director general, auditor): por guardia y por ruta
    function summarize(rounds, incidents, panics) {
        const byGuard = new Map();
        const byRoute = new Map();
        const add = (map, key, name, r) => {
            const e = map.get(key) || { name, rounds: 0, completed: 0, incomplete: 0, scoreSum: 0 };
            e.rounds++;
            if (r.status === 'COMPLETED') e.completed++;
            else e.incomplete++;
            e.scoreSum += Number(r.score) || 0;
            map.set(key, e);
        };
        const closed = (rounds || []).filter((r) => r && r.status !== 'IN_PROGRESS');
        closed.forEach((r) => {
            add(byGuard, r.guardId, r.guardName || r.guardId, r);
            add(byRoute, r.routeId, r.routeName || r.routeId, r);
        });
        const finish = (map) => [...map.values()]
            .map((e) => ({ ...e, avgScore: e.rounds ? Math.round((e.scoreSum / e.rounds) * 10) / 10 : 0 }))
            .sort((a, b) => b.rounds - a.rounds);
        const completed = closed.filter((r) => r.status === 'COMPLETED').length;
        const scoreSum = closed.reduce((s, r) => s + (Number(r.score) || 0), 0);
        return {
            rounds: closed.length,
            completed,
            incomplete: closed.length - completed,
            avgScore: closed.length ? Math.round((scoreSum / closed.length) * 10) / 10 : 0,
            incidents: (incidents || []).length,
            openIncidents: (incidents || []).filter((i) => i.status !== 'RESOLVED').length,
            panics: (panics || []).filter((p) => p.status !== 'CANCELLED').length,
            byGuard: finish(byGuard),
            byRoute: finish(byRoute)
        };
    }

    return {
        COMPLETE_SCORE, CODE_MAX_DISTANCE, STALE_MINUTES, SHIFT_TYPES, INCIDENT_TYPES, SEVERITIES,
        haversine, activeCheckpoints, mandatoryCheckpoints, nearestCheckpoint, withinRadius, visitStatus,
        roundScore, isRoundDone, nextCheckpoint, locationDue, assignmentActiveAt, isStale,
        checkpointCode, normalizeCode, summarize, ymd
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SisdelRondasLogic;
