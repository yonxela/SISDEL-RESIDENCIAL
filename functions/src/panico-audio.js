// ═══════════════════════════════════════════════════════════════
// Audio de doble via entre la garita y el vecino que pidio ayuda (pedido del usuario el 2026-11-24: "si es posible mostrar opcion
// para que garita y vecino que pide ayuda queden conectados en audio de doble via, es decir garita presiona boton y podra hablar
// con vecino afectado o escuchar lo que esta pasando").
//
// El audio va directo entre los dos navegadores (WebRTC); este servidor solo pasa la "llamada" (la oferta y la respuesta de cada
// lado, con sus direcciones de red ya juntas: sin ir y venir de candidatos). panicAudio (callable):
//   ice     las direcciones de los servidores de enlace (STUN de Google y, si se configuro, TURN en _privado/webrtc)
//   offer   la garita llama (quien atiende alertas: panico.atender) -> condominios/{c}/alertas_panico/{id}/audio/llamada
//   wait    la garita pregunta si ya contesto
//   poll    el telefono del vecino pregunta si lo estan llamando (cada pocos segundos mientras su alerta este abierta)
//   answer  el telefono del vecino contesta SOLO (el vecino pidio ayuda: la garita lo escucha sin que toque nada)
//   hangup  cualquiera de los dos cuelga
//   want    el vecino toco "HABLAR A CENTRAL DE MONITOREO" (pedido del usuario el 2026-11-25): la alerta queda con
//           audioWant { at, mic } y la central ve "PIDE HABLAR" en su "Escuchar / Hablar" (mic: si su telefono dio el microfono)
// El vecino entra con su sesion (vecino.html) o con la clave del telefono vinculado al QR (panico.html, sin sesion); contesta solo
// el telefono que envio la alerta (los demas de la casa reciben el aviso, no la llamada). La llamada
// solo existe mientras la alerta este activa o atendida (y de menos de 6 horas). Las reglas no dejan leer ni escribir el audio
// desde el navegador: todo pasa por aqui. Nada se graba: solo se guarda quien llamo, cuando y como termino.
//
// TURN: en redes de celular muchas veces no hay camino directo y hace falta un servidor de enlace (TURN). Se configura con
// scripts/set-audio-enlace.mjs en _privado/webrtc: { iceServers: [...] } (cualquier proveedor) o { cloudflare: { keyId, apiToken } }
// (credenciales de 24 horas que se piden a Cloudflare). Sin configurar, solo STUN: funciona en muchas redes, no en todas.
// ═══════════════════════════════════════════════════════════════
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const crypto = require('crypto');
const { db } = require('./firebase');
const { sha256 } = require('./util');
const privilegios = require('./privilegios');
const rateLimit = require('./rateLimit');

const ACTIONS = ['ice', 'offer', 'wait', 'poll', 'answer', 'hangup', 'want'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{40,64}$/;
const SDP_MAX = 20000;
const RING_MS = 90 * 1000;             // una llamada sin contestar caduca
const OPEN_ALERT_MS = 6 * 3600 * 1000; // como el QR: una alerta de mas de 6 horas ya no se llama
const OFFER_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 };
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const CONFIG_DOC = '_privado/webrtc';
const CF_TTL = 24 * 3600;

const cleanId = (v) => (ID_RE.test(String(v || '')) ? String(v) : '');
const nowIso = () => new Date().toISOString();
const fail = (code, text) => { throw new HttpsError(code, text); };

// ── Servidores de enlace ──
let iceCache = null; // { at, servers } por instancia: Cloudflare no se pide en cada llamada
async function iceServers() {
    if (iceCache && Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache.servers;
    let servers = STUN;
    try {
        const snap = await db.doc(CONFIG_DOC).get();
        const cfg = snap.exists ? snap.data() : {};
        if (cfg.cloudflare && cfg.cloudflare.keyId && cfg.cloudflare.apiToken) {
            const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfg.cloudflare.keyId)}/credentials/generate`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.cloudflare.apiToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl: CF_TTL })
            });
            if (!res.ok) throw new Error(`Cloudflare ${res.status}`);
            const body = await res.json();
            const got = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
            if (got.length) servers = [...STUN, ...got];
        } else if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
            servers = [...STUN, ...cfg.iceServers.filter((s) => s && s.urls)];
        }
    } catch (e) {
        logger.error('audio panico: servidores de enlace', { error: e.message });
    }
    iceCache = { at: Date.now(), servers };
    return servers;
}

// ── Quien llama ──
// { kind: 'staff', userId, name } o { kind: 'vecino', userId }; null si no puede
async function whoIs(request, condoId, data) {
    const secret = String(data.secret || '');
    if (secret) {
        if (!SECRET_RE.test(secret)) return null;
        const dev = await db.doc(`condominios/${condoId}/panico_dispositivos/${sha256(secret)}`).get();
        if (!dev.exists || dev.data().revokedAt) return null;
        const d = dev.data();
        // El codigo con que se vinculo sigue siendo un codigo vigente del vecino (como en panico-qr.js)
        const codes = await db.collection('codigos').where('userId', '==', d.userId).get();
        if (!codes.docs.some((c) => c.data().condominioId === condoId && sha256(c.id) === d.codeHash)) return null;
        return { kind: 'vecino', userId: d.userId, deviceId: dev.id };
    }
    if (!request.auth) return null;
    const { uid, token } = request.auth;
    if (!token || token.condominioId !== condoId) return null;
    const me = await db.doc(`condominios/${condoId}/usuarios/${uid}`).get();
    if (!me.exists || me.data().active === false) return null;
    const u = me.data();
    if (u.role === 'vecino') return { kind: 'vecino', userId: uid };
    if (privilegios.has(u.role, u.privilegios, 'panico.atender')) return { kind: 'staff', userId: uid, name: String(u.name || '').slice(0, 80) };
    return null;
}

function sdpOk(sdp) { return typeof sdp === 'string' && sdp.length > 20 && sdp.length <= SDP_MAX && sdp.startsWith('v=0'); }

const panicAudio = onCall({ timeoutSeconds: 30 }, async (request) => {
    const data = request.data || {};
    const action = String(data.action || '');
    if (!ACTIONS.includes(action)) fail('invalid-argument', 'Acción no válida');
    const condoId = cleanId(data.c);
    const alertId = cleanId(data.alertId);
    if (!condoId || !alertId) fail('invalid-argument', 'Faltan datos');

    const who = await whoIs(request, condoId, data);
    if (!who) fail('permission-denied', 'Sin permiso para el audio de esta alerta');
    const alertRef = db.doc(`condominios/${condoId}/alertas_panico/${alertId}`);
    const alertSnap = await alertRef.get();
    const alert = alertSnap.exists ? alertSnap.data() : null;
    if (!alert || alert.source !== 'vecino') fail('not-found', 'No se encontró la alerta');
    if (who.kind === 'vecino' && alert.userId !== who.userId) fail('permission-denied', 'Sin permiso para el audio de esta alerta');
    // Contesta SOLO el telefono que envio la alerta: el del QR que la envio, o el portal si salio del portal (no los demas de la casa)
    if (who.kind === 'vecino' && (who.deviceId ? alert.deviceId !== who.deviceId : !!alert.deviceId)) fail('permission-denied', 'La llamada es para el teléfono que envió la alerta');
    const open = ['ACTIVE', 'ATTENDED'].includes(alert.status) && Date.now() - Date.parse(alert.createdAt || '') < OPEN_ALERT_MS;

    if (action === 'ice') return { ok: true, iceServers: await iceServers() };

    const callRef = alertRef.collection('audio').doc('llamada');
    const callSnap = await callRef.get();
    const call = callSnap.exists ? callSnap.data() : null;
    const ringing = !!call && call.state === 'llamando' && Date.now() - Date.parse(call.at || '') < RING_MS;
    const log = (outcome, extra = {}) => logger.info('audio panico', { action, outcome, condominioId: condoId, alertId, kind: who.kind, ...extra });

    if (who.kind === 'staff') {
        if (action === 'offer') {
            if (!open) return { ok: false, error: 'La alerta ya está cerrada.' };
            if (!sdpOk(data.sdp)) fail('invalid-argument', 'Llamada no válida');
            const key = `${condoId}/${who.userId}`;
            if (await rateLimit.isBlocked('panico_audio', key, OFFER_LIMIT)) return { ok: false, error: 'Demasiadas llamadas en pocos minutos: espere un momento.' };
            await rateLimit.hit('panico_audio', key, OFFER_LIMIT);
            const callId = crypto.randomBytes(9).toString('base64url');
            await callRef.set({ callId, state: 'llamando', offer: data.sdp, answer: null, by: who.userId, byName: who.name, at: nowIso(), answeredAt: null, endedAt: null, endedBy: null });
            // Si el vecino habia pedido hablar, ya se le llamo: las demas pantallas dejan de decir "PIDE HABLAR"
            if (alert.audioWant && !alert.audioWant.calledAt) await alertRef.update({ 'audioWant.calledAt': nowIso() });
            log('ok', { callId });
            return { ok: true, callId };
        }
        if (action === 'wait') {
            if (!call || call.callId !== data.callId) return { ok: true, state: 'colgado' };
            if (call.state === 'llamando' && !ringing) return { ok: true, state: 'sin_respuesta' };
            return { ok: true, state: call.state, answer: call.state === 'conectado' ? call.answer : null };
        }
        if (action === 'hangup') {
            if (call && call.callId === data.callId && call.state !== 'colgado') await callRef.update({ state: 'colgado', endedAt: nowIso(), endedBy: 'garita' });
            log('ok');
            return { ok: true };
        }
        fail('permission-denied', 'Esta acción es del teléfono del vecino');
    }

    // El telefono del vecino
    if (action === 'poll') {
        if (!open) return { ok: true, open: false };
        if (ringing) return { ok: true, open: true, call: { callId: call.callId, offer: call.offer, byName: call.byName || 'La garita' } };
        return { ok: true, open: true, state: call ? call.state : null, callId: call ? call.callId : null };
    }
    if (action === 'answer') {
        if (!open || !ringing || !call || call.callId !== data.callId) return { ok: false, error: 'La llamada ya no está.' };
        if (!sdpOk(data.sdp)) fail('invalid-argument', 'Respuesta no válida');
        await callRef.update({ state: 'conectado', answer: data.sdp, answeredAt: nowIso() });
        log('ok', { callId: call.callId });
        return { ok: true };
    }
    if (action === 'hangup') {
        if (call && call.callId === data.callId && call.state !== 'colgado') await callRef.update({ state: 'colgado', endedAt: nowIso(), endedBy: 'vecino' });
        log('ok');
        return { ok: true };
    }
    // "HABLAR A CENTRAL DE MONITOREO": la central ve que el vecino pide hablar (y si su telefono ya dio el microfono)
    if (action === 'want') {
        if (!open) return { ok: false, error: 'La alerta ya está cerrada.' };
        // Sin microfono, el telefono dice por que (el nombre del error del navegador) y que telefono y navegador es (2026-11-25: un
        // iPhone lo negaba sin preguntar y no se sabia por que). Solo texto corto, para el registro
        const micError = data.mic === true ? '' : String(data.micError || '').replace(/[^A-Za-z]/g, '').slice(0, 40);
        const ua = String(data.ua || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
        await alertRef.update({ audioWant: { at: nowIso(), mic: data.mic === true, ...(micError ? { micError } : {}) } });
        log('ok', { mic: data.mic === true, ...(micError ? { micError } : {}), ...(ua ? { ua } : {}), ...(data.micMs != null ? { micMs: Math.max(0, Math.min(600000, Number(data.micMs) || 0)) } : {}) });
        return { ok: true };
    }
    fail('permission-denied', 'Esta acción es de la garita');
});

module.exports = { panicAudio, _test: { iceServers, whoIs, sdpOk, resetIceCache: () => { iceCache = null; } } };
