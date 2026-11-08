// Disparadores de rondas y alertas de panico
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { db } = require('../firebase');
const { recipientsFor } = require('./avisos');
const whatsapp = require('./whatsapp');
const { cleanAll } = require('./mantenimiento');
const privilegios = require('../privilegios');

// Alerta de panico nueva: WhatsApp a la central, al personal del condominio y,
// si es un vecino, a sus contactos de emergencia. El resultado queda en la alerta.
const onPanicCreated = onDocumentCreated('condominios/{condoId}/alertas_panico/{alertId}', async (event) => {
    const alert = event.data && event.data.data();
    if (!alert) return;
    const condoRef = db.collection('condominios').doc(event.params.condoId);
    const config = await whatsapp.loadConfig();
    if (!whatsapp.hasProvider(config)) {
        await event.data.ref.update({ whatsapp: { sent: false, reason: 'WhatsApp sin configurar', at: new Date().toISOString() } });
        logger.warn('panico: WhatsApp sin configurar', { condoId: event.params.condoId, alertId: event.params.alertId });
        return;
    }

    const [condoSnap, contactsSnap, staffSnap] = await Promise.all([
        condoRef.get(),
        alert.source === 'vecino' ? condoRef.collection('emergencia').doc(String(alert.userId)).get() : Promise.resolve(null),
        condoRef.collection('usuarios').where('role', 'in', ['admin', 'supervisor', 'operador']).get()
    ]);
    // Se avisa al personal que puede atender alertas de panico (admin y supervisores por defecto; el administrador
    // del condominio puede quitarselo a uno o dárselo a un operador)
    const staff = staffSnap.docs.map((d) => d.data())
        .filter((u) => u.active !== false && u.phone && privilegios.has(u.role, u.privilegios, 'panico.atender'));
    const recipients = recipientsFor({
        alert,
        condoName: condoSnap.exists ? condoSnap.data().name : '',
        contacts: contactsSnap && contactsSnap.exists ? contactsSnap.data().contacts || [] : [],
        staff: staff.map((u) => ({ name: u.name, phone: u.phone })),
        central: config.central || ''
    });

    const results = [];
    for (const r of recipients) {
        const canal = await whatsapp.send(config, r.telefono, r.mensaje);
        results.push({ nombre: r.nombre, canal: canal || 'NINGUNO', exito: !!canal });
    }
    await event.data.ref.update({
        whatsapp: { sent: results.some((r) => r.exito), recipients: results, at: new Date().toISOString(), reason: recipients.length ? '' : 'Sin destinatarios' }
    });
    logger.info('panico: avisos enviados', { condoId: event.params.condoId, alertId: event.params.alertId, enviados: results.filter((r) => r.exito).length, total: results.length });
});

// Todos los dias a las 03:00: cierra turnos y rondas olvidados y borra posiciones de mas de 30 dias
const dailyRondas = onSchedule({ schedule: 'every day 03:00', timeZone: 'America/Guatemala', timeoutSeconds: 540 }, async () => {
    const results = await cleanAll();
    logger.info('rondas: limpieza diaria', { results });
});

module.exports = { onPanicCreated, dailyRondas };
