// Firestore de mentira (en memoria) para correr finanzas-sync.js sin emuladores ni navegador. Solo lo que usa start().
// Sirve para probar carreras que con el emulador dependen del azar (que llega antes, la subida o el sello).
// - Un "servidor" compartido; cada equipo tiene su `db`. Las escrituras propias no generan evento en el mismo
//   equipo (como en Firestore: el evento local llega con hasPendingWrites y el codigo lo salta; la confirmacion
//   es solo de metadatos y no se entrega). El sello del servidor se pone llamando a server.stamp(condominio, id),
//   que es lo que hace la funcion onFinanceMovement.
// - server.failGet / failCommit / delayGet permiten cortar o demorar una lectura o una escritura.
// Lo usa test-finanzas-carreras.mjs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const D = require('../finanzas-datos.js');
export const SisdelFinanzas = require('../finanzas-sync.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const cmpStamp = (a, b) => (a.seconds - b.seconds) || (a.nanoseconds - b.nanoseconds);

export function createServer() {
    const docs = new Map(); // ruta -> datos
    const listeners = new Set();
    let clock = 1800000000;
    const server = {
        docs, failGet: null, failCommit: null, delayGet: null, log: [],
        nextStamp() { clock += 1; return { seconds: clock, nanoseconds: 0 }; },
        seed(path, data) { docs.set(path, clone(data)); },
        // Lo que hace la funcion onFinanceMovement: sella el movimiento
        stamp(condoId, id) {
            const path = `condominios/${condoId}/finanzas_movimientos/${id}`;
            const d = docs.get(path);
            if (!d) throw new Error('no existe ' + path);
            d.server_at = server.nextStamp();
            server.notify(null);
        },
        apply(writes, deviceId) {
            writes.forEach((w) => {
                const prev = docs.get(w.path);
                if (w.op === 'update' && !prev) throw Object.assign(new Error('not-found'), { code: 'not-found' });
                docs.set(w.path, w.merge || w.op === 'update' ? { ...(prev || {}), ...clone(w.data) } : clone(w.data));
                server.log.push({ path: w.path, data: clone(w.data), by: deviceId });
            });
            server.notify(deviceId);
        },
        notify(byDevice) {
            listeners.forEach((l) => {
                const now = l.evaluate();
                const changes = [];
                now.forEach((json, id) => { if (!l.last.has(id)) changes.push({ type: 'added', id }); else if (l.last.get(id) !== json) changes.push({ type: 'modified', id }); });
                l.last.forEach((json, id) => { if (!now.has(id)) changes.push({ type: 'removed', id, json }); });
                const before = l.last;
                l.last = now;
                if (!changes.length || l.deviceId === byDevice) return;
                setTimeout(() => { if (!l.dead) l.emit(changes, now, before); }, 0);
            });
        },
        listeners
    };
    return server;
}

function docSnap(id, json) {
    return { id, exists: json !== undefined, data: () => (json === undefined ? undefined : JSON.parse(json)), metadata: { hasPendingWrites: false } };
}

export function createDb(server, deviceId) {
    const fs = {
        Timestamp: class { constructor(s, n) { this.seconds = s; this.nanoseconds = n; } },
        FieldPath: { documentId: () => '__name__' }
    };
    function query(colPath, spec) {
        const evaluate = () => {
            let rows = [];
            server.docs.forEach((data, path) => {
                if (!path.startsWith(colPath + '/')) return;
                const id = path.slice(colPath.length + 1);
                if (id.includes('/')) return;
                rows.push({ id, data });
            });
            spec.where.forEach(([f, op, v]) => {
                rows = rows.filter((r) => {
                    const x = r.data[f];
                    if (op === '==') return x === v;
                    if (op === '>') return x !== undefined && x !== null && cmpStamp(x, v) > 0;
                    throw new Error('op ' + op);
                });
            });
            const ord = spec.orderBy || ['__name__', 'asc'];
            const key = (r) => (ord[0] === '__name__' ? r.id : r.data[ord[0]]);
            if (ord[0] !== '__name__') rows = rows.filter((r) => r.data[ord[0]] !== undefined);
            const cmp = (a, b) => {
                const ka = key(a); const kb = key(b);
                const c = ord[0] === '__name__' ? (ka < kb ? -1 : ka > kb ? 1 : 0) : cmpStamp(ka, kb);
                return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            };
            rows.sort(cmp);
            if (ord[1] === 'desc') rows.reverse();
            if (spec.startAfter !== undefined) {
                const s = spec.startAfter;
                const pivot = typeof s === 'string' ? { id: s, data: {} } : { id: s.id, data: s.data() };
                rows = rows.filter((r) => (ord[1] === 'desc' ? cmp(r, pivot) < 0 : cmp(r, pivot) > 0));
            }
            if (spec.limit) rows = rows.slice(0, spec.limit);
            return new Map(rows.map((r) => [r.id, JSON.stringify(r.data)]));
        };
        const snapOf = (map, changes, before) => {
            const docsArr = [...map.entries()].map(([id, json]) => docSnap(id, json));
            return {
                docs: docsArr, size: docsArr.length, empty: !docsArr.length,
                docChanges: () => (changes || [...map.keys()].map((id) => ({ type: 'added', id })))
                    .map((c) => ({ type: c.type, doc: docSnap(c.id, c.type === 'removed' ? (c.json || (before && before.get(c.id))) : map.get(c.id)) }))
            };
        };
        const q = {
            where: (f, op, v) => query(colPath, { ...spec, where: spec.where.concat([[f, op, v]]) }),
            orderBy: (f, dir) => query(colPath, { ...spec, orderBy: [f, dir || 'asc'] }),
            limit: (n) => query(colPath, { ...spec, limit: n }),
            startAfter: (s) => query(colPath, { ...spec, startAfter: s }),
            get: () => new Promise((resolve, reject) => setTimeout(() => {
                if (server.failGet && server.failGet(colPath, spec, deviceId)) { reject(Object.assign(new Error('unavailable'), { code: 'unavailable' })); return; }
                resolve(snapOf(evaluate()));
            }, server.delayGet ? server.delayGet(colPath, spec, deviceId) : 0)),
            onSnapshot: (cb) => {
                const l = { deviceId, evaluate, last: new Map(), dead: false, emit: (changes, now, before) => cb(snapOf(now, changes, before)) };
                setTimeout(() => { if (l.dead) return; l.last = evaluate(); server.listeners.add(l); cb(snapOf(l.last)); }, 0);
                return () => { l.dead = true; server.listeners.delete(l); };
            },
            doc: (id) => docRef(colPath + '/' + id)
        };
        return q;
    }
    function docRef(path) {
        const id = path.split('/').pop();
        return {
            path, id,
            collection: (name) => query(path + '/' + name, { where: [] }),
            set: (data, opts) => commit([{ op: 'set', path, data, merge: !!(opts && opts.merge) }]),
            onSnapshot: (cb) => {
                const evaluate = () => { const m = new Map(); if (server.docs.has(path)) m.set(id, JSON.stringify(server.docs.get(path))); return m; };
                const l = { deviceId, evaluate, last: new Map(), dead: false, emit: (changes, now) => cb(docSnap(id, now.get(id))) };
                setTimeout(() => { if (l.dead) return; l.last = evaluate(); server.listeners.add(l); cb(docSnap(id, l.last.get(id))); }, 0);
                return () => { l.dead = true; server.listeners.delete(l); };
            }
        };
    }
    function commit(writes) {
        return new Promise((resolve, reject) => setTimeout(() => {
            const fail = server.failCommit && server.failCommit(writes, deviceId);
            if (fail) { reject(Object.assign(new Error(fail), { code: fail })); return; }
            try { server.apply(writes, deviceId); resolve(); } catch (e) { reject(e); }
        }, 5));
    }
    const db = {
        collection: (name) => query(name, { where: [] }),
        batch: () => {
            const writes = [];
            return {
                set: (ref, data, opts) => writes.push({ op: 'set', path: ref.path, data, merge: !!(opts && opts.merge) }),
                update: (ref, data) => writes.push({ op: 'update', path: ref.path, data }),
                commit: () => commit(writes)
            };
        },
        // Transaccion: lee el estado del servidor en el momento de la lectura y escribe todo junto al final
        runTransaction: async (fn) => {
            const writes = [];
            const tx = {
                get: async (ref) => { const d = server.docs.get(ref.path); return docSnap(ref.id, d === undefined ? undefined : JSON.stringify(d)); },
                set: (ref, data, opts) => { writes.push({ op: 'set', path: ref.path, data, merge: !!(opts && opts.merge) }); return tx; },
                update: (ref, data) => { writes.push({ op: 'update', path: ref.path, data }); return tx; }
            };
            const result = await fn(tx);
            if (writes.length) await commit(writes);
            return result;
        }
    };
    return { db, fs };
}

export function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CONDO = 'c1';
const T0 = Date.parse('2026-11-01T12:00:00.000Z');
export const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();

export function seed(server, count, stamped = true) {
    const base = `condominios/${CONDO}`;
    server.seed(`${base}/usuarios/v1`, { id: 'v1', name: 'Ana', role: 'vecino', casa: 'L1', phone: '', createdAt: iso(0), updatedAt: iso(0) });
    server.seed(`${base}/finanzas_residentes/v1`, { id: 'v1', feeFrom: '2026-11', updated_at: iso(0) });
    server.seed(`${base}/finanzas_config/oikos_settings`, { currency: 'GTQ', lang: 'es', feeMode: 'manual', updated_at: iso(0) });
    for (let i = 1; i <= count; i++) {
        const id = 'm-' + String(i).padStart(4, '0');
        server.seed(`${base}/finanzas_movimientos/${id}`, { id, type: 'income', amount: 100, concept: 'Abono', resiId: 'v1', date: iso(i), created_at: iso(i), updated_at: iso(i), ...(stamped ? { server_at: server.nextStamp() } : {}) });
    }
}

let n = 0;
// Copia del equipo como la entrega openCache() en el navegador: el espejo (aqui en memoria) con el respaldo de
// pendientes en localStorage. `state`: el de otra copia, para abrir OTRA PESTANA sobre la misma base (en IndexedDB
// cada pestana tiene su propia conexion a la misma base).
export function deviceCache(storage, state) {
    const inner = D.memoryCache(state);
    const cache = D.withPendingBackup(inner, storage, CONDO);
    cache.state = inner.state;
    cache.stats = inner.stats;
    return cache;
}
// Abre el Sistema Financiero en un "equipo" (cache y storage sobreviven a cerrar y abrir)
export async function open(server, options = {}) {
    const deviceId = options.deviceId || 'eq' + (++n);
    const { db, fs } = createDb(server, deviceId);
    const events = { status: [], remote: [], blocked: [] };
    const storage = options.storage || memoryStorage();
    const cache = options.cache || deviceCache(storage);
    const device = { deviceId, events, cache, storage };
    globalThis.window = { firebase: { firestore: fs }, SisdelFinanzasDatos: D, sisdelFirebase: { db }, addEventListener() {}, removeEventListener() {} };
    try {
        device.sync = SisdelFinanzas.start(CONDO, {
            cache: device.cache, storage: device.storage, reload: options.reload, can: options.can, pageSize: options.pageSize || 40,
            onStatus: (s) => events.status.push(s), onRemoteChange: (k) => events.remote.push(k), onBlocked: (b) => events.blocked.push(b),
            newAccessCode: () => 'ZZ' + Math.floor(Math.random() * 1e6)
        });
    } finally {
        delete globalThis.window;
    }
    device.store = device.sync.store;
    device.close = () => device.sync.dispose();
    if (options.noWait) return device;
    await device.sync.ready;
    return device;
}
// Store.set de OIKOS
export function oikosSet(device, kind, list) {
    device.store.write(kind, D.stampList(device.store.read(kind), list, new Date().toISOString()));
}
// Store.get de OIKOS (copias de los vivos)
export const oikosGet = (device, kind) => (device.store.read(kind) || []).filter((x) => x && !x.deleted).map(D.cloneRecord);
export const txDoc = (server, id) => server.docs.get(`condominios/${CONDO}/finanzas_movimientos/${id}`);
export const live = (device) => (device.store.read('transactions') || []).filter((x) => x && !x.deleted).map((x) => x.id);
