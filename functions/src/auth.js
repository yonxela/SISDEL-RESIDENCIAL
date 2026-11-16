// Login por codigo de acceso y verificacion de codigos en garita
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db, auth } = require('./firebase');
const { ROLES, normalizeCode, clientIp } = require('./util');
const rateLimit = require('./rateLimit');
const { isMasterCode } = require('./master');
const privilegios = require('./privilegios');

// Todo un condominio suele salir por la misma IP publica: el limite es compartido, por eso es amplio
const LOGIN_LIMIT = { max: 30, windowMs: 15 * 60 * 1000 };
const VERIFY_LIMIT = { max: 60, windowMs: 10 * 60 * 1000 };
// Confirmar la propia clave: pocos intentos fallidos por usuario (no es un login, es una confirmacion de una accion delicada)
const CONFIRM_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

// Roles de condominio que pueden entrar (el master tiene su propia ruta). A donde van lo decide
// privilegios.landing: la pagina de su rol y, si el administrador se la quito, la primera que si le toca.
const CONDO_ROLES = [ROLES.ADMIN, ROLES.VECINO, ROLES.POLICIA, ROLES.AUDITOR, ROLES.SUPERVISOR, ROLES.OPERADOR];

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
            success: true, token, role: ROLES.MASTER, redirect: 'master.html',
            session: { role: ROLES.MASTER }
        };
    }

    // 2. Usuario de condominio
    const found = await findUserByCode(code);
    if (!found || !CONDO_ROLES.includes(found.user.role)) {
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
    const redirect = privilegios.landing(user.role, user.privilegios);
    if (!redirect) {
        log('no_access', { condominioId: user.condominioId, userId: user.id, role: user.role });
        return { success: false, error: 'Su usuario no tiene accesos asignados. Contacte al administrador.' };
    }

    const token = await auth.createCustomToken(user.id, { role: user.role, condominioId: user.condominioId });
    await rateLimit.reset('login', ip);
    log('ok', { role: user.role, condominioId: user.condominioId, userId: user.id });

    return {
        success: true, token, role: user.role, redirect,
        session: {
            role: user.role, userId: user.id, userName: user.name, userCasa: user.casa || '',
            condominioId: user.condominioId, condominioName: condo.name, code,
            // Solo las diferencias con los privilegios de su rol; el navegador calcula el resto (privilegios.js)
            privilegios: privilegios.cleanOverrides(user.privilegios), cargo: user.cargo || ''
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
        && privilegios.has(me.data().role, me.data().privilegios, 'garita.verificar');
    if (!allowed) throw new HttpsError('permission-denied', 'Sin permisos');

    if (await rateLimit.isBlocked('verify', uid, VERIFY_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas verificaciones. Espere unos minutos.');
    }
    await rateLimit.hit('verify', uid, VERIFY_LIMIT);

    const code = normalizeCode(request.data?.code);
    if (!code) return { user: null };

    const found = await findUserByCode(code);
    if (!found || found.user.condominioId !== condominioId) return { user: null };
    // La garita verifica vecinos. Los codigos del personal (guardias, administradores...) no se confirman desde aqui:
    // confirmar uno equivale a poder entrar con el.
    if (found.user.role !== 'vecino') return { user: null };

    const u = found.user;
    return {
        user: {
            id: u.id, condominioId, name: u.name, role: u.role, casa: u.casa || '',
            paymentStatus: u.paymentStatus || null, active: u.active !== false
        }
    };
});

// Reautenticacion: quien va a hacer una accion delicada (aplicar la cuota del mes a todos en cobro manual) vuelve a
// escribir SU propio codigo de acceso. Solo dice si ese codigo es el suyo: nunca revela de quien es otro codigo, asi que
// no sirve para adivinar claves ajenas. Pocos intentos fallidos por usuario (CONFIRM_LIMIT); el codigo nunca se registra.
const confirmOwnCode = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const code = normalizeCode(request.data?.code);
    const log = (outcome) => logger.info('confirmar clave', { outcome, uid, role: token.role || null });

    if (await rateLimit.isBlocked('confirm', uid, CONFIRM_LIMIT)) {
        log('blocked');
        throw new HttpsError('resource-exhausted', 'Demasiados intentos con la clave. Espere unos minutos e intente de nuevo.');
    }

    let mine = false;
    if (code) {
        if (token.role === ROLES.MASTER) {
            mine = await isMasterCode(code);
        } else if (token.condominioId) {
            const found = await findUserByCode(code);
            mine = !!found && found.user.condominioId === token.condominioId && found.user.id === uid && found.user.active !== false;
        } else {
            throw new HttpsError('permission-denied', 'Sin permisos');
        }
    }
    if (!mine) {
        await rateLimit.hit('confirm', uid, CONFIRM_LIMIT);
        log('bad');
        return { ok: false };
    }
    await rateLimit.reset('confirm', uid);
    log('ok');
    return { ok: true };
});

module.exports = { login, verifyAccessCode, confirmOwnCode };
