// Carga datos de prueba en el emulador de Firestore. Nunca escribe en la nube.
import fs from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PROJECT_ID, EMULATOR, sha256, normalizePlate, localDate, isoDaysAgo } from './lib.mjs';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || EMULATOR.firestore;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const seed = JSON.parse(fs.readFileSync(new URL('./dev-seed.json', import.meta.url), 'utf8'));
initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

// Vacia el emulador completo con su propio servicio de limpieza
async function clearAll() {
    const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(`No se pudo limpiar el emulador: HTTP ${res.status}`);
}

async function run() {
    await clearAll();
    const batch = db.batch();
    const now = new Date().toISOString();

    batch.set(db.doc('_privado/auth'), { masterCodeHash: sha256(seed.masterCode), updatedAt: now });
    // WhatsApp simulado: las alertas de panico registran a quien se avisaria, sin enviar nada
    if (seed.whatsapp) batch.set(db.doc('_privado/whatsapp'), { ...seed.whatsapp, updatedAt: now });

    for (const condo of seed.condominios) {
        const { usuarios, vehiculos, visitas, mensajes, rondas, ...condoData } = condo;
        const condoRef = db.doc(`condominios/${condo.id}`);
        batch.set(condoRef, { phone: '', serviceExpiry: null, createdAt: now, ...condoData });

        for (const u of usuarios) {
            const { code, morosoDaysAgo, ...user } = u;
            batch.set(condoRef.collection('usuarios').doc(u.id), {
                casa: '', phone: '', email: '', paymentStatus: null, active: true, createdAt: now,
                ...user, condominioId: condo.id,
                morosoSince: morosoDaysAgo !== undefined ? isoDaysAgo(morosoDaysAgo) : null
            });
            batch.set(db.doc(`codigos/${code}`), { condominioId: condo.id, userId: u.id, role: u.role, createdAt: now });
        }
        for (const v of vehiculos) {
            batch.set(condoRef.collection('vehiculos').doc(v.id), {
                ...v, condominioId: condo.id, plateNorm: normalizePlate(v.plate), createdAt: now
            });
        }
        for (const visit of visitas) {
            const { dayOffset, endOffset, ...data } = visit;
            batch.set(condoRef.collection('visitas').doc(visit.id), {
                visitTime: null, visitType: null, enteredAt: data.status === 'entered' ? now : null,
                ...data, condominioId: condo.id, plateNorm: normalizePlate(data.vehiclePlate),
                visitDate: localDate(dayOffset),
                endDate: endOffset !== undefined ? localDate(endOffset) : null,
                createdAt: isoDaysAgo(Math.max(0, -dayOffset))
            });
        }
        for (const m of mensajes) {
            batch.set(condoRef.collection('mensajes').doc(m.id), { ...m, condominioId: condo.id, read: false, createdAt: now });
        }
        for (const r of (rondas && rondas.rutas) || []) {
            batch.set(condoRef.collection('rondas_rutas').doc(r.id), { ...r, condominioId: condo.id, status: 'ACTIVE', createdAt: now, updatedAt: now });
        }
        for (const a of (rondas && rondas.asignaciones) || []) {
            const { startOffset, endOffset, ...data } = a;
            batch.set(condoRef.collection('rondas_asignaciones').doc(a.id), {
                ...data, condominioId: condo.id, dateStart: localDate(startOffset), dateEnd: localDate(endOffset), status: 'ACTIVE', createdAt: now
            });
        }
        for (const e of (rondas && rondas.emergencia) || []) {
            batch.set(condoRef.collection('emergencia').doc(e.userId), { ...e, condominioId: condo.id, updatedAt: now });
        }
    }
    for (const m of seed.mensajesGlobales) {
        batch.set(db.doc(`mensajes_globales/${m.id}`), { ...m, condominioId: 'all', read: false, createdAt: now });
    }

    await batch.commit();
    console.log(`Emulador sembrado: ${seed.condominios.length} condominios`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
