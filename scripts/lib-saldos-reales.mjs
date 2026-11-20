// Reemplazo de los saldos de un condominio con una hoja de "saldos reales" (La Perla, 2026-11-20: "la base de datos que se
// subio tiene muchos errores; subela completa reemplazando la que ya esta... que en el sistema quede igual que la hoja").
// Logica pura (sin base de datos): la usa reemplazar-saldos.mjs y la prueba test-saldos-reales.mjs con datos inventados.
//
// La hoja (un libro de Excel) trae, entre otras:
//   - "Para subir al sistema": una fila por lote: Lote, Propietario, Casa o lote, Cuotas pendientes, Mora, Total adeudado,
//     Saldo a favor, Pagos por aclarar, Observacion. Ultima fila: Total.
//   - "Detalle por cuota": una fila por cuota pendiente: Lote, Propietario, Concepto (Mantenimiento o Agua), Vencimiento
//     (fecha de Excel), Pendiente, Dias de atraso, Mora al corte, Origen.
//   - "Cuadre por lote": Lote, ..., "Cuotas sept. y oct." (columna 5): lo que se le cobro en esos dos meses dice su agua
//     (2 x 300 = sin agua, 2 x 380 = media paja, 2 x 460 = una paja).
//
// Lo que se hace (decidido con el usuario el 2026-11-20, "Si, lo recomendado"):
//   - Cada cuota pendiente entra como una cuota de su mes (mantenimiento y agua juntos, con su desglose) por lo que falta
//     pagar, con la mora que la hoja le calculo al corte (moraOpening / moraOpeningAt): desde ahi sigue la regla del
//     sistema (3 % el dia 6). Las cuotas con la mora exonerada (mora 0 con dias de atraso) llevan moraExempt.
//   - El saldo a favor entra como un pago del residente al corte, marcado openingCredit: no es dinero de la caja.
//   - "Pagos por aclarar" y la mora de cuotas ya pagadas NO se cargan (como en la hoja).
//   - Todo lo de la carga anterior (importedFrom distinto) se ANULA con su motivo (nada se borra).
//   - Todos cobran desde el mes en curso (feeFrom): la cuota de este mes la tiene que tener cada lote (se crea la que falte
//     o la que cambia por el agua) y una cuota de un mes que viene que se anula se repone (el servidor no repone una cuota
//     de un mes que ya tiene una anulada).
//   - Fase = las letras del lote (A, B, BA, C, D, F); tipo Casa o lote de la hoja; agua de lo cobrado en sept. y oct.;
//     la observacion de la hoja va a las notas de la ficha (sin borrar lo que tenga).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Cuotas = require('../finanzas/sisdel-cuotas.js');
const Mora = require('../finanzas/sisdel-mora.js');
const Server = require('../functions/src/finanzas/mora.js');   // quien es moroso para la garita (la misma funcion del servidor)

export const SHEETS = { lots: 'Para subir al sistema', detail: 'Detalle por cuota', cuadre: 'Cuadre por lote' };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const cents = (n) => Math.round((Number(n) || 0) * 100);
export const fromCents = (c) => Math.round(c) / 100;
const money = (n) => 'Q ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const raw = (cell) => (cell === undefined || cell === null ? null : (Array.isArray(cell) ? cell[0] : (typeof cell === 'object' && 'v' in cell ? cell.v : cell)));
const text = (cell) => { const v = raw(cell); return v === null || v === undefined ? '' : String(v).trim(); };
const number = (cell) => { const n = parseFloat(String(raw(cell) ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Fecha de Excel (numero de serie) -> 'AAAA-MM-DD'
export function excelDay(serial) {
    const n = Math.floor(Number(serial));
    if (!Number.isFinite(n) || n < 1) return null;
    return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}
export const sectorOf = (lot) => (String(lot).match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
export const monthLong = (period) => `${MONTHS[Number(period.slice(5, 7)) - 1]} de ${period.slice(0, 4)}`;
const lastDayIso = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0, 18)).toISOString(); };
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

// Las filas de una hoja como [{ r, c: { '0': valor, ... } }] (lo que da lib-xlsx: rows con cells)
function rowsOf(sheet) {
    return (sheet.rows || []).map((row) => ({ r: row.r, c: Object.fromEntries(Object.entries(row.cells || row.c || {}).map(([k, v]) => [k, v])) }));
}

// Lee el libro (resultado de readXlsx). Devuelve { lots, detail, totals, problems }
export function readSaldosWorkbook(wb) {
    const problems = [];
    const byName = new Map((wb.sheets || []).map((s) => [norm(s.name), s]));
    const sheet = (name) => byName.get(norm(name));
    const lotsSheet = sheet(SHEETS.lots);
    const detailSheet = sheet(SHEETS.detail);
    const cuadreSheet = sheet(SHEETS.cuadre);
    if (!lotsSheet || !detailSheet || !cuadreSheet) {
        problems.push(`El libro debe traer las hojas "${SHEETS.lots}", "${SHEETS.detail}" y "${SHEETS.cuadre}".`);
        return { lots: new Map(), detail: [], totals: null, problems };
    }
    // Encabezados esperados (asi un libro con otras columnas no se carga mal)
    const expect = (rows, cols, sheetName) => {
        const head = rows[0] ? rows[0].c : {};
        cols.forEach(([i, word]) => { if (!norm(text(head[i])).includes(word)) problems.push(`"${sheetName}": la columna ${i + 1} deberia decir "${word}" y dice "${text(head[i])}".`); });
    };
    const L = rowsOf(lotsSheet);
    const D = rowsOf(detailSheet);
    const C = rowsOf(cuadreSheet);
    expect(L, [[0, 'lote'], [2, 'casa o lote'], [3, 'cuotas pendientes'], [4, 'mora'], [5, 'total'], [6, 'saldo a favor'], [7, 'por aclarar'], [8, 'observ']], SHEETS.lots);
    expect(D, [[0, 'lote'], [2, 'concepto'], [3, 'vencimiento'], [4, 'pendiente'], [5, 'dias'], [6, 'mora']], SHEETS.detail);
    expect(C, [[0, 'lote'], [4, 'sept']], SHEETS.cuadre);
    if (problems.length) return { lots: new Map(), detail: [], totals: null, problems };

    const lots = new Map();
    let totals = null;
    L.slice(1).forEach((row) => {
        const lot = text(row.c['0']).toUpperCase();
        if (!lot) return;
        const vals = { pend: number(row.c['3']), mora: number(row.c['4']), total: number(row.c['5']), favor: number(row.c['6']), aclarar: number(row.c['7']) };
        if (norm(lot) === 'total') { totals = vals; return; }
        if (lots.has(lot)) problems.push(`"${SHEETS.lots}": el lote ${lot} esta repetido.`);
        const tipo = norm(text(row.c['2']));
        if (tipo !== 'casa' && tipo !== 'lote') problems.push(`"${SHEETS.lots}": el lote ${lot} no dice Casa o Lote.`);
        if (cents(vals.pend) + cents(vals.mora) !== cents(vals.total)) problems.push(`"${SHEETS.lots}": en ${lot} cuotas + mora no da el total.`);
        lots.set(lot, { lot, name: text(row.c['1']), type: tipo === 'casa' ? 'casa' : 'lote', ...vals, obs: text(row.c['8']), sepOct: null });
    });
    C.slice(1).forEach((row) => {
        const lot = text(row.c['0']).toUpperCase();
        if (lots.has(lot)) lots.get(lot).sepOct = number(row.c['4']);
    });
    const detail = [];
    D.slice(1).forEach((row) => {
        const lot = text(row.c['0']).toUpperCase();
        if (!lot) return;
        const due = excelDay(raw(row.c['3']));
        const concept = norm(text(row.c['2']));
        const item = { lot, concept: concept.startsWith('agua') ? 'water' : concept.startsWith('mant') ? 'maintenance' : null, due, pend: number(row.c['4']), days: number(row.c['5']), mora: number(row.c['6']), origin: text(row.c['7']) };
        if (!lots.has(lot)) problems.push(`"${SHEETS.detail}": el lote ${lot} no esta en "${SHEETS.lots}".`);
        if (!item.concept) problems.push(`"${SHEETS.detail}": ${lot} trae un concepto que no es Mantenimiento ni Agua ("${text(row.c['2'])}").`);
        if (!due) problems.push(`"${SHEETS.detail}": ${lot} trae una cuota sin fecha de vencimiento.`);
        if (!(item.pend > 0)) problems.push(`"${SHEETS.detail}": ${lot} trae una cuota sin monto pendiente.`);
        detail.push(item);
    });
    // Cuadres: el detalle de cada lote suma lo de "Para subir" y las sumas dan la fila de Total
    const byLot = new Map();
    detail.forEach((d) => { const x = byLot.get(d.lot) || { pend: 0, mora: 0 }; x.pend += cents(d.pend); x.mora += cents(d.mora); byLot.set(d.lot, x); });
    lots.forEach((l) => {
        const x = byLot.get(l.lot) || { pend: 0, mora: 0 };
        if (x.pend !== cents(l.pend) || x.mora !== cents(l.mora)) problems.push(`El detalle de ${l.lot} (cuotas ${money(fromCents(x.pend))}, mora ${money(fromCents(x.mora))}) no da lo de "${SHEETS.lots}" (${money(l.pend)}, ${money(l.mora)}).`);
        if (l.sepOct === null) problems.push(`"${SHEETS.cuadre}" no trae el lote ${l.lot}.`);
    });
    if (!totals) problems.push(`"${SHEETS.lots}" no trae la fila de Total.`);
    else {
        const sum = (k) => [...lots.values()].reduce((a, l) => a + cents(l[k]), 0);
        ['pend', 'mora', 'total', 'favor', 'aclarar'].forEach((k) => { if (sum(k) !== cents(totals[k])) problems.push(`"${SHEETS.lots}": la suma de ${k} (${money(fromCents(sum(k)))}) no da la fila de Total (${money(totals[k])}).`); });
    }
    return { lots, detail, totals, problems };
}

// Agua por lo cobrado en septiembre y octubre (dos cuotas): 0, 0.5 o 1; null si no es ninguna
export function waterFromSepOct(amount, settings) {
    const base = cents(Cuotas.residentFee(settings, { waterUnits: 0 }));
    const prices = Cuotas.waterPrices(settings);
    const c = cents(amount);
    if (c === 2 * base) return 0;
    if (c === 2 * (base + cents(prices.half))) return 0.5;
    if (c === 2 * (base + cents(prices.full))) return 1;
    return null;
}

// Arma el reemplazo. opts: { sheet (readSaldosWorkbook), existing: { users, fichas, movements } (documentos con su id),
// settings (finanzas_config/oikos_settings), prefix ('perla-'), cut ('AAAA-MM-DD'), source (texto), nowIso, currentPeriod ('AAAA-MM') }
// Devuelve { creates, annuls, fichas, users, problems, stats }. Lo que ya esta hecho (una carga a medias) no se repite:
// un documento nuevo que ya existe no se vuelve a crear y uno ya anulado no se vuelve a anular.
export function buildReplacement(opts) {
    const { sheet, existing, settings, prefix, cut, source, nowIso, currentPeriod } = opts;
    const problems = [];
    const users = new Map((existing.users || []).map((u) => [String(u.id), u]));
    const fichas = new Map((existing.fichas || []).map((f) => [String(f.id), f]));
    const movements = existing.movements || [];
    const ids = new Set(movements.map((m) => String(m.id)));
    const live = movements.filter((m) => m && !m.deleted);
    const reason = `Reemplazado por la carga de ${source}`;
    const creates = [];
    const annuls = [];
    const fichaUpdates = [];
    const userUpdates = [];
    const residentId = (lot) => `${prefix}${lot}`;
    const freeId = (base) => { if (!ids.has(base)) { ids.add(base); return base; } for (let n = 1; ; n++) { const id = `${base}_r${n}`; if (!ids.has(id)) { ids.add(id); return id; } } };
    const exists = (id) => movements.some((m) => String(m.id) === id);
    const cutIso = `${cut}T18:00:00.000Z`;
    const stats = { lots: 0, cuotas: 0, cuotasAmount: 0, mora: 0, exempt: 0, credits: 0, creditAmount: 0, annulled: 0, annulledAmount: 0, newFees: 0, newFeesAmount: 0, fases: 0, types: 0, waters: 0, notes: 0, skippedExisting: 0 };

    // Lo de la carga anterior: todo lo vivo que vino de otra carga (importedFrom distinto de esta)
    const oldByResident = new Map();
    live.forEach((m) => {
        if (!m.importedFrom || m.importedFrom === source) return;
        const id = String(m.resiId || '');
        if (!oldByResident.has(id)) oldByResident.set(id, []);
        oldByResident.get(id).push(m);
    });

    // Detalle por lote, mes y si la mora esta exonerada
    const groups = new Map();
    sheet.detail.forEach((d) => {
        const period = d.due.slice(0, 7);
        const exempt = d.mora === 0 && d.days > 0;
        const key = `${d.lot}|${period}|${exempt ? 'x' : ''}`;
        const g = groups.get(key) || { lot: d.lot, period, exempt, maintenance: 0, water: 0, mora: 0 };
        g[d.concept] += cents(d.pend);
        g.mora += cents(d.mora);
        groups.set(key, g);
    });

    const lotsInOrder = [...sheet.lots.keys()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    lotsInOrder.forEach((lot) => {
        const l = sheet.lots.get(lot);
        const id = residentId(lot);
        const user = users.get(id);
        if (!user) { problems.push(`El lote ${lot} no tiene vecino en el sistema (${id}): esta carga no crea vecinos.`); return; }
        stats.lots++;
        const water = waterFromSepOct(l.sepOct, settings);
        if (water === null) problems.push(`No se sabe el agua de ${lot}: en septiembre y octubre se le cobro ${money(l.sepOct)}.`);
        const ficha = fichas.get(id) || { id };
        const resident = { ...ficha, waterUnits: water === null ? ficha.waterUnits : water };
        const lotCreates = [];

        // Cuotas pendientes con su mora al corte
        [...groups.values()].filter((g) => g.lot === lot).sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.exempt - b.exempt)).forEach((g) => {
            const amount = g.maintenance + g.water;
            const docId = `sr_${id}_${g.period}${g.exempt ? '_exo' : ''}`;
            const breakdown = {};
            if (g.maintenance) breakdown.maintenance = fromCents(g.maintenance);
            if (g.water) breakdown.water = fromCents(g.water);
            const parts = [g.maintenance ? `mantenimiento ${money(fromCents(g.maintenance))}` : '', g.water ? `agua ${money(fromCents(g.water))}` : ''].filter(Boolean).join(' y ');
            stats.cuotas++; stats.cuotasAmount += amount; stats.mora += g.mora; if (g.exempt) stats.exempt++;
            if (exists(docId)) { stats.skippedExisting++; return; }
            ids.add(docId);
            lotCreates.push({
                id: docId, type: 'charge', kind: 'fee', period: g.period, amount: fromCents(amount), resiId: id, date: lastDayIso(g.period),
                concept: `Cuota de ${monthLong(g.period)} pendiente al ${cut.split('-').reverse().join('/')}: ${parts}`,
                breakdown, moraOpening: fromCents(g.mora), moraOpeningAt: cut, ...(g.exempt ? { moraExempt: true } : {}),
                manual: true, auto: false, retro: true, importedFrom: source, created_at: nowIso, updated_at: nowIso
            });
        });

        // Saldo a favor: un pago al corte que no es dinero de la caja
        if (cents(l.favor) > 0) {
            const docId = `sf_${id}`;
            stats.credits++; stats.creditAmount += cents(l.favor);
            if (exists(docId)) stats.skippedExisting++;
            else {
                ids.add(docId);
                lotCreates.push({
                    id: docId, type: 'income', amount: fromCents(cents(l.favor)), resiId: id, date: cutIso,
                    concept: `Saldo a favor al ${cut.split('-').reverse().join('/')} (anticipos y pagos adelantados, ${source})`,
                    openingCredit: true, importedFrom: source, created_at: nowIso, updated_at: nowIso
                });
            }
        }

        // Lo de la carga anterior se anula; la cuota de este mes y de los que vienen se revisa
        const old = oldByResident.get(id) || [];
        old.forEach((m) => annuls.push({ id: String(m.id), resiId: id, amount: m.amount, reason }));
        stats.annulled += old.length; stats.annulledAmount += old.reduce((a, m) => a + cents(m.amount), 0);
        const annulledIds = new Set(old.map((m) => String(m.id)));
        const feeNow = Cuotas.residentFee(settings, resident);
        const feePeriods = new Set([currentPeriod]);
        old.forEach((m) => { const p = Mora.feePeriod(m); if (p && p > currentPeriod) feePeriods.add(p); });
        [...feePeriods].sort().forEach((period) => {
            const liveFees = live.filter((m) => String(m.resiId) === id && Mora.feePeriod(m) === period && !annulledIds.has(String(m.id)) && m.importedFrom !== source);
            const ok = liveFees.filter((m) => cents(m.amount) === cents(feeNow));
            liveFees.filter((m) => cents(m.amount) !== cents(feeNow)).forEach((m) => { annuls.push({ id: String(m.id), resiId: id, amount: m.amount, reason: `${reason}: la cuota del lote es ${money(feeNow)}` }); stats.annulled++; stats.annulledAmount += cents(m.amount); });
            const already = movements.some((m) => !m.deleted && String(m.resiId) === id && Mora.feePeriod(m) === period && m.importedFrom === source);
            if (ok.length || already) return;
            const info = Cuotas.residentFeeInfo(settings, resident, feeNow, period);
            const [y, mo] = period.split('-').map(Number);
            const docId = freeId(`fee_${id}_${period}`);
            stats.newFees++; stats.newFeesAmount += cents(feeNow);
            lotCreates.push({
                id: docId, type: 'charge', kind: 'fee', period, amount: feeNow, resiId: id, date: new Date(Date.UTC(y, mo - 1, Math.min(28, Math.max(1, parseInt(settings.chargeDay, 10) || 1)), 12)).toISOString(),
                concept: info ? info.concept : `Cuota - ${monthLong(period)}`, ...(info && info.breakdown ? { breakdown: info.breakdown } : {}),
                auto: true, importedFrom: source, created_at: nowIso, updated_at: nowIso
            });
        });

        // Todos llevan serverGenerated (el servidor no recalcula uno por uno) salvo el ultimo de un lote que no anula nada:
        // ese dispara el recalculo de su vecino (las anulaciones ya lo disparan)
        const annulsHere = annuls.some((a) => a.resiId === id);
        lotCreates.forEach((t, i) => { if (annulsHere || i < lotCreates.length - 1) t.serverGenerated = true; });
        creates.push(...lotCreates);

        // Ficha: cobra desde este mes, tipo, agua y la observacion en sus notas (sin borrar lo que ya tenga)
        const fichaData = {};
        if (ficha.feeFrom !== currentPeriod) fichaData.feeFrom = currentPeriod;
        if (ficha.unitType !== l.type) { fichaData.unitType = l.type; stats.types++; }
        if (water !== null && (ficha.waterUnits || 0) !== water) { fichaData.waterUnits = water; stats.waters++; }
        if (l.obs) {
            const notes = String(ficha.notes || '');
            const line = `Hoja de ${source}: ${l.obs}`;
            if (!notes.includes(line)) { fichaData.notes = notes ? `${notes}\n${line}` : line; stats.notes++; }
        }
        if (Object.keys(fichaData).length) fichaUpdates.push({ id, data: { ...fichaData, updated_at: nowIso } });
        const fase = sectorOf(lot);
        if (String(user.fase || '') !== fase) { userUpdates.push({ id, data: { fase, updatedAt: nowIso } }); stats.fases++; }
    });

    return { creates, annuls, fichas: fichaUpdates, users: userUpdates, problems, stats, source, reason };
}

// Como quedaria cada lote: aplica el plan sobre los movimientos que hay (en memoria) y lo compara con la hoja.
//   sheetView: al corte, solo las cuotas de la hoja (sin el saldo a favor ni la cuota de este mes): debe dar EXACTO lo de la
//              hoja (cuotas pendientes y mora) lote por lote.
//   today:     a la fecha `asOf` con todo (lo que vera el sistema): capital, mora, saldo a favor, vencido y si es moroso
//              para la garita (con la ficha del lote despues de la carga: fichaOf(id)).
export function simulate(plan, existingMovements, settings, opts) {
    const { cut, asOf, sheet, prefix } = opts;
    const fichaOf = typeof opts.fichaOf === 'function' ? opts.fichaOf : () => null;
    const annulled = new Set(plan.annuls.map((a) => a.id));
    const after = existingMovements.map((m) => (annulled.has(String(m.id)) ? { ...m, deleted: true } : m)).concat(plan.creates);
    const byResident = new Map();
    after.forEach((m) => { if (!m || m.deleted) return; const id = String(m.resiId || ''); if (!byResident.has(id)) byResident.set(id, []); byResident.get(id).push(m); });
    const rows = [];
    let mismatches = 0;
    sheet.lots.forEach((l) => {
        const id = `${prefix}${l.lot}`;
        const txs = byResident.get(id) || [];
        const sheetOnly = txs.filter((t) => t.importedFrom === plan.source && t.type === 'charge' && String(t.id).startsWith('sr_'));
        const atCut = Mora.stateOf(id, sheetOnly, settings, cut);
        const now = Mora.stateOf(id, txs, settings, asOf);
        const same = cents(atCut.capital) === cents(l.pend) && cents(atCut.mora) === cents(l.mora);
        if (!same) mismatches++;
        const moroso = Server.moraOf(id, txs, settings, new Date(`${asOf}T18:00:00.000Z`), fichaOf(id)).moroso;
        rows.push({ lot: l.lot, id, sheetPend: l.pend, sheetMora: l.mora, sheetFavor: l.favor, cutCapital: atCut.capital, cutMora: atCut.mora, same,
            capital: now.capital, overdue: now.overdueCapital, mora: now.mora, credit: now.credit, balance: now.balance, moroso });
    });
    return { rows, mismatches };
}
