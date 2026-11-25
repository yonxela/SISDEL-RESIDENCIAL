// Bitacora: el rastro, en el servidor, de cada cambio a los datos de los residentes y del Sistema Financiero.
//
// Cada vez que se crea, cambia o elimina un documento de las colecciones de AUDITED, el servidor anota en
// condominios/{c}/bitacora/{id}: quien lo hizo, cuando, que documento y que cambio (valor de antes y de despues).
// - La escribe solo el servidor: las reglas no dejan que nadie la escriba, la cambie ni la borre desde una pantalla.
// - "Quien" sale del propio evento de Firestore (la sesion con la que se hizo la escritura), no de un dato que
//   mande el navegador. Lo que hace el servidor (cuotas del dia, mora, sellos) queda como "Servidor".
// - Lo eliminado queda con su contenido completo, y lo anulado o devuelto queda como "anular" / "restaurar".
// - Si el condominio se esta eliminando por completo (purga.js lo marca con `purging`) ya no se anota nada: no
//   se guardan copias de lo que se elimina ni se recrea nada suyo.
// - Una anotacion nunca se pierde por ser grande: se resume (entrada.js) y, si aun asi Firestore la rechaza, se
//   guarda lo minimo (que documento, que accion, quien y que campos).
//
// Se consulta con scripts/ver-bitacora.mjs. Como se arma cada anotacion: entrada.js (se prueba en scripts/test-bitacora.mjs).
const { onDocumentWrittenWithAuthContext } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../firebase');
const { COLLECTION, AUDITED, buildEntry, minimalEntry, userIdOf, actorOf } = require('./entrada');

// Fallas pasajeras (se reintenta): tiempo agotado, sin cupo, transaccion abortada, error interno, servicio caido
const TRANSIENT_CODES = [4, 8, 10, 13, 14];
const isTransient = (error) => !error || error.code === undefined || TRANSIENT_CODES.includes(Number(error.code));

// Anota en una transaccion: solo si el condominio todavia existe (si lo estan eliminando no se recrea nada).
// El id es el del evento: si el evento llega dos veces, se anota una sola vez.
async function record(condoId, entryId, entry) {
    const condoRef = db.doc(`condominios/${condoId}`);
    const uid = userIdOf(entry.actorType, entry.actorId);
    return db.runTransaction(async (tx) => {
        const refs = [condoRef];
        if (uid) refs.push(condoRef.collection('usuarios').doc(uid));
        const [condoSnap, actorSnap] = await tx.getAll(...refs);
        if (!condoSnap.exists || condoSnap.get('purging') === true) return false;
        const actor = actorOf(entry, actorSnap && actorSnap.exists ? actorSnap.data() : null);
        tx.set(condoRef.collection(COLLECTION).doc(entryId), { ...entry, ...actor, at: FieldValue.serverTimestamp() });
        return true;
    });
}

// Disparador de una coleccion con rastro. Reintenta si no pudo anotar: el rastro no debe perderse por una falla pasajera.
function audit(collection) {
    return onDocumentWrittenWithAuthContext({ document: `condominios/{condoId}/${collection}/{docId}`, retry: true }, async (event) => {
        let entry = null;
        try {
            const before = event.data && event.data.before.exists ? event.data.before.data() : null;
            const after = event.data && event.data.after.exists ? event.data.after.data() : null;
            entry = buildEntry({ collection, docId: event.params.docId, before, after, authType: event.authType, authId: event.authId, eventTime: event.time });
        } catch (error) {
            // Un evento que no se puede leer no se arregla reintentando: queda en el registro de la funcion
            logger.error('bitacora: evento ilegible', { collection, docId: event.params.docId, message: error.message });
            return;
        }
        if (!entry) return;
        const entryId = String(event.id || `${Date.now()}-${event.params.docId}`).replace(/\//g, '_');
        try {
            await record(event.params.condoId, entryId, entry);
        } catch (error) {
            if (isTransient(error)) throw error;
            // Firestore rechazo la anotacion (demasiado grande o con un valor que no admite): reintentar no lo arregla.
            // Se guarda lo minimo para que el cambio no quede sin rastro.
            logger.error('bitacora: anotacion rechazada, se guarda resumida', { collection, docId: event.params.docId, message: error.message });
            try {
                await record(event.params.condoId, entryId, minimalEntry(entry, error.message));
            } catch (second) {
                if (isTransient(second)) throw second;
                logger.error('bitacora: no se pudo anotar', { collection, docId: event.params.docId, message: second.message });
            }
        }
    });
}

module.exports = {
    auditUsers: audit('usuarios'),
    auditVehicles: audit('vehiculos'),
    auditFinanceResidents: audit('finanzas_residentes'),
    auditFinanceMovements: audit('finanzas_movimientos'),
    auditFinanceSettings: audit('finanzas_config'),
    auditBankAccounts: audit('finanzas_bancos'),
    auditBankMovements: audit('finanzas_bancos_movs'),
    // Configuracion del boton de panico: telefonos de la garita y la PNC y textos del aviso
    auditPanicConfig: audit('panico_config'),
    // Panel del vecino: marbete y pases de visita encendidos o apagados para todos los vecinos (Configuracion > Panel del vecino)
    auditVecinoConfig: audit('vecino_config'),
    record, AUDITED
};
