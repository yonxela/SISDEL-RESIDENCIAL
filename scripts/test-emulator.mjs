// Pruebas de extremo a extremo contra los emuladores: login, reglas por rol y webhook de camara.
// Uso: levantar emuladores, correr seed-emulator.mjs y luego este archivo.
import fs from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import {
    getFirestore, connectFirestoreEmulator, collection, collectionGroup, doc, getDoc, getDocs,
    setDoc, updateDoc, deleteDoc, writeBatch, query, where
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { PROJECT_ID, EMULATOR, localDate } from './lib.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./dev-seed.json', import.meta.url), 'utf8'));
const WEBHOOK = `http://${EMULATOR.functions[0]}:${EMULATOR.functions[1]}/${PROJECT_ID}/us-central1/anprWebhook`;
const A = 'condo-villa-ferrer';
const B = 'condo-los-olivos';
const C = 'condo-inactivo';

let passed = 0;
const failures = [];
let appCounter = 0;

function client() {
    const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, `app-${++appCounter}`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${EMULATOR.auth}`, { disableWarnings: true });
    const db = getFirestore(app);
    const [fsHost, fsPort] = EMULATOR.firestore.split(':');
    connectFirestoreEmulator(db, fsHost, Number(fsPort));
    const functions = getFunctions(app, 'us-central1');
    connectFunctionsEmulator(functions, ...EMULATOR.functions);
    return { app, auth, db, functions };
}

async function loginAs(code) {
    const c = client();
    const result = await httpsCallable(c.functions, 'login')({ code });
    c.login = result.data;
    if (result.data.success) await signInWithCustomToken(c.auth, result.data.token);
    return c;
}

function record(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}

async function allowed(name, fn) {
    try { await fn(); record(name, true); }
    catch (e) { record(name, false, `-> se esperaba permitido: ${e.code || e.message}`); }
}

async function denied(name, fn) {
    try { await fn(); record(name, false, '-> se esperaba denegado y fue permitido'); }
    catch (e) {
        const code = String(e.code || '');
        record(name, code.includes('permission-denied') || code.includes('unauthenticated'), `-> error inesperado: ${code || e.message}`);
    }
}

function equal(name, actual, expected) {
    record(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

async function camera(params, body, headers = { 'Content-Type': 'application/json' }) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${WEBHOOK}${qs ? '?' + qs : ''}`, {
        method: 'POST', headers, body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
}

async function run() {
    // ───────── Login ─────────
    console.log('\nLogin');
    const nobody = client();
    const bad = await httpsCallable(nobody.functions, 'login')({ code: 'ZZ000' });
    equal('codigo inexistente es rechazado', bad.data.success, false);

    const inactive = await httpsCallable(nobody.functions, 'login')({ code: 'CC300' });
    equal('condominio sin servicio no entra', inactive.data.error, 'El condominio no está activo');

    const master = await loginAs(seed.masterCode);
    equal('master entra', [master.login.success, master.login.role, master.login.redirect], [true, 'master', 'master.html']);
    const admin = await loginAs('VF100');
    equal('admin entra', [admin.login.role, admin.login.redirect, admin.login.session.condominioName], ['admin', 'admin.html', 'Villa Ferrer']);
    const guard = await loginAs('vp103');
    equal('guardia entra (minusculas)', [guard.login.role, guard.login.redirect], ['policia', 'garita.html']);
    const ana = await loginAs('VA101');
    equal('vecino entra', [ana.login.role, ana.login.session.userCasa], ['vecino', 'Casa 12']);
    equal('el login no devuelve datos de otros', Object.keys(ana.login.user).sort(), ['casa', 'condominioId', 'id', 'name', 'role']);

    // ───────── Sin sesion / anonimo ─────────
    console.log('\nSin sesion');
    await denied('sin sesion no lee condominios', () => getDocs(collection(nobody.db, 'condominios')));
    await denied('sin sesion no lee codigos', () => getDocs(collection(nobody.db, 'codigos')));
    await denied('sin sesion no lee datos privados', () => getDoc(doc(nobody.db, '_privado/auth')));
    const anon = client();
    await signInAnonymously(anon.auth);
    await denied('anonimo no lee condominios', () => getDoc(doc(anon.db, `condominios/${A}`)));
    await denied('anonimo no lee mensajes globales', () => getDocs(collection(anon.db, 'mensajes_globales')));
    await denied('anonimo no lee usuarios', () => getDocs(collection(anon.db, `condominios/${A}/usuarios`)));

    // ───────── Master ─────────
    console.log('\nMaster');
    await allowed('master lista condominios', async () => {
        const snap = await getDocs(collection(master.db, 'condominios'));
        if (snap.size !== 3) throw new Error(`esperaba 3, hay ${snap.size}`);
    });
    await allowed('master lista todos los usuarios', async () => {
        const snap = await getDocs(collectionGroup(master.db, 'usuarios'));
        if (snap.size !== 8) throw new Error(`esperaba 8, hay ${snap.size}`);
    });
    await allowed('master lee codigos', () => getDocs(collection(master.db, 'codigos')));
    await allowed('master cambia ajustes de condominio', () => updateDoc(doc(master.db, `condominios/${B}`), { hasLPR: true }));
    await denied('master no lee datos privados', () => getDoc(doc(master.db, '_privado/auth')));

    // ───────── Admin ─────────
    console.log('\nAdmin de Villa Ferrer');
    await allowed('admin lee usuarios propios', () => getDocs(collection(admin.db, `condominios/${A}/usuarios`)));
    await allowed('admin lee codigos propios', () => getDocs(query(collection(admin.db, 'codigos'), where('condominioId', '==', A))));
    await denied('admin no lee usuarios de otro condominio', () => getDocs(collection(admin.db, `condominios/${B}/usuarios`)));
    await denied('admin no lee codigos de otro condominio', () => getDocs(query(collection(admin.db, 'codigos'), where('condominioId', '==', B))));
    await denied('admin no lee todos los codigos', () => getDocs(collection(admin.db, 'codigos')));
    await denied('admin no lista condominios', () => getDocs(collection(admin.db, 'condominios')));
    await denied('admin no edita su condominio', () => updateDoc(doc(admin.db, `condominios/${A}`), { active: true }));
    await denied('admin no usa consultas globales', () => getDocs(collectionGroup(admin.db, 'usuarios')));

    const newUser = { id: 'u-nuevo', condominioId: A, name: 'Nuevo Vecino', role: 'vecino', casa: 'Casa 1', phone: '1', email: '', paymentStatus: 'al_dia', morosoSince: null, active: true, createdAt: new Date().toISOString() };
    await allowed('admin crea usuario con codigo', () => {
        const batch = writeBatch(admin.db);
        batch.set(doc(admin.db, 'codigos/VN555'), { condominioId: A, userId: 'u-nuevo', role: 'vecino', createdAt: newUser.createdAt });
        batch.set(doc(admin.db, `condominios/${A}/usuarios/u-nuevo`), newUser);
        return batch.commit();
    });
    await denied('codigo ocupado rechaza la escritura', () => setDoc(doc(admin.db, 'codigos/VA101'), { condominioId: A, userId: 'u-nuevo', role: 'vecino', createdAt: newUser.createdAt }));
    await denied('admin no crea codigo para otro condominio', () => setDoc(doc(admin.db, 'codigos/XX999'), { condominioId: B, userId: 'u-x', role: 'vecino', createdAt: newUser.createdAt }));
    await denied('admin no crea usuario master', () => setDoc(doc(admin.db, `condominios/${A}/usuarios/u-malo`), { ...newUser, id: 'u-malo', role: 'master' }));
    await denied('admin no guarda el codigo dentro del usuario', () => setDoc(doc(admin.db, `condominios/${A}/usuarios/u-malo`), { ...newUser, id: 'u-malo', accessCode: 'AA111' }));
    await denied('admin no crea usuario en otro condominio', () => setDoc(doc(admin.db, `condominios/${B}/usuarios/u-malo`), { ...newUser, id: 'u-malo', condominioId: B }));
    await allowed('admin marca moroso', () => updateDoc(doc(admin.db, `condominios/${A}/usuarios/u-nuevo`), { paymentStatus: 'moroso', morosoSince: new Date().toISOString() }));
    await allowed('admin envia mensaje', () => setDoc(doc(admin.db, `condominios/${A}/mensajes/msg-test`), { id: 'msg-test', condominioId: A, fromName: 'Admin', toRole: 'all', subject: 'Hola', body: 'Prueba', read: false, createdAt: new Date().toISOString() }));
    await denied('admin no borra mensajes globales', () => deleteDoc(doc(admin.db, 'mensajes_globales/msg-global')));
    const nuevo = await loginAs('VN555');
    equal('el usuario nuevo puede entrar con su codigo', [nuevo.login.success, nuevo.login.role], [true, 'vecino']);

    // ───────── Guardia ─────────
    console.log('\nGuardia de Villa Ferrer');
    await allowed('guardia lee vecinos', () => getDocs(collection(guard.db, `condominios/${A}/usuarios`)));
    await allowed('guardia lee vehiculos', () => getDocs(collection(guard.db, `condominios/${A}/vehiculos`)));
    await allowed('guardia lee visitas de hoy', () => getDocs(query(collection(guard.db, `condominios/${A}/visitas`), where('visitDate', '==', localDate(0)))));
    await denied('guardia no lee codigos', () => getDocs(query(collection(guard.db, 'codigos'), where('condominioId', '==', A))));
    await denied('guardia no lee un codigo puntual', () => getDoc(doc(guard.db, 'codigos/VF100')));
    await denied('guardia no crea usuarios', () => setDoc(doc(guard.db, `condominios/${A}/usuarios/u-malo`), { ...newUser, id: 'u-malo' }));
    await denied('guardia no edita usuarios', () => updateDoc(doc(guard.db, `condominios/${A}/usuarios/u-ana`), { paymentStatus: 'al_dia' }));
    await denied('guardia no lee otro condominio', () => getDocs(collection(guard.db, `condominios/${B}/vehiculos`)));
    await allowed('guardia registra ingreso de visita', () => updateDoc(doc(guard.db, `condominios/${A}/visitas/vis-maria`), { status: 'entered', enteredAt: new Date().toISOString() }));
    await denied('guardia no cambia otros datos de la visita', () => updateDoc(doc(guard.db, `condominios/${A}/visitas/vis-maria`), { visitorName: 'Otro' }));
    await allowed('guardia registra en historial', () => setDoc(doc(guard.db, `condominios/${A}/camera_logs/log-manual`), { id: 'log-manual', condominioId: A, plate: 'RESIDENTE', status: 'Authorized', reason: 'Acceso QR', createdAt: new Date().toISOString() }));
    await denied('guardia no altera el historial', () => updateDoc(doc(guard.db, `condominios/${A}/camera_logs/log-manual`), { status: 'Denied' }));
    await allowed('guardia lee mensajes para guardias', () => getDocs(query(collection(guard.db, `condominios/${A}/mensajes`), where('toRole', 'in', ['all', 'policia']))));
    await denied('guardia no lee mensajes de vecinos', () => getDocs(collection(guard.db, `condominios/${A}/mensajes`)));

    const verify = httpsCallable(guard.functions, 'verifyAccessCode');
    equal('garita valida codigo de vecino', (await verify({ code: 'va101' })).data.user?.name, 'Ana García');
    equal('garita ve estado moroso', (await verify({ code: 'VM102' })).data.user?.paymentStatus, 'moroso');
    equal('garita no valida codigos de otro condominio', (await verify({ code: 'LJ201' })).data.user, null);
    equal('garita no valida codigos inexistentes', (await verify({ code: 'QQ123' })).data.user, null);

    // ───────── Vecino ─────────
    console.log('\nVecino (Ana)');
    await allowed('vecino lee su ficha', () => getDoc(doc(ana.db, `condominios/${A}/usuarios/u-ana`)));
    await denied('vecino no lee la ficha de otro', () => getDoc(doc(ana.db, `condominios/${A}/usuarios/u-maria`)));
    await denied('vecino no lista vecinos', () => getDocs(collection(ana.db, `condominios/${A}/usuarios`)));
    await allowed('vecino lee sus visitas', async () => {
        const snap = await getDocs(query(collection(ana.db, `condominios/${A}/visitas`), where('userId', '==', 'u-ana')));
        if (snap.size !== 3) throw new Error(`esperaba 3, hay ${snap.size}`);
    });
    await denied('vecino no lee visitas de otros', () => getDocs(collection(ana.db, `condominios/${A}/visitas`)));
    await denied('vecino no lee visitas ajenas por usuario', () => getDocs(query(collection(ana.db, `condominios/${A}/visitas`), where('userId', '==', 'u-maria'))));
    const visit = { id: 'vis-nueva', condominioId: A, userId: 'u-ana', visitorName: 'Amigo', visitorInfo: '', vehiclePlate: 'P-777NEW', plateNorm: 'P777NEW', visitDate: localDate(0), visitTime: null, casa: 'Casa 12', qrCode: 'VISNEW1', status: 'pending', visitType: null, endDate: null, enteredAt: null, createdAt: new Date().toISOString() };
    await allowed('vecino crea su visita', () => setDoc(doc(ana.db, `condominios/${A}/visitas/vis-nueva`), visit));
    await allowed('vecino la convierte en temporal', () => updateDoc(doc(ana.db, `condominios/${A}/visitas/vis-nueva`), { visitType: 'temporal', endDate: localDate(7) }));
    await denied('vecino no crea visitas a nombre de otro', () => setDoc(doc(ana.db, `condominios/${A}/visitas/vis-mala`), { ...visit, id: 'vis-mala', userId: 'u-maria' }));
    await denied('vecino no se adueña de visitas ajenas', () => updateDoc(doc(ana.db, `condominios/${A}/visitas/vis-maria`), { userId: 'u-ana' }));
    await allowed('vecino registra su vehiculo', () => setDoc(doc(ana.db, `condominios/${A}/vehiculos/veh-nuevo`), { id: 'veh-nuevo', condominioId: A, userId: 'u-ana', plate: 'P-888NEW', plateNorm: 'P888NEW', brand: '', model: '', color: '', marbeteCode: 'MARNEW1', createdAt: new Date().toISOString() }));
    await allowed('vecino elimina su vehiculo', () => deleteDoc(doc(ana.db, `condominios/${A}/vehiculos/veh-nuevo`)));
    await denied('vecino no elimina vehiculos ajenos', () => deleteDoc(doc(ana.db, `condominios/${A}/vehiculos/veh-maria-1`)));
    await denied('vecino no lee vehiculos ajenos', () => getDocs(collection(ana.db, `condominios/${A}/vehiculos`)));
    await allowed('vecino lee sus mensajes', async () => {
        const snap = await getDocs(query(collection(ana.db, `condominios/${A}/mensajes`), where('toRole', 'in', ['all', 'vecino'])));
        if (snap.size !== 2) throw new Error(`esperaba 2, hay ${snap.size}`);
    });
    await denied('vecino no lee mensajes de guardias', () => getDoc(doc(ana.db, `condominios/${A}/mensajes/msg-guardias`)));
    await allowed('vecino lee mensajes globales', () => getDocs(collection(ana.db, 'mensajes_globales')));
    await allowed('vecino marca mensaje leido', () => updateDoc(doc(ana.db, `condominios/${A}/mensajes/msg-vecinos`), { read: true }));
    await denied('vecino no edita el texto del mensaje', () => updateDoc(doc(ana.db, `condominios/${A}/mensajes/msg-vecinos`), { body: 'hackeado' }));
    await denied('vecino no se cambia el estado de pago', () => updateDoc(doc(ana.db, `condominios/${A}/usuarios/u-ana`), { paymentStatus: 'al_dia' }));
    await denied('vecino no escribe historial', () => setDoc(doc(ana.db, `condominios/${A}/camera_logs/log-malo`), { id: 'log-malo', condominioId: A, plate: 'X', status: 'Authorized', reason: '', createdAt: new Date().toISOString() }));
    await denied('vecino no usa la verificacion de garita', () => httpsCallable(ana.functions, 'verifyAccessCode')({ code: 'VF100' }));

    // ───────── Camara LPR ─────────
    console.log('\nCamara LPR');
    const itms = (plate) => ({ Picture: { Plate: { PlateNumber: plate }, SnapInfo: { DeviceID: 'CAM-01' } } });

    let r = await camera({ condominioId: A }, itms('P987XYZ'));
    equal('vecino al dia abre', [r.body.Command, r.body.Plate], ['Open', 'P987XYZ']);
    r = await camera({ condominioId: A }, itms('P987XYZ'));
    equal('aviso repetido se ignora', r.body.Message, 'Duplicate skipped');
    r = await camera({ condominioId: A }, itms('P-111-MOR'));
    equal('moroso en periodo de gracia abre', r.body.Command, 'Open');
    r = await camera({ condominioId: A }, itms('P123ABC'));
    equal('visita programada abre', [r.body.Command, r.body.Reason], ['Open', 'Visita programada: Roberto Herrera']);
    r = await camera({ condominioId: A }, itms('M456DEF'));
    equal('vecino temporal vigente abre', r.body.Command, 'Open');
    r = await camera({ condominioId: A }, itms('P999OLD'));
    equal('visita pendiente muy vieja no abre', r.body.Command, 'Close');
    r = await camera({ condominioId: A }, itms('P000ZZZ'));
    equal('placa desconocida no abre', [r.body.Command, r.body.Reason], ['Close', 'Placa no registrada']);
    r = await camera({ condominioId: B }, itms('P555AAA'));
    equal('moroso sin periodo de gracia no abre', r.body.Command, 'Close');
    r = await camera({ condominioId: B }, itms('P222BBB'));
    equal('placa de otro condominio no abre', r.body.Command, 'Close');
    r = await camera({ id: A }, { PlateNumber: 'p-222-bbb' });
    equal('acepta ?id= y formato simple', [r.body.Command, r.body.Plate], ['Open', 'P222BBB']);
    r = await camera({}, { Picture: { Plate: { PlateNumber: 'P777NEW' }, SnapInfo: { DeviceID: A } } });
    equal('toma el condominio del DeviceID', r.body.Command, 'Open');

    const form = new FormData();
    form.append('info', JSON.stringify({ Events: [] }));
    form.append('file', new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }), 'P333MAR-20260929114824-plate.jpg');
    r = await camera({ condominioId: A }, form, {});
    equal('lee la placa del nombre de la foto', r.body.Plate, 'P333MAR');

    r = await camera({ condominioId: A }, '<Event><PlateNumber>P-000-XML</PlateNumber></Event>', { 'Content-Type': 'text/xml' });
    equal('lee la placa en XML', r.body.Plate, 'P000XML');
    r = await camera({ condominioId: A }, { Heartbeat: true });
    equal('latido sin placa responde sin abrir', [r.status, r.body.Plate], [200, 'NOPLATE']);
    r = await camera({}, { PlateNumber: 'P444SIN' });
    equal('sin condominio se registra aparte', r.body.error, 'condominioId is required, but event was logged');
    r = await camera({ condominioId: 'no-existe' }, itms('P987XYZ'));
    equal('condominio inexistente no abre', r.body.Command, 'Close');

    const logs = await getDocs(collection(admin.db, `condominios/${A}/camera_logs`));
    const byPlate = Object.fromEntries(logs.docs.map((d) => [d.data().plate, d.data().status]));
    equal('historial guarda los estados', [byPlate.P987XYZ, byPlate.P111MOR, byPlate.P123ABC, byPlate.P000ZZZ, byPlate.NOPLATE],
        ['Authorized', 'Reminder', 'Authorized', 'Denied', undefined]);
    const visitSnap = await getDoc(doc(admin.db, `condominios/${A}/visitas/vis-hoy`));
    equal('la visita queda marcada como ingresada', visitSnap.data().status, 'entered');
    const orphans = await getDocs(collection(master.db, 'camera_logs_huerfanos'));
    equal('lecturas sin condominio quedan para el master', orphans.size, 2);

    // ───────── Revocacion inmediata ─────────
    console.log('\nRevocacion');
    await allowed('admin desactiva a un vecino', () => updateDoc(doc(admin.db, `condominios/${A}/usuarios/u-nuevo`), { active: false }));
    await denied('vecino desactivado pierde acceso al instante', () => getDoc(doc(nuevo.db, `condominios/${A}/usuarios/u-nuevo`)));
    equal('vecino desactivado no puede entrar', (await httpsCallable(nobody.functions, 'login')({ code: 'VN555' })).data.error, 'Usuario inactivo. Contacte al administrador.');
    await allowed('master suspende el condominio', () => updateDoc(doc(master.db, `condominios/${B}`), { active: false }));
    const lucia = await httpsCallable(nobody.functions, 'login')({ code: 'LL200' });
    equal('condominio suspendido no entra', lucia.data.error, 'El condominio no está activo');

    // ───────── Borrado de condominio ─────────
    console.log('\nBorrado de condominio');
    await denied('admin no elimina condominios', () => httpsCallable(admin.functions, 'deleteCondominio')({ condominioId: B }));
    await allowed('master elimina condominio', () => httpsCallable(master.functions, 'deleteCondominio')({ condominioId: C }));
    const left = await getDocs(collection(master.db, 'condominios'));
    equal('quedan 2 condominios', left.size, 2);
    const orphanCodes = await getDocs(query(collection(master.db, 'codigos'), where('condominioId', '==', C)));
    equal('sus codigos se eliminan', orphanCodes.size, 0);
    const orphanUsers = await getDocs(collection(master.db, `condominios/${C}/usuarios`));
    equal('sus usuarios se eliminan', orphanUsers.size, 0);

    // ───────── Limite de intentos ─────────
    console.log('\nLimite de intentos');
    let blocked = null;
    // El limite es 30 intentos por IP cada 15 minutos (todo un condominio comparte la IP)
    for (let i = 0; i < 32; i++) {
        const attempt = await httpsCallable(nobody.functions, 'login')({ code: `ZZ${100 + i}` });
        if (/Demasiados intentos/.test(attempt.data.error || '')) { blocked = i; break; }
    }
    record('bloquea tras varios codigos invalidos', blocked !== null, `-> nunca bloqueo`);
    const lockedOut = await httpsCallable(nobody.functions, 'login')({ code: 'VF100' });
    equal('durante el bloqueo tampoco entra un codigo valido', lockedOut.data.success, false);

    console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
    if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
}

run().then(() => process.exit(failures.length ? 1 : 0)).catch((e) => { console.error('Error fatal:', e); process.exit(2); });
