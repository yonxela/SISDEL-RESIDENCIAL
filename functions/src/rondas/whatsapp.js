// Envio de WhatsApp: UltraMsg (principal) y Meta Cloud API (respaldo), como en SISDEL RONDIN.
// Las claves viven en _privado/whatsapp (solo el servidor las lee); se cargan con
// scripts/set-whatsapp.mjs. Sin claves, no se envia nada y la alerta lo registra.
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');

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

// Devuelve el canal usado o null si no salio por ninguno
async function send(config, to, message) {
    if (config.provider === 'simulado') return 'SIMULADO';
    if (await sendUltraMsg(config, to, message)) return 'ULTRAMSG';
    if (await sendMeta(config, to, message)) return 'META';
    return null;
}

module.exports = { loadConfig, hasProvider, send };
