// Chat de WhatsApp con los residentes (OIKOS > Chats WhatsApp; pedido del dueno el 2026-11-17).
// Logica sin firebase: la base (Firestore de admin) y el proveedor de WhatsApp entran por parametro, asi se prueba con
// el emulador y un WhatsApp de mentira (scripts/test-whatsapp-chat.mjs). Las funciones estan en whatsapp-chat.js.
//
// Como funciona:
//   - UltraMsg avisa al servidor (webhook) de cada mensaje que entra (message_received), de cada mensaje que sale del
//     numero, desde SISDEL, desde los recordatorios o desde el telefono (message_create), y de cada palomita (message_ack:
//     enviado, entregado, leido). El aviso trae una clave secreta (_privado/whatsapp.webhookToken) que pone
//     scripts/whatsapp-webhook.mjs al activarlo.
//   - Cada telefono se busca entre los usuarios de todos los condominios (normalizePhone, el mismo de los recordatorios):
//     el chat se guarda en condominios/{c}/whatsapp_chats/{telefono} con sus mensajes en wa_mensajes. Un telefono que no
//     es de nadie queda en whatsapp_sin_asignar (solo el master lo lee). Nada se borra.
//   - Con el WhatsApp OFICIAL de Meta (Cloud API) el aviso llega al mismo lugar con otro formato (parseMeta): mensajes que
//     entran y palomitas (sent, delivered, read, failed); Meta firma cada aviso con la clave de la aplicacion (lo verifica
//     whatsapp-chat.js). Cada chat recuerda por que canal escribio el residente (channel: 'meta' o 'ultramsg') y se le
//     contesta por ese. Por Meta un mensaje libre solo se puede mandar hasta 24 horas despues del ultimo mensaje del
//     residente (WINDOW_MS); despues, solo con plantilla aprobada (Recordatorios). Las palomitas de mensajes que no estan en
//     ningun chat (p. ej. los recordatorios con plantilla) quedan en whatsapp_estados/{id} para quien los quiera seguir.
//   - Contestar: OIKOS manda el texto y el chat (o el residente); el servidor toma el telefono del chat o de la ficha del
//     residente, nunca uno que mande el navegador: asi nadie usa el numero del condominio para escribir a cualquiera.
//     El mensaje se guarda "en cola" antes de enviarlo y, cuando UltraMsg avisa que salio, se le pone su id de WhatsApp
//     (por la referencia que se le manda, o por el mismo texto al mismo telefono) y sus palomitas.
const { normalizePhone } = require('./rondas/avisos');

const MAX_TEXT = 4096;
const INDEX_TTL_MS = 5 * 60 * 1000;
const MATCH_WINDOW_MS = 30 * 60 * 1000;   // un mensaje enviado desde SISDEL se reconoce en el aviso hasta 30 min despues
const HISTORY_LIMIT = 60;
const WINDOW_MS = 24 * 60 * 60 * 1000;   // Meta: mensaje libre solo hasta 24 h despues del ultimo mensaje del residente
const META_ACK = { sent: 'server', delivered: 'device', read: 'read', failed: 'failed' };
// Orden de las palomitas: nunca se baja (un aviso viejo que llega tarde no quita el "leido")
const ACK_RANK = { failed: -1, '': 0, pending: 0, server: 1, device: 2, read: 3, played: 4 };
const ACKS = new Set(['pending', 'server', 'device', 'read', 'played', 'failed']);

function fail(code, message) {
    return Object.assign(new Error(message), { userCode: code });
}

const text = (value, max) => String(value == null ? '' : value).slice(0, max);
const isoOf = (seconds, fallback) => {
    const n = Number(seconds);
    if (Number.isFinite(n) && n > 1e9) return new Date((n > 1e12 ? n : n * 1000)).toISOString();
    return fallback;
};
function normAck(value) {
    const v = String(value == null ? '' : value).toLowerCase();
    if (ACKS.has(v)) return v;
    if (v === 'error' || v === 'failed' || v === '-1') return 'failed';
    return '';
}
const ackRank = (a) => (a in ACK_RANK ? ACK_RANK[a] : 0);
// Una palomita nueva vale si sube; "fallo" vale sobre en cola o enviado (no sobre entregado o leido, ni sobre otro fallo)
const ackImproves = (prev, next) => (next === 'failed' ? prev !== 'failed' && ackRank(prev) < ACK_RANK.device : ackRank(next) > ackRank(prev));
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u).slice(0, 2000) : '');

// Telefono de un id de WhatsApp ('50255551234@c.us'). Grupos (@g.us), difusiones y estados no son chats de un residente.
function phoneOfJid(jid) {
    const s = String(jid || '').trim();
    if (!/@(c\.us|s\.whatsapp\.net)$/i.test(s)) return '';
    return normalizePhone(s.split('@')[0]);
}

// Id de documento a partir del id de WhatsApp (no puede llevar '/')
function docIdOf(waId) {
    const id = String(waId || '').replace(/\//g, '_').slice(0, 300);
    return id && id !== '.' && id !== '..' ? id : '';
}

// Huella de un mensaje enviado (telefono + texto): con ella se reconoce en el aviso de UltraMsg si no trae la referencia
function matchKeyOf(phone, body) {
    let h = 0x811c9dc5;
    const s = `${phone}|${String(body || '').trim()}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${phone}-${h.toString(16)}`;
}

// Un aviso de UltraMsg -> { kind: 'message' | 'ack' | 'ignore', ... }. UltraMsg manda
// { event_type, instanceId, data: { id, from, to, pushname, type, body, media, fromMe, ack, time } }.
function parseWebhook(body, nowIso) {
    const b = body && typeof body === 'object' ? body : {};
    const type = String(b.event_type || b.eventType || '');
    const d = b.data && typeof b.data === 'object' ? b.data : {};
    const fromMe = d.fromMe === true || d.fromMe === 'true';
    const phone = phoneOfJid(fromMe ? d.to : d.from);
    const id = text(d.id, 300);
    const instanceId = String(b.instanceId || '');
    if (type === 'message_ack') return { kind: 'ack', channel: 'ultramsg', instanceId, id, phone, fromMe, ack: normAck(d.ack) };
    if (type !== 'message_received' && type !== 'message_create') return { kind: 'ignore', instanceId, type };
    return {
        kind: 'message', channel: 'ultramsg', instanceId, id, phone, fromMe,
        type: text(d.type || 'chat', 30), body: text(d.body, MAX_TEXT), media: safeUrl(d.media), fileName: text(d.filename || d.fileName, 200),
        pushname: text(d.pushname, 100), at: isoOf(d.time != null ? d.time : d.timestamp, nowIso), ack: normAck(d.ack) || (fromMe ? 'server' : ''),
        referenceId: text(b.referenceId || d.referenceId, 100)
    };
}

// Un aviso de Meta (Cloud API) -> lista de eventos (un aviso puede traer varios mensajes y palomitas).
// { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts, messages, statuses } }] }] }
// Los archivos de Meta no traen enlace (se piden con la clave): se guarda su id y el texto que los acompana.
function parseMeta(body, nowIso) {
    const events = [];
    const entries = body && Array.isArray(body.entry) ? body.entry : [];
    entries.forEach((entry) => (Array.isArray(entry && entry.changes) ? entry.changes : []).forEach((change) => {
        if (!change || change.field !== 'messages') return;
        const v = change.value || {};
        const names = new Map((Array.isArray(v.contacts) ? v.contacts : []).map((c) => [String(c && c.wa_id || ''), String(c && c.profile && c.profile.name || '')]));
        (Array.isArray(v.messages) ? v.messages : []).forEach((m) => {
            if (!m || !m.id) return;
            const t = String(m.type || 'text');
            let type = t;
            let msgBody = '';
            let mediaId = '';
            let fileName = '';
            if (t === 'text') { type = 'chat'; msgBody = m.text && m.text.body; }
            else if (['image', 'video', 'audio', 'document', 'sticker'].includes(t)) {
                const o = m[t] || {};
                msgBody = o.caption || '';
                mediaId = o.id || '';
                fileName = o.filename || '';
                if (t === 'audio' && o.voice) type = 'ptt';
            } else if (t === 'button') { type = 'chat'; msgBody = m.button && m.button.text; }
            else if (t === 'interactive') { type = 'chat'; const i = m.interactive || {}; msgBody = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || ''; }
            else if (t === 'location') { const l = m.location || {}; msgBody = [l.name, l.address].filter(Boolean).join(' · ') || `${l.latitude}, ${l.longitude}`; }
            else if (t === 'reaction') { msgBody = (m.reaction && m.reaction.emoji) || ''; }
            else if (t === 'contacts') type = 'vcard';
            events.push({
                kind: 'message', channel: 'meta', id: text(m.id, 300), phone: normalizePhone(m.from), fromMe: false, type: text(type, 30),
                body: text(msgBody, MAX_TEXT), media: '', mediaId: text(mediaId, 200), fileName: text(fileName, 200),
                pushname: text(names.get(String(m.from)) || '', 100), at: isoOf(m.timestamp, nowIso), ack: '', referenceId: ''
            });
        });
        (Array.isArray(v.statuses) ? v.statuses : []).forEach((st) => {
            if (!st || !st.id || !META_ACK[st.status]) return;
            const e = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
            events.push({
                kind: 'ack', channel: 'meta', id: text(st.id, 300), phone: normalizePhone(st.recipient_id), fromMe: true, ack: META_ACK[st.status],
                at: isoOf(st.timestamp, nowIso), error: e ? text(e.title || e.message || `error ${e.code}`, 200) : ''
            });
        });
    }));
    return events;
}
const isMeta = (body) => !!(body && body.object === 'whatsapp_business_account');

// ── Telefonos de todos los usuarios: telefono -> [{ condoId, userId, name, unit, role }] ──
async function buildPhoneIndex(db) {
    const index = new Map();
    const condos = await db.collection('condominios').get();
    for (const condo of condos.docs) {
        const users = await condo.ref.collection('usuarios').get();
        users.docs.forEach((u) => {
            const data = u.data();
            const phone = normalizePhone(data.phone);
            if (!phone) return;
            if (!index.has(phone)) index.set(phone, []);
            index.get(phone).push({ condoId: condo.id, userId: u.id, name: String(data.name || ''), unit: String(data.casa || ''), role: String(data.role || '') });
        });
    }
    return index;
}
// Cache del indice (se rehace cada 5 minutos o cuando un telefono no aparece y paso al menos un minuto)
let cached = { at: 0, index: null };
async function phoneIndex(db, { now = Date.now(), force = false } = {}) {
    if (!force && cached.index && now - cached.at < INDEX_TTL_MS) return cached.index;
    cached = { at: now, index: await buildPhoneIndex(db) };
    return cached.index;
}
async function matchesFor(db, phone, now = Date.now()) {
    let found = (await phoneIndex(db, { now })).get(phone);
    if (!found && now - cached.at > 60 * 1000) found = (await phoneIndex(db, { now, force: true })).get(phone);
    return found || [];
}

// Datos del chat que salen de los residentes con ese telefono en un condominio
function chatPeople(matches) {
    return {
        residentIds: matches.map((m) => m.userId),
        names: matches.map((m) => m.name).filter(Boolean),
        units: matches.map((m) => m.unit).filter(Boolean),
        roles: Array.from(new Set(matches.map((m) => m.role).filter(Boolean)))
    };
}

// Resumen del ultimo mensaje para la lista de chats
const lastOf = (m) => ({ id: m.waId || m.ref || '', text: text(m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : ''), 160), fromMe: !!m.fromMe, type: m.type || 'chat', ack: m.ack || '', at: m.at });

// ── Guardar un mensaje (entrante o saliente) en el chat de un condominio (o en whatsapp_sin_asignar) ──
// source: 'whatsapp' (aviso de UltraMsg) o 'historial' (traido al abrir el chat: no cuenta como no leido ni mueve el chat)
async function saveMessage({ db, chatRef, people, ev, nowIso, source = 'whatsapp' }) {
    const msgs = chatRef.collection('wa_mensajes');
    const docId = docIdOf(ev.id);
    return db.runTransaction(async (tx) => {
        const chat = await tx.get(chatRef);
        let ref = docId ? msgs.doc(docId) : msgs.doc();
        let existing = docId ? await tx.get(ref) : null;
        // Un mensaje enviado desde SISDEL ya tiene su documento (con otro id): se busca por su id de WhatsApp
        if (docId && !existing.exists) {
            const byWa = await tx.get(msgs.where('waId', '==', ev.id).limit(1));
            if (!byWa.empty) { ref = byWa.docs[0].ref; existing = byWa.docs[0]; }
        }
        // ...o, la primera vez, su documento "en cola": por la referencia o por telefono y texto
        let pending = null;
        if (ev.fromMe && (!existing || !existing.exists || existing.data().placeholder)) {
            if (ev.referenceId) {
                const byRef = await tx.get(msgs.doc(docIdOf(ev.referenceId)));
                if (byRef.exists && !byRef.data().waId) pending = byRef;
            }
            if (!pending) {
                const q = await tx.get(msgs.where('matchKey', '==', matchKeyOf(ev.phone, ev.body)).where('waId', '==', null).limit(5));
                pending = q.docs.find((d) => Date.parse(nowIso) - Date.parse(d.data().at || 0) < MATCH_WINDOW_MS) || null;
            }
            if (pending && (!existing || !existing.exists)) { ref = pending.ref; existing = pending; pending = null; }
        }
        const prev = existing && existing.exists ? existing.data() : null;
        const ack = prev && ackRank(prev.ack) >= ackRank(ev.ack) ? prev.ack : (ev.ack || (prev && prev.ack) || '');
        const msg = prev
            ? { waId: ev.id || prev.waId || null, ack, placeholder: false, updatedAt: nowIso }
            : {
                waId: ev.id || null, fromMe: !!ev.fromMe, type: ev.type || 'chat', body: ev.body || '', media: ev.media || '', fileName: ev.fileName || '',
                at: ev.at || nowIso, receivedAt: nowIso, ack, source, pushname: ev.pushname || '', channel: ev.channel || '', updatedAt: nowIso
            };
        if (!prev && ev.mediaId) msg.mediaId = ev.mediaId;
        // Un aviso de palomita que llego antes que el mensaje dejo un "borrador": se completa con lo que trae el mensaje
        if (prev && prev.placeholder) Object.assign(msg, { fromMe: !!ev.fromMe, type: ev.type || 'chat', body: ev.body || '', media: ev.media || '', fileName: ev.fileName || '', at: ev.at || prev.at, source });
        tx.set(ref, msg, { merge: true });
        // Su palomita llego antes que el mensaje (quedo un borrador con el id de WhatsApp) y el enviado desde SISDEL sigue
        // "en cola": se completa el borrador con los datos del enviado y este queda marcado como repetido (no se borra)
        if (pending && prev && prev.placeholder) {
            const p = pending.data();
            tx.set(ref, { source: p.source || 'sisdel', sentBy: p.sentBy || '', sentByName: p.sentByName || '', ref: p.ref || pending.id, at: p.at || msg.at }, { merge: true });
            tx.set(pending.ref, { duplicateOf: ref.id, waId: ev.id, updatedAt: nowIso }, { merge: true });
        }

        const old = chat.exists ? chat.data() : {};
        const inbound = !ev.fromMe && (!prev || prev.placeholder) && source !== 'historial';
        const at = msg.at || (prev && prev.at) || nowIso;
        const newer = !old.lastAt || String(at) >= String(old.lastAt);
        const full = { ...(prev || {}), ...msg };
        const chatData = { phone: ev.phone, ...people, updatedAt: nowIso };
        if (!chat.exists) Object.assign(chatData, { createdAt: nowIso, unread: 0 });
        if (newer && source !== 'historial') Object.assign(chatData, { lastAt: at, lastMessage: lastOf(full) });
        else if (!old.lastAt && source === 'historial') Object.assign(chatData, { lastAt: at, lastMessage: lastOf(full) });
        else if (old.lastMessage && full.waId && old.lastMessage.id === full.waId) chatData.lastMessage = { ...old.lastMessage, ack: full.ack };
        // El residente escribio: cuenta como no leido y su canal es por donde se le contesta (por Meta, hasta 24 h despues)
        if (inbound) Object.assign(chatData, { unread: (old.unread || 0) + 1, lastInboundAt: at, lastPushname: ev.pushname || old.lastPushname || '', ...(ev.channel ? { channel: ev.channel } : {}) });
        tx.set(chatRef, chatData, { merge: true });
        return { id: ref.id, duplicate: !!(prev && !prev.placeholder) };
    });
}

// ── Palomitas: se sube el estado del mensaje (nunca se baja). Si el mensaje aun no esta, queda un borrador. ──
async function saveAck({ db, chatRef, people, ev, nowIso, allowPlaceholder = true }) {
    const docId = docIdOf(ev.id);
    if (!docId || !ev.ack) return { updated: false };
    const msgs = chatRef.collection('wa_mensajes');
    return db.runTransaction(async (tx) => {
        let ref = msgs.doc(docId);
        let [snap, chat] = await Promise.all([tx.get(ref), tx.get(chatRef)]);
        // Un mensaje enviado desde SISDEL tiene otro id de documento: se busca por su id de WhatsApp
        if (!snap.exists) {
            const byWa = await tx.get(msgs.where('waId', '==', ev.id).limit(1));
            if (!byWa.empty) { ref = byWa.docs[0].ref; snap = byWa.docs[0]; }
        }
        const prev = snap.exists ? snap.data() : null;
        if (!prev && !allowPlaceholder) return { updated: false, missing: true };
        if (prev && !ackImproves(prev.ack, ev.ack)) return { updated: false };
        tx.set(ref, prev
            ? { ack: ev.ack, ackAt: nowIso, updatedAt: nowIso, ...(ev.ack === 'failed' && ev.error ? { error: ev.error } : {}) }
            : { waId: ev.id, fromMe: !!ev.fromMe, type: 'chat', body: '', at: nowIso, receivedAt: nowIso, ack: ev.ack, ackAt: nowIso, placeholder: true, source: 'whatsapp', updatedAt: nowIso }, { merge: true });
        if (!chat.exists) tx.set(chatRef, { phone: ev.phone, ...people, createdAt: nowIso, unread: 0, updatedAt: nowIso }, { merge: true });
        else if (chat.data().lastMessage && chat.data().lastMessage.id === ev.id) tx.set(chatRef, { lastMessage: { ...chat.data().lastMessage, ack: ev.ack }, updatedAt: nowIso }, { merge: true });
        return { updated: true };
    });
}

// ── Un aviso del webhook: lo guarda en el chat de cada condominio donde vive ese telefono ──
async function handleWebhook({ db, body, now = () => new Date() }) {
    const nowIso = now().toISOString();
    const events = isMeta(body) ? parseMeta(body, nowIso) : [parseWebhook(body, nowIso)];
    let handled = 0;
    const condos = [];
    for (const ev of events) {
        const r = await handleEvent({ db, ev, nowIso, now });
        handled += r.handled;
        condos.push(...(r.condos || []));
    }
    return { handled, kind: events.length === 1 ? events[0].kind : 'varios', condos, events: events.length };
}
async function handleEvent({ db, ev, nowIso, now }) {
    if (ev.kind === 'ignore' || !ev.phone) return { handled: 0, kind: ev.kind, reason: ev.phone ? ev.type : 'sin telefono' };
    const matches = await matchesFor(db, ev.phone, now().getTime());
    const byCondo = new Map();
    matches.forEach((m) => { if (!byCondo.has(m.condoId)) byCondo.set(m.condoId, []); byCondo.get(m.condoId).push(m); });
    const targets = byCondo.size
        ? Array.from(byCondo.entries()).map(([condoId, list]) => ({ chatRef: db.doc(`condominios/${condoId}/whatsapp_chats/${ev.phone}`), people: chatPeople(list), condoId }))
        : [{ chatRef: db.doc(`whatsapp_sin_asignar/${ev.phone}`), people: { residentIds: [], names: [], units: [], roles: [] }, condoId: null }];
    let found = false;
    for (const t of targets) {
        if (ev.kind === 'ack') {
            // Por Meta no llega el mensaje que sale (solo sus palomitas): no se deja borrador
            const r = await saveAck({ db, chatRef: t.chatRef, people: t.people, ev, nowIso, allowPlaceholder: ev.channel !== 'meta' });
            if (!r.missing) found = true;
        } else {
            await saveMessage({ db, chatRef: t.chatRef, people: t.people, ev, nowIso });
            found = true;
        }
    }
    // Palomita de un mensaje que no esta en ningun chat (p. ej. un recordatorio con plantilla): queda aparte, para seguirlo
    if (!found && ev.kind === 'ack') {
        const ref = db.doc(`whatsapp_estados/${docIdOf(ev.id)}`);
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists && !ackImproves(snap.data().ack, ev.ack)) return;
            tx.set(ref, { waId: ev.id, ack: ev.ack, channel: ev.channel || '', phoneTail: ev.phone.slice(-4), at: ev.at || nowIso, error: ev.error || '', updatedAt: nowIso }, { merge: true });
        });
        return { handled: 0, kind: 'ack', condos: [], estado: true };
    }
    return { handled: targets.length, kind: ev.kind, condos: targets.map((t) => t.condoId) };
}

// ── Enviar un mensaje desde OIKOS ──
// data: { chatId (telefono del chat) | residentId, text }. El telefono sale del chat o de la ficha del residente.
async function sendMessage({ db, whatsapp, condominioId, caller, data, now = () => new Date() }) {
    const body = String((data && data.text) || '').trim();
    if (!body) throw fail('invalid-argument', 'Escriba el mensaje.');
    if (body.length > MAX_TEXT) throw fail('invalid-argument', `El mensaje es muy largo (máximo ${MAX_TEXT} letras).`);
    const condoRef = db.doc(`condominios/${condominioId}`);
    let phone = '';
    let resident = null;
    let chatData = null;
    if (data && data.residentId) {
        const user = await condoRef.collection('usuarios').doc(String(data.residentId)).get();
        if (!user.exists) throw fail('not-found', 'El residente no existe.');
        phone = normalizePhone(user.data().phone);
        if (!phone) throw fail('failed-precondition', 'Este residente no tiene un teléfono válido registrado.');
        resident = { condoId: condominioId, userId: user.id, name: String(user.data().name || ''), unit: String(user.data().casa || ''), role: String(user.data().role || '') };
        const chat = await condoRef.collection('whatsapp_chats').doc(phone).get();
        if (chat.exists) chatData = chat.data() || {};
    } else {
        phone = normalizePhone(data && data.chatId);
        if (!phone) throw fail('invalid-argument', 'Chat inválido.');
        const chat = await condoRef.collection('whatsapp_chats').doc(phone).get();
        if (!chat.exists) throw fail('not-found', 'Ese chat no es de este condominio.');
        chatData = chat.data() || {};
    }
    // Los residentes de este condominio con ese telefono (para el encabezado del chat), del indice en memoria
    const list = (await matchesFor(db, phone, now().getTime())).filter((m) => m.condoId === condominioId);
    if (resident && !list.some((m) => m.userId === resident.userId)) list.push(resident);
    const people = list.length ? chatPeople(list)
        : { residentIds: (chatData && chatData.residentIds) || [], names: (chatData && chatData.names) || [], units: (chatData && chatData.units) || [], roles: (chatData && chatData.roles) || [] };

    const config = await whatsapp.loadConfig();
    if (!config || !whatsapp.canChat(config)) throw fail('failed-precondition', 'El WhatsApp del condominio no está conectado para chatear.');
    // Con el WhatsApp OFICIAL activo (pedido del usuario el 2026-11-27: "que este chat sea del numero oficial y se le pueda escribir
    // directo a cualquier vecino") todo sale por el numero oficial, tambien los chats que empezaron por UltraMsg (ese numero lo
    // restringe WhatsApp). Sin el, se contesta por el canal por el que escribio el residente; un chat nuevo, por el del condominio.
    const official = whatsapp.defaultChannel(config) === 'meta';
    const channel = official ? 'meta' : ((chatData && chatData.channel) || whatsapp.defaultChannel(config));
    // Por Meta el mensaje libre solo vale hasta 24 horas despues del ultimo mensaje que el residente mando AL NUMERO OFICIAL. Fuera
    // de eso (o si nunca le escribio a ese numero), lo escrito sale dentro del aviso aprobado (aviso_general: "Hola {nombre}, la
    // administracion de {condominio} le informa: {lo escrito}. ..."); sin esa plantilla, como antes, no se puede
    let template = null;
    if (whatsapp.needsWindow(channel)) {
        const last = Date.parse((chatData && chatData.lastInboundAt) || '');
        const open = (chatData && chatData.channel) === 'meta' && Number.isFinite(last) && now().getTime() - last <= WINDOW_MS;
        if (!open) {
            const condoSnap = await condoRef.get();
            const nombre = (resident && resident.name) || (people.names && people.names[0]) || 'vecino';
            template = typeof whatsapp.chatTemplate === 'function'
                ? whatsapp.chatTemplate(config, { nombre, condominio: condoSnap.exists ? String(condoSnap.data().name || '') : '', aviso: body.replace(/[\s.]+$/, '') || body })
                : null;
            if (!template) throw fail('failed-precondition', 'Con el WhatsApp oficial solo se le puede escribir libremente a un residente hasta 24 horas después de su último mensaje. Para escribirle ahora use un aviso con plantilla (Recordatorios); cuando él responda, se le contesta aquí.');
        }
    }
    // Lo que le llega al residente: con plantilla, el aviso ya lleno
    const shown = template ? template.text : body;

    const nowIso = now().toISOString();
    const chatRef = condoRef.collection('whatsapp_chats').doc(phone);
    const ref = chatRef.collection('wa_mensajes').doc();
    const msg = {
        waId: null, ref: ref.id, matchKey: matchKeyOf(phone, shown), fromMe: true, type: 'chat', body: shown, media: '', fileName: '',
        at: nowIso, receivedAt: nowIso, ack: 'pending', source: 'sisdel', sentBy: caller.id, sentByName: caller.name || '', channel, updatedAt: nowIso,
        ...(template ? { template: template.tpl.name, aviso: body } : {})
    };
    await db.runTransaction(async (tx) => {
        const chat = await tx.get(chatRef);
        tx.set(ref, msg);
        tx.set(chatRef, { phone, ...people, ...(chat.exists ? {} : { createdAt: nowIso, unread: 0, channel }), lastAt: nowIso, lastMessage: lastOf(msg), updatedAt: nowIso }, { merge: true });
    });
    let result = null;
    try { result = await whatsapp.sendChat(config, phone, body, ref.id, channel, template); } catch (e) { result = { ok: false, error: e && e.message ? e.message : 'error' }; }
    if (!result || !result.ok) {
        const error = text((result && result.error) || 'WhatsApp no lo aceptó', 200);
        await ref.set({ ack: 'failed', error, updatedAt: now().toISOString() }, { merge: true });
        await chatRef.set({ lastMessage: { ...lastOf(msg), ack: 'failed' } }, { merge: true });
        return { ok: false, id: ref.id, chatId: phone, error };
    }
    // Meta no entrego la plantilla corta y salio la general: el chat guarda lo que de verdad le llego
    if (result.used && result.used.tpl) {
        await ref.set({ body: result.used.text, template: result.used.tpl.name, matchKey: matchKeyOf(phone, result.used.text), updatedAt: now().toISOString() }, { merge: true });
        msg.body = result.used.text;
    }
    // Meta devuelve el id de WhatsApp al aceptar el mensaje: sus palomitas lo buscan por ese id
    if (channel === 'meta' && result.id) {
        await ref.set({ waId: text(result.id, 300), providerId: text(result.id, 300), updatedAt: now().toISOString() }, { merge: true });
        await chatRef.set({ lastMessage: { ...lastOf(msg), id: text(result.id, 300) } }, { merge: true });
    } else {
        await ref.set({ providerId: text(result.id, 100), updatedAt: now().toISOString() }, { merge: true });
    }
    return { ok: true, id: ref.id, chatId: phone, channel, ...(template ? { template: (result.used && result.used.tpl ? result.used.tpl : template.tpl).name } : {}) };
}

// ── Marcar un chat como leido ──
async function markRead({ db, condominioId, caller, data, now = () => new Date() }) {
    const phone = normalizePhone(data && data.chatId);
    if (!phone) throw fail('invalid-argument', 'Chat inválido.');
    const ref = db.doc(`condominios/${condominioId}/whatsapp_chats/${phone}`);
    const snap = await ref.get();
    if (!snap.exists) throw fail('not-found', 'Ese chat no es de este condominio.');
    if ((snap.data().unread || 0) === 0) return { ok: true, changed: false };
    await ref.set({ unread: 0, readAt: now().toISOString(), readBy: caller.id, readByName: caller.name || '' }, { merge: true });
    return { ok: true, changed: true };
}

// ── Traer los mensajes de antes de un chat (los ultimos 60 que guarda UltraMsg) ──
async function loadHistory({ db, whatsapp, condominioId, data, now = () => new Date() }) {
    const phone = normalizePhone(data && data.chatId);
    if (!phone) throw fail('invalid-argument', 'Chat inválido.');
    const chatRef = db.doc(`condominios/${condominioId}/whatsapp_chats/${phone}`);
    const chat = await chatRef.get();
    if (!chat.exists) throw fail('not-found', 'Ese chat no es de este condominio.');
    const config = await whatsapp.loadConfig();
    if (!config || !whatsapp.canChat(config) || typeof whatsapp.chatHistory !== 'function') return { ok: false, saved: 0, reason: 'sin-proveedor' };
    // Meta no guarda los mensajes de antes: solo hay lo que llego por el aviso
    if ((chat.data().channel || whatsapp.defaultChannel(config)) === 'meta') return { ok: false, saved: 0, reason: 'meta' };
    let rows = [];
    try { rows = await whatsapp.chatHistory(config, phone, HISTORY_LIMIT); } catch (e) { return { ok: false, saved: 0, reason: 'sin-respuesta' }; }
    const nowIso = now().toISOString();
    const people = { residentIds: chat.data().residentIds || [], names: chat.data().names || [], units: chat.data().units || [], roles: chat.data().roles || [] };
    let saved = 0;
    for (const row of (Array.isArray(rows) ? rows : []).slice(-HISTORY_LIMIT)) {
        const ev = parseWebhook({ event_type: row.fromMe ? 'message_create' : 'message_received', data: row }, nowIso);
        if (ev.kind !== 'message' || ev.phone !== phone || !ev.id) continue;
        const r = await saveMessage({ db, chatRef, people, ev, nowIso, source: 'historial' });
        if (!r.duplicate) saved++;
    }
    await chatRef.set({ historyLoadedAt: nowIso }, { merge: true });
    return { ok: true, saved };
}

// ── Un mensaje que salio por otro lado (Recordatorios: el envio a todos o a un residente, por el WhatsApp oficial) ──
// Queda en el chat de ese vecino (pedido del usuario el 2026-11-27: "de los mensajes masivos, si el vecino responde, que se vea en
// este chat"): asi, cuando responde, se ve a que contesta. Con el id de Meta (wamid) sus palomitas lo encuentran. Nunca hace
// fallar el envio (quien llama ignora un error). Devuelve el id del mensaje en el chat o null.
async function recordOutgoing({ db, condominioId, phone, residentId, name, unit, text: body, waId, template, source = 'recordatorio', byName = '', channel = 'meta', now = () => new Date() }) {
    const p = normalizePhone(phone);
    if (!p || !condominioId || !body) return null;
    const nowIso = now().toISOString();
    const chatRef = db.doc(`condominios/${condominioId}/whatsapp_chats/${p}`);
    const msgs = chatRef.collection('wa_mensajes');
    const ref = waId ? msgs.doc(docIdOf(waId)) : msgs.doc();
    const msg = {
        waId: waId ? text(waId, 300) : null, ref: ref.id, fromMe: true, type: 'chat', body: text(body, MAX_TEXT), media: '', fileName: '',
        at: nowIso, receivedAt: nowIso, ack: 'pending', source, sentByName: text(byName, 100), channel, template: text(template || '', 100), updatedAt: nowIso
    };
    await db.runTransaction(async (tx) => {
        const chat = await tx.get(chatRef);
        const old = chat.exists ? chat.data() : {};
        tx.set(ref, msg, { merge: true });
        const fresh = chat.exists ? {} : {
            createdAt: nowIso, unread: 0, channel,
            residentIds: residentId ? [String(residentId)] : [], names: name ? [text(name, 120)] : [], units: unit ? [text(unit, 60)] : [], roles: ['vecino']
        };
        const newer = !old.lastAt || nowIso >= String(old.lastAt);
        tx.set(chatRef, { phone: p, ...fresh, ...(newer ? { lastAt: nowIso, lastMessage: { ...lastOf(msg), id: msg.waId || '' } } : {}), updatedAt: nowIso }, { merge: true });
    });
    return ref.id;
}

module.exports = {
    MAX_TEXT, ACK_RANK, WINDOW_MS, fail, normAck, phoneOfJid, docIdOf, matchKeyOf, parseWebhook, parseMeta, isMeta, buildPhoneIndex, phoneIndex, chatPeople,
    saveMessage, saveAck, handleWebhook, sendMessage, markRead, loadHistory, recordOutgoing,
    _resetIndex: () => { cached = { at: 0, index: null }; }
};
