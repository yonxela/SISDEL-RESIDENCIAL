// Siembra en el EMULADOR un condominio grande (por defecto 719 residentes y 24 meses de cuotas y pagos) para medir
// como se comporta el Sistema Financiero (OIKOS) y el panel admin con mucho volumen. Nunca escribe en la nube.
//
// Uso (con los emuladores levantados y despues de `npm run seed`):
//   cd scripts && node seed-carga-grande.mjs                       719 residentes, 24 meses
//   node seed-carga-grande.mjs --residentes=719 --meses=60         5 anos
//   node seed-carga-grande.mjs --fotos=5                           5 % de los pagos con foto de comprobante
// Para repetirlo o quitarlo: `npm run seed` limpia el emulador entero. Si despues de sembrar los disparadores de
// functions no responden (el script lo avisa), reinicie los emuladores.
//
// Entra con el codigo del administrador que imprime al final (solo existe en el emulador).
// Todos los nombres, telefonos y documentos son inventados.
import { createRequire } from 'node:module';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PROJECT_ID, EMULATOR } from './lib.mjs';
import { parseArgs, setEmulatorTriggers } from './admin.mjs';

const require = createRequire(import.meta.url);
const SisdelCuotas = require('../finanzas/sisdel-cuotas.js');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || EMULATOR.firestore;
process.env.GCLOUD_PROJECT = PROJECT_ID;
// Solo emulador: una direccion que no sea local se rechaza
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
    console.error('Este script solo escribe en el emulador local.');
    process.exit(1);
}

const args = parseArgs();
const CONDO_ID = String(args.condo || 'condo-carga-grande');
const RESIDENTS = Math.max(1, parseInt(args.residentes, 10) || 719);
const MONTHS = Math.max(1, parseInt(args.meses, 10) || 24);
const PHOTO_PERCENT = Math.max(0, Math.min(100, parseFloat(args.fotos) || 0));
const ADMIN = { id: 'u-cg-admin', code: 'CG7190', name: 'Administrador Carga Grande', role: 'admin' };
const AUDITOR = { id: 'u-cg-auditor', code: 'CG7191', name: 'Auditora Carga Grande', role: 'auditor' };
const HUB = process.env.FIREBASE_EMULATOR_HUB || '127.0.0.1:4400';
const BATCH_SIZE = 400;
const PARALLEL = 6;
const UTC_OFFSET_HOURS = 6; // Guatemala

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const FIRST = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Jorge', 'Lucía', 'Pedro', 'Elena', 'Mario', 'Rosa', 'Héctor', 'Julia', 'Óscar', 'Paola', 'Raúl', 'Irma', 'Byron', 'Karla', 'Edgar'];
const LAST = ['García', 'López', 'Pérez', 'Morales', 'Hernández', 'Castillo', 'Ramírez', 'Méndez', 'Ortiz', 'Sosa', 'Barrios', 'Chávez', 'Estrada', 'Figueroa', 'Guzmán', 'Juárez', 'León', 'Monzón', 'Paz', 'Reyes'];
const EXPENSES = ['Pago de planilla', 'Pago de energía eléctrica', 'Pago de jardineros', 'Compra de insumos', 'Pago de agua potable', 'Vigilancia y seguridad', 'Mantenimiento general', 'Reparaciones', 'Limpieza'];
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Azar repetible: la misma siembra da siempre los mismos datos
let seedState = 719;
function random() {
    seedState = (seedState * 1664525 + 1013904223) % 4294967296;
    return seedState / 4294967296;
}
const pad = (n, width) => String(n).padStart(width, '0');
const gtDate = (y, m, d, h = 0, min = 0) => new Date(Date.UTC(y, m, d, h + UTC_OFFSET_HOURS, min, 0));
const periodKey = (y, m) => `${y}-${pad(m + 1, 2)}`;

// Una foto de comprobante de mentira, del tamano que deja OIKOS (JPEG de 800 px al 60 %: unas 60 000 letras)
function fakePhoto() {
    return 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRgABAQ'.padEnd(60000, 'A');
}

const setTriggers = (enabled) => setEmulatorTriggers(db, enabled, HUB);

async function commitAll(writes) {
    const chunks = [];
    for (let i = 0; i < writes.length; i += BATCH_SIZE) chunks.push(writes.slice(i, i + BATCH_SIZE));
    let done = 0;
    async function worker() {
        while (chunks.length) {
            const chunk = chunks.shift();
            const batch = db.batch();
            chunk.forEach(({ ref, data }) => batch.set(ref, data));
            await batch.commit();
            done += chunk.length;
            process.stdout.write(`\r  ${done} de ${writes.length} documentos`);
        }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    process.stdout.write('\n');
}

function build() {
    const now = new Date();
    const nowIso = now.toISOString();
    const local = new Date(now.getTime() - UTC_OFFSET_HOURS * 3600 * 1000);
    const curY = local.getUTCFullYear();
    const curM = local.getUTCMonth();
    const curD = local.getUTCDate();
    // Meses a cobrar: los ultimos MONTHS, terminando en el mes actual
    const periods = [];
    for (let i = MONTHS - 1; i >= 0; i--) {
        const date = new Date(Date.UTC(curY, curM - i, 1));
        periods.push({ y: date.getUTCFullYear(), m: date.getUTCMonth() });
    }
    const first = periods[0];
    const startIso = gtDate(first.y, first.m, 1, 8).toISOString();

    const settings = {
        currency: 'GTQ', lang: 'es', name: 'Residencial Carga Grande', theme: 'light',
        feeBreakdown: { maintenance: 300, water: 75, garbage: 50, electricity: 0, other: 0 },
        fee: 425, chargeDay: 1, graceDays: 5, feeMode: 'manual', lastChargedMonth: '',
        chargedMonths: periods.map((p) => periodKey(p.y, p.m)), receiptCounter: 0, updated_at: nowIso
    };
    const feeInfo = SisdelCuotas.feeInfo(settings, settings.fee);

    const condoRef = db.doc(`condominios/${CONDO_ID}`);
    const writes = [];
    const add = (ref, data) => writes.push({ ref, data });

    add(condoRef, {
        id: CONDO_ID, name: 'Residencial Carga Grande', address: 'Datos de prueba para medir volumen', phone: '',
        active: true, hasQR: true, hasManual: true, hasLPR: false, reminderEnabled: false, gracePeriodDays: 15,
        serviceExpiry: null, moraAutomatica: true, moraAutomaticaDesde: startIso, createdAt: startIso
    });
    [ADMIN, AUDITOR].forEach((u) => {
        const { code, ...user } = u;
        add(condoRef.collection('usuarios').doc(u.id), {
            casa: '', phone: '5555-0000', email: '', paymentStatus: null, morosoSince: null, active: true,
            createdAt: startIso, ...user, condominioId: CONDO_ID
        });
        add(db.doc(`codigos/${code}`), { condominioId: CONDO_ID, userId: u.id, role: u.role, createdAt: startIso });
    });
    add(condoRef.collection('finanzas_config').doc('oikos_settings'), settings);

    const residents = [];
    for (let i = 1; i <= RESIDENTS; i++) {
        const id = `cg-${pad(i, 4)}`;
        const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]} ${LAST[(i * 3 + 5) % LAST.length]}`;
        // 4 de cada 100 dejan de pagar hacia el final; 6 de cada 100 se atrasan de vez en cuando
        const kind = i % 25 === 0 ? 'moroso' : (i % 17 === 0 ? 'irregular' : 'puntual');
        residents.push({ id, name, kind, debt: 0 });
    }

    const movements = [];
    let receipt = 0;
    // Id como los de OIKOS (la hora en milisegundos), sin repetir
    const usedIds = new Set();
    const txId = (date) => {
        let ms = date.getTime() + Math.floor(random() * 60000);
        while (usedIds.has(ms)) ms++;
        usedIds.add(ms);
        return String(ms);
    };
    periods.forEach(({ y, m }, index) => {
        const period = periodKey(y, m);
        const isCurrent = index === periods.length - 1;
        const feeDate = gtDate(y, m, settings.chargeDay, 6).toISOString();
        residents.forEach((r) => {
            movements.push({
                id: `fee_${r.id}_${period}`, date: feeDate, type: 'charge', kind: 'fee', period, amount: settings.fee,
                concept: feeInfo ? feeInfo.concept : `Cuota - ${MONTHS_ES[m]} ${y}`, resiId: r.id, auto: true,
                ...(feeInfo ? { breakdown: feeInfo.breakdown } : {}), created_at: feeDate, updated_at: feeDate
            });
            r.debt += settings.fee;
            const monthsLeft = periods.length - 1 - index;
            const pays = r.kind === 'moroso' ? monthsLeft >= 4 : (r.kind === 'irregular' ? random() < 0.75 : true);
            const day = 2 + Math.floor(random() * 24);
            if (!pays || (isCurrent && day > curD)) return;
            const date = gtDate(y, m, day, 8 + Math.floor(random() * 9), Math.floor(random() * 60));
            const iso = date.toISOString();
            const clean = r.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
            const payment = {
                id: txId(date), date: iso, type: 'income', amount: settings.fee, concept: `Cuota - ${MONTHS_ES[m]} ${y}`,
                receiptNum: clean.substring(0, 2) + pad(++receipt, 4), resiId: r.id, created_at: iso, updated_at: iso
            };
            if (random() < 0.3) payment.docNum = 'TRF-' + pad(Math.floor(random() * 1000000), 6);
            if (random() < 0.1) payment.notes = 'Pago recibido en la oficina de la administración';
            if (random() * 100 < PHOTO_PERCENT) payment.receiptImg = fakePhoto();
            movements.push(payment);
            r.debt -= settings.fee;
        });
        // Egresos del mes
        for (let e = 0; e < 15; e++) {
            const day = 1 + Math.floor(random() * 27);
            if (isCurrent && day > curD) continue;
            const date = gtDate(y, m, day, 9 + Math.floor(random() * 8), Math.floor(random() * 60));
            const iso = date.toISOString();
            movements.push({
                id: txId(date), date: iso, type: 'expense', amount: Math.round((500 + random() * 9500) * 100) / 100,
                concept: EXPENSES[e % EXPENSES.length], receiptNum: 'EG' + pad(++receipt, 4), created_at: iso, updated_at: iso
            });
        }
    });
    settings.receiptCounter = receipt;

    residents.forEach((r, i) => {
        const n = i + 1;
        const moroso = r.debt > settings.fee;
        add(condoRef.collection('usuarios').doc(r.id), {
            id: r.id, condominioId: CONDO_ID, name: r.name, role: 'vecino', casa: `Lote ${n}`, phone: `+5025${pad(5550000 + n, 7)}`,
            email: '', paymentStatus: moroso ? 'moroso' : 'al_dia', morosoSince: moroso ? nowIso : null, active: true,
            createdAt: startIso, updatedAt: startIso
        });
        add(db.doc(`codigos/CG${pad(n, 4)}V`), { condominioId: CONDO_ID, userId: r.id, role: 'vecino', createdAt: startIso });
        add(condoRef.collection('finanzas_residentes').doc(r.id), {
            id: r.id, dpi: pad(1000000000000 + n * 7919, 13), lot: `L-${pad(n, 3)}`, notes: '',
            feeFrom: periodKey(first.y, first.m), createdAt: startIso, updated_at: startIso
        });
    });
    movements.forEach((t) => add(condoRef.collection('finanzas_movimientos').doc(t.id), t));

    const jsonChars = JSON.stringify(movements).length;
    return { writes, residents, movements, jsonChars, morosos: residents.filter((r) => r.debt > settings.fee).length };
}

async function run() {
    // El emulador se limpia entero y al instante con `npm run seed`. Borrar decenas de miles de documentos uno por
    // uno con los disparadores en pausa deja al emulador sin entregar disparadores hasta reiniciarlo.
    if ((await db.doc(`condominios/${CONDO_ID}`).get()).exists) {
        console.error(`El condominio ${CONDO_ID} ya existe. Corra primero "npm run seed" (limpia el emulador) y luego este script.`);
        process.exit(1);
    }
    const data = build();
    console.log(`Sembrando ${CONDO_ID}: ${RESIDENTS} residentes, ${MONTHS} meses, ${data.movements.length} movimientos`);
    // Sin disparadores: cada movimiento recalcularia la mora de su vecino (decenas de miles de ejecuciones)
    const paused = await setTriggers(false);
    if (!paused) console.log('  Aviso: no se pudieron pausar los disparadores de functions (la siembra tardara mas).');
    const started = Date.now();
    try {
        await commitAll(data.writes);
    } finally {
        if (paused && !(await setTriggers(true))) console.log('  Aviso: los disparadores de functions no respondieron al reanudarlos: reinicie los emuladores.');
    }
    const mb = (chars) => (chars / 1e6).toFixed(1);
    console.log(`Listo en ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    console.log(`  Movimientos: ${data.movements.length} (${mb(data.jsonChars)} millones de letras en JSON)`);
    console.log(`  Residentes morosos (deben mas de una cuota): ${data.morosos}`);
    console.log(`  Entrar en http://127.0.0.1:5050 con el codigo ${ADMIN.code} (administrador) o ${AUDITOR.code} (auditor)`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
