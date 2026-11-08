// Login por codigo de acceso y verificacion de codigos en garita
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db, auth } = require('./firebase');
const { ROLES, normalizeCode, sha256, safeEqual, clientIp } = require('./util');
const rateLimit = require('./rateLimit');

// Todo un condominio suele salir por la misma IP publica: el limite es compartido, por eso es amplio
const LOGIN_LIMIT = { max: 30, windowMs: 15 * 60 * 1000 };
const VERIFY_LIMIT = { max: 120, windowMs: 10 * 60 * 1000 };

const REDIRECTS = {
    [ROLES.MASTER]: 'master.html',
    [ROLES.ADMIN]: 'admin.html',
    [ROLES.VECINO]: 'vecino.html',
    [ROLES.POLICIA]: 'garita.html',
    [ROLES.AUDITOR]: 'auditor.html',
    [ROLES.SUPERVISOR]: 'rondas.html'
};

async function isMasterCode(code) {
    const snap = await db.doc('_privado/auth').get();
    const hash = snap.exists ? snap.data().masterCodeHash : null;
    if (!hash) return false;
    return safeEqual(sha256(code), hash);
}

// Busca el usuario dueno de un codigo. Devuelve null si el codigo no existe
async function findUserByCode(code) {
    const codeSnap = await db.doc(`codigos/${code}`).get();
    if (!codeSnap.exists) return null;
    const { condominioId, userId } = codeSnap.data();
    if (!condominioId || !userId) return null;

    const [userSnap, condoSnap] = await Promise.all([
        db.doc(`condominios/${condominioId}/usuarios/${userId}`).get(),
        db.doc(`condominios/${condominioId}`).get()
    ]);
    if (!userSnap.exists) return null;
    return {
        user: { ...userSnap.data(), id: userSnap.id, condominioId },
        condo: condoSnap.exists ? { ...condoSnap.data(), id: condoSnap.id } : null
    };
}

const login = onCall(async (request) => {
    const code = normalizeCode(request.data?.code);
    const ip = clientIp(request.rawRequest);
    // Bitacora de intentos (nunca el codigo): sirve para ver por que alguien no puede entrar
    const log = (outcome, extra = {}) => logger.info('login', { outcome, ip, codeLength: code.length, ...extra });

    if (!code) { log('empty'); return { success: false, error: 'Código de acceso no válido' }; }

    if (await rateLimit.isBlocked('login', ip, LOGIN_LIMIT)) {
        log('blocked');
        return { success: false, error: 'Demasiados intentos. Espere 15 minutos e intente de nuevo.' };
    }

    // 1. Master
    if (await isMasterCode(code)) {
        const token = await auth.createCustomToken('master', { role: ROLES.MASTER });
        await rateLimit.reset('login', ip);
        log('ok', { role: ROLES.MASTER });
        return {
            success: true, token, role: ROLES.MASTER, redirect: REDIRECTS[ROLES.MASTER],
            session: { role: ROLES.MASTER }
        };
    }

    // 2. Usuario de condominio
    const found = await findUserByCode(code);
    if (!found || !REDIRECTS[found.user.role] || found.user.role === ROLES.MASTER) {
        await rateLimit.hit('login', ip, LOGIN_LIMIT);
        log(found ? 'bad_role' : 'not_found');
        return { success: false, error: 'Código de acceso no válido' };
    }
    const { user, condo } = found;
    if (!condo || condo.active !== true) {
        log('condo_inactive', { condominioId: user.condominioId });
        return { success: false, error: 'El condominio no está activo' };
    }
    if (user.active === false) {
        log('user_inactive', { condominioId: user.condominioId, userId: user.id });
        return { success: false, error: 'Usuario inactivo. Contacte al administrador.' };
    }

    const token = await auth.createCustomToken(user.id, { role: user.role, condominioId: user.condominioId });
    await rateLimit.reset('login', ip);
    log('ok', { role: user.role, condominioId: user.condominioId, userId: user.id });

    return {
        success: true, token, role: user.role, redirect: REDIRECTS[user.role],
        session: {
            role: user.role, userId: user.id, userName: user.name, userCasa: user.casa || '',
            condominioId: user.condominioId, condominioName: condo.name, code
        },
        user: { id: user.id, name: user.name, role: user.role, casa: user.casa || '', condominioId: user.condominioId }
    };
});

// Garita: valida el codigo que presenta una persona, sin exponer la lista de codigos
const verifyAccessCode = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const condominioId = token.condominioId;
    if (!condominioId) throw new HttpsError('permission-denied', 'Sin permisos');

    const me = await db.doc(`condominios/${condominioId}/usuarios/${uid}`).get();
    const allowed = me.exists && me.data().active !== false
        && [ROLES.ADMIN, ROLES.POLICIA].includes(me.data().role);
    if (!allowed) throw new HttpsError('permission-denied', 'Sin permisos');

    if (await rateLimit.isBlocked('verify', uid, VERIFY_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas verificaciones. Espere unos minutos.');
    }
    await rateLimit.hit('verify', uid, VERIFY_LIMIT);

    const code = normalizeCode(request.data?.code);
    if (!code) return { user: null };

    const found = await findUserByCode(code);
    if (!found || found.user.condominioId !== condominioId) return { user: null };

    const u = found.user;
    return {
        user: {
            id: u.id, condominioId, name: u.name, role: u.role, casa: u.casa || '',
            paymentStatus: u.paymentStatus || null, active: u.active !== false
        }
    };
});

module.exports = { login, verifyAccessCode };
