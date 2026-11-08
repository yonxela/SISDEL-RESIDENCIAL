/* ═══════════════════════════════════════════════════════════════
   SISDEL RONDÍN sobre la base de SISDEL
   ───────────────────────────────────────────────────────────────
   Las pantallas de RONDIN (rondin/js/app.js, rondin/css/style.css,
   rondin/js/i18n.js) se usan tal cual. Este archivo reemplaza a su cliente
   de API (api.js) y a socket.io: en lugar de su servidor Express + SQLite,
   responde las mismas rutas /api/... con Firestore.

   Una sola base:
     - Empresa de RONDIN      = condominio de SISDEL (condominios/{id}).
     - Guardias, supervisores = usuarios de SISDEL (policia, supervisor), con su
       mismo codigo de acceso (el "PIN" de RONDIN).
     - Director general       = administrador del condominio (el auditor ve lo
       mismo, sin poder modificar).
     - Vecinos                = vecinos de SISDEL. Su DPI vive en
       finanzas_residentes (el mismo del Sistema Financiero) y sus familiares en
       emergencia/{id} (los mismos del boton de panico de SISDEL).
     - Panico                 = alertas_panico de SISDEL (garita, admin, WhatsApp).
   Datos propios de rondas (formato de RONDIN, fechas 'AAAA-MM-DD HH:MM:SS' UTC):
     rondas_rutas (con sus puntos), rondas_asignaciones, rondas_turnos,
     rondas_rondas, rondas_visitas, rondas_ubicaciones, rondas_en_vivo/{id},
     rondas_incidentes, rondas_alertas, rondas_fotos, rondas_personal/{id},
     rondas_config/general, rondas_drones.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const TZ = 'America/Guatemala';
    const SIREN_MS = 60000;
    const ROLE_OUT = { admin: 'DIRECTOR_GENERAL', policia: 'GUARDIA', supervisor: 'SUPERVISOR', auditor: 'AUDITOR', vecino: 'NEIGHBOR', master: 'SUPER_ADMIN' };
    const ROLE_IN = { GUARDIA: 'policia', SUPERVISOR: 'supervisor', DIRECTOR_GENERAL: 'admin', ADMIN: 'admin' };
    const ALERT_TYPE_BY_SEVERITY = { CRITICAL: 'EMERGENCY', HIGH: 'URGENT' };

    // ── Sesion de SISDEL ──
    function session() { return SISDEL.getSession(); }
    function condoId() { return (session() || {}).condominioId; }
    function myId() { return (session() || {}).userId; }
    function myRole() { return (session() || {}).role; }
    // Privilegios del usuario (los asigna el administrador; ver privilegios.js). Las reglas de Firestore exigen
    // lo mismo: aqui solo se decide que pantalla de RONDIN se muestra.
    const can = (key) => SISDEL.can(key);
    const canManage = () => can('rondas.gestionar');
    const canPatrol = () => can('rondas.patrullar');
    // Pantalla de RONDIN: administra quien tiene rondas.gestionar (supervisor si ademas patrulla), patrulla quien
    // tiene rondas.patrullar y solo mira quien tiene rondas.ver (el auditor, en solo lectura)
    function rondinRoleFor(role, overrides) {
        const has = (key) => SISDEL.PRIV.has(role, overrides, key);
        if (role === 'vecino') return 'NEIGHBOR';
        if (role === 'master') return 'SUPER_ADMIN';
        if (has('rondas.gestionar')) return role === 'admin' ? 'DIRECTOR_GENERAL' : (has('rondas.patrullar') ? 'SUPERVISOR' : 'DIRECTOR_GENERAL');
        if (has('rondas.patrullar')) return 'GUARDIA';
        if (has('rondas.ver')) return 'DIRECTOR_GENERAL';
        return ROLE_OUT[role] || 'GUARDIA';
    }
    function rondinRole() { return rondinRoleFor(myRole(), (session() || {}).privilegios); }
    const asGuard = () => rondinRole() === 'GUARDIA';
    const isManager = () => canManage() || can('rondas.ver');
    const isPatroller = () => canPatrol();

    function apiUser() {
        const s = session();
        if (!s) return null;
        return {
            id: s.userId, company_id: s.condominioId, company_name: s.condominioName || '', name: s.userName || '',
            email: '', phone: '', role: rondinRole(), photo_url: null, status: 'ACTIVE', language: 'es', live_capture_enabled: 0
        };
    }

    // ── Firestore ──
    const fdb = () => window.sisdelFirebase.db;
    const col = (name) => fdb().collection('condominios').doc(condoId()).collection(name);
    const list = (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const one = (snap) => (snap.exists ? { ...snap.data(), id: snap.id } : null);
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2));

    // Usuario de Firebase Auth: al abrir la pagina se espera a que Firebase restaure la sesion
    let authPromise = null;
    function authReady() {
        const auth = window.sisdelFirebase.auth;
        if (auth.currentUser) return Promise.resolve(auth.currentUser);
        if (!authPromise) {
            authPromise = new Promise((resolve) => {
                const off = auth.onAuthStateChanged((u) => { off(); authPromise = null; resolve(u); });
            });
        }
        return authPromise;
    }

    // ── Fechas en el formato de RONDIN (SQLite, UTC) ──
    const sql = (date = new Date()) => new Date(date).toISOString().replace('T', ' ').slice(0, 19);
    const sqlFromIso = (iso) => (iso ? sql(new Date(iso)) : null);
    const ms = (s) => {
        if (!s) return 0;
        const t = String(s);
        return Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
    };
    const localDate = (when = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(when));
    const localDateOf = (s) => (s ? localDate(ms(s)) : '');
    const daysAgoSql = (days) => sql(Date.now() - days * 86400000);
    // Inicio del dia local (Guatemala, UTC-6) en formato SQL UTC
    const startOfLocalDaySql = (ymd = localDate()) => sql(Date.parse(ymd + 'T06:00:00Z'));

    async function quietSignOut() {
        sessionStorage.removeItem('sisdel_session');
        sessionStorage.removeItem('sisdel_neighbor');
        authPromise = null;
        try { await window.sisdelFirebase.auth.signOut(); } catch { /* sin sesion */ }
    }

    function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
    function readOnlyGuard() { if (!canManage() && !canPatrol()) throw err('Perfil de solo lectura: no puede modificar datos.', 403); }
    function friendly(e) {
        const code = String((e && e.code) || '');
        if (code.includes('permission-denied')) return err('Sin permisos para esta acción', 403);
        if (code.includes('unavailable')) return err('Error de conexión con el servidor', 503);
        return e;
    }

    // ── Cache corto para no repetir lecturas en una misma pantalla ──
    const cache = new Map();
    async function cached(key, ttlMs, fn) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await fn();
        cache.set(key, { at: Date.now(), value });
        return value;
    }
    const invalidate = (...keys) => keys.forEach((k) => cache.delete(k));

    // ── Personas (una sola base) ──
    async function sisdelUsers() {
        return cached('users', 4000, async () => {
            const users = await SISDEL.getUsers(condoId());
            // Quien puede registrar guardias ve el codigo de sus guardias (quien ve todos los codigos lo resuelve sisdel-core)
            if (can('guardias.crear') && !can('usuarios.codigos')) {
                try {
                    const snap = await fdb().collection('codigos').where('condominioId', '==', condoId()).where('role', '==', 'policia').get();
                    const codes = new Map(snap.docs.map((d) => [d.data().userId, d.id]));
                    users.forEach((u) => { if (u.role === 'policia' && codes.has(u.id)) u.accessCode = codes.get(u.id); });
                } catch (e) { console.warn('codigos', e.code || e.message); }
            }
            return users;
        });
    }
    async function personalMap() {
        if (!isManager()) return new Map();
        return cached('personal', 4000, async () => {
            try { return new Map(list(await col('rondas_personal').get()).map((p) => [p.id, p])); } catch { return new Map(); }
        });
    }
    function userOut(u, personal) {
        const p = (personal && personal.get(u.id)) || {};
        let profile = {};
        try { profile = JSON.parse(p.profile || '{}'); } catch { profile = {}; }
        // Un solo codigo por persona: el de SISDEL (solo el admin lo puede leer)
        if (u.accessCode) profile.access_code = u.accessCode;
        else delete profile.access_code;
        return {
            id: u.id, company_id: condoId(), name: u.name, email: u.email || '', phone: u.phone || '',
            role: u.role === 'operador' ? rondinRoleFor(u.role, u.privilegios) : (ROLE_OUT[u.role] || String(u.role || '').toUpperCase()), photo_url: null,
            status: u.active === false ? 'INACTIVE' : 'ACTIVE', profile: JSON.stringify(profile),
            document_id: p.document_id || null, supervisor_id: p.supervisor_id || null,
            pin_plain: u.accessCode || '', language: 'es', created_at: sqlFromIso(u.createdAt)
        };
    }
    async function staff() {
        const [users, personal] = await Promise.all([sisdelUsers(), personalMap()]);
        return users.filter((u) => u.role !== 'vecino').map((u) => userOut(u, personal));
    }
    async function userName(id) {
        const u = (await sisdelUsers()).find((x) => x.id === id);
        return u ? u.name : '';
    }

    async function config() {
        return cached('config', 4000, async () => {
            const snap = await col('rondas_config').doc('general').get();
            return snap.exists ? snap.data() : {};
        });
    }
    async function company() {
        const [condo, cfg] = await Promise.all([SISDEL.getCondominio(condoId()), config().catch(() => ({}))]);
        return {
            id: condoId(), name: (condo && condo.name) || '', logo_url: cfg.logo_url || null, country: cfg.country || 'GT',
            language: cfg.language || 'es', timezone: TZ, config: JSON.stringify(cfg.config || {}),
            status: condo && condo.active === false ? 'INACTIVE' : 'ACTIVE',
            neighbor_panic_enabled: cfg.neighbor_panic_enabled ? 1 : 0, pipa_monitoring_enabled: 0, pipa_enabled_by_dg: 0,
            created_at: sqlFromIso(condo && condo.createdAt), updated_at: cfg.updated_at || null
        };
    }

    // ── Fotos: la camara entrega varios MB; se comprimen para caber en Firestore ──
    function compress(dataUrl, maxDim = 1024, quality = 0.6) {
        return new Promise((resolve) => {
            if (!dataUrl || !String(dataUrl).startsWith('data:image')) { resolve(null); return; }
            const img = new Image();
            img.onload = () => {
                let { width: w, height: h } = img;
                if (w > maxDim || h > maxDim) { if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; } else { w = Math.round(w * maxDim / h); h = maxDim; } }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        });
    }
    async function savePhoto(dataUrl, kind, refId) {
        const data = await compress(dataUrl);
        if (!data) return null;
        const ref = col('rondas_fotos').doc();
        await ref.set({ id: ref.id, company_id: condoId(), data, kind, ref_id: refId || '', by: myId(), created_at: sql() });
        return ref.id;
    }

    // ── Alertas del panel (tabla alerts de RONDIN) ──
    async function addAlert(a) {
        const ref = col('rondas_alertas').doc();
        await ref.set({
            id: ref.id, company_id: condoId(), alert_type: a.alert_type, category: a.category || 'SYSTEM', title: a.title,
            message: a.message || '', source_user_id: a.source_user_id || myId(), target_user_id: a.target_user_id || null,
            shift_id: a.shift_id || null, latitude: a.latitude ?? null, longitude: a.longitude ?? null,
            acknowledged: 0, acknowledged_by: null, acknowledged_at: null, created_at: sql()
        });
        return ref.id;
    }

    // ══════════ RUTAS ══════════
    async function routesAll() { return cached('routes', 3000, async () => list(await col('rondas_rutas').get())); }
    const activeRoutes = async () => (await routesAll()).filter((r) => r.status === 'ACTIVE');
    const sortCp = (cps) => (cps || []).slice().sort((a, b) => (a.checkpoint_order || 0) - (b.checkpoint_order || 0));
    function routeOut(r, withCheckpoints) {
        const out = { ...r, checkpoint_count: (r.checkpoints || []).length };
        if (withCheckpoints) { out.checkpoints = sortCp(r.checkpoints); out.round_config = r.round_config || null; } else delete out.checkpoints;
        return out;
    }
    function newCheckpoint(cp, routeId, order) {
        return {
            id: cp.id || uuid(), route_id: routeId, name: cp.name || `Punto ${order}`, description: cp.description || null,
            latitude: Number(cp.latitude), longitude: Number(cp.longitude), radius_meters: Number(cp.radius_meters) || 10,
            checkpoint_order: order, checkpoint_type: cp.checkpoint_type || 'GPS', nfc_tag_id: cp.nfc_tag_id || null,
            qr_code: cp.qr_code || null, required_evidence: cp.required_evidence || 'none', min_stay_seconds: 0, max_stay_seconds: 300,
            risk_level: cp.risk_level || 'LOW', is_mandatory: cp.is_mandatory === false || cp.is_mandatory === 0 ? 0 : 1,
            status: 'ACTIVE', created_at: sql()
        };
    }
    async function routeHolding(cpId) {
        return (await routesAll()).find((r) => (r.checkpoints || []).some((c) => c.id === cpId));
    }

    // ══════════ ASIGNACIONES ══════════
    async function assignmentsAll() {
        if (asGuard()) return list(await col('rondas_asignaciones').where('guard_id', '==', myId()).get());
        return cached('assignments', 3000, async () => list(await col('rondas_asignaciones').get()));
    }
    function assignmentWorksOn(a, ymd) {
        if (a.status !== 'ACTIVE' || ymd < a.date_start || ymd > a.date_end) return false;
        if (a.shift_type === '24x24') {
            const diff = Math.floor((Date.parse(ymd + 'T12:00:00Z') - Date.parse(a.date_start + 'T12:00:00Z')) / 86400000);
            return diff >= 0 && diff % 2 === 0;
        }
        return true;
    }
    async function overlapping(guardId, dateStart, dateEnd, exceptId) {
        const routes = new Map((await routesAll()).map((r) => [r.id, r]));
        return (await assignmentsAll()).find((a) => a.guard_id === guardId && a.status === 'ACTIVE' && a.id !== exceptId
            && routes.get(a.route_id) && routes.get(a.route_id).status === 'ACTIVE' && a.date_start <= dateEnd && a.date_end >= dateStart);
    }

    // ══════════ TURNOS, RONDAS Y VISITAS ══════════
    // Turnos de los ultimos dias (los de mas de 16 h los cierra dailyRondas)
    async function shiftsQuery(filters = {}) {
        let q = col('rondas_turnos');
        if (asGuard()) q = q.where('guard_id', '==', myId());
        else if (filters.guard_id) q = q.where('guard_id', '==', filters.guard_id);
        if (filters.status) q = q.where('status', '==', filters.status);
        const since = daysAgoSql(filters.days || 30);
        return list(await q.get()).filter((s) => String(s.scheduled_start || '') >= since);
    }
    async function roundsSince(sinceSql) { return list(await col('rondas_rondas').where('created_at', '>=', sinceSql).get()); }
    // Visitas entre dos instantes (indice route_id + arrived_at en firestore.indexes.json)
    async function visitsQuery({ routeId, sinceSql, untilSql } = {}) {
        let q = col('rondas_visitas');
        const guard = asGuard();
        if (guard) q = q.where('guard_id', '==', myId());
        if (routeId) q = q.where('route_id', '==', routeId);
        if (!guard && sinceSql) q = q.where('arrived_at', '>=', sinceSql);
        if (!guard && untilSql) q = q.where('arrived_at', '<', untilSql);
        return list(await q.get()).filter((v) => (!sinceSql || v.arrived_at >= sinceSql) && (!untilSql || v.arrived_at < untilSql));
    }
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    // Puntaje como RONDIN (routes/rounds.js): % de puntos obligatorios visitados; completa desde 80
    async function scoreRound(round) {
        const route = (await routesAll()).find((r) => r.id === round.route_id);
        const mandatory = sortCp(route && route.checkpoints).filter((c) => c.is_mandatory !== 0 && c.status !== 'INACTIVE');
        if (!mandatory.length) return { score: 0, status: 'INCOMPLETE', done: false };
        const visits = list(await col('rondas_visitas').where('guard_id', '==', round.guard_id).where('round_id', '==', round.id).get());
        const visited = new Set(visits.filter((v) => v.status !== 'SUSPICIOUS').map((v) => v.checkpoint_id));
        const count = mandatory.filter((c) => visited.has(c.id)).length;
        const score = Math.round((count / mandatory.length) * 1000) / 10;
        return { score, status: score >= 80 ? 'COMPLETED' : 'INCOMPLETE', done: count === mandatory.length };
    }

    // ══════════ PANICO (alertas_panico de SISDEL) ══════════
    function guardPanicOut(p) {
        return {
            id: p.id, guard_id: p.userId, company_id: condoId(), shift_id: p.shiftId || null, latitude: p.lat, longitude: p.lng,
            audio_url: null, photo_url: null, trigger_method: 'BUTTON', status: p.status === 'ATTENDED' ? 'ACTIVE' : p.status,
            resolved_by: p.resolvedBy || null, resolved_at: sqlFromIso(p.resolvedAt), notes: p.notes || null,
            created_at: sqlFromIso(p.createdAt), guard_name: p.userName
        };
    }
    async function panicsOf(source) {
        return list(await col('alertas_panico').where('source', '==', source).get()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    // ══════════ VECINOS (los mismos de SISDEL) ══════════
    async function neighborsAll() {
        const users = (await sisdelUsers()).filter((u) => u.role === 'vecino');
        const [extras, contacts] = await Promise.all([
            col('finanzas_residentes').get().then((s) => new Map(list(s).map((e) => [e.id, e]))).catch(() => new Map()),
            col('emergencia').get().then((s) => new Map(list(s).map((e) => [e.id, e]))).catch(() => new Map())
        ]);
        return users.map((u) => neighborOut(u, extras.get(u.id), contacts.get(u.id)));
    }
    function neighborOut(u, extra, emergency) {
        const fam = ((emergency && emergency.contacts) || []).slice(0, 5);
        const out = {
            id: u.id, company_id: condoId(), name: u.name, document_id: (extra && extra.dpi) || '', phone: u.phone || '',
            reference: u.casa || '', access_code: u.accessCode || '', status: u.active === false ? 'INACTIVE' : 'ACTIVE',
            created_at: sqlFromIso(u.createdAt)
        };
        for (let i = 1; i <= 5; i++) { out[`fam_name_${i}`] = (fam[i - 1] && fam[i - 1].name) || ''; out[`fam_phone_${i}`] = (fam[i - 1] && fam[i - 1].phone) || ''; }
        return out;
    }
    // Telefonos: el formulario de vecinos de RONDIN antepone el texto literal '${lada}' en lugar del
    // codigo del pais. Los familiares quedan con codigo de pais (WhatsApp); el vecino con su numero
    // local, como el resto de SISDEL (garita, admin y Sistema Financiero)
    const LADAS = { GT: '502', MX: '52', SV: '503', HN: '504', NI: '505', CR: '506', PA: '507', CO: '57', US: '1', ES: '34', PE: '51', AR: '54', CL: '56', EC: '593', BO: '591', VE: '58', UY: '598', PY: '595', BR: '55', DO: '1' };
    let lada = '502';
    function cleanPhone(phone) { return String(phone || '').split('${lada}').join(lada).replace(/[^\d+]/g, ''); }
    function localPhone(phone) {
        const digits = cleanPhone(phone).replace(/\D/g, '');
        return digits.startsWith(lada) && digits.length >= lada.length + 7 ? digits.slice(lada.length) : digits;
    }
    async function loadLada() { try { lada = LADAS[(await config()).country || 'GT'] || '502'; } catch { /* GT */ } }

    function contactsFrom(body) {
        const contacts = [];
        for (let i = 1; i <= 5; i++) {
            const name = String(body[`fam_name_${i}`] || '').trim();
            const phone = cleanPhone(body[`fam_phone_${i}`]);
            if (name || phone) contacts.push({ name, phone });
        }
        return contacts;
    }
    async function saveContacts(userId, contacts) {
        await col('emergencia').doc(userId).set({ userId, condominioId: condoId(), contacts: contacts.slice(0, 5), updatedAt: new Date().toISOString() });
    }

    // ══════════ ENRUTADOR: mismas rutas que el servidor de RONDIN ══════════
    const routes = [];
    const on = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

    // ── Sesion ──
    on('POST', '/api/auth/login', async (b) => {
        const code = String((b && (b.pin || b.password)) || '').trim();
        const r = await SISDEL.login(code);
        if (!r.success) throw err(r.error || 'PIN inválido', 401);
        if (myRole() === 'master') { await quietSignOut(); throw err('El master usa el panel de SISDEL', 401); }
        if (myRole() === 'vecino') {
            try { await prepareNeighborSession(); } catch (e) { await quietSignOut(); throw e; }
        }
        API.token = 'sisdel'; API.user = apiUser();
        return { token: API.token, user: API.user };
    });
    on('GET', '/api/auth/me', async () => {
        if (myRole() === 'vecino') {
            try { await prepareNeighborSession(); } catch { sessionStorage.removeItem('sisdel_neighbor'); throw err('Botón de pánico no habilitado', 401); }
        }
        const c = await company().catch(() => ({ name: '' }));
        return { ...apiUser(), company_name: c.name || (session() || {}).condominioName || '' };
    });
    on('POST', '/api/auth/logout', async () => {
        if (!asGuard()) return { success: true };
        const today = localDate();
        const working = (await assignmentsAll()).some((a) => assignmentWorksOn(a, today));
        if (working) {
            await addAlert({ alert_type: 'LOGOUT_DURING_SHIFT', category: 'SECURITY', title: 'ABANDONO DE TURNO', message: 'El guardia cerró sesión en su dispositivo durante su turno activo.' });
        }
        return { success: true };
    });

    // ── Empresa (condominio) ──
    on('GET', '/api/companies', async () => company());
    on('GET', '/api/companies/all', async () => [await company()]);
    on('PUT', '/api/companies/:id/config', async (b) => {
        readOnlyGuard();
        const update = { updated_at: sql() };
        if (b.neighbor_panic_enabled !== undefined) update.neighbor_panic_enabled = b.neighbor_panic_enabled ? 1 : 0;
        if (b.pipa_defaults !== undefined) update.config = { ...((await config()).config || {}), pipa_defaults: b.pipa_defaults };
        await col('rondas_config').doc('general').set({ company_id: condoId(), ...update }, { merge: true });
        invalidate('config');
        return company();
    });
    on('PUT', '/api/companies/:id', async (b) => {
        readOnlyGuard();
        // El nombre del condominio se administra en SISDEL; aqui solo los datos de RONDIN
        const update = { updated_at: sql() };
        ['logo_url', 'country', 'language'].forEach((k) => { if (b[k] !== undefined) update[k] = b[k]; });
        await col('rondas_config').doc('general').set({ company_id: condoId(), ...update }, { merge: true });
        invalidate('config');
        return company();
    });
    on('POST', '/api/companies/:id/reset-dg-pin', async () => { throw err('El código de acceso se administra en el panel de SISDEL'); });
    on('POST', '/api/companies/master-login', async () => { throw err('PIN incorrecto', 401); });

    // ── Usuarios (guardias, supervisores, director) ──
    on('GET', '/api/users', async () => (await staff()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    on('GET', '/api/users/supervisors', async () => {
        const people = await staff();
        return people.filter((u) => u.role === 'SUPERVISOR').sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({
            id: s.id, name: s.name, email: s.email, phone: s.phone, pin_plain: s.pin_plain, status: s.status,
            guards: people.filter((g) => g.supervisor_id === s.id).map((g) => ({ id: g.id, name: g.name, phone: g.phone, status: g.status }))
        }));
    });
    on('PUT', '/api/users/:id/assign-supervisor', async (b, p) => {
        readOnlyGuard();
        await col('rondas_personal').doc(p.id).set({ id: p.id, company_id: condoId(), supervisor_id: b.supervisor_id || null, updated_at: sql() }, { merge: true });
        invalidate('personal');
        return { success: true };
    });
    on('POST', '/api/users', async (b) => {
        readOnlyGuard();
        const role = ROLE_IN[b.role || 'GUARDIA'] || 'policia';
        if (role !== 'policia' && !can('usuarios.crear')) throw err('Solo puede registrar guardias', 403);
        const u = await SISDEL.createUser(condoId(), b.name, role, '', b.phone || '', b.email || '', b.pin || '');
        if (!u) throw err('No se pudo crear el usuario.');
        const profile = { ...(b.profile || {}) };
        delete profile.access_code;
        const personal = { id: u.id, company_id: condoId(), document_id: b.document_id || null, profile: JSON.stringify(profile), updated_at: sql() };
        await col('rondas_personal').doc(u.id).set(personal, { merge: true });
        invalidate('users', 'personal');
        if (b.pin && String(b.pin).toUpperCase() !== u.accessCode) {
            Swal.fire({ title: 'Código de acceso', html: `El código propuesto ya estaba en uso. El código de <b>${u.name}</b> es <b style="color:#10b981;letter-spacing:3px">${u.accessCode}</b>`, icon: 'info', background: '#1e293b', color: '#f1f5f9' });
        }
        return { ...userOut(u, new Map([[u.id, personal]])), pin_raw: u.accessCode };
    });
    on('PUT', '/api/users/:id', async (b, p) => {
        readOnlyGuard();
        const changes = {};
        if (b.name) changes.name = b.name;
        if (b.phone) changes.phone = b.phone;
        if (b.email) changes.email = b.email;
        if (b.status) changes.active = b.status !== 'INACTIVE';
        if (b.role && ROLE_IN[b.role]) {
            changes.role = ROLE_IN[b.role];
            // Al cambiar de rol los privilegios a la medida del rol anterior ya no aplican: vuelve a los del nuevo rol
            const before = (await sisdelUsers()).find((x) => x.id === p.id);
            if (before && before.role !== changes.role && before.privilegios) changes.privilegios = firebase.firestore.FieldValue.delete();
        }
        const u = await SISDEL.updateUser(p.id, changes);
        if (!u) throw err('No se pudo actualizar el usuario');
        invalidate('users');
        return userOut(u, await personalMap());
    });
    on('DELETE', '/api/users/:id', async (b, p) => {
        readOnlyGuard();
        if (!(await SISDEL.updateUser(p.id, { active: false }))) throw err('No se pudo desactivar el usuario');
        invalidate('users');
        return { success: true };
    });

    // ── Rutas y puntos de control ──
    on('GET', '/api/routes', async () => (await activeRoutes()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((r) => routeOut(r, false)));
    on('GET', '/api/routes/:id', async (b, p) => {
        const r = (await routesAll()).find((x) => x.id === p.id);
        if (!r) throw err('No encontrada', 404);
        return routeOut(r, true);
    });
    on('POST', '/api/routes', async (b) => {
        readOnlyGuard();
        const id = uuid();
        let code = b.route_code;
        if (!code) {
            const nums = (await routesAll()).map((r) => parseInt(String(r.route_code || '').replace('R-', ''), 10)).filter(Number.isFinite);
            code = 'R-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
        }
        const route = {
            id, company_id: condoId(), name: b.name, description: b.description || null,
            geojson_path: b.geojson_path ? JSON.stringify(b.geojson_path) : null, color: b.color || '#3B82F6',
            estimated_duration_min: b.estimated_duration_min || 30, status: 'ACTIVE', created_by: myId(), route_code: code,
            checkpoints: (b.checkpoints || []).map((cp, i) => newCheckpoint(cp, id, i + 1)),
            round_config: b.round_config ? {
                id: uuid(), route_id: id, frequency_type: b.round_config.frequency_type || 'FIXED', interval_minutes: b.round_config.interval_minutes || 60,
                rounds_per_shift: b.round_config.rounds_per_shift || 4, max_duration_minutes: b.round_config.max_duration_minutes || 45,
                checkpoint_order_type: b.round_config.checkpoint_order_type || 'SEQUENTIAL', status: 'ACTIVE', created_at: sql()
            } : null,
            created_at: sql(), updated_at: sql()
        };
        await col('rondas_rutas').doc(id).set(route);
        invalidate('routes');
        return routeOut(route, true);
    });
    on('PUT', '/api/routes/checkpoints/:cpId', async (b, p) => {
        readOnlyGuard();
        if (!b.name) throw err('El nombre es obligatorio');
        const r = await routeHolding(p.cpId);
        if (!r) throw err('No encontrado', 404);
        const checkpoints = r.checkpoints.map((c) => (c.id === p.cpId ? { ...c, name: b.name } : c));
        await col('rondas_rutas').doc(r.id).update({ checkpoints, updated_at: sql() });
        invalidate('routes');
        return checkpoints.find((c) => c.id === p.cpId);
    });
    on('DELETE', '/api/routes/checkpoints/:cpId', async (b, p) => {
        readOnlyGuard();
        const r = await routeHolding(p.cpId);
        if (r) {
            await col('rondas_rutas').doc(r.id).update({ checkpoints: r.checkpoints.filter((c) => c.id !== p.cpId), updated_at: sql() });
            invalidate('routes');
        }
        return { success: true };
    });
    on('POST', '/api/routes/:id/checkpoints', async (b, p) => {
        readOnlyGuard();
        const r = (await routesAll()).find((x) => x.id === p.id);
        if (!r) throw err('Ruta no encontrada', 404);
        const cp = newCheckpoint({ ...b, radius_meters: b.radius_meters || 15 }, r.id, b.checkpoint_order || 1);
        await col('rondas_rutas').doc(r.id).update({ checkpoints: (r.checkpoints || []).concat(cp), updated_at: sql() });
        invalidate('routes');
        return cp;
    });
    on('PUT', '/api/routes/:id', async (b, p) => {
        readOnlyGuard();
        const r = (await routesAll()).find((x) => x.id === p.id);
        if (!r) throw err('No encontrada', 404);
        const update = {
            name: b.name || r.name, description: b.description || r.description, color: b.color || r.color,
            estimated_duration_min: b.estimated_duration_min || r.estimated_duration_min, status: b.status || r.status, updated_at: sql()
        };
        await col('rondas_rutas').doc(r.id).update(update);
        invalidate('routes');
        return routeOut({ ...r, ...update }, false);
    });
    on('DELETE', '/api/routes/:id', async (b, p) => {
        readOnlyGuard();
        await col('rondas_rutas').doc(p.id).update({ status: 'INACTIVE', updated_at: sql() });
        invalidate('routes');
        return { success: true };
    });
    on('GET', '/api/checkpoints', async (b, p, q) => {
        const r = (await routesAll()).find((x) => x.id === q.get('route_id'));
        return r ? sortCp(r.checkpoints) : [];
    });

    // ── Asignaciones de ruta ──
    on('GET', '/api/route-assignments', async (b, p, q) => {
        const [all, routesList, people] = await Promise.all([assignmentsAll(), routesAll(), staff()]);
        const rmap = new Map(routesList.map((r) => [r.id, r]));
        const umap = new Map(people.map((u) => [u.id, u]));
        return all.filter((a) => rmap.get(a.route_id) && rmap.get(a.route_id).status === 'ACTIVE' && umap.get(a.guard_id)
            && (!q.get('route_id') || a.route_id === q.get('route_id')))
            .map((a) => ({ ...a, guard_name: umap.get(a.guard_id).name, document_id: umap.get(a.guard_id).document_id, route_name: rmap.get(a.route_id).name, route_code: rmap.get(a.route_id).route_code }))
            .sort((x, y) => String(y.date_start).localeCompare(String(x.date_start)));
    });
    on('POST', '/api/route-assignments', async (b) => {
        readOnlyGuard();
        if (!b.route_id || !b.guard_id || !b.date_start || !b.date_end) throw err('Ruta, guardia y fechas son obligatorios');
        const clash = await overlapping(b.guard_id, b.date_start, b.date_end);
        if (clash) {
            const rn = ((await routesAll()).find((r) => r.id === clash.route_id) || {}).name;
            throw err(`Este guardia ya tiene una asignación activa en la ruta "${rn}" del ${clash.date_start} al ${clash.date_end}. No se puede asignar dos veces en las mismas fechas.`, 409);
        }
        const id = uuid();
        const a = {
            id, route_id: b.route_id, guard_id: b.guard_id, company_id: condoId(), shift_type: b.shift_type || '12H_DIA',
            date_start: b.date_start, date_end: b.date_end, hour_start: b.hour_start || '08:00', hour_end: b.hour_end || '20:00',
            status: 'ACTIVE', created_at: sql()
        };
        await col('rondas_asignaciones').doc(id).set(a);
        invalidate('assignments');
        return { ...a, guard_name: await userName(b.guard_id) };
    });
    on('PUT', '/api/route-assignments/:id', async (b, p) => {
        readOnlyGuard();
        const existing = (await assignmentsAll()).find((a) => a.id === p.id);
        if (!existing) throw err('Asignación no encontrada', 404);
        const next = {
            guard_id: b.guard_id || existing.guard_id, shift_type: b.shift_type || existing.shift_type,
            date_start: b.date_start || existing.date_start, date_end: b.date_end || existing.date_end,
            hour_start: b.hour_start || existing.hour_start, hour_end: b.hour_end || existing.hour_end
        };
        const clash = await overlapping(next.guard_id, next.date_start, next.date_end, p.id);
        if (clash) {
            const rn = ((await routesAll()).find((r) => r.id === clash.route_id) || {}).name;
            throw err(`Este guardia ya tiene una asignación activa en la ruta "${rn}" del ${clash.date_start} al ${clash.date_end}.`, 409);
        }
        await col('rondas_asignaciones').doc(p.id).update(next);
        invalidate('assignments');
        return { ...existing, ...next, guard_name: await userName(next.guard_id) };
    });
    on('DELETE', '/api/route-assignments/:id', async (b, p) => {
        readOnlyGuard();
        await col('rondas_asignaciones').doc(p.id).delete();
        invalidate('assignments');
        return { success: true };
    });
    on('GET', '/api/my-assignment', async () => {
        const today = localDate();
        const routesList = await routesAll();
        const mine = (await assignmentsAll()).filter((a) => a.guard_id === myId() && a.status === 'ACTIVE' && a.date_start <= today && a.date_end >= today)
            .sort((x, y) => String(y.date_start).localeCompare(String(x.date_start)));
        const valid = mine.find((a) => assignmentWorksOn(a, today));
        if (!valid) return null;
        const r = routesList.find((x) => x.id === valid.route_id);
        return r ? { ...valid, route_name: r.name, route_id: r.id } : null;
    });

    // ── Turnos ──
    on('GET', '/api/shifts', async (b, p, q) => {
        const [rows, routesList, people] = await Promise.all([shiftsQuery({ status: q.get('status'), guard_id: q.get('guard_id') }), routesAll(), staff()]);
        const rmap = new Map(routesList.map((r) => [r.id, r]));
        const umap = new Map(people.map((u) => [u.id, u]));
        const date = q.get('date');
        return rows.filter((s) => !date || localDateOf(s.scheduled_start) === date)
            .map((s) => ({ ...s, guard_name: (umap.get(s.guard_id) || {}).name || '', guard_photo: null, route_name: (rmap.get(s.route_id) || {}).name || '', supervisor_name: (umap.get(s.supervisor_id) || {}).name || null }))
            .sort((x, y) => String(y.scheduled_start).localeCompare(String(x.scheduled_start)));
    });
    on('POST', '/api/shifts', async (b) => {
        readOnlyGuard();
        const id = uuid();
        const s = {
            id, company_id: condoId(), guard_id: b.guard_id, supervisor_id: b.supervisor_id || (isManager() ? myId() : null), route_id: b.route_id,
            scheduled_start: b.scheduled_start ? sql(b.scheduled_start) : sql(), scheduled_end: b.scheduled_end ? sql(b.scheduled_end) : null,
            actual_start: null, actual_end: null, checkin_photo: null, checkin_lat: null, checkin_lng: null,
            checkout_photo: null, checkout_lat: null, checkout_lng: null, battery_start: null, battery_end: null,
            status: 'SCHEDULED', notes: null, created_at: sql()
        };
        await col('rondas_turnos').doc(id).set(s);
        return s;
    });
    on('POST', '/api/shifts/:id/checkin', async (b, p) => {
        const photo = await savePhoto(b.photo, 'checkin', p.id);
        const update = { actual_start: sql(), checkin_photo: photo, checkin_lat: b.latitude ?? null, checkin_lng: b.longitude ?? null, battery_start: b.battery_level ?? null, status: 'ACTIVE' };
        await col('rondas_turnos').doc(p.id).update(update);
        await addAlert({ alert_type: 'INFO', category: 'SYSTEM', title: 'Turno iniciado', message: `${(session() || {}).userName} ha iniciado su turno` });
        return one(await col('rondas_turnos').doc(p.id).get());
    });
    on('POST', '/api/shifts/:id/checkout', async (b, p) => {
        const photo = await savePhoto(b.photo, 'checkout', p.id);
        await col('rondas_turnos').doc(p.id).update({ actual_end: sql(), checkout_photo: photo, checkout_lat: b.latitude ?? null, checkout_lng: b.longitude ?? null, battery_end: b.battery_level ?? null, status: 'COMPLETED' });
        // Las rondas abiertas del turno se cierran con su puntaje
        const open = list(await col('rondas_rondas').where('guard_id', '==', myId()).where('shift_id', '==', p.id).get()).filter((r) => r.status === 'IN_PROGRESS');
        for (const r of open) {
            const s = await scoreRound(r);
            await col('rondas_rondas').doc(r.id).update({ completed_at: sql(), score: s.score, status: s.status });
        }
        await col('rondas_en_vivo').doc(myId()).delete().catch(() => {});
        return one(await col('rondas_turnos').doc(p.id).get());
    });

    // ── Rondas ──
    on('POST', '/api/rounds/start', async (b) => {
        const existing = list(await col('rondas_rondas').where('guard_id', '==', myId()).where('shift_id', '==', b.shift_id).get());
        const id = uuid();
        const r = { id, company_id: condoId(), shift_id: b.shift_id, route_id: b.route_id, guard_id: myId(), round_number: existing.length + 1, started_at: sql(), completed_at: null, score: 0, distance_meters: 0, status: 'IN_PROGRESS', notes: null, created_at: sql() };
        await col('rondas_rondas').doc(id).set(r);
        return r;
    });
    on('GET', '/api/rounds', async (b, p, q) => {
        const rows = asGuard()
            ? list(await col('rondas_rondas').where('guard_id', '==', myId()).get())
            : await roundsSince(daysAgoSql(30));
        return rows.filter((r) => (!q.get('shift_id') || r.shift_id === q.get('shift_id')) && (!q.get('status') || r.status === q.get('status')));
    });

    // ── Visitas a puntos de control ──
    on('POST', '/api/checkpoint-visits', async (b) => {
        const mine = list(await col('rondas_visitas').where('guard_id', '==', myId()).where('checkpoint_id', '==', b.checkpoint_id).get());
        const recent = mine.find((v) => ms(v.arrived_at) > Date.now() - 5 * 60000);
        if (recent) return { already: true, message: 'Ya registrado recientemente' };
        const route = (await routesAll()).find((r) => r.id === b.route_id) || (await routeHolding(b.checkpoint_id));
        const cp = route ? (route.checkpoints || []).find((c) => c.id === b.checkpoint_id) : null;
        const cpName = cp ? cp.name : 'Punto desconocido';
        const distance = cp && b.latitude != null ? Math.round(haversine(b.latitude, b.longitude, cp.latitude, cp.longitude)) : null;
        // Al recargar la pagina RONDIN pierde la ronda en curso: se usa la ronda abierta del turno
        let roundId = b.round_id || null;
        if (!roundId && b.shift_id) {
            const open = list(await col('rondas_rondas').where('guard_id', '==', myId()).where('shift_id', '==', b.shift_id).get())
                .filter((r) => r.status === 'IN_PROGRESS').sort((x, y) => String(y.started_at).localeCompare(String(x.started_at)));
            if (open.length) roundId = open[0].id;
        }
        const id = uuid();
        const now = new Date();
        const formatted = now.toLocaleString('es-MX', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        await col('rondas_visitas').doc(id).set({
            id, company_id: condoId(), round_id: roundId, checkpoint_id: b.checkpoint_id, checkpoint_name: cpName,
            guard_id: myId(), guard_name: (session() || {}).userName || '', route_id: b.route_id || (route && route.id) || null,
            shift_id: b.shift_id || null, arrived_at: sql(now), departed_at: null, latitude: b.latitude ?? null, longitude: b.longitude ?? null,
            distance_to_checkpoint: distance, nfc_read: 0, qr_scanned: 0, photo_url: null, note: null, status: 'VALID', created_at: sql(now)
        });
        await addAlert({ alert_type: 'INFO', category: 'CHECKPOINT_VISIT', title: `📍 Punto visitado: ${cpName}`, message: `${(session() || {}).userName} visitó "${cpName}" el ${formatted}. Coordenadas: ${b.latitude}, ${b.longitude}`, latitude: b.latitude, longitude: b.longitude });
        // Ronda completa cuando estan todos los puntos obligatorios (como routes/rounds.js)
        if (roundId) {
            const roundSnap = await col('rondas_rondas').doc(roundId).get();
            if (roundSnap.exists && roundSnap.data().status === 'IN_PROGRESS') {
                const s = await scoreRound({ ...roundSnap.data(), id: roundId });
                if (s.done) await col('rondas_rondas').doc(roundId).update({ completed_at: sql(), status: 'COMPLETED', score: 100 });
                else await col('rondas_rondas').doc(roundId).update({ score: s.score });
            }
        }
        return { id, success: true, timestamp: formatted };
    });
    async function visitsJoined(rows) {
        const routesList = await routesAll();
        const cps = new Map(routesList.flatMap((r) => (r.checkpoints || []).map((c) => [c.id, c])));
        return rows.map((v) => ({ ...v, checkpoint_name: v.checkpoint_name || (cps.get(v.checkpoint_id) || {}).name, cp_lat: (cps.get(v.checkpoint_id) || {}).latitude, cp_lng: (cps.get(v.checkpoint_id) || {}).longitude }));
    }
    on('GET', '/api/checkpoint-visits/today', async () => {
        const rows = await visitsQuery({ sinceSql: startOfLocalDaySql() });
        return (await visitsJoined(rows)).sort((a, b) => String(b.arrived_at).localeCompare(String(a.arrived_at))).slice(0, 50);
    });
    on('GET', '/api/checkpoint-visits/by-route/:routeId', async (b, p, q) => {
        const date = q.get('date') || localDate();
        const from = startOfLocalDaySql(date);
        const rows = await visitsQuery({ routeId: p.routeId, sinceSql: from, untilSql: sql(ms(from) + 86400000) });
        return (await visitsJoined(rows)).sort((a, c) => String(c.arrived_at).localeCompare(String(a.arrived_at)));
    });
    on('GET', '/api/checkpoint-visits/history/:routeId', async (b, p, q) => {
        const days = parseInt(q.get('days'), 10) || 15;
        const rows = await visitsQuery({ routeId: p.routeId, sinceSql: daysAgoSql(days) });
        return (await visitsJoined(rows)).sort((a, c) => String(a.arrived_at).localeCompare(String(c.arrived_at)));
    });

    // ── Rastreo GPS ──
    const lastHistory = { at: 0 };
    let lastBatteryAlert = 0;
    on('POST', '/api/tracking', async (b) => {
        if (!isPatroller()) return { success: true };
        const now = sql();
        const point = {
            user_id: myId(), company_id: condoId(), name: (session() || {}).userName || '', role: rondinRole(), shift_id: b.shift_id || null,
            latitude: b.latitude, longitude: b.longitude, accuracy: b.accuracy ?? null, speed: b.speed ?? null, heading: b.heading ?? null,
            altitude: b.altitude ?? null, battery_level: b.battery_level ?? null, connection_type: b.connection_type || null, timestamp: now
        };
        await col('rondas_en_vivo').doc(myId()).set(point);
        // Historial cada minuto como maximo (RONDIN guardaba cada punto)
        if (Date.now() - lastHistory.at > 60000) {
            lastHistory.at = Date.now();
            await col('rondas_ubicaciones').add(point);
        }
        if (b.battery_level && b.battery_level < 20 && Date.now() - lastBatteryAlert > 30 * 60000) {
            lastBatteryAlert = Date.now();
            await addAlert({ alert_type: 'WARNING', category: 'BATTERY_LOW', title: 'Batería baja', message: `${point.name}: batería al ${b.battery_level}%`, latitude: b.latitude, longitude: b.longitude });
        }
        return { success: true };
    });
    on('GET', '/api/tracking/live', async () => {
        const since = daysAgoSql(30 / 1440);
        const [live, shiftsList, routesList] = await Promise.all([col('rondas_en_vivo').get().then(list), shiftsQuery({ status: 'ACTIVE' }), routesAll()]);
        const smap = new Map(shiftsList.map((s) => [s.id, s]));
        const rmap = new Map(routesList.map((r) => [r.id, r]));
        return live.filter((l) => l.timestamp > since).map((l) => {
            const s = smap.get(l.shift_id);
            return { ...l, photo_url: null, shift_status: s ? s.status : null, route_name: s && rmap.get(s.route_id) ? rmap.get(s.route_id).name : null };
        }).sort((a, c) => String(c.timestamp).localeCompare(String(a.timestamp)));
    });
    on('GET', '/api/tracking/history', async (b, p, q) => {
        const rows = list(await col('rondas_ubicaciones').where('timestamp', '>=', daysAgoSql(1)).get());
        return rows.filter((l) => (!q.get('user_id') || l.user_id === q.get('user_id')) && (!q.get('shift_id') || l.shift_id === q.get('shift_id')))
            .sort((a, c) => String(c.timestamp).localeCompare(String(a.timestamp))).slice(0, parseInt(q.get('limit'), 10) || 500);
    });

    // ── Incidentes ──
    on('GET', '/api/incidents', async (b, p, q) => {
        const rows = list(await col('rondas_incidentes').get());
        const umap = new Map((await sisdelUsers()).map((u) => [u.id, u]));
        return rows.filter((i) => (!q.get('status') || i.status === q.get('status')) && (!q.get('severity') || i.severity === q.get('severity')) && (!q.get('type') || i.incident_type === q.get('type')))
            .map((i) => ({ ...i, reporter_name: (umap.get(i.reported_by) || {}).name || i.reporter_name || '' }))
            .sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)));
    });
    on('POST', '/api/incidents', async (b) => {
        readOnlyGuard();
        const id = uuid();
        const photoIds = [];
        for (const ph of (b.photos || [])) { const pid = await savePhoto(ph, 'incidente', id); if (pid) photoIds.push(pid); }
        const inc = {
            id, company_id: condoId(), reported_by: myId(), reporter_name: (session() || {}).userName || '', shift_id: b.shift_id || null, round_id: b.round_id || null,
            incident_type: b.incident_type, severity: b.severity || 'MEDIUM', title: b.title, description: b.description || '',
            latitude: b.latitude ?? null, longitude: b.longitude ?? null, photos: JSON.stringify(photoIds),
            status: 'OPEN', resolved_by: null, resolved_at: null, created_at: sql()
        };
        await col('rondas_incidentes').doc(id).set(inc);
        await addAlert({ alert_type: ALERT_TYPE_BY_SEVERITY[inc.severity] || 'WARNING', category: 'SYSTEM', title: `Incidente: ${inc.title}`, message: `${inc.reporter_name} reportó: ${inc.description}`, latitude: inc.latitude, longitude: inc.longitude });
        return inc;
    });
    on('PUT', '/api/incidents/:id', async (b, p) => {
        readOnlyGuard();
        const update = { status: b.status };
        if (b.status === 'RESOLVED' || b.status === 'CLOSED') { update.resolved_by = myId(); update.resolved_at = sql(); }
        await col('rondas_incidentes').doc(p.id).update(update);
        return one(await col('rondas_incidentes').doc(p.id).get());
    });

    // ── Alertas del panel ──
    on('GET', '/api/alerts', async (b, p, q) => {
        const rows = list(await col('rondas_alertas').where('created_at', '>=', daysAgoSql(30)).get());
        const ack = q.get('acknowledged');
        return rows.filter((a) => (ack === null || a.acknowledged === (ack === 'true' ? 1 : 0)) && (!q.get('type') || a.alert_type === q.get('type')))
            .sort((a, c) => String(c.created_at).localeCompare(String(a.created_at))).slice(0, 100);
    });
    on('PUT', '/api/alerts/:id/acknowledge', async (b, p) => {
        readOnlyGuard();
        await col('rondas_alertas').doc(p.id).update({ acknowledged: 1, acknowledged_by: myId(), acknowledged_at: sql() });
        return one(await col('rondas_alertas').doc(p.id).get());
    });
    on('DELETE', '/api/alerts/:id', async (b, p) => {
        readOnlyGuard();
        await col('rondas_alertas').doc(p.id).delete();
        return { success: true };
    });

    // ── Panico del guardia (alertas_panico de SISDEL) ──
    on('POST', '/api/panic', async (b) => {
        const ref = col('alertas_panico').doc();
        const s = session() || {};
        const data = {
            id: ref.id, condominioId: condoId(), source: 'guardia', userId: myId(), userName: s.userName || '', casa: 'Ronda', phone: '',
            lat: b.latitude ?? null, lng: b.longitude ?? null, accuracy: null, shiftId: b.shift_id || null, status: 'ACTIVE', createdAt: new Date().toISOString()
        };
        await ref.set(data);
        await addAlert({ alert_type: 'EMERGENCY', category: 'PANIC', title: '🆘 PÁNICO ACTIVADO', message: `${data.userName} activó botón de pánico`, latitude: data.lat, longitude: data.lng });
        return guardPanicOut(data);
    });
    on('GET', '/api/panic', async () => (await panicsOf('guardia')).map(guardPanicOut));
    on('PUT', '/api/panic/:id', async (b, p) => {
        readOnlyGuard();
        const s = session() || {};
        const status = b.status === 'RESOLVED' || b.status === 'CLOSED' ? 'RESOLVED' : 'ATTENDED';
        const update = status === 'RESOLVED'
            ? { status, resolvedBy: myId(), resolvedByName: s.userName || '', resolvedAt: new Date().toISOString(), notes: b.notes || '' }
            : { status, attendedBy: myId(), attendedByName: s.userName || '', attendedAt: new Date().toISOString() };
        await col('alertas_panico').doc(p.id).update(update);
        return guardPanicOut(one(await col('alertas_panico').doc(p.id).get()));
    });

    // ── Tablero y director general ──
    async function dgData() {
        const since7 = daysAgoSql(7);
        const [routesList, assignments, people, shifts, rounds7, incidents, alerts, panics] = await Promise.all([
            activeRoutes(), assignmentsAll(), staff(), shiftsQuery({ days: 3 }), roundsSince(since7),
            col('rondas_incidentes').get().then(list), col('rondas_alertas').where('created_at', '>=', daysAgoSql(30)).get().then(list),
            panicsOf('guardia')
        ]);
        return { routesList, assignments, people, shifts, rounds7, incidents, alerts, panics, guards: people.filter((u) => u.role === 'GUARDIA' && u.status === 'ACTIVE') };
    }
    const todayRounds = (rounds) => rounds.filter((r) => localDateOf(r.created_at) === localDate());
    on('GET', '/api/dashboard/stats', async () => {
        const d = await dgData();
        const today = todayRounds(d.rounds7);
        return {
            total_guards: d.guards.length, active_shifts: d.shifts.filter((s) => s.status === 'ACTIVE').length, today_rounds: today.length,
            avg_score: today.length ? today.reduce((s, r) => s + (Number(r.score) || 0), 0) / today.length : 0,
            pending_alerts: d.alerts.filter((a) => !a.acknowledged).length,
            open_incidents: d.incidents.filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.status)).length,
            active_panics: d.panics.filter((p) => p.status === 'ACTIVE').length
        };
    });
    function compliance(guards, rounds) {
        return guards.map((g) => {
            const mine = rounds.filter((r) => r.guard_id === g.id);
            const completed = mine.filter((r) => r.status === 'COMPLETED').length;
            const avg = mine.length ? Math.round((mine.reduce((s, r) => s + (Number(r.score) || 0), 0) / mine.length) * 10) / 10 : 0;
            return { id: g.id, name: g.name, photo_url: null, total_rounds: mine.length, completed_rounds: completed, completed, avg_score: avg,
                compliance_pct: mine.length ? Math.round((completed / mine.length) * 1000) / 10 : 0,
                days_worked: new Set(mine.map((r) => localDateOf(r.created_at))).size };
        }).sort((a, b) => b.compliance_pct - a.compliance_pct);
    }
    on('GET', '/api/dashboard/compliance', async () => { const d = await dgData(); return compliance(d.guards, d.rounds7); });
    on('GET', '/api/dashboard/recent-activity', async () => {
        const rows = list(await col('rondas_alertas').where('created_at', '>=', daysAgoSql(7)).get());
        return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20)
            .map((a) => ({ id: a.id, type: a.alert_type, title: a.title, message: a.message, created_at: a.created_at }));
    });
    on('GET', '/api/dashboard/route-stats', async () => {
        const d = await dgData();
        return d.routesList.map((r) => {
            const mine = d.rounds7.filter((x) => x.route_id === r.id);
            return { id: r.id, name: r.name, color: r.color, total_rounds: mine.length, completed: mine.filter((x) => x.status === 'COMPLETED').length,
                avg_score: mine.length ? Math.round((mine.reduce((s, x) => s + (Number(x.score) || 0), 0) / mine.length) * 10) / 10 : null };
        }).sort((a, b) => a.name.localeCompare(b.name));
    });
    on('GET', '/api/dg/summary', async () => {
        const d = await dgData();
        const today = localDate();
        const covered = new Set(d.assignments.filter((a) => a.status === 'ACTIVE' && a.date_start <= today && a.date_end >= today).map((a) => a.route_id));
        const coveredRoutes = d.routesList.filter((r) => covered.has(r.id)).length;
        const guardsOnShift = d.shifts.filter((s) => s.status === 'ACTIVE').length;
        const roundsToday = todayRounds(d.rounds7);
        const roundsCompleted = roundsToday.filter((r) => r.status === 'COMPLETED').length;
        const coveragePct = d.routesList.length ? Math.round((coveredRoutes / d.routesList.length) * 100) : 0;
        const roundPct = roundsToday.length ? Math.round((roundsCompleted / roundsToday.length) * 100) : 0;
        const operational = Math.round((coveragePct * 0.4) + (roundPct * 0.35) + (guardsOnShift > 0 ? Math.min(100, (guardsOnShift / Math.max(1, d.guards.length)) * 100) * 0.25 : 0));
        const open = d.incidents.filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.status));
        return {
            total_routes: d.routesList.length, covered_routes: coveredRoutes, coverage_pct: coveragePct,
            total_guards: d.guards.length, guards_on_shift: guardsOnShift,
            rounds_today: roundsToday.length, rounds_completed: roundsCompleted, round_compliance_pct: roundPct,
            open_incidents: open.length, high_incidents: open.filter((i) => ['HIGH', 'CRITICAL'].includes(i.severity)).length,
            active_panics: d.panics.filter((p) => p.status === 'ACTIVE').length, pending_alerts: d.alerts.filter((a) => !a.acknowledged).length,
            operational_score: operational
        };
    });
    const fmtGT = (s) => { try { return new Date(ms(s)).toLocaleString('es-GT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }); } catch { return s; } };
    on('GET', '/api/dg/critical-alerts', async () => {
        const d = await dgData();
        const today = localDate();
        // RONDIN mandaba solo la fecha y la pantalla la mostraba como las 6 p. m. del dia anterior
        const dayStart = startOfLocalDaySql(today);
        const alerts = [];
        // Panicos activos de las ultimas 48 horas (RONDIN cerraba los mas viejos)
        d.panics.filter((p) => p.status === 'ACTIVE' && Date.now() - Date.parse(p.createdAt) < 48 * 3600000).slice(0, 10).forEach((p) => alerts.push({
            level: 'CRITICAL', icon: '🆘', type: 'PANIC', title: `PÁNICO ACTIVO — ${p.userName}`, detail: `Activado el ${fmtGT(sqlFromIso(p.createdAt))}.`, lat: p.lat, lng: p.lng, time: sqlFromIso(p.createdAt)
        }));
        const umap = new Map(d.people.map((u) => [u.id, u]));
        const todays = d.assignments.filter((a) => a.status === 'ACTIVE' && a.date_start <= today && a.date_end >= today);
        const covered = new Set(todays.map((a) => a.route_id));
        d.routesList.filter((r) => !covered.has(r.id)).forEach((r) => alerts.push({
            level: 'HIGH', icon: '🔴', type: 'NO_ASSIGNMENT', title: `Ruta sin guardia asignado: ${r.name}`, detail: 'Esta ruta no tiene ningún guardia asignado para hoy. Requiere cobertura urgente.', time: dayStart
        }));
        const rmap = new Map(d.routesList.map((r) => [r.id, r]));
        todays.filter((a) => rmap.get(a.route_id)).forEach((a) => {
            const g = umap.get(a.guard_id);
            if (!g) return;
            if (g.status !== 'ACTIVE') {
                alerts.push({ level: 'HIGH', icon: '🚫', type: 'GUARD_INACTIVE', title: `Guardia inactivo en ruta: ${rmap.get(a.route_id).name}`, detail: `${g.name} está asignado a esta ruta hoy pero su estado es ${g.status}. La ruta puede quedar sin cobertura real.`, time: dayStart });
                return;
            }
            const shift = d.shifts.filter((s) => s.guard_id === g.id && ['ACTIVE', 'PENDING'].includes(s.status)).sort((x, y) => String(y.scheduled_start).localeCompare(String(x.scheduled_start)))[0];
            if (!shift) alerts.push({ level: 'HIGH', icon: '⚠️', type: 'NO_CHECKIN', title: `Sin check-in en turno: ${g.name}`, detail: `Asignado a la ruta "${rmap.get(a.route_id).name}" (${a.shift_type}) pero no ha iniciado turno hoy.`, time: dayStart });
            else if (shift.status === 'PENDING') alerts.push({ level: 'MEDIUM', icon: '🕐', type: 'SHIFT_PENDING', title: `Turno pendiente: ${g.name}`, detail: `Asignado a la ruta "${rmap.get(a.route_id).name}" — su turno está creado pero aún no ha hecho check-in.`, time: dayStart });
        });
        d.incidents.filter((i) => i.status === 'OPEN' && ['HIGH', 'CRITICAL'].includes(i.severity)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5).forEach((i) => alerts.push({
            level: 'HIGH', icon: '🚨', type: 'INCIDENT', title: `Incidente ${i.severity}: ${i.title}`, detail: `Reportado por ${(umap.get(i.reported_by) || {}).name || i.reporter_name || ''} — ${i.incident_type}`, time: i.created_at
        }));
        const twoHours = daysAgoSql(2 / 24);
        d.alerts.filter((a) => !a.acknowledged && a.alert_type !== 'INFO' && a.created_at < twoHours).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5).forEach((a) => alerts.push({
            level: 'MEDIUM', icon: '🔔', type: 'UNACKNOWLEDGED', title: `Alerta sin atender: ${a.title}`, detail: a.message || '', time: a.created_at
        }));
        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
        return alerts.sort((a, b) => ((order[a.level] ?? 3) - (order[b.level] ?? 3)) || (ms(b.time) - ms(a.time)));
    });
    on('GET', '/api/dg/ai-report', async () => {
        const d = await dgData();
        const ranking = compliance(d.guards, d.rounds7).map((g) => {
            const ai = Math.round((g.compliance_pct * 0.6) + (g.avg_score * 0.4));
            return { ...g, completed: g.completed_rounds, ai_score: ai, rating: ai >= 80 ? 'EXCELENTE' : ai >= 60 ? 'REGULAR' : 'DEFICIENTE', color: ai >= 80 ? '#10b981' : ai >= 60 ? '#f59e0b' : '#ef4444' };
        });
        const routeHealth = d.routesList.map((r) => {
            const mine = d.rounds7.filter((x) => x.route_id === r.id);
            const completed = mine.filter((x) => x.status === 'COMPLETED').length;
            return { name: r.name, rounds: mine.length, completed, health_pct: mine.length ? Math.round((completed / mine.length) * 1000) / 10 : 0 };
        }).sort((a, b) => a.health_pct - b.health_pct);
        const byDay = new Map();
        d.rounds7.forEach((r) => { const day = localDateOf(r.created_at); const e = byDay.get(day) || { day, total: 0, completed: 0 }; e.total++; if (r.status === 'COMPLETED') e.completed++; byDay.set(day, e); });
        const trend = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
        const avgCompliance = ranking.length ? Math.round(ranking.reduce((s, g) => s + g.compliance_pct, 0) / ranking.length) : 0;
        const top = ranking[0];
        const bottom = ranking[ranking.length - 1];
        const worst = routeHealth[0];
        const openIncidents = d.incidents.filter((i) => i.status === 'OPEN').length;
        let narrative = `Durante los últimos 7 días, la operación registró un cumplimiento promedio del <b>${avgCompliance}%</b> entre ${ranking.length} guardias activos. `;
        if (top) narrative += `El guardia con mejor desempeño fue <b>${top.name}</b> con un score de ${top.ai_score}/100. `;
        if (bottom && bottom.id !== (top && top.id)) narrative += `El guardia con menor desempeño fue <b>${bottom.name}</b> (${bottom.ai_score}/100) — se recomienda revisión. `;
        if (worst) narrative += `La ruta con menor cobertura fue <b>${worst.name}</b> con ${worst.health_pct}% de cumplimiento. `;
        if (openIncidents > 0) narrative += `Hay <b>${openIncidents} incidente(s) abiertos</b> pendientes de resolución.`;
        const recommendations = [];
        ranking.filter((g) => g.ai_score < 60).forEach((g) => recommendations.push(`⚠️ ${g.name} tiene un score bajo (${g.ai_score}/100). Considerar capacitación o seguimiento directo.`));
        routeHealth.filter((r) => r.health_pct < 50).forEach((r) => recommendations.push(`🔴 La ruta "${r.name}" tiene cobertura del ${r.health_pct}%. Revisar asignaciones.`));
        if (!recommendations.length) recommendations.push('✅ Todos los indicadores dentro de parámetros normales. Mantener supervisión rutinaria.');
        return { ranking, route_health: routeHealth, trend, narrative, recommendations, avg_compliance: avgCompliance, generated_at: new Date().toISOString() };
    });
    on('GET', '/api/dg/weekly-report', async () => {
        const d = await dgData();
        const umap = new Map(d.people.map((u) => [u.id, u]));
        const since7 = daysAgoSql(7);
        return {
            company: await company(),
            guards: compliance(d.guards, d.rounds7).map((g) => ({ name: g.name, total_rounds: g.total_rounds, completed: g.completed_rounds, avg_score: g.avg_score, compliance_pct: g.compliance_pct, days_worked: g.days_worked })),
            incidents: d.incidents.filter((i) => i.created_at >= since7).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((i) => ({ ...i, reporter: (umap.get(i.reported_by) || {}).name || i.reporter_name || '' })),
            routes: d.routesList.map((r) => {
                const mine = d.rounds7.filter((x) => x.route_id === r.id);
                return { name: r.name, active_days: new Set(mine.map((x) => localDateOf(x.created_at))).size, rounds: mine.length, completed: mine.filter((x) => x.status === 'COMPLETED').length };
            }),
            period: '7 días', generated_at: new Date().toISOString()
        };
    });

    // ── Vecinos (los mismos de SISDEL) ──
    on('GET', '/api/neighbors', async () => (await neighborsAll()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    on('POST', '/api/neighbors', async (b) => {
        readOnlyGuard();
        if (!b.name || !b.document_id || !b.phone) throw err('Nombre, identificación y teléfono son obligatorios');
        await loadLada();
        const dup = await col('finanzas_residentes').where('dpi', '==', String(b.document_id).trim()).get().catch(() => null);
        if (dup && !dup.empty && !dup.docs.every((d) => d.data().deleted)) throw err('Ya existe un vecino con ese número de identificación', 409);
        const u = await SISDEL.createUser(condoId(), b.name, 'vecino', b.reference || '', localPhone(b.phone), '');
        if (!u) throw err('No se pudo crear el vecino. Solo el administrador puede crear vecinos.');
        const now = new Date();
        const feeFrom = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(now);
        await col('finanzas_residentes').doc(u.id).set({ id: u.id, dpi: String(b.document_id).trim(), feeFrom, createdAt: now.toISOString(), updated_at: now.toISOString() }, { merge: true });
        await saveContacts(u.id, contactsFrom(b));
        invalidate('users');
        return neighborOut(u, { dpi: String(b.document_id).trim() }, { contacts: contactsFrom(b) });
    });
    on('PUT', '/api/neighbors/:id', async (b, p) => {
        readOnlyGuard();
        await loadLada();
        const changes = {};
        if (b.name) changes.name = b.name;
        if (b.phone) changes.phone = localPhone(b.phone);
        if (b.reference !== undefined) changes.casa = b.reference;
        const u = await SISDEL.updateUser(p.id, changes);
        if (!u) throw err('Vecino no encontrado', 404);
        if (Object.keys(b).some((k) => k.startsWith('fam_'))) await saveContacts(p.id, contactsFrom(b));
        invalidate('users');
        return (await neighborsAll()).find((n) => n.id === p.id);
    });
    on('DELETE', '/api/neighbors/:id', async (b, p) => {
        readOnlyGuard();
        if (await SISDEL.hasFinanceMovements(condoId(), p.id)) throw err('Este vecino tiene cargos o pagos en el Sistema Financiero. Desactívelo desde el panel de administración en lugar de eliminarlo.');
        if (!(await SISDEL.deleteUser(p.id))) throw err('No se pudo eliminar el vecino');
        invalidate('users');
        return { success: true };
    });
    on('GET', '/api/neighbors/panic-events', async () => (await panicsOf('vecino')).map((pe) => ({
        id: pe.id, neighbor_id: pe.userId, company_id: condoId(), latitude: pe.lat, longitude: pe.lng,
        status: pe.status === 'ATTENDED' ? 'ACTIVE' : pe.status, resolved_by: pe.resolvedBy || null, resolved_at: sqlFromIso(pe.resolvedAt),
        notes: pe.notes || null, created_at: sqlFromIso(pe.createdAt), neighbor_name: pe.userName, neighbor_phone: pe.phone, document_id: ''
    })));
    // Vista de panico del vecino de RONDIN: el vecino ya entro con su codigo de SISDEL
    async function neighborSelf() {
        const s = session() || {};
        const [me, cfg, contacts] = await Promise.all([
            SISDEL.getUserById(s.userId), config().catch(() => ({})), col('emergencia').doc(s.userId).get().then(one).catch(() => null)
        ]);
        const out = neighborOut({ ...(me || {}), id: s.userId, name: s.userName, casa: (me && me.casa) || s.userCasa }, null, contacts);
        return { ...out, access_code: s.code || '', company_name: s.condominioName || '', company_country: 'GT', neighbor_panic_enabled: cfg.neighbor_panic_enabled ? 1 : 0 };
    }
    async function prepareNeighborSession() {
        const n = await neighborSelf();
        if (!n.neighbor_panic_enabled) throw err('Botón de pánico no habilitado para esta empresa', 403);
        sessionStorage.setItem('sisdel_neighbor', JSON.stringify(n));
    }
    on('GET', '/api/neighbors/by-code/:code', async () => {
        if (myRole() !== 'vecino') throw err('Código no válido', 404);
        const n = await neighborSelf();
        if (!n.neighbor_panic_enabled) throw err('Botón de pánico no habilitado para esta empresa', 403);
        return n;
    });
    on('POST', '/api/neighbors/panic', async (b) => {
        if (myRole() !== 'vecino') throw err('Vecino no encontrado', 404);
        const n = await neighborSelf();
        const ref = col('alertas_panico').doc();
        const s = session() || {};
        await ref.set({
            id: ref.id, condominioId: condoId(), source: 'vecino', userId: s.userId, userName: s.userName || '', casa: n.reference || s.userCasa || '', phone: n.phone || '',
            lat: b.latitude ?? null, lng: b.longitude ?? null, accuracy: null, status: 'ACTIVE', createdAt: new Date().toISOString()
        });
        const familiares = [1, 2, 3, 4, 5].map((i) => ({ nombre: n[`fam_name_${i}`], telefono: n[`fam_phone_${i}`] })).filter((f) => f.telefono);
        // El WhatsApp lo manda el servidor de SISDEL (onPanicCreated) y deja el resultado en la alerta.
        // Se espera unos segundos para mostrarlo como RONDIN; sin respuesta, quedan los botones manuales.
        const recipients = await new Promise((resolve) => {
            let off = () => {};
            let done = false;
            const finish = (value) => { if (done) return; done = true; clearTimeout(timer); off(); resolve(value); };
            const timer = setTimeout(() => finish([]), 10000);
            off = ref.onSnapshot((snap) => {
                const w = snap.exists && snap.data().whatsapp;
                if (w) finish(w.recipients || []);
            }, () => finish([]));
        });
        const whatsappResults = recipients.map((r) => ({ ...r, telefono: (familiares.find((f) => f.nombre === r.nombre) || {}).telefono || '' }));
        return { id: ref.id, neighbor_name: n.name, familiares, whatsapp_results: whatsappResults, timestamp: new Date().toISOString() };
    });

    // ── Rondín Air (drones) ──
    on('GET', '/api/drones', async () => list(await col('rondas_drones').get()));
    on('POST', '/api/drones', async (b) => {
        readOnlyGuard();
        if (!b.name) throw err('El nombre es obligatorio');
        const id = uuid();
        const d = { id, company_id: condoId(), name: b.name, model: b.model || null, status: 'ACTIVE', battery_level: 100, created_at: sql() };
        await col('rondas_drones').doc(id).set(d);
        return d;
    });
    on('POST', '/api/drones/:id/telemetry', async (b, p) => {
        const update = { last_latitude: b.latitude, last_longitude: b.longitude, last_altitude: b.altitude, last_speed: b.speed, last_telemetry_at: sql() };
        if (b.battery_level !== undefined) update.battery_level = b.battery_level;
        await col('rondas_drones').doc(p.id).update(update);
        return { success: true };
    });
    on('GET', '/api/drones/:id/telemetry/latest', async (b, p) => {
        const d = one(await col('rondas_drones').doc(p.id).get());
        return d && d.last_telemetry_at ? { drone_id: d.id, latitude: d.last_latitude, longitude: d.last_longitude, altitude: d.last_altitude, speed: d.last_speed, timestamp: d.last_telemetry_at } : null;
    });

    // ── Servicios de RONDIN que no aplican en SISDEL ──
    on('GET', '/api/fcm/config', async () => ({ apiKey: '', authDomain: '', projectId: '', storageBucket: '', messagingSenderId: '', appId: '', vapidKey: '' }));
    on('POST', '/api/fcm/token', async () => ({ success: true }));
    on('GET', '/api/ping', async () => ({ ok: true, ts: Date.now() }));

    async function route(method, fullPath, body) {
        const url = new URL(fullPath, location.origin);
        const path = url.pathname;
        if (path.startsWith('/api/pipa')) return method === 'GET' ? [] : { success: true };
        const handler = routes.find((r) => r.method === method && r.re.test(path));
        if (!handler) throw err(`Ruta no disponible: ${method} ${path}`, 404);
        if (path !== '/api/auth/login' && path !== '/api/ping') {
            const u = await authReady();
            const s = session();
            if (!s || !u || u.uid !== s.userId) throw err('Sesión vencida', 401);
        }
        try {
            return await handler.handler(body || {}, path.match(handler.re).groups || {}, url.searchParams);
        } catch (e) { throw friendly(e); }
    }

    // ══════════ Tiempo real: reemplazo de socket.io con Firestore ══════════
    const handlers = {};
    const socket = {
        on(event, cb) { (handlers[event] = handlers[event] || []).push(cb); return socket; },
        emit() { return socket; }, // lo que RONDIN emitia al servidor ya lo guardan las rutas
        to() { return socket; },
        fire(event, data) { (handlers[event] || []).forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); }
    };
    let listening = false;
    function listenAdded(query, onDoc) {
        let first = true;
        return query.onSnapshot((snap) => {
            if (first) { first = false; return; }
            snap.docChanges().forEach((c) => { if (c.type === 'added' && !c.doc.metadata.hasPendingWrites) onDoc({ ...c.doc.data(), id: c.doc.id }); });
        }, (e) => console.warn('tiempo real', e.code || e.message));
    }
    async function dispatchDrone(panic, type) {
        try {
            const drones = list(await col('rondas_drones').get()).filter((d) => d.status === 'ACTIVE' && (d.battery_level ?? 100) > 20);
            if (!drones.length) return;
            const drone = drones[0];
            if (!canManage()) return;
            await col('rondas_drones').doc(drone.id).update({ status: 'DISPATCHED' }).catch(() => {});
            socket.fire('drone:panic_dispatch', { drone_id: drone.id, drone_name: drone.name, company_id: condoId(), emergency_type: type, latitude: panic.lat, longitude: panic.lng, event_id: panic.id, timestamp: new Date().toISOString() });
        } catch (e) { console.warn('drones', e); }
    }
    // Panicos nuevos: el primer resultado de Firestore puede venir de la cache local, asi que no sirve
    // para separar lo viejo de lo nuevo; suena solo lo creado en el ultimo minuto (lo anterior queda
    // en Alertas Criticas del panel)
    function listenNewPanics(onPanic) {
        const seen = new Set();
        return col('alertas_panico').where('status', '==', 'ACTIVE').onSnapshot((snap) => {
            snap.docChanges().forEach((c) => {
                if (c.type !== 'added' || c.doc.metadata.hasPendingWrites || seen.has(c.doc.id)) return;
                seen.add(c.doc.id);
                const p = { ...c.doc.data(), id: c.doc.id };
                if (Date.now() - Date.parse(p.createdAt || 0) < 60000) onPanic(p);
            });
        }, (e) => console.warn('panico', e.code || e.message));
    }
    function startRealtime() {
        if (listening || !session()) return;
        listening = true;
        authReady().then(() => {
            const sinceNow = sql();
            // Panico (vecinos y guardias): lo reciben quienes atienden
            if (can('panico.ver')) {
                listenNewPanics((p) => {
                    const mapsUrl = p.lat != null ? `https://www.google.com/maps?q=${p.lat},${p.lng}` : null;
                    if (p.source === 'vecino') {
                        socket.fire('alert:panic', { type: 'neighbor_panic', neighbor: { id: p.userId, name: p.userName, phone: p.phone, document_id: '' }, guard: { id: p.userId, name: `${p.userName}${p.casa ? ' (' + p.casa + ')' : ''}` }, company_name: (session() || {}).condominioName || '', latitude: p.lat, longitude: p.lng, timestamp: p.createdAt, mapsUrl, familiares: [] });
                        dispatchDrone(p, 'NEIGHBOR');
                    } else {
                        socket.fire('alert:panic', { panic: guardPanicOut(p), guard: { id: p.userId, name: p.userName }, latitude: p.lat, longitude: p.lng, timestamp: p.createdAt, mapsUrl });
                        dispatchDrone(p, 'GUARD');
                    }
                });
            }
            if (!isManager()) return;
            col('rondas_en_vivo').onSnapshot((snap) => {
                snap.docChanges().forEach((c) => {
                    if (c.type === 'removed') return;
                    const l = c.doc.data();
                    socket.fire('guard:location:update', { user_id: l.user_id, name: l.name, latitude: l.latitude, longitude: l.longitude, speed: l.speed, battery_level: l.battery_level, timestamp: l.timestamp });
                });
            }, (e) => console.warn('en vivo', e.code || e.message));
            listenAdded(col('rondas_visitas').where('arrived_at', '>=', sinceNow), (v) => socket.fire('checkpoint:visited', {
                visit_id: v.id, guard_name: v.guard_name, guard_id: v.guard_id, checkpoint_name: v.checkpoint_name, checkpoint_id: v.checkpoint_id,
                latitude: v.latitude, longitude: v.longitude, timestamp: new Date(ms(v.arrived_at)).toLocaleString('es-MX', { timeZone: TZ, hour12: true }), timestamp_utc: new Date(ms(v.arrived_at)).toISOString(), country: 'GT'
            }));
            listenAdded(col('rondas_incidentes').where('created_at', '>=', sinceNow), (i) => socket.fire('incident:new', { incident: i, reporter: { id: i.reported_by, name: i.reporter_name } }));
            listenAdded(col('rondas_alertas').where('created_at', '>=', sinceNow), (a) => {
                if (a.alert_type === 'LOGOUT_DURING_SHIFT') socket.fire('new_alert', { id: a.id, title: a.title, message: a.message });
            });
            col('rondas_drones').onSnapshot((snap) => snap.docChanges().forEach((c) => {
                const d = c.doc.data();
                if (c.type === 'modified' && d.last_telemetry_at) socket.fire('drone:telemetry', { drone_id: c.doc.id, latitude: d.last_latitude, longitude: d.last_longitude, altitude: d.last_altitude, speed: d.last_speed, battery_level: d.battery_level });
            }), () => {});
        });
    }
    window.io = function () { startRealtime(); return socket; };

    // ══════════ Cliente de API con la misma forma que el de RONDIN ══════════
    const API = {
        baseUrl: '',
        token: session() ? 'sisdel' : null,
        user: apiUser(),
        async request(method, path, body) {
            try { return await route(method, path, body); } catch (e) {
                if (e.status === 401) { this.logout(); }
                throw e;
            }
        },
        get(path) { return this.request('GET', path); },
        post(path, body) { return this.request('POST', path, body); },
        put(path, body) { return this.request('PUT', path, body); },
        del(path) { return this.request('DELETE', path); },
        async login(credentials) { return route('POST', '/api/auth/login', credentials); },
        async logout() {
            if (this.user && this.user.role === 'GUARDIA') { try { await route('POST', '/api/auth/logout'); } catch { /* sin conexion */ } }
            this.token = null; this.user = null;
            sessionStorage.removeItem('sisdel_neighbor');
            localStorage.removeItem('sisdel_token'); localStorage.removeItem('sisdel_user');
            SISDEL.logout();
        },
        isLoggedIn() {
            const s = session();
            if (!s || s.role === 'master') return false;
            // El vecino entra a RONDIN solo a su boton de panico
            return s.role !== 'vecino' || !!sessionStorage.getItem('sisdel_neighbor');
        }
    };
    window.API = API;

    // Llamadas directas de RONDIN a su servidor (fetch('/api/...')) tambien pasan por aqui
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
        if (!path.startsWith('/api/')) return nativeFetch(input, init);
        const method = (init && init.method) || 'GET';
        let body;
        try { body = init && init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
        try {
            const data = await route(method, path, body);
            return new Response(JSON.stringify(data ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: e.status || 400, headers: { 'Content-Type': 'application/json' } });
        }
    };

    // El vecino edita sus familiares en la vista de panico: RONDIN los guardaba solo en el
    // equipo; aqui quedan en emergencia/{id}, los mismos que avisa el boton de panico de SISDEL
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof App === 'undefined') return;
        // La sirena de panico de RONDIN debia apagarse sola al minuto, pero su codigo apunta a
        // variables que no existen y sonaba hasta tocar "ENTERADO". Se apaga a los 60 s; el aviso
        // rojo queda en pantalla hasta que alguien lo cierre
        if (App.showPanicAlert) {
            const show = App.showPanicAlert;
            App.showPanicAlert = function (data) {
                show.call(this, data);
                clearTimeout(this._sirenStop);
                this._sirenStop = setTimeout(() => {
                    clearInterval(this._panicSirenInterval);
                    ['_panicOsc1', '_panicOsc2'].forEach((k) => { try { if (this[k]) this[k].stop(); } catch { /* ya detenido */ } this[k] = null; });
                    try { if (this._panicGain) this._panicGain.disconnect(); } catch { /* ya desconectado */ }
                    this._panicGain = null;
                    try { if (navigator.vibrate) navigator.vibrate(0); } catch { /* sin vibracion */ }
                }, SIREN_MS);
            };
        }
        if (!App.nbEditContacts) return;
        const original = App.nbEditContacts;
        App.nbEditContacts = async function () {
            const before = JSON.stringify(this._neighborData || {});
            await original.call(this);
            const n = this._neighborData;
            if (!n || JSON.stringify(n) === before || myRole() !== 'vecino') return;
            try { await saveContacts(myId(), contactsFrom(n)); } catch (e) {
                console.error(e);
                Swal.fire('Error', 'No se pudieron guardar los contactos en el servidor', 'error');
            }
        };
    });

    // Acceso a rondas: quien no tiene rondas.ver ni rondas.patrullar va a su pagina de inicio. Los privilegios
    // pudieron cambiar despues del login: se vuelven a leer y, si cambiaron, la pagina se recarga una vez.
    (function guardAccess() {
        const entry = SISDEL.PRIV.PAGES.find((p) => p.page === 'rondin/');
        const s0 = session();
        if (!s0 || s0.role === 'master' || s0.role === 'vecino') return;
        const leave = () => location.replace('../' + (SISDEL.homePage() || 'index.html'));
        if (!SISDEL.PRIV.canEnter(s0.role, s0.privilegios, entry)) { leave(); return; }
        SISDEL.refreshAccess().then((r) => {
            const s1 = session();
            if (!r.ok || !s1) { sessionStorage.removeItem('sisdel_session'); location.replace('../index.html'); return; }
            if (!SISDEL.PRIV.canEnter(s1.role, s1.privilegios, entry)) { leave(); return; }
            if (r.changed && !sessionStorage.getItem('sisdel_rondin_reload')) {
                sessionStorage.setItem('sisdel_rondin_reload', '1');
                location.reload();
            } else if (!r.changed) sessionStorage.removeItem('sisdel_rondin_reload');
        });
    })();

    // RONDIN guardaba su sesion en localStorage; aqui manda la de SISDEL (por pestana)
    localStorage.removeItem('sisdel_token');
    localStorage.removeItem('sisdel_user');
    if (!session()) sessionStorage.removeItem('sisdel_neighbor');
})();
