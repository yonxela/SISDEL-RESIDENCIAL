// Disparadores de la mora automatica (ver recalc.js)
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { recalcCondo, recalcResident, recalcAll } = require('./recalc');
const { TIME_ZONE } = require('./mora');

// Campos de la configuracion que cambian cuanto debe cada vecino
const FEE_SETTINGS = ['fee', 'chargeDay', 'graceDays', 'feeMode'];

// Un cargo o pago nuevo, editado o anulado: se recalcula ese vecino al instante,
// asi la talanquera se abre en cuanto el vecino paga.
const onFinanceMovement = onDocumentWritten('condominios/{condoId}/finanzas_movimientos/{txId}', async (event) => {
    const before = event.data && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after.exists ? event.data.after.data() : null;
    // Las cuotas que crea el propio recalculo ya se tuvieron en cuenta
    if (!before && after && after.serverGenerated) return;
    const residentIds = new Set([before && before.resiId, after && after.resiId].filter(Boolean).map(String));
    for (const residentId of residentIds) {
        const result = await recalcResident(event.params.condoId, residentId);
        if (result) logger.info('finanzas: vecino recalculado', result);
    }
});

// Cambio de cuota, dia de cobro, dias de gracia o modo: se recalcula el condominio
const onFinanceSettings = onDocumentWritten('condominios/{condoId}/finanzas_config/{docId}', async (event) => {
    if (!event.data || !event.data.after.exists) return;
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.data();
    const relevant = !event.data.before.exists || FEE_SETTINGS.some((k) => String(before[k]) !== String(after[k]));
    if (!relevant) return;
    logger.info('finanzas: configuracion cambiada', await recalcCondo(event.params.condoId));
});

// Todos los dias: cuotas del mes y vencimientos de la gracia
const dailyFinance = onSchedule({ schedule: 'every day 05:00', timeZone: TIME_ZONE, timeoutSeconds: 540 }, async () => {
    const results = await recalcAll();
    logger.info('finanzas: recalculo diario', { condominios: results.filter((r) => r.active).length, results });
});

module.exports = { onFinanceMovement, onFinanceSettings, dailyFinance };
