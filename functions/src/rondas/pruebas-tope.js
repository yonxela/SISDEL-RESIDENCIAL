// Tope de pruebas ("todo sin novedad", simulacros) con WhatsApp por dia. Sin firebase: se prueba con scripts/test-rondas-servidor.mjs.
const { DRILL_LIMITS } = require('./avisos');

// Tope PROPIO de pruebas de un vecino (pedido del usuario el 2026-11-27: UNION EMPRESARIAL, A006 de La Perla, apoya las pruebas y
// necesita 20 al dia). Vive en condominios/{c}/panico_config/pruebas = { vecinos: { <userId>: 20 } } (solo el servidor: las reglas
// solo dejan escribir 'general'; se carga con scripts/set-pruebas-panico.mjs y queda en la bitacora). Entero de 1 a DRILL_PERSONAL_MAX.
const DRILL_PERSONAL_MAX = 50;
function personalDrillLimit(cfg, userId) {
    const n = Number(cfg && cfg.vecinos && cfg.vecinos[userId]);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, DRILL_PERSONAL_MAX) : null;
}
// El lugar del dia: con tope propio solo cuenta el suyo y NO gasta los DRILL_LIMITS.perDay del condominio (asi los demas vecinos
// conservan los suyos); sin tope propio, los dos topes de siempre. Devuelve { ok, reason } o { ok, next } (el dia ya sumado)
function drillSlot(day, userId, personal) {
    const users = day.users || {};
    const used = users[userId] || 0;
    if (personal != null) {
        if (used >= personal) return { ok: false, reason: `Hoy ya hizo ${personal} simulacros con WhatsApp: este quedo solo en la pantalla de la garita` };
        return { ok: true, next: { count: day.count || 0, special: (day.special || 0) + 1, users: { ...users, [userId]: used + 1 } } };
    }
    if ((day.count || 0) >= DRILL_LIMITS.perDay) {
        return { ok: false, reason: `Hoy ya se hicieron ${DRILL_LIMITS.perDay} simulacros con WhatsApp en el condominio: este quedo solo en la pantalla de la garita` };
    }
    if (used >= DRILL_LIMITS.perUser) {
        return { ok: false, reason: `Hoy ya hizo ${DRILL_LIMITS.perUser} simulacros con WhatsApp: este quedo solo en la pantalla de la garita` };
    }
    return { ok: true, next: { count: (day.count || 0) + 1, users: { ...users, [userId]: used + 1 } } };
}
module.exports = { DRILL_PERSONAL_MAX, personalDrillLimit, drillSlot };
