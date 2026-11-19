// Disparadores de la mora automatica (ver recalc.js)
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const { recalcCondo, recalcResident, recalcAll } = require('./recalc');
const { TIME_ZONE } = require('./mora');
const { SERVER_STAMP, needsStamp, onlyStampChanged } = require('./sello');

// Campos de la configuracion que cambian cuanto debe cada vecino (el desglose, el precio de la paja de agua
// y las reglas de mora tambien cambian la cuota de cada lote o su mora)
const FEE_SETTINGS = ['fee', 'chargeDay', 'graceDays', 'feeMode', 'feeBreakdown', 'waterUnitPrice', 'waterHalfPrice', 'moraRules'];
const sameValue = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Un cargo o pago nuevo, editado o anulado: se recalcula ese vecino al instante,
// asi la talanquera se abre en cuanto el vecino paga.
// Ademas le pone el sello del servidor (ver sello.js): con el, cada equipo pide solo lo que cambio.
const onFinanceMovement = onDocumentWritten('condominios/{condoId}/finanzas_movimientos/{txId}', async (event) => {
    const before = event.data && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after.exists ? event.data.after.data() : null;
    if (needsStamp(before, after)) {
        try {
            await event.data.after.ref.update({ [SERVER_STAMP]: FieldValue.serverTimestamp() });
        } catch (error) {
            // Si el movimiento ya no existe no hay nada que sellar; cualquier otra falla la repone la tarea diaria
            logger.warn('finanzas: no se pudo sellar el movimiento', { condoId: event.params.condoId, txId: event.params.txId, message: error.message });
        }
    }
    // El sello no cambia saldos ni cuotas
    if (onlyStampChanged(before, after)) return;
    // Las cuotas que crea el propio recalculo ya se tuvieron en cuenta
    if (!before && after && after.serverGenerated) return;
    const residentIds = new Set([before && before.resiId, after && after.resiId].filter(Boolean).map(String));
    for (const residentId of residentIds) {
        const result = await recalcResident(event.params.condoId, residentId);
        if (result) logger.info('finanzas: vecino recalculado', result);
    }
});

// Cambio de cuota, desglose, agua, dia de cobro, dias de gracia, mora o modo: se recalcula el condominio
const onFinanceSettings = onDocumentWritten('condominios/{condoId}/finanzas_config/{docId}', async (event) => {
    if (!event.data || !event.data.after.exists) return;
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.data();
    const relevant = !event.data.before.exists || FEE_SETTINGS.some((k) => !sameValue(before[k], after[k]));
    if (!relevant) return;
    logger.info('finanzas: configuracion cambiada', await recalcCondo(event.params.condoId));
});

// Todos los dias: cuotas del mes y vencimientos de la gracia
const dailyFinance = onSchedule({ schedule: 'every day 05:00', timeZone: TIME_ZONE, timeoutSeconds: 540 }, async () => {
    const results = await recalcAll();
    logger.info('finanzas: recalculo diario', { condominios: results.filter((r) => r.active).length, results });
});

module.exports = { onFinanceMovement, onFinanceSettings, dailyFinance };
