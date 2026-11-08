/* ═══════════════════════════════════════════════════════════════
   SISDEL - Rondas: capa de datos (Firestore)
   ───────────────────────────────────────────────────────────────
   Rondas de vigilancia traidas de SISDEL RONDIN, sobre la misma base de
   SISDEL: los guardias son los usuarios con rol policia (o supervisor) y los
   vecinos son los mismos de siempre. Colecciones por condominio:

     rondas_rutas         rutas con sus puntos de control (checkpoints)
     rondas_asignaciones  que guardia patrulla que ruta y en que horario
     rondas_turnos        turno de un guardia (inicio y fin con GPS y foto)
     rondas_rondas        cada vuelta a la ruta, con su puntaje
     rondas_visitas       cada punto marcado (no se edita ni se borra)
     rondas_en_vivo/{id}  posicion actual de cada guardia
     rondas_ubicaciones   historial de posiciones (se borra a los 30 dias)
     rondas_incidentes    incidentes reportados en la ronda
     rondas_fotos         fotos comprimidas de turnos e incidentes
     alertas_panico       boton de panico de vecinos y guardias
     emergencia/{userId}  contactos de emergencia del vecino

   Requiere firebase-client.js, sisdel-core.js y rondas-logic.js.
   ═══════════════════════════════════════════════════════════════ */

const SisdelRondas = (() => {
    const L = SisdelRondasLogic;
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

    // ── Utilidades del navegador ──

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

    // Foto de la camara comprimida a JPEG (maximo 1024 px): cabe en un documento de Firestore
    function compressImage(file, maxDim = 1024, quality = 0.6) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('No se pudo leer la foto'));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Formato de foto no valido'));
                img.onload = () => {
                    let { width: w, height: h } = img;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; } else { w = Math.round((w * maxDim) / h); h = maxDim; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    // Abre la camara del celular y devuelve la foto comprimida (o null si cancela)
    function takePhoto() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.capture = 'environment';
            input.onchange = async () => {
                const file = input.files && input.files[0];
                if (!file) { resolve(null); return; }
                try { resolve(await compressImage(file)); } catch { resolve(null); }
            };
            // Si cierra la camara sin foto
            input.addEventListener('cancel', () => resolve(null));
            input.click();
        });
    }

    function mapsLink(lat, lng) { return `https://www.google.com/maps?q=${lat},${lng}`; }

    // ── Rutas ──
    async function listRoutes(includeInactive = false) {
        const routes = snapList(await col('rondas_rutas').get());
        return routes.filter((r) => includeInactive || r.status !== 'INACTIVE').sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async function getRoute(id) {
        const snap = await col('rondas_rutas').doc(id).get();
        return snap.exists ? { ...snap.data(), id: snap.id } : null;
    }

    async function saveRoute(route) {
        const ref = route.id ? col('rondas_rutas').doc(route.id) : col('rondas_rutas').doc();
        const data = {
            id: ref.id, condominioId: condoId, name: String(route.name || '').trim() || 'Ruta sin nombre',
            description: route.description || '', color: route.color || '#3B82F6', status: route.status || 'ACTIVE',
            checkpoints: (route.checkpoints || []).map((c, i) => ({
                id: c.id || `cp_${Date.now().toString(36)}_${i}`, name: String(c.name || `Punto ${i + 1}`).trim(),
                lat: Number(c.lat), lng: Number(c.lng), radius: Number(c.radius) || 25, order: i + 1,
                mandatory: c.mandatory !== false, active: c.active !== false, code: c.code || L.checkpointCode()
            })),
            config: {
                roundsPerShift: Number(route.config && route.config.roundsPerShift) || 4,
                maxMinutes: Number(route.config && route.config.maxMinutes) || 45,
                sequential: !!(route.config && route.config.sequential)
            },
            updatedAt: nowIso(), updatedBy: uid()
        };
        if (!route.id) { data.createdAt = nowIso(); data.createdBy = uid(); }
        await ref.set(data, { merge: true });
        return data;
    }

    async function setRouteStatus(id, status) { await col('rondas_rutas').doc(id).update({ status, updatedAt: nowIso() }); }

    // ── Asignaciones ──
    async function listAssignments() {
        return snapList(await col('rondas_asignaciones').get()).sort(byDesc('dateStart'));
    }

    async function myAssignments() {
        return snapList(await col('rondas_asignaciones').where('guardId', '==', uid()).get());
    }

    async function saveAssignment(a) {
        const ref = a.id ? col('rondas_asignaciones').doc(a.id) : col('rondas_asignaciones').doc();
        const data = {
            id: ref.id, condominioId: condoId, routeId: a.routeId, routeName: a.routeName || '',
            guardId: a.guardId, guardName: a.guardName || '', shiftType: a.shiftType || '12H_DIA',
            dateStart: a.dateStart, dateEnd: a.dateEnd, hourStart: a.hourStart, hourEnd: a.hourEnd,
            status: a.status || 'ACTIVE', updatedAt: nowIso()
        };
        if (!a.id) data.createdAt = nowIso();
        await ref.set(data, { merge: true });
        return data;
    }

    async function deleteAssignment(id) { await col('rondas_asignaciones').doc(id).delete(); }

    // Guardias que pueden patrullar (policia y supervisor), sin codigos de acceso
    async function listPatrollers() {
        const users = await SISDEL.getUsers(condoId);
        return users.filter((u) => ['policia', 'supervisor'].includes(u.role) && u.active !== false);
    }

    // ── Fotos ──
    async function savePhoto(dataUrl, kind, refId) {
        if (!dataUrl) return null;
        const ref = col('rondas_fotos').doc();
        await ref.set({ id: ref.id, condominioId: condoId, data: dataUrl, kind, refId: refId || '', by: uid(), createdAt: nowIso() });
        return ref.id;
    }

    async function getPhoto(id) {
        if (!id) return null;
        const snap = await col('rondas_fotos').doc(id).get();
        return snap.exists ? snap.data().data : null;
    }

    // ── Turnos ──
    async function myActiveShift() {
        const shifts = snapList(await col('rondas_turnos').where('guardId', '==', uid()).where('status', '==', 'ACTIVE').get());
        return shifts.sort(byDesc('startedAt'))[0] || null;
    }

    async function startShift({ route, assignment, pos, photo }) {
        const ref = col('rondas_turnos').doc();
        const photoId = photo ? await savePhoto(photo, 'turno_inicio', ref.id) : null;
        const data = {
            id: ref.id, condominioId: condoId, guardId: uid(), guardName: session.userName || '',
            routeId: route.id, routeName: route.name, assignmentId: assignment ? assignment.id : null,
            startedAt: nowIso(), endedAt: null, startLat: pos ? pos.lat : null, startLng: pos ? pos.lng : null,
            startPhotoId: photoId, endLat: null, endLng: null, endPhotoId: null, rounds: 0, status: 'ACTIVE'
        };
        await ref.set(data);
        return data;
    }

    async function endShift(shift, { pos, photo, status = 'CLOSED', notes = '' } = {}) {
        const photoId = photo ? await savePhoto(photo, 'turno_fin', shift.id) : null;
        await col('rondas_turnos').doc(shift.id).update({
            status, endedAt: nowIso(), endLat: pos ? pos.lat : null, endLng: pos ? pos.lng : null, endPhotoId: photoId, notes
        });
    }

    async function listShifts(fromIso, toIso) {
        const snap = await col('rondas_turnos').where('startedAt', '>=', fromIso).where('startedAt', '<', toIso).get();
        return snapList(snap).sort(byDesc('startedAt'));
    }

    function subscribeActiveShifts(onChange, onError) {
        return col('rondas_turnos').where('status', '==', 'ACTIVE').onSnapshot((snap) => onChange(snapList(snap)), onError);
    }

    // ── Rondas y visitas ──
    async function shiftRounds(shift) {
        return snapList(await col('rondas_rondas').where('guardId', '==', shift.guardId).where('shiftId', '==', shift.id).get()).sort(byDesc('startedAt'));
    }

    async function startRound(shift, route, number) {
        const ref = col('rondas_rondas').doc();
        const data = {
            id: ref.id, condominioId: condoId, shiftId: shift.id, routeId: route.id, routeName: route.name,
            guardId: uid(), guardName: session.userName || '', number, startedAt: nowIso(), completedAt: null,
            visited: [], score: 0, totalCheckpoints: L.mandatoryCheckpoints(route).length, status: 'IN_PROGRESS'
        };
        await ref.set(data);
        await col('rondas_turnos').doc(shift.id).update({ rounds: number });
        return data;
    }

    async function roundVisits(round) {
        return snapList(await col('rondas_visitas').where('guardId', '==', round.guardId).where('roundId', '==', round.id).get())
            .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }

    async function markVisit(round, checkpoint, pos, method) {
        const distance = pos ? Math.round(L.haversine(pos.lat, pos.lng, checkpoint.lat, checkpoint.lng)) : null;
        const status = pos ? L.visitStatus(checkpoint, distance, method, pos.accuracy) : 'SUSPICIOUS';
        const ref = col('rondas_visitas').doc();
        const visit = {
            id: ref.id, condominioId: condoId, roundId: round.id, shiftId: round.shiftId, routeId: round.routeId,
            checkpointId: checkpoint.id, checkpointName: checkpoint.name, guardId: uid(), guardName: session.userName || '',
            at: nowIso(), lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, accuracy: pos ? pos.accuracy : null,
            distance, method, status
        };
        await ref.set(visit);
        if (status === 'VALID') {
            await col('rondas_rondas').doc(round.id).update({ visited: firebase.firestore.FieldValue.arrayUnion(checkpoint.id) });
        }
        return visit;
    }

    async function finishRound(round, route, visits, notes = '') {
        const result = L.roundScore(route, visits);
        const update = { completedAt: nowIso(), score: result.score, status: result.status, missing: result.missing.map((c) => c.name), notes };
        await col('rondas_rondas').doc(round.id).update(update);
        return { ...round, ...update };
    }

    async function listRounds(fromIso, toIso) {
        const snap = await col('rondas_rondas').where('startedAt', '>=', fromIso).where('startedAt', '<', toIso).get();
        return snapList(snap).sort(byDesc('startedAt'));
    }

    async function roundVisitsForPanel(roundId) {
        return snapList(await col('rondas_visitas').where('roundId', '==', roundId).get()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }

    // ── Posicion en vivo ──
    async function updateLive(shift, round, pos, saveHistory) {
        const data = {
            guardId: uid(), guardName: session.userName || '', condominioId: condoId, shiftId: shift.id,
            routeId: shift.routeId, routeName: shift.routeName, roundId: round ? round.id : null,
            roundNumber: round ? round.number : null, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy || null, at: nowIso()
        };
        await col('rondas_en_vivo').doc(uid()).set(data);
        if (saveHistory) {
            await col('rondas_ubicaciones').add({
                guardId: uid(), condominioId: condoId, shiftId: shift.id, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy || null, at: data.at
            });
        }
    }

    async function clearLive() { await col('rondas_en_vivo').doc(uid()).delete().catch(() => {}); }

    function subscribeLive(onChange, onError) {
        return col('rondas_en_vivo').onSnapshot((snap) => onChange(snapList(snap)), onError);
    }

    // ── Incidentes ──
    async function reportIncident({ shift, round, type, severity, title, description, pos, photo }) {
        const ref = col('rondas_incidentes').doc();
        const photoId = photo ? await savePhoto(photo, 'incidente', ref.id) : null;
        const data = {
            id: ref.id, condominioId: condoId, reportedBy: uid(), reporterName: session.userName || '',
            shiftId: shift ? shift.id : null, roundId: round ? round.id : null, routeName: shift ? shift.routeName : '',
            type, severity: severity || 'MEDIUM', title: String(title || type || 'Incidente').trim(), description: description || '',
            lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, photoIds: photoId ? [photoId] : [],
            status: 'OPEN', resolvedBy: null, resolvedByName: null, resolvedAt: null, resolution: '', createdAt: nowIso()
        };
        await ref.set(data);
        return data;
    }

    async function listIncidents(fromIso, toIso) {
        const snap = await col('rondas_incidentes').where('createdAt', '>=', fromIso).where('createdAt', '<', toIso).get();
        return snapList(snap).sort(byDesc('createdAt'));
    }

    async function resolveIncident(id, resolution) {
        await col('rondas_incidentes').doc(id).update({
            status: 'RESOLVED', resolvedBy: uid(), resolvedByName: session.userName || '', resolvedAt: nowIso(), resolution: resolution || ''
        });
    }

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

    async function listPanics(fromIso, toIso) {
        const snap = await col('alertas_panico').where('createdAt', '>=', fromIso).where('createdAt', '<', toIso).get();
        return snapList(snap).sort(byDesc('createdAt'));
    }

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

    return {
        init, getPosition, compressImage, takePhoto, mapsLink,
        listRoutes, getRoute, saveRoute, setRouteStatus,
        listAssignments, myAssignments, saveAssignment, deleteAssignment, listPatrollers,
        savePhoto, getPhoto,
        myActiveShift, startShift, endShift, listShifts, subscribeActiveShifts,
        shiftRounds, startRound, roundVisits, markVisit, finishRound, listRounds, roundVisitsForPanel,
        updateLive, clearLive, subscribeLive,
        reportIncident, listIncidents, resolveIncident,
        raisePanic, subscribeActivePanics, subscribePanic, attendPanic, resolvePanic, cancelPanic, listPanics, myLatestPanic,
        getContacts, saveContacts
    };
})();
