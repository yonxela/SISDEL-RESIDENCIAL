// Chat de WhatsApp con los residentes: el aviso de UltraMsg (webhook) y las funciones que usa OIKOS.
// La logica esta en whatsapp-chat-core.js. El webhook se activa con scripts/whatsapp-webhook.mjs (lo corre una persona):
// guarda la huella de una clave secreta en _privado/whatsapp.webhookTokenHash y le dice a UltraMsg a donde avisar
// (https://garita.app/api/whatsapp?token=<clave>, ver vercel.json).
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db } = require('./firebase');
const privilegios = require('./privilegios');
const rateLimit = require('./rateLimit');
const { sha256, safeEqual } = require('./util');
const crypto = require('crypto');
const base = require('./rondas/whatsapp');
const meta = require('./rondas/meta-estado');
const core = require('./whatsapp-chat-core');

const KEY = 'finanzas.whatsapp_chat';
const SEND_LIMIT = { max: 120, windowMs: 10 * 60 * 1000 };
const HISTORY_LIMIT = { max: 40, windowMs: 10 * 60 * 1000 };

// ── El WhatsApp del chat: UltraMsg (un WhatsApp conectado por QR) o el OFICIAL de Meta (Cloud API) ──
// Cada chat se contesta por el canal por el que escribio el residente; uno nuevo, por el del condominio (Meta si esta activo).
// Por Meta un mensaje libre solo vale hasta 24 horas despues del ultimo mensaje del residente (lo controla el core).
const hasUltra = (config) => !!(config && config.ultramsgInstance && config.ultramsgToken);
const canChat = (config) => !!config && (config.provider === 'simulado' || hasUltra(config) || meta.usesMeta(config));
const defaultChannel = (config) => (config && config.provider === 'simulado' ? (config.chatChannel || 'ultramsg') : (meta.usesMeta(config) ? 'meta' : 'ultramsg'));
const needsWindow = (channel) => channel === 'meta';
// El aviso aprobado por Meta (aviso_general) con lo escrito en el chat, para escribirle a un residente fuera de las 24 horas (o que
// nunca le escribio al numero oficial). { tpl, params, text } o null si no hay una plantilla con hueco para el aviso
// Primero la plantilla CORTA del chat (mensaje_chat, metaTemplates.chat: "Mensaje de la administracion de X: lo escrito. Puede
// responder a este chat."), que parece un mensaje normal; si no esta cargada, o Meta no la entrega, la de aviso_general (fallback)
function chatTemplate(config, vars) {
    const build = (tpl) => {
        if (!tpl || !tpl.params.includes('aviso')) return null;
        const params = meta.templateParams(tpl, vars);
        return { tpl, params, text: meta.renderTemplate(tpl, params).trim() };
    };
    const short = build(meta.normalizeTemplate(config && config.metaTemplates && config.metaTemplates.chat));
    const general = build(meta.templateFor(config, 'varios'));
    if (short) return { ...short, fallback: general };
    return general;
}
async function sendChat(config, phone, body, referenceId, channel, template) {
    if (config.provider === 'simulado') return { ok: true, id: channel === 'meta' ? `wamid.SIM-${referenceId}` : `SIM-${referenceId}` };
    if (channel === 'meta') {
        if (!meta.usesMeta(config)) return { ok: false, error: 'El WhatsApp oficial (Meta) no está activo' };
        if (template && template.fallback) {
            const first = await meta.sendTemplate(config, phone, template.tpl, template.params);
            if (first.ok) return { ok: true, id: String(first.id || '') };
            logger.warn('whatsapp-chat: Meta no entrego la plantilla corta, va la general', { code: first.code, error: first.error });
            const second = await meta.sendTemplate(config, phone, template.fallback.tpl, template.fallback.params);
            return second.ok ? { ok: true, id: String(second.id || ''), used: template.fallback } : { ok: false, error: `Meta (${second.code}): ${second.error}` };
        }
        const r = template ? await meta.sendTemplate(config, phone, template.tpl, template.params) : await meta.sendText(config, phone, body);
        return r.ok ? { ok: true, id: String(r.id || '') } : { ok: false, error: `Meta (${r.code}): ${r.error}` };
    }
    if (!hasUltra(config)) return { ok: false, error: 'UltraMsg no está configurado' };
    try {
        const res = await fetch(`https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: config.ultramsgToken, to: `+${phone}`, body, referenceId })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && String(data.sent) === 'true') return { ok: true, id: String(data.id || '') };
        return { ok: false, error: String(data.error || data.message || `UltraMsg respondio ${res.status}`).slice(0, 200) };
    } catch (error) {
        logger.warn('whatsapp-chat: UltraMsg fallo al enviar', { message: error.message });
        return { ok: false, error: 'No se pudo conectar con WhatsApp' };
    }
}
async function chatHistory(config, phone, limit) {
    if (config.provider === 'simulado') return [];
    const url = `https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/chats/messages?${new URLSearchParams({ token: config.ultramsgToken, chatId: `${phone}@c.us`, limit: String(limit) })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`UltraMsg respondio ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : []);
}
const whatsapp = { loadConfig: base.loadConfig, canChat, defaultChannel, needsWindow, sendChat, chatHistory, chatTemplate };

// ── Quien llama: un usuario activo del condominio con el chat de WhatsApp ──
async function authorize(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const condominioId = token.condominioId;
    if (!condominioId) throw new HttpsError('permission-denied', 'Sin permisos');
    const me = await db.doc(`condominios/${condominioId}/usuarios/${uid}`).get();
    const allowed = me.exists && me.data().active !== false && privilegios.has(me.data().role, me.data().privilegios, KEY);
    if (!allowed) throw new HttpsError('permission-denied', 'Su usuario no tiene permiso para el chat de WhatsApp.');
    return { uid, condominioId, caller: { id: uid, name: me.data().name || '' } };
}

function wrap(name, handler) {
    return onCall({ timeoutSeconds: 60 }, async (request) => {
        try {
            return await handler(request);
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            if (error && error.userCode) throw new HttpsError(error.userCode, error.message);
            logger.error(`whatsapp-chat: ${name} fallo`, { message: error && error.message });
            throw new HttpsError('internal', 'No se pudo completar. Intente de nuevo.');
        }
    });
}

const sendChatMessage = wrap('sendChatMessage', async (request) => {
    const { uid, condominioId, caller } = await authorize(request);
    if (await rateLimit.isBlocked('whatsapp_chat', uid, SEND_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Envió muchos mensajes seguidos. Espere unos minutos.');
    }
    await rateLimit.hit('whatsapp_chat', uid, SEND_LIMIT);
    const result = await core.sendMessage({ db, whatsapp, condominioId, caller, data: request.data || {} });
    logger.info('whatsapp-chat: mensaje enviado', { condominioId, ok: result.ok, por: uid, chat: String(result.chatId || '').slice(-4) });
    return result;
});

const markChatRead = wrap('markChatRead', async (request) => {
    const { condominioId, caller } = await authorize(request);
    return core.markRead({ db, condominioId, caller, data: request.data || {} });
});

const loadChatHistory = wrap('loadChatHistory', async (request) => {
    const { uid, condominioId } = await authorize(request);
    if (await rateLimit.isBlocked('whatsapp_historial', uid, HISTORY_LIMIT)) return { ok: false, saved: 0, reason: 'limite' };
    await rateLimit.hit('whatsapp_historial', uid, HISTORY_LIMIT);
    return core.loadHistory({ db, whatsapp, condominioId, data: request.data || {} });
});

// ── El aviso: de UltraMsg (clave secreta en ?token=, se compara su huella, y la instancia debe ser la del condominio) o de
// Meta (verificacion con hub.verify_token al configurarlo, y cada aviso firmado con la clave de la aplicacion: X-Hub-Signature-256)
const digits = (v) => String(v || '').replace(/\D/g, '');
function metaSignatureOk(config, req) {
    const secret = config && config.metaAppSecret;
    const header = String(req.get('X-Hub-Signature-256') || '');
    if (!secret || !header.startsWith('sha256=') || !req.rawBody) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(req.rawBody).digest('hex');
    return safeEqual(header, expected);
}
const whatsappWebhook = onRequest(
    { cors: false, invoker: 'public', memory: '256MiB', timeoutSeconds: 60 },
    async (req, res) => {
        try {
            const config = await base.loadConfig();
            // Meta comprueba la direccion con un GET y una clave que se le dio (whatsapp-webhook.mjs --meta)
            if (req.method === 'GET' && req.query['hub.mode'] === 'subscribe') {
                const given = String(req.query['hub.verify_token'] || '');
                if (config && config.metaVerifyTokenHash && given && safeEqual(sha256(given), config.metaVerifyTokenHash)) {
                    res.status(200).send(String(req.query['hub.challenge'] || ''));
                } else {
                    logger.warn('whatsapp-chat: verificacion de Meta con clave invalida');
                    res.status(403).send('Clave invalida');
                }
                return;
            }
            if (req.method !== 'POST') { res.status(405).send('Metodo no permitido'); return; }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            if (core.isMeta(body)) {
                if (!metaSignatureOk(config, req)) {
                    logger.warn('whatsapp-chat: aviso de Meta sin firma valida');
                    res.status(403).send('Firma invalida');
                    return;
                }
                const result = await core.handleWebhook({ db, body });
                res.status(200).json({ ok: true, handled: result.handled });
                return;
            }
            const token = String(req.query.token || req.get('X-Webhook-Token') || '');
            if (!config || !config.webhookTokenHash || !token || !safeEqual(sha256(token), config.webhookTokenHash)) {
                logger.warn('whatsapp-chat: aviso con clave invalida');
                res.status(403).send('Clave invalida');
                return;
            }
            if (config.ultramsgInstance && body.instanceId && digits(body.instanceId) !== digits(config.ultramsgInstance)) {
                logger.warn('whatsapp-chat: aviso de otra instancia');
                res.status(403).send('Instancia distinta');
                return;
            }
            const result = await core.handleWebhook({ db, body });
            res.status(200).json({ ok: true, handled: result.handled });
        } catch (error) {
            logger.error('whatsapp-chat: el aviso fallo', { message: error && error.message });
            // 200 igual: si UltraMsg reintenta sin fin con un aviso que siempre falla, se llenaria el registro
            res.status(200).json({ ok: false });
        }
    }
);

module.exports = { whatsappWebhook, sendChatMessage, markChatRead, loadChatHistory, _whatsapp: whatsapp };
