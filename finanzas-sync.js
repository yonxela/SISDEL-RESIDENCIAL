/* ═══════════════════════════════════════════════════════════════
   SISDEL - Sincronizacion del Sistema Financiero (OIKOS) con Firestore
   ───────────────────────────────────────────────────────────────
   Este archivo corre en la pagina contenedora (finanzas.html) y conecta los datos de OIKOS
   (finanzas/index.html) con Firestore. Los datos viven en la memoria de esta pagina
   (window.sisdelFinanzasStore, ver finanzas-datos.js): OIKOS lee y escribe ahi con su objeto Store.

   Una sola base de vecinos: los residentes de OIKOS SON los vecinos de SISDEL.
     - Nombre, casa y telefono viven en condominios/{c}/usuarios/{id} (rol vecino).
     - Lo que solo usa finanzas (DPI, lote, notas, finiquito...) vive en
       condominios/{c}/finanzas_residentes/{id}, con el mismo id. Asi los
       guardias, que leen usuarios, no ven el DPI ni las notas.
     - Un residente creado en OIKOS se crea como vecino de SISDEL con su codigo.
   Movimientos: condominios/{c}/finanzas_movimientos/{id} (resiId = id del vecino).
   Configuracion: condominios/{c}/finanzas_config/oikos_settings.

   Como se cargan los movimientos (un condominio grande junta decenas de miles):
   - El equipo guarda un espejo de los movimientos de la nube en IndexedDB (finanzas-datos.js). La primera
     vez se bajan todos por paginas; despues solo se piden los que cambiaron desde la ultima vez.
   - "Que cambio" lo dice el sello del servidor (server_at) que pone la funcion stampFinanceMovement a cada
     movimiento que se crea o modifica: no depende del reloj de ningun equipo. Ese campo nunca llega a OIKOS
     ni se sube desde aqui (las reglas no dejan).
   - El espejo se rehace completo cada 30 dias, al cerrar sesion (se borra) o con finanzas.html?recargar=1.

   Reglas de la mezcla:
   - Antes de abrir OIKOS se bajan los datos de la nube; gana la version con
     updated_at mas reciente (OIKOS sella updated_at en cada cambio).
   - Nunca se borra un documento: lo que desaparece de la lista local (por
     ejemplo con "deshacer") se sube como anulado (deleted: true), igual que
     OIKOS anula al eliminar.
   - Una lista local vacia o borrada no se sube: se restaura desde la nube.
   - Un vecino que entra al sistema financiero se cobra desde ese mes (feeFrom):
     OIKOS en modo automatico cobraria desde enero a todos los vecinos existentes.
   - Lo que cambia en este equipo y todavia no subio queda guardado en IndexedDB y se sube la proxima vez.
     Mientras lo haya queda la marca sisdel_fin_pendiente_*; sin esa marca, SISDEL.logout() borra la copia.
   - La copia en localStorage de la version anterior (oikos_multisys-{condoId}_*) se mezcla una vez y se borra.
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
    // Movimientos por pagina al bajar de la nube (el emulador de Firestore no entrega mas de 10 000 seguidos)
    const PAGE_SIZE = 3000;
    // Espera maxima por cada pagina: mas larga que la de la primera respuesta, porque una pagina pesa y en una
    // conexion lenta tarda. Si se agota, lo ya bajado queda guardado y "Reintentar" sigue desde ahi.
    const PAGE_TIMEOUT_MS = 60000;
    // El espejo de este equipo se rehace completo pasado este tiempo
    const MIRROR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    // Una carga completa interrumpida se retoma si empezo hace menos de esto
    const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    // Al pedir "lo que cambio" se retrocede un poco: releer unos movimientos no cuesta y no deja huecos
    const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
    // Sello del servidor en cada movimiento (lo pone functions/src/finanzas/index.js)
    const SERVER_STAMP = 'server_at';

    // ── Funciones puras (se prueban en scripts/test-finanzas-sync.mjs) ──

    // OIKOS deriva su empresa interna de ?msid=: 'multisys-' + msid
    function oikosCompanyId(condoId) { return 'multisys-' + condoId; }
    function storageKey(condoId, name) { return 'oikos_' + oikosCompanyId(condoId) + '_' + name; }
    function pendingKey(condoId) { return PENDING_PREFIX + condoId; }
    // Vecinos que este equipo ya vio en la nube (para no resucitar uno eliminado desde una copia local pendiente)
    function knownKey(condoId) { return 'sisdel_fin_conocidos_' + condoId; }

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

    // Sello del servidor: { s: segundos, n: nanosegundos } a partir de un Timestamp de Firestore
    function stampValue(ts) {
        if (!ts || typeof ts !== 'object') return null;
        const s = Number(ts.seconds !== undefined ? ts.seconds : ts.s);
        const n = Number(ts.nanoseconds !== undefined ? ts.nanoseconds : ts.n);
        return Number.isFinite(s) ? { s, n: Number.isFinite(n) ? n : 0 } : null;
    }
    function laterStamp(a, b) {
        if (!a) return b || null;
        if (!b) return a;
        return (b.s > a.s || (b.s === a.s && b.n > a.n)) ? b : a;
    }
    // El mismo sello, `ms` milisegundos antes (nunca antes del inicio de los tiempos)
    function stampMinus(stamp, ms) {
        if (!stamp) return { s: 0, n: 0 };
        return { s: Math.max(0, stamp.s - Math.ceil(ms / 1000)), n: stamp.n };
    }
    // El mismo registro sin el sello del servidor
    function withoutServerStamp(item) {
        if (!item || typeof item !== 'object' || !(SERVER_STAMP in item)) return item;
        const copy = { ...item };
        delete copy[SERVER_STAMP];
        return copy;
    }
    // Un sello imposible (muy adelantado respecto de este equipo) no mueve el punto de reanudacion
    function saneStamp(stamp, nowMs) {
        return !!stamp && stamp.s * 1000 <= nowMs + 24 * 60 * 60 * 1000;
    }

    // ¿Sirve el espejo guardado en este equipo? 'usar' (solo pedir cambios), 'retomar' (seguir una carga
    // completa que se interrumpio) o 'cargar' (bajar todo de nuevo).
    function mirrorPlan(info, schema, nowMs, force) {
        if (force || !info || info.schema !== schema) return 'cargar';
        const age = nowMs - Date.parse(info.loadedAt || '');
        if (!Number.isFinite(age)) return 'cargar';
        if (info.complete) return age > MIRROR_MAX_AGE_MS ? 'cargar' : 'usar';
        return info.lastId && info.chunks > 0 && age <= RESUME_MAX_AGE_MS ? 'retomar' : 'cargar';
    }

    // Lista con la que abre OIKOS: la nube en su orden (orderedCloud), con las versiones de este equipo que
    // son mas nuevas en su lugar y, al final, lo que solo existe aqui. Mismas reglas que mergeList.
    function overlayList(orderedCloud, cloudById, localItems, keepLocalOnly = true) {
        const winners = new Map();
        const localOnly = [];
        const toPush = [];
        const seen = new Set();
        (localItems || []).forEach((item) => {
            if (!item || item.id === null || item.id === undefined) return;
            const id = docIdOf(item);
            if (seen.has(id)) return;
            seen.add(id);
            const cloud = cloudById.get(id);
            if (!cloud && !keepLocalOnly) return;
            if (cloud && stampOf(cloud) >= stampOf(item)) return;
            toPush.push(item);
            if (cloud) winners.set(id, item); else localOnly.push(item);
        });
        const merged = winners.size
            ? orderedCloud.map((c) => (c && c.id !== undefined && c.id !== null && winners.get(docIdOf(c))) || c)
            : orderedCloud.slice();
        localOnly.forEach((item) => merged.push(item));
        return { merged, toPush };
    }

    // Lo sincronizado se guarda como objeto (o como texto canon, en las pruebas)
    const canonOf = (value) => (typeof value === 'string' ? value : canon(value));
    const objectOf = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

    // Compara la lista local actual con lo ultimo sincronizado (Map docId -> registro).
    // Devuelve los cambios a subir y si hubo que re-sellar o anular algo
    // (en ese caso la lista local debe reemplazarse por `items`). No modifica lo que recibe.
    function diffList(items, syncedById, nowIso) {
        const out = items.slice();
        const changed = [];
        const present = new Set();
        let rewrite = false;
        out.forEach((item, index) => {
            if (!item || item.id === null || item.id === undefined) return;
            const id = docIdOf(item);
            present.add(id);
            const prevRaw = syncedById.get(id);
            // El mismo objeto: no cambio (los registros guardados nunca se modifican, ver finanzas-datos.js)
            if (prevRaw === item) return;
            if (prevRaw && canonOf(prevRaw) === canon(item)) return;
            let next = item;
            if (prevRaw) {
                const prev = objectOf(prevRaw);
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
        syncedById.forEach((prevRaw, id) => {
            if (present.has(id)) return;
            const prev = objectOf(prevRaw);
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
    const RESIDENT_DELETE_KEYS = ['deleted', 'deleted_at', 'restored_at'];
    const MOVEMENT_ANNUL_KEYS = ['deleted', 'deleted_at', 'deleted_reason', 'restored_at', 'updated_at'];
    // "Deshacer" solo alcanza lo hecho hace poco (igual que firestore.rules): la pila de deshacer vive en la memoria de la pagina
    const UNDO_WINDOW_MS = 2 * 60 * 60 * 1000;
    const SETTINGS_FEE_KEYS = ['fee', 'feeBreakdown', 'chargeDay', 'graceDays', 'feeMode'];
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

    // Solo las claves de `item` que cambiaron respecto a `prev` (mas las que siempre viajan). Al subir solo eso, un
    // documento que otro equipo cambio mientras tanto (un finiquito, la cuota) no se pisa con la copia vieja de este equipo.
    function pick(item, keys) {
        const out = {};
        keys.forEach((k) => { if (item[k] !== undefined) out[k] = item[k]; });
        return out;
    }
    function changedFields(item, prev, always = ['id', 'updated_at']) {
        return [...new Set([...changedKeys(item, prev), ...always.filter((k) => item[k] !== undefined)])];
    }
    // Al deshacer una anulacion (o una eliminacion, o un finiquito) el registro de este equipo ya no trae esos campos.
    // Como solo se suben los campos presentes, la nube se quedaba con deleted:true: en pantalla el pago volvia y en
    // el servidor seguia anulado. Aqui se arma lo que hay que decirle a la nube, SIN borrar nada alla (todo deja
    // rastro): el interruptor se apaga de forma explicita y se anota cuando se devolvio; el motivo y la fecha de la
    // anulacion quedan en el documento.
    function revivedFields(item, prev) {
        const out = {};
        if (!item || !prev) return out;
        if (prev.deleted === true && item.deleted !== true) {
            if (item.deleted === undefined) out.deleted = false;
            out.restored_at = item.updated_at || new Date().toISOString();
        }
        if (prev.status === 'closed' && item.status === undefined) out.status = 'active';
        return out;
    }
    // Lo que se sube de un registro que ya existia: los campos que cambiaron mas lo que se devolvio al deshacer
    function changedData(item, prev, always) {
        return { ...pick(plain(item), changedFields(item, prev, always)), ...revivedFields(item, prev) };
    }

    // Residentes que solo existen en esta copia local pero que la nube YA conocio (`known`): los elimino otro
    // equipo o el panel admin, no son nuevos; subirlos los resucitaria con un codigo de acceso nuevo.
    function dropResurrected(localItems, cloudById, known) {
        return (localItems || []).filter((r) => {
            if (!r || r.id === null || r.id === undefined) return true;
            const id = docIdOf(r);
            return cloudById.has(id) || !known.has(id);
        });
    }

    function satisfied(needs, can) {
        return needs.every((clause) => clause.some((key) => can(key)));
    }

    // next/prev: residente de OIKOS (mezcla de vecino y datos financieros); prev = null si es nuevo en la nube
    function residentNeeds(next, prev, userExists) {
        // Un residente nuevo crea tambien al vecino de SISDEL (usuarios + codigos): exige ambos privilegios
        if (!userExists || !prev) return [['finanzas.residentes_crear'], ['usuarios.crear']];
        const needs = [];
        // Nombre, casa y telefono viven en el vecino de SISDEL
        if (changedKeys(next, prev).some((k) => CORE_FIELDS.includes(k))) needs.push(['finanzas.residentes_editar'], ['usuarios.editar']);
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
            // Todo movimiento nace con un monto numerico mayor que cero (igual que las reglas)
            if (!(typeof next.amount === 'number' && next.amount > 0)) return [[]];
            if (type === 'income') return [['finanzas.pagos_registrar']];
            if (type === 'expense') return [['finanzas.egresos_registrar']];
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
        const D = window.SisdelFinanzasDatos;
        const fs = window.firebase.firestore;
        const condoRef = db.collection('condominios').doc(condoId);
        const onStatus = handlers.onStatus || (() => {});
        const onRemoteChange = handlers.onRemoteChange || (() => {});
        const onResidentCreated = handlers.onResidentCreated || (() => {});
        // onProgress(movimientos leidos): avance de la carga de movimientos
        const onProgress = handlers.onProgress || (() => {});
        const newAccessCode = handlers.newAccessCode;
        // can(clave) -> bool. Sin ella no se filtra nada (las reglas igual rechazan lo que no corresponde).
        const can = typeof handlers.can === 'function' ? handlers.can : null;
        // onBlocked({ kind, count, silent }): se descartaron cambios que el usuario no puede hacer
        const onBlocked = handlers.onBlocked || (() => {});
        // Marcas pequenas de este equipo (pendiente, vecinos conocidos); las pruebas pasan una propia por equipo
        const localStorage = (() => { try { return handlers.storage || window.localStorage; } catch { return null; } })();
        // Movimientos por pagina (las pruebas usan paginas chicas para probar la paginacion con pocos datos)
        const pageSize = handlers.pageSize > 0 ? handlers.pageSize : PAGE_SIZE;

        // Los datos de OIKOS viven aqui (ver finanzas-datos.js); OIKOS los encuentra en window.sisdelFinanzasStore
        const store = D.createStore('oikos_' + oikosCompanyId(condoId) + '_');
        window.sisdelFinanzasStore = store;

        // Ultima version conocida de la nube. transactions es el espejo que tambien se guarda en este equipo.
        const cloud = { users: new Map(), extras: new Map(), transactions: new Map(), settings: null };
        // Lo que creemos que tiene la nube (se adelanta al enviar): registros, nunca se modifican
        const synced = { residents: new Map(), transactions: new Map(), settings: null };
        // Cambios de este equipo que la nube todavia no confirmo (tambien en IndexedDB, para no perderlos)
        const pendingLocal = { residents: new Map(), transactions: new Map(), settings: new Map() };
        const timers = {};
        const unsubscribers = [];
        // Snapshots que llegan durante la primera carga; se aplican al terminarla
        const remote = {};
        const queued = { users: [], extras: [], transactions: [], settings: [] };
        let cache = D.nullCache();
        // Sello del servidor del ultimo movimiento visto: desde ahi se piden los cambios
        let cursor = null;
        let mirrorInfo = null;
        let inFlight = 0;
        // Ids que se estan subiendo en este momento (todavia sin confirmar): no se olvidan como pendientes
        const inFlightIds = { residents: new Set(), transactions: new Set(), settings: new Set() };
        // Ultima falla por cada cosa que se sube o se escucha. Una subida que sale bien solo borra la suya: antes
        // habia una sola bandera y guardar la configuracion "tapaba" un pago que no habia subido.
        const failures = { transactions: null, residents: null, settings: null, extras: null, listen: null };
        const failedState = () => failures.transactions || failures.residents || failures.settings || failures.extras || failures.listen;
        let ready = false;
        let disposed = false;

        const ref = {
            users: () => condoRef.collection(COL.users),
            extras: () => condoRef.collection(COL.extras),
            transactions: () => condoRef.collection(COL.transactions),
            settings: () => condoRef.collection(COL.settings).doc(SETTINGS_DOC)
        };
        const readKnown = () => { try { return new Set(JSON.parse(localStorage.getItem(knownKey(condoId)) || '[]')); } catch { return new Set(); } };
        const rememberKnown = () => { try { const seen = readKnown(); cloud.users.forEach((u, id) => seen.add(id)); localStorage.setItem(knownKey(condoId), JSON.stringify([...seen])); } catch { /* sin espacio */ } };
        const nowIso = () => new Date().toISOString();
        const hasId = (x) => !!x && x.id !== undefined && x.id !== null;
        const toTimestamp = (stamp) => new fs.Timestamp(stamp ? stamp.s : 0, stamp ? stamp.n : 0);
        const withTimeout = (promise) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT_MS);
            promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });

        function cloudResident(id) {
            const user = cloud.users.get(id);
            return user ? toResident(user, cloud.extras.get(id)) : null;
        }
        function cloudResidents() {
            return new Map([...cloud.users.keys()].map((id) => [id, cloudResident(id)]));
        }

        function hasPending() { return inFlight > 0 || Object.values(timers).some(Boolean); }
        function markPending() { try { localStorage.setItem(pendingKey(condoId), '1'); } catch { /* sin espacio */ } }
        // ¿Queda algo de este equipo que la nube no confirmo?
        function hasUnsynced() { return KINDS.some((kind) => pendingLocal[kind].size > 0); }
        function updateStatus() {
            if (hasPending()) { onStatus('saving'); return; }
            const failed = failedState();
            if (failed) { onStatus(failed); return; }
            // La marca de pendiente se quita solo cuando ya no queda nada por subir
            if (!hasUnsynced()) { try { localStorage.removeItem(pendingKey(condoId)); } catch { /* ignorar */ } }
            onStatus(navigator.onLine === false ? 'offline' : 'ok');
        }

        // ── Cambios de este equipo sin confirmar ──
        function rememberPending(kind, items) {
            const fresh = items.filter((item) => {
                const id = kind === 'settings' ? 'settings' : docIdOf(item);
                if (pendingLocal[kind].get(id) === item) return false;
                pendingLocal[kind].set(id, item);
                return true;
            });
            if (!fresh.length) return;
            markPending();
            cache.putPending(kind, fresh);
        }
        // La nube confirmo estos cambios (si mientras tanto no cambiaron otra vez)
        function settlePending(kind, items) {
            const ids = [];
            items.forEach((item) => {
                const id = kind === 'settings' ? 'settings' : docIdOf(item);
                if (pendingLocal[kind].get(id) !== item) return;
                pendingLocal[kind].delete(id);
                ids.push(id);
            });
            if (ids.length) cache.deletePending(kind, ids);
        }
        function forgetPending(kind, ids) {
            const gone = ids.filter((id) => pendingLocal[kind].delete(id));
            if (gone.length) cache.deletePending(kind, gone);
        }
        // Deja como pendiente exactamente lo que hoy difiere de la nube (`changed`) mas lo que se esta subiendo.
        // Lo que ya no difiere (se deshizo, o la lista volvio a ser la de la nube) deja de estar pendiente: si no,
        // al volver a abrir se subiria un cambio que el usuario ya habia deshecho.
        function syncPending(kind, changed) {
            rememberPending(kind, changed);
            const keep = new Set(changed.map((item) => (kind === 'settings' ? 'settings' : docIdOf(item))));
            const stale = [...pendingLocal[kind].keys()].filter((id) => !keep.has(id) && !inFlightIds[kind].has(id));
            if (stale.length) forgetPending(kind, stale);
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

        // prevById: lo ultimo que sabiamos de la nube de cada documento, para subir solo lo que cambio
        async function writeResidents(items, prevById) {
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
                const prev = prevById && prevById.get(id) ? extraOf(prevById.get(id)) : null;
                const data = prev ? changedData(extra, prev) : plain(extra);
                writes.push((b) => b.set(ref.extras().doc(id), data, { merge: true }));
                applied.push(() => cloud.extras.set(id, { ...(cloud.extras.get(id) || {}), ...data }));
            });
            await commitInChunks(writes);
            applied.forEach((fn) => fn());
            for (const c of creations) await createVecino(c.resident, c.core, c.extra);
        }

        async function writeTransactions(items, prevById) {
            const payloads = items.map((item) => {
                const id = docIdOf(item);
                const prev = prevById && prevById.get(id) ? prevById.get(id) : null;
                const data = prev ? changedData(item, prev) : plain(item);
                // El sello del servidor nunca sale de aqui (una copia vieja podia traerlo pegado al movimiento)
                delete data[SERVER_STAMP];
                return { id, item, data };
            });
            await commitInChunks(payloads.map(({ id, data }) => (b) => b.set(ref.transactions().doc(id), data, { merge: true })));
            // El espejo queda como quedo la nube. Si es igual a lo que tiene OIKOS se guarda EL MISMO registro:
            // asi la comparacion siguiente lo reconoce sin recorrerlo.
            const mirrored = payloads.map(({ id, item, data }) => {
                const merged = { ...(cloud.transactions.get(id) || {}), ...data };
                const record = canon(merged) === canon(item) ? item : merged;
                cloud.transactions.set(id, record);
                return record;
            });
            cache.applyDeltas(mirrored, null);
        }

        async function writeSettings(item, prev) {
            const data = prev ? pick(plain(item), changedFields(item, prev, ['updated_at'])) : plain(item);
            await ref.settings().set(data, { merge: true });
            cloud.settings = { ...(cloud.settings || {}), ...data };
        }

        // ¿Puede este usuario escribir este cambio? Se compara con lo ultimo que sabemos de la nube.
        function allowedItem(kind, item) {
            if (!can) return true;
            if (kind === 'settings') return satisfied(settingsNeeds(item, synced.settings), can);
            const id = docIdOf(item);
            const prev = synced[kind].get(id) || null;
            if (kind === 'transactions') return satisfied(movementNeeds(item, prev), can);
            return satisfied(residentNeeds(item, prev, cloud.users.has(id)), can);
        }

        // Lo que el usuario no puede hacer se descarta y la lista de OIKOS vuelve a ser la de la nube:
        // sin datos fantasma que alteren saldos, morosos o reportes en este equipo.
        function revertRejected(kind, rejected) {
            if (kind === 'settings') {
                store.replace('settings', cloud.settings || INITIAL_SETTINGS, true);
                synced.settings = cloud.settings || null;
                forgetPending('settings', ['settings']);
                return;
            }
            const byId = kind === 'residents' ? cloudResidents() : cloud.transactions;
            const gone = new Set(rejected.map(docIdOf));
            const next = (store.read(kind) || []).filter((x) => !(hasId(x) && gone.has(docIdOf(x))));
            gone.forEach((id) => {
                const mine = byId.get(id);
                if (mine) { next.push(mine); synced[kind].set(id, mine); } else synced[kind].delete(id);
            });
            forgetPending(kind, [...gone]);
            store.replace(kind, next, true);
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
            // Lo ultimo que sabiamos de la nube: para subir solo los campos que cambiaron y para volver atras si falla
            const prevSettings = synced.settings;
            const prevById = new Map(items.map((item) => [docIdOf(item), kind === 'settings' ? null : (synced[kind].get(docIdOf(item)) || null)]));
            items.forEach((item) => {
                if (kind === 'settings') synced.settings = item;
                else synced[kind].set(docIdOf(item), item);
            });
            const flying = items.map((item) => (kind === 'settings' ? 'settings' : docIdOf(item)));
            flying.forEach((id) => inFlightIds[kind].add(id));
            markPending();
            inFlight++;
            updateStatus();
            try {
                if (kind === 'residents') await writeResidents(items, prevById);
                else if (kind === 'transactions') await writeTransactions(items, prevById);
                else await writeSettings(items[0], prevSettings);
                failures[kind] = null;
                settlePending(kind, items);
            } catch (error) {
                console.error('Sistema Financiero: no se pudo guardar', error);
                const denied = String(error && error.code || '').includes('permission-denied');
                failures[kind] = denied ? 'denied' : 'error';
                // Se vuelve a lo que sabiamos antes de enviar: el siguiente intento lo sube de nuevo como el mismo cambio
                // (no como un alta). Sin permisos no se reintenta (sesion vencida o usuario desactivado).
                items.forEach((item) => {
                    if (kind === 'settings') { synced.settings = prevSettings; return; }
                    const prev = prevById.get(docIdOf(item));
                    if (prev) synced[kind].set(docIdOf(item), prev); else synced[kind].delete(docIdOf(item));
                });
                if (!disposed && !denied) setTimeout(() => schedule(kind, 0), RETRY_MS);
            } finally {
                flying.forEach((id) => inFlightIds[kind].delete(id));
                inFlight--;
                updateStatus();
            }
        }

        // Restaura una lista que OIKOS dejo vacia o borro (p. ej. "Borrar todo")
        function restoreList(kind) {
            const byId = kind === 'residents' ? cloudResidents() : cloud.transactions;
            const items = D.canonicalOrder([...byId.values()]);
            if (!items.length) return;
            store.replace(kind, items, false);
            synced[kind] = new Map(items.filter(hasId).map((item) => [docIdOf(item), item]));
            onRemoteChange('restored');
        }

        function flushList(kind) {
            const items = store.read(kind);
            if (!Array.isArray(items) || (items.length === 0 && synced[kind].size > 0)) { restoreList(kind); return null; }
            const { items: next, changed, rewrite } = diffList(items, synced[kind], nowIso());
            if (rewrite) store.replace(kind, next, true);
            syncPending(kind, changed);
            return push(kind, changed);
        }

        function flushSettings() {
            const current = store.read('settings');
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                if (cloud.settings) { store.replace('settings', cloud.settings, false); onRemoteChange('restored'); }
                return null;
            }
            if (synced.settings && canon(current) === canon(synced.settings)) { syncPending('settings', []); return null; }
            let next = current;
            if (synced.settings && stampOf(current) <= stampOf(synced.settings)) {
                next = { ...current, updated_at: nowIso() };
                store.replace('settings', next, true);
            }
            syncPending('settings', [next]);
            return push('settings', [next]);
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

        // OIKOS guardo algo (Store.set). El cambio se anota enseguida en este equipo (por si la pagina se
        // cierra antes de subirlo) y se sube poco despues, junto con lo demas de la misma accion.
        function onLocalWrite(kind) {
            if (disposed || !ready) return;
            try {
                if (kind === 'settings') {
                    const current = store.read('settings');
                    if (current && typeof current === 'object') syncPending('settings', synced.settings && canon(current) === canon(synced.settings) ? [] : [current]);
                } else {
                    const items = store.read(kind);
                    if (Array.isArray(items) && items.length) syncPending(kind, diffList(items, synced[kind], nowIso()).changed);
                }
            } catch (error) { console.error('Sistema Financiero: no se pudo anotar el cambio en este equipo', error); }
            schedule(kind);
        }

        // Aplica a la lista de OIKOS los registros de la nube mas nuevos que los de este equipo
        function applyRemote(kind, incoming, removedIds = []) {
            const local = store.read(kind) || [];
            let next = local;
            let applied = false;
            if (removedIds.length) {
                const gone = new Set(removedIds);
                next = local.filter((x) => !(hasId(x) && gone.has(docIdOf(x))));
                removedIds.forEach((id) => synced[kind].delete(id));
                forgetPending(kind, removedIds);
                applied = next.length !== local.length;
            }
            const indexById = new Map();
            next.forEach((x, i) => { if (hasId(x)) indexById.set(docIdOf(x), i); });
            const replaced = [];
            incoming.forEach((item) => {
                const id = docIdOf(item);
                const i = indexById.get(id);
                const mine = i === undefined ? null : next[i];
                if (mine && stampOf(mine) >= stampOf(item)) return;
                // No esta en la lista de OIKOS pero la nube si lo tenia: se acaba de quitar en este equipo (se deshizo
                // su alta) y la anulacion todavia no subio. No se vuelve a poner: llega, por ejemplo, el sello del
                // servidor de la propia alta. Se anota lo que tiene la nube para que la anulacion parta de ahi.
                if (!mine && synced[kind].has(id)) { synced[kind].set(id, item); return; }
                // La lista guardada no se modifica (la comparten las fotos de deshacer de OIKOS): se copia al primer cambio
                if (next === local) next = local.slice();
                synced[kind].set(id, item);
                if (mine) { next[i] = item; replaced.push(id); }
                else { indexById.set(id, next.length); next.push(item); }
                applied = true;
            });
            if (replaced.length) forgetPending(kind, replaced);
            if (applied) { store.replace(kind, next, true); onRemoteChange('remote'); }
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
                // merge: si otro equipo acaba de guardar el residente con sus datos, no se pisan
                await commitInChunks(extras.map((e) => (b) => b.set(ref.extras().doc(e.id), e, { merge: true })));
                failures.extras = null;
            } catch (error) {
                console.error('Sistema Financiero: no se pudieron preparar los vecinos', error);
                failures.extras = 'error';
            } finally {
                inFlight--;
                updateStatus();
            }
        }

        function onListenError(error) {
            console.error('Sistema Financiero: se perdio la conexion en tiempo real', error);
            failures.listen = String(error && error.code || '').includes('permission-denied') ? 'denied' : 'error';
            updateStatus();
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
                    onListenError(error);
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

        // ── Movimientos: espejo de la nube en este equipo ──

        // Movimiento como lo ve OIKOS (sin el sello del servidor) y su sello
        function movementOf(doc) {
            const record = doc.data();
            const stamp = stampValue(record[SERVER_STAMP]);
            delete record[SERVER_STAMP];
            // Un documento escrito por un script sin el campo id se trata con el id de su documento: sin el, la
            // lista de OIKOS y lo sincronizado no coincidirian y el movimiento se subiria como anulado.
            if (record.id === undefined || record.id === null) record.id = doc.id;
            return { id: doc.id, record, stamp };
        }
        function infoNow(extra) {
            mirrorInfo = { schema: D.SCHEMA, complete: true, cursor, loadedAt: (mirrorInfo && mirrorInfo.loadedAt) || nowIso(), ...(extra || {}) };
            return mirrorInfo;
        }
        function advanceCursor(stamp) {
            if (saneStamp(stamp, Date.now())) cursor = laterStamp(cursor, stamp);
        }

        // Baja todos los movimientos por paginas (la primera vez, o cuando el espejo vencio). `resume`: carga interrumpida.
        async function loadAllMovements(resume) {
            let lastId = null;
            let chunk = 0;
            let startedAt = nowIso();
            if (resume) {
                cursor = resume.info.cursor || null;
                lastId = resume.info.lastId;
                chunk = resume.info.chunks;
                startedAt = resume.info.loadedAt;
                cloud.transactions = resume.records;
            } else {
                // El sello mas reciente ANTES de empezar: lo que cambie mientras se baja se pide despues desde ahi
                const latest = await withTimeout(ref.transactions().orderBy(SERVER_STAMP, 'desc').limit(1).get({ source: 'server' }));
                cursor = null;
                if (!latest.empty) advanceCursor(movementOf(latest.docs[0]).stamp);
                cloud.transactions = new Map();
                await cache.resetMirror({ schema: D.SCHEMA, complete: false, cursor, loadedAt: startedAt, lastId: null, chunks: 0 });
            }
            onProgress(cloud.transactions.size);
            for (;;) {
                let query = ref.transactions().orderBy(fs.FieldPath.documentId()).limit(pageSize);
                if (lastId) query = query.startAfter(lastId);
                const snap = await withTimeout(query.get({ source: 'server' }));
                const records = snap.docs.map((doc) => {
                    const { id, record } = movementOf(doc);
                    cloud.transactions.set(id, record);
                    return record;
                });
                if (snap.size) {
                    lastId = snap.docs[snap.size - 1].id;
                    await cache.appendChunk(chunk++, records, { schema: D.SCHEMA, complete: false, cursor, loadedAt: startedAt, lastId, chunks: chunk });
                }
                onProgress(cloud.transactions.size);
                if (snap.size < pageSize) break;
            }
            mirrorInfo = { schema: D.SCHEMA, complete: true, cursor, loadedAt: startedAt };
            await cache.setInfo(mirrorInfo);
        }

        // Pide lo que cambio desde el ultimo sello visto (con un margen hacia atras), por paginas
        async function loadChangedMovements() {
            const base = ref.transactions().where(SERVER_STAMP, '>', toTimestamp(stampMinus(cursor, CURSOR_OVERLAP_MS))).orderBy(SERVER_STAMP);
            let last = null;
            let count = 0;
            for (;;) {
                const query = last ? base.startAfter(last).limit(pageSize) : base.limit(pageSize);
                const snap = await withTimeout(query.get({ source: 'server' }));
                const records = snap.docs.map((doc) => {
                    const { id, record, stamp } = movementOf(doc);
                    cloud.transactions.set(id, record);
                    advanceCursor(stamp);
                    return record;
                });
                count += records.length;
                if (records.length) await cache.applyDeltas(records, infoNow());
                if (snap.size < pageSize) break;
                last = snap.docs[snap.size - 1];
            }
            return count;
        }

        // Deja cloud.transactions al dia. Devuelve cuantos cambios sueltos acumula la copia de este equipo.
        async function loadMovements(saved) {
            const plan = mirrorPlan(saved.info, D.SCHEMA, Date.now(), handlers.reload === true);
            let loose = 0;
            if (plan === 'usar') {
                cloud.transactions = saved.records;
                cursor = saved.info.cursor || null;
                mirrorInfo = saved.info;
                loose = saved.deltaCount;
                onProgress(cloud.transactions.size);
            } else {
                await loadAllMovements(plan === 'retomar' ? saved : null);
            }
            loose += await loadChangedMovements();
            onProgress(cloud.transactions.size);
            return loose;
        }

        // Cambios de otros equipos (y el sello de los propios) mientras la pagina esta abierta
        function listenMovements() {
            const query = ref.transactions().where(SERVER_STAMP, '>', toTimestamp(cursor)).orderBy(SERVER_STAMP);
            unsubscribers.push(query.onSnapshot((snap) => {
                const records = [];
                snap.docChanges().forEach((c) => {
                    if (c.doc.metadata.hasPendingWrites || c.type === 'removed') return;
                    const { id, record, stamp } = movementOf(c.doc);
                    // Si es lo mismo que ya tiene este equipo se conserva el registro que ya se comparte con OIKOS
                    const known = cloud.transactions.get(id);
                    const kept = known && canon(known) === canon(record) ? known : record;
                    cloud.transactions.set(id, kept);
                    advanceCursor(stamp);
                    records.push(kept);
                });
                if (!records.length) return;
                cache.applyDeltas(records, infoNow());
                applyRemote('transactions', records);
            }, onListenError));
        }

        // Copia de la version anterior en localStorage: se mezcla una vez (por si quedaron cambios sin subir)
        function readLegacy() {
            try {
                // La version anterior guardaba cada movimiento como llegaba de la nube: desde que el servidor sella,
                // con server_at incluido. Ese campo no es de OIKOS ni se puede subir: se quita.
                const transactions = parseArray(localStorage.getItem(storageKey(condoId, 'transactions')));
                return {
                    residents: parseArray(localStorage.getItem(storageKey(condoId, 'residents'))),
                    transactions: transactions && transactions.map(withoutServerStamp),
                    settings: parseObject(localStorage.getItem(storageKey(condoId, 'settings')))
                };
            } catch { return { residents: null, transactions: null, settings: null }; }
        }
        function dropLegacy() {
            try { KINDS.forEach((kind) => localStorage.removeItem(storageKey(condoId, kind))); } catch { /* ignorar */ }
        }

        async function hydrate() {
            onStatus('loading');
            const hadPending = (() => { try { return localStorage.getItem(pendingKey(condoId)) === '1'; } catch { return false; } })();
            cache = handlers.cache || await D.openCache(condoId);
            const saved = await cache.load();
            const legacy = readLegacy();
            const hasLegacy = !!(legacy.residents || legacy.transactions || legacy.settings);
            const waiting = { residents: [], transactions: [], settings: [] };
            saved.pending.forEach((p) => { if (p && waiting[p.kind] && p.item) waiting[p.kind].push(p.item); });

            const [usersSnap, extrasSnap, setSnap, loose] = await Promise.all([
                listen('users', ref.users().where('role', '==', 'vecino')),
                listen('extras', ref.extras()),
                listen('settings', ref.settings()),
                loadMovements(saved)
            ]);

            usersSnap.docs.forEach((d) => cloud.users.set(d.id, { ...d.data(), id: d.id }));
            extrasSnap.docs.forEach((d) => cloud.extras.set(d.id, d.data()));
            const newExtras = missingExtras();

            // Residentes: la nube (vecinos de SISDEL) manda. Lo que solo esta en este
            // equipo se sube unicamente si quedo pendiente de una sesion anterior.
            const residents = cloudResidents();
            synced.residents = new Map(residents);
            // Lo local-solo se sube unicamente si quedo pendiente; nunca un vecino que la nube ya conocio (lo eliminaron)
            const localRes = dropResurrected(waiting.residents.concat(legacy.residents || []), residents, readKnown());
            const res = overlayList(D.canonicalOrder([...residents.values()]), residents, localRes, hadPending);
            rememberKnown();
            store.replace('residents', res.merged, false);

            const ordered = D.canonicalOrder([...cloud.transactions.values()]);
            synced.transactions = new Map(cloud.transactions);
            const tx = overlayList(ordered, cloud.transactions, waiting.transactions.concat(legacy.transactions || []), true);
            store.replace('transactions', tx.merged, false);

            cloud.settings = setSnap.exists ? setSnap.data() : null;
            synced.settings = cloud.settings || null;
            const localSettings = waiting.settings[0] || legacy.settings;
            let localSettingsWon = false;
            if (cloud.settings && (!localSettings || stampOf(cloud.settings) >= stampOf(localSettings))) {
                store.replace('settings', cloud.settings, false);
            } else if (localSettings) {
                store.replace('settings', localSettings, false);
                localSettingsWon = true;
            } else {
                store.replace('settings', INITIAL_SETTINGS, false);
            }

            // Lo que este equipo traia anotado como pendiente. Al subir (mas abajo) queda pendiente solo lo que siga
            // difiriendo de la nube; lo que la nube ya supero se olvida.
            saved.pending.forEach((p) => { if (p && pendingLocal[p.kind] && p.item) pendingLocal[p.kind].set(p.id, p.item); });

            // Desde aqui cada snapshot es un cambio de otro equipo (o de otra pagina de SISDEL)
            remote.users = (snap) => {
                const { docs, removed } = changesOf(snap);
                docs.forEach(({ _docId, ...u }) => cloud.users.set(_docId, { ...u, id: _docId }));
                rememberKnown();
                removed.forEach((id) => cloud.users.delete(id));
                saveExtras(missingExtras());
                applyRemote('residents', docs.map((u) => cloudResident(u._docId)).filter(Boolean), removed);
            };
            remote.extras = (snap) => {
                const { docs } = changesOf(snap);
                docs.forEach((e) => { const { _docId, ...extra } = e; cloud.extras.set(_docId, extra); });
                applyRemote('residents', docs.map((e) => cloudResident(e._docId)).filter(Boolean));
            };
            remote.settings = (snap) => {
                if (!snap.exists || snap.metadata.hasPendingWrites) return;
                const item = snap.data();
                cloud.settings = item;
                const mine = store.read('settings');
                if (mine && stampOf(mine) >= stampOf(item)) return;
                synced.settings = item;
                forgetPending('settings', ['settings']);
                store.replace('settings', item, true);
                onRemoteChange('remote');
            };
            Object.keys(queued).forEach((name) => { if (remote[name]) queued[name].splice(0).forEach((snap) => remote[name](snap)); });
            listenMovements();

            ready = true;
            store.setLocalListener(onLocalWrite);
            await saveExtras(newExtras);
            // Se sube lo que este equipo tenia sin subir. Que subir se decide AHORA, comparando la lista con la nube
            // (no antes de la espera de arriba): si mientras tanto llego una version mas nueva de un registro, ya no
            // hay nada suyo que subir. La configuracion solo si la de este equipo era la mas nueva.
            if (!localSettingsWon) syncPending('settings', []);
            await Promise.all([flushList('residents'), flushList('transactions'), localSettingsWon ? flushSettings() : null]);
            // La copia vieja se borra cuando lo suyo ya esta a salvo (subido, o anotado en la copia nueva)
            if (hasLegacy && (pendingIsSafe() || !failedState())) dropLegacy();
            // Muchos cambios sueltos: la copia se reescribe en bloques para que la proxima apertura sea rapida
            if (loose > D.COMPACT_AFTER) cache.compact(D.canonicalOrder([...cloud.transactions.values()]), infoNow());
            updateStatus();
        }

        // ¿Lo que todavia no subio esta guardado en este equipo? (si no, cerrar la pagina lo pierde)
        function pendingIsSafe() {
            return typeof cache.keepsPending === 'function' ? cache.keepsPending() : cache.persistent === true;
        }

        // Espera a que se confirme todo lo pendiente (o se agote el tiempo)
        async function waitIdle(timeoutMs = 10000) {
            Object.keys(timers).forEach((kind) => { if (timers[kind]) { clearTimeout(timers[kind]); flush(kind); } });
            const until = Date.now() + timeoutMs;
            while (hasPending() && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
            return !hasPending() && !failedState() && !hasUnsynced();
        }

        function dispose() {
            disposed = true;
            store.setLocalListener(null);
            unsubscribers.forEach((u) => { try { u(); } catch { /* ignorar */ } });
            cache.close();
        }

        window.addEventListener('online', updateStatus);
        window.addEventListener('offline', updateStatus);

        return { ready: hydrate(), hasPending, waitIdle, dispose, store, pendingIsSafe };
    }

    return {
        start,
        internals: {
            oikosCompanyId, storageKey, pendingKey, docIdOf, stampOf, periodOf, canon, parseArray,
            toContact, toResident, splitResident, mergeList, diffList, INITIAL_SETTINGS,
            changedKeys, extraOf, satisfied, residentNeeds, movementNeeds, settingsNeeds, pick, changedFields, dropResurrected,
            overlayList, stampValue, laterStamp, stampMinus, saneStamp, mirrorPlan, PAGE_SIZE, MIRROR_MAX_AGE_MS, RESUME_MAX_AGE_MS,
            revivedFields, changedData, withoutServerStamp
        }
    };
})();

// Node (pruebas): exportar las funciones puras
if (typeof module !== 'undefined' && module.exports) module.exports = SisdelFinanzas;
