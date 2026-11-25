// Envio de WhatsApp: UltraMsg (principal) y Meta Cloud API (respaldo), como en SISDEL RONDIN.
// Las claves viven en _privado/whatsapp (solo el servidor las lee); se cargan con
// scripts/set-whatsapp.mjs. Sin claves, no se envia nada y la alerta lo registra.
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');
const estado = require('./ultramsg-estado');
const meta = require('./meta-estado');
const panicMeta = require('./panico-meta');

async function loadConfig() {
    const snap = await db.doc('_privado/whatsapp').get();
    return snap.exists ? snap.data() : null;
}

function hasProvider(config) {
    if (!config) return false;
    if (config.provider === 'simulado') return true;
    return !!((config.ultramsgInstance && config.ultramsgToken) || (config.metaToken && config.metaPhoneId));
}

async function sendUltraMsg(config, to, message) {
    if (!config.ultramsgInstance || !config.ultramsgToken) return false;
    try {
        const res = await fetch(`https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: config.ultramsgToken, to: `+${to}`, body: message })
        });
        const data = await res.json().catch(() => ({}));
        return res.ok && String(data.sent) === 'true';
    } catch (error) {
        logger.warn('whatsapp: UltraMsg fallo', { message: error.message });
        return false;
    }
}

async function sendMeta(config, to, message) {
    if (!config.metaToken || !config.metaPhoneId) return false;
    try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(config.metaPhoneId)}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.metaToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: message } })
        });
        return res.ok;
    } catch (error) {
        logger.warn('whatsapp: Meta fallo', { message: error.message });
        return false;
    }
}

// Por el WhatsApp OFICIAL de Meta (config.channel === 'meta'): con plantilla si se pide (opts.template + opts.params), si no texto
// libre (solo llega a quien escribio en las ultimas 24 h). Si falla, deja el motivo en opts.errors; nunca anota el token.
async function sendMetaOfficial(config, to, message, opts) {
    const result = opts.template
        ? await meta.sendTemplate(config, to, opts.template, opts.params || [])
        : await meta.sendText(config, to, message);
    if (result.ok) return true;
    logger.warn('whatsapp: Meta rechazo el mensaje', { code: result.code, message: result.error });
    if (Array.isArray(opts.errors)) opts.errors.push(`Meta (${result.code}): ${result.error}`);
    return false;
}

// Devuelve el canal usado o null si no salio por ninguno. Con config.channel === 'meta', los AVISOS con plantilla (opts.template:
// recordatorios) salen SOLO por Meta (no caen a UltraMsg, cuyo numero puede estar bloqueado). Un mensaje libre (alertas de panico,
// rondas/index.js) sigue como siempre, UltraMsg y de respaldo Meta: Meta solo deja mandar texto libre a quien escribio en las
// ultimas 24 horas, y una alerta de panico no puede depender de eso.
// opts: { template, params, errors }
async function send(config, to, message, opts = {}) {
    if (config.provider === 'simulado') return 'SIMULADO';
    if (meta.usesMeta(config) && opts.template) return (await sendMetaOfficial(config, to, message, opts)) ? 'META' : null;
    if (await sendUltraMsg(config, to, message)) return 'ULTRAMSG';
    if (await sendMeta(config, to, message)) return 'META';
    return null;
}

// Un aviso de panico (alerta, familiares o prueba): con config.panicChannel === 'meta' sale por el WhatsApp oficial con su
// plantilla (panico-meta.js); si no, como siempre. opts: { tipo, vars, errors, drill }
async function sendPanic(config, to, message, opts = {}) {
    if (config.provider === 'simulado') return 'SIMULADO';
    return panicMeta.sendPanicMessage(config, to, message, opts, {
        sendTemplate: (c, t, tpl, params) => meta.sendTemplate(c, t, tpl, params),
        legacy: (c, t, m) => send(c, t, m)
    });
}

// Estado de la conexion de UltraMsg (ver ultramsg-estado.js): connection, queueStats y describeConnection
module.exports = {
    loadConfig, hasProvider, send, sendPanic,
    // Estado de la conexion: del canal que se use (Meta o UltraMsg)
    connection: (config) => (meta.usesMeta(config) ? meta.connection(config) : estado.connection(config)),
    describeConnection: (conn) => (conn && conn.provider === 'meta' ? meta.describeConnection(conn) : estado.describeConnection(conn)),
    queueStats: (config) => (meta.usesMeta(config) ? null : estado.queueStats(config)),
    // Lo que UltraMsg dice de cada mensaje (en cola, rechazado, enviado, entregado): ver ultramsg-estado.js
    listMessages: (config, options) => (meta.usesMeta(config) ? null : estado.listMessages(config, options)),
    classify: estado.classify, describeReason: estado.describeReason, deliveryFor: estado.deliveryFor, matchCampaign: estado.matchCampaign,
    // Si WhatsApp esta dejando salir los mensajes de UltraMsg (palomitas), para frenar los envios con el numero restringido
    health: (config) => (meta.usesMeta(config) ? { confirming: null } : estado.health(config)),
    describeHealth: estado.describeHealth,
    // WhatsApp oficial de Meta con plantillas aprobadas (ver meta-estado.js)
    usesTemplates: meta.usesMeta, templateFor: meta.templateFor, templateParams: meta.templateParams, renderTemplate: meta.renderTemplate
};
