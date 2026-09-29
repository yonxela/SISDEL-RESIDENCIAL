// ═══════════════════════════════════════════════════════════════
// SISDEL Comunities - Cloud Functions
// ═══════════════════════════════════════════════════════════════
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const { login, verifyAccessCode } = require('./src/auth');
const { deleteCondominio } = require('./src/condominios');
const { anprWebhook } = require('./src/anpr/webhook');

module.exports = { login, verifyAccessCode, deleteCondominio, anprWebhook };
