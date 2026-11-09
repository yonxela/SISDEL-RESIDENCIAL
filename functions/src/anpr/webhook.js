// Webhook de la camara LPR: recibe la placa, decide y responde Open/Close
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');
const { parseRequest, condominioFromRequest } = require('./parse');
const { decideAccess } = require('./decide');

const DEDUP_MS = 30 * 1000;       // La camara manda 3 o mas avisos por cada deteccion
const MAX_PAYLOAD_CHARS = 8000;

function payloadText(rawData) {
    try { return JSON.stringify(rawData).slice(0, MAX_PAYLOAD_CHARS); }
    catch { return '{}'; }
}

async function writeLog(collection, data) {
    const ref = collection.doc();
    await ref.set({ id: ref.id, createdAt: new Date().toISOString(), ...data });
    return ref.id;
}

async function isDuplicate(condoRef, plate) {
    const since = new Date(Date.now() - DEDUP_MS).toISOString();
    const recent = await condoRef.collection('camera_logs').where('createdAt', '>=', since).get();
    return recent.docs.some((d) => d.data().plate === plate);
}

function reply(res, body) {
    res.status(200).json(body);
}

const anprWebhook = onRequest(
    { cors: true, invoker: 'public', memory: '256MiB', timeoutSeconds: 30 },
    async (req, res) => {
        try {
            const { rawData, plateNumber } = await parseRequest(req);
            const condominioId = condominioFromRequest(req, rawData);
            logger.info('ANPR evento', { path: req.path, plate: plateNumber || 'NOPLATE', condominioId });

            // Avisos sin placa (latidos de la camara): se responde OK y no se registra nada
            if (!plateNumber) {
                reply(res, { Command: 'Close', Message: 'No plate', Plate: 'NOPLATE' });
                return;
            }

            const orphans = db.collection('camera_logs_huerfanos');
            if (!condominioId) {
                await writeLog(orphans, {
                    plate: plateNumber, status: 'Error', reason: 'Missing condominioId',
                    rawPayload: payloadText(rawData)
                });
                reply(res, { error: 'condominioId is required, but event was logged' });
                return;
            }

            const condoRef = db.collection('condominios').doc(condominioId);
            const condoSnap = await condoRef.get();
            if (!condoSnap.exists) {
                await writeLog(orphans, {
                    condominioId, plate: plateNumber, status: 'Error', reason: 'Condominio no existe',
                    rawPayload: payloadText(rawData)
                });
                reply(res, { Command: 'Close', Message: 'Denied', Reason: 'Condominio no existe', Plate: plateNumber });
                return;
            }

            if (await isDuplicate(condoRef, plateNumber)) {
                reply(res, { Command: 'OK', Message: 'Duplicate skipped', Plate: plateNumber });
                return;
            }

            const decision = await decideAccess(condoRef, condoSnap.data(), plateNumber);
            const authorized = decision.status !== 'Denied';

            await writeLog(condoRef.collection('camera_logs'), {
                condominioId, plate: plateNumber, status: decision.status,
                reason: decision.reason, rawPayload: payloadText(rawData)
            });

            if (authorized && decision.visitIdToMark) {
                await condoRef.collection('visitas').doc(decision.visitIdToMark)
                    .update({ status: 'entered', enteredAt: new Date().toISOString() });
            }

            if (authorized) {
                reply(res, { Command: 'Open', Message: 'Authorized', Reason: decision.reason, Plate: plateNumber });
            } else {
                reply(res, { Command: 'Close', Message: 'Denied', Reason: decision.reason || 'Placa no registrada', Plate: plateNumber });
            }
        } catch (error) {
            logger.error('ANPR error', { message: error.message, stack: error.stack });
            try {
                await writeLog(db.collection('camera_logs_huerfanos'), {
                    plate: 'ERROR', status: 'Error', reason: String(error.message).slice(0, 500)
                });
            } catch (logError) {
                logger.error('ANPR no pudo registrar el error', { message: logError.message });
            }
            // Siempre 200: la camara reintenta sin parar si recibe error
            reply(res, { error: error.message });
        }
    }
);

module.exports = { anprWebhook };
