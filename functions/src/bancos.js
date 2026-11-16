// Bancos del Sistema Financiero: cambiar la cuenta favorita (la que recibe sola los pagos y gastos de OIKOS).
// Solo el administrador del condominio, y escribiendo su propio codigo de acceso (pedido del dueno). Los intentos
// fallidos se limitan. El historial de favoritas vive en condominios/{c}/finanzas_config/bancos y solo lo escribe esta
// funcion (las reglas no dejan escribirlo desde el navegador); queda en la bitacora (auditFinanceSettings) y cada cambio
// guarda quien lo hizo y desde cuando vale. Sin historial, la favorita es la primera cuenta que se abrio.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db } = require('./firebase');
const { ROLES, normalizeCode } = require('./util');
const rateLimit = require('./rateLimit');

const FAVORITE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
const MAX_HISTORY = 200;

// La primera cuenta que se abrio (la favorita mientras nadie la cambie)
function firstAccount(accounts) {
    return accounts.slice().sort((a, b) => String(a.openedAt || '').localeCompare(String(b.openedAt || '')) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

// La favorita vigente segun el historial (o la primera cuenta si no hay historial)
function currentFavorite(accounts, favorites) {
    const list = Array.isArray(favorites) ? favorites.filter((f) => f && f.accountId && f.from) : [];
    if (list.length) return list.slice().sort((a, b) => String(a.from).localeCompare(String(b.from)))[list.length - 1].accountId;
    const first = firstAccount(accounts);
    return first ? first.id : null;
}

const setFavoriteBank = onCall(async (request) => {
    const uid = request.auth?.uid;
    const condominioId = request.auth?.token?.condominioId;
    if (!uid || request.auth?.token?.role !== ROLES.ADMIN || !condominioId) {
        throw new HttpsError('permission-denied', 'Solo el administrador del condominio puede cambiar la cuenta favorita');
    }
    const accountId = String(request.data?.accountId || '').trim();
    if (!accountId || accountId.includes('/') || accountId.length > 100) throw new HttpsError('invalid-argument', 'Cuenta inválida');

    if (await rateLimit.isBlocked('favorita', uid, FAVORITE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espere 15 minutos e intente de nuevo.');
    }
    // El codigo tiene que ser el del propio administrador (no basta con estar dentro de su sesion)
    const code = normalizeCode(request.data?.code);
    const codeSnap = code ? await db.doc(`codigos/${code}`).get() : null;
    const owner = codeSnap && codeSnap.exists ? codeSnap.data() : null;
    if (!owner || owner.userId !== uid || owner.condominioId !== condominioId) {
        await rateLimit.hit('favorita', uid, FAVORITE_LIMIT);
        logger.warn('cuenta favorita: codigo incorrecto', { condominioId, userId: uid });
        throw new HttpsError('permission-denied', 'El código no es el suyo. Escriba su código de acceso de administrador.');
    }

    const condoRef = db.doc(`condominios/${condominioId}`);
    const userSnap = await condoRef.collection('usuarios').doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : null;
    if (!user || user.role !== ROLES.ADMIN || user.active === false) {
        throw new HttpsError('permission-denied', 'Solo el administrador del condominio puede cambiar la cuenta favorita');
    }

    const result = await db.runTransaction(async (tx) => {
        const [accountsSnap, configSnap] = await Promise.all([
            tx.get(condoRef.collection('finanzas_bancos')),
            tx.get(condoRef.collection('finanzas_config').doc('bancos'))
        ]);
        const accounts = accountsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
        const account = accounts.find((a) => a.id === accountId);
        if (!account) throw new HttpsError('not-found', 'La cuenta no existe');
        if (account.active === false) throw new HttpsError('failed-precondition', 'La cuenta está desactivada');
        const favorites = configSnap.exists && Array.isArray(configSnap.data().favorites) ? configSnap.data().favorites.slice() : [];
        if (currentFavorite(accounts, favorites) === accountId) throw new HttpsError('failed-precondition', 'Esa cuenta ya es la favorita');
        if (favorites.length >= MAX_HISTORY) throw new HttpsError('resource-exhausted', 'El historial de cuentas favoritas está lleno');
        const now = new Date().toISOString();
        // La primera vez se anota tambien la favorita que habia (la primera cuenta, desde que se abrio): el historial queda completo
        if (!favorites.length) {
            const first = firstAccount(accounts);
            if (first) favorites.push({ accountId: first.id, from: first.openedAt || now, by: 'apertura', byName: 'Primera cuenta abierta' });
        }
        favorites.push({ accountId, from: now, by: uid, byName: user.name || '' });
        tx.set(condoRef.collection('finanzas_config').doc('bancos'), { favorites, updated_at: now }, { merge: true });
        return { favorites, from: now };
    });
    await rateLimit.reset('favorita', uid);
    logger.info('cuenta favorita cambiada', { condominioId, userId: uid, accountId, from: result.from });
    return { success: true, ...result };
});

module.exports = { setFavoriteBank, currentFavorite, firstAccount };
