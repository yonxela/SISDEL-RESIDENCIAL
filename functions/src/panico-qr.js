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
// Ademas, la oficina puede ENTREGAR la clave con el QR (panicCodeDelivery y panicCodeReveal, al final): la primera vez que el
// vecino lo escanea ve su clave una sola vez y su telefono queda vinculado, solo si la oficina activo esa entrega al darle la tarjeta.
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

    const secret = await createDeviceLink({ condoId, userId, code, request, log });
    log('ok');
    return { ok: true, secret, ...info(neighbor), alert: null };
});

const userAgentOf = (request) => String((request && request.rawRequest && request.rawRequest.headers && request.rawRequest.headers['user-agent']) || '').slice(0, 200);

// Vincula un telefono nuevo al QR del vecino (con su codigo vigente) y devuelve la clave al azar que se queda en el telefono
async function createDeviceLink({ condoId, userId, code, request, log, via = 'codigo', secret = crypto.randomBytes(32).toString('base64url') }) {
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
    await db.doc(devicePath(condoId, secret)).create({
        userId, condominioId: condoId, codeHash, createdAt: nowIso(), lastUsedAt: null, userAgent: userAgentOf(request), via
    });
    return secret;
}

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

// ───────── Entregar la clave de acceso con el QR (pedido del usuario el 2026-11-22) ─────────
// "La oficina entrega el QR de panico al vecino; el vecino lo escanea y ve su clave por una sola vez con el aviso; luego el QR sirve
// solo para el boton de panico". El QR NO lleva la clave y por si solo nunca la muestra: va pegado en puertas y carros, y los ya
// pegados (y los enlaces mandados por WhatsApp) son el mismo QR. Por eso la oficina ACTIVA la entrega al darle la tarjeta al vecino
// (panicCodeDelivery, quien ve las claves: usuarios.codigos), por 24 horas. La primera persona que escanea el QR en ese tiempo y toca
// "Ver mi clave" la ve (panicCodeReveal, 'claim'), ese telefono queda vinculado al boton y la entrega se gasta: nadie mas la vuelve a
// ver por el QR. Si la vio otra persona, el vecino lo sabe ("ya se entrego el dia X") y la oficina le cambia la clave y activa otra
// entrega con la MISMA tarjeta. Todo queda en condominios/{c}/panico_entregas/{vecino} (que solo escribe y lee el servidor, con la
// historia de cada entrega); la clave nunca se guarda ahi ni en el registro del servidor.
const DELIVERY_MS = 24 * 3600 * 1000;
const RESHOW_MS = 15 * 60 * 1000; // el mismo telefono puede volver a verla un rato (se corto la senal, recargo la pagina)
const DELIVERY_LIMIT = { max: 120, windowMs: 10 * 60 * 1000 };
const REVEAL_IP_LIMIT = { max: 60, windowMs: 15 * 60 * 1000 };
const HISTORY_MAX = 20;
const deliveryPath = (condoId, userId) => `condominios/${condoId}/panico_entregas/${userId}`;
// Entrega GENERAL (pedido del usuario el 2026-11-22: "boton de activar entrega de claves: activado entrega las claves a todos los
// QR de casas y lotes; desactivado ya no muestra nada"): un interruptor por condominio en Reportes > QR de panico. Mientras esta
// activa (hasta una fecha que se elige: se apaga sola), el QR de cada vecino que NUNCA ha recibido su clave la muestra una vez,
// como una entrega activada por la oficina. Puede ser para todos los vecinos o solo para una lista (la que se ve en el reporte:
// solo casas, solo lotes, una fase...). Quien ya la recibio no la vuelve a ver por la entrega general: para darsela otra vez,
// la ventana del QR de OIKOS. condominios/{c}/panico_config/entregas, solo el servidor (como panico_entregas).
const campaignPath = (condoId) => `condominios/${condoId}/panico_config/entregas`;
const CAMPAIGN_DAYS = [1, 3, 7, 15, 30];
const CAMPAIGN_MAX_IDS = 3000;
const campaignActive = (cp, now = Date.now()) => !!cp && cp.enabled === true && Date.parse(cp.until) > now;
// Ya recibio su clave alguna vez (por la oficina o por una entrega general)
const everDelivered = (d) => !!d && (!!d.deliveredAt || (Array.isArray(d.history) && d.history.some((h) => h && h.deliveredAt)));
const campaignCovers = (cp, userId, d, now = Date.now()) => campaignActive(cp, now) && (!Array.isArray(cp.ids) || cp.ids.includes(userId)) && !everDelivered(d);
// Por donde se le puede dar la clave ahora: 'oficina' (la activo la oficina para el), 'general' o null
function deliverable(d, cp, userId, now = Date.now()) {
    if (deliveryState(d, now).status === 'armed') return 'oficina';
    return campaignCovers(cp, userId, d, now) ? 'general' : null;
}
function campaignState(cp, now = Date.now()) {
    if (!cp) return { active: false };
    return {
        active: campaignActive(cp, now), enabled: cp.enabled === true, campaignId: cp.campaignId || '', startedAt: cp.startedAt || '', until: cp.until || '',
        startedByName: cp.startedByName || '', endedAt: cp.endedAt || '', endedByName: cp.endedByName || '', days: cp.days || null,
        scope: Array.isArray(cp.ids) ? 'lista' : 'todos', count: Array.isArray(cp.ids) ? cp.ids.length : null, label: cp.label || ''
    };
}

// La clave vigente del vecino en este condominio (la mas nueva)
async function currentCode(condoId, userId) {
    const snap = await db.collection('codigos').where('userId', '==', userId).get();
    const codes = snap.docs.filter((d) => d.data().condominioId === condoId)
        .sort((a, b) => String(b.data().createdAt || '').localeCompare(String(a.data().createdAt || '')));
    return codes.length ? codes[0].id : '';
}

// En que telefono se vio (para que el vecino y la oficina sepan si fue el suyo), sin guardar mas datos del aparato
function deviceKind(userAgent) {
    const ua = String(userAgent || '');
    if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android';
    return ua ? 'computadora u otro aparato' : '';
}

// Como esta la entrega: none (nunca se activo), armed (activa), expired (vencio sin usarse), delivered o cancelled
function deliveryState(d, now = Date.now()) {
    if (!d || !d.status) return { status: 'none' };
    let status = d.status;
    if (status === 'armed' && !(Date.parse(d.armedUntil) > now)) status = 'expired';
    return {
        status, armedAt: d.armedAt || '', armedUntil: d.armedUntil || '', armedByName: d.armedByName || '',
        deliveredAt: d.deliveredAt || '', deliveredOn: d.deliveredOn || '', cancelledAt: d.cancelledAt || '',
        via: d.via || 'oficina', times: (Array.isArray(d.history) ? d.history.length : 0) + 1
    };
}
// Lo que se guarda en la historia al empezar otra entrega
function historyEntry(d) {
    return {
        status: deliveryState(d).status, armedAt: d.armedAt || '', armedUntil: d.armedUntil || '', armedById: d.armedById || '', armedByName: d.armedByName || '',
        deliveredAt: d.deliveredAt || '', deliveredOn: d.deliveredOn || '', cancelledAt: d.cancelledAt || '', cancelledByName: d.cancelledByName || '',
        via: d.via || 'oficina', campaignId: d.campaignId || ''
    };
}

// La oficina: ver como esta, activar la entrega (24 horas) o cancelarla. Pide la sesion de un usuario con "Ver y cambiar codigos de
// acceso" (usuarios.codigos: el mismo privilegio con que las reglas dejan leer las claves) o la del Master
const panicCodeDelivery = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const data = request.data || {};
    const action = String(data.action || '');
    if (!['status', 'arm', 'cancel', 'generalStatus', 'generalOn', 'generalOff'].includes(action)) throw new HttpsError('invalid-argument', 'Acción no válida');
    const { uid, token = {} } = request.auth;
    let condoId = '';
    let caller = null;
    let canSwitch = true; // el interruptor de la entrega general: reportes.panico_entrega (el Master siempre)
    if (token.role === ROLES.MASTER) {
        condoId = cleanId(data.condoId);
        caller = { id: 'master', name: 'Master (programador)' };
    } else {
        condoId = cleanId(token.condominioId);
        const me = condoId ? await db.doc(`condominios/${condoId}/usuarios/${uid}`).get() : null;
        const ok = !!me && me.exists && me.data().active !== false && privilegios.has(me.data().role, me.data().privilegios, 'usuarios.codigos');
        if (!ok) throw new HttpsError('permission-denied', 'Su usuario no puede entregar claves de acceso (privilegio "Ver y cambiar códigos de acceso").');
        caller = { id: uid, name: String(me.data().name || '') };
        canSwitch = privilegios.has(me.data().role, me.data().privilegios, 'reportes.panico_entrega');
    }
    if (!condoId) throw new HttpsError('invalid-argument', 'Condominio inválido.');
    if (action.startsWith('general')) {
        // Ver como esta basta con ver las claves; activarla o desactivarla pide ademas su privilegio (Configuracion > Privilegios >
        // Reportes > "Activar o desactivar la entrega de claves con el QR", que solo trae el administrador)
        if (action !== 'generalStatus' && !canSwitch) throw new HttpsError('permission-denied', 'Su usuario no puede activar ni desactivar la entrega de claves (privilegio "Activar o desactivar la entrega de claves con el QR").');
        return generalDelivery({ action, condoId, caller, data });
    }
    const userId = cleanId(data.residentId);
    if (!userId) throw new HttpsError('invalid-argument', 'Residente inválido.');
    const ref = db.doc(deliveryPath(condoId, userId));
    const log = (outcome, extra = {}) => logger.info('qr panico: entrega de la clave', { action, outcome, condominioId: condoId, userId, by: caller.id, ...extra });

    if (action === 'status') {
        const [snap, cpSnap] = await Promise.all([ref.get(), db.doc(campaignPath(condoId)).get()]);
        const d = snap.exists ? snap.data() : null;
        const cp = cpSnap.exists ? cpSnap.data() : null;
        return { ok: true, ...deliveryState(d), general: { active: campaignActive(cp), until: cp && cp.until ? cp.until : '', covers: campaignCovers(cp, userId, d) } };
    }
    if (await rateLimit.isBlocked('panico_entrega', caller.id, DELIVERY_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas entregas seguidas. Espere unos minutos.');
    }
    await rateLimit.hit('panico_entrega', caller.id, DELIVERY_LIMIT);

    if (action === 'cancel') {
        const snap = await ref.get();
        const state = deliveryState(snap.exists ? snap.data() : null);
        if (state.status !== 'armed') return { ok: false, error: 'No hay una entrega activa que cancelar.', ...state };
        await ref.update({ status: 'cancelled', cancelledAt: nowIso(), cancelledById: caller.id, cancelledByName: caller.name });
        log('ok');
        return { ok: true, ...deliveryState((await ref.get()).data()) };
    }

    // arm: solo a un vecino activo de un condominio activo, que tenga clave
    const [condoSnap, userSnap, code] = await Promise.all([db.doc(`condominios/${condoId}`).get(), db.doc(`condominios/${condoId}/usuarios/${userId}`).get(), currentCode(condoId, userId)]);
    if (!condoSnap.exists || condoSnap.data().active !== true) return { ok: false, error: 'El condominio no está activo.' };
    const user = userSnap.exists ? userSnap.data() : null;
    if (!user || user.role !== ROLES.VECINO) return { ok: false, error: 'Solo se entrega la clave de un vecino.' };
    if (user.active === false) return { ok: false, error: 'Este vecino está desactivado: actívelo antes de entregarle la clave.' };
    if (!code) return { ok: false, error: 'Este vecino no tiene clave de acceso. Créela en su ficha antes de entregarla.' };
    const now = Date.now();
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists ? snap.data() : null;
        const history = prev ? [...(Array.isArray(prev.history) ? prev.history : []), historyEntry(prev)].slice(-HISTORY_MAX) : [];
        tx.set(ref, {
            userId, condominioId: condoId, status: 'armed',
            armedAt: new Date(now).toISOString(), armedUntil: new Date(now + DELIVERY_MS).toISOString(), armedById: caller.id, armedByName: caller.name,
            deliveredAt: null, deliveredOn: null, deliveredDevice: null, deliveredUserAgent: null,
            cancelledAt: null, cancelledById: null, cancelledByName: null, history
        });
    });
    log('ok');
    return { ok: true, ...deliveryState((await ref.get()).data()) };
});

// La entrega general (Reportes > QR de panico): ver como esta, activarla (para todos o una lista, de 1 a 30 dias) o desactivarla.
// Quien la activa y la desactiva queda anotado; las anteriores quedan en la historia
async function generalDelivery({ action, condoId, caller, data }) {
    const ref = db.doc(campaignPath(condoId));
    const log = (outcome, extra = {}) => logger.info('qr panico: entrega general de claves', { action, outcome, condominioId: condoId, by: caller.id, ...extra });
    const withCount = async (cp) => {
        const st = campaignState(cp);
        if (!st.campaignId) return { ok: true, ...st, delivered: 0 };
        const snap = await db.collection(`condominios/${condoId}/panico_entregas`).where('campaignId', '==', st.campaignId).get();
        return { ok: true, ...st, delivered: snap.size };
    };
    if (action === 'generalStatus') {
        const snap = await ref.get();
        return withCount(snap.exists ? snap.data() : null);
    }
    if (await rateLimit.isBlocked('panico_entrega', caller.id, DELIVERY_LIMIT)) throw new HttpsError('resource-exhausted', 'Demasiados cambios seguidos. Espere unos minutos.');
    await rateLimit.hit('panico_entrega', caller.id, DELIVERY_LIMIT);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;
    if (action === 'generalOff') {
        if (!campaignActive(prev)) return { ...(await withCount(prev)), ok: false, error: 'La entrega general de claves no está activada.' };
        await ref.update({ enabled: false, endedAt: nowIso(), endedById: caller.id, endedByName: caller.name });
        log('ok');
        return withCount((await ref.get()).data());
    }
    // generalOn
    const condo = await db.doc(`condominios/${condoId}`).get();
    if (!condo.exists || condo.data().active !== true) return { ok: false, error: 'El condominio no está activo.' };
    const days = CAMPAIGN_DAYS.includes(Number(data.days)) ? Number(data.days) : 7;
    let ids = null;
    if (Array.isArray(data.ids)) {
        ids = [...new Set(data.ids.map(cleanId).filter(Boolean))];
        if (!ids.length) return { ok: false, error: 'No hay vecinos en la lista.' };
        if (ids.length > CAMPAIGN_MAX_IDS) return { ok: false, error: `Son demasiados vecinos (más de ${CAMPAIGN_MAX_IDS}).` };
    }
    const now = Date.now();
    const old = prev ? campaignState(prev) : null;
    const history = prev ? [...(Array.isArray(prev.history) ? prev.history : []), { campaignId: old.campaignId, startedAt: old.startedAt, until: old.until, startedByName: old.startedByName, endedAt: prev.endedAt || (campaignActive(prev, now) ? new Date(now).toISOString() : ''), endedByName: prev.endedByName || (campaignActive(prev, now) ? caller.name : ''), scope: old.scope, count: old.count, label: old.label }].slice(-HISTORY_MAX) : [];
    await ref.set({
        enabled: true, campaignId: `${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
        startedAt: new Date(now).toISOString(), until: new Date(now + days * 24 * 3600 * 1000).toISOString(), days,
        startedById: caller.id, startedByName: caller.name, endedAt: null, endedById: null, endedByName: null,
        ids, label: String(data.label || '').slice(0, 80), history
    });
    log('ok', { days, scope: ids ? ids.length : 'todos' });
    return withCount((await ref.get()).data());
}

// El telefono que escanea el QR (sin sesion): 'peek' dice si hay una entrega activa (sin mostrar la clave) y 'claim' la muestra
// UNA vez y vincula ese telefono al boton. Con la clave del vinculo de ese mismo telefono ('secret') se puede volver a ver durante
// 15 minutos; un telefono ya vinculado tambien puede reclamarla (no se crea otro vinculo)
const panicCodeReveal = onCall(async (request) => {
    const data = request.data || {};
    const action = String(data.action || '');
    if (!['peek', 'claim'].includes(action)) throw new HttpsError('invalid-argument', 'Acción no válida');
    const condoId = cleanId(data.c);
    const userId = cleanId(data.v);
    const ip = clientIp(request.rawRequest);
    const log = (outcome, extra = {}) => logger.info('qr panico: ver la clave', { action, outcome, ip, condominioId: condoId, userId, ...extra });
    if (!condoId || !userId) return { ok: false, error: 'Este QR no es válido.' };
    if (await rateLimit.isBlocked('panico_entrega_ip', ip, REVEAL_IP_LIMIT)) {
        log('blocked');
        return { ok: false, blocked: true, error: 'Demasiados intentos desde esta red. Espere 15 minutos e intente de nuevo.' };
    }
    await rateLimit.hit('panico_entrega_ip', ip, REVEAL_IP_LIMIT);

    const secret = SECRET_RE.test(String(data.secret || '')) ? String(data.secret) : '';
    const ref = db.doc(deliveryPath(condoId, userId));
    const cpRef = db.doc(campaignPath(condoId));
    const [snap, cpSnap, neighbor] = await Promise.all([ref.get(), cpRef.get(), loadNeighbor(condoId, userId)]);
    const d = snap.exists ? snap.data() : null;
    const cp = cpSnap.exists ? cpSnap.data() : null;
    const state = deliveryState(d);
    const usable = !!neighbor.condo && neighbor.condo.active === true && !!neighbor.user && neighbor.user.role === ROLES.VECINO && neighbor.user.active !== false;
    // Lo que se dice de una entrega que ya se uso (para que el vecino sepa si fue el)
    const used = state.status === 'delivered' ? { deliveredAt: state.deliveredAt, deliveredOn: state.deliveredOn } : {};
    const mineAgain = !!secret && !!d && d.status === 'delivered' && d.deliveredDevice === sha256(secret) && (Date.now() - Date.parse(d.deliveredAt)) < RESHOW_MS;

    if (action === 'peek') {
        const available = usable && (!!deliverable(d, cp, userId) || mineAgain);
        return { ok: true, available, reshow: available && mineAgain, ...(available ? { name: neighbor.user.name || '', casa: neighbor.user.casa || '', condoName: neighbor.condo.name || '' } : used) };
    }

    if (!usable) { log('not_allowed'); return { ok: false, error: 'La clave de este QR no se puede entregar. Pídala en la administración.' }; }
    const code = await currentCode(condoId, userId);
    if (!code) { log('no_code'); return { ok: false, error: 'Este vecino no tiene clave de acceso. Pídala en la administración.' }; }
    const problem = neighborProblem(neighbor);
    if (mineAgain) {
        log('reshow');
        return { ok: true, code, reshown: true, ...info(neighbor), problem };
    }

    // Un telefono que ya estaba vinculado (con un vinculo vigente de este vecino) no necesita otro
    let linkedHash = '';
    if (secret) {
        const dev = await db.doc(devicePath(condoId, secret)).get();
        if (dev.exists && dev.data().userId === userId && !dev.data().revokedAt) linkedHash = sha256(secret);
    }
    const newSecret = linkedHash ? '' : crypto.randomBytes(32).toString('base64url');
    const deviceHash = linkedHash || sha256(newSecret);
    const userAgent = userAgentOf(request);
    // Solo UNO la ve: la entrega se gasta dentro de una transaccion (dos telefonos al mismo tiempo: el segundo ya la encuentra usada)
    const won = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const cpCur = await tx.get(cpRef);
        const c = cur.exists ? cur.data() : null;
        const g = cpCur.exists ? cpCur.data() : null;
        const via = deliverable(c, g, userId);
        if (!via) return false;
        const delivered = { status: 'delivered', deliveredAt: nowIso(), deliveredOn: deviceKind(userAgent), deliveredDevice: deviceHash, deliveredUserAgent: userAgent };
        if (via === 'oficina') tx.set(ref, { ...c, ...delivered, via: 'oficina' });
        else {
            // Por la entrega general: queda como una entrega de quien activo la general (lo anterior del vecino, a la historia)
            const history = c ? [...(Array.isArray(c.history) ? c.history : []), historyEntry(c)].slice(-HISTORY_MAX) : [];
            tx.set(ref, {
                userId, condominioId: condoId, armedAt: g.startedAt, armedUntil: g.until, armedById: g.startedById || '', armedByName: g.startedByName || '',
                cancelledAt: null, cancelledById: null, cancelledByName: null, history, via: 'general', campaignId: g.campaignId, ...delivered
            });
        }
        return true;
    });
    if (!won) {
        const after = deliveryState((await ref.get()).data());
        log('not_armed', { status: after.status });
        if (after.status === 'delivered') return { ok: false, delivered: true, deliveredAt: after.deliveredAt, deliveredOn: after.deliveredOn, error: 'La clave de este QR ya se entregó. Si no fue usted quien la vio, avise a la administración para que le cambie la clave.' };
        return { ok: false, error: 'La entrega de la clave no está activa. Pídala en la administración (la activan al entregarle el QR).' };
    }
    // El telefono que la vio queda vinculado al boton. Si el vecino todavia no puede usarlo (el panico de vecinos apagado en RONDIN,
    // sin el privilegio), el vinculo queda listo para cuando pueda y la pagina dice por que no sale el boton (problem)
    let linked = '';
    if (!linkedHash) linked = await createDeviceLink({ condoId, userId, code, request, log, via: 'entrega', secret: newSecret });
    log('ok', { linked: !!(linked || linkedHash) });
    return { ok: true, code, ...(linked ? { secret: linked } : {}), ...info(neighbor), problem, alert: null };
});

module.exports = { linkPanicDevice, panicDevice, panicCodeDelivery, panicCodeReveal, _test: { cleanPos, neighborProblem, deliveryState, deviceKind, campaignCovers, deliverable } };
