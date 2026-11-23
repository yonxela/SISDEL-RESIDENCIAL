// Avisos en el celular (notificaciones push del navegador, Web Push con llaves VAPID): la logica, sin firebase, para poder probarla
// con datos de mentira (scripts/test-avisos-push.mjs). Pedido del usuario el 2026-11-23: "como puedo mandar un mensaje al vecino si
// el ya cerro la sesion de garita.app pero yo necesito que el mensaje le salte en su celular".
//
// Como funciona: el vecino toca "Activar avisos" en garita.app (vecino.html); el navegador le pide permiso y entrega una
// "suscripcion" (una direccion del servicio de avisos de Google, Apple, Mozilla o Microsoft y dos llaves). El servidor la guarda en
// condominios/{c}/push_dispositivos/{huella de la direccion} y, cada vez que la administracion manda un mensaje, la usa para que el
// telefono muestre el aviso aunque garita.app este cerrado. Al tocarlo se abre garita.app con los mensajes.
//
// Seguridad: el servidor solo escribe a direcciones de esos servicios (una direccion cualquiera haria que la funcion llamara a
// donde quiera quien la registro); la direccion de cada telefono no la lee nadie desde el navegador (con ella y la llave del
// servidor se le pueden mandar avisos); el aviso se ve en la pantalla bloqueada, asi que nunca lleva claves ni saldos que el
// administrador no escribio.

const crypto = require('crypto');

const MAX_ACTIVE_PER_USER = 10;
const TITLE_MAX = 80;
const BODY_MAX = 300;
const PAYLOAD_MAX_BYTES = 3000; // el limite de los servicios es 4 KB ya cifrado
const TTL_SECONDS = 3 * 24 * 60 * 60; // si el telefono esta apagado, el aviso espera hasta 3 dias
const SEND_CONCURRENCY = 20;

// Servicios de avisos de los navegadores (Chrome, Edge, Firefox, Safari / iPhone, Samsung). Solo a estos se envia.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];

// Roles a los que llega un mensaje segun su destinatario (el mismo criterio de las reglas de mensajes: toRole 'all' o el rol)
const TARGET_ROLES = { vecino: ['vecino'], policia: ['policia'] };

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function deviceId(endpoint) {
    return sha256(String(endpoint || '')).slice(0, 40);
}

function hostAllowed(host) {
    const h = String(host || '').toLowerCase();
    return PUSH_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
}

function base64UrlBytes(text) {
    const s = String(text || '');
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return -1;
    return Buffer.from(s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
}

// Revisa la suscripcion que entrega el navegador (PushSubscription.toJSON()). Devuelve { endpoint, keys } o { error }.
function cleanSubscription(sub) {
    if (!sub || typeof sub !== 'object') return { error: 'Falta la suscripción del teléfono.' };
    const endpoint = String(sub.endpoint || '');
    if (!endpoint || endpoint.length > 1000) return { error: 'La dirección de avisos del teléfono no sirve.' };
    let url;
    try { url = new URL(endpoint); } catch (e) { return { error: 'La dirección de avisos del teléfono no sirve.' }; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return { error: 'La dirección de avisos del teléfono no sirve.' };
    if (!hostAllowed(url.hostname)) return { error: 'Este navegador usa un servicio de avisos que garita.app no reconoce.' };
    const keys = sub.keys || {};
    const p256dh = String(keys.p256dh || '');
    const auth = String(keys.auth || '');
    // p256dh: punto publico P-256 sin comprimir (65 bytes); auth: 16 bytes
    if (base64UrlBytes(p256dh) !== 65 || base64UrlBytes(auth) !== 16) return { error: 'Las llaves de avisos del teléfono no sirven.' };
    return { endpoint, keys: { p256dh, auth } };
}

// Tipo de equipo, solo para que la persona reconozca sus telefonos (nunca decide nada)
function platformOf(userAgent) {
    const ua = String(userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iphone';
    if (/Android/i.test(ua)) return 'android';
    return 'computadora';
}

function browserOf(userAgent) {
    const ua = String(userAgent || '');
    if (/EdgA?\//.test(ua)) return 'Edge';
    if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
    if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
    if (/FxiOS\/|Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'Navegador';
}

function clip(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + '…';
}

// El aviso de un mensaje de la administracion. url: a donde lleva al tocarlo (los mensajes, despues de entrar con su clave).
function messagePayload(msg, condoName) {
    const m = msg || {};
    const subject = clip(m.subject, TITLE_MAX);
    const condo = clip(condoName, 40);
    const title = subject || (condo ? `Mensaje de ${condo}` : 'Mensaje de la administración');
    const body = clip(m.body, BODY_MAX) || 'Tiene un mensaje nuevo de la administración.';
    return fitPayload({
        title,
        body: condo && subject ? `${condo}: ${body}` : body,
        url: '/index.html?next=vecino.html&abrir=mensajes',
        tag: 'mensaje-' + String(m.id || '').slice(0, 60),
        kind: 'mensaje'
    });
}

function testPayload(condoName) {
    const condo = clip(condoName, 40);
    return fitPayload({
        title: 'Aviso de prueba',
        body: `Listo: en este teléfono le llegarán los mensajes de la administración${condo ? ' de ' + condo : ''}, aunque tenga garita.app cerrado.`,
        url: '/index.html?next=vecino.html&abrir=mensajes',
        tag: 'prueba',
        kind: 'prueba'
    });
}

// Recorta el texto hasta que el aviso quepa en el limite de los servicios
function fitPayload(p) {
    const out = { ...p };
    while (Buffer.byteLength(JSON.stringify(out), 'utf8') > PAYLOAD_MAX_BYTES && out.body.length > 20) {
        out.body = clip(out.body, Math.floor(out.body.length * 0.8));
    }
    return out;
}

// Quien recibe un mensaje: los telefonos activos de usuarios activos, del rol del destinatario (o todos con 'all'), que pueden
// recibir mensajes (has(usuario) = privilegio mensajes.recibir). Un telefono va una sola vez aunque aparezca dos veces.
function recipientsFor(msg, devices, usersById, has) {
    const toRole = String((msg && msg.toRole) || 'all');
    const roles = TARGET_ROLES[toRole] || null;
    if (toRole !== 'all' && !roles) return [];
    const seen = new Set();
    const out = [];
    for (const d of devices || []) {
        if (!d || d.active === false || !d.endpoint || seen.has(d.endpoint)) continue;
        const u = usersById[d.userId];
        if (!u || u.active === false || u.deleted === true) continue;
        if (roles && !roles.includes(u.role)) continue;
        if (!has(u)) continue;
        seen.add(d.endpoint);
        out.push(d);
    }
    return out;
}

// Que hacer con un error del servicio de avisos: 'gone' = el telefono ya no recibe (desactivo los avisos, borro los datos del
// navegador o desinstalo): se desactiva aqui; 'error' = fallo de este envio, se deja como esta.
function classifyError(err) {
    const status = Number(err && err.statusCode);
    if (status === 404 || status === 410) return 'gone';
    if (status === 400 || status === 403) {
        // Apple y Google responden 400/403 cuando la suscripcion ya no sirve con estas llaves
        const body = String((err && err.body) || '');
        if (/VapidPkHashMismatch|BadJwtToken|ExpiredSubscription|InvalidRegistration|unsubscribed|expired/i.test(body)) return 'gone';
    }
    return 'error';
}

// Envia a varios telefonos con un limite de envios a la vez. send(device) devuelve una promesa; nunca se cae por un telefono.
async function sendAll(devices, send, concurrency = SEND_CONCURRENCY) {
    const results = new Array(devices.length);
    let next = 0;
    async function worker() {
        while (next < devices.length) {
            const i = next++;
            const d = devices[i];
            try {
                const res = await send(d);
                results[i] = { id: d.id, ok: true, status: res && res.statusCode };
            } catch (err) {
                results[i] = { id: d.id, ok: false, status: err && err.statusCode, kind: classifyError(err), error: clip((err && (err.body || err.message)) || 'error', 160) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, devices.length) }, worker));
    return results;
}

function summarize(results) {
    const sum = { devices: results.length, sent: 0, failed: 0, gone: 0 };
    for (const r of results) {
        if (r.ok) sum.sent += 1;
        else if (r.kind === 'gone') sum.gone += 1;
        else sum.failed += 1;
    }
    return sum;
}

// Telefonos activos de un usuario que sobran (deja los MAX_ACTIVE_PER_USER mas recientes)
function overLimit(devices, keepId, max = MAX_ACTIVE_PER_USER) {
    const active = (devices || []).filter((d) => d && d.active !== false && d.id !== keepId);
    active.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return active.slice(Math.max(0, max - 1));
}

module.exports = {
    MAX_ACTIVE_PER_USER, TTL_SECONDS, PUSH_HOSTS, PAYLOAD_MAX_BYTES,
    deviceId, hostAllowed, cleanSubscription, platformOf, browserOf, clip,
    messagePayload, testPayload, fitPayload, recipientsFor, classifyError, sendAll, summarize, overLimit
};
