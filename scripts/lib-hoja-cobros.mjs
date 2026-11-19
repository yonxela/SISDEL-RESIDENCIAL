// Carga de un condominio desde una HOJA DE COBROS (una fila por casa, una columna por mes con lo que pago). Se uso con
// Residenciales Delco II (hoja "AÑO 2026", 2026-11-19); no trae datos de contacto, solo casa, nombre y pagos.
//
// Funciones puras, sin base de datos ni archivos: las usa cargar-hoja-cobros.mjs y se prueban en test-hoja-cobros.mjs
// con datos inventados. Los datos reales (nombres) van en un archivo JSON FUERA del repositorio (el repo es publico).
//
// Reglas de la carga (decididas con el usuario el 2026-11-19: "subamos los datos que estan claros, lo demas se completa a mano"):
// - Cada casa es un vecino (id `<prefijo><casa>`, casa con lote) con su ficha; la ficha dice que se cobra desde el mes en curso.
// - Cada pago claro de un mes entra como DOS movimientos: la cuota de ese mes (cargo) y el pago, por el mismo monto, asi la
//   casa queda al dia en esos meses. No se inventan cuotas para los meses en blanco: no se sabe si se debian (cargarlas a
//   mano en OIKOS, "Cargar cuotas por mes", o con "Cuota del mes").
// - Un monto que no es la tarifa del mes (pago parcial, descuento, anotacion a mano) NO se carga: queda en la lista de dudas.
// - Un pago de un mes que todavia no llega (adelantado) entra solo como pago: queda como saldo a favor y cubre esa cuota
//   cuando se genere.
// - No llevan `importedFrom`: con ese campo la Tabla general daria por pagados los meses en blanco (ver sisdelInitialLoadAt).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SisdelCuotas = require('../finanzas/sisdel-cuotas.js');

export const MONTHS = ['EN', 'FEB', 'MZ', 'AB', 'MY', 'JN', 'JL', 'AG', 'SEP', 'OCT', 'NV', 'DC'];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clean = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
const periodOf = (year, month) => `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}`;
const noonGt = (day) => `${day}T18:00:00.000Z`;

// "LUIS RODAS CIFUENTES." -> "LUIS RODAS CIFUENTES" (una sigla como D.C. conserva su punto final)
export function cleanName(raw) {
    const name = clean(raw);
    return /\b[A-Z]\.[A-Z]\.$/.test(name) ? name : name.replace(/[.\-,;]+$/, '').trim();
}

// Revisa la forma del archivo de datos. Devuelve la lista de problemas (vacia si esta bien)
export function validateSheet(sheet) {
    const problems = [];
    if (!sheet || typeof sheet !== 'object') return ['el archivo no es un objeto JSON'];
    if (!clean(sheet.condominio)) problems.push('falta "condominio" (el nombre tal como esta en el sistema)');
    if (!Number.isInteger(sheet.anio)) problems.push('falta "anio"');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sheet.fechaHoja || ''))) problems.push('falta "fechaHoja" (AAAA-MM-DD: ningun pago se fecha despues)');
    if (!(Number(sheet.cuotaActual) > 0)) problems.push('falta "cuotaActual"');
    MONTHS.forEach((m) => { if (!(Number(sheet.tarifas && sheet.tarifas[m]) > 0)) problems.push(`falta la tarifa de ${m}`); });
    if (!Array.isArray(sheet.casas) || !sheet.casas.length) problems.push('no hay casas');
    const seen = new Set();
    (sheet.casas || []).forEach((c) => {
        const where = `casa ${c && c.casa}`;
        if (!c || !Number.isInteger(c.casa) || c.casa < 1) { problems.push(`${where}: numero de casa invalido`); return; }
        if (seen.has(c.casa)) problems.push(`${where}: repetida`);
        seen.add(c.casa);
        if (!cleanName(c.nombre)) problems.push(`${where}: sin nombre`);
        Object.entries(c.pagos || {}).forEach(([m, amount]) => {
            if (!MONTHS.includes(m)) problems.push(`${where}: mes desconocido ${m}`);
            else if (!(Number(amount) > 0)) problems.push(`${where}: monto invalido en ${m}`);
        });
    });
    return problems;
}

// options: { condoId, condoName, nowIso, currentPeriod ('AAAA-MM'), currency, source }
export function buildPlan(sheet, options) {
    const { condoId, nowIso, currentPeriod, currency = 'GTQ' } = options;
    const prefix = sheet.prefijoId || 'casa-';
    const source = options.source || sheet.fuente || 'hoja de cobros';
    const hojaDay = sheet.fechaHoja;
    const houses = [];
    const movements = [];
    const skippedCells = [];   // celdas que traen monto pero no se cargan (con el motivo)
    const excluded = {};       // mes -> suma de lo que no se carga (para cuadrar con los totales de la hoja)
    const addExcluded = (m, amount) => { excluded[m] = round2((excluded[m] || 0) + amount); };

    [...sheet.casas].sort((a, b) => a.casa - b.casa).forEach((c) => {
        const id = prefix + c.casa;
        const name = cleanName(c.nombre);
        let charges = 0;
        let payments = 0;
        let advance = 0;
        MONTHS.forEach((m) => {
            const amount = c.pagos && c.pagos[m];
            if (!amount) return;
            const tarifa = Number(sheet.tarifas[m]);
            if (round2(amount) !== round2(tarifa)) {
                skippedCells.push({ casa: c.casa, mes: m, monto: amount, motivo: `no es la tarifa del mes (${tarifa})` });
                addExcluded(m, amount);
                return;
            }
            const period = periodOf(sheet.anio, m);
            const base = { resiId: id, created_at: nowIso, updated_at: nowIso, serverGenerated: true, loadedFrom: source };
            // La cuota del mes (solo de un mes que ya llego; una pagada por adelantado queda como saldo a favor)
            if (period <= currentPeriod) {
                const breakdown = { maintenance: tarifa };
                movements.push({
                    ...base, id: `fee_${id}_${period}`, type: 'charge', kind: 'fee', manual: true, auto: false, period,
                    date: noonGt(`${period}-01`), amount: tarifa, concept: SisdelCuotas.describe(breakdown, currency, period), breakdown, retro: period < currentPeriod
                });
                charges++;
            } else advance++;
            // El pago: el 15 del mes de la cuota, o el dia de la hoja si ese dia todavia no habia llegado cuando se hizo la hoja
            const day = `${period}-15` <= hojaDay ? `${period}-15` : hojaDay;
            movements.push({
                ...base, id: `pago_${id}_${period}`, type: 'income', amount: tarifa, date: noonGt(day),
                concept: `Pago de mantenimiento correspondiente a ${SisdelCuotas.monthLabel(period) || period}${period > currentPeriod ? ' (adelantado)' : ''}`
            });
            payments++;
        });
        (c.dudas || []).forEach((d) => {
            // Lo que se anoto como duda en el archivo (anotaciones a mano, celdas marcadas...) y no esta en "pagos"
            if (!skippedCells.some((s) => s.casa === c.casa && s.mes === d.mes)) skippedCells.push({ casa: c.casa, mes: d.mes, monto: d.monto, motivo: d.motivo });
            if (d.monto && !(c.pagos && c.pagos[d.mes])) addExcluded(d.mes, Number(d.monto));
        });
        houses.push({
            id, casa: c.casa, name,
            user: {
                id, condominioId: condoId, name, role: 'vecino', casa: String(c.casa), phone: '', email: '',
                paymentStatus: 'al_dia', morosoSince: null, active: true, createdAt: nowIso, updatedAt: nowIso, loadedFrom: source
            },
            ficha: { id, feeFrom: currentPeriod, unitType: 'casa', createdAt: nowIso, updated_at: nowIso },
            check: { charges, payments, advance, paid: round2(movements.filter((t) => t.resiId === id && t.type === 'income').reduce((sum, t) => sum + t.amount, 0)), nota: clean(c.nota) }
        });
    });

    return { houses, movements, skippedCells, excluded };
}

// Lo que se carga por mes (pagos) comparado con los totales de la hoja: cargado + no cargado = total de la hoja
export function reconcile(sheet, plan) {
    const rows = [];
    MONTHS.forEach((m) => {
        const period = periodOf(sheet.anio, m);
        const loaded = round2(plan.movements.filter((t) => t.type === 'income' && t.id.endsWith('_' + period)).reduce((s, t) => s + t.amount, 0));
        const excluded = round2(plan.excluded[m] || 0);
        const total = sheet.totales && sheet.totales[m] != null ? Number(sheet.totales[m]) : null;
        rows.push({ mes: m, loaded, excluded, total, ok: total == null ? null : Math.abs(loaded + excluded - total) < 0.005 });
    });
    return { rows, ok: rows.every((r) => r.ok !== false), checked: rows.filter((r) => r.ok !== null).length };
}

// Codigo de acceso como los de SISDEL (inicial del condominio + inicial del nombre + 3 cifras): el mismo de La Perla
export { accessCodeFor } from './lib-carga-perla.mjs';
