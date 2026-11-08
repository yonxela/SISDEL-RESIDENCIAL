/* ═══════════════════════════════════════════════════════════════
   SISDEL - Boton de panico y contactos de emergencia (Firestore)
   ───────────────────────────────────────────────────────────────
   Lo usan vecino.html (boton de panico), garita.html y admin.html
   (panico-alertas.js). Las rondas de vigilancia son el modulo RONDIN
   (rondin/), que usa estas mismas colecciones:

     alertas_panico       boton de panico de vecinos y guardias
     emergencia/{userId}  contactos de emergencia del vecino (hasta 5)

   Requiere firebase-client.js y sisdel-core.js.
   ═══════════════════════════════════════════════════════════════ */

const SisdelRondas = (() => {
    let condoId = null;
    let session = null;

    function db() { return window.sisdelFirebase.db; }
    function col(name) { return db().collection('condominios').doc(condoId).collection(name); }
    function nowIso() { return new Date().toISOString(); }
    function uid() { return session.userId; }
    function snapList(snap) { return snap.docs.map((d) => ({ ...d.data(), id: d.id })); }
    const byDesc = (field) => (a, b) => String(b[field] || '').localeCompare(String(a[field] || ''));

    function init(currentSession) {
        session = currentSession;
        condoId = currentSession.condominioId;
    }

    // Posicion actual (o null si no hay GPS o el usuario no da permiso)
    function getPosition(timeoutMs = 12000) {
        return new Promise((resolve) => {
            if (!navigator.geolocation) { resolve(null); return; }
            navigator.geolocation.getCurrentPosition(
                (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }),
                () => resolve(null),
                { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 }
            );
        });
    }

    function mapsLink(lat, lng) { return `https://www.google.com/maps?q=${lat},${lng}`; }

    // ── Alertas de panico ──
    async function raisePanic({ source, pos, casa, phone }) {
        const ref = col('alertas_panico').doc();
        const data = {
            id: ref.id, condominioId: condoId, source, userId: uid(), userName: session.userName || '',
            casa: casa || session.userCasa || '', phone: phone || '',
            lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, accuracy: pos ? pos.accuracy : null,
            status: 'ACTIVE', createdAt: nowIso()
        };
        await ref.set(data);
        return data;
    }

    // Alertas sin resolver: activas y atendidas (siguen a la vista hasta que alguien las resuelve)
    function subscribeActivePanics(onChange, onError) {
        return col('alertas_panico').where('status', 'in', ['ACTIVE', 'ATTENDED']).onSnapshot((snap) => onChange(snapList(snap).sort(byDesc('createdAt'))), onError);
    }

    function subscribePanic(id, onChange, onError) {
        return col('alertas_panico').doc(id).onSnapshot((snap) => onChange(snap.exists ? { ...snap.data(), id: snap.id } : null), onError);
    }

    async function attendPanic(id) {
        await col('alertas_panico').doc(id).update({ status: 'ATTENDED', attendedBy: uid(), attendedByName: session.userName || '', attendedAt: nowIso() });
    }

    async function resolvePanic(id, notes) {
        await col('alertas_panico').doc(id).update({ status: 'RESOLVED', resolvedBy: uid(), resolvedByName: session.userName || '', resolvedAt: nowIso(), notes: notes || '' });
    }

    async function cancelPanic(id) { await col('alertas_panico').doc(id).update({ status: 'CANCELLED', cancelledAt: nowIso() }); }

    // Ultima alerta propia del vecino (para mostrar su estado al volver a la pagina)
    async function myLatestPanic() {
        const list = snapList(await col('alertas_panico').where('userId', '==', uid()).get()).sort(byDesc('createdAt'));
        return list[0] || null;
    }

    // ── Contactos de emergencia del vecino ──
    async function getContacts(userId) {
        const snap = await col('emergencia').doc(userId).get();
        return snap.exists ? (snap.data().contacts || []) : [];
    }

    async function saveContacts(userId, contacts) {
        const clean = (contacts || [])
            .map((c) => ({ name: String(c.name || '').trim(), phone: String(c.phone || '').trim() }))
            .filter((c) => c.name || c.phone)
            .slice(0, 5);
        await col('emergencia').doc(userId).set({ userId, condominioId: condoId, contacts: clean, updatedAt: nowIso() });
        return clean;
    }

    // Configuracion de RONDIN: el boton de panico del vecino se activa en RONDIN > Configuracion
    async function neighborPanicEnabled() {
        try {
            const snap = await col('rondas_config').doc('general').get();
            return snap.exists && !!snap.data().neighbor_panic_enabled;
        } catch { return false; }
    }

    return {
        init, getPosition, mapsLink,
        raisePanic, subscribeActivePanics, subscribePanic, attendPanic, resolvePanic, cancelPanic, myLatestPanic,
        getContacts, saveContacts, neighborPanicEnabled
    };
})();
