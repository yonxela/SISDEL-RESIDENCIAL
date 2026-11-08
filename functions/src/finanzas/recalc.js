// Mora automatica: el Sistema Financiero decide el estado de pago de cada vecino,
// que es lo que usa la camara LPR (ver anpr/decide.js).
//
// - Se activa sola la primera vez que el condominio registra un cargo en el Sistema
//   Financiero (condominios/{id}.moraAutomatica = true) y queda activa. Antes de eso
//   el estado de pago se sigue manejando a mano en el panel admin.
// - Una vez activa, paymentStatus y morosoSince los escribe solo el servidor.
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');
const { missingFees, moraOf, periodKey, localParts } = require('./mora');

const SETTINGS_DOC = 'oikos_settings';
const BATCH_SIZE = 400;
// Solo los campos que hacen falta: los movimientos pueden traer fotos de comprobantes
const TX_FIELDS = ['id', 'type', 'kind', 'amount', 'resiId', 'deleted', 'period', 'concept'];

const docIdOf = (id) => String(id).replace(/\//g, '_');

async function commitInChunks(writes) {
    for (let i = 0; i < writes.length; i += BATCH_SIZE) {
        const batch = db.batch();
        writes.slice(i, i + BATCH_SIZE).forEach((write) => write(batch));
        await batch.commit();
    }
}

function txOf(doc) {
    const data = doc.data();
    return { ...data, id: data.id !== undefined ? data.id : doc.id };
}

// Cambio de estado de pago del vecino, o null si no cambia
function statusUpdate(user, mora, nowIso) {
    const next = mora.moroso ? 'moroso' : 'al_dia';
    if (user.paymentStatus === next) return null;
    return { paymentStatus: next, morosoSince: next === 'moroso' ? (user.morosoSince || nowIso) : null };
}

async function readSettings(condoRef) {
    const snap = await condoRef.collection('finanzas_config').doc(SETTINGS_DOC).get();
    return snap.exists ? snap.data() : null;
}

// Recalcula todo el condominio: crea las cuotas automaticas que falten y actualiza
// el estado de pago de cada vecino. Devuelve un resumen para la bitacora.
async function recalcCondo(condoId, now = new Date()) {
    const condoRef = db.collection('condominios').doc(condoId);
    const [condoSnap, settings] = await Promise.all([condoRef.get(), readSettings(condoRef)]);
    if (!condoSnap.exists || !settings) return { condoId, active: false };
    const condo = condoSnap.data();

    const [usersSnap, extrasSnap, txSnap] = await Promise.all([
        condoRef.collection('usuarios').where('role', '==', 'vecino').get(),
        condoRef.collection('finanzas_residentes').get(),
        condoRef.collection('finanzas_movimientos').select(...TX_FIELDS).get()
    ]);
    const txs = txSnap.docs.map(txOf);
    const active = condo.moraAutomatica === true || txs.some((t) => t.type === 'charge');
    if (!active) return { condoId, active: false };

    const nowIso = now.toISOString();
    const { y, m } = localParts(now);
    const currentPeriod = periodKey(y, m);
    const extras = new Map(extrasSnap.docs.map((d) => [d.id, d.data()]));
    const writes = [];

    if (condo.moraAutomatica !== true) {
        writes.push((b) => b.update(condoRef, { moraAutomatica: true, moraAutomaticaDesde: nowIso }));
    }

    // Vecinos sin datos financieros: se cobran desde este mes (igual que finanzas-sync.js)
    const residents = [];
    const users = new Map();
    usersSnap.docs.forEach((doc) => {
        const user = { ...doc.data(), id: doc.id };
        users.set(doc.id, user);
        let extra = extras.get(doc.id);
        if (!extra) {
            extra = { id: doc.id, feeFrom: currentPeriod, updated_at: nowIso };
            const data = extra;
            writes.push((b) => b.set(condoRef.collection('finanzas_residentes').doc(doc.id), data));
        }
        // Quitado del Sistema Financiero en OIKOS: su estado de pago no se toca
        if (extra.deleted) return;
        residents.push({ ...extra, id: doc.id, createdAt: extra.createdAt || user.createdAt });
    });

    const fees = missingFees(residents, txs, settings, now, nowIso);
    fees.forEach((fee) => writes.push((b) => b.set(condoRef.collection('finanzas_movimientos').doc(docIdOf(fee.id)), fee)));
    txs.push(...fees);

    let changes = 0;
    residents.forEach((r) => {
        const update = statusUpdate(users.get(r.id), moraOf(r.id, txs, settings, now), nowIso);
        if (!update) return;
        changes++;
        writes.push((b) => b.update(condoRef.collection('usuarios').doc(r.id), update));
    });

    await commitInChunks(writes);
    return { condoId, active: true, fees: fees.length, changes };
}

// Recalcula un solo vecino (al registrar o anular un cargo o pago)
async function recalcResident(condoId, residentId, now = new Date()) {
    const condoRef = db.collection('condominios').doc(condoId);
    const condoSnap = await condoRef.get();
    if (!condoSnap.exists) return null;
    // La primera vez se recalcula todo el condominio, que es lo que activa la mora automatica
    if (condoSnap.data().moraAutomatica !== true) return recalcCondo(condoId, now);

    const userRef = condoRef.collection('usuarios').doc(String(residentId));
    const [settings, userSnap, extraSnap, txSnap] = await Promise.all([
        readSettings(condoRef),
        userRef.get(),
        condoRef.collection('finanzas_residentes').doc(String(residentId)).get(),
        condoRef.collection('finanzas_movimientos').where('resiId', '==', String(residentId)).select(...TX_FIELDS).get()
    ]);
    if (!settings || !userSnap.exists || userSnap.data().role !== 'vecino') return null;
    if (extraSnap.exists && extraSnap.data().deleted) return null;

    const mora = moraOf(String(residentId), txSnap.docs.map(txOf), settings, now);
    const update = statusUpdate(userSnap.data(), mora, now.toISOString());
    if (update) await userRef.update(update);
    return { condoId, residentId, moroso: mora.moroso, overdue: mora.overdue, changed: !!update };
}

// Todos los condominios activos con Sistema Financiero (lo corre la tarea diaria)
async function recalcAll(now = new Date()) {
    const condos = await db.collection('condominios').where('active', '==', true).get();
    const results = [];
    for (const condo of condos.docs) {
        try {
            results.push(await recalcCondo(condo.id, now));
        } catch (error) {
            logger.error('finanzas: no se pudo recalcular', { condoId: condo.id, message: error.message });
        }
    }
    return results;
}

module.exports = { recalcCondo, recalcResident, recalcAll, statusUpdate };
