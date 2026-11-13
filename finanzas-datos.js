/* ═══════════════════════════════════════════════════════════════
   SISDEL - Datos del Sistema Financiero (OIKOS) en el navegador
   ───────────────────────────────────────────────────────────────
   Antes OIKOS guardaba cada lista (residentes, movimientos, configuracion) como UN texto en localStorage,
   que admite unos 5 millones de letras (la mitad en Safari de iPhone): un condominio de 719 residentes lo
   llena en menos de un ano y, lleno, nada se guarda ni abre. Ahora:

   - Memoria (createStore): las listas viven como objetos en la pagina contenedora (finanzas.html). OIKOS
     (finanzas/index.html, objeto Store) lee y escribe ahi; finanzas-sync.js las sincroniza con Firestore.
     Los registros guardados no se modifican nunca: quien lee recibe copias y quien guarda entrega una lista
     nueva. Por eso se pueden compartir entre la lista de OIKOS, el espejo de la nube y las fotos de deshacer.
   - Copia del equipo (openCache): IndexedDB guarda el espejo de los movimientos de la nube (para no bajarlos
     todos cada vez que se abre) y los cambios locales que todavia no subieron (para no perderlos al recargar).
     Sin IndexedDB todo funciona igual, solo que cada apertura baja todo de nuevo.

   Lo cargan finanzas.html y finanzas/index.html (misma version en los dos: una prueba lo exige).
   Las funciones puras se prueban en scripts/test-finanzas-datos.mjs.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelFinanzasDatos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const KINDS = ['residents', 'transactions', 'settings'];
    // Copia del equipo
    const DB_PREFIX = 'sisdel-finanzas-';
    const REGISTRY_KEY = 'sisdel_fin_bases';
    // Lo pendiente de subir tambien se anota aqui (localStorage), al instante: ver pendingBackup
    const PENDING_PREFIX = 'sisdel_fin_sin_subir_';
    const SCHEMA = 1;
    const CHUNK_SIZE = 2000;
    // Con mas cambios sueltos que estos, la copia se reescribe en bloques (abre mas rapido)
    const COMPACT_AFTER = 4000;

    // ── Registros ──
    // Todo lo que entra o sale de la memoria se comporta como si pasara por JSON (asi era con localStorage):
    // sin undefined ni funciones, y sin compartir objetos con quien llama.

    function cloneJson(value) {
        const text = JSON.stringify(value);
        return text === undefined ? null : JSON.parse(text);
    }

    // Igual que JSON.parse(JSON.stringify(x)) para un registro, sin armar el texto completo
    function cloneRecord(x) {
        if (x === null || typeof x !== 'object' || Array.isArray(x)) return cloneJson(x);
        if (typeof x.toJSON === 'function') return cloneJson(x);
        const out = {};
        const keys = Object.keys(x);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = x[k];
            const t = typeof v;
            if (t === 'string' || t === 'boolean' || v === null) out[k] = v;
            else if (t === 'number') out[k] = Number.isFinite(v) ? (v === 0 ? 0 : v) : null;
            else if (t === 'object') {
                const text = JSON.stringify(v);
                if (text !== undefined) out[k] = JSON.parse(text);
            }
            // undefined, funciones y simbolos: JSON los omite
        }
        return out;
    }

    function cloneList(list) {
        const out = new Array(list.length);
        for (let i = 0; i < list.length; i++) out[i] = cloneRecord(list[i]);
        return out;
    }

    const STAMP_KEYS = { updated_at: true, created_at: true };
    function skipsKey(obj, key, skipStamps) {
        if (skipStamps && STAMP_KEYS[key] === true) return true;
        const t = typeof obj[key];
        return t === 'undefined' || t === 'function' || t === 'symbol';
    }

    // true si JSON.stringify(a) === JSON.stringify(b). Con skipStamps no cuentan updated_at ni created_at
    // (es la comparacion con la que Store.set de OIKOS decide si un registro cambio).
    function sameRecord(a, b, skipStamps) {
        if (a === b) return true;
        const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && typeof x.toJSON !== 'function';
        if (!plain(a) || !plain(b)) {
            if (skipStamps) return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
            return JSON.stringify(a) === JSON.stringify(b);
        }
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        let i = 0;
        let j = 0;
        for (;;) {
            while (i < ka.length && skipsKey(a, ka[i], skipStamps)) i++;
            while (j < kb.length && skipsKey(b, kb[j], skipStamps)) j++;
            if (i >= ka.length || j >= kb.length) return i >= ka.length && j >= kb.length;
            if (ka[i] !== kb[j]) return false;
            const va = a[ka[i]];
            const vb = b[kb[j]];
            if (va !== vb) {
                const complex = (v) => (v !== null && typeof v === 'object') || typeof v === 'number';
                if (!complex(va) && !complex(vb)) return false;
                if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
            }
            i++;
            j++;
        }
    }
    function strip(o) {
        if (o === null || typeof o !== 'object' || Array.isArray(o)) return o;
        const c = { ...o };
        delete c.updated_at;
        delete c.created_at;
        return c;
    }

    // Lo que hace Store.set de OIKOS con una lista: sella lo nuevo y lo que cambio, deja igual lo demas y
    // conserva los anulados que quien llama no traia. Devuelve la lista nueva; `prevList` no se toca y los
    // registros sin cambios son LOS MISMOS objetos (asi la sincronizacion los reconoce sin compararlos).
    function stampList(prevList, items, nowIso) {
        const prevArr = Array.isArray(prevList) ? prevList : [];
        const prevById = new Map();
        for (let i = 0; i < prevArr.length; i++) prevById.set(String(prevArr[i] && prevArr[i].id), prevArr[i]);
        const seen = new Set();
        const list = Array.isArray(items) ? items : [];
        const out = new Array(list.length);
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (!item || item.id === null || item.id === undefined) { out[i] = cloneJson(item); continue; }
            const key = String(item.id);
            seen.add(key);
            const prev = prevById.get(key);
            if (!prev) {
                out[i] = cloneRecord({ ...item, created_at: item.created_at || nowIso, updated_at: item.updated_at || nowIso });
            } else if (!sameRecord(prev, item, true)) {
                out[i] = cloneRecord({ ...item, created_at: item.created_at || prev.created_at || nowIso, updated_at: nowIso });
            } else {
                out[i] = sameRecord(prev, item, false) ? prev : cloneRecord(item);
            }
        }
        for (let i = 0; i < prevArr.length; i++) {
            const x = prevArr[i];
            if (x && x.deleted && !seen.has(String(x.id))) out.push(x);
        }
        return out;
    }

    // Saldo de cada residente: pagos menos cargos vivos (igual que _residentBalanceMap de OIKOS)
    function balanceMap(transactions) {
        const map = new Map();
        const arr = Array.isArray(transactions) ? transactions : [];
        for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            if (!t || t.deleted || !t.resiId) continue;
            const amt = parseFloat(t.amount) || 0;
            const key = String(t.resiId);
            const prev = map.get(key) || 0;
            if (t.type === 'income') map.set(key, prev + amt);
            else if (t.type === 'charge') map.set(key, prev - amt);
        }
        return map;
    }

    // Movimientos vivos agrupados por residente, en el mismo orden de la lista
    function byResident(transactions) {
        const map = new Map();
        const arr = Array.isArray(transactions) ? transactions : [];
        for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            if (!t || t.deleted || t.resiId === undefined || t.resiId === null) continue;
            const key = String(t.resiId);
            const list = map.get(key);
            if (list) list.push(t); else map.set(key, [t]);
        }
        return map;
    }

    // Orden de la lista al abrir: por fecha de alta y, a igual fecha, por id (el orden en que la nube los
    // entregaba a un equipo sin copia local).
    function canonicalOrder(records) {
        const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator() : null;
        const created = (x) => String((x && (x.created_at || x.createdAt)) || '');
        const idOf = (x) => String(x && x.id);
        return records.slice().sort((a, b) => {
            const ca = created(a);
            const cb = created(b);
            if (ca !== cb) {
                const order = collator ? collator.compare(ca, cb) : ca.localeCompare(cb);
                if (order !== 0) return order;
            }
            const ia = idOf(a);
            const ib = idOf(b);
            return ia < ib ? -1 : (ia > ib ? 1 : 0);
        });
    }

    // ── Memoria compartida entre finanzas.html (sincronizacion) y OIKOS ──
    function createStore(prefix) {
        const data = { residents: null, transactions: null, settings: null };
        const versions = { residents: 0, transactions: 0, settings: 0 };
        let onLocal = null;
        let onRemote = null;
        return {
            prefix,
            read: (kind) => data[kind],
            // Cambia con cada escritura: sirve para guardar calculos (saldos, indices) mientras la lista no cambie
            version: (kind) => versions[kind],
            // OIKOS guarda (Store.set): avisa a la sincronizacion. La lista se pasa a un arreglo de esta pagina:
            // el que entrega OIKOS es de su iframe, que se vuelve a crear al "Actualizar".
            write(kind, value) {
                data[kind] = Array.isArray(value) ? Array.prototype.slice.call(value) : value;
                versions[kind]++;
                if (onLocal) onLocal(kind);
            },
            // La sincronizacion aplica un cambio; con notify avisa a OIKOS para que repinte
            replace(kind, value, notify) {
                data[kind] = value;
                versions[kind]++;
                if (notify && onRemote) { try { onRemote(kind); } catch (e) { /* OIKOS se esta recargando */ } }
            },
            setLocalListener(fn) { onLocal = fn; },
            // Solo escucha el OIKOS montado en este momento (el iframe se vuelve a crear al "Actualizar")
            setRemoteListener(fn) { onRemote = fn; }
        };
    }

    // ── Copia del equipo (IndexedDB) ──
    function request(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    function finished(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('abortado'));
        });
    }

    function readRegistry(storage) {
        try { const list = JSON.parse(storage.getItem(REGISTRY_KEY) || '[]'); return Array.isArray(list) ? list.map(String) : []; } catch (e) { return []; }
    }
    function register(storage, condoId) {
        try {
            const list = readRegistry(storage);
            if (!list.includes(condoId)) storage.setItem(REGISTRY_KEY, JSON.stringify(list.concat(condoId)));
        } catch (e) { /* sin espacio o sin acceso */ }
    }

    // indexedDB y localStorage del navegador, o los que pasen las pruebas en `env` (null = no hay)
    function envOf(env, name) {
        if (env && name in env) return env[name];
        try { return typeof globalThis !== 'undefined' && globalThis[name] ? globalThis[name] : null; } catch (e) { return null; }
    }

    // Respaldo de lo pendiente de subir en localStorage. IndexedDB guarda de forma diferida y puede no existir
    // (ventana privada, almacenamiento bloqueado) o fallar; localStorage guarda al instante, como hacia OIKOS
    // antes. Lo pendiente es poco (lo que todavia no subio), asi que cabe; si no cabe, queda solo en IndexedDB.
    function pendingBackup(storage, condoId) {
        const key = PENDING_PREFIX + condoId;
        const read = () => {
            try { const map = JSON.parse((storage && storage.getItem(key)) || '{}'); return map && typeof map === 'object' && !Array.isArray(map) ? map : {}; } catch (e) { return {}; }
        };
        const write = (map) => {
            if (!storage) return false;
            try {
                if (Object.keys(map).length) storage.setItem(key, JSON.stringify(map)); else storage.removeItem(key);
                return true;
            } catch (e) { return false; }
        };
        return {
            list: () => Object.values(read()),
            put(kind, items) {
                const map = read();
                items.forEach((item) => { const id = kind === 'settings' ? 'settings' : docIdOf(item); map[kind + ':' + id] = { kind, id, item }; });
                return write(map);
            },
            remove(kind, ids) {
                const map = read();
                ids.forEach((id) => { delete map[kind + ':' + id]; });
                return write(map);
            }
        };
    }
    const stampMs = (entry) => { const t = Date.parse((entry && entry.item && entry.item.updated_at) || ''); return Number.isFinite(t) ? t : 0; };

    // Agrega el respaldo de pendientes a una copia. keepsPending(): ¿lo pendiente esta a salvo en este equipo?
    function withPendingBackup(cache, storage, condoId) {
        const backup = pendingBackup(storage, condoId);
        let saved = !!storage;
        return {
            get persistent() { return cache.persistent === true; },
            keepsPending: () => saved || cache.persistent === true,
            async load() {
                const loaded = await cache.load();
                // Lo pendiente sale de los dos lugares; si esta en ambos, vale el cambio mas reciente
                const byKey = new Map();
                (loaded.pending || []).concat(backup.list()).forEach((entry) => {
                    if (!entry || !entry.kind || entry.item === undefined || entry.item === null) return;
                    const k = entry.kind + ':' + entry.id;
                    if (!byKey.has(k) || stampMs(entry) > stampMs(byKey.get(k))) byKey.set(k, entry);
                });
                return { ...loaded, pending: [...byKey.values()] };
            },
            putPending(kind, items) { saved = backup.put(kind, items); return cache.putPending(kind, items); },
            deletePending(kind, ids) { backup.remove(kind, ids); return cache.deletePending(kind, ids); },
            resetMirror: (info) => cache.resetMirror(info),
            appendChunk: (index, records, info) => cache.appendChunk(index, records, info),
            applyDeltas: (records, info) => cache.applyDeltas(records, info),
            setInfo: (info) => cache.setInfo(info),
            compact: (records, info) => cache.compact(records, info),
            close: () => cache.close()
        };
    }

    // Copia que no guarda nada (sin IndexedDB, o si falla): todo sigue funcionando desde la nube
    function nullCache() {
        const ok = () => Promise.resolve();
        return {
            persistent: false,
            load: () => Promise.resolve({ info: null, records: new Map(), deltaCount: 0, pending: [] }),
            resetMirror: ok, appendChunk: ok, applyDeltas: ok, setInfo: ok, compact: ok, putPending: ok, deletePending: ok, close() {}
        };
    }

    // Tanda del espejo: cada carga completa empieza una nueva. Con ella una pestana sabe si el espejo sigue siendo
    // el que ella cargo o si otra pestana lo rehizo (y entonces deja de escribirlo): asi una pestana vieja nunca
    // marca como completo un espejo que otra dejo a medias.
    function newGeneration() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

    // Copia en memoria con el mismo comportamiento que la de IndexedDB (lo que se guarda se copia). La usan las
    // pruebas (scripts/test-finanzas-nube.mjs) para simular que la pagina se cierra y se vuelve a abrir.
    function memoryCache(sharedState) {
        // sharedState: el estado de otra copia en memoria, para simular dos pestanas sobre la misma base
        const state = sharedState || { info: null, base: new Map(), delta: new Map(), pending: new Map() };
        const stats = { resets: 0, chunks: 0, deltas: 0, compactions: 0 };
        const done = () => Promise.resolve();
        let generation = null;
        let detached = false;
        // Como en IndexedDB: si otra pestana rehizo el espejo (otra tanda), esta deja de escribirlo
        const mine = () => {
            if (detached) return false;
            if (((state.info && state.info.generation) || null) !== generation) { detached = true; return false; }
            return true;
        };
        const stamped = (info) => cloneJson({ ...info, generation });
        return {
            persistent: true, stats, state,
            load() {
                generation = (state.info && state.info.generation) || null;
                detached = false;
                const records = new Map();
                [...state.base.keys()].sort((a, b) => a - b).forEach((n) => state.base.get(n).forEach((r) => records.set(docIdOf(r), cloneJson(r))));
                state.delta.forEach((r, id) => records.set(id, cloneJson(r)));
                return Promise.resolve({ info: cloneJson(state.info), records, deltaCount: state.delta.size, pending: [...state.pending.values()].map(cloneJson) });
            },
            resetMirror(info) {
                stats.resets++;
                generation = newGeneration();
                detached = false;
                state.base.clear(); state.delta.clear();
                state.info = info ? stamped(info) : null;
                if (!info) generation = null;
                return done();
            },
            appendChunk(index, records, info) { if (!mine()) return done(); stats.chunks++; state.base.set(index, cloneJson(records)); if (info) state.info = stamped(info); return done(); },
            applyDeltas(records, info) { if (!mine()) return done(); stats.deltas += records.length; records.forEach((r) => state.delta.set(docIdOf(r), cloneJson(r))); if (info) state.info = stamped(info); return done(); },
            setInfo(info) { if (!mine()) return done(); state.info = stamped(info); return done(); },
            compact(records, info) {
                if (!mine()) return done();
                stats.compactions++;
                state.base.clear(); state.delta.clear();
                for (let i = 0, n = 0; i < records.length; i += CHUNK_SIZE, n++) state.base.set(n, cloneJson(records.slice(i, i + CHUNK_SIZE)));
                state.info = stamped(info);
                return done();
            },
            putPending(kind, items) { items.forEach((item) => { const id = kind === 'settings' ? 'settings' : docIdOf(item); state.pending.set(kind + ':' + id, cloneJson({ kind, id, item })); }); return done(); },
            deletePending(kind, ids) { ids.forEach((id) => state.pending.delete(kind + ':' + id)); return done(); },
            close() {}
        };
    }

    // Abre la copia de un condominio. Nunca falla: si IndexedDB no esta disponible devuelve nullCache().
    //   base     bloques de hasta CHUNK_SIZE movimientos (la carga completa)
    //   delta    movimientos que cambiaron despues, uno por id (se aplican encima de los bloques)
    //   pending  cambios locales sin confirmar: { kind, id, item }
    //   meta     'info': { schema, complete, cursor, loadedAt, lastId, chunks }
    async function openCache(condoId, env) {
        const idb = envOf(env, 'indexedDB');
        const storage = envOf(env, 'localStorage');
        if (!idb) return withPendingBackup(nullCache(), storage, condoId);
        let db;
        try {
            const open = idb.open(DB_PREFIX + condoId, 1);
            open.onupgradeneeded = () => {
                const d = open.result;
                ['base', 'delta', 'pending', 'meta'].forEach((name) => { if (!d.objectStoreNames.contains(name)) d.createObjectStore(name); });
            };
            db = await request(open);
        } catch (error) {
            console.warn('Sistema Financiero: sin copia en este equipo (IndexedDB no disponible)', error);
            return withPendingBackup(nullCache(), storage, condoId);
        }
        if (storage) register(storage, condoId);
        let broken = false;
        // Tanda del espejo con la que trabaja esta pagina (ver newGeneration) y si otra pagina la reemplazo
        let generation = null;
        let detached = false;
        // Al cerrar sesion en otra pestana se borra la base: se suelta para no bloquear el borrado
        db.onversionchange = () => { broken = true; try { db.close(); } catch (e) { /* ya cerrada */ } };

        // Ninguna falla de la copia debe frenar al Sistema Financiero: se avisa y se sigue sin copia
        async function safely(label, work, fallback) {
            if (broken) return fallback;
            try { return await work(); } catch (error) {
                broken = true;
                console.warn('Sistema Financiero: la copia de este equipo dejo de usarse (' + label + ')', error);
                return fallback;
            }
        }
        const keyOf = (kind, id) => kind + ':' + id;
        // Escritura del espejo: en la misma transaccion se comprueba que siga siendo el de esta pagina. Si otra
        // pestana lo rehizo, no se escribe nada y esta pagina deja de tocarlo (sigue trabajando desde la memoria).
        const mirrorWrite = (label, stores, work) => safely(label, async () => {
            if (detached) return;
            const tx = db.transaction(stores, 'readwrite');
            const current = await request(tx.objectStore('meta').get('info'));
            if (((current && current.generation) || null) !== generation) { detached = true; return; }
            work(tx);
            await finished(tx);
        });
        const stamped = (info) => ({ ...info, generation });

        return withPendingBackup({
            get persistent() { return !broken; },
            load: () => safely('leer', async () => {
                const tx = db.transaction(['base', 'delta', 'pending', 'meta'], 'readonly');
                const [info, chunks, deltas, pending] = await Promise.all([
                    request(tx.objectStore('meta').get('info')),
                    request(tx.objectStore('base').getAll()),
                    request(tx.objectStore('delta').getAll()),
                    request(tx.objectStore('pending').getAll())
                ]);
                const records = new Map();
                chunks.forEach((chunk) => (chunk || []).forEach((r) => { if (r && r.id !== undefined && r.id !== null) records.set(docIdOf(r), r); }));
                deltas.forEach((r) => { if (r && r.id !== undefined && r.id !== null) records.set(docIdOf(r), r); });
                generation = (info && info.generation) || null;
                detached = false;
                return { info: info || null, records, deltaCount: deltas.length, pending: pending || [] };
            }, { info: null, records: new Map(), deltaCount: 0, pending: [] }),
            // Empieza una carga completa: se vacia el espejo (los pendientes se conservan) y empieza una tanda nueva
            resetMirror: (info) => safely('vaciar', async () => {
                generation = info ? newGeneration() : null;
                detached = false;
                const tx = db.transaction(['base', 'delta', 'meta'], 'readwrite');
                tx.objectStore('base').clear();
                tx.objectStore('delta').clear();
                tx.objectStore('meta').put(info ? stamped(info) : null, 'info');
                await finished(tx);
            }),
            appendChunk: (index, records, info) => mirrorWrite('guardar bloque', ['base', 'meta'], (tx) => {
                tx.objectStore('base').put(records, index);
                if (info) tx.objectStore('meta').put(stamped(info), 'info');
            }),
            applyDeltas: (records, info) => mirrorWrite('guardar cambios', ['delta', 'meta'], (tx) => {
                const store = tx.objectStore('delta');
                records.forEach((r) => store.put(r, docIdOf(r)));
                if (info) tx.objectStore('meta').put(stamped(info), 'info');
            }),
            setInfo: (info) => mirrorWrite('guardar estado', ['meta'], (tx) => {
                tx.objectStore('meta').put(stamped(info), 'info');
            }),
            // Reescribe todo en bloques (records en el orden en que se quieren guardar)
            compact: (records, info) => mirrorWrite('compactar', ['base', 'delta', 'meta'], (tx) => {
                const base = tx.objectStore('base');
                base.clear();
                tx.objectStore('delta').clear();
                for (let i = 0, n = 0; i < records.length; i += CHUNK_SIZE, n++) base.put(records.slice(i, i + CHUNK_SIZE), n);
                tx.objectStore('meta').put(stamped(info), 'info');
            }),
            putPending: (kind, items) => safely('guardar pendientes', async () => {
                const tx = db.transaction(['pending'], 'readwrite');
                const store = tx.objectStore('pending');
                items.forEach((item) => {
                    const id = kind === 'settings' ? 'settings' : docIdOf(item);
                    store.put({ kind, id, item }, keyOf(kind, id));
                });
                await finished(tx);
            }),
            deletePending: (kind, ids) => safely('quitar pendientes', async () => {
                const tx = db.transaction(['pending'], 'readwrite');
                const store = tx.objectStore('pending');
                ids.forEach((id) => store.delete(keyOf(kind, id)));
                await finished(tx);
            }),
            close() { broken = true; try { db.close(); } catch (e) { /* ya cerrada */ } }
        }, storage, condoId);
    }

    // Borra las copias de este equipo (al cerrar sesion). Resuelve cuando termina o al agotarse el tiempo.
    function destroyCaches(env, timeoutMs) {
        const idb = envOf(env, 'indexedDB');
        const storage = envOf(env, 'localStorage');
        if (!idb || !storage) return Promise.resolve();
        const ids = readRegistry(storage);
        try { storage.removeItem(REGISTRY_KEY); ids.forEach((id) => storage.removeItem(PENDING_PREFIX + id)); } catch (e) { /* ignorar */ }
        const all = Promise.all(ids.map((id) => new Promise((resolve) => {
            try {
                const req = idb.deleteDatabase(DB_PREFIX + id);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
            } catch (e) { resolve(); }
        })));
        return Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs || 1500))]);
    }

    // Id de documento valido para Firestore (sin '/'); el mismo de finanzas-sync.js
    function docIdOf(item) { return String(item.id).replace(/\//g, '_'); }

    return {
        KINDS, DB_PREFIX, REGISTRY_KEY, PENDING_PREFIX, SCHEMA, CHUNK_SIZE, COMPACT_AFTER, pendingBackup, withPendingBackup,
        cloneJson, cloneRecord, cloneList, sameRecord, stampList, balanceMap, byResident, canonicalOrder,
        createStore, openCache, nullCache, memoryCache, destroyCaches, docIdOf
    };
});
