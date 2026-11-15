// Conexion de administrador a Firestore: emulador local o nube
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PROJECT_ID, EMULATOR } from './lib.mjs';

// target: 'emulator' | 'prod'
export function connect(target) {
    if (target === 'prod') {
        delete process.env.FIRESTORE_EMULATOR_HOST;
        initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
    } else {
        process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || EMULATOR.firestore;
        process.env.GCLOUD_PROJECT = PROJECT_ID;
        initializeApp({ projectId: PROJECT_ID });
    }
    const db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
}

// Lee argumentos tipo --clave=valor y --bandera
export function parseArgs(argv = process.argv.slice(2)) {
    const args = {};
    for (const item of argv) {
        const match = item.match(/^--([^=]+)(?:=(.*))?$/);
        if (match) args[match[1]] = match[2] === undefined ? true : match[2];
    }
    return args;
}

// Escribe muchos documentos en lotes
export async function writeAll(db, writes) {
    const SIZE = 400;
    for (let i = 0; i < writes.length; i += SIZE) {
        const batch = db.batch();
        writes.slice(i, i + SIZE).forEach(({ path, data }) => batch.set(db.doc(path), data));
        await batch.commit();
    }
}

// ¿Responden los disparadores de functions del EMULADOR? Escribe un movimiento de sonda y espera a que el servidor
// lo selle (functions/src/finanzas/sello.js).
export async function emulatorTriggersRespond(db, timeoutMs = 6000) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const probe = db.doc('condominios/_sonda-disparadores/finanzas_movimientos/sonda');
    try {
        await probe.set({ id: 'sonda', type: 'expense', amount: 1, updated_at: new Date().toISOString() });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            if ((await probe.get()).get('server_at')) return true;
            await sleep(250);
        }
        return false;
    } finally {
        try { await probe.delete(); } catch { /* ya no existe */ }
    }
}

// Pausa o reanuda los disparadores de functions en el EMULADOR (para sembrar miles de documentos sin ejecutar una
// funcion por cada uno). Al reanudar, el emulador a veces no vuelve a entregarlos (sobre todo tras escribir o borrar
// mucho con ellos en pausa): se comprueba con la sonda y se reintenta. Devuelve true si quedaron como se pidio.
// Las pruebas de `npm test` no los pausan nunca.
export async function setEmulatorTriggers(db, enabled, hub = process.env.FIREBASE_EMULATOR_HUB || '127.0.0.1:4400') {
    const toggle = async (on) => {
        try { return (await fetch(`http://${hub}/functions/${on ? 'enable' : 'disable'}BackgroundTriggers`, { method: 'PUT' })).ok; } catch { return false; }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!(await toggle(enabled))) return false;
    if (!enabled) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await emulatorTriggersRespond(db)) return true;
        await toggle(false);
        await sleep(500);
        await toggle(true);
    }
    return false;
}
