// Operaciones de condominio que requieren borrado en cascada
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./firebase');
const { ROLES } = require('./util');

const deleteCondominio = onCall({ timeoutSeconds: 300 }, async (request) => {
    if (request.auth?.token?.role !== ROLES.MASTER) {
        throw new HttpsError('permission-denied', 'Solo el master puede eliminar condominios');
    }
    const condominioId = String(request.data?.condominioId || '').trim();
    if (!condominioId || condominioId.includes('/')) {
        throw new HttpsError('invalid-argument', 'Condominio inválido');
    }

    // 1. Codigos de acceso del condominio
    const codes = await db.collection('codigos').where('condominioId', '==', condominioId).get();
    for (let i = 0; i < codes.docs.length; i += 400) {
        const batch = db.batch();
        codes.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }

    // 2. Documento y todas sus subcolecciones
    await db.recursiveDelete(db.doc(`condominios/${condominioId}`));
    return { success: true };
});

module.exports = { deleteCondominio };
