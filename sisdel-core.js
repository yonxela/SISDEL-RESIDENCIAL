/* ═══════════════════════════════════════════════════════════════
   SISDEL Core Cloud - Firebase (Firestore + Auth + Functions)
   Datos aislados por condominio: condominios/{condoId}/...
   ═══════════════════════════════════════════════════════════════ */

const SISDEL = (() => {
    // ── Constants ──
    const STORAGE_KEYS = { session: 'sisdel_session', loginTiming: 'sisdel_login_timing' };

    const ROLES = { MASTER: 'master', ADMIN: 'admin', VECINO: 'vecino', POLICIA: 'policia', AUDITOR: 'auditor', SUPERVISOR: 'supervisor', OPERADOR: 'operador' };
    // Catalogo de privilegios (privilegios.js, cargado antes que este archivo)
    const PRIV = window.SisdelPrivilegios;
    if (!PRIV) throw new Error('Falta privilegios.js: debe cargarse antes que sisdel-core.js');
    const PAYMENT_STATUS = { AL_DIA: 'al_dia', MOROSO: 'moroso' };
    const VISIT_STATUS = { PENDING: 'pending', ENTERED: 'entered', COMPLETED: 'completed' };

    const COL = {
        condos: 'condominios', users: 'usuarios', visits: 'visitas', vehicles: 'vehiculos',
        messages: 'mensajes', cameraLogs: 'camera_logs', exits: 'salidas',
        globalMessages: 'mensajes_globales', codes: 'codigos', templates: 'plantillas_privilegios'
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

    // ── Privilegios: el rol trae unos por defecto y el administrador los amplia o restringe por usuario ──
    // La sesion guarda solo las diferencias (session.privilegios); el catalogo calcula el resto.
    // Esto decide que se muestra: lo que realmente se permite lo deciden las reglas de Firestore.
    function can(key) {
        const session = getSession();
        return !!session && PRIV.has(session.role, session.privilegios, key);
    }
    function canAny(keys) { return keys.some(can); }
    function effectivePrivileges() {
        const session = getSession();
        return session ? PRIV.effective(session.role, session.privilegios) : {};
    }
    // Pagina a la que debe ir el usuario al entrar (o cuando la actual no le corresponde)
    function homePage() {
        const session = getSession();
        if (!session) return 'index.html';
        return session.role === ROLES.MASTER ? 'master.html' : PRIV.landing(session.role, session.privilegios);
    }
    // Boton de salida de una pagina: en el panel principal del usuario (homePage) cierra la sesion ("Salir"); en cualquier otro
    // panel es "Regresar al panel principal" y no cierra la sesion. Asi hay un solo "Salir" en todo el sistema.
    // Devuelve true si el boton regresa al panel principal.
    function bindExitButton(button, currentPage) {
        if (!button) return false;
        const home = homePage();
        const toHome = !!home && home !== currentPage && home !== 'index.html';
        if (toHome) {
            const label = 'Regresar al panel principal';
            const icon = button.querySelector('svg');
            [...button.childNodes].filter((node) => node.nodeType === 3).forEach((node) => node.remove());
            button.appendChild(document.createTextNode(' ' + label));
            if (icon) icon.innerHTML = '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>';
            button.setAttribute('title', label);
        }
        button.addEventListener('click', () => { if (toHome) window.location.href = home; else logout(); });
        return toHome;
    }

    // Otras paginas a las que el usuario puede entrar (para los botones de cada panel)
    function otherPanels(currentPage) {
        const session = getSession();
        if (!session || session.role === ROLES.MASTER) return [];
        // El panel del vecino (vecino.html) solo se ofrece a un vecino que tiene ademas otros paneles (p. ej. un fiscalizador)
        return PRIV.pagesFor(session.role, session.privilegios).filter((p) => p.page !== currentPage && (p.page !== 'vecino.html' || session.role === ROLES.VECINO));
    }

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
    // Elimina un condominio completo. Aunque ya haya sesion master, el servidor vuelve a pedir la clave master y el nombre
    // del condominio. Devuelve { ok: true, usuarios, codigos, cuentas } o { ok: false, error } con el motivo en español.
    async function deleteCondominio(id, masterCode, confirmName) {
        try {
            await authReady();
            const result = await services().functions.httpsCallable('deleteCondominio', { timeout: 540000 })({ condominioId: id, masterCode, confirmName });
            return { ok: true, ...(result.data || {}) };
        } catch (error) {
            console.error('deleteCondominio', error && error.code);
            // El servidor da el motivo en español; se quita el sufijo tecnico "[403]" que a veces agrega el cliente
            return { ok: false, error: String((error && error.message) || 'No se pudo eliminar el condominio').replace(/\s*\[\d{3}\]\s*$/, '') };
        }
    }

    // ══════════════════════════════════
    //  Codigos de acceso (coleccion aparte: guardias y vecinos no pueden leerlos)
    // ══════════════════════════════════
    function canReadCodes() { return isMasterSession() || can('usuarios.codigos'); }

    // Quien ve codigos sin poder asignar privilegios no ve los de administradores y operadores (las reglas lo exigen)
    const PLAIN_ROLES = [ROLES.VECINO, ROLES.POLICIA, ROLES.AUDITOR, ROLES.SUPERVISOR];
    function onlyPlainCodes(query) {
        return isMasterSession() || can('usuarios.privilegios') ? query : query.where('role', 'in', PLAIN_ROLES);
    }

    // Mapa userId -> codigo. Devuelve null si el rol no puede ver codigos
    async function codesByUser(condominioId) {
        if (!canReadCodes()) return null;
        const scope = condominioId || sessionCondoId();
        let query = db().collection(COL.codes);
        if (scope) query = query.where('condominioId', '==', scope);
        query = onlyPlainCodes(query);
        const snap = await query.get(SERVER);
        const map = new Map();
        snap.docs.forEach((d) => map.set(d.data().userId, d.id));
        return map;
    }

    async function codeDocsOfUser(condominioId, userId) {
        const snap = await onlyPlainCodes(db().collection(COL.codes)
            .where('condominioId', '==', condominioId)
            .where('userId', '==', userId))
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
    // extra: { privilegios, cargo } (solo diferencias con los privilegios del rol; ver privilegios.js)
    async function createUser(condominioId, name, role, casa, phone, email, preferredCode, extra) {
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
            const overrides = PRIV.cleanOverrides(extra && extra.privilegios);
            if (Object.keys(overrides).length) user.privilegios = overrides;
            if (extra && extra.cargo) user.cargo = String(extra.cargo).trim().slice(0, 60);

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

    // Privilegios y cargo de un usuario. `privilegios` son solo las diferencias con su rol (privilegios.toOverrides);
    // vacio = vuelve a los del rol. Las reglas exigen usuarios.privilegios y no dejan cambiarse los propios.
    async function setUserAccess(userId, { privilegios, cargo } = {}) {
        try {
            await authReady();
            const ref = await findRef(COL.users, userId);
            if (!ref) return false;
            const overrides = PRIV.cleanOverrides(privilegios);
            const changes = {
                privilegios: Object.keys(overrides).length ? overrides : firebase.firestore.FieldValue.delete(),
                updatedAt: nowIso()
            };
            if (cargo !== undefined) changes.cargo = String(cargo || '').trim().slice(0, 60);
            await ref.update(changes);
            return true;
        } catch (error) { reportError('setUserAccess', error); return false; }
    }

    // ── Plantillas de privilegios propias del condominio (las del sistema estan en privilegios.js) ──
    async function getPrivilegeTemplates(condominioId) {
        try {
            await authReady();
            const snap = await sub(condominioId || sessionCondoId(), COL.templates).get(SERVER);
            return snap.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        } catch (error) { reportError('getPrivilegeTemplates', error); return []; }
    }

    async function savePrivilegeTemplate(condominioId, { id, name, role, claves, description }) {
        try {
            await authReady();
            const ref = id ? sub(condominioId, COL.templates).doc(id) : sub(condominioId, COL.templates).doc();
            const valid = (claves || []).filter((k) => PRIV.itemOf(k));
            await ref.set({
                id: ref.id, condominioId, name: String(name || '').trim().slice(0, 60), role: PRIV.ROLES.includes(role) ? role : 'operador',
                description: String(description || '').trim().slice(0, 200), claves: valid, updatedAt: nowIso()
            });
            return ref.id;
        } catch (error) { reportError('savePrivilegeTemplate', error); return null; }
    }

    async function deletePrivilegeTemplate(condominioId, id) {
        try {
            await authReady();
            await sub(condominioId, COL.templates).doc(id).delete();
            return true;
        } catch (error) { reportError('deletePrivilegeTemplate', error); return false; }
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

    // Salida de una visita que ya ingreso: solo agrega la hora (el estado sigue siendo "entered")
    async function markVisitAsExited(visitId) {
        return updateVisit(visitId, { exitedAt: nowIso() });
    }

    // Una visita esta dentro si ingreso y no ha salido despues de ese ingreso (un acceso temporal puede volver a entrar otro dia)
    function isVisitInside(visit) {
        return !!visit && !!visit.enteredAt && (!visit.exitedAt || visit.exitedAt < visit.enteredAt);
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
                const seesAll = role === ROLES.MASTER || can('mensajes.historial');
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

    // Salida de un vecino (kind: 'vehiculo' o 'residente'); las de las visitas se guardan en la propia visita (exitedAt)
    async function createExit(condominioId, kind, { plate, name, casa, userId, reason } = {}) {
        try {
            await authReady();
            const ref = sub(condominioId, COL.exits).doc();
            const data = {
                id: ref.id, condominioId, kind,
                plate: String(plate || '').toUpperCase(), name: name || '', casa: casa || '', userId: userId || '',
                reason: reason || '', createdAt: nowIso()
            };
            await ref.set(data);
            return data;
        } catch (error) { reportError('createExit', error); return null; }
    }

    // Salidas entre dos instantes ISO [desde, hasta), de la mas nueva a la mas vieja (null si la consulta falla)
    async function getExitsBetween(condominioId, fromIso, toIso, max = 5000) {
        try {
            await authReady();
            const snap = await sub(condominioId, COL.exits)
                .where('createdAt', '>=', fromIso)
                .where('createdAt', '<', toIso)
                .orderBy('createdAt', 'desc')
                .limit(max)
                .get(SERVER);
            return snap.docs.map((d) => toObj(COL.exits, d));
        } catch (error) { reportError('getExitsBetween', error); return null; }
    }

    async function getExitsToday(condominioId, max = 15) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
        return (await getExitsBetween(condominioId, start, end, max)) || [];
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

    // `to`: pagina a la que se va al salir (por defecto el login). RONDIN vive en rondin/ y sale a ../index.html
    function logout(to) {
        const destination = typeof to === 'string' && to ? to : 'index.html';
        clearSession();
        clearFinanceCache();
        const leave = () => { window.location.href = destination; };
        try { services().auth.signOut().then(leave, leave); } catch { leave(); }
    }

    // Vuelve a leer la ficha del usuario para tomar sus privilegios, rol y nombre actuales: el administrador
    // pudo cambiarlos despues del login. Sin conexion se sigue con lo que trajo el login.
    async function refreshAccess() {
        const session = getSession();
        if (!session || session.role === ROLES.MASTER) return { ok: true, changed: false };
        try {
            await authReady();
            const snap = await sub(session.condominioId, COL.users).doc(session.userId).get(SERVER);
            if (!snap.exists || snap.data().active === false) return { ok: false, changed: false };
            const data = snap.data();
            const next = {
                ...session, role: data.role, userName: data.name || session.userName, userCasa: data.casa || '',
                privilegios: PRIV.cleanOverrides(data.privilegios), cargo: data.cargo || ''
            };
            const changed = JSON.stringify([session.role, session.privilegios || {}]) !== JSON.stringify([next.role, next.privilegios]);
            sessionStorage.setItem(STORAGE_KEYS.session, JSON.stringify(next));
            return { ok: true, changed };
        } catch (error) {
            const code = String((error && error.code) || '');
            // Sin permiso: el usuario o el condominio ya no estan activos
            if (code.includes('permission-denied')) return { ok: false, changed: false };
            console.warn('refreshAccess', error);
            return { ok: true, changed: false, stale: true };
        }
    }

    // page: pagina que se abre (ver PAGES en privilegios.js). Con ella manda el catalogo de privilegios;
    // sin ella (master.html) basta con el rol. Si el usuario no puede estar aqui, va a la pagina que si le toca.
    async function requireAuth(allowedRoles, page) {
        const session = getSession();
        if (!session) { window.location.href = 'index.html'; return null; }
        if (session.role === ROLES.MASTER) {
            if (allowedRoles && !allowedRoles.includes(ROLES.MASTER)) { window.location.href = 'master.html'; return null; }
        } else if (!page && allowedRoles && !allowedRoles.includes(session.role)) { window.location.href = 'index.html'; return null; }

        // La sesion guardada debe coincidir con el usuario autenticado en Firebase
        const user = await authReady();
        const expectedUid = session.role === ROLES.MASTER ? 'master' : session.userId;
        if (!user || user.uid !== expectedUid) {
            clearSession();
            window.location.href = 'index.html';
            return null;
        }
        if (session.role === ROLES.MASTER) return session;

        const fresh = await refreshAccess();
        if (!fresh.ok) { clearSession(); window.location.href = 'index.html'; return null; }
        const current = getSession();
        if (page) {
            const entry = PRIV.PAGES.find((p) => p.page === page);
            if (!entry || !PRIV.canEnter(current.role, current.privilegios, entry)) {
                const home = PRIV.landing(current.role, current.privilegios);
                window.location.href = home && home !== page ? home : 'index.html';
                return null;
            }
        }
        return current;
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

    // Copia un texto al portapapeles (por ejemplo un codigo de acceso). Usa el portapapeles del navegador y, si no esta
    // disponible (pagina sin https, navegador viejo), un campo oculto.
    async function copyText(text, message = 'Copiado') {
        const value = String(text == null ? '' : text);
        let copied = false;
        try {
            if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); copied = true; }
        } catch (error) { copied = false; }
        if (!copied) {
            const area = document.createElement('textarea');
            area.value = value;
            area.setAttribute('readonly', '');
            area.style.cssText = 'position:fixed; top:0; left:0; opacity:0;';
            document.body.appendChild(area);
            area.select();
            try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
            area.remove();
        }
        showToast(copied ? message : 'No se pudo copiar', copied ? 'success' : 'warning');
        return copied;
    }

    // Boton "Copiar" de un codigo. Un clic en cualquier elemento con data-copy copia ese valor (ver el escuchador de abajo).
    // El valor se escapa: los codigos los escriben otros usuarios.
    function copyButton(value, label = 'Copiar código') {
        const safe = String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        return `<button type="button" class="btn btn-ghost btn-icon" data-copy="${safe}" title="${label}" aria-label="${label}" style="width:auto; height:auto; padding:0.2rem; vertical-align:middle;">`
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>';
    }
    // El boton avisa que copio: el icono (o el texto) pasa a una palomita verde un momento y vuelve a lo de antes.
    // Si no se pudo copiar, queda una cruz roja. El aviso emergente tambien sale, pero puede pasar desapercibido.
    const COPY_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const COPY_FAIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    function flashCopied(button, copied) {
        if (button._copyTimer) clearTimeout(button._copyTimer);
        else button._copyBefore = { html: button.innerHTML, title: button.getAttribute('title'), label: button.getAttribute('aria-label'), color: button.style.color };
        const before = button._copyBefore;
        const iconOnly = button.classList.contains('btn-icon');
        const mark = copied ? COPY_CHECK : COPY_FAIL;
        const word = copied ? 'Copiado' : 'No se pudo copiar';
        button.innerHTML = iconOnly ? mark : `${mark} ${word}`;
        button.style.color = copied ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)';
        button.setAttribute('title', word);
        button.setAttribute('aria-label', word);
        button._copyTimer = setTimeout(() => {
            button.innerHTML = before.html;
            button.style.color = before.color;
            if (before.title === null) button.removeAttribute('title'); else button.setAttribute('title', before.title);
            if (before.label === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', before.label);
            button._copyTimer = null;
            button._copyBefore = null;
        }, 1800);
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('click', (event) => {
            const button = event.target && event.target.closest ? event.target.closest('[data-copy]') : null;
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            copyText(button.getAttribute('data-copy'), 'Código copiado').then((copied) => flashCopied(button, copied));
        });
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
        const names = { [ROLES.ADMIN]: 'Administrador', [ROLES.VECINO]: 'Vecino', [ROLES.POLICIA]: 'Policía / Guardia', [ROLES.AUDITOR]: 'Auditor', [ROLES.SUPERVISOR]: 'Supervisor de rondas', [ROLES.OPERADOR]: 'Operador', [ROLES.MASTER]: 'Master' };
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
        PRIV, can, canAny, effectivePrivileges, homePage, otherPanels, bindExitButton, refreshAccess,
        setUserAccess, getPrivilegeTemplates, savePrivilegeTemplate, deletePrivilegeTemplate,
        getUsers, getUserByCode, getUserById, createUser, updateUser, deleteUser, hasFinanceMovements, getUsersByPaymentStatus, generateAccessCode, isValidCodeFormat,
        getVisits, getVisitsByUser, getVisitsBetween, getTodayVisits, createVisit, updateVisit, getVisitByQR, markVisitAsEntered, markVisitAsExited, isVisitInside,
        getVehicles, createVehicle, getVehicleByQR, deleteVehicle,
        getMessages, createMessage, markMessageRead, deleteMessage,
        createCameraLog, getCameraLogsToday, getCameraLogsBetween, subscribeCameraLogs,
        createExit, getExitsBetween, getExitsToday,
        login, getSession, logout, requireAuth, reportPageLoad, localToday,
        showToast, copyText, copyButton, formatDate, formatDateTime, getRoleName, getPaymentBadge, confirmDialog, seedDemoData
    };
})();
