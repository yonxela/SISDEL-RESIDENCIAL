// QR de panico por vecino (panico.html; las tarjetas se imprimen en admin.html > Reportes > QR de panico).
//
// El QR va pegado en la puerta o en el carro: cualquiera puede escanearlo. Por eso solo lleva el condominio y el vecino
// (?c=<condominio>&v=<vecino>), nunca su codigo de acceso, y por si solo no deja hacer nada:
//  - La PRIMERA vez, en cada telefono, el vecino escribe su codigo de acceso para VINCULAR ese telefono a su QR
//    (linkPanicDevice). El servidor guarda solo la huella de una clave al azar que se queda en el telefono, y la huella del
//    codigo con que se vinculo: si el administrador le cambia el codigo, los telefonos vinculados dejan de servir.
//  - Despues, escanear el QR en ese telefono muestra el boton sin pedir nada mas, y la alerta la crea el servidor
//    (panicDevice, accion 'alert') con los datos del vecino: la sesion normal de SISDEL vive solo en su pestana y escanear
//    abre una pestana nueva, asi que pedir el login cada vez dejaria el QR inutil en una emergencia.
//  - Vincular solo deja enviar la alerta de ESE vecino, ver como va y cancelarla: no entra a nada mas.
// Un extrano que escanea el QR de otro no puede vincularse sin el codigo de ese vecino (5 intentos fallidos por vecino y
// 30 por IP cada 15 minutos). La alerta sale como la del portal (alertas_panico, source 'vecino') con via 'qr', y
// onPanicCreated avisa por WhatsApp igual que siempre.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const crypto = require('crypto');
const { db } = require('./firebase');
const { ROLES, normalizeCode, sha256, clientIp } = require('./util');
const rateLimit = require('./rateLimit');
const privilegios = require('./privilegios');

const LINK_IP_LIMIT = { max: 30, windowMs: 15 * 60 * 1000 };
const LINK_USER_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
// Contra un telefono o un programa que se queda enviando alertas sin parar (el portal no tiene tope: es generoso)
const ALERT_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };
const MAX_DEVICES = 20;
const OPEN_ALERT_MS = 6 * 3600 * 1000; // una alerta sin resolver se muestra al volver a escanear durante 6 horas
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{40,64}$/;
const ACTIONS = ['check', 'alert', 'status', 'cancel', 'unlink'];

const cleanId = (value) => (ID_RE.test(String(value || '')) ? String(value) : '');
const nowIso = () => new Date().toISOString();
const devicePath = (condoId, secret) => `condominios/${condoId}/panico_dispositivos/${sha256(secret)}`;

// Coordenadas del telefono: numeros dentro del rango del mapa; cualquier otra cosa se descarta (la alerta sale sin ubicacion)
function cleanPos(data) {
    const lat = Number(data && data.lat);
    const lng = Number(data && data.lng);
    if (data == null || data.lat == null || data.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { lat: null, lng: null, accuracy: null };
    }
    const acc = Number(data.accuracy);
    return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}

async function loadNeighbor(condoId, userId) {
    const condoRef = db.doc(`condominios/${condoId}`);
    const [condoSnap, userSnap, cfgSnap] = await Promise.all([
        condoRef.get(),
        db.doc(`condominios/${condoId}/usuarios/${userId}`).get(),
        db.doc(`condominios/${condoId}/rondas_config/general`).get()
    ]);
    return {
        condo: condoSnap.exists ? condoSnap.data() : null,
        user: userSnap.exists ? { ...userSnap.data(), id: userSnap.id } : null,
        panicEnabled: cfgSnap.exists && !!cfgSnap.data().neighbor_panic_enabled
    };
}

// Por que este vecino no puede usar el boton (o null). Solo se dice a quien ya demostro ser el (codigo o telefono vinculado)
function neighborProblem({ condo, user, panicEnabled }) {
    if (!condo || condo.active !== true) return 'El condominio no está activo.';
    if (!user || user.role !== ROLES.VECINO) return 'Este QR ya no corresponde a un vecino registrado. Pida uno nuevo a la administración.';
    if (user.active === false) return 'Su usuario está desactivado. Comuníquese con la administración.';
    if (!privilegios.has(user.role, user.privilegios, 'panico.activar')) return 'Su usuario no tiene el botón de pánico. Pídaselo a la administración.';
    if (!panicEnabled) return 'El botón de pánico de vecinos no está activado en su condominio. Pídale a la administración que lo active.';
    return null;
}

// Lo que el telefono muestra del vecino (lo mismo que ya dice la tarjeta impresa)
function info({ condo, user }) {
    return {
        name: user.name || '', casa: user.casa || '', condoName: (condo && condo.name) || '',
        canCancel: privilegios.has(user.role, user.privilegios, 'panico.cancelar')
    };
}

function publicAlert(a) {
    return { id: a.id, status: a.status, createdAt: a.createdAt || '', attendedByName: a.status === 'ATTENDED' ? (a.attendedByName || '') : '', hasLocation: a.lat != null };
}

// El codigo con que se vinculo el telefono sigue siendo un codigo vigente del vecino (si se lo cambiaron, hay que volver a vincular)
async function codeStillValid(condoId, userId, codeHash) {
    if (!codeHash) return false;
    const snap = await db.collection('codigos').where('userId', '==', userId).get();
    return snap.docs.some((d) => d.data().condominioId === condoId && sha256(d.id) === codeHash);
}

// La alerta mas reciente del vecino que sigue sin resolver (de las ultimas 6 horas)
async function latestOpenAlert(condoId, userId) {
    const snap = await db.collection(`condominios/${condoId}/alertas_panico`).where('userId', '==', userId).get();
    const since = new Date(Date.now() - OPEN_ALERT_MS).toISOString();
    const open = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
        .filter((a) => ['ACTIVE', 'ATTENDED'].includes(a.status) && String(a.createdAt || '') >= since)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return open[0] || null;
}

// Vincula este telefono al QR del vecino con su codigo de acceso (una sola vez por telefono)
const linkPanicDevice = onCall(async (request) => {
    const data = request.data || {};
    const condoId = cleanId(data.c);
    const userId = cleanId(data.v);
    const code = normalizeCode(data.code);
    const ip = clientIp(request.rawRequest);
    const log = (outcome, extra = {}) => logger.info('qr panico: vincular', { outcome, ip, condominioId: condoId, userId, ...extra });
    if (!condoId || !userId) return { ok: false, error: 'Este QR no es válido.' };

    const userKey = `${condoId}/${userId}`;
    if (await rateLimit.isBlocked('panico_vincular_ip', ip, LINK_IP_LIMIT) || await rateLimit.isBlocked('panico_vincular', userKey, LINK_USER_LIMIT)) {
        log('blocked');
        return { ok: false, blocked: true, error: 'Demasiados intentos. Espere 15 minutos e intente de nuevo.' };
    }

    let mine = false;
    if (code) {
        const snap = await db.doc(`codigos/${code}`).get();
        mine = snap.exists && snap.data().condominioId === condoId && snap.data().userId === userId;
    }
    if (!mine) {
        await Promise.all([rateLimit.hit('panico_vincular_ip', ip, LINK_IP_LIMIT), rateLimit.hit('panico_vincular', userKey, LINK_USER_LIMIT)]);
        log('bad_code');
        // Nunca dice de quien es un codigo ajeno: solo que no es el de la persona del QR
        return { ok: false, error: 'Ese código no es el de este vecino. Escriba el código de acceso de la persona del QR.' };
    }
    await rateLimit.reset('panico_vincular', userKey);

    const neighbor = await loadNeighbor(condoId, userId);
    const problem = neighborProblem(neighbor);
    if (problem) { log('not_allowed'); return { ok: false, error: problem }; }

    const codeHash = sha256(code);
    const devices = await db.collection(`condominios/${condoId}/panico_dispositivos`).where('userId', '==', userId).get();
    const live = devices.docs.filter((d) => !d.data().revokedAt && d.data().codeHash === codeHash);
    if (live.length >= MAX_DEVICES) {
        // A quien tiene su codigo NUNCA se le niega el boton: se reemplaza el telefono que lleva mas tiempo sin usarse. Un telefono que
        // olvida su clave (el iPhone borra lo que guarda una pagina sin uso en una semana) se vincula de nuevo y deja el vinculo viejo
        // huerfano: con un tope que negara, esos huerfanos acabarian dejando al vecino sin poder vincular su telefono
        const lastUse = (d) => String(d.data().lastUsedAt || d.data().createdAt || '');
        const oldest = live.sort((x, y) => lastUse(x).localeCompare(lastUse(y))).slice(0, live.length - MAX_DEVICES + 1);
        await Promise.all(oldest.map((d) => d.ref.update({ revokedAt: nowIso(), revokedBy: 'reemplazado' })));
        log('replaced', { count: oldest.length });
    }

    const secret = crypto.randomBytes(32).toString('base64url');
    await db.doc(devicePath(condoId, secret)).create({
        userId, condominioId: condoId, codeHash, createdAt: nowIso(), lastUsedAt: null,
        userAgent: String((request.rawRequest && request.rawRequest.headers && request.rawRequest.headers['user-agent']) || '').slice(0, 200)
    });
    log('ok');
    return { ok: true, secret, ...info(neighbor), alert: null };
});

// Lo que hace un telefono vinculado: comprobar el vinculo ('check'), enviar la alerta ('alert'), ver como va ('status'),
// cancelarla ('cancel') o desvincularse ('unlink')
const panicDevice = onCall(async (request) => {
    const data = request.data || {};
    const action = String(data.action || '');
    if (!ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'Acción no válida');
    const condoId = cleanId(data.c);
    const userId = cleanId(data.v);
    const secret = String(data.secret || '');
    const log = (outcome, extra = {}) => logger.info('qr panico', { action, outcome, condominioId: condoId, userId, ...extra });
    const relink = { ok: false, relink: true, error: 'Este teléfono no está vinculado a este QR. Vincúlelo con el código de acceso del vecino.' };
    if (!condoId || !userId || !SECRET_RE.test(secret)) return relink;

    const devRef = db.doc(devicePath(condoId, secret));
    const devSnap = await devRef.get();
    const device = devSnap.exists ? devSnap.data() : null;
    if (!device || device.userId !== userId || device.revokedAt) { log('not_linked'); return relink; }
    if (action === 'unlink') {
        await devRef.update({ revokedAt: nowIso(), revokedBy: 'telefono' });
        log('ok');
        return { ok: true };
    }

    const [neighbor, codeOk] = await Promise.all([loadNeighbor(condoId, userId), codeStillValid(condoId, userId, device.codeHash)]);
    if (!codeOk) {
        log('code_changed');
        return { ok: false, relink: true, error: 'El código de acceso de este vecino cambió: vincule este teléfono de nuevo con el código nuevo.' };
    }
    const problem = neighborProblem(neighbor);
    if (problem) { log('not_allowed'); return { ok: false, error: problem }; }

    if (action === 'check') {
        const open = await latestOpenAlert(condoId, userId);
        return { ok: true, ...info(neighbor), alert: open ? publicAlert(open) : null };
    }

    if (action === 'alert') {
        const userKey = `${condoId}/${userId}`;
        if (await rateLimit.isBlocked('panico_qr', userKey, ALERT_LIMIT)) {
            log('blocked');
            return { ok: false, error: 'Ya envió varias alertas en pocos minutos y la garita ya fue avisada. Si sigue en peligro, llame por teléfono.' };
        }
        await rateLimit.hit('panico_qr', userKey, ALERT_LIMIT);
        const user = neighbor.user;
        const ref = db.collection(`condominios/${condoId}/alertas_panico`).doc();
        const alert = {
            id: ref.id, condominioId: condoId, source: 'vecino', userId, userName: user.name || '',
            casa: user.casa || '', phone: user.phone || '', ...cleanPos(data),
            status: 'ACTIVE', createdAt: nowIso(), via: 'qr'
        };
        await ref.set(alert);
        await devRef.update({ lastUsedAt: alert.createdAt });
        log('ok', { alertId: ref.id, gps: alert.lat != null });
        return { ok: true, ...info(neighbor), alert: publicAlert(alert) };
    }

    // status / cancel: solo alertas de este vecino
    const alertId = cleanId(data.alertId);
    const alertRef = alertId ? db.doc(`condominios/${condoId}/alertas_panico/${alertId}`) : null;
    const alertSnap = alertRef ? await alertRef.get() : null;
    if (!alertSnap || !alertSnap.exists || alertSnap.data().userId !== userId) return { ok: false, error: 'No se encontró la alerta.' };
    let current = { ...alertSnap.data(), id: alertSnap.id };
    if (action === 'cancel') {
        if (!info(neighbor).canCancel) return { ok: false, error: 'Su usuario no puede cancelar alertas. Avise a la garita por teléfono.' };
        if (current.status !== 'ACTIVE') return { ok: false, error: 'La alerta ya fue atendida: avise a la garita por teléfono si fue un error.', alert: publicAlert(current) };
        const cancelledAt = nowIso();
        await alertRef.update({ status: 'CANCELLED', cancelledAt });
        current = { ...current, status: 'CANCELLED', cancelledAt };
        log('ok', { alertId });
    }
    return { ok: true, alert: publicAlert(current) };
});

module.exports = { linkPanicDevice, panicDevice, _test: { cleanPos, neighborProblem } };
