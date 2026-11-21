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

const { login, verifyAccessCode, confirmOwnCode } = require('./src/auth');
const { deleteCondominio, renameCondominio, renameAdmin } = require('./src/condominios');
// Bancos: cambiar la cuenta favorita con el codigo del administrador (src/bancos.js)
const { setFavoriteBank } = require('./src/bancos');
const { anprWebhook } = require('./src/anpr/webhook');
const { startReminderCampaign, controlReminderCampaign, sendReminderTest, sendReminderOne, sendAccessCode, checkWhatsAppConnection, reconcileReminderCampaign, resendReminderCampaign, processReminderQueue } = require('./src/recordatorios');
// Chat de WhatsApp con los residentes (src/whatsapp-chat.js): aviso de UltraMsg y funciones de OIKOS
const { whatsappWebhook, sendChatMessage, markChatRead, loadChatHistory } = require('./src/whatsapp-chat');
const { onFinanceMovement, onFinanceSettings, dailyFinance } = require('./src/finanzas');
const { onPanicCreated, dailyRondas } = require('./src/rondas');
// QR de panico por vecino (panico.html): vincular el telefono con su codigo y enviar la alerta (src/panico-qr.js)
const { linkPanicDevice, panicDevice } = require('./src/panico-qr');
// Bitacora: rastro de cada cambio a usuarios, vehiculos y Sistema Financiero (ver src/bitacora.js)
const { auditUsers, auditVehicles, auditFinanceResidents, auditFinanceMovements, auditFinanceSettings, auditBankAccounts, auditBankMovements } = require('./src/bitacora');

module.exports = {
    login, verifyAccessCode, confirmOwnCode, deleteCondominio, renameCondominio, renameAdmin, setFavoriteBank, anprWebhook,
    startReminderCampaign, controlReminderCampaign, sendReminderTest, sendReminderOne, sendAccessCode, checkWhatsAppConnection, reconcileReminderCampaign, resendReminderCampaign, processReminderQueue,
    whatsappWebhook, sendChatMessage, markChatRead, loadChatHistory,
    onFinanceMovement, onFinanceSettings, dailyFinance,
    onPanicCreated, dailyRondas, linkPanicDevice, panicDevice,
    auditUsers, auditVehicles, auditFinanceResidents, auditFinanceMovements, auditFinanceSettings, auditBankAccounts, auditBankMovements
};
