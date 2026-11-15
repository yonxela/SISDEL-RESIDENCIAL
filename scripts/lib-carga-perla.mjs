// Plan de la carga de RESIDENCIALES LA PERLA (lista de propietarios + cartera de saldos). Solo CALCULA: no lee la
// base ni escribe nada (eso lo hace scripts/cargar-la-perla.mjs). Las pruebas usan datos inventados
// (scripts/test-carga-perla.mjs): los archivos reales tienen datos personales y nunca entran al repositorio.
//
// Un lote = una cuenta (vecino de SISDEL con su codigo + su ficha del Sistema Financiero):
//   usuarios/{id}            nombre, casa (= lote, como lo escribe la asociacion: A001, BA012...), telefono, correo
//   finanzas_residentes/{id} NIT, direccion, ownerGroup (mismo NIT = mismo dueno), agua del lote (paja), desde que
//                            mes se cobra, observaciones (otros telefonos o correos que traia la celda)
//   finanzas_movimientos     una cuota por lote y mes con capital pendiente (mantenimiento + agua de ese mes, con su
//                            desglose y la descripcion de OIKOS), la mora que quedo de cuotas ya pagadas como cargo
//                            fijo (moraFixed) y el interes pendiente. La mora de lo que se debe NO se carga: la
//                            calcula el sistema por dia (finanzas/sisdel-mora.js).
import { createRequire } from 'node:module';
import { cellText, cellNumber } from './lib-xlsx.mjs';

const require = createRequire(import.meta.url);
const SisdelCuotas = require('../finanzas/sisdel-cuotas.js');

export const SOURCE = 'cartera La Perla al 15/11/2026';
const EPS = 0.005;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clean = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
const plainName = (text) => clean(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[.\-,;]+$/, '').trim();

// ── Lotes ──
// 'A001', 'a-1', 'BA 12' -> clave 'A1' / 'BA12'; null si no es un lote
export function lotKey(label) {
    const mt = /^\s*([A-Za-z]{1,2})\s*-?\s*0*(\d{1,4})\s*$/.exec(String(label || ''));
    return mt ? mt[1].toUpperCase() + parseInt(mt[2], 10) : null;
}
// Como lo escribe la asociacion: letras y tres cifras ('A1' -> 'A001')
export function lotLabel(key) {
    const mt = /^([A-Z]{1,2})(\d+)$/.exec(String(key || ''));
    return mt ? mt[1] + mt[2].padStart(3, '0') : String(key || '');
}
export const sectorOf = (key) => (/^([A-Z]{1,2})/.exec(String(key || '')) || [])[1] || '';

// ── Datos de contacto ──
// Una celda puede traer varios numeros ("5555-1234 / 4444-5678"). Devuelve el primero ya normalizado (+502 en
// Guatemala, +1 en Estados Unidos) y los demas como texto para las observaciones.
export function parsePhones(raw) {
    const text = clean(raw);
    if (!text) return { phone: '', others: [], odd: false };
    // "/ , ; y" separan numeros. Dentro de cada parte, los grupos de cifras se juntan hasta formar un telefono:
    // 8 cifras (Guatemala), 502 + 8, o 001 + 10 (Estados Unidos). Asi "5555-1234 001 305 555 1234" son dos numeros.
    const numbers = [];
    text.split(/\s*(?:\/|,|;|\by\b|\|)\s*/i).forEach((piece) => {
        const groups = piece.match(/\d+/g) || [];
        const all = groups.join('');
        if (!all) return;
        // Un numero de Estados Unidos sin 001 ("305 555 1234") o con 1 adelante
        if (all.length === 10 || (all.length === 11 && all.startsWith('1'))) { numbers.push(all); return; }
        // Una sola corrida de cifras que no mide como un telefono (le falta o le sobra una cifra): se deja como vino
        if (groups.length === 1 && ![8, 10, 11, 13].includes(all.length) && all.length % 8 !== 0) { numbers.push(all); return; }
        let acc = '';
        groups.forEach((group) => {
            acc += group;
            for (;;) {
                const need = acc.startsWith('001') ? 13 : (acc.startsWith('502') && acc.length >= 11) ? 11 : /^[2-7]/.test(acc) ? 8 : null;
                if (need && acc.length >= need) { numbers.push(acc.slice(0, need)); acc = acc.slice(need); continue; }
                break;
            }
        });
        if (acc) numbers.push(acc);
    });
    const normalize = (piece) => {
        const digits = String(piece).replace(/\D/g, '');
        if (digits.length === 8) return '+502' + digits;
        if (digits.length === 11 && digits.startsWith('502')) return '+' + digits;
        if (digits.length === 13 && digits.startsWith('001')) return '+1' + digits.slice(3);
        if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
        if (digits.length === 10) return '+1' + digits;
        return null;
    };
    const first = numbers[0];
    const phone = first ? normalize(first) : null;
    return {
        phone: phone || (first ? clean(first) : ''),
        others: numbers.slice(1).map((n) => normalize(n) || clean(n)),
        odd: !!first && !phone
    };
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
export function parseEmails(raw) {
    const items = clean(raw).split(/[\s,;/]+/).filter(Boolean);
    const valid = items.filter((e) => EMAIL.test(e)).map((e) => e.toLowerCase());
    return { email: valid[0] || '', others: valid.slice(1), bad: items.filter((e) => !EMAIL.test(e)) };
}
// C/F o vacio no agrupa; un NIT con numeros agrupa los lotes del mismo dueno (igual que SISDEL.ownerGroupOf)
export function normalizeNit(raw) {
    const text = clean(raw).toUpperCase();
    if (!text) return '';
    if (/^C\.?\s*\/?\s*F\.?$/.test(text)) return 'C/F';
    return text;
}
export function ownerGroupOf(nit) {
    const text = String(nit || '').toUpperCase().trim();
    const digits = text.replace(/[^0-9K]/g, '');
    if (!digits || !/\d/.test(digits) || /^C\.?\s*\/?\s*F\.?$/.test(text)) return '';
    return 'nit:' + digits;
}

// Lo que no es una persona (el pozo, areas comunes): no recibe codigo de acceso
const NOT_A_PERSON = /\b(POZO|TANQUE|AREA VERDE|GARITA|SALON|PARQUE|BODEGA|PLANTA DE TRATAMIENTO)\b/;

// ── Lectura de los archivos ──
// Lista de propietarios: encabezado en la fila 4; columnas No., # LOTE, NIT, PROPIETARIO, DIRECCION, TELEFONO, CORREO
export function parseOwners(book) {
    const sheet = book.sheets[0];
    const out = [];
    const seen = new Map();
    const issues = [];
    sheet.rows.filter((row) => row.r > 4 && cellText(row, 1)).forEach((row) => {
        let key = lotKey(cellText(row, 1));
        if (!key) { issues.push({ row: row.r, issue: 'lote ilegible' }); return; }
        // El archivo repite D124: la segunda fila es D125 (confirmado con la cartera: mismo dueno en los dos lotes)
        if (seen.has(key) && key === 'D124' && !seen.has('D125')) key = 'D125';
        if (seen.has(key)) { issues.push({ row: row.r, lot: key, issue: 'lote repetido' }); return; }
        seen.set(key, row.r);
        out.push({
            row: row.r, key, label: lotLabel(key),
            nit: cellText(row, 2), name: cellText(row, 3), direccion: cellText(row, 4),
            phone: cellText(row, 5), email: cellText(row, 6)
        });
    });
    return { owners: out, issues };
}

// 'dd/mm/yy' o 'dd/mm/yyyy' -> 'AAAA-MM-DD'
export function parseDate(text) {
    const mt = /^(\d{1,2})[/\-]+(\d{1,2})[/\-]+(\d{2,4})$/.exec(clean(text));
    if (!mt) return null;
    let year = parseInt(mt[3], 10);
    if (year < 100) year += 2000;
    const month = parseInt(mt[2], 10);
    const day = parseInt(mt[1], 10);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
}

// Cartera ("Saldos por Antiguedad"): cada cuenta empieza con su codigo LOTE-TIPO+ANO en la columna B (A002-M26:
// mantenimiento 2026; A002-A26: agua) y el cliente en la C; sus cuotas tienen el numero en la C, la fecha esperada
// en la D y capital, interes, mora y total en E a H. Otras filas con texto en la B (subtotales) no cierran la cuenta.
const ACCOUNT = /^([A-Z]{1,2})\s*0*(\d{1,4})\s*-\s*([A-Z]*)\s*(\d{2})$/;
export function parseCartera(book) {
    const sheet = book.sheets[0];
    const accounts = [];
    let current = null;
    sheet.rows.forEach((row) => {
        const code = cellText(row, 1).toUpperCase();
        if (code) {
            const mt = ACCOUNT.exec(code);
            if (mt) {
                current = {
                    key: mt[1] + parseInt(mt[2], 10), type: mt[3] || '', year: 2000 + parseInt(mt[4], 10), code,
                    client: cellText(row, 2), paid: cellNumber(row, 3), pending: cellNumber(row, 6), row: row.r, quotas: []
                };
                accounts.push(current);
            }
            return;
        }
        if (!current || !/^\d+(\.0)?$/.test(cellText(row, 2))) return;
        const date = parseDate(cellText(row, 3));
        if (!date) return;
        current.quotas.push({
            row: row.r, number: parseInt(cellText(row, 2), 10), date, period: date.slice(0, 7),
            capital: round2(cellNumber(row, 4)), interest: round2(cellNumber(row, 5)), mora: round2(cellNumber(row, 6)), total: round2(cellNumber(row, 7))
        });
    });
    return accounts;
}

// Agua del lote por la cuenta de agua mas reciente: Q160 al mes = una paja, Q80 = media paja. Sin monto visible
// (cuenta al dia) se toma media paja, salvo los sectores B y BA (fase 2 y 2A: una paja). Sin cuenta de agua: 0.
export function waterUnitsOf(key, accounts) {
    const water = accounts.filter((a) => a.key === key && a.type === 'A').sort((a, b) => b.year - a.year);
    if (!water.length) return { units: 0, source: 'sin cuenta de agua' };
    // La fase 2 y la 2A (sectores B y BA) pagan una paja (Q160), segun la asociacion
    if (['B', 'BA'].includes(sectorOf(key))) return { units: 1, source: `sector ${sectorOf(key)} (fase 2 / 2A): una paja` };
    const latest = water[0];
    const plan = latest.paid + latest.pending;
    const caps = latest.quotas.map((q) => q.capital).filter((c) => c > EPS);
    const common = caps.length ? caps.sort((a, b) => caps.filter((x) => x === b).length - caps.filter((x) => x === a).length)[0] : 0;
    const monthly = plan > EPS ? round2(plan / 12) : common;
    if (Math.abs(monthly - 160) < 0.5) return { units: 1, source: 'Q160 al mes' };
    if (Math.abs(monthly - 80) < 0.5) return { units: 0.5, source: 'Q80 al mes' };
    if (['B', 'BA'].includes(sectorOf(key))) return { units: 1, source: `sector ${sectorOf(key)} (fase 2 / 2A)` };
    return { units: 0.5, source: monthly > EPS ? `monto raro Q${monthly}` : 'sin monto visible: media paja por omision', unsure: true };
}

const nextPeriod = (period) => {
    const [y, m] = period.split('-').map((n) => parseInt(n, 10));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const monthText = (period) => SisdelCuotas.monthLabel(period) || period;
// Mediodia de Guatemala (UTC-6) de un dia AAAA-MM-DD
const noonGt = (day) => `${day}T18:00:00.000Z`;

// Parecido entre dos nombres (palabras en comun): para avisar de los lotes donde la cartera trae otro dueno
function nameSimilarity(a, b) {
    const words = (s) => new Set(plainName(s).split(/[^A-Z]+/).filter((w) => w.length >= 3 && !['DEL', 'LAS', 'LOS'].includes(w)));
    const x = words(a);
    const y = words(b);
    if (!x.size || !y.size) return 0;
    let common = 0;
    x.forEach((w) => { if (y.has(w)) common++; });
    return common / Math.min(x.size, y.size);
}

// ── El plan ──
// options: { condoId, nowIso, currentPeriod (AAAA-MM), currency, idPrefix }
export function buildPlan(owners, accounts, options) {
    const { condoId, nowIso, currentPeriod, currency = 'GTQ', idPrefix = 'perla-' } = options;
    const byLot = new Map();
    accounts.forEach((a) => { if (!byLot.has(a.key)) byLot.set(a.key, []); byLot.get(a.key).push(a); });
    const ownerKeys = new Set(owners.map((o) => o.key));
    const lots = [];
    const skipped = [];
    const charges = [];

    owners.forEach((o) => {
        const name = clean(o.name).replace(/[.\-,;]+$/, '').trim();
        const own = byLot.get(o.key) || [];
        if (!name || NOT_A_PERSON.test(plainName(name))) {
            skipped.push({ lot: o.label, reason: name ? 'no es una persona (pozo o area comun): no recibe codigo' : 'sin nombre', accounts: own.length });
            return;
        }
        const id = idPrefix + o.label;
        const phones = parsePhones(o.phone);
        const emails = parseEmails(o.email);
        const nit = normalizeNit(o.nit);
        const water = waterUnitsOf(o.key, own);
        const notes = [];
        if (phones.others.length) notes.push(`Otros teléfonos: ${phones.others.join(', ')}`);
        if (emails.others.length) notes.push(`Otros correos: ${emails.others.join(', ')}`);
        if (emails.bad.length) notes.push(`Correo como venía en la lista (revisar): ${emails.bad.join(' ')}`);

        // Cuotas de la cartera por mes: mantenimiento (M o sin tipo) y agua (A) del mismo mes van en una sola cuota
        const months = new Map();
        let lastPeriod = null;
        own.forEach((account) => account.quotas.forEach((q) => {
            if (!lastPeriod || q.period > lastPeriod) lastPeriod = q.period;
            if (!months.has(q.period)) months.set(q.period, { period: q.period, date: q.date, maintenance: 0, water: 0, moraPaid: 0, interest: 0, moraOnDebt: 0 });
            const m = months.get(q.period);
            if (q.date > m.date) m.date = q.date;
            const part = account.type === 'A' ? 'water' : 'maintenance';
            if (q.capital > EPS) { m[part] = round2(m[part] + q.capital); m.moraOnDebt = round2(m.moraOnDebt + q.mora); }
            else if (q.mora > EPS) m.moraPaid = round2(m.moraPaid + q.mora);
            if (q.interest > EPS) m.interest = round2(m.interest + q.interest);
        }));
        const lotCharges = [];
        [...months.values()].sort((a, b) => a.period.localeCompare(b.period)).forEach((m) => {
            const base = { type: 'charge', resiId: id, manual: true, auto: false, serverGenerated: true, importedFrom: SOURCE, created_at: nowIso, updated_at: nowIso };
            const breakdown = {};
            if (m.maintenance > EPS) breakdown.maintenance = m.maintenance;
            if (m.water > EPS) breakdown.water = m.water;
            const amount = round2((breakdown.maintenance || 0) + (breakdown.water || 0));
            if (amount > EPS) {
                lotCharges.push({
                    ...base, id: `fee_${id}_${m.period}`, kind: 'fee', period: m.period, date: noonGt(m.date), amount,
                    concept: SisdelCuotas.describe(breakdown, currency, m.period), breakdown, retro: m.period < currentPeriod,
                    _moraOnDebt: m.moraOnDebt
                });
            }
            // Mora que la asociacion dejo pendiente de una cuota ya pagada: cargo fijo, no crece (sisdel-mora.js)
            if (m.moraPaid > EPS) {
                lotCharges.push({
                    ...base, id: `mora_${id}_${m.period}`, kind: 'extra', date: noonGt(m.date), amount: m.moraPaid,
                    concept: `Mora pendiente de la cuota de ${monthText(m.period)} (${SOURCE})`, moraFixed: true, moraPeriod: m.period
                });
            }
            if (m.interest > EPS) {
                lotCharges.push({
                    ...base, id: `interes_${id}_${m.period}`, kind: 'extra', date: noonGt(m.date), amount: m.interest,
                    concept: `Interés pendiente de ${monthText(m.period)} (${SOURCE})`, interestPeriod: m.period
                });
            }
        });
        charges.push(...lotCharges);

        const clients = [...new Set(own.map((a) => clean(a.client)).filter(Boolean))];
        const differentOwner = clients.filter((c) => nameSimilarity(c, name) < 0.5);
        const ficha = { id, feeFrom: lastPeriod ? nextPeriod(lastPeriod) : currentPeriod, createdAt: nowIso, updated_at: nowIso, waterUnits: water.units };
        if (nit) ficha.nit = nit;
        const group = ownerGroupOf(nit);
        if (group) ficha.ownerGroup = group;
        if (clean(o.direccion)) ficha.direccion = clean(o.direccion);
        if (notes.length) ficha.notes = notes.join(' · ');
        lots.push({
            key: o.key, label: o.label, id,
            user: {
                id, condominioId: condoId, name, role: 'vecino', casa: o.label, phone: phones.phone, email: emails.email,
                paymentStatus: 'al_dia', morosoSince: null, active: true, createdAt: nowIso, updatedAt: nowIso, importedFrom: SOURCE
            },
            ficha,
            check: {
                accounts: own.length, water, phoneOdd: phones.odd, phoneOthers: phones.others.length, noPhone: !phones.phone,
                noEmail: !emails.email, badEmail: emails.bad.length > 0, cartera: clients, differentOwner,
                charges: lotCharges.length,
                capital: round2(lotCharges.filter((c) => c.kind === 'fee').reduce((s, c) => s + c.amount, 0)),
                moraFixed: round2(lotCharges.filter((c) => c.moraFixed).reduce((s, c) => s + c.amount, 0)),
                interest: round2(lotCharges.filter((c) => c.interestPeriod).reduce((s, c) => s + c.amount, 0))
            }
        });
    });

    // Cuentas de la cartera de lotes que no estan en la lista de propietarios: no se cargan (se avisan)
    const orphanAccounts = accounts.filter((a) => !ownerKeys.has(a.key));
    return { lots, charges, skipped, orphanAccounts };
}

// Totales de la cartera para cuadrar (todas sus filas de cuota)
export function carteraTotals(accounts) {
    const t = { quotas: 0, capital: 0, interest: 0, mora: 0, moraOnDebt: 0, moraOnPaid: 0 };
    accounts.forEach((a) => a.quotas.forEach((q) => {
        t.quotas++;
        t.capital += q.capital; t.interest += q.interest; t.mora += q.mora;
        if (q.capital > EPS) t.moraOnDebt += q.mora; else t.moraOnPaid += q.mora;
    }));
    Object.keys(t).forEach((k) => { if (k !== 'quotas') t[k] = round2(t[k]); });
    return t;
}

// Codigo de acceso como los de SISDEL: inicial del condominio + inicial del nombre + 3 cifras (RM123). random(): 0..1
export function accessCodeFor(condoName, name, taken, random = Math.random) {
    const initial = (text) => {
        const letter = String(text || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
        return /^[A-Z0-9]$/.test(letter) ? letter : 'X';
    };
    const prefix = initial(condoName) + initial(name);
    for (let attempt = 0; attempt < 5000; attempt++) {
        const code = prefix + String(Math.floor(random() * 1000)).padStart(3, '0');
        if (!/^[A-Z]{2}\d{3}$/.test(code) || taken.has(code)) continue;
        taken.add(code);
        return code;
    }
    throw new Error(`No quedan codigos libres para ${prefix}`);
}
