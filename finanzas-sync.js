/* ═══════════════════════════════════════════════════════════════
   SISDEL - Sincronizacion del Sistema Financiero (OIKOS) con Firestore
   ───────────────────────────────────────────────────────────────
   OIKOS (finanzas/index.html) se usa tal cual, sin modificar: guarda todo
   en localStorage con las claves oikos_multisys-{condoId}_residents,
   _transactions y _settings. Este archivo corre en la pagina contenedora
   (finanzas.html) y conecta esos datos con Firestore.

   Una sola base de vecinos: los residentes de OIKOS SON los vecinos de SISDEL.
     - Nombre, casa y telefono viven en condominios/{c}/usuarios/{id} (rol vecino).
     - Lo que solo usa finanzas (DPI, lote, notas, finiquito...) vive en
       condominios/{c}/finanzas_residentes/{id}, con el mismo id. Asi los
       guardias, que leen usuarios, no ven el DPI ni las notas.
     - Un residente creado en OIKOS se crea como vecino de SISDEL con su codigo.
   Movimientos: condominios/{c}/finanzas_movimientos/{id} (resiId = id del vecino).
   Configuracion: condominios/{c}/finanzas_config/oikos_settings.

   Reglas de la mezcla:
   - Antes de abrir OIKOS se bajan los datos de la nube; gana la version con
     updated_at mas reciente (OIKOS sella updated_at en cada cambio).
   - Nunca se borra un documento: lo que desaparece de la lista local (por
     ejemplo con "deshacer") se sube como anulado (deleted: true), igual que
     OIKOS anula al eliminar.
   - Una lista local vacia o borrada no se sube: se restaura desde la nube.
   - Un vecino que entra al sistema financiero se cobra desde ese mes (feeFrom):
     OIKOS en modo automatico cobraria desde enero a todos los vecinos existentes.
   - Mientras haya cambios sin confirmar queda la marca sisdel_fin_pendiente_*;
     sin esa marca, SISDEL.logout() borra la copia local de OIKOS.
   ═══════════════════════════════════════════════════════════════ */

const SisdelFinanzas = (() => {
    const COL = {
        users: 'usuarios', extras: 'finanzas_residentes',
        transactions: 'finanzas_movimientos', settings: 'finanzas_config'
    };
    const SETTINGS_DOC = 'oikos_settings';
    const PENDING_PREFIX = 'sisdel_fin_pendiente_';
    const KINDS = ['residents', 'transactions', 'settings'];
    // Campos del residente de OIKOS que viven en el vecino de SISDEL
    const CORE_FIELDS = ['name', 'unit', 'contact'];
    // Configuracion inicial de un condominio: quetzales y cobro manual hasta que el admin fije la cuota
    const INITIAL_SETTINGS = { currency: 'GTQ', lang: 'es', feeMode: 'manual' };
    const PUSH_DELAY_MS = 300;
    const RETRY_MS = 10000;
    const FIRST_LOAD_TIMEOUT_MS = 20000;
    const BATCH_SIZE = 400;
    const CODE_ATTEMPTS = 12;

    // ── Funciones puras (se prueban en scripts/test-finanzas-sync.mjs) ──

    // OIKOS deriva su empresa interna de ?msid=: 'multisys-' + msid
    function oikosCompanyId(condoId) { return 'multisys-' + condoId; }
    function storageKey(condoId, name) { return 'oikos_' + oikosCompanyId(condoId) + '_' + name; }
    function pendingKey(condoId) { return PENDING_PREFIX + condoId; }

    // Id de documento valido para Firestore (sin '/')
    function docIdOf(item) { return String(item.id).replace(/\//g, '_'); }

    function stampOf(item) {
        const t = Date.parse((item && item.updated_at) || '');
        return Number.isFinite(t) ? t : 0;
    }

    // Periodo de cuota de OIKOS: 'YYYY-MM'
    function periodOf(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }

    // Copia apta para Firestore: sin undefined ni funciones
    function plain(value) { return JSON.parse(JSON.stringify(value)); }

    // JSON estable para comparar: claves ordenadas y sin el saldo (OIKOS lo recalcula siempre)
    function canon(item) {
        const sortKeys = (v) => {
            if (Array.isArray(v)) return v.map(sortKeys);
            if (v && typeof v === 'object') {
                return Object.keys(v).sort().reduce((o, k) => { if (v[k] !== undefined) o[k] = sortKeys(v[k]); return o; }, {});
            }
            return v;
        };
        const copy = { ...item };
        delete copy.balance;
        return JSON.stringify(sortKeys(copy));
    }

    function parseArray(raw) {
        if (raw === null || raw === undefined) return null;
        try {
            const value = JSON.parse(raw);
            return Array.isArray(value) ? value : [];
        } catch { return []; }
    }

    function parseObject(raw) {
        if (raw === null || raw === undefined) return null;
        try {
            const value = JSON.parse(raw);
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch { return null; }
    }

    // Telefono de SISDEL -> contacto de OIKOS (con codigo de pais para WhatsApp)
    function toContact(phone) {
        const text = String(phone || '').trim();
        if (!text) return '';
        if (text.startsWith('+')) return text;
        const digits = text.replace(/\D/g, '');
        return digits ? '+502' + digits : '';
    }

    // Vecino de SISDEL + datos financieros -> residente de OIKOS
    function toResident(user, extra) {
        const r = { ...(extra || {}) };
        delete r.balance;
        r.id = user.id;
        r.name = user.name || '';
        r.unit = user.casa || '';
        r.contact = toContact(user.phone);
        if (!r.createdAt) r.createdAt = user.createdAt || null;
        const stamp = Math.max(stampOf({ updated_at: user.updatedAt || user.createdAt }), stampOf(extra));
        if (stamp) r.updated_at = new Date(stamp).toISOString();
        return r;
    }

    // Residente de OIKOS -> cambios para el vecino de SISDEL + datos financieros
    function splitResident(resident, user) {
        const extra = { ...resident };
        CORE_FIELDS.concat('balance').forEach((k) => delete extra[k]);
        extra.id = String(resident.id);
        const core = {
            name: String(resident.name || '').trim(),
            casa: String(resident.unit || '').trim(),
            phone: String(resident.contact || '').trim()
        };
        if (!user) return { core, changes: null, extra };
        const changes = {};
        if (core.name && core.name !== user.name) changes.name = core.name;
        if (core.casa !== String(user.casa || '')) changes.casa = core.casa;
        if (core.phone !== toContact(user.phone)) changes.phone = core.phone;
        return { core, changes, extra };
    }

    // Mezcla la lista local con la de la nube (Map docId -> item).
    // Gana el updated_at mas reciente; en empate gana la nube.
    // keepLocalOnly=false descarta lo que solo existe en este equipo (p. ej. un
    // vecino que se elimino en SISDEL) en vez de subirlo.
    function mergeList(localItems, cloudById, keepLocalOnly = true) {
        const merged = [];
        const toPush = [];
        const seen = new Set();
        (localItems || []).forEach((item) => {
            if (!item || item.id === null || item.id === undefined) return;
            const id = docIdOf(item);
            if (seen.has(id)) return;
            seen.add(id);
            const cloud = cloudById.get(id);
            if (!cloud && !keepLocalOnly) return;
            if (cloud && stampOf(cloud) >= stampOf(item)) {
                merged.push(cloud);
            } else {
                merged.push(item);
                toPush.push(item);
            }
        });
        const cloudOnly = [...cloudById.entries()]
            .filter(([id]) => !seen.has(id))
            .map(([, item]) => item)
            .sort((a, b) => String(a.created_at || a.createdAt || '').localeCompare(String(b.created_at || b.createdAt || '')));
        merged.push(...cloudOnly);
        return { merged, toPush };
    }

    // Compara la lista local actual con lo ultimo sincronizado (Map docId -> canon).
    // Devuelve los cambios a subir y si hubo que re-sellar o anular algo
    // (en ese caso la lista local debe reescribirse con `items`).
    function diffList(items, syncedById, nowIso) {
        const out = items.slice();
        const changed = [];
        const present = new Set();
        let rewrite = false;
        out.forEach((item, index) => {
            if (!item || item.id === null || item.id === undefined) return;
            const id = docIdOf(item);
            present.add(id);
            const prevCanon = syncedById.get(id);
            if (prevCanon === canon(item)) return;
            let next = item;
            if (prevCanon) {
                const prev = JSON.parse(prevCanon);
                // Cambio sin sello nuevo (p. ej. "rehacer" con un registro viejo): se sella ahora
                if (stampOf(item) <= stampOf(prev)) {
                    next = { ...item, updated_at: nowIso };
                    out[index] = next;
                    rewrite = true;
                }
            }
            changed.push(next);
        });
        // Lo que desaparecio sin anularse ("deshacer" un alta): se anula
        syncedById.forEach((prevCanon, id) => {
            if (present.has(id)) return;
            const prev = JSON.parse(prevCanon);
            if (prev.deleted) return;
            const tombstone = { ...prev, deleted: true, updated_at: nowIso };
            out.push(tombstone);
            changed.push(tombstone);
            rewrite = true;
        });
        return { items: out, changed, rewrite };
    }

    // ── Privilegios: que privilegio exige cada escritura ──
    // Es el espejo, en el navegador, de las reglas de firestore.rules (finanzas_residentes, finanzas_movimientos y
    // finanzas_config): las reglas son la barrera real; esto evita subir lo que se sabe que no se aceptara y deja la
    // copia local igual que la nube (sin datos fantasma) cuando OIKOS escribio algo que el usuario no puede hacer.
    // Una "necesidad" es una lista de condiciones que se cumplen TODAS; cada condicion es una lista de claves de las que
    // basta UNA. [] = sin requisito extra; [[]] = no se permite.
    const TOUCH_KEYS = ['updated_at', 'created_at', 'createdAt', 'id'];
    const RESIDENT_STATE_KEYS = ['status', 'closedAt', 'closeReason', 'closeNotes', 'reactivatedAt', 'feeFrom'];
    const RESIDENT_DELETE_KEYS = ['deleted', 'deleted_at'];
    const MOVEMENT_ANNUL_KEYS = ['deleted', 'deleted_at', 'deleted_reason', 'updated_at'];
    // "Deshacer" solo alcanza lo hecho hace poco (igual que firestore.rules): la pila de deshacer vive en la memoria de la pagina
    const UNDO_WINDOW_MS = 2 * 60 * 60 * 1000;
    const SETTINGS_FEE_KEYS = ['fee', 'chargeDay', 'graceDays', 'feeMode'];
    const SETTINGS_GENERAL_KEYS = ['currency', 'lang', 'name', 'theme'];
    const SETTINGS_OPERATION_KEYS = ['receiptCounter', 'chargedMonths', 'lastChargedMonth'];

    // Claves cuyo valor difiere entre dos objetos (JSON)
    function changedKeys(next, prev) {
        const a = next || {};
        const b = prev || {};
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...keys].filter((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
    }

    // Datos financieros de un residente de OIKOS (todo menos nombre, casa, telefono y saldo)
    function extraOf(resident) {
        const extra = { ...(resident || {}) };
        CORE_FIELDS.concat('balance').forEach((k) => delete extra[k]);
        return extra;
    }

    function satisfied(needs, can) {
        return needs.every((clause) => clause.some((key) => can(key)));
    }

    // next/prev: residente de OIKOS (mezcla de vecino y datos financieros); prev = null si es nuevo en la nube
    function residentNeeds(next, prev, userExists) {
        if (!userExists || !prev) return [['finanzas.residentes_crear']];
        const needs = [];
        if (changedKeys(next, prev).some((k) => CORE_FIELDS.includes(k))) needs.push(['finanzas.residentes_editar']);
        const keys = changedKeys(extraOf(next), extraOf(prev)).filter((k) => !TOUCH_KEYS.includes(k));
        if (keys.some((k) => RESIDENT_STATE_KEYS.includes(k))) needs.push(['finanzas.residentes_finiquitar']);
        if (keys.some((k) => RESIDENT_DELETE_KEYS.includes(k))) needs.push(['finanzas.residentes_eliminar']);
        if (keys.some((k) => !RESIDENT_STATE_KEYS.includes(k) && !RESIDENT_DELETE_KEYS.includes(k))) needs.push(['finanzas.residentes_editar']);
        return needs;
    }

    function movementNeeds(next, prev, now = Date.now()) {
        const recent = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && now - t < UNDO_WINDOW_MS; };
        const type = next && next.type;
        if (!prev) {
            if (type === 'income') return [['finanzas.pagos_registrar']];
            if (type === 'expense') {
                const initial = next.concept === 'Saldo Inicial Adeudado';
                return [initial ? ['finanzas.egresos_registrar', 'finanzas.residentes_crear'] : ['finanzas.egresos_registrar']];
            }
            if (type === 'charge') {
                if (next.kind === 'fee') {
                    return next.auto === true ? [['finanzas.cuotas_mes']] : [['finanzas.cuotas_mes', 'finanzas.cuotas_meses', 'finanzas.cargos_crear']];
                }
                if (next.kind === 'extra') return [['finanzas.cargos_crear']];
            }
            return [[]];
        }
        const keys = changedKeys(next, prev);
        if (keys.every((k) => k === 'updated_at')) return [];
        if (prev.type === 'charge' && !prev.period && keys.every((k) => ['period', 'kind', 'updated_at'].includes(k))) return [];
        if (keys.every((k) => MOVEMENT_ANNUL_KEYS.includes(k))) {
            if (next.deleted === true && prev.deleted !== true) {
                const own = prev.type === 'income' ? ['finanzas.pagos_anular']
                    : prev.type === 'expense' ? ['finanzas.egresos_anular']
                        : prev.type === 'charge' ? (prev.kind === 'fee' ? ['finanzas.cargos_anular', 'finanzas.cuotas_corregir'] : ['finanzas.cargos_anular']) : [];
                return [[...(recent(prev.created_at) ? ['finanzas.deshacer'] : []), ...own]];
            }
            if (prev.deleted === true && next.deleted !== true) return recent(prev.updated_at) ? [['finanzas.deshacer']] : [[]];
        }
        return [[]];
    }

    function settingsNeeds(next, prev) {
        if (!prev) return [];
        const needs = [];
        const keys = changedKeys(next, prev).filter((k) => !TOUCH_KEYS.includes(k));
        if (keys.some((k) => SETTINGS_FEE_KEYS.includes(k))) needs.push(['finanzas.config_cuota']);
        if (keys.some((k) => SETTINGS_GENERAL_KEYS.includes(k))) needs.push(['finanzas.config_general']);
        if (keys.includes('customIncomeConcepts')) needs.push(['finanzas.config_conceptos', 'finanzas.cargos_crear']);
        if (keys.includes('customExpenseConcepts')) needs.push(['finanzas.config_conceptos', 'finanzas.egresos_registrar']);
        const known = [...SETTINGS_FEE_KEYS, ...SETTINGS_GENERAL_KEYS, ...SETTINGS_OPERATION_KEYS, 'customIncomeConcepts', 'customExpenseConcepts'];
        if (keys.some((k) => !known.includes(k))) needs.push(['finanzas.config_general']);
        return needs;
    }

    // ── Sincronizacion en el navegador ──

    function start(condoId, handlers = {}) {
        const db = window.sisdelFirebase.db;
        const condoRef = db.collection('condominios').doc(condoId);
        const onStatus = handlers.onStatus || (() => {});
        const onRemoteChange = handlers.onRemoteChange || (() => {});
        const onResidentCreated = handlers.onResidentCreated || (() => {});
        const newAccessCode = handlers.newAccessCode;
        // can(clave) -> bool. Sin ella no se filtra nada (las reglas igual rechazan lo que no corresponde).
        const can = typeof handlers.can === 'function' ? handlers.can : null;
        // onBlocked({ kind, count, silent }): se descartaron cambios que el usuario no puede hacer
        const onBlocked = handlers.onBlocked || (() => {});

        // Ultima version conocida de la nube
        const cloud = { users: new Map(), extras: new Map(), transactions: new Map(), settings: null };
        // Lo que creemos que tiene la nube, en forma comparable (canon)
        const synced = { residents: new Map(), transactions: new Map(), settings: null };
        const timers = {};
        const unsubscribers = [];
        // Snapshots que llegan durante la primera carga; se aplican al terminarla
        const remote = {};
        const queued = { users: [], extras: [], transactions: [], settings: [] };
        let inFlight = 0;
        let failed = null;
        let ready = false;
        let disposed = false;

        const ref = {
            users: () => condoRef.collection(COL.users),
            extras: () => condoRef.collection(COL.extras),
            transactions: () => condoRef.collection(COL.transactions),
            settings: () => condoRef.collection(COL.settings).doc(SETTINGS_DOC)
        };
        const readRaw = (name) => localStorage.getItem(storageKey(condoId, name));
        const writeRaw = (name, value) => localStorage.setItem(storageKey(condoId, name), JSON.stringify(value));
        const nowIso = () => new Date().toISOString();

        function cloudResident(id) {
            const user = cloud.users.get(id);
            return user ? toResident(user, cloud.extras.get(id)) : null;
        }
        function cloudResidents() {
            return new Map([...cloud.users.keys()].map((id) => [id, cloudResident(id)]));
        }

        function hasPending() { return inFlight > 0 || Object.values(timers).some(Boolean); }
        function markPending() { try { localStorage.setItem(pendingKey(condoId), '1'); } catch { /* sin espacio */ } }
        function updateStatus() {
            if (hasPending()) { onStatus('saving'); return; }
            if (failed) { onStatus(failed); return; }
            try { localStorage.removeItem(pendingKey(condoId)); } catch { /* ignorar */ }
            onStatus(navigator.onLine === false ? 'offline' : 'ok');
        }

        async function commitInChunks(writes) {
            for (let i = 0; i < writes.length; i += BATCH_SIZE) {
                const batch = db.batch();
                writes.slice(i, i + BATCH_SIZE).forEach((write) => write(batch));
                await batch.commit();
            }
        }

        // Residente nuevo creado en OIKOS: se crea el vecino en SISDEL con su codigo de acceso.
        // El codigo es el id de su documento: si ya existe, la escritura se rechaza y se prueba otro.
        async function createVecino(resident, core, extra) {
            const id = docIdOf(resident);
            const user = {
                id, condominioId: condoId, name: core.name || 'Vecino', role: 'vecino',
                casa: core.casa, phone: core.phone, email: '',
                paymentStatus: 'al_dia', morosoSince: null, active: true,
                createdAt: resident.createdAt || nowIso(), updatedAt: resident.updated_at || nowIso()
            };
            let lastError = null;
            for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
                const code = newAccessCode(user.name);
                const batch = db.batch();
                batch.set(db.collection('codigos').doc(code), { condominioId: condoId, userId: id, role: 'vecino', createdAt: user.createdAt });
                batch.set(ref.users().doc(id), user);
                batch.set(ref.extras().doc(id), plain(extra));
                try {
                    await batch.commit();
                    cloud.users.set(id, user);
                    cloud.extras.set(id, extra);
                    onResidentCreated(user.name, code);
                    return;
                } catch (error) {
                    if (!String(error && error.code || '').includes('permission-denied')) throw error;
                    lastError = error;
                }
            }
            throw lastError;
        }

        async function writeResidents(items) {
            const writes = [];
            const creations = [];
            const applied = [];
            items.forEach((resident) => {
                const id = docIdOf(resident);
                const user = cloud.users.get(id);
                const { core, changes, extra } = splitResident(resident, user);
                if (!user && !resident.deleted) { creations.push({ resident, core, extra }); return; }
                if (user && Object.keys(changes).length) {
                    const update = { ...changes, updatedAt: resident.updated_at || nowIso() };
                    writes.push((b) => b.update(ref.users().doc(id), update));
                    applied.push(() => cloud.users.set(id, { ...user, ...update }));
                }
                writes.push((b) => b.set(ref.extras().doc(id), plain(extra)));
                applied.push(() => cloud.extras.set(id, extra));
            });
            await commitInChunks(writes);
            applied.forEach((fn) => fn());
            for (const c of creations) await createVecino(c.resident, c.core, c.extra);
        }

        async function writeTransactions(items) {
            await commitInChunks(items.map((item) => (b) => b.set(ref.transactions().doc(docIdOf(item)), plain(item))));
            items.forEach((item) => cloud.transactions.set(docIdOf(item), item));
        }

        async function writeSettings(item) {
            await ref.settings().set(plain(item));
            cloud.settings = item;
        }

        // ¿Puede este usuario escribir este cambio? Se compara con lo ultimo que sabemos de la nube.
        function allowedItem(kind, item) {
            if (!can) return true;
            const id = docIdOf(item);
            if (kind === 'settings') {
                const prev = synced.settings ? JSON.parse(synced.settings) : null;
                return satisfied(settingsNeeds(item, prev), can);
            }
            const prevCanon = synced[kind].get(id);
            const prev = prevCanon ? JSON.parse(prevCanon) : null;
            if (kind === 'transactions') return satisfied(movementNeeds(item, prev), can);
            return satisfied(residentNeeds(item, prev, cloud.users.has(id)), can);
        }

        // Lo que el usuario no puede hacer se descarta y la copia local vuelve a ser la de la nube:
        // sin datos fantasma que alteren saldos, morosos o reportes en este equipo.
        function revertRejected(kind, rejected) {
            if (kind === 'settings') {
                writeRaw('settings', cloud.settings || INITIAL_SETTINGS);
                synced.settings = cloud.settings ? canon(cloud.settings) : null;
                return;
            }
            const byId = kind === 'residents' ? cloudResidents() : cloud.transactions;
            const gone = new Set(rejected.map(docIdOf));
            const next = (parseArray(readRaw(kind)) || []).filter((x) => !(x && x.id !== undefined && x.id !== null && gone.has(docIdOf(x))));
            gone.forEach((id) => {
                const mine = byId.get(id);
                if (mine) { next.push(mine); synced[kind].set(id, canon(mine)); } else synced[kind].delete(id);
            });
            writeRaw(kind, next);
        }

        function gate(kind, items) {
            if (!can) return items;
            const allowed = [];
            const rejected = [];
            items.forEach((item) => (allowedItem(kind, item) ? allowed : rejected).push(item));
            if (rejected.length) {
                revertRejected(kind, rejected);
                // Las cuotas automaticas que OIKOS genera al abrir (si el usuario no puede cobrarlas) no son una accion suya
                const silent = rejected.every((item) => item && item.type === 'charge' && item.auto === true);
                onBlocked({ kind, count: rejected.length, silent });
            }
            return allowed;
        }

        // Sube cambios. Se marcan como sincronizados al enviarlos:
        // asi un "deshacer" inmediato todavia detecta que hay que anularlos.
        async function push(kind, items) {
            items = gate(kind, items);
            if (!items.length) return;
            items.forEach((item) => {
                if (kind === 'settings') synced.settings = canon(item);
                else synced[kind].set(docIdOf(item), canon(item));
            });
            markPending();
            inFlight++;
            updateStatus();
            try {
                if (kind === 'residents') await writeResidents(items);
                else if (kind === 'transactions') await writeTransactions(items);
                else await writeSettings(items[0]);
                failed = null;
            } catch (error) {
                console.error('Sistema Financiero: no se pudo guardar', error);
                const denied = String(error && error.code || '').includes('permission-denied');
                failed = denied ? 'denied' : 'error';
                // Se olvida lo enviado: el siguiente intento lo vuelve a subir.
                // Sin permisos no se reintenta (sesion vencida o usuario desactivado).
                items.forEach((item) => {
                    if (kind === 'settings') synced.settings = null;
                    else synced[kind].delete(docIdOf(item));
                });
                if (!disposed && !denied) setTimeout(() => schedule(kind, 0), RETRY_MS);
            } finally {
                inFlight--;
                updateStatus();
            }
        }

        // Restaura una lista que OIKOS dejo vacia o borro (p. ej. "Borrar todo")
        function restoreList(kind) {
            const byId = kind === 'residents' ? cloudResidents() : cloud.transactions;
            const items = [...byId.values()];
            if (!items.length) return;
            writeRaw(kind, items);
            synced[kind] = new Map(items.map((item) => [docIdOf(item), canon(item)]));
            onRemoteChange('restored');
        }

        function flushList(kind) {
            const items = parseArray(readRaw(kind));
            if (!items || (items.length === 0 && synced[kind].size > 0)) { restoreList(kind); return; }
            const { items: next, changed, rewrite } = diffList(items, synced[kind], nowIso());
            if (rewrite) writeRaw(kind, next);
            push(kind, changed);
        }

        function flushSettings() {
            const current = parseObject(readRaw('settings'));
            if (!current) {
                if (cloud.settings) { writeRaw('settings', cloud.settings); onRemoteChange('restored'); }
                return;
            }
            if (canon(current) === synced.settings) return;
            let next = current;
            const prev = synced.settings ? JSON.parse(synced.settings) : null;
            if (prev && stampOf(current) <= stampOf(prev)) {
                next = { ...current, updated_at: nowIso() };
                writeRaw('settings', next);
            }
            push('settings', [next]);
        }

        function flush(kind) {
            timers[kind] = null;
            if (disposed || !ready) return;
            if (kind === 'settings') flushSettings();
            else flushList(kind);
            updateStatus();
        }

        function schedule(kind, delay = PUSH_DELAY_MS) {
            if (timers[kind]) clearTimeout(timers[kind]);
            markPending();
            timers[kind] = setTimeout(() => flush(kind), delay);
            updateStatus();
        }

        // OIKOS escribe en localStorage dentro del iframe: esta pagina recibe el evento 'storage'
        function onStorage(event) {
            if (event.storageArea !== localStorage) return;
            if (event.key === null) { KINDS.forEach((k) => schedule(k)); return; }
            KINDS.forEach((kind) => { if (event.key === storageKey(condoId, kind)) schedule(kind); });
        }

        // Aplica a la copia local los registros de la nube mas nuevos que los locales
        function applyRemote(kind, incoming, removedIds = []) {
            const local = parseArray(readRaw(kind)) || [];
            let applied = false;
            let next = local;
            if (removedIds.length) {
                const gone = new Set(removedIds);
                next = local.filter((x) => !(x && x.id !== undefined && gone.has(docIdOf(x))));
                removedIds.forEach((id) => synced[kind].delete(id));
                applied = next.length !== local.length;
            }
            const indexById = new Map();
            next.forEach((x, i) => { if (x && x.id !== undefined && x.id !== null) indexById.set(docIdOf(x), i); });
            incoming.forEach((item) => {
                const id = docIdOf(item);
                const i = indexById.get(id);
                const mine = i === undefined ? null : next[i];
                if (mine && stampOf(mine) >= stampOf(item)) return;
                synced[kind].set(id, canon(item));
                if (mine) next[i] = item;
                else { indexById.set(id, next.length); next.push(item); }
                applied = true;
            });
            if (applied) { writeRaw(kind, next); onRemoteChange('remote'); }
        }

        // Vecino que todavia no tiene datos financieros: se cobra desde este mes
        function missingExtras() {
            const period = periodOf(new Date());
            const created = [];
            cloud.users.forEach((user, id) => {
                if (cloud.extras.has(id)) return;
                const extra = { id, feeFrom: period, updated_at: nowIso() };
                cloud.extras.set(id, extra);
                created.push(extra);
            });
            return created;
        }

        async function saveExtras(extras) {
            if (!extras.length) return;
            inFlight++;
            markPending();
            updateStatus();
            try {
                await commitInChunks(extras.map((e) => (b) => b.set(ref.extras().doc(e.id), e)));
            } catch (error) {
                console.error('Sistema Financiero: no se pudieron preparar los vecinos', error);
                failed = 'error';
            } finally {
                inFlight--;
                updateStatus();
            }
        }

        // Escucha una consulta o documento. Resuelve con la primera respuesta del
        // servidor; las siguientes son cambios de otros equipos.
        function listen(name, target) {
            return new Promise((resolve, reject) => {
                let first = true;
                const timer = setTimeout(() => reject(new Error('timeout')), FIRST_LOAD_TIMEOUT_MS);
                const unsubscribe = target.onSnapshot((snap) => {
                    if (first) { first = false; clearTimeout(timer); resolve(snap); return; }
                    if (remote[name]) remote[name](snap); else queued[name].push(snap);
                }, (error) => {
                    clearTimeout(timer);
                    if (first) { reject(error); return; }
                    console.error('Sistema Financiero: se perdio la conexion en tiempo real', error);
                    failed = String(error && error.code || '').includes('permission-denied') ? 'denied' : 'error';
                    updateStatus();
                });
                unsubscribers.push(unsubscribe);
            });
        }

        function changesOf(snap) {
            const docs = [];
            const removed = [];
            snap.docChanges().forEach((c) => {
                if (c.doc.metadata.hasPendingWrites) return;
                if (c.type === 'removed') removed.push(c.doc.id);
                else docs.push({ ...c.doc.data(), id: c.doc.data().id !== undefined ? c.doc.data().id : c.doc.id, _docId: c.doc.id });
            });
            return { docs, removed };
        }

        async function hydrate() {
            onStatus('loading');
            const hadPending = (() => { try { return localStorage.getItem(pendingKey(condoId)) === '1'; } catch { return false; } })();
            const [usersSnap, extrasSnap, txSnap, setSnap] = await Promise.all([
                listen('users', ref.users().where('role', '==', 'vecino')),
                listen('extras', ref.extras()),
                listen('transactions', ref.transactions()),
                listen('settings', ref.settings())
            ]);

            usersSnap.docs.forEach((d) => cloud.users.set(d.id, { ...d.data(), id: d.id }));
            extrasSnap.docs.forEach((d) => cloud.extras.set(d.id, d.data()));
            txSnap.docs.forEach((d) => cloud.transactions.set(d.id, d.data()));
            const newExtras = missingExtras();

            const toPush = {};
            // Residentes: la nube (vecinos de SISDEL) manda. Lo que solo esta en este
            // equipo se sube unicamente si quedo pendiente de una sesion anterior.
            const residents = cloudResidents();
            synced.residents = new Map([...residents.entries()].map(([id, r]) => [id, canon(r)]));
            const localRes = parseArray(readRaw('residents'));
            const res = mergeList(localRes || [], residents, hadPending);
            writeRaw('residents', res.merged);
            toPush.residents = res.toPush;

            synced.transactions = new Map([...cloud.transactions.entries()].map(([id, t]) => [id, canon(t)]));
            const localTx = parseArray(readRaw('transactions'));
            const tx = mergeList(localTx || [], cloud.transactions, true);
            if (tx.merged.length || localTx) writeRaw('transactions', tx.merged);
            toPush.transactions = tx.toPush;

            cloud.settings = setSnap.exists ? setSnap.data() : null;
            synced.settings = cloud.settings ? canon(cloud.settings) : null;
            const localSettings = parseObject(readRaw('settings'));
            if (cloud.settings && (!localSettings || stampOf(cloud.settings) >= stampOf(localSettings))) {
                writeRaw('settings', cloud.settings);
            } else if (localSettings) {
                toPush.settings = [localSettings];
            } else {
                writeRaw('settings', INITIAL_SETTINGS);
            }

            // Desde aqui cada snapshot es un cambio de otro equipo (o de otra pagina de SISDEL)
            remote.users = (snap) => {
                const { docs, removed } = changesOf(snap);
                docs.forEach(({ _docId, ...u }) => cloud.users.set(_docId, { ...u, id: _docId }));
                removed.forEach((id) => cloud.users.delete(id));
                saveExtras(missingExtras());
                applyRemote('residents', docs.map((u) => cloudResident(u._docId)).filter(Boolean), removed);
            };
            remote.extras = (snap) => {
                const { docs } = changesOf(snap);
                docs.forEach((e) => { const { _docId, ...extra } = e; cloud.extras.set(_docId, extra); });
                applyRemote('residents', docs.map((e) => cloudResident(e._docId)).filter(Boolean));
            };
            remote.transactions = (snap) => {
                const { docs } = changesOf(snap);
                const items = docs.map(({ _docId, ...t }) => { cloud.transactions.set(_docId, t); return t; });
                applyRemote('transactions', items);
            };
            remote.settings = (snap) => {
                if (!snap.exists || snap.metadata.hasPendingWrites) return;
                const item = snap.data();
                cloud.settings = item;
                const mine = parseObject(readRaw('settings'));
                if (mine && stampOf(mine) >= stampOf(item)) return;
                synced.settings = canon(item);
                writeRaw('settings', item);
                onRemoteChange('remote');
            };
            Object.keys(queued).forEach((name) => queued[name].splice(0).forEach((snap) => remote[name](snap)));

            ready = true;
            window.addEventListener('storage', onStorage);
            await saveExtras(newExtras);
            await Promise.all(Object.entries(toPush).map(([kind, items]) => push(kind, items || [])));
            updateStatus();
        }

        // Espera a que se confirme todo lo pendiente (o se agote el tiempo)
        async function waitIdle(timeoutMs = 10000) {
            Object.keys(timers).forEach((kind) => { if (timers[kind]) { clearTimeout(timers[kind]); flush(kind); } });
            const until = Date.now() + timeoutMs;
            while (hasPending() && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
            return !hasPending() && !failed;
        }

        function dispose() {
            disposed = true;
            window.removeEventListener('storage', onStorage);
            unsubscribers.forEach((u) => { try { u(); } catch { /* ignorar */ } });
        }

        window.addEventListener('online', updateStatus);
        window.addEventListener('offline', updateStatus);

        return { ready: hydrate(), hasPending, waitIdle, dispose };
    }

    return {
        start,
        internals: {
            oikosCompanyId, storageKey, pendingKey, docIdOf, stampOf, periodOf, canon, parseArray,
            toContact, toResident, splitResident, mergeList, diffList, INITIAL_SETTINGS,
            changedKeys, extraOf, satisfied, residentNeeds, movementNeeds, settingsNeeds
        }
    };
})();

// Node (pruebas): exportar las funciones puras
if (typeof module !== 'undefined' && module.exports) module.exports = SisdelFinanzas;
