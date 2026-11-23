// Avisos en el celular (notificaciones push) contra los emuladores: la funcion pushDevice (activar, estado, prueba, desactivar,
// cuantos), el aviso de cada mensaje de la administracion (onMessagePush: a quien le llega, el telefono que ya no recibe, el
// mensaje sin aviso) y las reglas (nadie lee ni escribe los telefonos desde el navegador). Las direcciones de prueba llevan la
// marca /prueba-sisdel- y el servidor, SOLO en los emuladores, no las manda a internet: las anota en _push_simulados.
// Uso: levantar los emuladores, `npm run seed` y node test-avisos-emulador.mjs (tambien corre con npm test).
import crypto from 'node:crypto';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, collection } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { PROJECT_ID, EMULATOR } from './lib.mjs';
import { connect } from './admin.mjs';

const adb = connect('emulator');
const A = 'condo-villa-ferrer';

let passed = 0;
const failures = [];
function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
const equal = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
async function denied(name, fn) {
    try { await fn(); record(name, false, '-> se esperaba denegado y fue permitido'); } catch (e) { record(name, String(e.code || '').includes('permission-denied'), `-> error inesperado: ${e.code || e.message}`); }
}
async function waitFor(name, fn, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        try { last = await fn(); if (last) { record(name, true); return last; } } catch (e) { last = e.code || e.message; }
        await new Promise((r) => setTimeout(r, 400));
    }
    record(name, false, `-> no se cumplio en ${timeoutMs / 1000}s (${JSON.stringify(last)})`);
    return null;
}

let appCounter = 0;
async function loginAs(code) {
    const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, `avisos-${++appCounter}`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${EMULATOR.auth}`, { disableWarnings: true });
    const db = getFirestore(app);
    const [h, p] = EMULATOR.firestore.split(':');
    connectFirestoreEmulator(db, h, Number(p));
    const functions = getFunctions(app, 'us-central1');
    connectFunctionsEmulator(functions, ...EMULATOR.functions);
    const res = await httpsCallable(functions, 'login')({ code });
    if (!res.data.success) throw new Error('No entro ' + code);
    await signInWithCustomToken(auth, res.data.token);
    return { db, functions, uid: auth.currentUser.uid };
}

const push = (c, data) => httpsCallable(c.functions, 'pushDevice')(data).then((r) => r.data);
const errOf = async (p) => { try { await p; return 'sin error'; } catch (e) { return String(e.code || e.message).replace(/^functions\//, ''); } };
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function subscription(tag) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { endpoint: `https://fcm.googleapis.com/fcm/send/prueba-sisdel-${tag}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
}
const devCol = adb.collection(`condominios/${A}/push_dispositivos`);
const simulated = async () => (await adb.collection('_push_simulados').get()).docs.map((d) => d.data());
let msgCounter = 0;
const createdMessages = [];
async function sendMessage(admin, toRole, extra = {}) {
    const id = `msg-avisos-${Date.now()}-${++msgCounter}`;
    createdMessages.push(id);
    await setDoc(doc(admin.db, `condominios/${A}/mensajes/${id}`), {
        id, condominioId: A, fromName: 'Administración', toRole, subject: `Aviso ${msgCounter}`, body: `Texto del aviso ${msgCounter}`, read: false, createdAt: new Date().toISOString(), ...extra
    });
    return id;
}
const result = async (id) => ((await adb.doc(`condominios/${A}/mensajes/${id}`).get()).data() || {}).pushResult || null;

async function run() {
    await adb.recursiveDelete(devCol);
    await adb.recursiveDelete(adb.collection('_push_simulados'));
    // El tope de mensajes con aviso por hora es por condominio: se empieza de cero
    await adb.recursiveDelete(adb.collection('_privado/rate/push-mensajes'));

    // Los mensajes que trae la base de prueba disparan su aviso al sembrarla: se espera a que terminen (sin telefonos activados)
    // para que no avisen a los telefonos de estas pruebas
    await waitFor('los mensajes de la base de prueba ya pasaron por el aviso (sin telefonos)', async () => {
        const snap = await adb.collection(`condominios/${A}/mensajes`).get();
        return snap.docs.every((d) => d.data().push === false || (d.data().pushResult && d.data().pushResult.status === 'listo'));
    }, 60000);
    const admin = await loginAs('VF100');
    const ana = await loginAs('VA101');
    const maria = await loginAs('VM102');
    const guard = await loginAs('vp103');
    const sup = await loginAs('VO105');

    console.log('\nActivar los avisos en un telefono');
    const cfg = await push(ana, { action: 'config' });
    equal('el servidor entrega su llave publica (la privada nunca sale)', [typeof cfg.publicKey, cfg.publicKey.length, Object.keys(cfg)], ['string', 87, ['publicKey']]);
    const keysDoc = (await adb.doc('_privado/push').get()).data() || {};
    equal('las llaves se crearon solas en _privado/push y la publica es la misma', [keysDoc.publicKey === cfg.publicKey, typeof keysDoc.privateKey], [true, 'string']);
    equal('la misma llave en cada pedido', (await push(maria, { action: 'config' })).publicKey, cfg.publicKey);
    const subAna = subscription('ana-1');
    equal('Ana activa los avisos en su telefono', await push(ana, { action: 'register', subscription: subAna, standalone: true }), { ok: true });
    const devAna = (await devCol.where('userId', '==', 'u-ana').get()).docs.map((d) => d.data());
    equal('queda el telefono de Ana activo, con su rol y si se abrio desde la pantalla de inicio', devAna.map((d) => [d.role, d.active, d.standalone, d.endpoint === subAna.endpoint, !!d.createdAt]), [['vecino', true, true, true, true]]);
    equal('una direccion que no es de un servicio de avisos no se acepta', await errOf(push(ana, { action: 'register', subscription: { ...subAna, endpoint: 'https://ejemplo.com/push/1' } })), 'invalid-argument');
    equal('estado: activo para Ana', await push(ana, { action: 'state', endpoint: subAna.endpoint }), { active: true, otherUser: false });
    equal('estado de un telefono que no se activo: inactivo', await push(ana, { action: 'state', endpoint: 'https://fcm.googleapis.com/fcm/send/nunca' }), { active: false, otherUser: false });

    console.log('\nAviso de prueba');
    equal('Ana se manda un aviso de prueba', await push(ana, { action: 'test', endpoint: subAna.endpoint }), { ok: true, gone: false });
    const sims = await simulated();
    equal('el aviso de prueba fue a SU telefono (simulado en los emuladores)', sims.map((s) => [s.userId, s.endpoint === subAna.endpoint, s.payload.title, s.payload.kind]), [['u-ana', true, 'Aviso de prueba', 'prueba']]);
    equal('nadie manda la prueba a un telefono que no es suyo', await errOf(push(maria, { action: 'test', endpoint: subAna.endpoint })), 'failed-precondition');

    console.log('\nVarios telefonos y quien los ve');
    const subMaria = subscription('gone-maria');
    const subGuard = subscription('guardia-1');
    await push(maria, { action: 'register', subscription: subMaria });
    await push(guard, { action: 'register', subscription: subGuard });
    equal('la administracion ve cuantos tienen los avisos activados (sin ver los telefonos)', await push(admin, { action: 'summary' }), { devices: 3, users: 3, byRole: { vecino: 2, policia: 1 } });
    equal('un vecino o el supervisor no lo consultan (no mandan mensajes)', [await errOf(push(ana, { action: 'summary' })), await errOf(push(sup, { action: 'summary' }))], ['permission-denied', 'permission-denied']);
    await denied('reglas: el administrador no lee los telefonos desde el navegador', () => getDocs(collection(admin.db, `condominios/${A}/push_dispositivos`)));
    await denied('reglas: ni el propio vecino', () => getDoc(doc(ana.db, `condominios/${A}/push_dispositivos/x`)));
    await denied('reglas: nadie escribe uno a mano', () => setDoc(doc(ana.db, `condominios/${A}/push_dispositivos/x`), { userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/x', active: true }));

    console.log('\nEl aviso de cada mensaje de la administracion');
    await adb.recursiveDelete(adb.collection('_push_simulados'));
    const m1 = await sendMessage(admin, 'vecino', { push: true });
    const r1 = await waitFor('un mensaje a los vecinos avisa a sus telefonos y anota el resultado', async () => { const r = await result(m1); return r && r.status === 'listo' ? r : null; });
    equal('llego al de Ana; el de Maria ya no recibia (el servicio respondio 410); el guardia no era destinatario', r1 && [r1.devices, r1.sent, r1.gone, r1.failed, r1.users], [2, 1, 1, 0, 1]);
    const sims1 = await simulated();
    equal('el aviso lleva el asunto, el texto con el condominio y lleva a los mensajes', sims1.filter((s) => s.userId === 'u-ana' && s.payload.tag === `mensaje-${m1}`).map((s) => [s.payload.title, /Texto del aviso/.test(s.payload.body), s.payload.url, s.payload.tag]), [[`Aviso ${msgCounter}`, true, '/index.html?next=vecino.html&abrir=mensajes', `mensaje-${m1}`]]);
    const mariaDev = (await devCol.where('userId', '==', 'u-maria').get()).docs.map((d) => d.data());
    equal('el telefono de Maria quedo desactivado con el motivo (no se borra)', mariaDev.map((d) => [d.active, d.revokedBy, /410/.test(d.lastError)]), [[false, 'servicio', true]]);
    equal('Maria lo ve inactivo y puede volver a activarlo', await push(maria, { action: 'state', endpoint: subMaria.endpoint }), { active: false, otherUser: false });

    const m2 = await sendMessage(admin, 'policia');
    const r2 = await waitFor('un mensaje a los guardias avisa solo al de la garita', async () => { const r = await result(m2); return r && r.status === 'listo' ? r : null; });
    equal('a los guardias: un telefono', r2 && [r2.devices, r2.sent, r2.users], [1, 1, 1]);
    const m3 = await sendMessage(admin, 'all');
    const r3 = await waitFor('un mensaje a todos avisa a vecinos y guardias', async () => { const r = await result(m3); return r && r.status === 'listo' ? r : null; });
    equal('a todos: Ana y el guardia (Maria ya no recibe)', r3 && [r3.devices, r3.sent, r3.users], [2, 2, 2]);
    const m4 = await sendMessage(admin, 'vecino', { push: false });
    await new Promise((r) => setTimeout(r, 3500));
    equal('un mensaje con la casilla desmarcada no avisa a nadie', await result(m4), null);

    console.log('\nUn telefono que pasa a otra persona y desactivar');
    await push(guard, { action: 'register', subscription: subAna });
    equal('si otra persona activa los avisos en el telefono de Ana, desde ahi son de ella y Ana lo ve', await push(ana, { action: 'state', endpoint: subAna.endpoint }), { active: false, otherUser: true });
    const moved = (await devCol.doc((await devCol.where('endpoint', '==', subAna.endpoint).get()).docs[0].id).get()).data();
    equal('queda anotado de quien era antes', [moved.userId, moved.previousUserId], [guard.uid, 'u-ana']);
    await push(ana, { action: 'register', subscription: subAna });
    equal('Ana lo recupera tocando "Recibir aqui mis avisos"', await push(ana, { action: 'state', endpoint: subAna.endpoint }), { active: true, otherUser: false });
    equal('Ana desactiva los avisos en su telefono', await push(ana, { action: 'unregister', endpoint: subAna.endpoint }), { ok: true });
    equal('desactivado: inactivo y queda quien lo apago', [await push(ana, { action: 'state', endpoint: subAna.endpoint }), (await devCol.where('endpoint', '==', subAna.endpoint).get()).docs[0].data().revokedBy], [{ active: false, otherUser: false }, 'usuario']);
    const m5 = await sendMessage(admin, 'vecino');
    const r5 = await waitFor('sin telefonos activados, el mensaje dice que nadie de ese grupo los tiene', async () => { const r = await result(m5); return r && r.status === 'listo' ? r : null; });
    equal('a los vecinos: ningun telefono', r5 && [r5.devices, r5.sent], [0, 0]);

    console.log('\nQuien puede activarlos');
    await adb.doc(`condominios/${A}/usuarios/u-ana`).update({ privilegios: { 'mensajes.recibir': false } });
    equal('sin "Recibir mensajes" no se activan', await errOf(push(ana, { action: 'register', subscription: subAna })), 'permission-denied');
    await adb.doc(`condominios/${A}/usuarios/u-ana`).update({ privilegios: {} });
    const master = await (async () => {
        const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, `avisos-${++appCounter}`);
        const auth = getAuth(app);
        connectAuthEmulator(auth, `http://${EMULATOR.auth}`, { disableWarnings: true });
        const functions = getFunctions(app, 'us-central1');
        connectFunctionsEmulator(functions, ...EMULATOR.functions);
        const seed = JSON.parse((await import('node:fs')).readFileSync(new URL('./dev-seed.json', import.meta.url), 'utf8'));
        const res = await httpsCallable(functions, 'login')({ code: seed.masterCode });
        await signInWithCustomToken(auth, res.data.token);
        return { functions };
    })();
    equal('el Master no tiene avisos (no es de un condominio)', await errOf(push(master, { action: 'config' })), 'permission-denied');

    // Se deja todo como estaba para las demas pruebas (test-emulator.mjs cuenta los mensajes del condominio): telefonos apagados y
    // sin los mensajes de estas pruebas
    const all = await devCol.get();
    const batch = adb.batch();
    all.docs.forEach((d) => batch.update(d.ref, { active: false, revokedBy: 'prueba' }));
    createdMessages.forEach((id) => batch.delete(adb.doc(`condominios/${A}/mensajes/${id}`)));
    await batch.commit();
}

run().then(() => {
    console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
    if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
