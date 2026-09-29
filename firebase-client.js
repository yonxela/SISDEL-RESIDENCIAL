// ═══════════════════════════════════════════════════════════════
// SISDEL Cloud Connection (Firebase)
// ═══════════════════════════════════════════════════════════════
// Requiere cargar antes, en el HTML, los SDK compat de Firebase:
//   firebase-app-compat, firebase-auth-compat, firebase-firestore-compat, firebase-functions-compat

(function () {
    // Configuracion publica de la app web GARITA-APP (proyecto sisdel-datacenter).
    // No es un secreto: la seguridad la dan las reglas de Firestore y el login.
    const FIREBASE_CONFIG = {
        apiKey: 'AIzaSyA2wjrJE-Zv35bvAydz-RcvvIJxIgWYL10',
        authDomain: 'sisdel-datacenter.firebaseapp.com',
        projectId: 'sisdel-datacenter',
        storageBucket: 'sisdel-datacenter.firebasestorage.app',
        messagingSenderId: '1098770073312',
        appId: '1:1098770073312:web:eb7a8d62ec62b325f87285'
    };
    const FUNCTIONS_REGION = 'us-central1';

    if (typeof firebase === 'undefined') {
        console.error('Firebase SDK no cargado. Incluya los scripts compat en el HTML.');
        return;
    }

    const app = firebase.initializeApp(FIREBASE_CONFIG);
    const services = {
        db: firebase.firestore(),
        auth: firebase.auth(),
        functions: app.functions(FUNCTIONS_REGION)
    };

    // En desarrollo local se usan los emuladores (firebase emulators:start).
    // Para probar contra la nube desde localhost: localStorage.setItem('sisdel_backend', 'prod')
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    let forceProd = false;
    try { forceProd = localStorage.getItem('sisdel_backend') === 'prod'; } catch (e) { /* sin acceso a storage */ }

    if (isLocalHost && !forceProd) {
        services.db.useEmulator('127.0.0.1', 8080);
        services.auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
        services.functions.useEmulator('127.0.0.1', 5001);
        console.log('SISDEL conectado a emuladores locales');
    }

    window.sisdelFirebase = services;
})();
