/* ═══════════════════════════════════════════════════════════════
   SISDEL Core Cloud - Firebase (Firestore + Auth + Functions)
   Datos aislados por condominio: condominios/{condoId}/...
   ═══════════════════════════════════════════════════════════════ */

const SISDEL = (() => {
    // ── Constants ──
    const STORAGE_KEYS = { session: 'sisdel_session', loginTiming: 'sisdel_login_timing' };

    const ROLES = { MASTER: 'master', ADMIN: 'admin', VECINO: 'vecino', POLICIA: 'policia', AUDITOR: 'auditor', SUPERVISOR: 'supervisor' };
    const PAYMENT_STATUS = { AL_DIA: 'al_dia', MOROSO: 'moroso' };
    const VISIT_STATUS = { PENDING: 'pending', ENTERED: 'entered', COMPLETED: 'completed' };

    const COL = {
        condos: 'condominios', users: 'usuarios', visits: 'visitas', vehicles: 'vehiculos',
        messages: 'mensajes', cameraLogs: 'camera_logs',
        globalMessages: 'mensajes_globales', codes: 'codigos'
    };

    // Las lecturas van siempre al servidor: si no hay conexion se avisa, no se muestra una lista vacia
    const SERVER = { source: 'server' };
    const BATCH_SIZE = 400;

    // ── Database Helper ──
    function services() {
        if (!window.sisdelFirebase) throw new Error('Firebase client not initialized or loaded.');
        return window.sisdelFirebase;
    }
    function db() { return services().db; }
    function condoRef(condominioId) { return db().collection(COL.condos).doc(condominioId); }
    function sub(condominioId, name) { return condoRef(condominioId).collection(name); }

    let authReadyPromise = null;
    let authReadyMs = null; // cuanto tardo en restaurarse la sesion (diagnostico)
    function authReady() {
        if (!authReadyPromise) {
            authReadyPromise = new Promise((resolve) => {
                const unsubscribe = services().auth.onAuthStateChanged((user) => {
                    unsubscribe();
                    authReadyMs = Math.round(performance.now());
                    resolve(user);
                });
            });
        }
        return authReadyPromise;
    }

    // Si la misma consulta ya esta en curso se comparte: las paginas piden lo mismo varias veces al cargar.
    // Cada llamador recibe su propia copia de la lista para que nadie altere la de otro.
    const inFlight = new Map();
    function shared(key, run) {
        if (!inFlight.has(key)) {
            const promise = Promise.resolve().then(run).finally(() => inFlight.delete(key));
            inFlight.set(key, promise);
        }
        return inFlight.get(key).then((result) => (Array.isArray(result) ? result.slice() : result));
    }

    // ── Tools ──
    function nowIso() { return new Date().toISOString(); }

    function localToday() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    function normalizePlate(plate) { return String(plate || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

    function normalizeCode(code) { return String(code || '').trim().toUpperCase(); }

    function isSafeCode(code) { return !!code && code.length <= 64 && !code.includes('/') && code !== '.' && code !== '..'; }

    function uniqueSuffix() { return Math.random().toString(36).slice(2, 4).toUpperCase(); }

    // Primera letra sin acentos. Si no es letra o numero se usa X
    function initial(text) {
        const letter = String(text || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
        return /^[A-Z0-9]$/.test(letter) ? letter : 'X';
    }

    function generateAccessCode(condominioName, userName) {
        const numbers = String(Math.floor(100 + Math.random() * 900));
        return initial(condominioName) + initial(userName) + numbers;
    }

    function isValidCodeFormat(code) { return /^[A-Z]{2}\d{3}$/i.test(code); }

    function byCreatedDesc(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }

    // Cache de referencias: permite operar por id sin saber el condominio
    const refCache = new Map();
    function toObj(kind, doc) {
        refCache.set(`${kind}:${doc.id}`, doc.ref);
        return { ...doc.data(), id: doc.id };
    }

    function sessionCondoId() {
        const session = getSession();
        return session && session.condominioId ? session.condominioId : null;
    }
    function sessionRole() {
        const session = getSession();
        return session ? session.role : null;
    }
    function isMasterSession() { return sessionRole() === ROLES.MASTER; }

    // Ubica un documento por id. El master no tiene condominio fijo: se busca en todos
    async function findRef(kind, id) {
        if (!id) return null;
        const key = `${kind}:${id}`;
        if (refCache.has(key)) return refCache.get(key);

        const condominioId = sessionCondoId();
        if (condominioId) {
            if (kind !== COL.messages) return sub(condominioId, kind).doc(id);
            const local = await sub(condominioId, kind).doc(id).get(SERVER).catch(() => null);
            return local && local.exists ? local.ref : db().collection(COL.globalMessages).doc(id);
        }

        if (kind === COL.messages) {
            const global = await db().collection(COL.globalMessages).doc(id).get(SERVER);
            if (global.exists) return global.ref;
        }
        const condos = await db().collection(COL.condos).get(SERVER);
        for (const condo of condos.docs) {
            const snap = await condo.ref.collection(kind).doc(id).get(SERVER);
            if (snap.exists) { refCache.set(key, snap.ref); return snap.ref; }
        }
        return null;
    }

    async function commitInChunks(refs, action) {
        for (let i = 0; i < refs.length; i += BATCH_SIZE) {
            const batch = db().batch();
            refs.slice(i, i + BATCH_SIZE).forEach((ref) => action(batch, ref));
            await batch.commit();
        }
    }

    // ── Errores visibles: nunca confundir "sin conexion" con "sin datos" ──
    let lastErrorToast = 0;
    function reportError(context, error) {
        console.error(`${context} error:`, error);
        const code = String((error && error.code) || '');
        const message = String((error && error.message) || '');
        const now = Date.now();
        if (now - lastErrorToast < 6000) return;

        if (code.includes('unavailable') || code.includes('deadline-exceeded') || /offline|network/i.test(message)) {
            lastErrorToast = now;
            showToast('Sin conexión a la base de datos. Revise su internet.', 'error');
        } else if (code.includes('permission-denied') || code.includes('unauthenticated')) {
            lastErrorToast = now;
            showToast('Sesión vencida o sin permisos. Vuelva a iniciar sesión.', 'warning');
        }
    }

    // ══════════════════════════════════
    //  Condominio CRUD
    // ══════════════════════════════════
    function getCondominios() {
        return shared('condos', async () => {
            try {
                await authReady();
                const snap = await db().collection(COL.condos).get(SERVER);
                return snap.docs.map((d) => toObj(COL.condos, d)).sort(byCreatedDesc);
            } catch (error) { reportError('getCondominios', error); return []; }
        });
    }

    function getCondominio(id) {
        return shared(`condo:${id || ''}`, async () => {
            try {
                await authReady();
                if (!id) return null;
                const snap = await condoRef(id).get(SERVER);
                return snap.exists ? toObj(COL.condos, snap) : null;
            } catch (error) { reportError('getCondominio', error); return null; }
        });
    }

    async function createCondominio(name, address, phone) {
        try {
            await authReady();
            const ref = db().collection(COL.condos).doc();
            const data = {
                id: ref.id, name: name.trim(), address: address || '', phone: phone || '', active: true,
                hasQR: true, hasManual: true, hasLPR: false,
                reminderEnabled: false, gracePeriodDays: 15,
                serviceExpiry: null, createdAt: nowIso()
            };
            await ref.set(data);
            return data;
        } catch (error) { reportError('createCondominio', error); return null; }
    }

    async function updateCondominio(id, updates) {
        try {
            await authReady();
            const changes = { ...updates };
            delete changes.id;
            await condoRef(id).update(changes);
            return await getCondominio(id);
        } catch (error) { reportError('updateCondominio', error); return null; }
    }

    async function deactivateCondominio(id) { return updateCondominio(id, { active: false }); }
    async function activateCondominio(id) { return updateCondominio(id, { active: true }); }
    async function toggleCondoSetting(id, settingName, value) {
        return updateCondominio(id, { [settingName]: value });
    }

    // El borrado en cascada (usuarios, visitas, vehiculos, etc.) lo hace el servidor
    async function deleteCondominio(id) {
        try {
            await authReady();
            await services().functions.httpsCallable('deleteCondominio', { timeout: 300000 })({ condominioId: id });
            return true;
        } catch (error) { reportError('deleteCondominio', error); return false; }
    }

    // ══════════════════════════════════
    //  Codigos de acceso (coleccion aparte: guardias y vecinos no pueden leerlos)
    // ══════════════════════════════════
    function canReadCodes() { return [ROLES.MASTER, ROLES.ADMIN].includes(sessionRole()); }

    // Mapa userId -> codigo. Devuelve null si el rol no puede ver codigos
    async function codesByUser(condominioId) {
        if (!canReadCodes()) return null;
        const scope = condominioId || sessionCondoId();
        let query = db().collection(COL.codes);
        if (scope) query = query.where('condominioId', '==', scope);
        const snap = await query.get(SERVER);
        const map = new Map();
        snap.docs.forEach((d) => map.set(d.data().userId, d.id));
        return map;
    }

    async function codeDocsOfUser(condominioId, userId) {
        const snap = await db().collection(COL.codes)
            .where('condominioId', '==', condominioId)
            .where('userId', '==', userId)
            .get(SERVER);
        return snap.docs;
    }

    // ══════════════════════════════════
    //  User CRUD
    // ══════════════════════════════════
    function getUsers(condominioId) {
        const scope = condominioId || sessionCondoId();
        return shared(`users:${scope || ''}`, async () => {
            try {
                await authReady();
                const query = scope ? sub(scope, COL.users) : db().collectionGroup(COL.users);
                const [snap, codes] = await Promise.all([query.get(SERVER), codesByUser(scope)]);
                const users = snap.docs.map((d) => toObj(COL.users, d)).sort(byCreatedDesc);
                if (codes) users.forEach((u) => { u.accessCode = codes.get(u.id) || ''; });
                return users;
            } catch (error) { reportError('getUsers', error); return []; }
        });
    }

    async function getUserByCode(code) {
        try {
            await authReady();
            const normalized = normalizeCode(code);
            if (!isSafeCode(normalized)) return null;

            if (isMasterSession()) {
                const codeSnap = await db().collection(COL.codes).doc(normalized).get(SERVER);
                if (!codeSnap.exists) return null;
                const { condominioId, userId } = codeSnap.data();
                const userSnap = await sub(condominioId, COL.users).doc(userId).get(SERVER);
                return userSnap.exists ? { ...toObj(COL.users, userSnap), accessCode: normalized } : null;
            }

            // Garita y admin: lo valida el servidor sin exponer la lista de codigos
            const result = await services().functions.httpsCallable('verifyAccessCode')({ code: normalized });
            return (result.data && result.data.user) || null;
        } catch (error) { reportError('getUserByCode', error); return null; }
    }

    async function getUserById(id) {
        try {
            await authReady();
            const ref = await findRef(COL.users, id);
            if (!ref) return null;
            const snap = await ref.get(SERVER);
            if (!snap.exists) return null;
            const user = toObj(COL.users, snap);
            if (canReadCodes()) {
                const codes = await codeDocsOfUser(user.condominioId, user.id);
                user.accessCode = codes.length ? codes[0].id : '';
            }
            return user;
        } catch (error) { reportError('getUserById', error); return null; }
    }

    // preferredCode: codigo que propone la pantalla (RONDIN muestra el codigo del guardia antes de guardarlo);
    // si no es valido o ya esta ocupado se genera uno nuevo
    async function createUser(condominioId, name, role, casa, phone, email, preferredCode) {
        try {
            await authReady();
            const condo = await getCondominio(condominioId);
            if (!condo) return null;

            const userRef = sub(condominioId, COL.users).doc();
            const user = {
                id: userRef.id, condominioId, name: name.trim(), role,
                casa: casa || '', phone: phone || '', email: email || '',
                paymentStatus: role === ROLES.VECINO ? PAYMENT_STATUS.AL_DIA : null,
                morosoSince: null, active: true, createdAt: nowIso()
            };

            // El codigo es el id del documento: si ya existe, la escritura se rechaza y se prueba otro
            let lastError = null;
            const proposed = normalizeCode(preferredCode);
            for (let attempt = 0; attempt < 12; attempt++) {
                const accessCode = attempt === 0 && /^[A-Z0-9]{4,8}$/.test(proposed) ? proposed : generateAccessCode(condo.name, name);
                const batch = db().batch();
                batch.set(db().collection(COL.codes).doc(accessCode), {
                    condominioId, userId: userRef.id, role, createdAt: nowIso()
                });
                batch.set(userRef, user);
                try {
                    await batch.commit();
                    refCache.set(`${COL.users}:${userRef.id}`, userRef);
                    return { ...user, accessCode };
                } catch (error) {
                    if (error.code !== 'permission-denied') throw error;
                    lastError = error;
                }
            }
            throw lastError;
        } catch (error) { reportError('createUser', error); return null; }
    }

    async function updateUser(userId, updates) {
        try {
            await authReady();
            const ref = await findRef(COL.users, userId);
            if (!ref) return null;
            const snap = await ref.get(SERVER);
            if (!snap.exists) return null;
            const current = toObj(COL.users, snap);

            const changes = { ...updates };
            delete changes.id;
            delete changes.condominioId;
            // Sello del cambio: el Sistema Financiero lo usa para saber que version del vecino es la mas nueva
            changes.updatedAt = nowIso();
            const requestedCode = changes.accessCode !== undefined ? normalizeCode(changes.accessCode) : null;
            delete changes.accessCode;

            // Auto-track morosoSince date when payment status changes
            if (changes.paymentStatus === PAYMENT_STATUS.MOROSO) {
                if (!current.morosoSince) changes.morosoSince = nowIso();
            } else if (changes.paymentStatus === PAYMENT_STATUS.AL_DIA) {
                changes.morosoSince = null; // Clear when payment is made
            }

            const batch = db().batch();
            let accessCode;
            let codeChanged = false;
            if (canReadCodes()) {
                const codeDocs = await codeDocsOfUser(current.condominioId, userId);
                accessCode = codeDocs.length ? codeDocs[0].id : '';
                if (requestedCode && requestedCode !== accessCode) {
                    if (!isSafeCode(requestedCode)) return null;
                    codeDocs.forEach((d) => batch.delete(d.ref));
                    batch.set(db().collection(COL.codes).doc(requestedCode), {
                        condominioId: current.condominioId, userId, role: current.role, createdAt: nowIso()
                    });
                    accessCode = requestedCode;
                    codeChanged = true;
                }
            }
            batch.update(ref, changes);
            try {
                await batch.commit();
            } catch (error) {
                // Un codigo ocupado rechaza la escritura completa
                if (codeChanged && error.code === 'permission-denied') {
                    console.error('updateUser: codigo en uso', requestedCode);
                    showToast('Ese código ya está en uso por otro usuario', 'warning');
                    return null;
                }
                throw error;
            }

            const updated = { ...current, ...changes };
            if (accessCode !== undefined) updated.accessCode = accessCode;
            return updated;
        } catch (error) { reportError('updateUser', error); return null; }
    }

    // Elimina al usuario con su codigo, vehiculos y visitas
    async function deleteUser(userId) {
        try {
            await authReady();
            const ref = await findRef(COL.users, userId);
            if (!ref) return false;
            const condominioId = ref.parent.parent.id;
            const [codes, vehicles, visits] = await Promise.all([
                codeDocsOfUser(condominioId, userId),
                sub(condominioId, COL.vehicles).where('userId', '==', userId).get(SERVER),
                sub(condominioId, COL.visits).where('userId', '==', userId).get(SERVER)
            ]);
            const refs = [...codes, ...vehicles.docs, ...visits.docs].map((d) => d.ref);
            refs.push(ref);
            await commitInChunks(refs, (batch, docRef) => batch.delete(docRef));
            refCache.delete(`${COL.users}:${userId}`);
            return true;
        } catch (error) { reportError('deleteUser', error); return false; }
    }

    // true si el vecino tiene cargos o pagos en el Sistema Financiero (no conviene eliminarlo)
    async function hasFinanceMovements(condominioId, userId) {
        try {
            await authReady();
            const snap = await sub(condominioId, 'finanzas_movimientos').where('resiId', '==', userId).limit(1).get(SERVER);
            return !snap.empty;
        } catch (error) { console.warn('hasFinanceMovements', error); return false; }
    }

    async function getUsersByPaymentStatus(condominioId, status) {
        try {
            await authReady();
            const snap = await sub(condominioId, COL.users).where('paymentStatus', '==', status).get(SERVER);
            return snap.docs.map((d) => toObj(COL.users, d));
        } catch (error) { reportError('getUsersByPaymentStatus', error); return []; }
    }

    // ══════════════════════════════════
    //  Visit CRUD
    // ══════════════════════════════════
    // Ejecuta una consulta en un condominio, o en todos si el master no indica uno
    async function queryAcrossCondos(kind, condominioId, build) {
        const scope = condominioId || sessionCondoId();
        if (scope) {
            const snap = await build(sub(scope, kind)).get(SERVER);
            return snap.docs.map((d) => toObj(kind, d));
        }
        const condos = await db().collection(COL.condos).get(SERVER);
        const results = await Promise.all(condos.docs.map((c) => build(c.ref.collection(kind)).get(SERVER)));
        return results.flatMap((snap) => snap.docs.map((d) => toObj(kind, d)));
    }

    async function getVisits(condominioId) {
        try {
            await authReady();
            const visits = await queryAcrossCondos(COL.visits, condominioId, (q) => q);
            return visits.sort(byCreatedDesc);
        } catch (error) { reportError('getVisits', error); return []; }
    }

    async function getVisitsByUser(userId) {
        try {
            await authReady();
            const visits = await queryAcrossCondos(COL.visits, null, (q) => q.where('userId', '==', userId));
            return visits.sort(byCreatedDesc);
        } catch (error) { reportError('getVisitsByUser', error); return []; }
    }

    // Visitas con fecha (YYYY-MM-DD) dentro del rango, ambos extremos incluidos
    async function getVisitsBetween(condominioId, fromDate, toDate) {
        try {
            await authReady();
            const visits = await queryAcrossCondos(COL.visits, condominioId,
                (q) => q.where('visitDate', '>=', fromDate).where('visitDate', '<=', toDate));
            return visits.sort(byCreatedDesc);
        } catch (error) { reportError('getVisitsBetween', error); return null; }
    }

    function getTodayVisits(condominioId) {
        return shared(`todayVisits:${condominioId || sessionCondoId() || ''}`, async () => {
            try {
                await authReady();
                const today = localToday();
                return await queryAcrossCondos(COL.visits, condominioId, (q) => q.where('visitDate', '==', today));
            } catch (error) { reportError('getTodayVisits', error); return []; }
        });
    }

    async function createVisit(condominioId, userId, visitorName, visitorInfo, vehiclePlate, visitDate, visitTime, casa) {
        try {
            await authReady();
            const visitCode = 'VIS' + Date.now().toString(36).toUpperCase() + uniqueSuffix();
            let timeFormatted = visitTime;
            if (timeFormatted && timeFormatted.length === 5) timeFormatted = timeFormatted + ':00';

            const ref = sub(condominioId, COL.visits).doc();
            const plate = (vehiclePlate || '').toUpperCase();
            const data = {
                id: ref.id, condominioId, userId, visitorName: visitorName.trim(), visitorInfo: visitorInfo || '',
                vehiclePlate: plate, plateNorm: normalizePlate(plate),
                visitDate: visitDate || localToday(), visitTime: timeFormatted || null,
                casa: casa || '', qrCode: visitCode, status: VISIT_STATUS.PENDING,
                visitType: null, endDate: null, enteredAt: null, createdAt: nowIso()
            };
            await ref.set(data);
            refCache.set(`${COL.visits}:${ref.id}`, ref);
            return data;
        } catch (error) { reportError('createVisit', error); return null; }
    }

    async function updateVisit(visitId, updates) {
        try {
            await authReady();
            const ref = await findRef(COL.visits, visitId);
            if (!ref) return null;
            const changes = { ...updates };
            delete changes.id;
            if (changes.vehiclePlate !== undefined) {
                changes.vehiclePlate = String(changes.vehiclePlate || '').toUpperCase();
                changes.plateNorm = normalizePlate(changes.vehiclePlate);
            }
            await ref.update(changes);
            const snap = await ref.get(SERVER);
            return snap.exists ? toObj(COL.visits, snap) : null;
        } catch (error) { reportError('updateVisit', error); return null; }
    }

    async function getVisitByQR(qrCode) {
        try {
            await authReady();
            const code = normalizeCode(qrCode);
            if (!code) return null;
            const found = await queryAcrossCondos(COL.visits, null, (q) => q.where('qrCode', '==', code).limit(1));
            return found[0] || null;
        } catch (error) { reportError('getVisitByQR', error); return null; }
    }

    async function markVisitAsEntered(visitId) {
        return updateVisit(visitId, { status: VISIT_STATUS.ENTERED, enteredAt: nowIso() });
    }

    // ══════════════════════════════════
    //  Vehicle / Marbete
    // ══════════════════════════════════
    async function getVehicles(userId) {
        try {
            await authReady();
            return await queryAcrossCondos(COL.vehicles, null, (q) => (userId ? q.where('userId', '==', userId) : q));
        } catch (error) { reportError('getVehicles', error); return []; }
    }

    async function createVehicle(userId, condominioId, plate, brand, model, color) {
        try {
            await authReady();
            const marbeteCode = 'MAR' + Date.now().toString(36).toUpperCase() + uniqueSuffix();
            const ref = sub(condominioId, COL.vehicles).doc();
            const cleanPlate = (plate || '').toUpperCase();
            const data = {
                id: ref.id, condominioId, userId, plate: cleanPlate, plateNorm: normalizePlate(cleanPlate),
                brand: brand || '', model: model || '', color: color || '', marbeteCode, createdAt: nowIso()
            };
            await ref.set(data);
            refCache.set(`${COL.vehicles}:${ref.id}`, ref);
            return data;
        } catch (error) { reportError('createVehicle', error); return null; }
    }

    async function getVehicleByQR(qrCode) {
        try {
            await authReady();
            const code = normalizeCode(qrCode);
            if (!code) return null;
            const found = await queryAcrossCondos(COL.vehicles, null, (q) => q.where('marbeteCode', '==', code).limit(1));
            return found[0] || null;
        } catch (error) { reportError('getVehicleByQR', error); return null; }
    }

    async function deleteVehicle(vehicleId) {
        try {
            await authReady();
            const ref = await findRef(COL.vehicles, vehicleId);
            if (!ref) return false;
            await ref.delete();
            refCache.delete(`${COL.vehicles}:${vehicleId}`);
            return true;
        } catch (error) { reportError('deleteVehicle', error); return false; }
    }

    // ══════════════════════════════════
    //  Messages
    // ══════════════════════════════════
    function getMessages(condominioId) {
        return shared(`messages:${condominioId || sessionCondoId() || ''}`, async () => {
            try {
                await authReady();
                const role = sessionRole();
                const scope = condominioId || sessionCondoId();
                const seesAll = [ROLES.MASTER, ROLES.ADMIN, ROLES.AUDITOR].includes(role);
                const filter = (q) => (seesAll ? q : q.where('toRole', 'in', ['all', role]));

                const local = scope ? filter(sub(scope, COL.messages)) : db().collectionGroup(COL.messages);
                const [localSnap, globalSnap] = await Promise.all([
                    local.get(SERVER),
                    filter(db().collection(COL.globalMessages)).get(SERVER)
                ]);
                return [...localSnap.docs, ...globalSnap.docs].map((d) => toObj(COL.messages, d)).sort(byCreatedDesc);
            } catch (error) { reportError('getMessages', error); return []; }
        });
    }

    async function createMessage(condominioId, fromName, toRole, subject, body) {
        try {
            await authReady();
            const isGlobal = !condominioId || condominioId === 'all';
            const ref = isGlobal
                ? db().collection(COL.globalMessages).doc()
                : sub(condominioId, COL.messages).doc();
            const data = {
                id: ref.id, condominioId: isGlobal ? 'all' : condominioId, fromName: fromName || 'SISDEL',
                toRole: toRole || 'all', subject: subject || '', body, read: false, createdAt: nowIso()
            };
            await ref.set(data);
            refCache.set(`${COL.messages}:${ref.id}`, ref);
            return data;
        } catch (error) { reportError('createMessage', error); return null; }
    }

    async function markMessageRead(messageId) {
        try {
            await authReady();
            const ref = await findRef(COL.messages, messageId);
            if (!ref) return false;
            await ref.update({ read: true });
            return true;
        } catch (error) { reportError('markMessageRead', error); return false; }
    }

    async function deleteMessage(messageId) {
        try {
            await authReady();
            const ref = await findRef(COL.messages, messageId);
            if (!ref) return false;
            await ref.delete();
            refCache.delete(`${COL.messages}:${messageId}`);
            return true;
        } catch (error) { reportError('deleteMessage', error); return false; }
    }

    // ══════════════════════════════════
    //  Camera logs (historial de garita y camara LPR)
    // ══════════════════════════════════
    async function createCameraLog(condominioId, plate, status, reason) {
        try {
            await authReady();
            const ref = sub(condominioId, COL.cameraLogs).doc();
            const data = {
                id: ref.id, condominioId, plate: String(plate || '').toUpperCase(),
                status, reason: reason || '', createdAt: nowIso()
            };
            await ref.set(data);
            return data;
        } catch (error) { reportError('createCameraLog', error); return null; }
    }

    async function getCameraLogsToday(condominioId, max = 15) {
        try {
            await authReady();
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            const snap = await sub(condominioId, COL.cameraLogs)
                .where('createdAt', '>=', startOfDay)
                .orderBy('createdAt', 'desc')
                .limit(max)
                .get(SERVER);
            return snap.docs.map((d) => toObj(COL.cameraLogs, d));
        } catch (error) { reportError('getCameraLogsToday', error); return []; }
    }

    // Registros entre dos instantes ISO [desde, hasta), del mas nuevo al mas viejo.
    // Devuelve null si la consulta falla, para no confundir un error con "sin registros"
    async function getCameraLogsBetween(condominioId, fromIso, toIso, max = 5000) {
        try {
            await authReady();
            const snap = await sub(condominioId, COL.cameraLogs)
                .where('createdAt', '>=', fromIso)
                .where('createdAt', '<', toIso)
                .orderBy('createdAt', 'desc')
                .limit(max)
                .get(SERVER);
            return snap.docs.map((d) => toObj(COL.cameraLogs, d));
        } catch (error) { reportError('getCameraLogsBetween', error); return null; }
    }

    // Avisa en tiempo real cada registro nuevo. Devuelve la funcion para dejar de escuchar
    function subscribeCameraLogs(condominioId, onLog) {
        let firstSnapshot = true;
        return sub(condominioId, COL.cameraLogs)
            .orderBy('createdAt', 'desc')
            .limit(5)
            .onSnapshot((snap) => {
                // La primera respuesta trae el historial existente: no son eventos nuevos
                if (firstSnapshot) { firstSnapshot = false; return; }
                snap.docChanges().forEach((change) => {
                    if (change.type === 'added') onLog(toObj(COL.cameraLogs, change.doc));
                });
            }, (error) => reportError('subscribeCameraLogs', error));
    }

    // ══════════════════════════════════
    //  Auth / Session
    // ══════════════════════════════════
    async function login(code) {
        const trimmed = normalizeCode(code);
        const { auth, functions } = services();
        const startedAt = performance.now();

        const result = await functions.httpsCallable('login')({ code: trimmed });
        const callableMs = Math.round(performance.now() - startedAt);
        const data = result.data || {};
        if (!data.success) return { success: false, error: data.error || 'Código de acceso no válido' };

        // La sesion vive solo en esta pestana, igual que sessionStorage
        await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
        await auth.signInWithCustomToken(data.token);

        const session = { ...data.session, loggedAt: nowIso() };
        sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
        // Tiempos del login; la siguiente pagina los reporta junto con su propia carga
        sessionStorage.setItem(STORAGE_KEYS.loginTiming, JSON.stringify({
            callable: callableMs, signIn: Math.round(performance.now() - startedAt) - callableMs
        }));

        return { success: true, role: data.role, redirect: data.redirect, user: data.user };
    }

    function getSession() {
        try { return JSON.parse(sessionStorage.getItem(STORAGE_KEYS.session)); } catch { return null; }
    }

    function clearSession() { sessionStorage.removeItem(STORAGE_KEYS.session); }

    // Copia local del Sistema Financiero (OIKOS guarda en localStorage con prefijo oikos_).
    // Los datos viven en Firestore: al salir se borra la copia del equipo, salvo que tenga
    // cambios que todavia no subieron (marca sisdel_fin_pendiente_*; ver finanzas-sync.js).
    function clearFinanceCache() {
        try {
            const keys = Object.keys(localStorage);
            if (keys.some((k) => k.startsWith('sisdel_fin_pendiente_'))) return;
            keys.filter((k) => k.startsWith('oikos_')).forEach((k) => localStorage.removeItem(k));
        } catch { /* sin acceso a localStorage */ }
    }

    function logout() {
        clearSession();
        clearFinanceCache();
        const leave = () => { window.location.href = 'index.html'; };
        try { services().auth.signOut().then(leave, leave); } catch { leave(); }
    }

    async function requireAuth(allowedRoles) {
        const session = getSession();
        if (!session) { window.location.href = 'index.html'; return null; }
        if (allowedRoles && !allowedRoles.includes(session.role)) { window.location.href = 'index.html'; return null; }

        // La sesion guardada debe coincidir con el usuario autenticado en Firebase
        const user = await authReady();
        const expectedUid = session.role === ROLES.MASTER ? 'master' : session.userId;
        if (!user || user.uid !== expectedUid) {
            clearSession();
            window.location.href = 'index.html';
            return null;
        }
        return session;
    }

    // ══════════════════════════════════
    //  UI Helpers
    // ══════════════════════════════════
    function showToast(message, type = 'info') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const icons = {
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div class="toast-icon" style="color: var(--${type === 'error' ? 'danger' : type})">${icons[type] || icons.info}</div><span class="toast-message">${message}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        // Reemplazamos guiones por barras solo para fechas YYYY-MM-DD
        const isISO = typeof dateStr === 'string' && dateStr.includes('T');
        const normalizedDate = (typeof dateStr === 'string' && !isISO) ? dateStr.replace(/-/g, '/') : dateStr;
        return new Date(normalizedDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function formatDateTime(dateStr) {
        if (!dateStr) return '';
        const isISO = typeof dateStr === 'string' && dateStr.includes('T');
        const normalizedDate = (typeof dateStr === 'string' && !isISO) ? dateStr.replace(/-/g, '/') : dateStr;
        return new Date(normalizedDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function getRoleName(role) {
        const names = { [ROLES.ADMIN]: 'Administrador', [ROLES.VECINO]: 'Vecino', [ROLES.POLICIA]: 'Policía / Guardia', [ROLES.AUDITOR]: 'Auditor', [ROLES.SUPERVISOR]: 'Supervisor de rondas', [ROLES.MASTER]: 'Master' };
        return names[role] || role;
    }

    function getPaymentBadge(status) {
        if (status === PAYMENT_STATUS.AL_DIA) return '<span class="badge badge-success">Al día</span>';
        if (status === PAYMENT_STATUS.MOROSO) return '<span class="badge badge-danger">Moroso</span>';
        return '';
    }

    function confirmDialog(message) { return confirm(message); }

    // Los datos de demostracion ya no se siembran desde el navegador
    async function seedDemoData() { return; }

    // ── Diagnostico: cuanto tarda cada pagina en quedar lista, medido en el navegador del usuario ──
    // Se guarda en la coleccion _diag (solo la lee el master). Nunca debe afectar a la pagina.
    function reportPageLoad(page) {
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            const conn = navigator.connection || {};
            const session = getSession() || {};
            let loginTiming = null;
            try { loginTiming = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.loginTiming)); } catch { /* sin datos */ }
            sessionStorage.removeItem(STORAGE_KEYS.loginTiming);
            const user = services().auth.currentUser;
            db().collection('_diag').add({
                page,
                at: nowIso(),
                uid: user ? user.uid : null,
                role: session.role || null,
                condominioId: session.condominioId || null,
                ms: {
                    total: Math.round(performance.now()),
                    domReady: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
                    authReady: authReadyMs,
                    login: loginTiming
                },
                net: {
                    type: conn.effectiveType || null,
                    rtt: typeof conn.rtt === 'number' ? conn.rtt : null,
                    downlink: typeof conn.downlink === 'number' ? conn.downlink : null
                },
                ua: String(navigator.userAgent).slice(0, 200)
            }).catch((error) => console.warn('diag', error));
        } catch (error) { console.warn('diag', error); }
    }

    // Public API
    return {
        ROLES, PAYMENT_STATUS, VISIT_STATUS,
        getCondominios, getCondominio, createCondominio, updateCondominio, deactivateCondominio, activateCondominio, deleteCondominio, toggleCondoSetting,
        getUsers, getUserByCode, getUserById, createUser, updateUser, deleteUser, hasFinanceMovements, getUsersByPaymentStatus, generateAccessCode, isValidCodeFormat,
        getVisits, getVisitsByUser, getVisitsBetween, getTodayVisits, createVisit, updateVisit, getVisitByQR, markVisitAsEntered,
        getVehicles, createVehicle, getVehicleByQR, deleteVehicle,
        getMessages, createMessage, markMessageRead, deleteMessage,
        createCameraLog, getCameraLogsToday, getCameraLogsBetween, subscribeCameraLogs,
        login, getSession, logout, requireAuth, reportPageLoad,
        showToast, formatDate, formatDateTime, getRoleName, getPaymentBadge, confirmDialog, seedDemoData
    };
})();
