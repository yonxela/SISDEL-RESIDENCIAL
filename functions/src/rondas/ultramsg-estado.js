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

// ───────── Que paso de verdad con cada mensaje ─────────
// "Enviado" en nuestro sistema = UltraMsg lo ACEPTO. Lo que cuenta es lo que UltraMsg dice despues: en cola, rechazado por
// WhatsApp (por ejemplo `temporary_block`), enviado (una palomita), entregado al telefono (dos) o leido. Se lee del listado
// de mensajes de la instancia (GET messages, 100 por pagina, mas nuevos primero).
const lastDigits = (v) => String(v || '').replace(/[^0-9]/g, '').slice(-8);

// Lista los mensajes mas nuevos de la instancia (status "all": enviados, en cola, no enviados e invalidos). Se detiene al llegar
// a mensajes mas viejos que `sinceSec` (segundos unix) o a `maxPages` paginas. null si no se puede leer.
async function listMessages(config, { sinceSec = 0, maxPages = 12 } = {}, fetchImpl = fetch) {
    if (!config || config.provider === 'simulado' || !config.ultramsgInstance || !config.ultramsgToken) return null;
    const rows = [];
    try {
        for (let page = 1; page <= maxPages; page++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            let res; let data;
            try {
                const url = `https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/messages?${new URLSearchParams({ token: config.ultramsgToken, page: String(page), limit: '100', status: 'all', sort: 'desc' })}`;
                res = await fetchImpl(url, { signal: controller.signal });
                data = await res.json().catch(() => null);
            } finally { clearTimeout(timer); }
            const batch = data && Array.isArray(data.messages) ? data.messages : Array.isArray(data) ? data : null;
            if (!res.ok || !batch) return rows.length ? rows : null;
            rows.push(...batch);
            const oldest = batch.length ? Number(batch[batch.length - 1].created_at) : 0;
            if (batch.length < 100 || (sinceSec && oldest && oldest < sinceSec)) break;
        }
        return rows;
    } catch (error) {
        return rows.length ? rows : null;
    }
}

// Estado de UN mensaje de UltraMsg -> { state, reason }
//  entregado (ack device/read/played) | enviado (ack server: llego a WhatsApp, una palomita) | pendiente (aceptado, sin confirmar)
//  en_cola | rechazado (unsent / invalid / expired, con su motivo)
function classify(row) {
    if (!row) return { state: 'desconocido', reason: '' };
    const status = String(row.status || '');
    const ack = String(row.ack || '');
    if (status === 'sent') {
        if (ack === 'device' || ack === 'read' || ack === 'played') return { state: 'entregado', reason: '' };
        if (ack === 'server') return { state: 'enviado', reason: '' };
        return { state: 'pendiente', reason: '' };
    }
    if (status === 'queue') return { state: 'en_cola', reason: '' };
    if (status === 'unsent' || status === 'invalid' || status === 'expired') {
        return { state: 'rechazado', reason: String(row.failed_reason || (status === 'invalid' ? 'invalid' : status)) };
    }
    return { state: 'desconocido', reason: '' };
}

// Texto para quien usa OIKOS: por que WhatsApp no entrego un mensaje
function describeReason(reason) {
    const r = String(reason || '');
    if (r === 'temporary_block') return 'WhatsApp bloqueó temporalmente el número del condominio (temporary_block): no deja escribir a contactos nuevos por ahora.';
    if (r === 'invalid') return 'ese número no tiene WhatsApp o está mal escrito.';
    if (r === 'expired') return 'el mensaje venció en la cola de UltraMsg (24 horas) sin poder salir.';
    return r ? `WhatsApp lo rechazó (${r}).` : 'WhatsApp no lo entregó.';
}

// Para UN envio: el mensaje mas reciente de UltraMsg hacia ese telefono desde `sinceSec` (con 5 s de margen)
function deliveryFor(rows, phone, sinceSec) {
    const last = lastDigits(phone);
    const mine = (rows || [])
        .filter((m) => lastDigits(m.to) === last && Number(m.created_at) >= sinceSec - 5)
        .sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return mine.length ? { ...classify(mine[0]), found: true } : { state: 'desconocido', reason: '', found: false };
}

// Para un envio a muchos: a cada destinatario ({ id, phone, sentAtMs }) le toca el mensaje de UltraMsg hacia su telefono con
// la hora mas cercana a la suya (por telefono; un propietario con varios lotes recibe varios mensajes). -> Map id -> row | null
function matchCampaign(rows, recipients, toleranceSec = 300) {
    const byPhone = new Map();
    for (const row of rows || []) {
        const key = lastDigits(row.to);
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push({ row, used: false });
    }
    const out = new Map();
    for (const r of [...recipients].sort((a, b) => a.sentAtMs - b.sentAtMs)) {
        const candidates = byPhone.get(lastDigits(r.phone)) || [];
        let best = null;
        for (const c of candidates) {
            if (c.used) continue;
            const diff = Math.abs(Number(c.row.created_at) - r.sentAtMs / 1000);
            if (diff <= toleranceSec && (!best || diff < best.diff)) best = { c, diff };
        }
        if (best) { best.c.used = true; out.set(r.id, best.c.row); } else out.set(r.id, null);
    }
    return out;
}

// Texto para quien usa OIKOS (siempre empieza con "WhatsApp no está conectado": la pantalla ofrece enviarlo a mano con wa.me)
function describeConnection(conn) {
    const state = conn && conn.state ? conn.state : 'desconocido';
    const how = state === 'qr' || state === 'disconnected' || state === 'logout'
        ? 'Vuelva a vincular el teléfono: en UltraMsg > Instances > Authentication escanee el código QR (WhatsApp > Dispositivos vinculados).'
        : 'Abra WhatsApp en el teléfono vinculado, revise que tenga internet y, si sigue igual, vuelva a vincularlo en UltraMsg > Instances > Authentication (código QR).';
    return `WhatsApp no está conectado (estado: ${state}). ${how}`;
}

module.exports = { connection, queueStats, describeConnection, listMessages, classify, describeReason, deliveryFor, matchCampaign };
