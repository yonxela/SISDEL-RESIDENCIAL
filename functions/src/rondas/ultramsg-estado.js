// Estado de la conexion de UltraMsg (el WhatsApp del condominio). No importa firebase: se prueba con scripts/test-ultramsg-estado.mjs.
//
// Por que existe: UltraMsg ACEPTA los mensajes aunque su instancia este desconectada ("standby", "qr"...) y los deja EN COLA
// (a las 24 horas vencen). Mandar no falla, asi que el sistema decia "enviado" y no salia nada: pasó el 2026-11-16 con 712
// mensajes a La Perla (UltraMsg: sent 4, queue 709). Antes de mandar, y cada pocos mensajes, se pregunta si la instancia
// esta "authenticated".
const TIMEOUT_MS = 8000;

async function getJson(config, path, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const url = `https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/${path}?${new URLSearchParams({ token: config.ultramsgToken })}`;
        const res = await fetchImpl(url, { signal: controller.signal });
        const data = await res.json().catch(() => null);
        return { ok: res.ok, data };
    } finally {
        clearTimeout(timer);
    }
}

// { connected: true | false | null, state, provider }. null = no se pudo saber (UltraMsg no responde o no se puede
// consultar, por ejemplo con Meta): se deja seguir y el envio mismo dira si falla.
async function connection(config, fetchImpl = fetch) {
    if (!config) return { connected: false, state: 'sin-configurar', provider: null };
    if (config.provider === 'simulado') return { connected: true, state: 'simulado', provider: 'simulado' };
    if (!config.ultramsgInstance || !config.ultramsgToken) return { connected: null, state: 'sin-estado', provider: config.metaToken ? 'meta' : null };
    try {
        const { ok, data } = await getJson(config, 'instance/status', fetchImpl);
        const account = data && data.status && data.status.accountStatus;
        const state = account && account.status ? String(account.status) : '';
        if (!ok || !state) return { connected: null, state: 'sin-respuesta', provider: 'ultramsg' };
        return { connected: state === 'authenticated', state, provider: 'ultramsg' };
    } catch (error) {
        return { connected: null, state: 'sin-respuesta', provider: 'ultramsg' };
    }
}

// Cuantos mensajes tiene UltraMsg en cola, enviados, no enviados... (null si no se puede saber)
async function queueStats(config, fetchImpl = fetch) {
    if (!config || config.provider === 'simulado' || !config.ultramsgInstance || !config.ultramsgToken) return null;
    try {
        const { ok, data } = await getJson(config, 'messages/statistics', fetchImpl);
        const s = data && data.messages_statistics;
        if (!ok || !s) return null;
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        return { queued: num(s.queue), sent: num(s.sent), unsent: num(s.unsent), invalid: num(s.invalid), expired: num(s.expired) };
    } catch (error) {
        return null;
    }
}

// Texto para quien usa OIKOS (siempre empieza con "WhatsApp no está conectado": la pantalla ofrece enviarlo a mano con wa.me)
function describeConnection(conn) {
    const state = conn && conn.state ? conn.state : 'desconocido';
    const how = state === 'qr' || state === 'disconnected' || state === 'logout'
        ? 'Vuelva a vincular el teléfono: en UltraMsg > Instances > Authentication escanee el código QR (WhatsApp > Dispositivos vinculados).'
        : 'Abra WhatsApp en el teléfono vinculado, revise que tenga internet y, si sigue igual, vuelva a vincularlo en UltraMsg > Instances > Authentication (código QR).';
    return `WhatsApp no está conectado (estado: ${state}). ${how}`;
}

module.exports = { connection, queueStats, describeConnection };
