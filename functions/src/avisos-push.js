// Avisos en el celular (notificaciones push): las funciones. La logica sin firebase esta en avisos-push-core.js.
//
// pushDevice (callable, con sesion): config (la llave publica para suscribirse), register (guarda el telefono), state (si este
// telefono esta activado para el usuario), unregister (lo desactiva), test (un aviso de prueba a ESE telefono) y summary (cuantos
// telefonos tienen los avisos activados, para quien manda mensajes).
// onMessagePush: cuando la administracion crea un mensaje en condominios/{c}/mensajes, avisa a los telefonos de quienes lo reciben.
//
// Datos: condominios/{c}/push_dispositivos/{huella de la direccion} = { userId, role, endpoint, keys, platform, browser, standalone,
// active, createdAt, updatedAt, lastOkAt, lastErrorAt, lastError, revokedAt, revokedBy }. Nada se borra: un telefono que ya no
// recibe se desactiva (active: false) con el motivo. Las reglas no dejan leerla ni escribirla desde el navegador. Las llaves
// VAPID del servidor (con las que los servicios de avisos saben que el aviso es de garita.app) se crean solas la primera vez en
// _privado/push; la privada nunca sale del servidor.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const webpush = require('web-push');
const { db } = require('./firebase');
const privilegios = require('./privilegios');
const rateLimit = require('./rateLimit');
const core = require('./avisos-push-core');

const KEYS_DOC = '_privado/push';
const VAPID_SUBJECT = 'https://garita.app';
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';
// En los emuladores, las direcciones de prueba (con esta marca) no salen a internet: el envio queda en _push_simulados
const FAKE_MARK = '/prueba-sisdel-';

const REGISTER_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 };
const TEST_LIMIT = { max: 6, windowMs: 10 * 60 * 1000 };
// Tope de mensajes con aviso por condominio: un error que cree mensajes en bucle no llena de avisos los telefonos
const MESSAGE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };

// Las llaves se leen de la base en cada uso (una lectura): si se cambian en _privado/push, todas las instancias usan las nuevas
async function loadKeys() {
    const ref = db.doc(KEYS_DOC);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : null;
    if (data && data.publicKey && data.privateKey) return { publicKey: data.publicKey, privateKey: data.privateKey };
    return db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const d = cur.exists ? cur.data() : null;
        if (d && d.publicKey && d.privateKey) return { publicKey: d.publicKey, privateKey: d.privateKey };
        const keys = webpush.generateVAPIDKeys();
        tx.set(ref, { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() });
        return keys;
    });
}

async function fakeSend(device, payload) {
    await db.collection('_push_simulados').add({ deviceId: device.id, userId: device.userId || null, endpoint: device.endpoint, payload, at: new Date().toISOString() });
    if (device.endpoint.includes(FAKE_MARK + 'gone')) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
    if (device.endpoint.includes(FAKE_MARK + 'falla')) { const e = new Error('Server error'); e.statusCode = 500; throw e; }
    return { statusCode: 201 };
}

async function sendTo(device, payload, keys) {
    if (IS_EMULATOR && device.endpoint.includes(FAKE_MARK)) return fakeSend(device, payload);
    return webpush.sendNotification(
        { endpoint: device.endpoint, keys: device.keys },
        JSON.stringify(payload),
        { vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: core.TTL_SECONDS, urgency: 'high', timeout: 15000 }
    );
}

function nowIso() { return new Date().toISOString(); }

// Guarda lo que paso con cada telefono: el que ya no recibe queda desactivado con el motivo
async function recordResults(col, results) {
    const at = nowIso();
    for (let i = 0; i < results.length; i += 400) {
        const batch = db.batch();
        for (const r of results.slice(i, i + 400)) {
            const ref = col.doc(r.id);
            if (r.ok) batch.update(ref, { lastOkAt: at });
            else if (r.kind === 'gone') batch.update(ref, { active: false, revokedAt: at, revokedBy: 'servicio', lastError: `${r.status || ''} ${r.error || ''}`.trim().slice(0, 200), lastErrorAt: at });
            else batch.update(ref, { lastErrorAt: at, lastError: `${r.status || ''} ${r.error || ''}`.trim().slice(0, 200) });
        }
        await batch.commit();
    }
}

function fail(code, text) { throw new HttpsError(code, text); }

const pushDevice = onCall({ timeoutSeconds: 60 }, async (request) => {
    if (!request.auth) fail('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const condominioId = token.condominioId;
    if (!condominioId || uid === 'master') fail('permission-denied', 'Los avisos al celular son para los usuarios de un condominio.');
    const data = request.data || {};
    const action = String(data.action || '');
    const condoRef = db.collection('condominios').doc(condominioId);
    const [condoSnap, meSnap] = await Promise.all([condoRef.get(), condoRef.collection('usuarios').doc(uid).get()]);
    const condo = condoSnap.exists ? condoSnap.data() : null;
    if (!condo || condo.active === false || condo.purging === true) fail('failed-precondition', 'El condominio no está activo.');
    const me = meSnap.exists ? meSnap.data() : null;
    if (!me || me.active === false) fail('permission-denied', 'Su usuario no está activo.');
    const canReceive = privilegios.has(me.role, me.privilegios, 'mensajes.recibir');
    const col = condoRef.collection('push_dispositivos');

    if (action === 'summary') {
        if (!privilegios.has(me.role, me.privilegios, 'mensajes.enviar')) fail('permission-denied', 'Su usuario no envía mensajes.');
        const snap = await col.where('active', '==', true).get();
        const ids = [...new Set(snap.docs.map((d) => d.data().userId).filter(Boolean))];
        const users = await getUsers(condoRef, ids);
        const byRole = {};
        let devices = 0;
        const counted = new Set();
        for (const d of snap.docs) {
            const u = users[d.data().userId];
            if (!u || u.active === false || !privilegios.has(u.role, u.privilegios, 'mensajes.recibir')) continue;
            devices += 1;
            if (counted.has(d.data().userId)) continue;
            counted.add(d.data().userId);
            byRole[u.role] = (byRole[u.role] || 0) + 1;
        }
        return { devices, users: counted.size, byRole };
    }

    if (!canReceive) fail('permission-denied', 'Su usuario no recibe mensajes de la administración.');
    if (action === 'config') return { publicKey: (await loadKeys()).publicKey };

    if (!['register', 'state', 'unregister', 'test'].includes(action)) fail('invalid-argument', 'Acción desconocida.');
    let endpoint = '';
    let subKeys = null;
    if (action === 'register') {
        const clean = core.cleanSubscription(data.subscription);
        if (clean.error) fail('invalid-argument', clean.error);
        endpoint = clean.endpoint;
        subKeys = clean.keys;
    } else {
        endpoint = String(data.endpoint || '');
        if (!endpoint || endpoint.length > 1000) fail('invalid-argument', 'Falta la dirección de avisos del teléfono.');
    }
    const id = core.deviceId(endpoint);
    const ref = col.doc(id);

    if (action === 'state') {
        const snap = await ref.get();
        const d = snap.exists ? snap.data() : null;
        const active = !!(d && d.active !== false);
        return { active: active && d.userId === uid, otherUser: active && d.userId !== uid };
    }

    if (action === 'unregister') {
        const snap = await ref.get();
        // Quien tiene la direccion del telefono es quien tiene el telefono: puede apagar sus avisos aunque los haya activado otro usuario
        if (snap.exists && snap.data().active !== false) await ref.update({ active: false, revokedAt: nowIso(), revokedBy: 'usuario', revokedById: uid });
        return { ok: true };
    }

    if (action === 'register') {
        if (await rateLimit.isBlocked('push-registro', uid, REGISTER_LIMIT)) fail('resource-exhausted', 'Intentó muchas veces seguidas. Espere unos minutos.');
        await rateLimit.hit('push-registro', uid, REGISTER_LIMIT);
        const ua = String(request.rawRequest && request.rawRequest.headers ? request.rawRequest.headers['user-agent'] || '' : '');
        const at = nowIso();
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const prev = snap.exists ? snap.data() : null;
            const doc = {
                id, userId: uid, role: me.role, endpoint, keys: subKeys,
                platform: core.platformOf(ua), browser: core.browserOf(ua), standalone: data.standalone === true,
                active: true, updatedAt: at, revokedAt: null, revokedBy: null
            };
            if (!prev) doc.createdAt = at;
            // Un telefono que pasa a otro usuario (otra persona entro con su clave y activo los avisos) recibe desde ahora los de ella
            if (prev && prev.userId && prev.userId !== uid) { doc.previousUserId = prev.userId; doc.changedUserAt = at; }
            tx.set(ref, doc, { merge: true });
        });
        // Hasta 10 telefonos por usuario: el que sobra (el mas viejo) se desactiva
        const mine = await col.where('userId', '==', uid).get();
        const extra = core.overLimit(mine.docs.map((d) => ({ id: d.id, ...d.data() })), id);
        if (extra.length) {
            const batch = db.batch();
            extra.forEach((d) => batch.update(col.doc(d.id), { active: false, revokedAt: at, revokedBy: 'reemplazado' }));
            await batch.commit();
        }
        return { ok: true };
    }

    if (action === 'test') {
        const snap = await ref.get();
        const d = snap.exists ? { id, ...snap.data() } : null;
        if (!d || d.active === false || d.userId !== uid) fail('failed-precondition', 'Este teléfono no tiene los avisos activados. Toque "Activar avisos".');
        if (await rateLimit.isBlocked('push-prueba', uid, TEST_LIMIT)) fail('resource-exhausted', 'Ya envió varias pruebas seguidas. Espere unos minutos.');
        await rateLimit.hit('push-prueba', uid, TEST_LIMIT);
        const keys = await loadKeys();
        const results = await core.sendAll([d], (dev) => sendTo(dev, core.testPayload(condo.name), keys), 1);
        await recordResults(col, results);
        const r = results[0];
        logger.info('avisos: prueba', { condominioId, por: uid, ok: r.ok, status: r.status || null });
        return { ok: r.ok, gone: r.kind === 'gone' };
    }
    return null;
});

async function getUsers(condoRef, ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map((id) => condoRef.collection('usuarios').doc(id));
        if (!refs.length) continue;
        const snaps = await db.getAll(...refs);
        snaps.forEach((s) => { if (s.exists) out[s.id] = s.data(); });
    }
    return out;
}

const onMessagePush = onDocumentCreated({ document: 'condominios/{condoId}/mensajes/{msgId}', timeoutSeconds: 300 }, async (event) => {
    const snap = event.data;
    if (!snap) return;
    const { condoId } = event.params;
    const msg = { id: snap.id, ...snap.data() };
    if (msg.push === false) return;
    const condoRef = db.collection('condominios').doc(condoId);
    const condoSnap = await condoRef.get();
    const condo = condoSnap.exists ? condoSnap.data() : null;
    if (!condo || condo.active === false || condo.purging === true) return;

    // Un mismo evento puede llegar dos veces: solo una corrida envia
    const first = await db.runTransaction(async (tx) => {
        const cur = await tx.get(snap.ref);
        if (!cur.exists || cur.data().pushResult) return false;
        tx.update(snap.ref, { pushResult: { status: 'enviando', at: nowIso() } });
        return true;
    });
    if (!first) return;

    const finish = (result) => snap.ref.update({ pushResult: { status: 'listo', at: nowIso(), ...result } })
        .catch((e) => logger.warn('avisos: no se pudo anotar el resultado (¿mensaje borrado?)', { condominioId: condoId, mensaje: snap.id, error: e.message }));
    const col = condoRef.collection('push_dispositivos');
    const devSnap = await col.where('active', '==', true).get();
    const devices = devSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const users = await getUsers(condoRef, [...new Set(devices.map((d) => d.userId).filter(Boolean))]);
    const targets = core.recipientsFor(msg, devices, users, (u) => privilegios.has(u.role, u.privilegios, 'mensajes.recibir'));
    if (!targets.length) { await finish({ devices: 0, sent: 0, failed: 0, gone: 0, users: 0 }); return; }

    if (await rateLimit.isBlocked('push-mensajes', condoId, MESSAGE_LIMIT)) {
        logger.warn('avisos: tope de mensajes con aviso', { condominioId: condoId, mensaje: snap.id });
        await finish({ devices: targets.length, sent: 0, failed: 0, gone: 0, users: 0, skipped: 'tope' });
        return;
    }
    await rateLimit.hit('push-mensajes', condoId, MESSAGE_LIMIT);

    const keys = await loadKeys();
    const payload = core.messagePayload(msg, condo.name);
    const results = await core.sendAll(targets, (d) => sendTo(d, payload, keys));
    await recordResults(col, results).catch((e) => logger.warn('avisos: no se pudo anotar cada telefono', { condominioId: condoId, error: e.message }));
    const sum = core.summarize(results);
    const reached = new Set(targets.filter((d, i) => results[i] && results[i].ok).map((d) => d.userId));
    await finish({ ...sum, users: reached.size });
    logger.info('avisos: mensaje', { condominioId: condoId, mensaje: snap.id, toRole: msg.toRole || 'all', ...sum, users: reached.size });
});

module.exports = { pushDevice, onMessagePush, _test: { loadKeys, sendTo } };
