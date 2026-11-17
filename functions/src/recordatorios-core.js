// Envio de recordatorios por WhatsApp a todos los residentes con un solo clic (OIKOS > Residentes > Recordatorios).
//
// Como funciona (todo en el servidor, con el WhatsApp del condominio: UltraMsg o Meta, ver rondas/whatsapp.js):
//  1. createCampaign: OIKOS manda el texto de cada residente (ya con su nombre y su saldo). El servidor NO recibe telefonos:
//     los lee de la ficha del vecino (usuarios/{id}.phone), asi nadie usa el numero del condominio para escribirle a un
//     numero cualquiera. Guarda el envio en condominios/{c}/recordatorios_envios/{id} (un documento por residente en
//     "destinatarios") y lo anota en la cola colas_envios.
//  2. processQueue (cada minuto, ver recordatorios.js): manda de a poco, con una pausa de 6 a 10 segundos entre mensajes
//     (WhatsApp bloquea los numeros que mandan cientos seguidos). Cada mensaje queda como enviado o fallido; despues de
//     5 fallos seguidos se detiene y avisa.
//  3. controlCampaign: cancelar, reanudar o reintentar los fallidos.
// Los documentos de un envio los escribe solo el servidor; OIKOS los lee para mostrar el avance (reglas de Firestore).
// Aqui no se importa firebase: la base y el proveedor entran por parametro (se prueba con scripts/test-recordatorios.mjs).
const { normalizePhone } = require('./rondas/avisos');

const MAX_RECIPIENTS = 1500;
const MAX_TEXT = 1000;
const PAUSE_MIN_MS = 6000;
const PAUSE_MAX_MS = 10000;
const AVG_PAUSE_SECONDS = 8;
const RUN_BUDGET_MS = 12 * 60 * 1000;   // lo que trabaja cada corrida del minuto (la funcion tiene 15 min)
const LOCK_MS = 14 * 60 * 1000;         // una sola corrida por envio; si una muere, el turno vence solo
const FAIL_STREAK = 5;
const BATCH = 400;
const QUEUE = 'colas_envios';

// Error con el codigo de HttpsError y un texto en español para quien lo usa
function fail(code, message) {
    return Object.assign(new Error(message), { userCode: code });
}
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomPause = () => PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS + 1));
const campaignsOf = (db, condominioId) => db.collection('condominios').doc(condominioId).collection('recordatorios_envios');
const queueDoc = (db, condominioId, campaignId) => db.collection(QUEUE).doc(`${condominioId}__${campaignId}`);
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

async function recount(campRef) {
    const col = campRef.collection('destinatarios');
    const count = async (status) => (await col.where('status', '==', status).count().get()).data().count;
    const [pending, sent, failed, skipped] = await Promise.all([count('pending'), count('sent'), count('failed'), count('skipped')]);
    await campRef.update({ pending, sent, failed, skipped });
    return { pending, sent, failed, skipped };
}

async function hasRunning(db, condominioId, exceptId) {
    const snap = await campaignsOf(db, condominioId).where('status', '==', 'running').limit(3).get();
    return snap.docs.some((d) => d.id !== exceptId);
}

// ───────── 1. Crear el envio ─────────
async function createCampaign({ db, whatsapp, condominioId, caller, data, now = () => new Date() }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.');
    }
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) throw fail('invalid-argument', 'No hay a quién enviar.');
    if (items.length > MAX_RECIPIENTS) throw fail('invalid-argument', `Se pueden enviar hasta ${MAX_RECIPIENTS} mensajes a la vez.`);
    const texts = new Map();
    for (const item of items) {
        const id = String((item && item.residentId) || '').trim();
        const text = String((item && item.text) || '').trim();
        if (!id || id.includes('/') || !text) throw fail('invalid-argument', 'Hay un mensaje sin residente o sin texto.');
        if (text.length > MAX_TEXT) throw fail('invalid-argument', `Un mensaje pasa de ${MAX_TEXT} caracteres.`);
        if (!texts.has(id)) texts.set(id, text);
    }
    if (await hasRunning(db, condominioId)) throw fail('failed-precondition', 'Ya hay un envío en curso. Espere a que termine o cancélelo.');

    // Los telefonos salen de la ficha del vecino (nunca del cliente)
    const condoRef = db.collection('condominios').doc(condominioId);
    const ids = [...texts.keys()];
    const users = [];
    const fichas = [];
    for (const part of chunks(ids, 300)) {
        users.push(...await db.getAll(...part.map((id) => condoRef.collection('usuarios').doc(id))));
        fichas.push(...await db.getAll(...part.map((id) => condoRef.collection('finanzas_residentes').doc(id))));
    }
    const rows = ids.map((id, i) => {
        const user = users[i].exists ? users[i].data() : null;
        const ficha = fichas[i].exists ? fichas[i].data() : null;
        const phone = user ? normalizePhone(user.phone) : '';
        let reason = null;
        if (!user || user.role !== 'vecino') reason = 'no es un vecino';
        else if (user.active === false) reason = 'vecino inactivo';
        else if (ficha && ficha.deleted) reason = 'quitado del Sistema Financiero';
        else if (!phone) reason = 'sin teléfono válido';
        return {
            id,
            data: {
                name: user ? String(user.name || '') : '', casa: user ? String(user.casa || '') : '',
                phoneTail: phone ? phone.slice(-4) : '', text: texts.get(id),
                status: reason ? 'skipped' : 'pending', ...(reason ? { reason } : {})
            }
        };
    });
    const pending = rows.filter((r) => r.data.status === 'pending');
    if (!pending.length) throw fail('failed-precondition', 'Ninguno de los residentes tiene un teléfono válido.');

    const campRef = campaignsOf(db, condominioId).doc();
    for (const part of chunks(rows, BATCH)) {
        const batch = db.batch();
        part.forEach((row) => batch.set(campRef.collection('destinatarios').doc(row.id), row.data));
        await batch.commit();
    }
    const createdAt = now().toISOString();
    await campRef.set({
        createdAt, createdBy: { id: caller.id, name: String(caller.name || '') },
        mode: data.mode === 'varios' ? 'varios' : 'mora', status: 'running', lockUntil: 0,
        total: rows.length, pending: pending.length, sent: 0, failed: 0, skipped: rows.length - pending.length,
        pauseSeconds: AVG_PAUSE_SECONDS, sample: pending[0].data.text.slice(0, 200)
    });
    await queueDoc(db, condominioId, campRef.id).set({ condominioId, campaignId: campRef.id, status: 'running', createdAt });
    return {
        id: campRef.id, total: rows.length, pending: pending.length, skipped: rows.length - pending.length,
        estimatedMinutes: Math.ceil((pending.length * AVG_PAUSE_SECONDS) / 60)
    };
}

// ───────── 2. Mandar (la corrida de cada minuto) ─────────
async function processCampaign(ctx) {
    const { db, whatsapp, sleep, pause, budgetMs, nowMs, started, condominioId, campaignId, queueRef } = ctx;
    const campRef = campaignsOf(db, condominioId).doc(campaignId);
    const isoNow = () => new Date(nowMs()).toISOString();

    // Tomar el turno: una sola corrida por envio
    const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(campRef);
        if (!snap.exists) return { gone: true };
        const camp = snap.data();
        if (camp.status !== 'running') return { status: camp.status };
        if ((camp.lockUntil || 0) > nowMs()) return { busy: true };
        tx.update(campRef, { lockUntil: nowMs() + LOCK_MS });
        return { ok: true, counts: { pending: camp.pending || 0, sent: camp.sent || 0, failed: camp.failed || 0, skipped: camp.skipped || 0 } };
    });
    if (claimed.gone) { await queueRef.delete(); return { campaignId, gone: true }; }
    if (claimed.status) { await queueRef.set({ status: claimed.status }, { merge: true }); return { campaignId, status: claimed.status }; }
    if (claimed.busy) return { campaignId, busy: true };

    const condoRef = db.collection('condominios').doc(condominioId);
    // Los contadores los escribe solo quien tiene el turno: se llevan aqui y se guardan completos cada vez
    let counts = claimed.counts;
    const bump = async (kind) => {
        counts = { ...counts, pending: Math.max(0, counts.pending - 1), [kind]: counts[kind] + 1 };
        await campRef.update(counts);
    };
    // Lo que quedo "enviando" cuando una corrida murio: no se sabe si salio. No se repite (podria duplicarse): queda como fallido.
    const stale = await campRef.collection('destinatarios').where('status', '==', 'sending').get();
    for (const doc of stale.docs) await doc.ref.update({ status: 'failed', error: 'Interrumpido: puede que sí se haya enviado' });
    if (stale.size) counts = await recount(campRef);

    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: 'WhatsApp no está conectado. Pida al programador que lo conecte y use Reanudar.' });
        await queueRef.set({ status: 'error' }, { merge: true });
        return { campaignId, status: 'error' };
    }

    let sent = 0; let failed = 0; let streak = 0; let tick = 0; let finished = false; let stoppedBy = null;
    outer: for (;;) {
        const page = await campRef.collection('destinatarios').where('status', '==', 'pending').limit(20).get();
        if (page.empty) { finished = true; break; }
        for (const doc of page.docs) {
            if (nowMs() - started >= budgetMs) { stoppedBy = 'tiempo'; break outer; }
            if (tick++ % 5 === 0) {
                const current = await campRef.get();
                if (!current.exists || current.data().status !== 'running') { stoppedBy = 'estado'; break outer; }
            }
            const user = await condoRef.collection('usuarios').doc(doc.id).get();
            const phone = user.exists && user.data().active !== false ? normalizePhone(user.data().phone) : '';
            if (!phone) {
                await doc.ref.update({ status: 'skipped', reason: 'sin teléfono válido' });
                await bump('skipped');
                continue;
            }
            await doc.ref.update({ status: 'sending', startedAt: isoNow() });
            let channel = null;
            let error = null;
            try { channel = await whatsapp.send(config, phone, doc.data().text); } catch (e) { error = e && e.message ? e.message : 'error'; }
            if (channel) {
                await doc.ref.update({ status: 'sent', channel, sentAt: isoNow() });
                await bump('sent');
                sent++; streak = 0;
            } else {
                await doc.ref.update({ status: 'failed', error: error || 'No salió por ningún proveedor de WhatsApp' });
                await bump('failed');
                failed++; streak++;
                if (streak >= FAIL_STREAK) { stoppedBy = 'fallos'; break outer; }
            }
            await sleep(pause());
        }
    }

    if (finished) {
        await recount(campRef);
        await campRef.update({ status: 'done', finishedAt: isoNow(), lockUntil: 0 });
        await queueRef.set({ status: 'done' }, { merge: true });
    } else if (stoppedBy === 'fallos') {
        await recount(campRef);
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `WhatsApp no está respondiendo (${FAIL_STREAK} fallos seguidos). Revise la conexión de UltraMsg y use Reanudar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
    } else {
        await campRef.update({ lockUntil: 0 });
    }
    return { campaignId, sent, failed, finished, stoppedBy };
}

async function processQueue({ db, whatsapp, sleep = realSleep, pause = randomPause, budgetMs = RUN_BUDGET_MS, nowMs = () => Date.now() }) {
    const started = nowMs();
    const queued = await db.collection(QUEUE).where('status', '==', 'running').get();
    const results = [];
    for (const doc of queued.docs) {
        if (nowMs() - started >= budgetMs) break;
        const { condominioId, campaignId } = doc.data();
        results.push(await processCampaign({ db, whatsapp, sleep, pause, budgetMs, nowMs, started, condominioId, campaignId, queueRef: doc.ref }));
    }
    return results;
}

// ───────── 3. Cancelar, reanudar, reintentar ─────────
async function controlCampaign({ db, condominioId, data, now = () => new Date() }) {
    const campaignId = String((data && data.campaignId) || '').trim();
    if (!campaignId || campaignId.includes('/')) throw fail('invalid-argument', 'Envío inválido.');
    const campRef = campaignsOf(db, condominioId).doc(campaignId);
    const snap = await campRef.get();
    if (!snap.exists) throw fail('not-found', 'El envío no existe.');
    const camp = snap.data();
    const queueRef = queueDoc(db, condominioId, campaignId);
    const action = data && data.action;
    const iso = now().toISOString();

    if (action === 'cancel') {
        if (camp.status !== 'running' && camp.status !== 'error') throw fail('failed-precondition', 'Ese envío ya no está en curso.');
        await campRef.update({ status: 'canceled', canceledAt: iso, lockUntil: 0 });
        await queueRef.set({ condominioId, campaignId, status: 'canceled' }, { merge: true });
        return { status: 'canceled' };
    }
    if (action === 'resume' || action === 'retry') {
        if (camp.status === 'running') throw fail('failed-precondition', 'Ese envío ya está en curso.');
        if (await hasRunning(db, condominioId, campaignId)) throw fail('failed-precondition', 'Ya hay otro envío en curso.');
        if (action === 'retry') {
            const failedDocs = await campRef.collection('destinatarios').where('status', '==', 'failed').get();
            for (const part of chunks(failedDocs.docs, BATCH)) {
                const batch = db.batch();
                part.forEach((doc) => batch.update(doc.ref, { status: 'pending', error: null }));
                await batch.commit();
            }
        }
        const counts = await recount(campRef);
        if (!counts.pending) throw fail('failed-precondition', 'No queda nadie por enviar.');
        await campRef.update({ status: 'running', lockUntil: 0, errorMessage: null, finishedAt: null });
        await queueRef.set({ condominioId, campaignId, status: 'running', createdAt: iso }, { merge: true });
        return { status: 'running', pending: counts.pending };
    }
    throw fail('invalid-argument', 'Acción inválida.');
}

// ───────── 4. Mensaje de prueba ─────────
async function sendTest({ whatsapp, data }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio.');
    const phone = normalizePhone(data && data.phone);
    if (!phone) throw fail('invalid-argument', 'Escriba el teléfono completo (8 dígitos de Guatemala o con código de país).');
    const text = String((data && data.text) || '').trim();
    if (!text || text.length > MAX_TEXT) throw fail('invalid-argument', `El mensaje debe tener entre 1 y ${MAX_TEXT} caracteres.`);
    const channel = await whatsapp.send(config, phone, text);
    return { sent: !!channel, channel: channel || null, phoneTail: phone.slice(-4) };
}

module.exports = {
    MAX_RECIPIENTS, MAX_TEXT, PAUSE_MIN_MS, PAUSE_MAX_MS, AVG_PAUSE_SECONDS, RUN_BUDGET_MS, LOCK_MS, FAIL_STREAK,
    fail, recount, createCampaign, processQueue, processCampaign, controlCampaign, sendTest
};
