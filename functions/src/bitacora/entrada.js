// Bitacora: como se arma cada anotacion (funciones puras; los disparadores estan en index.js).
// Se prueban en scripts/test-bitacora.mjs.

const COLLECTION = 'bitacora';
// Colecciones con rastro y los campos que sirven para reconocer el registro sin abrirlo
const AUDITED = {
    usuarios: ['name', 'role', 'casa'],
    vehiculos: ['plate', 'userId'],
    finanzas_residentes: ['id'],
    finanzas_movimientos: ['type', 'kind', 'period', 'amount', 'concept', 'resiId', 'receiptNum'],
    finanzas_config: []
};
// Campos que no son un cambio del negocio: el sello del servidor de los movimientos (finanzas/sello.js)
const IGNORED_FIELDS = ['server_at'];
// Un texto mas largo que esto (la foto de un comprobante) se anota por su tamano
const MAX_TEXT = 300;
const MASTER_UID = 'master';

// Valor apto para la bitacora: fechas del servidor como texto, textos largos resumidos
function plainValue(value, depth = 0) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value.length > MAX_TEXT ? `[texto de ${value.length} letras]` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value.toDate === 'function') { try { return value.toDate().toISOString(); } catch { return String(value); } }
    if (value instanceof Date) return value.toISOString();
    if (depth >= 4) return '[...]';
    if (Array.isArray(value)) return value.map((v) => plainValue(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        Object.keys(value).sort().forEach((k) => { out[k] = plainValue(value[k], depth + 1); });
        return out;
    }
    return String(value);
}

// Campos que cambiaron: { campo: { from, to } } (null = no existia). Al crear, todo "to"; al eliminar, todo "from".
function changesOf(before, after) {
    const a = before || {};
    const b = after || {};
    const changes = {};
    [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().forEach((key) => {
        if (IGNORED_FIELDS.includes(key)) return;
        const from = plainValue(a[key]);
        const to = plainValue(b[key]);
        if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
    });
    return changes;
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
    (AUDITED[collection] || []).forEach((key) => { if (data && data[key] !== undefined) subject[key] = plainValue(data[key]); });
    return subject;
}

// La anotacion de un cambio, o null si no cambio nada que importe (p. ej. solo el sello del servidor)
function buildEntry({ collection, docId, before, after, authType, authId, eventTime }) {
    if (!before && !after) return null;
    const changes = changesOf(before, after);
    if (!Object.keys(changes).length) return null;
    return {
        collection, docId: String(docId), action: actionOf(before, after),
        actorType: authType || 'unknown', actorId: authId || null,
        subject: subjectOf(collection, after || before),
        changes, eventTime: eventTime || null
    };
}

// ¿Puede ser el id de un usuario del condominio? (las cuentas de servicio y el master no lo son)
function userIdOf(authType, authId) {
    if (!authId || authType === 'service_account' || authType === 'system') return null;
    const id = String(authId);
    return id === MASTER_UID || id.includes('/') || id.includes('@') ? null : id;
}

// Nombre y rol de quien hizo el cambio
function actorOf(entry, userData) {
    if (userData) return { actorName: userData.name || '', actorRole: userData.role || '' };
    if (entry.actorId === MASTER_UID) return { actorName: 'Master', actorRole: 'master' };
    if (entry.actorType === 'service_account' || entry.actorType === 'system') return { actorName: 'Servidor', actorRole: 'servidor' };
    return { actorName: '', actorRole: '' };
}

module.exports = { COLLECTION, AUDITED, IGNORED_FIELDS, MAX_TEXT, MASTER_UID, plainValue, changesOf, actionOf, subjectOf, buildEntry, userIdOf, actorOf };
