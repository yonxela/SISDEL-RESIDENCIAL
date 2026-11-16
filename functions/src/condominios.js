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

// Cambiar el nombre de un condominio: solo el programador, con la clave master aunque ya haya sesion master (las reglas no
// dejan cambiar `name` desde el navegador). Se copia tambien a la configuracion del Sistema Financiero, que lo usa en sus
// reportes y recibos (y queda en la bitacora); el cambio queda ademas en el registro del servidor con el nombre de antes.
const RENAME_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
const NAME_MIN = 3;
const NAME_MAX = 80;
const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const renameCondominio = onCall(async (request) => {
    if (request.auth?.token?.role !== ROLES.MASTER) {
        throw new HttpsError('permission-denied', 'Solo el programador puede cambiar el nombre de un condominio');
    }
    const condominioId = String(request.data?.condominioId || '').trim();
    if (!condominioId || condominioId.includes('/')) {
        throw new HttpsError('invalid-argument', 'Condominio inválido');
    }
    const newName = cleanName(request.data?.newName);
    if (newName.length < NAME_MIN || newName.length > NAME_MAX) {
        throw new HttpsError('invalid-argument', `El nombre debe tener entre ${NAME_MIN} y ${NAME_MAX} caracteres`);
    }

    const uid = request.auth.uid;
    if (await rateLimit.isBlocked('renombrar', uid, RENAME_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espere 15 minutos e intente de nuevo.');
    }
    const masterCode = normalizeCode(request.data?.masterCode);
    if (!masterCode || !(await isMasterCode(masterCode))) {
        await rateLimit.hit('renombrar', uid, RENAME_LIMIT);
        logger.warn('cambiar nombre de condominio: clave master incorrecta', { condominioId });
        throw new HttpsError('permission-denied', 'La clave master no es correcta');
    }

    const condoRef = db.doc(`condominios/${condominioId}`);
    const condoSnap = await condoRef.get();
    if (!condoSnap.exists) throw new HttpsError('not-found', 'El condominio no existe');
    await rateLimit.reset('renombrar', uid);
    const oldName = condoSnap.data().name || '';
    if (newName === oldName) return { success: true, name: newName, changed: false };

    const settingsRef = condoRef.collection('finanzas_config').doc('oikos_settings');
    const settingsSnap = await settingsRef.get();
    const batch = db.batch();
    batch.update(condoRef, { name: newName, previousName: oldName, renamedAt: new Date().toISOString() });
    if (settingsSnap.exists) batch.set(settingsRef, { name: newName, updated_at: new Date().toISOString() }, { merge: true });
    await batch.commit();
    logger.warn('condominio renombrado', { condominioId, antes: oldName, despues: newName });
    return { success: true, name: newName, changed: true };
});

// Cambiar el nombre de un administrador: igual que el del condominio, solo el programador y con la clave master (las reglas
// no dejan cambiar el nombre de un admin desde el navegador, ni al master ni a otro administrador). La bitacora anota el
// cambio (auditUsers) y el registro del servidor guarda el nombre de antes.
const renameAdmin = onCall(async (request) => {
    if (request.auth?.token?.role !== ROLES.MASTER) {
        throw new HttpsError('permission-denied', 'Solo el programador puede cambiar el nombre de un administrador');
    }
    const condominioId = String(request.data?.condominioId || '').trim();
    const userId = String(request.data?.userId || '').trim();
    if (!condominioId || condominioId.includes('/') || !userId || userId.includes('/')) {
        throw new HttpsError('invalid-argument', 'Administrador inválido');
    }
    const newName = cleanName(request.data?.newName);
    if (newName.length < NAME_MIN || newName.length > NAME_MAX) {
        throw new HttpsError('invalid-argument', `El nombre debe tener entre ${NAME_MIN} y ${NAME_MAX} caracteres`);
    }

    const uid = request.auth.uid;
    if (await rateLimit.isBlocked('renombrar', uid, RENAME_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiados intentos. Espere 15 minutos e intente de nuevo.');
    }
    const masterCode = normalizeCode(request.data?.masterCode);
    if (!masterCode || !(await isMasterCode(masterCode))) {
        await rateLimit.hit('renombrar', uid, RENAME_LIMIT);
        logger.warn('cambiar nombre de administrador: clave master incorrecta', { condominioId, userId });
        throw new HttpsError('permission-denied', 'La clave master no es correcta');
    }

    const userRef = db.doc(`condominios/${condominioId}/usuarios/${userId}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new HttpsError('not-found', 'El usuario no existe');
    if (userSnap.data().role !== ROLES.ADMIN) throw new HttpsError('failed-precondition', 'Ese usuario no es administrador');
    await rateLimit.reset('renombrar', uid);
    const oldName = userSnap.data().name || '';
    if (newName === oldName) return { success: true, name: newName, changed: false };

    await userRef.update({ name: newName, previousName: oldName, renamedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    logger.warn('administrador renombrado', { condominioId, userId, antes: oldName, despues: newName });
    return { success: true, name: newName, changed: true };
});

module.exports = { deleteCondominio, renameCondominio, renameAdmin };
