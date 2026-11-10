// Verificacion de la clave master (la que solo conoce el programador). En la base solo esta su huella (_privado/auth).
// La usan el login y el borrado de condominios, que vuelve a pedir la clave aunque ya haya sesion master.
const { db } = require('./firebase');
const { sha256, safeEqual } = require('./util');

async function isMasterCode(code) {
    const snap = await db.doc('_privado/auth').get();
    const hash = snap.exists ? snap.data().masterCodeHash : null;
    if (!hash) return false;
    return safeEqual(sha256(code), hash);
}

module.exports = { isMasterCode };
