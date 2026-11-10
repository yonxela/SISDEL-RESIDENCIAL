// Operaciones de condominio que requieren borrado en cascada
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db, auth } = require('./firebase');
const { ROLES, normalizeCode } = require('./util');
const { isMasterCode } = require('./master');
const rateLimit = require('./rateLimit');
const { purgeCondominio, normalizeName } = require('./purga');

// Eliminar un condominio es lo mas grave que se puede hacer en el sistema: aunque ya haya sesion master, se vuelve a pedir
// la clave master y el nombre del condominio. Los intentos fallidos se limitan.
const PURGE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
// Segunda pasada de limpieza (el borrado de movimientos dispara el recalculo de mora); en el emulador no hace falta esperar
const SETTLE_MS = process.env.FUNCTIONS_EMULATOR === 'true' ? 0 : 15000;

const deleteCondominio = onCall({ timeoutSeconds: 300 }, async (request) => {
    if (request.auth?.token?.role !== ROLES.MASTER) {
        throw new HttpsError('permission-denied', 'Solo el master puede eliminar condominios');
    }
    const condominioId = String(request.data?.condominioId || '').trim();
    if (!condominioId || condominioId.includes('/')) {
        throw new HttpsError('invalid-argument', 'Condominio inválido');
    }

    const uid = request.auth.uid;
    if (await rateLimit.isBlocked('purga', uid, PURGE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espere 15 minutos e intente de nuevo.');
    }
    const masterCode = normalizeCode(request.data?.masterCode);
    if (!masterCode || !(await isMasterCode(masterCode))) {
        await rateLimit.hit('purga', uid, PURGE_LIMIT);
        logger.warn('eliminar condominio: clave master incorrecta', { condominioId });
        throw new HttpsError('permission-denied', 'La clave master no es correcta');
    }

    const condoSnap = await db.doc(`condominios/${condominioId}`).get();
    if (!condoSnap.exists) throw new HttpsError('not-found', 'El condominio no existe');
    const name = condoSnap.data().name || '';
    const typed = normalizeName(request.data?.confirmName);
    if (!typed || typed !== normalizeName(name)) {
        throw new HttpsError('failed-precondition', 'El nombre escrito no coincide con el del condominio');
    }

    const result = await purgeCondominio({ db, auth }, condominioId, { settleMs: SETTLE_MS });
    await rateLimit.reset('purga', uid);
    logger.warn('condominio eliminado', { condominioId, nombre: name, ...result });
    return { success: true, ...result };
});

module.exports = { deleteCondominio };
