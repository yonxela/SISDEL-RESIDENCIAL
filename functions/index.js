// ═══════════════════════════════════════════════════════════════
// SISDEL Comunities - Cloud Functions
// ═══════════════════════════════════════════════════════════════
const { setGlobalOptions } = require('firebase-functions/v2');

// Las funciones corren con la cuenta de servicio de Firebase Admin: ya tiene permiso
// para leer Firestore y para firmar los tokens de login, sin tocar permisos del proyecto.
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'sisdel-datacenter';

setGlobalOptions({
    region: 'us-central1',
    maxInstances: 10,
    serviceAccount: `firebase-adminsdk-fbsvc@${PROJECT_ID}.iam.gserviceaccount.com`
});

const { login, verifyAccessCode } = require('./src/auth');
const { deleteCondominio } = require('./src/condominios');
const { anprWebhook } = require('./src/anpr/webhook');

module.exports = { login, verifyAccessCode, deleteCondominio, anprWebhook };
