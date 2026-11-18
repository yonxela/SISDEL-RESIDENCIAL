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

    // ── GPS del celular para la alerta de panico ──
    // La alerta necesita las coordenadas en el MOMENTO de crearse (el aviso por WhatsApp sale de ahi). Pedirlas al terminar de
    // mantener presionado el boton fallaba: el permiso aparece justo entonces y tarda mas que la espera. Por eso:
    //  - al abrir el panel se pide el permiso y, con el permiso dado, se sigue la posicion (watchPosition) mientras la pagina
    //    esta visible: la alerta sale al instante con la ultima posicion conocida;
    //  - al empezar a mantener presionado el boton se vuelve a pedir si todavia no hay permiso (y se calienta el GPS);
    //  - al enviar, bestPosition() usa la posicion reciente o espera unos segundos una nueva (con un intento de baja
    //    precision por red y wifi a un tercio de la espera, que llega rapido dentro de edificios) y, si no hay, se envia igual.
    // status: 'idle' (sin pedir) | 'searching' | 'ok' | 'denied' | 'unsupported'
    const gps = { pos: null, at: 0, watchId: null, status: 'idle', listeners: new Set() };
    const GPS_STALE_MS = 10 * 60 * 1000; // una posicion mas vieja que esto ya no sirve para decir donde esta
    function gpsState() { return { status: gps.status, pos: gps.pos, ageMs: gps.pos ? Date.now() - gps.at : null }; }
    function gpsEmit() { gps.listeners.forEach((fn) => { try { fn(gpsState()); } catch (e) { /* un escuchador roto no frena a los demas */ } }); }
    function gpsFix(p) {
        gps.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) };
        gps.at = Date.now();
        gps.status = 'ok';
        gpsEmit();
    }
    function gpsStop() {
        if (gps.watchId === null) return;
        try { navigator.geolocation.clearWatch(gps.watchId); } catch (e) { /* ya estaba cerrado */ }
        gps.watchId = null;
    }
    function gpsFail(err) {
        if (err && err.code === 1) { gps.status = 'denied'; gpsStop(); } // permiso negado: no hay que seguir insistiendo
        else if (gps.status !== 'ok') gps.status = 'searching';
        gpsEmit();
    }
    // Empieza a seguir la posicion (y, si falta, hace que el telefono pida el permiso)
    function gpsStart() {
        if (typeof navigator === 'undefined' || !navigator.geolocation) { gps.status = 'unsupported'; gpsEmit(); return; }
        if (gps.watchId !== null) return;
        if (gps.status !== 'ok') gps.status = 'searching';
        gps.watchId = navigator.geolocation.watchPosition(gpsFix, gpsFail, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
        gpsEmit();
    }
    // 'granted' | 'prompt' | 'denied' | 'unknown' (sin la API de permisos del navegador)
    function gpsPermission() {
        if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown');
        return navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state).catch(() => 'unknown');
    }
    // Avisa cuando el usuario cambia el permiso (por ejemplo, lo activa en los ajustes del telefono)
    function gpsWatchPermission(onChange) {
        if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return;
        navigator.permissions.query({ name: 'geolocation' }).then((r) => { r.onchange = () => onChange(r.state); }).catch(() => {});
    }
    // Al ingresar el vecino (index.html): pide el permiso del GPS y ESPERA su respuesta (hasta waitMs) antes de pasar al portal, para
    // que el telefono no pierda la ventana al cambiar de pagina. Con el permiso ya dado no espera (sigue la posicion) y con el
    // permiso negado tampoco. Devuelve: 'granted' | 'denied' | 'timeout' (no respondio: el portal lo vuelve a pedir) | 'unsupported'.
    async function gpsAsk(waitMs = 25000) {
        if (typeof navigator === 'undefined' || !navigator.geolocation) { gps.status = 'unsupported'; gpsEmit(); return 'unsupported'; }
        const state = await gpsPermission();
        if (state === 'denied') { gps.status = 'denied'; gpsEmit(); return 'denied'; }
        if (state === 'granted') { gpsStart(); return 'granted'; }
        return new Promise((resolve) => {
            let done = false;
            let timer = null;
            const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
            timer = setTimeout(() => finish('timeout'), waitMs);
            navigator.geolocation.getCurrentPosition(
                (p) => { gpsFix(p); finish('granted'); },
                (err) => {
                    if (err && err.code === 1) { gps.status = 'denied'; gpsEmit(); finish('denied'); }
                    else finish('granted'); // dio el permiso pero todavia no hay senal: el portal sigue buscando
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
            );
        });
    }
    function gpsOnChange(fn) { gps.listeners.add(fn); return () => gps.listeners.delete(fn); }
    // La mejor posicion para la alerta: la reciente si la hay (hasta maxAgeMs); si no, espera hasta waitMs una nueva.
    // Con el permiso negado responde null de inmediato. Nunca falla: sin posicion devuelve null y la alerta sale igual.
    function bestPosition(waitMs = 6000, maxAgeMs = 120000) {
        return new Promise((resolve) => {
            if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve(null); return; }
            if (gps.pos && Date.now() - gps.at <= maxAgeMs) { resolve(gps.pos); return; }
            let finished = false;
            const timers = [];
            const lastKnown = () => (gps.pos && Date.now() - gps.at <= GPS_STALE_MS ? gps.pos : null);
            const finish = (pos) => {
                if (finished) return;
                finished = true;
                gps.listeners.delete(onChange);
                timers.forEach(clearTimeout);
                resolve(pos);
            };
            const onChange = (s) => {
                if (s.status === 'denied') finish(lastKnown());
                else if (s.pos && s.ageMs !== null && s.ageMs < 5000) finish(s.pos);
            };
            gps.listeners.add(onChange);
            gpsStart();
            timers.push(setTimeout(() => {
                if (finished) return;
                try { navigator.geolocation.getCurrentPosition(gpsFix, () => {}, { enableHighAccuracy: false, timeout: Math.max(1500, Math.round(waitMs / 2)), maximumAge: GPS_STALE_MS }); } catch (e) { /* sin GPS de red */ }
            }, Math.round(waitMs / 3)));
            timers.push(setTimeout(() => finish(lastKnown()), waitMs));
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
        gps: { start: gpsStart, ask: gpsAsk, stop: gpsStop, state: gpsState, permission: gpsPermission, watchPermission: gpsWatchPermission, onChange: gpsOnChange, bestPosition },
        raisePanic, subscribeActivePanics, subscribePanic, attendPanic, resolvePanic, cancelPanic, myLatestPanic,
        getContacts, saveContacts, neighborPanicEnabled
    };
})();
