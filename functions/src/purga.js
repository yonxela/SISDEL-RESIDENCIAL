// Borrado total de un condominio. Lo usan la funcion deleteCondominio (boton "Eliminar Condominio Definitivamente" del
// master) y scripts/purgar-condominios.mjs (limpieza completa). No importa firebase-admin: recibe db y auth ya iniciados,
// asi funciona igual en las funciones y en un script con el emulador o con la nube.
//
// Que se borra de un condominio: el documento y TODAS sus subcolecciones (usuarios, visitas, vehiculos, mensajes,
// camara, Sistema Financiero, rondas, alertas de panico, privilegios...), sus codigos de acceso (coleccion codigos),
// la clave secreta de su camara (_privado/camaras/claves/{id}) y las cuentas de acceso (Firebase Auth) de sus usuarios.
// Nunca toca _privado/auth (clave master), _privado/whatsapp, mensajes_globales ni la cuenta "master".

const CHUNK = 400;
const MASTER_UID = 'master';
const AUTH_CHUNK = 1000;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deleteRefs(db, refs) {
    for (let i = 0; i < refs.length; i += CHUNK) {
        const batch = db.batch();
        refs.slice(i, i + CHUNK).forEach((ref) => batch.delete(ref));
        await batch.commit();
    }
}

function validId(condominioId) {
    const id = String(condominioId || '').trim();
    if (!id || id.includes('/') || id === '.' || id === '..') throw new Error('Condominio invalido');
    return id;
}

// Nombre comparable: sin acentos, sin mayusculas y con los espacios normalizados
function normalizeName(text) {
    return String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Cuanto hay en un condominio (no toca nada): documentos por subcoleccion, codigos y cuentas de acceso
async function describeCondominio({ db }, condominioId) {
    const id = validId(condominioId);
    const condoRef = db.doc(`condominios/${id}`);
    const snap = await condoRef.get();
    const counts = {};
    for (const col of await condoRef.listCollections()) {
        counts[col.id] = (await col.count().get()).data().count;
    }
    const codigos = (await db.collection('codigos').where('condominioId', '==', id).count().get()).data().count;
    const data = snap.exists ? snap.data() : {};
    return { id, existe: snap.exists, nombre: data.name || '', activo: data.active !== false, subcolecciones: counts, codigos };
}

// Borra el condominio completo. settleMs: espera antes de una segunda pasada, porque borrar movimientos del Sistema
// Financiero dispara el recalculo de mora (no recrea nada si el condominio ya no existe, pero la segunda pasada
// deja la limpieza comprobada).
async function purgeCondominio({ db, auth }, condominioId, { settleMs = 0, sleep = sleepMs } = {}) {
    const id = validId(condominioId);
    const condoRef = db.doc(`condominios/${id}`);

    // Usuarios del condominio (para borrar luego sus cuentas de acceso)
    const users = await condoRef.collection('usuarios').select().get();
    const userIds = users.docs.map((d) => d.id).filter((uid) => uid !== MASTER_UID);

    // 1. Codigos de acceso y clave de la camara
    const codes = await db.collection('codigos').where('condominioId', '==', id).get();
    await deleteRefs(db, codes.docs.map((d) => d.ref));
    await db.doc(`_privado/camaras/claves/${id}`).delete();

    // 2. El documento y todas sus subcolecciones
    await db.recursiveDelete(condoRef);
    if (settleMs > 0) {
        await sleep(settleMs);
        await db.recursiveDelete(condoRef);
        const lateCodes = await db.collection('codigos').where('condominioId', '==', id).get();
        await deleteRefs(db, lateCodes.docs.map((d) => d.ref));
    }

    // 3. Cuentas de acceso (Firebase Auth) de sus usuarios
    let cuentas = 0;
    if (auth) {
        for (let i = 0; i < userIds.length; i += AUTH_CHUNK) {
            const result = await auth.deleteUsers(userIds.slice(i, i + AUTH_CHUNK));
            cuentas += result.successCount;
        }
    }
    return { usuarios: userIds.length, codigos: codes.size, cuentas };
}

module.exports = { purgeCondominio, describeCondominio, normalizeName, validId, MASTER_UID };
