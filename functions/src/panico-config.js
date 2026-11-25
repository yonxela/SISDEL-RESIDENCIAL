// Configuracion > Boton de panico (admin.html): mandar un mensaje de PRUEBA a los telefonos configurados (garita, PNC...), para
// comprobar que reciben los avisos antes de una emergencia. Lo pide quien tiene panico.configurar; solo a los telefonos guardados en
// condominios/{id}/panico_config/general (nunca a uno que mande el navegador), con un tope por usuario. El mensaje dice claramente
// que no es una emergencia.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { db } = require('./firebase');
const privilegios = require('./privilegios');
const rateLimit = require('./rateLimit');
const whatsapp = require('./rondas/whatsapp');
const { cleanConfig, testMessage } = require('./rondas/avisos');
const { testVars } = require('./rondas/panico-meta');

const TEST_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

const testPanicNotice = onCall({ timeoutSeconds: 120 }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesión requerida');
    const { uid, token } = request.auth;
    const condominioId = token.condominioId;
    if (!condominioId) throw new HttpsError('permission-denied', 'Sin permisos');
    const me = await db.doc(`condominios/${condominioId}/usuarios/${uid}`).get();
    const allowed = me.exists && me.data().active !== false && privilegios.has(me.data().role, me.data().privilegios, 'panico.configurar');
    if (!allowed) throw new HttpsError('permission-denied', 'Su usuario no puede configurar el botón de pánico.');
    if (await rateLimit.isBlocked('panico-prueba', uid, TEST_LIMIT)) throw new HttpsError('resource-exhausted', 'Ya envió varias pruebas seguidas. Espere unos minutos.');
    const condoRef = db.collection('condominios').doc(condominioId);
    const [condoSnap, cfgSnap] = await Promise.all([condoRef.get(), condoRef.collection('panico_config').doc('general').get()]);
    const cfg = cleanConfig(cfgSnap.exists ? cfgSnap.data() : null);
    if (!cfg.phones.length) throw new HttpsError('failed-precondition', 'No hay teléfonos guardados. Agregue el de la garita o la PNC y guarde antes de probar.');
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) throw new HttpsError('failed-precondition', 'WhatsApp todavía no está conectado al condominio. Pida al programador que lo conecte.');
    await rateLimit.hit('panico-prueba', uid, TEST_LIMIT);
    const condoName = condoSnap.exists ? String(condoSnap.data().name || '') : '';
    const text = testMessage(condoName, cfg);
    // Con el WhatsApp oficial de Meta (panicChannel 'meta') sale la plantilla de PRUEBA ("no es una emergencia"), sin caer a UltraMsg
    const vars = testVars(condoName);
    const results = [];
    for (const p of cfg.phones) {
        let channel = null;
        try { channel = await whatsapp.sendPanic(config, p.phone, text, { tipo: 'prueba', vars, errors: [], drill: true }); } catch (e) { channel = null; }
        results.push({ kind: p.kind, name: p.name, phoneTail: p.phone.slice(-4), sent: !!channel });
    }
    logger.warn('panico: mensaje de prueba', { condominioId, por: uid, enviados: results.filter((r) => r.sent).length, total: results.length });
    return { results };
});

module.exports = { testPanicNotice };
