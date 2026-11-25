// Bitacora: como se arma cada anotacion (funciones puras; los disparadores estan en index.js).
// Se prueban en scripts/test-bitacora.mjs.
const crypto = require('node:crypto');

const COLLECTION = 'bitacora';
// Colecciones con rastro y los campos que sirven para reconocer el registro sin abrirlo
const AUDITED = {
    usuarios: ['name', 'role', 'casa'],
    vehiculos: ['plate', 'userId'],
    finanzas_residentes: ['id'],
    finanzas_movimientos: ['type', 'kind', 'period', 'amount', 'concept', 'resiId', 'receiptNum'],
    finanzas_config: [],
    finanzas_bancos: ['bankName', 'accountNumber', 'accountType', 'currency'],
    finanzas_bancos_movs: ['accountId', 'type', 'direction', 'amount', 'concept', 'reference'],
    panico_config: [],
    vecino_config: []
};
// Campos que no son un cambio del negocio: el sello del servidor de los movimientos (finanzas/sello.js)
const IGNORED_FIELDS = ['server_at'];
// De un texto mas largo que esto (la foto de un comprobante) se anota el principio, su tamano y su huella
const MAX_TEXT = 300;
// Una anotacion no pasa de este tamano ni de esta cantidad de valores: Firestore rechaza documentos de mas de
// 1 MiB o con decenas de miles de valores indexados, y una anotacion rechazada seria un cambio sin rastro.
const MAX_ENTRY_CHARS = 200000;
const MAX_LEAVES = 2000;
const MAX_FIELDS = 400;
const MASTER_UID = 'master';

const fingerprint = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 10);
const isPlainObject = (value) => {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};
const isBytes = (value) => (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) || value instanceof Uint8Array || value instanceof ArrayBuffer;

// Valor apto para la bitacora. Con `full` no se resume nada: sirve para saber si dos valores son distintos de verdad.
function plainValue(value, depth = 0, full = false) {
    if (value === undefined || value === null) return null;
    const type = typeof value;
    if (type === 'string') {
        if (full || value.length <= MAX_TEXT) return value;
        return `${value.slice(0, MAX_TEXT)}… [${value.length} letras, huella ${fingerprint(value)}]`;
    }
    if (type === 'number') return Number.isFinite(value) ? value : String(value);
    if (type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type !== 'object') return `[${type}]`;
    if (typeof value.toDate === 'function') { try { return value.toDate().toISOString(); } catch { return '[fecha]'; } }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[fecha]' : value.toISOString();
    if (isBytes(value)) {
        const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
        return full ? `binario:${bytes.toString('base64')}` : `[binario de ${bytes.length} bytes, huella ${fingerprint(bytes.toString('base64'))}]`;
    }
    // Referencia a otro documento: su ruta (nunca los datos internos de la libreria)
    if (typeof value.path === 'string' && value.firestore) return `[referencia ${value.path}]`;
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && !isPlainObject(value)) return { latitude: value.latitude, longitude: value.longitude };
    if (depth >= 5) return '[...]';
    if (Array.isArray(value)) return value.map((v) => plainValue(v, depth + 1, full));
    if (isPlainObject(value)) {
        const out = {};
        Object.keys(value).sort().forEach((k) => { out[k] = plainValue(value[k], depth + 1, full); });
        return out;
    }
    return `[${(value.constructor && value.constructor.name) || 'objeto'}]`;
}

// ¿Son distintos de verdad? (se compara el valor completo, no su resumen)
const differs = (a, b) => JSON.stringify(plainValue(a, 0, true)) !== JSON.stringify(plainValue(b, 0, true));

// De dos mapas (p. ej. los privilegios de un usuario) se anotan solo las claves que cambiaron
function mapChange(from, to) {
    const out = { from: {}, to: {} };
    [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().forEach((key) => {
        if (!differs(from[key], to[key])) return;
        out.from[key] = plainValue(from[key], 1);
        out.to[key] = plainValue(to[key], 1);
    });
    return out;
}

// Campos que cambiaron: { campo: { from, to } } (null = no existia). Al crear, todo "to"; al eliminar, todo "from".
function changesOf(before, after) {
    const a = before || {};
    const b = after || {};
    const changes = {};
    [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().forEach((key) => {
        if (IGNORED_FIELDS.includes(key) || !differs(a[key], b[key])) return;
        changes[key] = isPlainObject(a[key]) && isPlainObject(b[key]) ? mapChange(a[key], b[key]) : { from: plainValue(a[key]), to: plainValue(b[key]) };
    });
    return changes;
}

function leaves(value) {
    if (value === null || typeof value !== 'object') return 1;
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.reduce((sum, item) => sum + leaves(item), 1);
}
const brief = (value) => {
    const text = JSON.stringify(value);
    return text.length <= 80 ? value : `[valor grande: ${text.length} letras, huella ${fingerprint(text)}]`;
};

// Deja la anotacion dentro de lo que Firestore admite: si es demasiado grande, los valores mas grandes se
// reemplazan por su tamano y su huella (y queda marcada como resumida). Que campos cambiaron no se pierde nunca.
function limitChanges(changes) {
    const keys = Object.keys(changes);
    if (keys.length > MAX_FIELDS) {
        const names = keys.slice(0, MAX_FIELDS).join(', ');
        return { changes: { '(campos)': { from: null, to: `${keys.length} campos cambiaron: ${names}${keys.length > MAX_FIELDS ? '...' : ''}` } }, truncated: true };
    }
    const out = { ...changes };
    const size = (key) => JSON.stringify(out[key]).length;
    const total = () => keys.reduce((sum, key) => sum + size(key), 0);
    const count = () => keys.reduce((sum, key) => sum + leaves(out[key]), 0);
    let truncated = false;
    const pending = keys.slice().sort((x, y) => size(y) - size(x));
    while (pending.length && (total() > MAX_ENTRY_CHARS || count() > MAX_LEAVES)) {
        const key = pending.shift();
        out[key] = { from: brief(out[key].from), to: brief(out[key].to) };
        truncated = true;
    }
    return { changes: out, truncated };
}

// Que paso, en una palabra
function actionOf(before, after) {
    if (!before) return 'crear';
    if (!after) return 'eliminar';
    if (after.deleted === true && before.deleted !== true) return 'anular';
    if (before.deleted === true && after.deleted !== true) return 'restaurar';
    return 'cambiar';
}

function subjectOf(collection, data) {
    const subject = {};
    (AUDITED[collection] || []).forEach((key) => { if (data && data[key] !== undefined) subject[key] = brief(plainValue(data[key])); });
    return subject;
}

// La anotacion de un cambio, o null si no cambio nada que importe (p. ej. solo el sello del servidor)
function buildEntry({ collection, docId, before, after, authType, authId, eventTime }) {
    if (!before && !after) return null;
    const { changes, truncated } = limitChanges(changesOf(before, after));
    if (!Object.keys(changes).length) return null;
    return {
        collection, docId: String(docId), action: actionOf(before, after),
        actorType: authType || 'unknown', actorId: authId || null,
        subject: subjectOf(collection, after || before),
        changes, eventTime: eventTime || null,
        ...(truncated ? { truncated: true } : {})
    };
}

// Lo minimo de una anotacion que Firestore rechazo: que documento, que accion, quien y que campos
function minimalEntry(entry, reason) {
    return {
        collection: entry.collection, docId: entry.docId, action: entry.action,
        actorType: entry.actorType, actorId: entry.actorId, subject: {}, eventTime: entry.eventTime || null,
        changes: { '(campos)': { from: null, to: Object.keys(entry.changes || {}).slice(0, MAX_FIELDS).join(', ') } },
        truncated: true, note: String(reason || '').slice(0, 300)
    };
}

// ¿Puede ser el id de un usuario del condominio? (las cuentas de servicio no lo son)
function userIdOf(authType, authId) {
    if (!authId || authType === 'service_account' || authType === 'system') return null;
    const id = String(authId);
    return id.includes('/') || id.includes('@') ? null : id;
}

// Nombre y rol de quien hizo el cambio. Un usuario del condominio se reconoce por su ficha; "Master" es solo
// quien entro con la clave master y no tiene ficha en el condominio.
function actorOf(entry, userData) {
    if (userData) return { actorName: userData.name || '', actorRole: userData.role || '' };
    if (entry.actorId === MASTER_UID) return { actorName: 'Master', actorRole: 'master' };
    if (entry.actorType === 'service_account' || entry.actorType === 'system') return { actorName: 'Servidor', actorRole: 'servidor' };
    return { actorName: '', actorRole: '' };
}

module.exports = {
    COLLECTION, AUDITED, IGNORED_FIELDS, MAX_TEXT, MAX_ENTRY_CHARS, MAX_LEAVES, MAX_FIELDS, MASTER_UID,
    plainValue, differs, changesOf, limitChanges, leaves, actionOf, subjectOf, buildEntry, minimalEntry, userIdOf, actorOf
};
