// Disparadores de rondas y alertas de panico
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');
const { recipientsFor, cleanConfig, isDrill } = require('./avisos');
const { personalDrillLimit, drillSlot } = require('./pruebas-tope');
const whatsapp = require('./whatsapp');
const { panicVars } = require('./panico-meta');
const { cleanAll } = require('./mantenimiento');
const privilegios = require('../privilegios');
const { notifyHousehold } = require('../panico-qr');

// Dia de Guatemala (UTC-6) de una fecha ISO
const gtDay = (iso) => {
    const t = Date.parse(iso || '');
    return new Date((Number.isFinite(t) ? t : Date.now()) - 6 * 3600000).toISOString().slice(0, 10);
};
// SIMULACRO (pedido del usuario el 2026-11-23): toma un lugar del tope del dia (por condominio y por vecino) en
// condominios/{c}/panico_simulacros/{AAAA-MM-DD} (solo el servidor; las reglas no lo dejan leer ni escribir). { ok } o { ok: false, reason }
async function takeDrillSlot(condoRef, alert) {
    const ref = condoRef.collection('panico_simulacros').doc(gtDay(alert.createdAt));
    const cfgRef = condoRef.collection('panico_config').doc('pruebas');
    const userId = String(alert.userId || 'sin-usuario');
    return db.runTransaction(async (tx) => {
        const [snap, cfgSnap] = await Promise.all([tx.get(ref), tx.get(cfgRef)]);
        const day = snap.exists ? snap.data() : {};
        const slot = drillSlot(day, userId, personalDrillLimit(cfgSnap.exists ? cfgSnap.data() : null, userId));
        if (!slot.ok) return { ok: false, reason: slot.reason };
        tx.set(ref, { ...slot.next, updatedAt: new Date().toISOString() }, { merge: true });
        return { ok: true };
    });
}

// Alerta de panico nueva: WhatsApp a la central, a los telefonos que configuro el condominio (garita, PNC...), al personal del
// condominio y, si es un vecino, a sus contactos de emergencia. El resultado queda en la alerta. Los textos y los telefonos salen de
// condominios/{id}/panico_config/general (Configuracion > Boton de panico de admin.html); sin configurar, los de siempre.
const onPanicCreated = onDocumentCreated('condominios/{condoId}/alertas_panico/{alertId}', async (event) => {
    const alert = event.data && event.data.data();
    if (!alert) return;
    const condoRef = db.collection('condominios').doc(event.params.condoId);
    // Primero, sin esperar al WhatsApp: el aviso al celular a los OTROS telefonos de la casa que lo activaron (panico.html; no en un
    // simulacro). Va aparte del WhatsApp: sale aunque WhatsApp no este configurado. Queda anotado en la alerta (push)
    const pushing = notifyHousehold(event.params.condoId, event.params.alertId, alert)
        .catch((e) => { logger.error('panico: aviso a la casa', { error: e.message }); return { sent: 0, failed: 0, error: true }; });
    const savePush = async () => {
        const r = await pushing;
        if (r.sent || r.failed || r.error) await event.data.ref.update({ push: { ...r, at: new Date().toISOString() } }).catch(() => {});
    };
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        await event.data.ref.update({ whatsapp: { sent: false, reason: 'WhatsApp sin configurar', at: new Date().toISOString() } });
        logger.warn('panico: WhatsApp sin configurar', { condoId: event.params.condoId, alertId: event.params.alertId });
        await savePush();
        return;
    }
    // Un simulacro solo avisa a la central, las garitas y el propio vecino (avisos.js), y como mucho DRILL_LIMITS por dia: pasado
    // el tope la prueba igual se ve en la pantalla de la garita, sin WhatsApp
    if (isDrill(alert)) {
        const slot = await takeDrillSlot(condoRef, alert);
        if (!slot.ok) {
            await event.data.ref.update({ whatsapp: { sent: false, simulacro: true, reason: slot.reason, at: new Date().toISOString() } });
            logger.info('panico: simulacro sin WhatsApp (tope del dia)', { condoId: event.params.condoId, alertId: event.params.alertId });
            await savePush();
            return;
        }
    }

    const [condoSnap, contactsSnap, staffSnap, panicCfgSnap] = await Promise.all([
        condoRef.get(),
        alert.source === 'vecino' ? condoRef.collection('emergencia').doc(String(alert.userId)).get() : Promise.resolve(null),
        condoRef.collection('usuarios').where('role', 'in', ['admin', 'supervisor', 'operador']).get(),
        condoRef.collection('panico_config').doc('general').get().catch(() => null)
    ]);
    const panicConfig = cleanConfig(panicCfgSnap && panicCfgSnap.exists ? panicCfgSnap.data() : null);
    // Se avisa al personal que puede atender alertas de panico (admin y supervisores por defecto; el administrador
    // del condominio puede quitarselo a uno o dárselo a un operador)
    const staff = staffSnap.docs.map((d) => d.data())
        .filter((u) => u.active !== false && u.phone && privilegios.has(u.role, u.privilegios, 'panico.atender'));
    const recipients = recipientsFor({
        alert,
        condoName: condoSnap.exists ? condoSnap.data().name : '',
        contacts: contactsSnap && contactsSnap.exists ? contactsSnap.data().contacts || [] : [],
        staff: staff.map((u) => ({ name: u.name, phone: u.phone })),
        central: config.central || '',
        config: panicConfig
    });

    // Con el WhatsApp oficial de Meta (config.panicChannel === 'meta', panico-meta.js) cada aviso sale con su plantilla aprobada y
    // estos datos en los huecos; si no, el texto de siempre por UltraMsg
    const vars = panicVars({ alert, condoName: condoSnap.exists ? condoSnap.data().name : '', garitaPhone: (panicConfig.phones.find((p) => p.kind === 'garita') || {}).phone });
    const results = [];
    for (const r of recipients) {
        const errors = [];
        let canal = null;
        try { canal = await whatsapp.sendPanic(config, r.telefono, r.mensaje, { tipo: r.tipo, vars, errors, drill: isDrill(alert) }); } catch (e) { errors.push(e.message || 'error'); }
        results.push({ nombre: r.nombre, canal: canal || 'NINGUNO', exito: !!canal, ...(errors.length ? { error: errors.join(' | ').slice(0, 300) } : {}) });
    }
    // El motivo de cada aviso que no salio queda en su destinatario (error); `reason` no cambia (lo ve el vecino en la prueba)
    await event.data.ref.update({
        whatsapp: {
            sent: results.some((r) => r.exito), recipients: results, at: new Date().toISOString(), reason: recipients.length ? '' : 'Sin destinatarios',
            ...(isDrill(alert) ? { simulacro: true } : {})
        }
    });
    logger.info(isDrill(alert) ? 'panico: simulacro, avisos enviados' : 'panico: avisos enviados', { condoId: event.params.condoId, alertId: event.params.alertId, enviados: results.filter((r) => r.exito).length, total: results.length });
    await savePush();
});

// Todos los dias a las 03:00: cierra turnos y rondas olvidados y borra posiciones de mas de 30 dias
const dailyRondas = onSchedule({ schedule: 'every day 03:00', timeZone: 'America/Guatemala', timeoutSeconds: 540 }, async () => {
    const results = await cleanAll();
    logger.info('rondas: limpieza diaria', { results });
});

module.exports = { onPanicCreated, dailyRondas };
