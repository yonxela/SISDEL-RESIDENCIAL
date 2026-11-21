// Funciones del envio de recordatorios por WhatsApp a todos los residentes (la logica esta en recordatorios-core.js).
//  - startReminderCampaign / controlReminderCampaign / sendReminderTest: las llama OIKOS (finanzas.html) con la sesion
//    de quien lo usa; piden el privilegio finanzas.residentes_contactar y estan limitadas.
//  - processReminderQueue: cada minuto manda los mensajes que faltan, de a poco.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { db } = require('./firebase');
const privilegios = require('./privilegios');
const rateLimit = require('./rateLimit');
const whatsapp = require('./rondas/whatsapp');
const core = require('./recordatorios-core');

const KEY = 'finanzas.residentes_contactar';
const CREATE_LIMIT = { max: 6, windowMs: 60 * 60 * 1000 };
const TEST_LIMIT = { max: 8, windowMs: 10 * 60 * 1000 };
const ONE_LIMIT = { max: 60, windowMs: 10 * 60 * 1000 };
const CODE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };
const STATUS_LIMIT = { max: 60, windowMs: 10 * 60 * 1000 };
const RECONCILE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 };

// Quien llama: un usuario activo del condominio con el privilegio de recordatorios
async function authorize(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const condominioId = token.condominioId;
    if (!condominioId) throw new HttpsError('permission-denied', 'Sin permisos');
    const me = await db.doc(`condominios/${condominioId}/usuarios/${uid}`).get();
    const allowed = me.exists && me.data().active !== false && privilegios.has(me.data().role, me.data().privilegios, KEY);
    if (!allowed) throw new HttpsError('permission-denied', 'Su usuario no tiene permiso para enviar recordatorios por WhatsApp.');
    return { uid, condominioId, caller: { id: uid, name: me.data().name || '' }, me: me.data() };
}

// Los errores de la logica traen su codigo y un texto en español; cualquier otro se registra y no se muestra
function wrap(name, handler) {
    return onCall({ timeoutSeconds: 120 }, async (request) => {
        try {
            return await handler(request);
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            if (error && error.userCode) throw new HttpsError(error.userCode, error.message);
            logger.error(`recordatorios: ${name} fallo`, { message: error && error.message });
            throw new HttpsError('internal', 'No se pudo completar. Intente de nuevo.');
        }
    });
}

const startReminderCampaign = wrap('startReminderCampaign', async (request) => {
    const { uid, condominioId, caller } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios', uid, CREATE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Ya hizo varios envíos en la última hora. Espere un poco e intente de nuevo.');
    }
    const result = await core.createCampaign({ db, whatsapp, condominioId, caller, data: request.data || {} });
    await rateLimit.hit('recordatorios', uid, CREATE_LIMIT);
    logger.warn('recordatorios: envio creado', { condominioId, campaignId: result.id, total: result.total, pendientes: result.pending, por: uid });
    return result;
});

const controlReminderCampaign = wrap('controlReminderCampaign', async (request) => {
    const { condominioId, uid } = await authorize(request);
    const result = await core.controlCampaign({ db, whatsapp, condominioId, data: request.data || {} });
    logger.warn('recordatorios: envio controlado', { condominioId, accion: (request.data || {}).action, campaignId: (request.data || {}).campaignId, por: uid });
    return result;
});

const sendReminderTest = wrap('sendReminderTest', async (request) => {
    const { uid } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios-prueba', uid, TEST_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas pruebas seguidas. Espere unos minutos.');
    }
    await rateLimit.hit('recordatorios-prueba', uid, TEST_LIMIT);
    return core.sendTest({ whatsapp, data: request.data || {} });
});

// Un residente, al instante (boton Enviar de la fila y Contactar)
const sendReminderOne = wrap('sendReminderOne', async (request) => {
    const { uid, condominioId, caller } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios-uno', uid, ONE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiados mensajes seguidos. Espere unos minutos o use "Enviar a todos".');
    }
    await rateLimit.hit('recordatorios-uno', uid, ONE_LIMIT);
    const result = await core.sendOne({ db, whatsapp, condominioId, caller, data: request.data || {} });
    logger.warn('recordatorios: mensaje a un residente', { condominioId, residentId: (request.data || {}).residentId, enviado: result.sent, por: uid });
    return result;
});

// La clave de acceso a garita.app de UN vecino, desde el numero del condominio (Enviar clave de acceso de OIKOS). Pide ademas
// "Ver y cambiar codigos de acceso" (usuarios.codigos): el mismo privilegio que las reglas piden para leer las claves
const sendAccessCode = wrap('sendAccessCode', async (request) => {
    const { uid, condominioId, caller, me } = await authorize(request);
    if (!privilegios.has(me.role, me.privilegios, 'usuarios.codigos')) {
        throw new HttpsError('permission-denied', 'Su usuario no puede ver ni enviar las claves de acceso (privilegio "Ver y cambiar códigos de acceso").');
    }
    if (await rateLimit.isBlocked('clave-acceso', uid, CODE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas claves enviadas seguidas. Espere unos minutos.');
    }
    await rateLimit.hit('clave-acceso', uid, CODE_LIMIT);
    const result = await core.sendAccessCode({ db, whatsapp, condominioId, caller, data: request.data || {} });
    // En el registro del servidor: a quien y si salio; nunca la clave
    logger.warn('recordatorios: clave de acceso enviada', { condominioId, residentId: (request.data || {}).residentId, enviado: result.sent, por: uid });
    return result;
});

// Que paso de verdad con los mensajes de un envio (UltraMsg: entregado, en cola, rechazado...) y reenviar solo a los que no recibieron
const reconcileReminderCampaign = wrap('reconcileReminderCampaign', async (request) => {
    const { uid, condominioId } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios-entregas', uid, RECONCILE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas comprobaciones seguidas. Espere unos minutos.');
    }
    await rateLimit.hit('recordatorios-entregas', uid, RECONCILE_LIMIT);
    return core.reconcileCampaign({ db, whatsapp, condominioId, campaignId: (request.data || {}).campaignId });
});

const resendReminderCampaign = wrap('resendReminderCampaign', async (request) => {
    const { uid, condominioId, caller } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios', uid, CREATE_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Ya hizo varios envíos en la última hora. Espere un poco e intente de nuevo.');
    }
    const result = await core.resendCampaign({ db, whatsapp, condominioId, caller, data: request.data || {} });
    await rateLimit.hit('recordatorios', uid, CREATE_LIMIT);
    logger.warn('recordatorios: reenvio creado', { condominioId, campaignId: result.id, desde: (request.data || {}).campaignId, pendientes: result.pending, por: uid });
    return result;
});

// Si el WhatsApp del condominio esta conectado (y cuantos mensajes tiene UltraMsg en cola): OIKOS lo muestra al abrir Recordatorios
const checkWhatsAppConnection = wrap('checkWhatsAppConnection', async (request) => {
    const { uid } = await authorize(request);
    if (await rateLimit.isBlocked('recordatorios-estado', uid, STATUS_LIMIT)) {
        throw new HttpsError('resource-exhausted', 'Demasiadas revisiones seguidas. Espere unos minutos.');
    }
    await rateLimit.hit('recordatorios-estado', uid, STATUS_LIMIT);
    return core.connectionInfo({ whatsapp });
});

const processReminderQueue = onSchedule({ schedule: 'every 1 minutes', timeoutSeconds: 900 }, async () => {
    const results = await core.processQueue({ db, whatsapp });
    const worked = results.filter((r) => !r.busy);
    if (worked.length) logger.info('recordatorios: corrida', { envios: worked });
});

module.exports = { startReminderCampaign, controlReminderCampaign, sendReminderTest, sendReminderOne, sendAccessCode, checkWhatsAppConnection, reconcileReminderCampaign, resendReminderCampaign, processReminderQueue };
