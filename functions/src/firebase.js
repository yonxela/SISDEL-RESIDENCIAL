// Inicializacion unica del Admin SDK
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

if (getApps().length === 0) initializeApp();

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, auth: getAuth() };
