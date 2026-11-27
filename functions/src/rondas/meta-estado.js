// WhatsApp OFICIAL de Meta (Cloud API) con plantillas aprobadas. No importa firebase: se prueba con scripts/test-meta-estado.mjs.
//
// Por que existe: con UltraMsg el numero es un WhatsApp "normal" conectado por QR y WhatsApp lo bloqueo por mandar cientos de
// mensajes a contactos nuevos (temporary_block, 2026-11-17). Con la API oficial el numero es de una cuenta de empresa y los avisos
// masivos van con PLANTILLAS aprobadas por Meta: un texto fijo con huecos ({{1}}, {{2}}...) que se llenan con los datos de cada
// residente. Un mensaje libre solo se puede mandar a quien escribio en las ultimas 24 horas.
//
// Configuracion (en _privado/whatsapp, solo la lee el servidor; se carga con scripts/set-whatsapp.mjs y
// scripts/set-whatsapp-plantillas.mjs):
//   metaToken, metaPhoneId            claves de Meta (secretas)
//   channel: 'meta'                   manda SOLO por Meta (sin caer a UltraMsg); sin esto todo sigue como antes
//   metaTemplates: { mora, general }  { name, language, params: ['nombre', 'casa', ...], body }  (no secretas)
const TIMEOUT_MS = 10000;
const API = 'https://graph.facebook.com/v21.0';
// Datos de cada residente que una plantilla puede usar (los mismos {nombre}, {casa}... de los mensajes de OIKOS) y `aviso`: el texto
// que la administracion escribe en OIKOS para Mensajes varios (pedido del usuario el 2026-11-25: convocatorias, cortes de agua,
// cobros...), que va dentro de una plantilla con un hueco para el (aviso_general)
const VARIABLES = ['nombre', 'casa', 'saldo', 'cuotas', 'mora', 'condominio', 'aviso'];
// Las plantillas de los avisos enviadas a Meta el 2026-11-25 (Utilidad, espanol), con el dato de cada hueco
const DEFAULT_TEMPLATES = {
    mora: {
        name: 'aviso_mora', language: 'es', params: ['nombre', 'condominio', 'casa', 'saldo'],
        body: 'Hola {{1}}, le saluda la administración de {{2}}. Le recordamos que su lote {{3}} tiene un saldo pendiente de {{4}}. Si ya realizó su pago, se lo agradecemos y puede ignorar este mensaje.'
    },
    general: {
        name: 'aviso_general', language: 'es', params: ['nombre', 'condominio', 'aviso'],
        body: 'Hola {{1}}, la administración de {{2}} le informa: {{3}}. Si tiene alguna duda, comuníquese con la administración de su residencial.'
    },
    // La del CHAT de OIKOS (enviada el 2026-11-27, Marketing: como Utilidad Meta la rechazaba): lo escrito en el chat, corto, como
    // un mensaje normal, para escribirle a un vecino fuera de las 24 horas. Se carga con set-whatsapp-plantillas.mjs --chat
    chat: {
        name: 'mensaje_chat', language: 'es', params: ['condominio', 'aviso'],
        body: 'Mensaje de la administración de {{1}}: {{2}}. Puede responder a este chat.'
    }
};

const usesMeta = (config) => !!(config && config.channel === 'meta' && config.metaToken && config.metaPhoneId);

// Una plantilla valida o null. `params` dice que dato va en {{1}}, {{2}}...; `body` es el texto aprobado en Meta (para mostrarlo).
// `variables`: los datos que puede usar (los de un residente; las alertas de panico usan los suyos, panico-meta.js)
function normalizeTemplate(raw, variables = VARIABLES) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    if (!/^[a-z0-9_]{1,200}$/.test(name)) return null;
    const language = String(raw.language || 'es').trim() || 'es';
    const params = Array.isArray(raw.params) ? raw.params.map((p) => String(p).trim().toLowerCase()) : [];
    if (params.some((p) => !variables.includes(p))) return null;
    return { name, language, params, body: String(raw.body || '') };
}
// Plantilla de un tipo de aviso: 'mora' (mensaje por morosidad) o 'general' (mensajes varios)
function templateFor(config, mode) {
    const key = mode === 'varios' ? 'general' : 'mora';
    return normalizeTemplate(config && config.metaTemplates && config.metaTemplates[key]);
}
// Meta rechaza parametros vacios, con saltos de linea, tabuladores o mas de 4 espacios seguidos
const cleanParam = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 1000) || '-';
const templateParams = (tpl, vars) => tpl.params.map((key) => cleanParam(vars && vars[key]));
// El texto que le llega al residente: el cuerpo de la plantilla con sus datos
const renderTemplate = (tpl, params) => String(tpl.body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => (params[Number(n) - 1] != null ? params[Number(n) - 1] : ''));
// Cuantos huecos {{n}} tiene un texto (debe coincidir con los datos de la plantilla)
function bodyParamCount(body) {
    const numbers = [...String(body || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return numbers.length ? Math.max(...numbers) : 0;
}

function buildTemplatePayload(to, tpl, params) {
    return {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
            name: tpl.name, language: { code: tpl.language },
            components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : []
        }
    };
}

async function post(config, payload, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${API}/${encodeURIComponent(config.metaPhoneId)}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.metaToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, id: data && data.messages && data.messages[0] ? data.messages[0].id : null };
        const e = (data && data.error) || {};
        return { ok: false, code: e.code || res.status, error: String(e.error_user_msg || e.message || `HTTP ${res.status}`).slice(0, 300) };
    } catch (error) {
        return { ok: false, code: 0, error: 'Meta no respondió' };
    } finally {
        clearTimeout(timer);
    }
}
// { ok, id } o { ok: false, code, error }. Nunca lleva el token.
const sendTemplate = (config, to, tpl, params, fetchImpl = fetch) => post(config, buildTemplatePayload(to, tpl, params), fetchImpl);
const sendText = (config, to, message, fetchImpl = fetch) => post(config, { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: message } }, fetchImpl);

// El numero de la cuenta de empresa: { connected: true | false | null, state, provider: 'meta', quality, name, number }
async function connection(config, fetchImpl = fetch) {
    if (!usesMeta(config)) return { connected: null, state: 'sin-estado', provider: 'meta' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${API}/${encodeURIComponent(config.metaPhoneId)}?fields=display_phone_number,verified_name,quality_rating,status`, {
            headers: { Authorization: `Bearer ${config.metaToken}` }, signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const code = data && data.error && data.error.code;
            if (code === 190) return { connected: false, state: 'token-invalido', provider: 'meta' };
            return { connected: null, state: 'sin-respuesta', provider: 'meta' };
        }
        const status = String((data && data.status) || '');
        if (!status) return { connected: null, state: 'sin-respuesta', provider: 'meta' };
        return {
            connected: status === 'CONNECTED' || status === 'FLAGGED', state: status.toLowerCase(), provider: 'meta',
            quality: String(data.quality_rating || ''), name: String(data.verified_name || ''), number: String(data.display_phone_number || '')
        };
    } catch (error) {
        return { connected: null, state: 'sin-respuesta', provider: 'meta' };
    } finally {
        clearTimeout(timer);
    }
}

function describeConnection(conn) {
    const state = conn && conn.state ? conn.state : 'desconocido';
    if (state === 'token-invalido') return 'WhatsApp no está conectado (Meta): el token de acceso venció o no es válido. Pida al programador que cargue uno nuevo (scripts/set-whatsapp.mjs).';
    return `WhatsApp no está conectado (Meta, estado: ${state}). Revise el número en el Administrador de WhatsApp de Meta: puede estar restringido, desconectado o pendiente de verificación.`;
}

module.exports = {
    VARIABLES, DEFAULT_TEMPLATES, usesMeta, normalizeTemplate, templateFor, templateParams, renderTemplate, bodyParamCount, cleanParam,
    buildTemplatePayload, sendTemplate, sendText, connection, describeConnection
};
