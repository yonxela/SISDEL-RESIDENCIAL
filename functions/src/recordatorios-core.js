// Envio de recordatorios por WhatsApp a todos los residentes con un solo clic (OIKOS > Residentes > Recordatorios).
//
// Como funciona (todo en el servidor, con el WhatsApp del condominio: UltraMsg o Meta, ver rondas/whatsapp.js):
//  1. createCampaign: OIKOS manda el texto de cada residente (ya con su nombre y su saldo). El servidor NO recibe telefonos:
//     los lee de la ficha del vecino (usuarios/{id}.phone), asi nadie usa el numero del condominio para escribirle a un
//     numero cualquiera. Guarda el envio en condominios/{c}/recordatorios_envios/{id} (un documento por residente en
//     "destinatarios") y lo anota en la cola colas_envios.
//  2. processQueue (cada minuto, ver recordatorios.js): manda de a poco, con una pausa al azar de 25 a 55 segundos entre
//     mensajes, solo de 8:00 a 18:00 (hora de Guatemala) y, con UltraMsg, hasta 120 mensajes por dia y condominio: lo demas
//     sigue solo al dia siguiente (envio cuidadoso, ver SCHEDULE). Cada mensaje queda como enviado o fallido; despues de
//     5 fallos seguidos se detiene y avisa.
//     Antes de mandar, y cada 10 mensajes, se comprueba que el WhatsApp del condominio este conectado (UltraMsg acepta los
//     mensajes aunque su instancia este desconectada y los deja en cola: sin esta revision decia "enviado" y no salia nada).
//     Tambien se comprueba que WhatsApp deje salir los mensajes (palomitas): con el numero restringido por WhatsApp la instancia
//     sigue conectada y nada llega, asi que se frena (healthOf; La Perla, 16 y 17/11/2026).
//     "Enviado" = UltraMsg lo ACEPTO. Lo que llego de verdad se pregunta a UltraMsg: reconcileCampaign marca cada destinatario como
//     entregado / enviado / pendiente / en cola / rechazado / desconocido (ver ultramsg-estado.js) y resendCampaign manda de nuevo
//     solo a los que no recibieron. Los envios a UN residente y la prueba se verifican a los pocos segundos.
//  3. controlCampaign: pausar, continuar, cancelar o reintentar los fallidos. Pausar detiene el envio (en cuanto sale el
//     mensaje en curso) y se puede continuar despues; cancelar es definitivo para quien usa OIKOS.
// Los documentos de un envio los escribe solo el servidor; OIKOS los lee para mostrar el avance (reglas de Firestore).
// Aqui no se importa firebase: la base y el proveedor entran por parametro (se prueba con scripts/test-recordatorios.mjs).
const { normalizePhone } = require('./rondas/avisos');

const MAX_RECIPIENTS = 1500;
const MAX_TEXT = 1000;
// Envio cuidadoso (pedido del usuario el 2026-11-17, despues de que WhatsApp restringiera el numero de La Perla por mandar
// cientos de recordatorios seguidos a contactos nuevos: pagar UltraMsg paga el servicio, no el permiso de WhatsApp). WhatsApp
// vigila sobre todo cuantos mensajes manda un numero a gente que no le ha escrito y que tan seguido: por eso los envios a
// muchos salen despacio (una pausa al azar de 25 a 55 s, que no parezca una maquina), solo en horario de oficina de Guatemala
// y, con UltraMsg, con un tope por dia y condominio; lo que pasa del tope o del horario sigue solo (el envio queda "en
// espera" con waitingUntil y waitingReason). Con el WhatsApp oficial de Meta el tope por dia lo pone Meta y este no se aplica.
// Ningun ritmo garantiza que WhatsApp no restrinja un numero no oficial: lo garantiza el canal oficial (Meta con plantillas).
const PAUSE_MIN_MS = 25000;
const PAUSE_MAX_MS = 55000;
const AVG_PAUSE_SECONDS = 40;
const SEND_HOURS = { from: 8, to: 18 };      // hora de Guatemala
const DAILY_LIMIT = 120;                      // mensajes por dia y condominio con UltraMsg
const SCHEDULE = { hours: SEND_HOURS, dailyLimit: DAILY_LIMIT };
const DAY_COL = 'recordatorios_dia';          // condominios/{c}/recordatorios_dia/{AAAA-MM-DD}: { count } (lo escribe el servidor)
const GT_OFFSET_MS = 6 * 60 * 60 * 1000;      // Guatemala: UTC-6 todo el ano (sin horario de verano)
const RUN_BUDGET_MS = 12 * 60 * 1000;   // lo que trabaja cada corrida del minuto (la funcion tiene 15 min)
const LOCK_MS = 14 * 60 * 1000;         // una sola corrida por envio; si una muere, el turno vence solo
const FAIL_STREAK = 5;
const BATCH = 400;
const VERIFY_WAIT_MS = 8000;            // cuanto se espera, como maximo, el resultado real de un envio a UN residente
const VERIFY_STEP_MS = 2000;
const CONN_CHECK_EVERY = 10;            // cada cuantos mensajes se vuelve a comprobar la conexion de WhatsApp
const QUEUE = 'colas_envios';

// Error con el codigo de HttpsError y un texto en español para quien lo usa
function fail(code, message) {
    return Object.assign(new Error(message), { userCode: code });
}
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomPause = () => PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS + 1));
// La fecha de Guatemala de un instante: sus campos UTC son la hora local de Guatemala
const gtDate = (ms) => new Date(ms - GT_OFFSET_MS);
const gtDay = (ms) => gtDate(ms).toISOString().slice(0, 10);
// La hora de abrir (hours.from) de Guatemala de ese dia o, con `tomorrow`, del siguiente (en ms)
function nextOpening(ms, hours, tomorrow) {
    const d = gtDate(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (tomorrow ? 1 : 0), hours.from, 0, 0) + GT_OFFSET_MS;
}
// null si a esa hora se puede mandar; si no, cuando se puede (ms)
function waitFor(ms, hours) {
    const d = gtDate(ms);
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (h >= hours.from && h < hours.to) return null;
    return nextOpening(ms, hours, h >= hours.to);
}
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

// Un envio en pausa cuenta como en curso: si no, se podria empezar otro a todos y repetir mensajes
async function hasRunning(db, condominioId, exceptId) {
    const snap = await campaignsOf(db, condominioId).where('status', 'in', ['running', 'paused']).limit(5).get();
    return snap.docs.some((d) => d.id !== exceptId);
}

// Conexion del WhatsApp del condominio. El proveedor la consulta (whatsapp.connection); si no se puede saber (null) se deja
// seguir: el envio mismo dira si falla. Un proveedor sin control (las pruebas) cuenta como conectado.
async function connectionOf(whatsapp, config) {
    if (typeof whatsapp.connection !== 'function') return { connected: true, state: 'sin-control' };
    try { return await whatsapp.connection(config); } catch (e) { return { connected: null, state: 'sin-respuesta' }; }
}
const connectionText = (whatsapp, conn) => (typeof whatsapp.describeConnection === 'function' ? whatsapp.describeConnection(conn) : `WhatsApp no está conectado (estado: ${conn.state}).`);
async function requireConnected(whatsapp, config) {
    const conn = await connectionOf(whatsapp, config);
    if (conn.connected === false) throw fail('failed-precondition', connectionText(whatsapp, conn));
    return conn;
}
// ¿WhatsApp deja salir los mensajes? Conectado no basta: con el numero restringido UltraMsg sigue "authenticated" y los mensajes
// se quedan sin palomita (ver health en ultramsg-estado.js; La Perla, 16 y 17/11/2026). Con el numero asi se frena el envio a
// todos, el reenvio, continuar y el envio a uno; la prueba NO (es la forma de saber que ya paso). Si no se puede saber, se sigue.
async function healthOf(whatsapp, config) {
    if (typeof whatsapp.health !== 'function') return { confirming: null };
    try { return (await whatsapp.health(config)) || { confirming: null }; } catch (e) { return { confirming: null }; }
}
const healthText = (whatsapp, h) => (typeof whatsapp.describeHealth === 'function' ? whatsapp.describeHealth(h) : 'WhatsApp no está dejando salir los mensajes del número del condominio.');
async function requireConfirming(whatsapp, config) {
    const h = await healthOf(whatsapp, config);
    if (h.confirming === false) throw fail('failed-precondition', healthText(whatsapp, h));
    return h;
}

// WhatsApp OFICIAL de Meta: los avisos van con una plantilla aprobada (un texto fijo con huecos) y OIKOS manda los datos de cada
// residente (`vars`: nombre, casa, saldo...) en vez de un texto. El texto que queda anotado es el de la plantilla ya llena.
const templatesOn = (whatsapp, config) => typeof whatsapp.usesTemplates === 'function' && !!whatsapp.usesTemplates(config);
function templateOrFail(whatsapp, config, mode) {
    const tpl = typeof whatsapp.templateFor === 'function' ? whatsapp.templateFor(config, mode) : null;
    if (!tpl) throw fail('failed-precondition', `Falta la plantilla de Meta para los avisos de ${mode === 'varios' ? 'mensajes varios' : 'mora'}. Pida al programador que la cargue (scripts/set-whatsapp-plantillas.mjs).`);
    return tpl;
}
// Una plantilla con el AVISO que se escribe en OIKOS (aviso_general, Mensajes varios): sin el aviso no se envia (saldria
// "le informa: -."). Al reenviar ya vienen los `params` calculados
const avisoMissing = (tpl, item) => Array.isArray(tpl.params) && tpl.params.includes('aviso') && !(item && Array.isArray(item.params))
    && !String((item && item.vars && item.vars.aviso) || '').trim();
const AVISO_MISSING = 'Escriba el aviso antes de enviarlo: va dentro de la plantilla aprobada por Meta.';
// Un envio hecho con el numero anterior (UltraMsg, sin `channel: 'meta'`) no se sigue con el WhatsApp oficial (2026-11-27)
const OLD_CHANNEL = 'Este envío se hizo con el número anterior. Use «Continuar con los que faltan»: crea un envío nuevo por el WhatsApp oficial solo con los residentes que todavía no lo recibieron.';
// Los datos de la plantilla de un residente: ya calculados (`params`, al reenviar) o a partir de `vars`; null si no vienen
const paramsOf = (whatsapp, tpl, item) => {
    if (item && Array.isArray(item.params)) return item.params.map(String);
    if (item && item.vars && typeof item.vars === 'object') return whatsapp.templateParams(tpl, item.vars);
    return null;
};

// Resultado REAL de un envio suelto: se espera unos segundos y se mira lo que UltraMsg dice del mensaje a ese telefono.
// null si no se puede saber (proveedor sin esta consulta o UltraMsg no responde).
async function verifyDelivery({ whatsapp, config, phone, sinceMs, waitMs = VERIFY_WAIT_MS, sleep = realSleep }) {
    if (templatesOn(whatsapp, config)) return null;   // con Meta el resultado llega por su webhook, no por el listado de UltraMsg
    if (typeof whatsapp.listMessages !== 'function' || typeof whatsapp.deliveryFor !== 'function') return null;
    const sinceSec = Math.floor(sinceMs / 1000);
    const attempts = Math.max(1, Math.ceil(waitMs / VERIFY_STEP_MS) + 1);   // la primera mirada es enseguida; despues se espera de a 2 s
    let last = null;
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(VERIFY_STEP_MS);
        let rows = null;
        try { rows = await whatsapp.listMessages(config, { sinceSec: sinceSec - 5, maxPages: 1 }); } catch (e) { rows = null; }
        if (!rows) return last;
        const result = whatsapp.deliveryFor(rows, phone, sinceSec);
        last = { state: result.state, reason: result.reason || '' };
        if (result.found && result.state !== 'en_cola' && result.state !== 'pendiente') return last;
    }
    return last;
}
const reasonText = (whatsapp, reason) => (typeof whatsapp.describeReason === 'function' ? whatsapp.describeReason(reason) : String(reason || ''));

// Por que a un residente no se le puede enviar (null si si): lo usan el envio a todos y el envio a uno
function skipReason(user, ficha, phone) {
    if (!user || user.role !== 'vecino') return 'no es un vecino';
    if (user.active === false) return 'vecino inactivo';
    if (ficha && ficha.deleted) return 'quitado del Sistema Financiero';
    if (!phone) return 'sin teléfono válido';
    return null;
}

// ───────── 1. Crear el envio ─────────
async function createCampaign({ db, whatsapp, condominioId, caller, data, now = () => new Date() }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.');
    }
    await requireConnected(whatsapp, config);
    await requireConfirming(whatsapp, config);
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) throw fail('invalid-argument', 'No hay a quién enviar.');
    if (items.length > MAX_RECIPIENTS) throw fail('invalid-argument', `Se pueden enviar hasta ${MAX_RECIPIENTS} mensajes a la vez.`);
    const tpl = templatesOn(whatsapp, config) ? templateOrFail(whatsapp, config, data.mode) : null;
    const texts = new Map();
    const paramsById = new Map();
    for (const item of items) {
        const id = String((item && item.residentId) || '').trim();
        let text = String((item && item.text) || '').trim();
        let params = null;
        if (tpl) {
            if (avisoMissing(tpl, item)) throw fail('invalid-argument', AVISO_MISSING);
            params = paramsOf(whatsapp, tpl, item);
            text = params ? whatsapp.renderTemplate(tpl, params).trim() : '';
        }
        if (!id || id.includes('/') || !text) throw fail('invalid-argument', tpl ? 'Hay un residente sin datos para la plantilla.' : 'Hay un mensaje sin residente o sin texto.');
        if (text.length > MAX_TEXT) throw fail('invalid-argument', `Un mensaje pasa de ${MAX_TEXT} caracteres.`);
        if (!texts.has(id)) { texts.set(id, text); if (params) paramsById.set(id, params); }
    }
    if (await hasRunning(db, condominioId)) throw fail('failed-precondition', 'Ya hay un envío en curso o en pausa. Espere a que termine, o continúelo o cancélelo.');

    // Los telefonos salen de la ficha del vecino (nunca del cliente)
    const condoRef = db.collection('condominios').doc(condominioId);
    const ids = [...texts.keys()];
    const users = [];
    const fichas = [];
    for (const part of chunks(ids, 300)) {
        users.push(...await db.getAll(...part.map((id) => condoRef.collection('usuarios').doc(id))));
        fichas.push(...await db.getAll(...part.map((id) => condoRef.collection('finanzas_residentes').doc(id))));
    }
    // El mismo mensaje al mismo telefono se manda una sola vez (un propietario con varios lotes recibia el aviso hasta 11 veces:
    // pasó en La Perla el 2026-11-16, y repetir el mismo texto tambien levanta sospechas en WhatsApp). Si el texto cambia por lote
    // (por ejemplo {saldo}), se manda cada uno.
    const seenMessages = new Set();
    const rows = ids.map((id, i) => {
        const user = users[i].exists ? users[i].data() : null;
        const ficha = fichas[i].exists ? fichas[i].data() : null;
        const phone = user ? normalizePhone(user.phone) : '';
        let reason = skipReason(user, ficha, phone);
        if (!reason) {
            const key = `${phone}|${texts.get(id)}`;
            if (seenMessages.has(key)) reason = 'mismo mensaje al mismo teléfono (ya se le manda por otro lote)';
            else seenMessages.add(key);
        }
        return {
            id,
            data: {
                name: user ? String(user.name || '') : '', casa: user ? String(user.casa || '') : '',
                phoneTail: phone ? phone.slice(-4) : '', text: texts.get(id),
                ...(paramsById.has(id) ? { params: paramsById.get(id) } : {}),
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
        pauseSeconds: AVG_PAUSE_SECONDS, sample: pending[0].data.text.slice(0, 200),
        ...(tpl ? { channel: 'meta', template: tpl.name } : {}),
        ...(data.resendOf ? { resendOf: String(data.resendOf).slice(0, 60) } : {}),
        // "Continuar con los que faltan" de OIKOS: el envio del que salen los que todavia no lo recibieron
        ...(data.continueOf ? { continueOf: String(data.continueOf).slice(0, 60) } : {})
    });
    await queueDoc(db, condominioId, campRef.id).set({ condominioId, campaignId: campRef.id, status: 'running', createdAt });
    return {
        id: campRef.id, total: rows.length, pending: pending.length, skipped: rows.length - pending.length,
        estimatedMinutes: Math.ceil((pending.length * AVG_PAUSE_SECONDS) / 60),
        // Con UltraMsg salen hasta DAILY_LIMIT por dia: un envio grande tarda dias (con Meta, el tope es de Meta)
        estimatedDays: tpl ? 1 : Math.max(1, Math.ceil(pending.length / DAILY_LIMIT)), dailyLimit: tpl ? null : DAILY_LIMIT
    };
}

// ───────── 2. Mandar (la corrida de cada minuto) ─────────
async function processCampaign(ctx) {
    const { db, whatsapp, sleep, pause, budgetMs, nowMs, started, condominioId, campaignId, queueRef, schedule } = ctx;
    const campRef = campaignsOf(db, condominioId).doc(campaignId);
    const isoNow = () => new Date(nowMs()).toISOString();

    // Tomar el turno: una sola corrida por envio
    const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(campRef);
        if (!snap.exists) return { gone: true };
        const camp = snap.data();
        if (camp.status !== 'running') return { status: camp.status };
        if ((camp.lockUntil || 0) > nowMs()) return { busy: true };
        // En espera (fuera de horario o con el tope del dia lleno): ni se toma el turno hasta su hora
        if (schedule && camp.waitingUntil && Date.parse(camp.waitingUntil) > nowMs()) return { waiting: true };
        tx.update(campRef, { lockUntil: nowMs() + LOCK_MS });
        return { ok: true, mode: camp.mode, channel: camp.channel || null, wasWaiting: !!camp.waitingUntil, counts: { pending: camp.pending || 0, sent: camp.sent || 0, failed: camp.failed || 0, skipped: camp.skipped || 0 } };
    });
    if (claimed.gone) { await queueRef.delete(); return { campaignId, gone: true }; }
    if (claimed.status) { await queueRef.set({ status: claimed.status }, { merge: true }); return { campaignId, status: claimed.status }; }
    if (claimed.busy) return { campaignId, busy: true };
    if (claimed.waiting) return { campaignId, waiting: true };

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
    // Envio cuidadoso: solo en horario y, con UltraMsg, con un tope por dia (con Meta el tope lo pone Meta)
    const capped = !!schedule && !templatesOn(whatsapp, config);
    const dayRef = (day) => condoRef.collection(DAY_COL).doc(day);
    const dayCount = async (day) => ((await dayRef(day).get()).data() || {}).count || 0;
    const toWait = async (atMs, reason) => {
        await campRef.update({ lockUntil: 0, waitingUntil: new Date(atMs).toISOString(), waitingReason: reason });
        return { campaignId, waiting: reason, until: new Date(atMs).toISOString() };
    };
    let today = gtDay(nowMs());
    let todayCount = 0;
    if (schedule) {
        const closedUntil = waitFor(nowMs(), schedule.hours);
        if (closedUntil) return toWait(closedUntil, 'horario');
    }
    if (capped) {
        todayCount = await dayCount(today);
        if (todayCount >= schedule.dailyLimit) return toWait(nextOpening(nowMs(), schedule.hours, true), 'tope');
    }
    const startConn = await connectionOf(whatsapp, config);
    if (startConn.connected === false) {
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `${connectionText(whatsapp, startConn)} Cuando esté conectado, pulse Continuar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
        return { campaignId, status: 'error', stoppedBy: 'conexion' };
    }
    const startHealth = await healthOf(whatsapp, config);
    if (startHealth.confirming === false) {
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `${healthText(whatsapp, startHealth)} Cuando la prueba llegue, pulse Continuar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
        return { campaignId, status: 'error', stoppedBy: 'restringido' };
    }
    // Con el WhatsApp oficial de Meta cada mensaje sale con la plantilla del tipo de aviso (si falta, se detiene con el motivo)
    let tpl = null;
    if (templatesOn(whatsapp, config)) {
        tpl = typeof whatsapp.templateFor === 'function' ? whatsapp.templateFor(config, claimed.mode) : null;
        if (!tpl) {
            await campRef.update({ status: 'error', lockUntil: 0, errorMessage: 'Falta la plantilla de Meta para este aviso. Pida al programador que la cargue y pulse Continuar.' });
            await queueRef.set({ status: 'error' }, { merge: true });
            return { campaignId, status: 'error', stoppedBy: 'plantilla' };
        }
        // Un envio creado con el numero anterior (UltraMsg) no trae los datos de la plantilla: seguirlo mandaria texto libre por
        // UltraMsg (el numero que WhatsApp restringe). Se detiene: OIKOS crea uno nuevo solo con los que faltan
        if (claimed.channel !== 'meta') {
            await campRef.update({ status: 'error', lockUntil: 0, errorMessage: OLD_CHANNEL });
            await queueRef.set({ status: 'error' }, { merge: true });
            return { campaignId, status: 'error', stoppedBy: 'canal' };
        }
    }

    if (claimed.wasWaiting) await campRef.update({ waitingUntil: null, waitingReason: null });
    let sent = 0; let failed = 0; let streak = 0; let sinceCheck = 0; let lostConn = null; let lostHealth = null; let finished = false; let stoppedBy = null;
    let waitAt = null;
    outer: for (;;) {
        const page = await campRef.collection('destinatarios').where('status', '==', 'pending').limit(20).get();
        if (page.empty) { finished = true; break; }
        for (const doc of page.docs) {
            if (nowMs() - started >= budgetMs) { stoppedBy = 'tiempo'; break outer; }
            // El estado se mira antes de CADA mensaje: pausar o cancelar detiene el envio en cuanto sale el que esta en curso
            const current = await campRef.get();
            if (!current.exists || current.data().status !== 'running') { stoppedBy = 'estado'; break outer; }
            // Se acabo el horario o el tope del dia: el envio queda en espera y sigue solo a su hora
            if (schedule) {
                const closedUntil = waitFor(nowMs(), schedule.hours);
                if (closedUntil) { waitAt = closedUntil; stoppedBy = 'horario'; break outer; }
                if (capped && gtDay(nowMs()) !== today) { today = gtDay(nowMs()); todayCount = await dayCount(today); }
                if (capped && todayCount >= schedule.dailyLimit) { waitAt = nextOpening(nowMs(), schedule.hours, true); stoppedBy = 'tope'; break outer; }
            }
            if (sinceCheck >= CONN_CHECK_EVERY) {
                sinceCheck = 0;
                const conn = await connectionOf(whatsapp, config);
                if (conn.connected === false) { lostConn = conn; stoppedBy = 'conexion'; break outer; }
                // Los mensajes de esta misma corrida cuentan cuando pasan 3 minutos sin palomita: asi, con el numero restringido,
                // el envio se detiene tras unos 30 mensajes en vez de seguir con cientos
                const h = await healthOf(whatsapp, config);
                if (h.confirming === false) { lostHealth = h; stoppedBy = 'restringido'; break outer; }
            }
            const user = await condoRef.collection('usuarios').doc(doc.id).get();
            const phone = user.exists && user.data().active !== false ? normalizePhone(user.data().phone) : '';
            if (!phone) {
                await doc.ref.update({ status: 'skipped', reason: 'sin teléfono válido' });
                await bump('skipped');
                continue;
            }
            await doc.ref.update({ status: 'sending', startedAt: isoNow() });
            sinceCheck++;
            let channel = null;
            let error = null;
            const sendErrors = [];
            const sendOpts = tpl && doc.data().params ? { template: tpl, params: doc.data().params, errors: sendErrors } : { errors: sendErrors };
            try { channel = await whatsapp.send(config, phone, doc.data().text, sendOpts); } catch (e) { error = e && e.message ? e.message : 'error'; }
            if (channel) {
                await doc.ref.update({ status: 'sent', channel, sentAt: isoNow() });
                await bump('sent');
                sent++; streak = 0;
                if (capped) {
                    todayCount++;
                    await dayRef(today).set({ day: today, count: todayCount, updatedAt: isoNow() }, { merge: true });
                }
            } else {
                await doc.ref.update({ status: 'failed', error: error || sendErrors.join('; ') || 'No salió por ningún proveedor de WhatsApp' });
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
    } else if (stoppedBy === 'conexion') {
        await recount(campRef);
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `${connectionText(whatsapp, lostConn)} Cuando esté conectado, pulse Continuar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
    } else if (stoppedBy === 'restringido') {
        await recount(campRef);
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `${healthText(whatsapp, lostHealth)} Cuando la prueba llegue, pulse Continuar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
    } else if (stoppedBy === 'horario' || stoppedBy === 'tope') {
        await campRef.update({ lockUntil: 0, waitingUntil: new Date(waitAt).toISOString(), waitingReason: stoppedBy });
    } else if (stoppedBy === 'fallos') {
        await recount(campRef);
        await campRef.update({ status: 'error', lockUntil: 0, errorMessage: `WhatsApp no está respondiendo (${FAIL_STREAK} fallos seguidos). Revise la conexión de UltraMsg y use Reanudar.` });
        await queueRef.set({ status: 'error' }, { merge: true });
    } else {
        await campRef.update({ lockUntil: 0 });
    }
    return { campaignId, sent, failed, finished, stoppedBy };
}

async function processQueue({ db, whatsapp, sleep = realSleep, pause = randomPause, budgetMs = RUN_BUDGET_MS, nowMs = () => Date.now(), schedule = SCHEDULE }) {
    const started = nowMs();
    const queued = await db.collection(QUEUE).where('status', '==', 'running').get();
    const results = [];
    for (const doc of queued.docs) {
        if (nowMs() - started >= budgetMs) break;
        const { condominioId, campaignId } = doc.data();
        results.push(await processCampaign({ db, whatsapp, sleep, pause, budgetMs, nowMs, started, condominioId, campaignId, queueRef: doc.ref, schedule }));
    }
    return results;
}

// ───────── 3. Pausar, continuar, cancelar, reintentar ─────────
// Ni pausar ni cancelar tocan lockUntil: lo suelta la corrida que esta mandando cuando ve el cambio (si se soltara aqui,
// un "continuar" enseguida dejaria que otra corrida mande a la vez que la anterior y se repetirian mensajes).
async function controlCampaign({ db, condominioId, data, whatsapp, now = () => new Date() }) {
    const campaignId = String((data && data.campaignId) || '').trim();
    if (!campaignId || campaignId.includes('/')) throw fail('invalid-argument', 'Envío inválido.');
    const campRef = campaignsOf(db, condominioId).doc(campaignId);
    const snap = await campRef.get();
    if (!snap.exists) throw fail('not-found', 'El envío no existe.');
    const camp = snap.data();
    const queueRef = queueDoc(db, condominioId, campaignId);
    const action = data && data.action;
    const iso = now().toISOString();

    if (action === 'pause') {
        if (camp.status !== 'running') throw fail('failed-precondition', 'Ese envío no está en curso.');
        await campRef.update({ status: 'paused', pausedAt: iso });
        await queueRef.set({ condominioId, campaignId, status: 'paused' }, { merge: true });
        return { status: 'paused' };
    }
    if (action === 'cancel') {
        if (camp.status !== 'running' && camp.status !== 'paused' && camp.status !== 'error') throw fail('failed-precondition', 'Ese envío ya no está en curso.');
        await campRef.update({ status: 'canceled', canceledAt: iso });
        await queueRef.set({ condominioId, campaignId, status: 'canceled' }, { merge: true });
        return { status: 'canceled' };
    }
    if (action === 'resume' || action === 'retry') {
        if (camp.status === 'running') throw fail('failed-precondition', 'Ese envío ya está en curso.');
        // Continuar con WhatsApp desconectado solo dejaria mas mensajes en la cola de UltraMsg; con el numero restringido, sin palomita
        if (whatsapp) {
            const config = await whatsapp.loadConfig();
            if (templatesOn(whatsapp, config) && camp.channel !== 'meta') throw fail('failed-precondition', OLD_CHANNEL);
            await requireConnected(whatsapp, config);
            await requireConfirming(whatsapp, config);
        }
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
        await campRef.update({ status: 'running', errorMessage: null, finishedAt: null, pausedAt: null, resumedAt: iso });
        await queueRef.set({ condominioId, campaignId, status: 'running', createdAt: iso }, { merge: true });
        return { status: 'running', pending: counts.pending };
    }
    throw fail('invalid-argument', 'Acción inválida.');
}

// ───────── 3b. Enviar a UN residente, al instante ─────────
// El boton Enviar de cada residente y Contactar. No pasa por la cola ni por la pausa: sale ya. El telefono sale de la
// ficha del vecino (nunca del cliente). Queda anotado en condominios/{c}/recordatorios_individuales (solo lo escribe
// el servidor): quien, cuando, a quien y el texto.
async function sendOne({ db, whatsapp, condominioId, caller, data, verify = {}, now = () => new Date() }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.');
    await requireConnected(whatsapp, config);
    await requireConfirming(whatsapp, config);
    const residentId = String((data && data.residentId) || '').trim();
    const tpl = templatesOn(whatsapp, config) ? templateOrFail(whatsapp, config, data && data.mode) : null;
    if (tpl && avisoMissing(tpl, data)) throw fail('invalid-argument', AVISO_MISSING);
    const params = tpl ? paramsOf(whatsapp, tpl, data) : null;
    if (tpl && !params) throw fail('invalid-argument', 'Faltan los datos del residente para la plantilla.');
    const text = tpl ? whatsapp.renderTemplate(tpl, params).trim() : String((data && data.text) || '').trim();
    if (!residentId || residentId.includes('/')) throw fail('invalid-argument', 'Residente inválido.');
    if (!text || text.length > MAX_TEXT) throw fail('invalid-argument', `El mensaje debe tener entre 1 y ${MAX_TEXT} caracteres.`);
    const condoRef = db.collection('condominios').doc(condominioId);
    const [userSnap, fichaSnap] = await Promise.all([
        condoRef.collection('usuarios').doc(residentId).get(),
        condoRef.collection('finanzas_residentes').doc(residentId).get()
    ]);
    const user = userSnap.exists ? userSnap.data() : null;
    const phone = user ? normalizePhone(user.phone) : '';
    const reason = skipReason(user, fichaSnap.exists ? fichaSnap.data() : null, phone);
    if (reason) throw fail('failed-precondition', `No se le puede enviar: ${reason}.`);
    let channel = null;
    let error = null;
    const startedMs = now().getTime();
    const sendErrors = [];
    try { channel = await whatsapp.send(config, phone, text, tpl ? { template: tpl, params, errors: sendErrors } : { errors: sendErrors }); } catch (e) { error = e && e.message ? e.message : 'error'; }
    // "Enviado" solo dice que UltraMsg lo acepto: se mira que paso de verdad (en cola, rechazado por WhatsApp, entregado...)
    const delivery = channel ? await verifyDelivery({ whatsapp, config, phone, sinceMs: startedMs, ...verify }) : null;
    await condoRef.collection('recordatorios_individuales').doc().set({
        at: now().toISOString(), by: { id: caller.id, name: String(caller.name || '') }, residentId,
        name: String(user.name || ''), casa: String(user.casa || ''), phoneTail: phone.slice(-4), text,
        mode: data.mode === 'varios' ? 'varios' : 'mora', status: channel ? 'sent' : 'failed', channel: channel || null,
        ...(tpl ? { template: tpl.name } : {}),
        delivery: delivery ? delivery.state : null, ...(delivery && delivery.reason ? { deliveryReason: delivery.reason } : {}),
        ...(channel ? {} : { error: error || sendErrors.join('; ') || 'No salió por ningún proveedor de WhatsApp' })
    });
    return {
        sent: !!channel, channel: channel || null, phoneTail: phone.slice(-4), name: String(user.name || ''), casa: String(user.casa || ''),
        ...(channel ? {} : { error: error || sendErrors.join('; ') || '' }),
        delivery: delivery ? delivery.state : null, deliveryReason: delivery ? delivery.reason : '', deliveryText: delivery && delivery.state === 'rechazado' ? reasonText(whatsapp, delivery.reason) : ''
    };
}

// ───────── 3c. Enviar al vecino SU clave de acceso a garita.app (pedido del usuario el 2026-11-20) ─────────
// "Enviar clave de acceso" del menu de cada residente de OIKOS, desde el numero del condominio. El texto lo arma el SERVIDOR con la
// clave que el mismo lee de `codigos`: el navegador no la manda ni la recibe, y en recordatorios_individuales (que lee todo el que
// tiene el privilegio de recordatorios, vea o no las claves) queda anotado QUE se envio la clave, nunca la clave. Solo a vecinos
// (la clave de un guardia o un administrador no se manda por aqui). El telefono sale de su ficha. Con el WhatsApp oficial de Meta
// no sale: Meta solo deja mandar texto libre hasta 24 horas despues de que el vecino escribio (para eso esta Mi WhatsApp).
const ACCESS_URL = 'https://garita.app/';
// El mismo texto que arma OIKOS para "Enviar desde mi WhatsApp" (accessCodeMessage de finanzas/index.html)
function accessCodeText({ name, code, condoName }) {
    return [
        `Hola ${String(name || '').trim()},`,
        `su clave de acceso a garita.app${condoName ? ` (${condoName})` : ''} es: ${code}`,
        '',
        `Para entrar abra ${ACCESS_URL} y escriba su clave. Ahí registra sus visitas, ve su marbete y tiene su botón de pánico.`,
        '',
        // Texto del cierre pedido por el usuario el 2026-11-21 (el mismo en accessCodeMessage de OIKOS)
        'Favor guarde y no comparta su clave. ESTA APLICACIÓN SERÁ DE GRAN UTILIDAD PARA EL TEMA DE SEGURIDAD, YA QUE AL PRESIONAR EL BOTÓN DE PÁNICO EL MENSAJE LLEGARÁ A GARITA, A PNC Y A 5 FAMILIARES PREVIAMENTE CONFIGURADOS.'
    ].join('\n');
}
async function sendAccessCode({ db, whatsapp, condominioId, caller, data, verify = {}, now = () => new Date() }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.');
    if (templatesOn(whatsapp, config)) {
        throw fail('failed-precondition', 'Con el WhatsApp oficial (Meta) solo salen mensajes con plantilla aprobada: envíe la clave con «Enviar desde mi WhatsApp».');
    }
    await requireConnected(whatsapp, config);
    await requireConfirming(whatsapp, config);
    const residentId = String((data && data.residentId) || '').trim();
    if (!residentId || residentId.includes('/')) throw fail('invalid-argument', 'Residente inválido.');
    const condoRef = db.collection('condominios').doc(condominioId);
    const [condoSnap, userSnap, fichaSnap, codesSnap] = await Promise.all([
        condoRef.get(),
        condoRef.collection('usuarios').doc(residentId).get(),
        condoRef.collection('finanzas_residentes').doc(residentId).get(),
        db.collection('codigos').where('userId', '==', residentId).get()
    ]);
    const user = userSnap.exists ? userSnap.data() : null;
    const phone = user ? normalizePhone(user.phone) : '';
    const reason = skipReason(user, fichaSnap.exists ? fichaSnap.data() : null, phone);
    if (reason) throw fail('failed-precondition', `No se le puede enviar: ${reason}.`);
    const codes = codesSnap.docs.filter((d) => d.data().condominioId === condominioId)
        .sort((a, b) => String(b.data().createdAt || '').localeCompare(String(a.data().createdAt || '')));
    const code = codes.length ? codes[0].id : '';
    if (!code) throw fail('failed-precondition', 'Este vecino no tiene clave de acceso. Créela en su ficha antes de enviarla.');
    const condoName = condoSnap.exists ? String(condoSnap.data().name || '') : '';
    const text = accessCodeText({ name: user.name, code, condoName });
    let channel = null;
    let error = null;
    const startedMs = now().getTime();
    const sendErrors = [];
    try { channel = await whatsapp.send(config, phone, text, { errors: sendErrors }); } catch (e) { error = e && e.message ? e.message : 'error'; }
    const delivery = channel ? await verifyDelivery({ whatsapp, config, phone, sinceMs: startedMs, ...verify }) : null;
    // Lo que queda anotado: quien, cuando, a quien y que fue la clave de acceso; la clave NO
    await condoRef.collection('recordatorios_individuales').doc().set({
        at: now().toISOString(), by: { id: caller.id, name: String(caller.name || '') }, residentId,
        name: String(user.name || ''), casa: String(user.casa || ''), phoneTail: phone.slice(-4),
        text: 'Clave de acceso a garita.app (la clave no se guarda)', mode: 'clave', status: channel ? 'sent' : 'failed', channel: channel || null,
        delivery: delivery ? delivery.state : null, ...(delivery && delivery.reason ? { deliveryReason: delivery.reason } : {}),
        ...(channel ? {} : { error: error || sendErrors.join('; ') || 'No salió por ningún proveedor de WhatsApp' })
    });
    return {
        sent: !!channel, channel: channel || null, phoneTail: phone.slice(-4), name: String(user.name || ''), casa: String(user.casa || ''),
        ...(channel ? {} : { error: error || sendErrors.join('; ') || '' }),
        delivery: delivery ? delivery.state : null, deliveryReason: delivery ? delivery.reason : '', deliveryText: delivery && delivery.state === 'rechazado' ? reasonText(whatsapp, delivery.reason) : ''
    };
}

// ───────── 4. Mensaje de prueba ─────────
async function sendTest({ whatsapp, data, verify = {} }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) throw fail('failed-precondition', 'WhatsApp todavía no está conectado al condominio.');
    await requireConnected(whatsapp, config);
    const phone = normalizePhone(data && data.phone);
    if (!phone) throw fail('invalid-argument', 'Escriba el teléfono completo (8 dígitos de Guatemala o con código de país).');
    const tpl = templatesOn(whatsapp, config) ? templateOrFail(whatsapp, config, data && data.mode) : null;
    if (tpl && avisoMissing(tpl, data)) throw fail('invalid-argument', AVISO_MISSING);
    const params = tpl ? paramsOf(whatsapp, tpl, data) : null;
    if (tpl && !params) throw fail('invalid-argument', 'Faltan los datos de ejemplo para la plantilla.');
    const text = tpl ? whatsapp.renderTemplate(tpl, params).trim() : String((data && data.text) || '').trim();
    if (!text || text.length > MAX_TEXT) throw fail('invalid-argument', `El mensaje debe tener entre 1 y ${MAX_TEXT} caracteres.`);
    const startedMs = Date.now();
    const sendErrors = [];
    const channel = await whatsapp.send(config, phone, text, tpl ? { template: tpl, params, errors: sendErrors } : { errors: sendErrors });
    const delivery = channel ? await verifyDelivery({ whatsapp, config, phone, sinceMs: startedMs, ...verify }) : null;
    return {
        sent: !!channel, channel: channel || null, phoneTail: phone.slice(-4), ...(channel ? {} : { error: sendErrors.join('; ') }),
        delivery: delivery ? delivery.state : null, deliveryReason: delivery ? delivery.reason : '', deliveryText: delivery && delivery.state === 'rechazado' ? reasonText(whatsapp, delivery.reason) : ''
    };
}

// ───────── 5. Estado de la conexion (lo que muestra OIKOS arriba de los botones de enviar) ─────────
async function connectionInfo({ whatsapp }) {
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        return { configured: false, connected: false, state: 'sin-configurar', message: 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.', queue: null };
    }
    const conn = await connectionOf(whatsapp, config);
    let queue = null;
    if (typeof whatsapp.queueStats === 'function') { try { queue = await whatsapp.queueStats(config); } catch (e) { queue = null; } }
    // Conectado, pero ¿salen los mensajes? (numero restringido por WhatsApp: ver healthOf)
    const health = conn.connected === false ? { confirming: null } : await healthOf(whatsapp, config);
    // Con Meta: las plantillas (para mostrar el texto y saber que dato va en cada hueco) y la calidad del numero
    const onMeta = templatesOn(whatsapp, config);
    const templates = onMeta && typeof whatsapp.templateFor === 'function'
        ? { mora: whatsapp.templateFor(config, 'mora'), general: whatsapp.templateFor(config, 'varios') }
        : null;
    return {
        configured: true, connected: conn.connected, state: conn.state, provider: conn.provider || null,
        channel: onMeta ? 'meta' : 'ultramsg', templates,
        ...(onMeta ? { meta: { quality: conn.quality || '', name: conn.name || '', number: conn.number || '' } } : {}),
        message: conn.connected === false ? connectionText(whatsapp, conn) : '', queue,
        confirming: health.confirming === undefined ? null : health.confirming,
        healthMessage: health.confirming === false ? healthText(whatsapp, health) : ''
    };
}

// ───────── 6. Comprobar que llego de verdad y reenviar solo a los que no recibieron ─────────
// Motivo con que UltraMsg rechaza un numero que no tiene WhatsApp o esta mal escrito (ultramsg-estado.js, classify): es definitivo
const NO_WHATSAPP = 'invalid';
// Pregunta a UltraMsg que paso con cada mensaje aceptado de un envio y lo anota en cada destinatario (`delivery`: entregado,
// enviado, pendiente, en_cola, rechazado o desconocido) y en el envio (`delivery`: los totales y `resend`, a cuantos se les
// puede reenviar). Los mensajes se enlazan por telefono y hora (un propietario con varios lotes recibe varios).
async function reconcileCampaign({ db, whatsapp, condominioId, campaignId, now = () => new Date() }) {
    const id = String(campaignId || '').trim();
    if (!id || id.includes('/')) throw fail('invalid-argument', 'Envío inválido.');
    const campRef = campaignsOf(db, condominioId).doc(id);
    const snap = await campRef.get();
    if (!snap.exists) throw fail('not-found', 'El envío no existe.');
    const camp = snap.data();
    const config = await whatsapp.loadConfig();
    if (templatesOn(whatsapp, config)) {
        throw fail('failed-precondition', 'Con el WhatsApp oficial de Meta el resultado de cada mensaje llega por el webhook de Meta, que todavía no está conectado a OIKOS.');
    }
    if (typeof whatsapp.listMessages !== 'function' || !config || config.provider === 'simulado' || !config.ultramsgInstance) {
        throw fail('failed-precondition', 'La comprobación de entregas solo está disponible con UltraMsg.');
    }
    const createdMs = Date.parse(camp.createdAt) || 0;
    const rows = await whatsapp.listMessages(config, { sinceSec: Math.floor(createdMs / 1000) - 600, maxPages: 15 });
    if (!rows) throw fail('unavailable', 'No se pudo leer el estado de los mensajes en UltraMsg. Intente de nuevo en un momento.');

    const destRef = campRef.collection('destinatarios');
    const all = (await destRef.get()).docs;
    const accepted = all.filter((d) => d.data().status === 'sent' && d.data().sentAt);
    const condoRef = db.collection('condominios').doc(condominioId);
    const phones = new Map();
    for (const part of chunks(accepted, 300)) {
        const users = await db.getAll(...part.map((d) => condoRef.collection('usuarios').doc(d.id)));
        users.forEach((u, i) => phones.set(part[i].id, u.exists ? normalizePhone(u.data().phone) : ''));
    }
    const matched = whatsapp.matchCampaign(rows, accepted.map((d) => ({ id: d.id, phone: phones.get(d.id), sentAtMs: Date.parse(d.data().sentAt) })));
    const totals = { entregado: 0, enviado: 0, pendiente: 0, en_cola: 0, rechazado: 0, desconocido: 0, sinEnviar: 0 };
    const reasons = {};
    let noWhatsapp = 0;
    const checkedAt = now().toISOString();
    const updates = [];
    for (const d of accepted) {
        const result = whatsapp.classify(matched.get(d.id));
        totals[result.state] = (totals[result.state] || 0) + 1;
        if (result.state === 'rechazado') {
            reasons[result.reason] = (reasons[result.reason] || 0) + 1;
            if (result.reason === NO_WHATSAPP) noWhatsapp++;
        }
        updates.push([d.ref, { delivery: result.state, deliveryReason: result.reason || null, deliveryCheckedAt: checkedAt }]);
    }
    for (const d of all) {
        const status = d.data().status;
        if (status === 'failed' || status === 'pending') {
            totals.sinEnviar++;
            updates.push([d.ref, { delivery: 'sin_enviar', deliveryReason: null, deliveryCheckedAt: checkedAt }]);
        }
    }
    for (const part of chunks(updates, BATCH)) {
        const batch = db.batch();
        part.forEach(([ref, fields]) => batch.update(ref, fields));
        await batch.commit();
    }
    // A un numero sin WhatsApp no se le reenvia: no sirve hasta que se corrija su telefono (se cuenta aparte, en noWhatsapp)
    const summary = { ...totals, noWhatsapp, resend: totals.rechazado - noWhatsapp + totals.desconocido + totals.sinEnviar, reasons, checkedAt };
    await campRef.update({ delivery: summary });
    return summary;
}

// Manda de nuevo SOLO a los que no recibieron (rechazados por WhatsApp, sin rastro en UltraMsg o que nunca se aceptaron), con el
// mismo texto que ya tenian. Crea un envio nuevo (con las mismas revisiones: conexion, uno a la vez, un mensaje por telefono).
async function resendCampaign({ db, whatsapp, condominioId, caller, data }) {
    const sourceId = String((data && data.campaignId) || '').trim();
    if (!sourceId || sourceId.includes('/')) throw fail('invalid-argument', 'Envío inválido.');
    const campRef = campaignsOf(db, condominioId).doc(sourceId);
    const snap = await campRef.get();
    if (!snap.exists) throw fail('not-found', 'El envío no existe.');
    const camp = snap.data();
    if (camp.status === 'running') throw fail('failed-precondition', 'Ese envío sigue en curso. Páuselo o espere a que termine.');
    if (!camp.delivery) throw fail('failed-precondition', 'Primero pulse "Comprobar entregas" para saber a quiénes les llegó.');
    const dests = (await campRef.collection('destinatarios').get()).docs;
    // Los rechazados porque su numero no tiene WhatsApp (invalid) no se reenvian: volverian a rebotar hasta que se corrija su telefono
    const noWa = (x) => x.delivery === 'rechazado' && x.deliveryReason === NO_WHATSAPP;
    const items = dests
        .filter((d) => { const x = d.data(); return x.status !== 'skipped' && !noWa(x) && (x.delivery === 'rechazado' || x.delivery === 'desconocido' || x.delivery === 'sin_enviar'); })
        .map((d) => ({ residentId: d.id, text: d.data().text, ...(Array.isArray(d.data().params) ? { params: d.data().params } : {}) }));
    if (!items.length) {
        const withoutWhatsapp = dests.filter((d) => d.data().status !== 'skipped' && noWa(d.data())).length;
        throw fail('failed-precondition', withoutWhatsapp
            ? `No hay a quién reenviar: a los demás les llegó o siguen en proceso, y ${withoutWhatsapp} tienen un número sin WhatsApp (reenviarles no sirve): corrija su teléfono en su ficha.`
            : 'No hay a quién reenviar: a todos les llegó o siguen en proceso.');
    }
    return createCampaign({ db, whatsapp, condominioId, caller, data: { mode: camp.mode, items, resendOf: sourceId } });
}

module.exports = {
    CONN_CHECK_EVERY, connectionInfo, verifyDelivery, reconcileCampaign, resendCampaign,
    MAX_RECIPIENTS, MAX_TEXT, PAUSE_MIN_MS, PAUSE_MAX_MS, AVG_PAUSE_SECONDS, RUN_BUDGET_MS, LOCK_MS, FAIL_STREAK,
    SEND_HOURS, DAILY_LIMIT, SCHEDULE, DAY_COL, gtDay, waitFor, nextOpening,
    fail, recount, createCampaign, processQueue, processCampaign, controlCampaign, sendOne, sendTest, sendAccessCode, accessCodeText, ACCESS_URL
};
