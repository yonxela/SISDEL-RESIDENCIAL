/* ═══════════════════════════════════════════════════════════════
   SISDEL - Desglose de la cuota mensual (Sistema Financiero)
   ───────────────────────────────────────────────────────────────
   La cuota mensual se compone de hasta cinco conceptos: mantenimiento, agua, recoleccion de basura,
   electricidad y otros. En Configuracion se escribe cuanto corresponde a cada uno (settings.feeBreakdown)
   y la cuota (settings.fee) es la suma. Al cobrar la cuota (automatica o manual) el movimiento queda en UNA
   sola linea cuya descripcion nombra solo los conceptos con monto y el mes que se cobra, por ejemplo:

       Por aporte para mantenimiento y servicio de agua correspondiente a octubre de 2026 Q 500.00

   y guarda el desglose en movimiento.breakdown ({ maintenance: 400, water: 100 }). El mes sale del periodo
   de la cuota (movimiento.period, AAAA-MM), no de la fecha en que se registra: una cuota de octubre cobrada
   en noviembre dice octubre.

   Agua por lote: si el condominio cobra el agua por paja (settings.waterUnitPrice), la cuota de cada lote es la
   del condominio mas su agua (residentFee y residentFeeInfo, al final del archivo).

   Lo carga OIKOS (finanzas/index.html) en el navegador y lo usa el servidor al generar las cuotas del dia
   (functions/src/finanzas/mora.js). functions/src/finanzas/cuotas.js es una COPIA IDENTICA de este archivo
   (la prueba scripts/test-finanzas-cuotas.mjs falla si difieren): al cambiar uno, copiarlo al otro.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.SisdelCuotas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // key: nombre en el desglose; label: como se ve en la pantalla; phrase: como se nombra en la descripcion
    const PARTS = [
        { key: 'maintenance', label: 'Mantenimiento', phrase: 'mantenimiento' },
        { key: 'water', label: 'Agua', phrase: 'servicio de agua' },
        { key: 'garbage', label: 'Recolección de basura', phrase: 'recolección de basura' },
        { key: 'electricity', label: 'Electricidad', phrase: 'servicio de electricidad' },
        { key: 'other', label: 'Otros', phrase: 'otros conceptos' }
    ];
    const SYMBOLS = { GTQ: 'Q', USD: '$', MXN: '$', EUR: '€' };
    const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    // Un monto valido es un numero mayor que cero; lo demas (vacio, texto, negativo) cuenta como cero
    function amountOf(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) && n > 0 ? round2(n) : 0;
    }

    // Desglose limpio: siempre las cinco claves, con 0 donde no hay monto
    function normalize(raw) {
        const out = {};
        PARTS.forEach((p) => { out[p.key] = amountOf(raw && raw[p.key]); });
        return out;
    }
    function total(raw) {
        return round2(PARTS.reduce((sum, p) => sum + amountOf(raw && raw[p.key]), 0));
    }
    // Conceptos con monto, en el orden de siempre
    function used(raw) {
        return PARTS.filter((p) => amountOf(raw && raw[p.key]) > 0);
    }

    // "a", "a y b", "a, b y c"
    function joinList(items) {
        if (items.length <= 1) return items.join('');
        return items.slice(0, -1).join(', ') + ' y ' + items[items.length - 1];
    }
    function symbolOf(currency) {
        const code = String(currency || '').toUpperCase();
        return SYMBOLS[code] || code || 'Q';
    }
    // Q 1,250.00
    function money(amount, currency) {
        const [integer, decimals] = round2(amount).toFixed(2).split('.');
        return `${symbolOf(currency)} ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`;
    }

    // "octubre de 2026" para el periodo "2026-10"; null si el periodo no es valido
    function monthLabel(period) {
        const mt = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
        if (!mt) return null;
        const month = parseInt(mt[2], 10);
        return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} de ${mt[1]}` : null;
    }

    // La descripcion de la cuota; null si no hay ningun monto. Con periodo (AAAA-MM) dice a que mes corresponde.
    function describe(raw, currency, period) {
        const sum = total(raw);
        if (sum <= 0) return null;
        const month = monthLabel(period);
        return `Por aporte para ${joinList(used(raw).map((p) => p.phrase))}${month ? ` correspondiente a ${month}` : ''} ${money(sum, currency)}`;
    }
    // "Mantenimiento Q 400.00 · Agua Q 100.00" (para el detalle de un movimiento)
    function listParts(raw, currency) {
        return used(raw).map((p) => `${p.label} ${money(amountOf(raw[p.key]), currency)}`).join(' · ');
    }

    // Concepto y desglose de la cuota del periodo `period` (AAAA-MM) por `amount` segun la configuracion; null si no hay desglose
    // o si el monto no coincide con su suma (un cobro con un monto distinto al de la cuota conserva su concepto de siempre:
    // "Cuota - Mes Año")
    function feeInfo(settings, amount, period) {
        const s = settings || {};
        const breakdown = normalize(s.feeBreakdown);
        const sum = total(breakdown);
        const fee = parseFloat(amount);
        if (sum <= 0 || !Number.isFinite(fee) || Math.abs(sum - fee) >= 0.005) return null;
        const parts = {};
        used(breakdown).forEach((p) => { parts[p.key] = breakdown[p.key]; });
        return { concept: describe(breakdown, s.currency, period), breakdown: parts };
    }

    // ── Agua por lote ──
    // En un condominio que cobra el agua por "paja de agua", el precio de la paja se guarda en la configuracion
    // (settings.waterUnitPrice) y cada lote guarda cuanta tiene (residente.waterUnits): 0 = sin casa, no paga agua;
    // 0.5 = media paja; 1 = una paja. La cuota de un lote es la cuota del condominio (settings.fee) mas su agua.
    // Sin precio de la paja nada cambia: todos pagan la misma cuota.
    const WATER_UNITS = [0, 0.5, 1];
    function waterUnits(resident) {
        const n = parseFloat(resident && resident.waterUnits);
        return WATER_UNITS.includes(n) ? n : 0;
    }
    // Lo que paga de agua el lote cada mes
    function waterOf(settings, resident) {
        return round2(waterUnits(resident) * amountOf(settings && settings.waterUnitPrice));
    }
    // La cuota mensual de un residente; 0 si el condominio no cobra cuota
    function residentFee(settings, resident) {
        const base = amountOf(settings && settings.fee);
        return base > 0 ? round2(base + waterOf(settings, resident)) : 0;
    }
    // Concepto y desglose de la cuota de un residente (el agua de su lote se suma al concepto "agua" del desglose);
    // null en los mismos casos que feeInfo
    function residentFeeInfo(settings, resident, amount, period) {
        const s = settings || {};
        const water = waterOf(s, resident);
        const breakdown = normalize(s.feeBreakdown);
        if (water <= 0 || total(breakdown) <= 0) return feeInfo(s, amount, period);
        breakdown.water = round2(breakdown.water + water);
        return feeInfo({ ...s, feeBreakdown: breakdown }, amount, period);
    }

    return {
        PARTS, normalize, total, describe, listParts, feeInfo, money, joinList, symbolOf, monthLabel,
        WATER_UNITS, waterUnits, waterOf, residentFee, residentFeeInfo
    };
});
