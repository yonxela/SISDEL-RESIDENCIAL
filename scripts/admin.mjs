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
