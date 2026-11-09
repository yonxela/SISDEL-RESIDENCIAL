/* ═══════════════════════════════════════════════════════════════
   SISDEL - Desglose de la cuota mensual (Sistema Financiero)
   ───────────────────────────────────────────────────────────────
   La cuota mensual se compone de hasta cinco conceptos: mantenimiento, agua, recoleccion de basura,
   electricidad y otros. En Configuracion se escribe cuanto corresponde a cada uno (settings.feeBreakdown)
   y la cuota (settings.fee) es la suma. Al cobrar la cuota (automatica o manual) el movimiento queda en UNA
   sola linea cuya descripcion nombra solo los conceptos con monto, por ejemplo:

       Por aporte para mantenimiento y servicio de agua Q 500.00

   y guarda el desglose en movimiento.breakdown ({ maintenance: 400, water: 100 }).

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

    // La descripcion de la cuota; null si no hay ningun monto
    function describe(raw, currency) {
        const sum = total(raw);
        if (sum <= 0) return null;
        return `Por aporte para ${joinList(used(raw).map((p) => p.phrase))} ${money(sum, currency)}`;
    }
    // "Mantenimiento Q 400.00 · Agua Q 100.00" (para el detalle de un movimiento)
    function listParts(raw, currency) {
        return used(raw).map((p) => `${p.label} ${money(amountOf(raw[p.key]), currency)}`).join(' · ');
    }

    // Concepto y desglose de una cuota de `amount` segun la configuracion; null si no hay desglose o si el monto no coincide con
    // su suma (un cobro con un monto distinto al de la cuota conserva su concepto de siempre: "Cuota - Mes Año")
    function feeInfo(settings, amount) {
        const s = settings || {};
        const breakdown = normalize(s.feeBreakdown);
        const sum = total(breakdown);
        const fee = parseFloat(amount);
        if (sum <= 0 || !Number.isFinite(fee) || Math.abs(sum - fee) >= 0.005) return null;
        const parts = {};
        used(breakdown).forEach((p) => { parts[p.key] = breakdown[p.key]; });
        return { concept: describe(breakdown, s.currency), breakdown: parts };
    }

    return { PARTS, normalize, total, describe, listParts, feeInfo, money, joinList, symbolOf };
});
