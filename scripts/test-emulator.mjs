// Pruebas de extremo a extremo contra los emuladores: login, reglas por rol, privilegios por usuario y webhook de camara.
// Uso: levantar emuladores, correr seed-emulator.mjs y luego este archivo.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import {
    getFirestore, connectFirestoreEmulator, collection, collectionGroup, doc, getDoc, getDocs,
    setDoc, updateDoc, deleteDoc, deleteField, writeBatch, query, where, orderBy
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { PROJECT_ID, EMULATOR, localDate, isoDaysAgo } from './lib.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./dev-seed.json', import.meta.url), 'utf8'));
// Catalogo de privilegios (el mismo archivo que cargan las paginas)
const PRIV = createRequire(import.meta.url)('../privilegios.js');
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

// Espera hasta que fn() devuelva algo verdadero (los disparadores de Firestore son asincronos)
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

// Periodo de cuota 'YYYY-MM' de hace n meses, en hora de Guatemala
function periodMonthsAgo(n) {
    const [y, m] = localDate(0).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
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
    const auditor = await loginAs('VS104');
    equal('auditor entra a su panel', [auditor.login.role, auditor.login.redirect], ['auditor', 'auditor.html']);

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
        if (snap.size !== 10) throw new Error(`esperaba 10, hay ${snap.size}`);
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
    await allowed('admin crea un auditor', () => {
        const batch = writeBatch(admin.db);
        batch.set(doc(admin.db, 'codigos/VA556'), { condominioId: A, userId: 'u-auditor2', role: 'auditor', createdAt: newUser.createdAt });
        batch.set(doc(admin.db, `condominios/${A}/usuarios/u-auditor2`), { ...newUser, id: 'u-auditor2', name: 'Auditor Nuevo', role: 'auditor', casa: '', paymentStatus: null });
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
    await allowed('vecino marca mensaje global leido', () => updateDoc(doc(ana.db, 'mensajes_globales/msg-global'), { read: true }));
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

    // ───────── Auditor: lee todo su condominio, no escribe nada ─────────
    console.log('\nAuditor de Villa Ferrer');
    const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await allowed('auditor lee su condominio', () => getDoc(doc(auditor.db, `condominios/${A}`)));
    await allowed('auditor lee todos los usuarios', async () => {
        const snap = await getDocs(collection(auditor.db, `condominios/${A}/usuarios`));
        if (snap.size < 5) throw new Error(`esperaba 5 o mas, hay ${snap.size}`);
    });
    await allowed('auditor lee todas las visitas', () => getDocs(collection(auditor.db, `condominios/${A}/visitas`)));
    await allowed('auditor lee visitas por rango de fechas', () => getDocs(query(collection(auditor.db, `condominios/${A}/visitas`),
        where('visitDate', '>=', localDate(-30)), where('visitDate', '<=', localDate(0)))));
    await allowed('auditor lee todos los vehiculos', () => getDocs(collection(auditor.db, `condominios/${A}/vehiculos`)));
    await allowed('auditor lee el historial de accesos por rango', async () => {
        const snap = await getDocs(query(collection(auditor.db, `condominios/${A}/camera_logs`),
            where('createdAt', '>=', isoDaysAgo(1)), where('createdAt', '<', tomorrowIso), orderBy('createdAt', 'desc')));
        if (snap.size === 0) throw new Error('el historial vino vacio');
    });
    await allowed('auditor lee todos los mensajes del condominio', async () => {
        const snap = await getDocs(collection(auditor.db, `condominios/${A}/mensajes`));
        if (snap.size < 3) throw new Error(`esperaba 3 o mas, hay ${snap.size}`);
    });
    await allowed('auditor lee mensajes globales', () => getDocs(collection(auditor.db, 'mensajes_globales')));
    await denied('auditor no lee codigos de acceso', () => getDocs(query(collection(auditor.db, 'codigos'), where('condominioId', '==', A))));
    await denied('auditor no lee un codigo puntual', () => getDoc(doc(auditor.db, 'codigos/VF100')));
    await denied('auditor no lee otro condominio', () => getDocs(collection(auditor.db, `condominios/${B}/usuarios`)));
    await denied('auditor no usa consultas globales', () => getDocs(collectionGroup(auditor.db, 'usuarios')));
    await denied('auditor no crea usuarios', () => setDoc(doc(auditor.db, `condominios/${A}/usuarios/u-malo`), { ...newUser, id: 'u-malo' }));
    await denied('auditor no edita usuarios', () => updateDoc(doc(auditor.db, `condominios/${A}/usuarios/u-maria`), { paymentStatus: 'al_dia' }));
    await denied('auditor no se edita a si mismo', () => updateDoc(doc(auditor.db, `condominios/${A}/usuarios/u-sofia`), { role: 'admin' }));
    await denied('auditor no elimina usuarios', () => deleteDoc(doc(auditor.db, `condominios/${A}/usuarios/u-maria`)));
    await denied('auditor no crea codigos', () => setDoc(doc(auditor.db, 'codigos/VZ999'), { condominioId: A, userId: 'u-sofia', role: 'admin', createdAt: new Date().toISOString() }));
    await denied('auditor no crea visitas', () => setDoc(doc(auditor.db, `condominios/${A}/visitas/vis-aud`), { ...visit, id: 'vis-aud', userId: 'u-sofia' }));
    await denied('auditor no marca ingresos', () => updateDoc(doc(auditor.db, `condominios/${A}/visitas/vis-vieja`), { status: 'entered', enteredAt: new Date().toISOString() }));
    await denied('auditor no elimina visitas', () => deleteDoc(doc(auditor.db, `condominios/${A}/visitas/vis-vieja`)));
    await denied('auditor no registra vehiculos', () => setDoc(doc(auditor.db, `condominios/${A}/vehiculos/veh-aud`), { id: 'veh-aud', condominioId: A, userId: 'u-sofia', plate: 'P-000AUD', plateNorm: 'P000AUD', brand: '', model: '', color: '', marbeteCode: 'MARAUD1', createdAt: new Date().toISOString() }));
    await denied('auditor no elimina vehiculos', () => deleteDoc(doc(auditor.db, `condominios/${A}/vehiculos/veh-ana-1`)));
    await denied('auditor no escribe historial', () => setDoc(doc(auditor.db, `condominios/${A}/camera_logs/log-aud`), { id: 'log-aud', condominioId: A, plate: 'X', status: 'Authorized', reason: '', createdAt: new Date().toISOString() }));
    await denied('auditor no borra historial', () => deleteDoc(doc(auditor.db, `condominios/${A}/camera_logs/log-manual`)));
    await denied('auditor no envia mensajes', () => setDoc(doc(auditor.db, `condominios/${A}/mensajes/msg-aud`), { id: 'msg-aud', condominioId: A, fromName: 'Auditor', toRole: 'all', subject: 'x', body: 'x', read: false, createdAt: new Date().toISOString() }));
    await denied('auditor no marca mensajes como leidos', () => updateDoc(doc(auditor.db, `condominios/${A}/mensajes/msg-test`), { read: true }));
    await denied('auditor no marca mensajes globales', () => updateDoc(doc(auditor.db, 'mensajes_globales/msg-global'), { read: false }));
    await denied('auditor no edita su condominio', () => updateDoc(doc(auditor.db, `condominios/${A}`), { hasLPR: false }));
    await denied('auditor no usa la verificacion de garita', () => httpsCallable(auditor.functions, 'verifyAccessCode')({ code: 'VF100' }));
    await denied('auditor no elimina condominios', () => httpsCallable(auditor.functions, 'deleteCondominio')({ condominioId: B }));

    // ───────── Sistema Financiero (OIKOS) ─────────
    console.log('\nSistema Financiero');
    // Una sola base de vecinos: finanzas_residentes guarda solo los datos financieros del vecino (mismo id)
    const finRes = { id: 'u-ana', dpi: '1234567890101', lot: '', notes: 'Paga por transferencia', feeFrom: '2026-11', updated_at: new Date().toISOString() };
    const finTx = { id: 'fee_u-ana_2026-11', date: new Date().toISOString(), type: 'charge', kind: 'fee', period: '2026-11', amount: 500, concept: 'Cuota - Noviembre 2026', resiId: 'u-ana', auto: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const finRef = (col, id) => (c) => doc(c.db, `condominios/${A}/${col}/${id}`);
    await allowed('admin guarda los datos financieros de un vecino', () => setDoc(finRef('finanzas_residentes', finRes.id)(admin), finRes));
    await allowed('admin edita el vecino desde finanzas', () => updateDoc(doc(admin.db, `condominios/${A}/usuarios/u-ana`), { phone: '+50255555678', updatedAt: new Date().toISOString() }));
    await allowed('residente nuevo en finanzas crea el vecino con su codigo', () => {
        const batch = writeBatch(admin.db);
        const now = new Date().toISOString();
        batch.set(doc(admin.db, 'codigos/VF777'), { condominioId: A, userId: '1731000000000', role: 'vecino', createdAt: now });
        batch.set(doc(admin.db, `condominios/${A}/usuarios/1731000000000`), { id: '1731000000000', condominioId: A, name: 'Vecino Desde Finanzas', role: 'vecino', casa: '013', phone: '', email: '', paymentStatus: 'al_dia', morosoSince: null, active: true, createdAt: now, updatedAt: now });
        batch.set(finRef('finanzas_residentes', '1731000000000')(admin), { id: '1731000000000', dpi: '999', createdAt: now, updated_at: now });
        return batch.commit();
    });
    equal('el vecino creado desde finanzas puede entrar', (await httpsCallable(nobody.functions, 'login')({ code: 'VF777' })).data.role, 'vecino');
    await allowed('admin registra un cargo', () => setDoc(finRef('finanzas_movimientos', finTx.id)(admin), finTx));
    await allowed('admin registra un pago con comprobante', () => setDoc(finRef('finanzas_movimientos', '1730000000099')(admin), { id: '1730000000099', type: 'income', amount: 500, concept: 'Cuota', resiId: finRes.id, receiptNum: 'AG-0001', receiptImg: 'data:image/jpeg;base64,AAAA', date: new Date().toISOString(), updated_at: new Date().toISOString() }));
    await allowed('admin anula un movimiento', () => setDoc(finRef('finanzas_movimientos', finTx.id)(admin), { ...finTx, deleted: true, updated_at: new Date().toISOString() }));
    await denied('admin no borra movimientos', () => deleteDoc(finRef('finanzas_movimientos', finTx.id)(admin)));
    await denied('movimiento sin id es rechazado', () => setDoc(finRef('finanzas_movimientos', 'sin-id')(admin), { type: 'income', amount: 1 }));
    await denied('comprobante demasiado grande es rechazado', () => setDoc(finRef('finanzas_movimientos', 'grande')(admin), { id: 'grande', type: 'income', amount: 1, receiptImg: 'x'.repeat(950000) }));
    await allowed('admin guarda la configuracion', () => setDoc(finRef('finanzas_config', 'oikos_settings')(admin), { currency: 'GTQ', fee: 500, chargeDay: 1, updated_at: new Date().toISOString() }));
    await denied('configuracion con otro nombre es rechazada', () => setDoc(finRef('finanzas_config', 'otra')(admin), { currency: 'GTQ' }));
    await allowed('admin lee el sistema financiero', async () => {
        const snap = await getDocs(collection(admin.db, `condominios/${A}/finanzas_movimientos`));
        if (snap.size !== 2) throw new Error(`esperaba 2, hay ${snap.size}`);
    });
    await allowed('auditor lee el sistema financiero', async () => {
        await getDocs(collection(auditor.db, `condominios/${A}/finanzas_residentes`));
        await getDocs(collection(auditor.db, `condominios/${A}/finanzas_movimientos`));
        await getDoc(finRef('finanzas_config', 'oikos_settings')(auditor));
    });
    await denied('auditor no escribe en el sistema financiero', () => setDoc(finRef('finanzas_movimientos', 'aud-1')(auditor), { id: 'aud-1', type: 'income', amount: 1 }));
    await denied('auditor no cambia la configuracion financiera', () => setDoc(finRef('finanzas_config', 'oikos_settings')(auditor), { currency: 'USD' }));
    await allowed('master lee el sistema financiero', () => getDocs(collection(master.db, `condominios/${A}/finanzas_movimientos`)));
    await denied('master no escribe en el sistema financiero', () => setDoc(finRef('finanzas_movimientos', 'mas-1')(master), { id: 'mas-1', type: 'income', amount: 1 }));
    await denied('guardia no lee el sistema financiero', () => getDocs(collection(guard.db, `condominios/${A}/finanzas_movimientos`)));
    await denied('guardia no ve el DPI ni las notas de los vecinos', () => getDoc(finRef('finanzas_residentes', 'u-ana')(guard)));
    await denied('vecino no lee el sistema financiero', () => getDocs(collection(ana.db, `condominios/${A}/finanzas_residentes`)));
    await denied('vecino no ve su propio registro financiero', () => getDoc(finRef('finanzas_residentes', finRes.id)(ana)));
    const luciaFin = await loginAs('LL200');
    await denied('admin de otro condominio no lee', () => getDocs(collection(luciaFin.db, `condominios/${A}/finanzas_movimientos`)));
    await denied('admin de otro condominio no escribe', () => setDoc(finRef('finanzas_movimientos', 'ajeno')(luciaFin), { id: 'ajeno', type: 'income', amount: 1 }));
    await allowed('admin de otro condominio usa el suyo', () => setDoc(doc(luciaFin.db, `condominios/${B}/finanzas_config/oikos_settings`), { currency: 'GTQ' }));

    // ───────── Mora automatica: el Sistema Financiero decide el estado de pago ─────────
    console.log('\nMora automatica');
    const condoA = () => getDoc(doc(admin.db, `condominios/${A}`)).then((d) => d.data());
    const vecinoA = (id) => getDoc(doc(admin.db, `condominios/${A}/usuarios/${id}`)).then((d) => d.data());
    await waitFor('el primer cargo activa la mora automatica del condominio', async () => (await condoA()).moraAutomatica === true);
    await waitFor('el servidor prepara los datos financieros de cada vecino', async () => {
        const extra = await getDoc(finRef('finanzas_residentes', 'u-maria')(admin));
        return extra.exists() && extra.data().feeFrom === periodMonthsAgo(0);
    });
    await waitFor('en modo automatico el servidor genera la cuota del mes', async () => {
        const fee = await getDoc(finRef('finanzas_movimientos', `fee_u-maria_${periodMonthsAgo(0)}`)(admin));
        return fee.exists() && fee.data().serverGenerated === true && fee.data().amount === 500 && fee.data().type === 'charge';
    });
    await waitFor('una sola cuota vencida no lo hace moroso para la garita', async () => (await vecinoA('u-maria')).paymentStatus === 'al_dia');

    // Ana: dos cuotas vencidas de 750 (ya tiene un pago de 500) -> debe 1000, mas de una cuota
    const now = new Date().toISOString();
    for (const [i, period] of [[1, periodMonthsAgo(2)], [2, periodMonthsAgo(1)]]) {
        await setDoc(finRef('finanzas_movimientos', `mora_test_${i}`)(admin), { id: `mora_test_${i}`, date: now, type: 'charge', kind: 'fee', period, amount: 750, concept: 'Cuota de prueba', resiId: 'u-ana', created_at: now, updated_at: now });
    }
    const anaMorosa = await waitFor('dos cuotas vencidas: el vecino queda moroso', async () => {
        const v = await vecinoA('u-ana');
        return v.paymentStatus === 'moroso' && v.morosoSince ? v : null;
    });
    await denied('con mora automatica el admin no cambia el estado de pago a mano', () => updateDoc(doc(admin.db, `condominios/${A}/usuarios/u-ana`), { paymentStatus: 'al_dia', morosoSince: null }));
    await allowed('el admin sigue editando los demas datos del vecino', () => updateDoc(doc(admin.db, `condominios/${A}/usuarios/u-ana`), { casa: 'Casa 12', updatedAt: new Date().toISOString() }));

    await setDoc(doc(admin.db, `condominios/${A}/vehiculos/veh-ana-fin`), { id: 'veh-ana-fin', condominioId: A, userId: 'u-ana', plate: 'P-321FIN', plateNorm: 'P321FIN', brand: '', model: '', color: '', marbeteCode: 'MARFIN1', createdAt: now });
    r = await camera({ condominioId: A }, itms('P321FIN'));
    equal('la camara lo deja pasar con aviso de mora', [r.body.Command, /MOROSO/.test(r.body.Reason || '')], ['Open', true]);

    await setDoc(finRef('finanzas_movimientos', 'mora_test_pago')(admin), { id: 'mora_test_pago', date: now, type: 'income', amount: 1000, concept: 'Pago', resiId: 'u-ana', receiptNum: 'AG-0002', created_at: now, updated_at: now });
    await waitFor('al pagar vuelve a estar al dia al instante', async () => {
        const v = await vecinoA('u-ana');
        return v.paymentStatus === 'al_dia' && v.morosoSince === null;
    });
    await setDoc(doc(admin.db, `condominios/${A}/vehiculos/veh-ana-fin2`), { id: 'veh-ana-fin2', condominioId: A, userId: 'u-ana', plate: 'P-654FIN', plateNorm: 'P654FIN', brand: '', model: '', color: '', marbeteCode: 'MARFIN2', createdAt: now });
    r = await camera({ condominioId: A }, itms('P654FIN'));
    equal('ya al dia, la camara abre normal', [r.body.Command, /Vecino permanente/.test(r.body.Reason || '')], ['Open', true]);
    equal('el moroso conservo su fecha de inicio mientras estuvo en mora', typeof (anaMorosa && anaMorosa.morosoSince), 'string');

    // ───────── Rondas (traido de SISDEL RONDIN) ─────────
    console.log('\nRondas');
    const sup = await loginAs('VO105');
    equal('supervisor entra al panel de rondas', [sup.login.role, sup.login.redirect], ['supervisor', 'rondin/']);
    const rref = (c, col, id) => doc(c.db, `condominios/${A}/${col}/${id}`);
    const rcol = (c, col) => collection(c.db, `condominios/${A}/${col}`);
    const ts = () => new Date().toISOString();
    // Formato de SISDEL RONDIN (rondin/js/sisdel-api.js): company_id, guard_id..., fechas 'AAAA-MM-DD HH:MM:SS'
    const sqlTs = () => ts().replace('T', ' ').slice(0, 19);

    await allowed('el vecino lee la configuracion de RONDIN', () => getDoc(rref(ana, 'rondas_config', 'general')));
    equal('el boton de panico de vecinos viene activado en el seed', (await getDoc(rref(ana, 'rondas_config', 'general'))).data().neighbor_panic_enabled, 1);
    await allowed('el supervisor cambia la configuracion de RONDIN', () => setDoc(rref(sup, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 1, updated_at: sqlTs() }, { merge: true }));
    await denied('el guardia no cambia la configuracion', () => setDoc(rref(guard, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 0 }, { merge: true }));
    await denied('el auditor no cambia la configuracion', () => setDoc(rref(auditor, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 0 }, { merge: true }));
    await denied('otra configuracion distinta de general es rechazada', () => setDoc(rref(admin, 'rondas_config', 'otra'), { company_id: A }));

    const rutaTest = {
        id: 'ruta-test', company_id: A, name: 'Ruta de prueba', status: 'ACTIVE', color: '#3B82F6', route_code: 'R-900',
        checkpoints: [{ id: 'cp1', route_id: 'ruta-test', name: 'Punto 1', latitude: 14.5, longitude: -90.4, radius_meters: 25, checkpoint_order: 1, is_mandatory: 1, status: 'ACTIVE' }],
        round_config: null, created_at: sqlTs(), updated_at: sqlTs()
    };
    await allowed('supervisor crea una ruta', () => setDoc(rref(sup, 'rondas_rutas', 'ruta-test'), rutaTest));
    await allowed('admin edita la ruta', () => updateDoc(rref(admin, 'rondas_rutas', 'ruta-test'), { name: 'Ruta de prueba 2' }));
    await denied('guardia no crea rutas', () => setDoc(rref(guard, 'rondas_rutas', 'ruta-mala'), { ...rutaTest, id: 'ruta-mala' }));
    await denied('auditor no crea rutas', () => setDoc(rref(auditor, 'rondas_rutas', 'ruta-mala'), { ...rutaTest, id: 'ruta-mala' }));
    await denied('ruta marcada de otro condominio es rechazada', () => setDoc(rref(sup, 'rondas_rutas', 'ruta-mala'), { ...rutaTest, id: 'ruta-mala', company_id: B }));
    await allowed('guardia ve las rutas', () => getDocs(rcol(guard, 'rondas_rutas')));
    await allowed('auditor ve las rutas', () => getDocs(rcol(auditor, 'rondas_rutas')));
    await denied('vecino no ve las rutas', () => getDocs(rcol(ana, 'rondas_rutas')));
    await denied('admin de otro condominio no ve las rutas', () => getDocs(rcol(luciaFin, 'rondas_rutas')));

    await allowed('guardia ve sus asignaciones', async () => {
        const snap = await getDocs(query(rcol(guard, 'rondas_asignaciones'), where('guard_id', '==', 'u-pedro')));
        if (snap.size !== 1) throw new Error(`esperaba 1, hay ${snap.size}`);
    });
    await denied('guardia no ve las asignaciones de todos', () => getDocs(rcol(guard, 'rondas_asignaciones')));
    const asig = { id: 'asig-test', company_id: A, route_id: 'ruta-test', guard_id: 'u-pedro', shift_type: '12H_DIA', date_start: localDate(40), date_end: localDate(45), hour_start: '08:00', hour_end: '20:00', status: 'ACTIVE', created_at: sqlTs() };
    await allowed('supervisor asigna una ruta', () => setDoc(rref(sup, 'rondas_asignaciones', 'asig-test'), asig));
    await denied('guardia no se asigna rutas', () => setDoc(rref(guard, 'rondas_asignaciones', 'asig-mala'), { ...asig, id: 'asig-mala' }));
    await allowed('supervisor quita la asignacion', () => deleteDoc(rref(sup, 'rondas_asignaciones', 'asig-test')));

    const turno = { id: 'turno-test', company_id: A, guard_id: 'u-pedro', supervisor_id: 'u-pedro', route_id: 'ruta-test', scheduled_start: sqlTs(), scheduled_end: null, actual_start: null, status: 'SCHEDULED', created_at: sqlTs() };
    await allowed('guardia crea su turno', () => setDoc(rref(guard, 'rondas_turnos', 'turno-test'), turno));
    await denied('guardia no crea turno a nombre de otro', () => setDoc(rref(guard, 'rondas_turnos', 'turno-malo'), { ...turno, id: 'turno-malo', guard_id: 'u-otro' }));
    await denied('vecino no crea turnos', () => setDoc(rref(ana, 'rondas_turnos', 'turno-malo'), { ...turno, id: 'turno-malo', guard_id: 'u-ana' }));
    await allowed('guardia hace check-in en su turno', () => updateDoc(rref(guard, 'rondas_turnos', 'turno-test'), { actual_start: sqlTs(), checkin_lat: 14.5, checkin_lng: -90.4, status: 'ACTIVE' }));
    await denied('guardia no pasa su turno a otro', () => updateDoc(rref(guard, 'rondas_turnos', 'turno-test'), { guard_id: 'u-otro' }));
    await allowed('guardia lee su turno activo', () => getDocs(query(rcol(guard, 'rondas_turnos'), where('guard_id', '==', 'u-pedro'), where('status', '==', 'ACTIVE'))));
    await denied('guardia no lee los turnos de todos', () => getDocs(rcol(guard, 'rondas_turnos')));
    const ronda = { id: 'ronda-test', company_id: A, shift_id: 'turno-test', route_id: 'ruta-test', guard_id: 'u-pedro', round_number: 1, started_at: sqlTs(), completed_at: null, score: 0, status: 'IN_PROGRESS', created_at: sqlTs() };
    await allowed('guardia inicia una ronda', () => setDoc(rref(guard, 'rondas_rondas', 'ronda-test'), ronda));
    await denied('una ronda nueva no nace completada', () => setDoc(rref(guard, 'rondas_rondas', 'ronda-mala'), { ...ronda, id: 'ronda-mala', status: 'COMPLETED' }));
    const visita = { id: 'visita-test', company_id: A, round_id: 'ronda-test', shift_id: 'turno-test', route_id: 'ruta-test', checkpoint_id: 'cp1', checkpoint_name: 'Punto 1', guard_id: 'u-pedro', guard_name: 'Pedro', arrived_at: sqlTs(), latitude: 14.5, longitude: -90.4, distance_to_checkpoint: 3, status: 'VALID', created_at: sqlTs() };
    await allowed('guardia marca un punto', () => setDoc(rref(guard, 'rondas_visitas', 'visita-test'), visita));
    await denied('guardia no marca puntos a nombre de otro', () => setDoc(rref(guard, 'rondas_visitas', 'visita-mala'), { ...visita, id: 'visita-mala', guard_id: 'u-otro' }));
    await denied('un punto marcado no se puede cambiar', () => updateDoc(rref(guard, 'rondas_visitas', 'visita-test'), { distance_to_checkpoint: 1 }));
    await denied('un punto marcado no se puede borrar', () => deleteDoc(rref(sup, 'rondas_visitas', 'visita-test')));
    await allowed('guardia busca su visita reciente al punto', () => getDocs(query(rcol(guard, 'rondas_visitas'), where('guard_id', '==', 'u-pedro'), where('checkpoint_id', '==', 'cp1'))));
    await allowed('guardia termina la ronda', () => updateDoc(rref(guard, 'rondas_rondas', 'ronda-test'), { status: 'COMPLETED', score: 100, completed_at: sqlTs() }));
    await denied('guardia no pasa la ronda a otro guardia', () => updateDoc(rref(guard, 'rondas_rondas', 'ronda-test'), { guard_id: 'u-otro' }));
    await allowed('supervisor ve las visitas de la ruta por fecha', () => getDocs(query(rcol(sup, 'rondas_visitas'), where('route_id', '==', 'ruta-test'), where('arrived_at', '>=', '2020-01-01 00:00:00'))));
    await allowed('auditor ve las rondas', () => getDocs(rcol(auditor, 'rondas_rondas')));
    await denied('guardia no ve las rondas de todos', () => getDocs(rcol(guard, 'rondas_rondas')));
    await allowed('guardia hace check-out', () => updateDoc(rref(guard, 'rondas_turnos', 'turno-test'), { actual_end: sqlTs(), status: 'COMPLETED' }));
    await allowed('supervisor corrige el turno', () => updateDoc(rref(sup, 'rondas_turnos', 'turno-test'), { notes: 'Revisado' }));

    const posicion = { user_id: 'u-pedro', company_id: A, name: 'Pedro', role: 'GUARDIA', shift_id: 'turno-test', latitude: 14.5, longitude: -90.4, battery_level: 100, timestamp: sqlTs() };
    await allowed('guardia publica su posicion', () => setDoc(rref(guard, 'rondas_en_vivo', 'u-pedro'), posicion));
    await denied('guardia no publica la posicion de otro', () => setDoc(rref(guard, 'rondas_en_vivo', 'u-otro'), { ...posicion, user_id: 'u-otro' }));
    await allowed('supervisor ve las posiciones en vivo', () => getDocs(rcol(sup, 'rondas_en_vivo')));
    await denied('vecino no ve las posiciones de los guardias', () => getDocs(rcol(ana, 'rondas_en_vivo')));
    await allowed('guardia guarda su historial de posiciones', () => setDoc(rref(guard, 'rondas_ubicaciones', 'ubi-test'), posicion));
    await denied('el historial de posiciones no se edita', () => updateDoc(rref(guard, 'rondas_ubicaciones', 'ubi-test'), { latitude: 0 }));
    await allowed('guardia borra su posicion al terminar el turno', () => deleteDoc(rref(guard, 'rondas_en_vivo', 'u-pedro')));

    const incidente = { id: 'inc-test', company_id: A, reported_by: 'u-pedro', reporter_name: 'Pedro', incident_type: 'ROBBERY', severity: 'HIGH', title: 'Prueba', description: '', photos: '[]', status: 'OPEN', created_at: sqlTs() };
    await allowed('guardia reporta un incidente', () => setDoc(rref(guard, 'rondas_incidentes', 'inc-test'), incidente));
    await denied('vecino no reporta incidentes de ronda', () => setDoc(rref(ana, 'rondas_incidentes', 'inc-malo'), { ...incidente, id: 'inc-malo', reported_by: 'u-ana' }));
    await denied('guardia no reporta a nombre de otro', () => setDoc(rref(guard, 'rondas_incidentes', 'inc-malo'), { ...incidente, id: 'inc-malo', reported_by: 'u-otro' }));
    await denied('guardia no resuelve incidentes', () => updateDoc(rref(guard, 'rondas_incidentes', 'inc-test'), { status: 'RESOLVED' }));
    await allowed('supervisor resuelve el incidente', () => updateDoc(rref(sup, 'rondas_incidentes', 'inc-test'), { status: 'RESOLVED', resolved_by: 'u-samuel', resolved_at: sqlTs() }));
    await allowed('la garita ve los incidentes', () => getDocs(rcol(guard, 'rondas_incidentes')));
    const foto = { id: 'foto-test', company_id: A, data: 'data:image/jpeg;base64,AAAA', kind: 'checkin', ref_id: 'turno-test', by: 'u-pedro', created_at: sqlTs() };
    await allowed('guardia sube una foto', () => setDoc(rref(guard, 'rondas_fotos', 'foto-test'), foto));
    await denied('foto demasiado grande es rechazada', () => setDoc(rref(guard, 'rondas_fotos', 'foto-grande'), { ...foto, id: 'foto-grande', data: 'x'.repeat(950000) }));
    await allowed('auditor ve la foto', () => getDoc(rref(auditor, 'rondas_fotos', 'foto-test')));
    await denied('vecino no ve fotos de rondas', () => getDoc(rref(ana, 'rondas_fotos', 'foto-test')));

    const alerta = { id: 'al-test', company_id: A, alert_type: 'INFO', category: 'CHECKPOINT_VISIT', title: 'Punto visitado: Punto 1', message: '', source_user_id: 'u-pedro', acknowledged: 0, acknowledged_by: null, acknowledged_at: null, created_at: sqlTs() };
    await allowed('guardia deja una alerta en el panel', () => setDoc(rref(guard, 'rondas_alertas', 'al-test'), alerta));
    await denied('guardia no deja alertas a nombre de otro', () => setDoc(rref(guard, 'rondas_alertas', 'al-mala'), { ...alerta, id: 'al-mala', source_user_id: 'u-otro' }));
    await denied('una alerta nueva no nace atendida', () => setDoc(rref(guard, 'rondas_alertas', 'al-mala'), { ...alerta, id: 'al-mala', acknowledged: 1 }));
    await denied('guardia no ve el panel de alertas', () => getDocs(rcol(guard, 'rondas_alertas')));
    await allowed('auditor ve las alertas del panel', () => getDocs(rcol(auditor, 'rondas_alertas')));
    await denied('auditor no atiende alertas del panel', () => updateDoc(rref(auditor, 'rondas_alertas', 'al-test'), { acknowledged: 1, acknowledged_by: 'u-sofia', acknowledged_at: sqlTs() }));
    await denied('supervisor no cambia el texto de la alerta', () => updateDoc(rref(sup, 'rondas_alertas', 'al-test'), { title: 'otro' }));
    await allowed('supervisor atiende la alerta', () => updateDoc(rref(sup, 'rondas_alertas', 'al-test'), { acknowledged: 1, acknowledged_by: 'u-samuel', acknowledged_at: sqlTs() }));
    await allowed('admin borra la alerta', () => deleteDoc(rref(admin, 'rondas_alertas', 'al-test')));

    const dron = { id: 'dron-test', company_id: A, name: 'Dron 1', model: 'X', status: 'ACTIVE', battery_level: 100, created_at: sqlTs() };
    await allowed('admin registra un dron de Rondin Air', () => setDoc(rref(admin, 'rondas_drones', 'dron-test'), dron));
    await denied('guardia no registra drones', () => setDoc(rref(guard, 'rondas_drones', 'dron-malo'), { ...dron, id: 'dron-malo' }));
    await allowed('supervisor despacha el dron', () => updateDoc(rref(sup, 'rondas_drones', 'dron-test'), { status: 'DISPATCHED' }));
    await allowed('auditor ve los drones', () => getDocs(rcol(auditor, 'rondas_drones')));

    // Guardias y supervisores: una sola persona en SISDEL (usuarios + codigos) con su expediente en rondas_personal
    await allowed('auditor ve el expediente de guardias', () => getDoc(rref(auditor, 'rondas_personal', 'u-pedro')));
    await denied('guardia no ve expedientes', () => getDoc(rref(guard, 'rondas_personal', 'u-pedro')));
    await allowed('supervisor asigna un guardia a su cargo', () => setDoc(rref(sup, 'rondas_personal', 'u-pedro'), { id: 'u-pedro', company_id: A, supervisor_id: 'u-samuel', updated_at: sqlTs() }, { merge: true }));
    await denied('el auditor no edita expedientes', () => setDoc(rref(auditor, 'rondas_personal', 'u-pedro'), { id: 'u-pedro', company_id: A, supervisor_id: null }, { merge: true }));
    const nuevoGuardia = (c, userId, code, role = 'policia') => {
        const b = writeBatch(c.db);
        b.set(doc(c.db, `codigos/${code}`), { condominioId: A, userId, role, createdAt: ts() });
        b.set(rref(c, 'usuarios', userId), { id: userId, condominioId: A, name: 'Guardia Nuevo', role, casa: '', phone: '', email: '', paymentStatus: null, morosoSince: null, active: true, createdAt: ts() });
        return b.commit();
    };
    await allowed('supervisor registra un guardia con su codigo', () => nuevoGuardia(sup, 'u-guardia-nuevo', 'VGTEST1'));
    await denied('supervisor no registra administradores', () => nuevoGuardia(sup, 'u-admin-falso', 'VGTEST2', 'admin'));
    await denied('supervisor no crea un codigo para un usuario que ya existe', () => setDoc(doc(sup.db, 'codigos/VGTEST3'), { condominioId: A, userId: 'u-fernando', role: 'policia', createdAt: ts() }));
    await denied('supervisor no crea un codigo extra para otro guardia', () => setDoc(doc(sup.db, 'codigos/VGTEST4'), { condominioId: A, userId: 'u-pedro', role: 'policia', createdAt: ts() }));
    await allowed('supervisor ve los codigos de los guardias', () => getDocs(query(collection(sup.db, 'codigos'), where('condominioId', '==', A), where('role', '==', 'policia'))));
    await denied('supervisor no ve los codigos de los vecinos', () => getDocs(query(collection(sup.db, 'codigos'), where('condominioId', '==', A))));
    {
        const nuevo = await loginAs('VGTEST1');
        equal('el guardia nuevo entra con su codigo a la garita', [nuevo.login.success, nuevo.login.role], [true, 'policia']);
    }

    console.log('\nAlertas de panico');
    const maria = await loginAs('VM102');
    const panico = (id, extra = {}) => ({ id, condominioId: A, source: 'vecino', userId: 'u-ana', userName: 'Ana García', casa: 'Casa 12', phone: '5555-5678', lat: 14.542, lng: -90.453, status: 'ACTIVE', createdAt: ts(), ...extra });
    await allowed('vecino activa el boton de panico', () => setDoc(rref(ana, 'alertas_panico', 'pan-1'), panico('pan-1')));
    await denied('vecino no activa alertas a nombre de otro', () => setDoc(rref(ana, 'alertas_panico', 'pan-x'), panico('pan-x', { userId: 'u-maria' })));
    await denied('vecino no se hace pasar por guardia', () => setDoc(rref(ana, 'alertas_panico', 'pan-x'), panico('pan-x', { source: 'guardia' })));
    await allowed('la garita ve las alertas sin resolver', () => getDocs(query(rcol(guard, 'alertas_panico'), where('status', 'in', ['ACTIVE', 'ATTENDED']))));
    await allowed('el vecino ve su alerta', () => getDoc(rref(ana, 'alertas_panico', 'pan-1')));
    await denied('otro vecino no ve la alerta', () => getDoc(rref(maria, 'alertas_panico', 'pan-1')));
    await denied('un vecino no ve las alertas de todos', () => getDocs(rcol(ana, 'alertas_panico')));
    await waitFor('la alerta avisa por WhatsApp a central, personal y familiares (simulado)', async () => {
        const w = (await getDoc(rref(admin, 'alertas_panico', 'pan-1'))).data().whatsapp;
        if (!w) return false;
        const names = w.recipients.map((r) => r.nombre);
        return w.sent === true && names[0] === 'Central SISDEL' && names.includes('Samuel Ortiz') && names.includes('Luis García') && names.includes('Marta García');
    });
    await allowed('el guardia atiende la alerta', () => updateDoc(rref(guard, 'alertas_panico', 'pan-1'), { status: 'ATTENDED', attendedBy: 'u-pedro', attendedByName: 'Pedro', attendedAt: ts() }));
    await denied('el guardia no cambia los datos de la alerta', () => updateDoc(rref(guard, 'alertas_panico', 'pan-1'), { userName: 'Otro' }));
    await denied('el vecino no marca su alerta como resuelta', () => updateDoc(rref(ana, 'alertas_panico', 'pan-1'), { status: 'RESOLVED' }));
    await allowed('el supervisor resuelve la alerta', () => updateDoc(rref(sup, 'alertas_panico', 'pan-1'), { status: 'RESOLVED', resolvedBy: 'u-samuel', resolvedByName: 'Samuel', resolvedAt: ts(), notes: 'Falsa alarma' }));
    await allowed('vecino activa otra alerta', () => setDoc(rref(ana, 'alertas_panico', 'pan-2'), panico('pan-2')));
    await allowed('el vecino cancela su alerta activa', () => updateDoc(rref(ana, 'alertas_panico', 'pan-2'), { status: 'CANCELLED', cancelledAt: ts() }));
    await denied('una alerta no se borra', () => deleteDoc(rref(admin, 'alertas_panico', 'pan-2')));
    await allowed('el guardia activa su boton de panico', () => setDoc(rref(guard, 'alertas_panico', 'pan-g'), { ...panico('pan-g'), source: 'guardia', userId: 'u-pedro', userName: 'Pedro Ramírez' }));
    await denied('el auditor no atiende alertas', () => updateDoc(rref(auditor, 'alertas_panico', 'pan-g'), { status: 'ATTENDED', attendedBy: 'u-sofia' }));
    await allowed('el auditor ve las alertas', () => getDocs(rcol(auditor, 'alertas_panico')));

    await allowed('vecino guarda sus contactos de emergencia', () => setDoc(rref(ana, 'emergencia', 'u-ana'), { userId: 'u-ana', condominioId: A, contacts: [{ name: 'Luis', phone: '5555-1111' }], updatedAt: ts() }));
    await denied('vecino no edita contactos de otro', () => setDoc(rref(ana, 'emergencia', 'u-maria'), { userId: 'u-maria', condominioId: A, contacts: [], updatedAt: ts() }));
    await denied('no se aceptan mas de 5 contactos', () => setDoc(rref(ana, 'emergencia', 'u-ana'), { userId: 'u-ana', condominioId: A, contacts: Array.from({ length: 6 }, () => ({ name: 'x', phone: '1' })), updatedAt: ts() }));
    await allowed('la garita ve los contactos de emergencia', () => getDoc(rref(guard, 'emergencia', 'u-ana')));
    await denied('otro vecino no ve los contactos', () => getDoc(rref(maria, 'emergencia', 'u-ana')));

    // ───────── Privilegios por usuario (el administrador del condominio los asigna) ─────────
    console.log('\nPrivilegios por usuario');
    const mkUser = (id, name, role, extra = {}) => ({
        id, condominioId: A, name, role, casa: '', phone: '5555-0000', email: '', paymentStatus: role === 'vecino' ? 'al_dia' : null,
        morosoSince: null, active: true, createdAt: ts(), ...extra
    });
    const uref = (c, id) => rref(c, 'usuarios', id);
    // Usuario y codigo en la misma escritura, como hace SISDEL.createUser
    const createUserAs = (c, user, code) => {
        const batch = writeBatch(c.db);
        batch.set(doc(c.db, `codigos/${code}`), { condominioId: A, userId: user.id, role: user.role, createdAt: ts() });
        batch.set(uref(c, user.id), user);
        return batch.commit();
    };
    // Privilegios (solo diferencias con el rol) de una plantilla del sistema
    const tpl = (id) => PRIV.TEMPLATES.find((t) => t.id === id);
    const overridesOf = (templateId, role) => PRIV.toOverrides(role || tpl(templateId).role, tpl(templateId).claves);
    const setPriv = (c, id, privilegios) => updateDoc(uref(c, id), { privilegios });

    // Operador sin privilegios: existe pero no entra a ningun panel
    await allowed('admin crea un operador sin privilegios', () => createUserAs(admin, mkUser('u-op0', 'Operador Vacio', 'operador'), 'PO000'));
    const op0 = await httpsCallable(nobody.functions, 'login')({ code: 'PO000' });
    equal('un operador sin privilegios no entra', [op0.data.success, op0.data.error], [false, 'Su usuario no tiene accesos asignados. Contacte al administrador.']);

    // Secretaria: plantilla del sistema
    await allowed('admin crea a la secretaria con su plantilla', () => createUserAs(admin, mkUser('u-sec', 'Secretaria', 'operador', { cargo: 'Secretaria', privilegios: overridesOf('sys-secretaria') }), 'PS001'));
    const sec = await loginAs('PS001');
    equal('la secretaria entra al panel de administracion', [sec.login.role, sec.login.redirect], ['operador', 'admin.html']);
    equal('el login entrega solo las diferencias con el rol', sec.login.session.privilegios, overridesOf('sys-secretaria'));
    equal('el login entrega el cargo', sec.login.session.cargo, 'Secretaria');
    await allowed('la secretaria lee su propia ficha', () => getDoc(uref(sec, 'u-sec')));
    await allowed('la secretaria lee los usuarios', () => getDocs(rcol(sec, 'usuarios')));
    await denied('la secretaria no lee codigos de acceso', () => getDocs(query(collection(sec.db, 'codigos'), where('condominioId', '==', A))));
    await allowed('la secretaria crea un vecino', () => createUserAs(sec, mkUser('u-v1', 'Vecino de la secretaria', 'vecino', { casa: 'Casa 77' }), 'PV001'));
    await denied('la secretaria no crea guardias (conocería su código y entraría como él)', () => createUserAs(sec, mkUser('u-g1', 'Guardia de la secretaria', 'policia'), 'PG001'));
    await denied('la secretaria no crea auditores', () => createUserAs(sec, mkUser('u-au1', 'Auditor de la secretaria', 'auditor'), 'PU001'));
    await denied('la secretaria no crea supervisores', () => createUserAs(sec, mkUser('u-su1', 'Supervisor de la secretaria', 'supervisor'), 'PU002'));
    await denied('la secretaria no crea administradores', () => createUserAs(sec, mkUser('u-adm-s', 'Admin falso', 'admin'), 'PA001'));
    await denied('la secretaria no crea operadores', () => createUserAs(sec, mkUser('u-op-s', 'Operador falso', 'operador'), 'PA002'));
    await denied('la secretaria no asigna privilegios al crear', () => createUserAs(sec, mkUser('u-v2', 'Vecino con poder', 'vecino', { privilegios: { 'finanzas.usar': true } }), 'PV002'));
    await allowed('la secretaria edita a un vecino', () => updateDoc(uref(sec, 'u-v1'), { phone: '5555-9999' }));
    await denied('la secretaria no edita a un administrador', () => updateDoc(uref(sec, 'u-fernando'), { phone: '5555-0000' }));
    await denied('la secretaria no elimina usuarios', () => deleteDoc(uref(sec, 'u-v1')));
    await denied('la secretaria no cambia privilegios de otros', () => setPriv(sec, 'u-v1', { 'finanzas.usar': true }));
    await denied('la secretaria no se cambia los suyos', () => setPriv(sec, 'u-sec', { ...overridesOf('sys-secretaria'), 'finanzas.usar': true }));
    await denied('la secretaria no cambia el rol de otro', () => updateDoc(uref(sec, 'u-v1'), { role: 'auditor' }));
    await denied('la secretaria no reemplaza el codigo de un usuario', () => setDoc(doc(sec.db, 'codigos/PX001'), { condominioId: A, userId: 'u-v1', role: 'vecino', createdAt: ts() }));
    await denied('la secretaria no apunta un codigo nuevo a un administrador', () => setDoc(doc(sec.db, 'codigos/PX002'), { condominioId: A, userId: 'u-fernando', role: 'vecino', createdAt: ts() }));
    await allowed('la secretaria envia un mensaje', () => setDoc(rref(sec, 'mensajes', 'msg-sec'), { id: 'msg-sec', condominioId: A, fromName: 'Secretaria', toRole: 'all', subject: 'Aviso', body: 'Reunion', read: false, createdAt: ts() }));
    await allowed('la secretaria lee todos los mensajes', () => getDocs(rcol(sec, 'mensajes')));
    await allowed('la secretaria ve las visitas', () => getDocs(rcol(sec, 'visitas')));
    await allowed('la secretaria crea una visita para un vecino', () => setDoc(rref(sec, 'visitas', 'vis-sec'), { id: 'vis-sec', condominioId: A, userId: 'u-ana', visitorName: 'Proveedor', visitorInfo: '', vehiclePlate: '', plateNorm: '', visitDate: localDate(0), visitTime: null, casa: 'Casa 12', qrCode: 'VISSEC', status: 'pending', visitType: null, endDate: null, enteredAt: null, createdAt: ts() }));
    await denied('la secretaria no ve el historial de la camara', () => getDocs(rcol(sec, 'camera_logs')));
    await denied('la secretaria no ve las finanzas', () => getDocs(rcol(sec, 'finanzas_residentes')));
    await denied('la secretaria no administra rondas', () => setDoc(rref(sec, 'rondas_rutas', 'ruta-sec'), { ...rutaTest, id: 'ruta-sec' }));
    await denied('la secretaria no atiende alertas de panico', () => updateDoc(rref(sec, 'alertas_panico', 'pan-g'), { status: 'ATTENDED', attendedBy: 'u-sec' }));
    await denied('la secretaria no usa la verificacion de garita', () => httpsCallable(sec.functions, 'verifyAccessCode')({ code: 'VA101' }));
    await denied('la secretaria no lee las plantillas de privilegios', () => getDocs(rcol(sec, 'plantillas_privilegios')));
    const vecino1 = await loginAs('PV001');
    equal('el vecino creado por la secretaria entra', [vecino1.login.success, vecino1.login.redirect], [true, 'vecino.html']);

    // Efecto inmediato: el administrador le quita un privilegio y la sesion abierta lo siente en la siguiente operacion
    await allowed('admin le quita a la secretaria enviar mensajes', () => setPriv(admin, 'u-sec', { ...overridesOf('sys-secretaria'), 'mensajes.enviar': false }));
    await denied('la secretaria ya no envia mensajes (sin volver a entrar)', () => setDoc(rref(sec, 'mensajes', 'msg-sec2'), { id: 'msg-sec2', condominioId: A, fromName: 'Secretaria', toRole: 'all', subject: 'Otro', body: 'x', read: false, createdAt: ts() }));
    await allowed('admin se lo devuelve', () => setPriv(admin, 'u-sec', overridesOf('sys-secretaria')));
    await allowed('la secretaria vuelve a enviar mensajes', () => setDoc(rref(sec, 'mensajes', 'msg-sec2'), { id: 'msg-sec2', condominioId: A, fromName: 'Secretaria', toRole: 'all', subject: 'Otro', body: 'x', read: false, createdAt: ts() }));
    await allowed('admin desactiva a la secretaria', () => updateDoc(uref(admin, 'u-sec'), { active: false }));
    await denied('la secretaria desactivada pierde todo al instante', () => getDoc(uref(sec, 'u-sec')));
    await allowed('admin la reactiva', () => updateDoc(uref(admin, 'u-sec'), { active: true }));

    // Contador: solo el Sistema Financiero
    await allowed('admin crea al contador', () => createUserAs(admin, mkUser('u-cont', 'Contador', 'operador', { privilegios: overridesOf('sys-contador') }), 'PC001'));
    const cont = await loginAs('PC001');
    equal('el contador entra directo al Sistema Financiero', cont.login.redirect, 'finanzas.html');
    await allowed('el contador lee las finanzas', () => getDocs(rcol(cont, 'finanzas_residentes')));
    await allowed('el contador escribe en las finanzas', () => setDoc(rref(cont, 'finanzas_movimientos', 'fee_u-ana_2026-12'), { ...finTx, id: 'fee_u-ana_2026-12', period: '2026-12', concept: 'Cuota - Diciembre 2026' }));
    await allowed('el contador edita la configuracion financiera', () => setDoc(rref(cont, 'finanzas_config', 'oikos_settings'), { id: 'oikos_settings', currency: 'GTQ' }, { merge: true }));
    await denied('el contador no envia mensajes', () => setDoc(rref(cont, 'mensajes', 'msg-cont'), { id: 'msg-cont', condominioId: A, fromName: 'Contador', toRole: 'all', subject: 'x', body: 'x', read: false, createdAt: ts() }));
    await denied('el contador no elimina usuarios', () => deleteDoc(uref(cont, 'u-maria')));
    await denied('el contador no ve codigos', () => getDocs(query(collection(cont.db, 'codigos'), where('condominioId', '==', A))));
    await denied('el contador no ve el historial de la camara', () => getDocs(rcol(cont, 'camera_logs')));

    // Garitero: solo la garita
    await allowed('admin crea al garitero', () => createUserAs(admin, mkUser('u-gar', 'Garitero', 'operador', { privilegios: overridesOf('sys-garitero') }), 'PT001'));
    const gar = await loginAs('PT001');
    equal('el garitero entra a la garita', gar.login.redirect, 'garita.html');
    equal('la garita valida codigos de vecino con privilegio garita.operar', (await httpsCallable(gar.functions, 'verifyAccessCode')({ code: 'VA101' })).data.user?.name, 'Ana García');
    await allowed('el garitero lee los vehiculos', () => getDocs(rcol(gar, 'vehiculos')));
    await allowed('el garitero ve el historial de la camara', () => getDocs(rcol(gar, 'camera_logs')));
    await allowed('el garitero registra un ingreso', () => updateDoc(rref(gar, 'visitas', 'vis-sec'), { status: 'entered', enteredAt: ts() }));
    await allowed('el garitero registra en el historial', () => setDoc(rref(gar, 'camera_logs', 'log-gar'), { id: 'log-gar', condominioId: A, plate: 'RESIDENTE', status: 'Authorized', reason: '', createdAt: ts() }));
    await denied('el garitero no cambia otros datos de la visita', () => updateDoc(rref(gar, 'visitas', 'vis-sec'), { visitorName: 'Otro' }));
    await denied('el garitero no crea visitas', () => setDoc(rref(gar, 'visitas', 'vis-gar'), { id: 'vis-gar', condominioId: A, userId: 'u-ana', visitorName: 'x', visitDate: localDate(0), status: 'pending', createdAt: ts() }));
    await denied('el garitero no crea usuarios', () => createUserAs(gar, mkUser('u-v9', 'Nadie', 'vecino'), 'PV009'));
    await denied('el garitero no ve las finanzas', () => getDocs(rcol(gar, 'finanzas_residentes')));
    await denied('el garitero no lee todos los mensajes', () => getDocs(rcol(gar, 'mensajes')));
    await allowed('el garitero lee los mensajes que le tocan', () => getDocs(query(rcol(gar, 'mensajes'), where('toRole', 'in', ['all', 'operador']))));
    await allowed('un vecino activa una alerta para el garitero', () => setDoc(rref(ana, 'alertas_panico', 'pan-p'), panico('pan-p')));
    await allowed('el garitero ve las alertas de panico', () => getDocs(query(rcol(gar, 'alertas_panico'), where('status', 'in', ['ACTIVE', 'ATTENDED']))));
    await allowed('el garitero atiende la alerta', () => updateDoc(rref(gar, 'alertas_panico', 'pan-p'), { status: 'ATTENDED', attendedBy: 'u-gar', attendedByName: 'Garitero', attendedAt: ts() }));
    await denied('el garitero no administra rondas', () => setDoc(rref(gar, 'rondas_rutas', 'ruta-gar'), { ...rutaTest, id: 'ruta-gar' }));

    // Rondas: ver, administrar y patrullar son privilegios distintos
    await allowed('admin crea un operador que solo mira las rondas', () => createUserAs(admin, mkUser('u-rver', 'Mira rondas', 'operador', { privilegios: { 'rondas.ver': true } }), 'PR001'));
    await allowed('admin crea al jefe de seguridad', () => createUserAs(admin, mkUser('u-jefe', 'Jefe de seguridad', 'operador', { privilegios: overridesOf('sys-jefe-seguridad') }), 'PR002'));
    const rver = await loginAs('PR001');
    const jefe = await loginAs('PR002');
    equal('quien solo mira rondas entra a RONDIN', rver.login.redirect, 'rondin/');
    equal('el jefe de seguridad entra por la primera pagina que le toca (la garita)', jefe.login.redirect, 'garita.html');
    await allowed('quien solo mira lee las rutas', () => getDocs(rcol(rver, 'rondas_rutas')));
    await allowed('quien solo mira lee los turnos de todos', () => getDocs(rcol(rver, 'rondas_turnos')));
    await denied('quien solo mira no crea rutas', () => setDoc(rref(rver, 'rondas_rutas', 'ruta-rver'), { ...rutaTest, id: 'ruta-rver' }));
    await denied('quien solo mira no patrulla', () => setDoc(rref(rver, 'rondas_turnos', 'turno-rver'), { id: 'turno-rver', company_id: A, guard_id: 'u-rver', status: 'ACTIVE' }));
    await allowed('el jefe de seguridad crea una ruta', () => setDoc(rref(jefe, 'rondas_rutas', 'ruta-jefe'), { ...rutaTest, id: 'ruta-jefe', route_code: 'R-901' }));
    await allowed('el jefe de seguridad registra a un guardia', () => createUserAs(jefe, mkUser('u-g2', 'Guardia del jefe', 'policia'), 'PG002'));
    await allowed('el jefe de seguridad ve el codigo de sus guardias', () => getDoc(doc(jefe.db, 'codigos/PG002')));
    await denied('el jefe de seguridad no ve el codigo de un administrador', () => getDoc(doc(jefe.db, 'codigos/VF100')));
    await denied('el jefe de seguridad no registra vecinos', () => createUserAs(jefe, mkUser('u-v3', 'Vecino', 'vecino'), 'PV003'));
    await denied('el jefe de seguridad no crea auditores', () => createUserAs(jefe, mkUser('u-au2', 'Auditor', 'auditor'), 'PU003'));
    await allowed('el jefe de seguridad patrulla (turno propio)', () => setDoc(rref(jefe, 'rondas_turnos', 'turno-jefe'), { id: 'turno-jefe', company_id: A, guard_id: 'u-jefe', status: 'ACTIVE', scheduled_start: sqlTs() }));

    // Un co-administrador con privilegios restringidos
    const adm2Limits = { 'usuarios.privilegios': false, 'usuarios.eliminar': false, 'finanzas.usar': false, 'mensajes.enviar': false };
    await allowed('admin crea un co-administrador restringido', () => createUserAs(admin, mkUser('u-adm2', 'Co-administrador', 'admin', { privilegios: adm2Limits }), 'PA010'));
    const adm2 = await loginAs('PA010');
    equal('el co-administrador entra al panel de administracion', adm2.login.redirect, 'admin.html');
    await allowed('el co-administrador crea un vecino', () => createUserAs(adm2, mkUser('u-v4', 'Vecino del co-admin', 'vecino', { casa: 'Casa 88' }), 'PV004'));
    await allowed('el co-administrador edita un vecino', () => updateDoc(uref(adm2, 'u-v4'), { phone: '5555-4444' }));
    await allowed('el co-administrador ve los codigos de vecinos, guardias, auditores y supervisores', () => getDocs(query(collection(adm2.db, 'codigos'), where('condominioId', '==', A), where('role', 'in', ['vecino', 'policia', 'auditor', 'supervisor']))));
    await denied('pero no los de administradores y operadores (no asigna privilegios)', () => getDocs(query(collection(adm2.db, 'codigos'), where('condominioId', '==', A))));
    await allowed('el co-administrador lee las finanzas', () => getDocs(rcol(adm2, 'finanzas_residentes')));
    await denied('el co-administrador no escribe en las finanzas', () => setDoc(rref(adm2, 'finanzas_movimientos', 'tx-adm2'), { ...finTx, id: 'tx-adm2' }));
    await denied('el co-administrador no elimina usuarios', () => deleteDoc(uref(adm2, 'u-v4')));
    await denied('el co-administrador no envia mensajes', () => setDoc(rref(adm2, 'mensajes', 'msg-adm2'), { id: 'msg-adm2', condominioId: A, fromName: 'Co-admin', toRole: 'all', subject: 'x', body: 'x', read: false, createdAt: ts() }));
    await denied('el co-administrador no asigna privilegios', () => setPriv(adm2, 'u-v4', { 'finanzas.usar': true }));
    await denied('el co-administrador no crea administradores', () => createUserAs(adm2, mkUser('u-adm3', 'Otro admin', 'admin'), 'PA011'));
    await denied('el co-administrador no edita al administrador', () => updateDoc(uref(adm2, 'u-fernando'), { phone: '5555-0000' }));
    await denied('el co-administrador no elimina al administrador', () => deleteDoc(uref(adm2, 'u-fernando')));
    await denied('el co-administrador no se quita las restricciones', () => setPriv(adm2, 'u-adm2', {}));
    await denied('el co-administrador no cambia el codigo del administrador', () => setDoc(doc(adm2.db, 'codigos/PX003'), { condominioId: A, userId: 'u-fernando', role: 'vecino', createdAt: ts() }));
    await denied('el co-administrador no se vuelve admin pleno cambiando su rol', () => updateDoc(uref(adm2, 'u-adm2'), { role: 'operador' }));

    // El administrador de plenos poderes
    await denied('el administrador no se cambia sus propios privilegios', () => setPriv(admin, 'u-fernando', { 'finanzas.usar': false }));
    await denied('el administrador no se elimina a si mismo', () => deleteDoc(uref(admin, 'u-fernando')));
    await allowed('el administrador si edita sus datos', () => updateDoc(uref(admin, 'u-fernando'), { phone: '5555-1234' }));
    await allowed('el administrador asigna privilegios a otro', () => setPriv(admin, 'u-adm2', { ...adm2Limits, 'garita.camara': false }));
    await allowed('el administrador quita los privilegios a la medida (vuelve a los del rol)', () => updateDoc(uref(admin, 'u-adm2'), { privilegios: deleteField() }));
    await allowed('con los privilegios del rol, el co-administrador escribe finanzas', () => setDoc(rref(adm2, 'finanzas_movimientos', 'tx-adm2'), { ...finTx, id: 'tx-adm2' }));
    await denied('los privilegios deben ser un mapa', () => setPriv(admin, 'u-adm2', 'todo'));
    await denied('los privilegios no pueden ser un arreglo', () => setPriv(admin, 'u-adm2', ['finanzas.usar']));
    await denied('los privilegios tienen un tope de tamano', () => setPriv(admin, 'u-adm2', Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`x${i}`, true]))));
    await allowed('admin elimina al co-administrador de prueba', () => deleteDoc(uref(admin, 'u-adm2')));

    // Administrador restringido que pierde el panel: cae en la primera pagina que si le toca
    await allowed('admin crea un administrador sin acceso al panel de administracion', () => createUserAs(admin, mkUser('u-adm4', 'Admin de garita', 'admin', { privilegios: { 'usuarios.panel': false } }), 'PA012'));
    const adm4 = await loginAs('PA012');
    equal('sin panel de administracion el login lo manda a otra pagina', adm4.login.redirect, 'garita.html');

    // Guardia ampliado y restringido
    await denied('el guardia no ve las finanzas por defecto', () => getDocs(rcol(guard, 'finanzas_residentes')));
    await allowed('admin le da al guardia lectura financiera', () => setPriv(admin, 'u-pedro', { 'finanzas.ver': true }));
    await allowed('el guardia ahora lee las finanzas', () => getDocs(rcol(guard, 'finanzas_residentes')));
    await denied('pero no las escribe', () => setDoc(rref(guard, 'finanzas_movimientos', 'tx-guard'), { ...finTx, id: 'tx-guard' }));
    await allowed('admin le quita al guardia operar la garita', () => setPriv(admin, 'u-pedro', { 'garita.operar': false }));
    await denied('el guardia sin garita.operar no registra ingresos', () => updateDoc(rref(guard, 'visitas', 'vis-sec'), { status: 'entered', enteredAt: ts() }));
    await denied('ni escribe en el historial', () => setDoc(rref(guard, 'camera_logs', 'log-guard2'), { id: 'log-guard2', condominioId: A, plate: 'X', status: 'Authorized', reason: '', createdAt: ts() }));
    await denied('ni usa la verificacion de garita', () => httpsCallable(guard.functions, 'verifyAccessCode')({ code: 'VA101' }));
    const guardLogin = await httpsCallable(nobody.functions, 'login')({ code: 'VP103' });
    equal('el guardia sin garita entra a rondas', [guardLogin.data.success, guardLogin.data.redirect], [true, 'rondin/']);
    await allowed('admin le devuelve al guardia los privilegios de su rol', () => updateDoc(uref(admin, 'u-pedro'), { privilegios: deleteField() }));
    await allowed('el guardia vuelve a operar la garita', () => updateDoc(rref(guard, 'visitas', 'vis-sec'), { status: 'entered', enteredAt: ts() }));
    await denied('el guardia vuelve a no ver las finanzas', () => getDocs(rcol(guard, 'finanzas_residentes')));

    // Vecino restringido
    await allowed('admin restringe a Ana: sin visitas, vehiculos ni panico', () => setPriv(admin, 'u-ana', { 'vecino.visitas': false, 'vecino.vehiculos': false, 'panico.activar': false }));
    await allowed('Ana sigue leyendo sus visitas', () => getDocs(query(rcol(ana, 'visitas'), where('userId', '==', 'u-ana'))));
    await denied('Ana ya no crea visitas', () => setDoc(rref(ana, 'visitas', 'vis-ana-r'), { ...visit, id: 'vis-ana-r' }));
    await denied('Ana ya no registra vehiculos', () => setDoc(rref(ana, 'vehiculos', 'veh-ana-r'), { id: 'veh-ana-r', condominioId: A, userId: 'u-ana', plate: 'P-111RES', plateNorm: 'P111RES', brand: '', model: '', color: '', marbeteCode: 'MARR', createdAt: ts() }));
    await denied('Ana ya no activa el boton de panico', () => setDoc(rref(ana, 'alertas_panico', 'pan-ana-r'), panico('pan-ana-r')));
    await allowed('Ana sigue leyendo su ficha', () => getDoc(uref(ana, 'u-ana')));
    await allowed('admin le devuelve a Ana sus privilegios', () => updateDoc(uref(admin, 'u-ana'), { privilegios: deleteField() }));
    await allowed('Ana vuelve a crear visitas', () => setDoc(rref(ana, 'visitas', 'vis-ana-r'), { ...visit, id: 'vis-ana-r' }));
    await allowed('Ana vuelve a activar el panico', () => setDoc(rref(ana, 'alertas_panico', 'pan-ana-r'), panico('pan-ana-r')));
    await denied('Ana no se da privilegios a si misma', () => setPriv(ana, 'u-ana', { 'finanzas.ver': true }));

    // Auditor ampliado y restringido: sigue siendo de solo lectura salvo lo que el administrador le agregue
    await allowed('admin le agrega al auditor enviar mensajes', () => setPriv(admin, 'u-sofia', { 'mensajes.enviar': true }));
    await allowed('el auditor ahora envia un mensaje', () => setDoc(rref(auditor, 'mensajes', 'msg-aud2'), { id: 'msg-aud2', condominioId: A, fromName: 'Auditor', toRole: 'all', subject: 'x', body: 'x', read: false, createdAt: ts() }));
    await denied('pero sigue sin crear usuarios', () => createUserAs(auditor, mkUser('u-v5', 'Nadie', 'vecino'), 'PV005'));
    await allowed('admin le quita al auditor las finanzas', () => setPriv(admin, 'u-sofia', { 'finanzas.ver': false }));
    await denied('el auditor sin finanzas.ver no las lee', () => getDocs(rcol(auditor, 'finanzas_residentes')));
    await allowed('admin le devuelve al auditor sus privilegios', () => updateDoc(uref(admin, 'u-sofia'), { privilegios: deleteField() }));
    await allowed('el auditor vuelve a leer las finanzas', () => getDocs(rcol(auditor, 'finanzas_residentes')));
    await denied('y vuelve a no enviar mensajes', () => setDoc(rref(auditor, 'mensajes', 'msg-aud3'), { id: 'msg-aud3', condominioId: A, fromName: 'Auditor', toRole: 'all', subject: 'x', body: 'x', read: false, createdAt: ts() }));

    // Supervisor: registrar guardias es un privilegio que se puede quitar
    await allowed('admin le quita al supervisor registrar guardias', () => setPriv(admin, 'u-samuel', { 'guardias.crear': false }));
    await denied('el supervisor sin guardias.crear no crea guardias', () => createUserAs(sup, mkUser('u-g3', 'Guardia', 'policia'), 'PG003'));
    await allowed('admin se lo devuelve', () => updateDoc(uref(admin, 'u-samuel'), { privilegios: deleteField() }));
    await allowed('el supervisor vuelve a crear guardias', () => createUserAs(sup, mkUser('u-g3', 'Guardia', 'policia'), 'PG003'));
    await denied('el supervisor no crea vecinos', () => createUserAs(sup, mkUser('u-v6', 'Vecino', 'vecino'), 'PV006'));

    // Codigos de acceso: ver codigos no da acceso a las cuentas de administradores y operadores
    await allowed('admin crea al operador que ve codigos', () => createUserAs(admin, mkUser('u-cod', 'Ve codigos', 'operador', { privilegios: { 'usuarios.ver': true, 'usuarios.codigos': true } }), 'PQ001'));
    const cod = await loginAs('PQ001');
    equal('un operador que solo ve codigos no tiene pagina a la que entrar', [cod.login.success, cod.login.error], [false, 'Su usuario no tiene accesos asignados. Contacte al administrador.']);
    await allowed('admin le agrega ver el historial para que pueda entrar', () => setPriv(admin, 'u-cod', { 'usuarios.ver': true, 'usuarios.codigos': true, 'garita.camara': true, 'visitas.ver': true, 'garita.operar': true }));
    const cod2 = await loginAs('PQ001');
    await allowed('ve los codigos de vecinos, guardias, auditores y supervisores', () => getDocs(query(collection(cod2.db, 'codigos'), where('condominioId', '==', A), where('role', 'in', ['vecino', 'policia', 'auditor', 'supervisor']))));
    await allowed('ve el codigo de un vecino', () => getDoc(doc(cod2.db, 'codigos/VA101')));
    await denied('no ve la lista completa (incluye administradores)', () => getDocs(query(collection(cod2.db, 'codigos'), where('condominioId', '==', A))));
    await denied('no ve el codigo del administrador', () => getDoc(doc(cod2.db, 'codigos/VF100')));
    await denied('no ve los codigos de operadores', () => getDocs(query(collection(cod2.db, 'codigos'), where('condominioId', '==', A), where('role', '==', 'operador'))));
    await denied('no borra el codigo del administrador', () => deleteDoc(doc(cod2.db, 'codigos/VF100')));
    await allowed('si cambia el codigo de un vecino', () => setDoc(doc(cod2.db, 'codigos/PZ701'), { condominioId: A, userId: 'u-v4', role: 'vecino', createdAt: ts() }));
    await denied('el codigo debe llevar el rol real del usuario', () => setDoc(doc(cod2.db, 'codigos/PZ702'), { condominioId: A, userId: 'u-v4', role: 'admin', createdAt: ts() }));
    await allowed('borra un codigo de vecino', () => deleteDoc(doc(cod2.db, 'codigos/PZ701')));
    await denied('no apunta un codigo al administrador', () => setDoc(doc(cod2.db, 'codigos/PZ703'), { condominioId: A, userId: 'u-fernando', role: 'admin', createdAt: ts() }));

    // Un guardia, auditor, supervisor o vecino no puede tener "asignar privilegios": solo administradores y operadores
    await denied('un guardia no puede recibir usuarios.privilegios', () => setPriv(admin, 'u-pedro', { 'usuarios.privilegios': true }));
    await denied('un vecino no puede recibir usuarios.privilegios', () => setPriv(admin, 'u-ana', { 'usuarios.privilegios': true }));
    await allowed('un operador si puede recibir usuarios.privilegios', () => setPriv(admin, 'u-cod', { 'usuarios.ver': true, 'usuarios.codigos': true, 'usuarios.privilegios': true, 'usuarios.editar': true, 'garita.operar': true, 'visitas.ver': true }));
    await allowed('con asignar privilegios ve el codigo del administrador', () => getDoc(doc(cod2.db, 'codigos/VF100')));
    await allowed('y ve toda la lista de codigos', () => getDocs(query(collection(cod2.db, 'codigos'), where('condominioId', '==', A))));
    await allowed('admin le quita los privilegios de codigos', () => setPriv(admin, 'u-cod', { 'usuarios.ver': true, 'usuarios.eliminar': true, 'usuarios.codigos': true, 'garita.operar': true, 'visitas.ver': true }));

    // Eliminar usuarios sirve para el borrado en cascada de un usuario, no para vaciar visitas y vehiculos ajenos
    await allowed('admin crea un vecino con visita y vehiculo para borrarlo', async () => {
        await createUserAs(admin, mkUser('u-v7', 'Vecino a eliminar', 'vecino', { casa: 'Casa 7' }), 'PV007');
        await setDoc(rref(admin, 'visitas', 'vis-v7'), { id: 'vis-v7', condominioId: A, userId: 'u-v7', visitorName: 'Visita', visitorInfo: '', vehiclePlate: '', plateNorm: '', visitDate: localDate(0), visitTime: null, casa: 'Casa 7', qrCode: 'VISV7', status: 'pending', visitType: null, endDate: null, enteredAt: null, createdAt: ts() });
        await setDoc(rref(admin, 'vehiculos', 'veh-v7'), { id: 'veh-v7', condominioId: A, userId: 'u-v7', plate: 'P-777V7', plateNorm: 'P777V7', brand: '', model: '', color: '', marbeteCode: 'MARV7', createdAt: ts() });
    });
    const del = await loginAs('PQ001');
    await denied('quien elimina usuarios no borra visitas de otros vecinos', () => deleteDoc(rref(del, 'visitas', 'vis-sec')));
    await denied('ni vehiculos de vecinos que siguen existiendo', () => deleteDoc(rref(del, 'vehiculos', 'veh-ana-1')));
    await denied('ni la visita de un vecino que no se elimina', () => deleteDoc(rref(del, 'visitas', 'vis-v7')));
    await denied('no elimina a un administrador', () => deleteDoc(uref(del, 'u-fernando')));
    await allowed('si elimina a un vecino con su codigo, visitas y vehiculos en la misma operacion', async () => {
        const batch = writeBatch(del.db);
        batch.delete(doc(del.db, 'codigos/PV007'));
        batch.delete(rref(del, 'visitas', 'vis-v7'));
        batch.delete(rref(del, 'vehiculos', 'veh-v7'));
        batch.delete(uref(del, 'u-v7'));
        return batch.commit();
    });

    // Configuracion en solo lectura: usuarios.panel + usuarios.ver
    await allowed('admin crea un operador de solo lectura', () => createUserAs(admin, mkUser('u-ro', 'Solo lectura', 'operador', { privilegios: { 'usuarios.panel': true, 'usuarios.ver': true } }), 'PO777'));
    const ro = await loginAs('PO777');
    equal('el operador de solo lectura entra al panel de administracion', ro.login.redirect, 'admin.html');
    await allowed('ve la lista de usuarios', () => getDocs(rcol(ro, 'usuarios')));
    await denied('no edita usuarios', () => updateDoc(uref(ro, 'u-ana'), { phone: '5555-0000' }));
    await denied('no crea usuarios', () => createUserAs(ro, mkUser('u-v8', 'Nadie', 'vecino'), 'PV008'));
    await denied('no ve las plantillas del condominio (Configuracion solo le muestra las del sistema)', () => getDocs(rcol(ro, 'plantillas_privilegios')));
    await denied('no ve codigos de acceso', () => getDocs(query(collection(ro.db, 'codigos'), where('condominioId', '==', A))));
    await denied('no cambia privilegios', () => setPriv(ro, 'u-ana', { 'finanzas.ver': true }));

    // Plantillas de privilegios del condominio
    const plantilla = { id: 'plt-1', condominioId: A, name: 'Portero de turno', role: 'operador', description: '', claves: ['garita.operar', 'usuarios.ver', 'visitas.ver'], updatedAt: ts() };
    await allowed('admin guarda una plantilla del condominio', () => setDoc(rref(admin, 'plantillas_privilegios', 'plt-1'), plantilla));
    await allowed('admin lee las plantillas', () => getDocs(rcol(admin, 'plantillas_privilegios')));
    await denied('una plantilla necesita una lista de claves', () => setDoc(rref(admin, 'plantillas_privilegios', 'plt-2'), { ...plantilla, id: 'plt-2', claves: 'todas' }));
    await denied('una plantilla no puede ser de otro condominio', () => setDoc(rref(admin, 'plantillas_privilegios', 'plt-3'), { ...plantilla, id: 'plt-3', condominioId: B }));
    await denied('el contador no guarda plantillas de privilegios', () => setDoc(rref(cont, 'plantillas_privilegios', 'plt-4'), { ...plantilla, id: 'plt-4' }));
    await denied('un usuario de otro condominio no ve las plantillas', async () => {
        const otro = await loginAs('LJ201');
        return getDocs(collection(otro.db, `condominios/${A}/plantillas_privilegios`));
    });
    await allowed('admin elimina la plantilla', () => deleteDoc(rref(admin, 'plantillas_privilegios', 'plt-1')));
    await allowed('el master guarda una plantilla de un condominio', () => setDoc(rref(master, 'plantillas_privilegios', 'plt-m'), { ...plantilla, id: 'plt-m', name: 'Del master' }));
    await allowed('el master la elimina', () => deleteDoc(rref(master, 'plantillas_privilegios', 'plt-m')));

    // Eliminar usuarios: quien puede eliminar tambien limpia sus codigos
    await allowed('admin elimina a la secretaria con su codigo', async () => {
        const batch = writeBatch(admin.db);
        batch.delete(doc(admin.db, 'codigos/PS001'));
        batch.delete(uref(admin, 'u-sec'));
        return batch.commit();
    });
    await allowed('admin elimina al garitero con su codigo', async () => {
        const batch = writeBatch(admin.db);
        batch.delete(doc(admin.db, 'codigos/PT001'));
        batch.delete(uref(admin, 'u-gar'));
        return batch.commit();
    });
    const goneLogin = await httpsCallable(nobody.functions, 'login')({ code: 'PS001' });
    equal('un usuario eliminado ya no entra', goneLogin.data.success, false);

    // ───────── Privilegios por accion: Sistema Financiero (OIKOS), RONDIN y las llaves nuevas de SISDEL ─────────
    console.log('\nPrivilegios por accion');
    // Operador con solo las acciones indicadas (al activar una accion se activa su paraguas y lo que necesita);
    // recibe mensajes como todos los operadores
    const opWith = async (id, code, name, keys) => {
        const wanted = new Set(['mensajes.recibir']);
        keys.forEach((k) => PRIV.toggle(wanted, k, true));
        if (!PRIV.landing('operador', PRIV.toOverrides('operador', wanted))) PRIV.toggle(wanted, 'usuarios.panel', true);
        await createUserAs(admin, mkUser(id, name, 'operador', { privilegios: PRIV.toOverrides('operador', wanted) }), code);
        return loginAs(code);
    };
    const nowT = ts();
    const mv = (id, extra) => ({ id, date: nowT, amount: 100, concept: 'Prueba', resiId: 'u-ana', created_at: nowT, updated_at: nowT, ...extra });
    const annul = () => ({ deleted: true, deleted_at: ts(), deleted_reason: 'prueba', updated_at: ts() });
    const unannul = () => ({ deleted: false, updated_at: ts() });
    const mref = (c, id) => rref(c, 'finanzas_movimientos', id);
    const xref = (c, id) => rref(c, 'finanzas_residentes', id);
    const cfgRef = (c) => rref(c, 'finanzas_config', 'oikos_settings');
    const patchCfg = (c, fields) => setDoc(cfgRef(c), { ...fields, updated_at: ts() }, { merge: true });
    const setupDocs = [
        mv('fin-in-1', { type: 'income', receiptNum: 'T-1' }), mv('fin-in-2', { type: 'income', receiptNum: 'T-2' }), mv('fin-in-3', { type: 'income', receiptNum: 'T-3' }),
        mv('fin-in-4', { type: 'income', receiptNum: 'T-4' }), mv('fin-eg-1', { type: 'expense', resiId: null }), mv('fin-eg-2', { type: 'expense', resiId: null }),
        mv('fin-eg-3', { type: 'expense', resiId: null }), mv('fin-ch-1', { type: 'charge', kind: 'extra' }), mv('fin-ch-2', { type: 'charge', kind: 'fee', period: '2030-01', manual: true }),
        mv('fin-ch-2b', { type: 'charge', kind: 'fee', period: '2030-02', manual: true }), mv('fin-ch-3', { type: 'charge', kind: 'extra' })
    ];
    for (const d of setupDocs) await setDoc(mref(admin, d.id), d);
    // Un pago viejo (de enero): "deshacer" ya no lo alcanza
    await setDoc(mref(admin, 'fin-in-old'), mv('fin-in-old', { type: 'income', created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' }));
    for (const id of ['res-t1', 'res-t2', 'res-t3', 'res-t4']) await setDoc(xref(admin, id), { id, dpi: '111', notes: '', status: 'active', feeFrom: '2026-11', updated_at: nowT });
    await setDoc(mref(admin, 'fin-in-2'), { ...setupDocs[1], ...annul() });
    await allowed('admin (acceso de siempre) registra todos los tipos de movimiento', async () => {
        await setDoc(mref(admin, 'adm-in'), mv('adm-in', { type: 'income' }));
        await setDoc(mref(admin, 'adm-eg'), mv('adm-eg', { type: 'expense', resiId: null }));
        await setDoc(mref(admin, 'adm-ch'), mv('adm-ch', { type: 'charge', kind: 'extra' }));
        await setDoc(mref(admin, 'adm-fee'), mv('adm-fee', { type: 'charge', kind: 'fee', period: '2029-01', auto: true }));
    });
    await allowed('admin anula un movimiento de cada tipo', async () => {
        await updateDoc(mref(admin, 'adm-in'), annul());
        await updateDoc(mref(admin, 'adm-eg'), annul());
        await updateDoc(mref(admin, 'adm-ch'), annul());
    });
    await allowed('admin cambia la cuota y los datos generales', () => patchCfg(admin, { fee: 300, chargeDay: 2, currency: 'GTQ', customIncomeConcepts: ['Parqueo'], customExpenseConcepts: ['Jardin'] }));
    await allowed('admin edita y finiquita residentes', async () => {
        await updateDoc(xref(admin, 'res-t4'), { dpi: '444', updated_at: ts() });
        await updateDoc(xref(admin, 'res-t4'), { status: 'closed', closedAt: ts(), closeReason: 'x', updated_at: ts() });
    });

    // Cajero: solo registra pagos
    const cajero = await opWith('u-caj', 'PCAJ1', 'Cajero', ['finanzas.pagos_registrar']);
    await allowed('cajero lee los movimientos', () => getDocs(rcol(cajero, 'finanzas_movimientos')));
    await allowed('cajero registra un pago', () => setDoc(mref(cajero, 'caj-in'), mv('caj-in', { type: 'income', receiptNum: 'C-1', receiptImg: 'data:image/jpeg;base64,AAAA' })));
    await allowed('cajero deja su sello en un residente (registrar un pago lo re-sella)', () => updateDoc(xref(cajero, 'res-t1'), { updated_at: ts() }));
    await allowed('cajero avanza el contador de recibos', () => patchCfg(cajero, { receiptCounter: 7 }));
    await allowed('cajero marca un vecino nuevo para cobrarse desde este mes', () => setDoc(xref(cajero, 'res-min'), { id: 'res-min', feeFrom: '2026-11', updated_at: ts() }));
    await denied('cajero no registra egresos', () => setDoc(mref(cajero, 'caj-eg'), mv('caj-eg', { type: 'expense', resiId: null })));
    await denied('cajero no crea cargos especiales', () => setDoc(mref(cajero, 'caj-ch'), mv('caj-ch', { type: 'charge', kind: 'extra' })));
    await denied('cajero no genera cuotas automaticas', () => setDoc(mref(cajero, 'fee_u-ana_2031-01'), mv('fee_u-ana_2031-01', { type: 'charge', kind: 'fee', period: '2031-01', auto: true })));
    await denied('cajero no anula pagos', () => updateDoc(mref(cajero, 'fin-in-1'), annul()));
    await denied('cajero no reasigna el periodo de una cuota', () => updateDoc(mref(cajero, 'fin-ch-2'), { period: '2030-05', updated_at: ts() }));
    await allowed('cajero si migra un cargo viejo sin periodo (lo hace OIKOS al abrir)', async () => {
        // Un cargo de antes de que OIKOS guardara periodo y tipo: ya no se puede crear asi, se siembra sin pasar por las reglas
        const legacy = await fetch(`http://${EMULATOR.firestore}/v1/projects/${PROJECT_ID}/databases/(default)/documents/condominios/${A}/finanzas_movimientos/fin-ch-old`, {
            method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { id: { stringValue: 'fin-ch-old' }, type: { stringValue: 'charge' }, amount: { integerValue: '100' }, concept: { stringValue: 'Cuota - Enero 2026' }, resiId: { stringValue: 'u-ana' }, updated_at: { stringValue: ts() } } })
        });
        if (!legacy.ok) throw new Error(`no se pudo sembrar el cargo viejo: ${legacy.status}`);
        await updateDoc(mref(cajero, 'fin-ch-old'), { period: '2026-01', kind: 'fee', updated_at: ts() });
    });
    await denied('cajero no cambia el monto de un pago', () => updateDoc(mref(cajero, 'fin-in-1'), { amount: 5000, updated_at: ts() }));
    await denied('cajero no cambia la cuota', () => patchCfg(cajero, { fee: 999 }));
    await denied('cajero no cambia la moneda', () => patchCfg(cajero, { currency: 'USD' }));
    await denied('cajero no agrega conceptos de ingreso', () => patchCfg(cajero, { customIncomeConcepts: ['Otro'] }));
    await denied('cajero no cambia el DPI de un residente', () => updateDoc(xref(cajero, 'res-t1'), { dpi: '999', updated_at: ts() }));
    await denied('cajero no finiquita residentes', () => updateDoc(xref(cajero, 'res-t1'), { status: 'closed', closedAt: ts(), updated_at: ts() }));
    await denied('cajero no registra residentes con datos', () => setDoc(xref(cajero, 'res-nuevo'), { id: 'res-nuevo', dpi: '555', updated_at: ts() }));
    await denied('cajero no borra movimientos', () => deleteDoc(mref(cajero, 'caj-in')));
    await denied('un usuario de otro condominio no escribe movimientos', async () => { const otro = await loginAs('LJ201'); return setDoc(doc(otro.db, `condominios/${A}/finanzas_movimientos/x`), mv('x', { type: 'income' })); });

    // Anular: pagos, egresos y cargos son privilegios distintos
    const anulaPagos = await opWith('u-anp', 'PANU1', 'Anula pagos', ['finanzas.pagos_anular']);
    await allowed('quien anula pagos anula un pago', () => updateDoc(mref(anulaPagos, 'fin-in-1'), annul()));
    await denied('pero no un egreso', () => updateDoc(mref(anulaPagos, 'fin-eg-1'), annul()));
    await denied('ni un cargo', () => updateDoc(mref(anulaPagos, 'fin-ch-1'), annul()));
    await denied('ni devuelve una anulacion (eso es deshacer)', () => updateDoc(mref(anulaPagos, 'fin-in-1'), unannul()));
    await denied('ni registra pagos', () => setDoc(mref(anulaPagos, 'anp-in'), mv('anp-in', { type: 'income' })));
    const anulaEgresos = await opWith('u-ane', 'PANU2', 'Anula egresos', ['finanzas.egresos_anular']);
    await allowed('quien anula egresos anula un egreso', () => updateDoc(mref(anulaEgresos, 'fin-eg-1'), annul()));
    await denied('pero no un pago', () => updateDoc(mref(anulaEgresos, 'fin-in-3'), annul()));
    const egresero = await opWith('u-egr', 'PEGR1', 'Egresos', ['finanzas.egresos_registrar']);
    await allowed('quien registra egresos registra un egreso', () => setDoc(mref(egresero, 'egr-eg'), mv('egr-eg', { type: 'expense', resiId: null })));
    await allowed('y agrega categorias de egreso', () => patchCfg(egresero, { customExpenseConcepts: ['Reparaciones'] }));
    await denied('pero no registra pagos', () => setDoc(mref(egresero, 'egr-in'), mv('egr-in', { type: 'income' })));
    await denied('ni anula egresos', () => updateDoc(mref(egresero, 'fin-eg-2'), annul()));
    await denied('ni agrega conceptos de ingreso', () => patchCfg(egresero, { customIncomeConcepts: ['Otro'] }));

    // Cuotas y cargos
    const cuotero = await opWith('u-cuo', 'PCUO1', 'Cuota del mes', ['finanzas.cuotas_mes']);
    await allowed('cuota del mes: genera la cuota automatica', () => setDoc(mref(cuotero, 'fee_u-ana_2031-01'), mv('fee_u-ana_2031-01', { type: 'charge', kind: 'fee', period: '2031-01', auto: true })));
    await allowed('cuota del mes: aplica la cuota manual', () => setDoc(mref(cuotero, 'fee_u-ana_2031-02'), mv('fee_u-ana_2031-02', { type: 'charge', kind: 'fee', period: '2031-02', manual: true, auto: false })));
    await denied('cuota del mes: no crea cargos especiales', () => setDoc(mref(cuotero, 'cuo-ch'), mv('cuo-ch', { type: 'charge', kind: 'extra' })));
    await denied('cuota del mes: no registra pagos', () => setDoc(mref(cuotero, 'cuo-in'), mv('cuo-in', { type: 'income' })));
    await denied('cuota del mes: no anula cargos', () => updateDoc(mref(cuotero, 'fin-ch-3'), annul()));
    const cargos = await opWith('u-car', 'PCAR1', 'Cargos', ['finanzas.cargos_crear']);
    await allowed('cargos: crea un cargo especial', () => setDoc(mref(cargos, 'car-ch'), mv('car-ch', { type: 'charge', kind: 'extra' })));
    await allowed('cargos: crea una cuota manual', () => setDoc(mref(cargos, 'fee_u-ana_2031-03'), mv('fee_u-ana_2031-03', { type: 'charge', kind: 'fee', period: '2031-03', manual: true, auto: false })));
    await allowed('cargos: agrega conceptos de ingreso', () => patchCfg(cargos, { customIncomeConcepts: ['Multa'] }));
    await denied('cargos: no genera cuotas automaticas', () => setDoc(mref(cargos, 'fee_u-ana_2031-04'), mv('fee_u-ana_2031-04', { type: 'charge', kind: 'fee', period: '2031-04', auto: true })));
    await denied('cargos: no anula cargos', () => updateDoc(mref(cargos, 'fin-ch-3'), annul()));
    await denied('cargos: no agrega conceptos de egreso', () => patchCfg(cargos, { customExpenseConcepts: ['Otro'] }));
    const anulaCargos = await opWith('u-anc', 'PANC1', 'Anula cargos', ['finanzas.cargos_anular']);
    await allowed('anular cargos: anula un cargo especial', () => updateDoc(mref(anulaCargos, 'fin-ch-1'), annul()));
    await allowed('anular cargos: anula una cuota', () => updateDoc(mref(anulaCargos, 'fin-ch-2'), annul()));
    await denied('anular cargos: no anula pagos', () => updateDoc(mref(anulaCargos, 'fin-in-3'), annul()));
    const corrige = await opWith('u-cor', 'PCOR1', 'Corrige cuotas', ['finanzas.cuotas_corregir']);
    await allowed('corregir cuotas: anula una cuota duplicada', () => updateDoc(mref(corrige, 'fin-ch-2b'), annul()));
    await denied('corregir cuotas: no anula cargos especiales', () => updateDoc(mref(corrige, 'fin-ch-3'), annul()));
    const deshace = await opWith('u-des', 'PDES1', 'Deshacer', ['finanzas.deshacer']);
    await allowed('deshacer: devuelve una anulacion', () => updateDoc(mref(deshace, 'fin-in-2'), unannul()));
    await allowed('deshacer: quita un alta (la anula)', () => updateDoc(mref(deshace, 'fin-in-3'), annul()));
    await denied('deshacer: no anula un pago viejo (solo alcanza lo hecho en las ultimas 2 horas)', () => updateDoc(mref(deshace, 'fin-in-old'), annul()));
    await denied('deshacer: no cambia montos', () => updateDoc(mref(deshace, 'fin-in-4'), { amount: 1, updated_at: ts() }));
    await denied('deshacer: no registra pagos', () => setDoc(mref(deshace, 'des-in'), mv('des-in', { type: 'income' })));

    // Configuracion: cuota y cobro, datos generales y conceptos
    const cfgCuota = await opWith('u-cfc', 'PCFC1', 'Cuota y cobro', ['finanzas.config_cuota']);
    await allowed('config cuota: cambia cuota, dia, gracia y modo', () => patchCfg(cfgCuota, { fee: 350, chargeDay: 5, graceDays: 3, feeMode: 'manual' }));
    await denied('config cuota: no cambia la moneda', () => patchCfg(cfgCuota, { currency: 'USD' }));
    await denied('config cuota: no cambia el nombre', () => patchCfg(cfgCuota, { name: 'Otro' }));
    const cfgGen = await opWith('u-cfg', 'PCFG1', 'Datos generales', ['finanzas.config_general']);
    await allowed('config general: cambia moneda, idioma, nombre y tema', () => patchCfg(cfgGen, { currency: 'GTQ', lang: 'es', name: 'Villa Ferrer', theme: 'light' }));
    await denied('config general: no cambia la cuota', () => patchCfg(cfgGen, { fee: 1 }));
    await denied('config general: no cambia el modo de cobro', () => patchCfg(cfgGen, { feeMode: 'auto' }));
    const cfgCon = await opWith('u-cfn', 'PCFN1', 'Conceptos', ['finanzas.config_conceptos']);
    await allowed('config conceptos: edita ambas listas', () => patchCfg(cfgCon, { customIncomeConcepts: ['A'], customExpenseConcepts: ['B'] }));
    await denied('config conceptos: no cambia la cuota', () => patchCfg(cfgCon, { fee: 1 }));
    await denied('config conceptos: no cambia datos desconocidos (se tratan como generales)', () => patchCfg(cfgCon, { campoNuevo: 1 }));

    // Residentes: editar, finiquitar y eliminar son privilegios distintos
    const resEd = await opWith('u-red', 'PRED1', 'Edita residentes', ['finanzas.residentes_editar']);
    await allowed('residentes: editar cambia el DPI', () => updateDoc(xref(resEd, 'res-t1'), { dpi: '222', notes: 'n', updated_at: ts() }));
    await denied('residentes: editar no finiquita', () => updateDoc(xref(resEd, 'res-t1'), { status: 'closed', closedAt: ts(), updated_at: ts() }));
    await denied('residentes: editar no elimina', () => updateDoc(xref(resEd, 'res-t1'), { deleted: true, updated_at: ts() }));
    const resFin = await opWith('u-rfi', 'PRFI1', 'Finiquita', ['finanzas.residentes_finiquitar']);
    await allowed('residentes: finiquitar cierra la relacion', () => updateDoc(xref(resFin, 'res-t2'), { status: 'closed', closedAt: ts(), closeReason: 'Mudanza', closeNotes: '', updated_at: ts() }));
    await allowed('residentes: finiquitar reactiva', () => updateDoc(xref(resFin, 'res-t2'), { status: 'active', reactivatedAt: ts(), feeFrom: '2026-12', updated_at: ts() }));
    await denied('residentes: finiquitar no edita el DPI', () => updateDoc(xref(resFin, 'res-t2'), { dpi: '9', updated_at: ts() }));
    await denied('residentes: finiquitar no elimina', () => updateDoc(xref(resFin, 'res-t2'), { deleted: true, updated_at: ts() }));
    const resEl = await opWith('u-rel', 'PREL1', 'Elimina residentes', ['finanzas.residentes_eliminar']);
    await denied('residentes: eliminar no edita el DPI', () => updateDoc(xref(resEl, 'res-t3'), { dpi: '9', updated_at: ts() }));
    await allowed('residentes: eliminar marca al residente como eliminado', () => updateDoc(xref(resEl, 'res-t3'), { deleted: true, updated_at: ts() }));
    await denied('residentes: nunca se borra el documento', () => deleteDoc(xref(resEl, 'res-t3')));
    const resCr = await opWith('u-rcr', 'PRCR1', 'Registra residentes', ['finanzas.residentes_crear']);
    await allowed('residentes: crear registra los datos financieros de uno nuevo', () => setDoc(xref(resCr, 'res-t5'), { id: 'res-t5', dpi: '555', notes: '', feeFrom: '2026-11', updated_at: ts() }));
    await denied('residentes: crear no edita a uno existente', () => updateDoc(xref(resCr, 'res-t4'), { dpi: '9', updated_at: ts() }));

    // Un administrador con una accion quitada conserva todo lo demas
    await allowed('admin: crea un administrador sin "anular pagos"', () => createUserAs(admin, mkUser('u-adm5', 'Admin sin anular', 'admin', { privilegios: { 'finanzas.pagos_anular': false } }), 'PA050'));
    const adm5 = await loginAs('PA050');
    await denied('admin sin "anular pagos" no anula un pago viejo (aunque tenga "deshacer")', () => updateDoc(mref(adm5, 'fin-in-old'), annul()));
    await allowed('pero si deshace un pago que acaba de registrar', () => updateDoc(mref(adm5, 'fin-in-4'), annul()));
    await allowed('pero anula un egreso', () => updateDoc(mref(adm5, 'fin-eg-3'), annul()));
    await allowed('y registra pagos', () => setDoc(mref(adm5, 'adm5-in'), mv('adm5-in', { type: 'income' })));
    await allowed('y cambia la cuota', () => patchCfg(adm5, { fee: 320 }));
    await denied('admin sin finanzas.usar: ninguna accion de finanzas', async () => { await createUserAs(admin, mkUser('u-adm6', 'Admin sin finanzas', 'admin', { privilegios: { 'finanzas.usar': false } }), 'PA060'); const a6 = await loginAs('PA060'); return setDoc(mref(a6, 'adm6-in'), mv('adm6-in', { type: 'income' })); });
    await denied('lo mismo con las acciones sueltas aunque se las pongan (sin el paraguas)', async () => { const a6 = await loginAs('PA060'); return updateDoc(xref(a6, 'res-t1'), { dpi: '1', updated_at: ts() }); });

    // ───────── Rondas: una llave por operacion ─────────
    console.log('\nPrivilegios por accion: rondas');
    const cp = (id, name) => ({ id, route_id: 'ruta-test', name, latitude: 14.5, longitude: -90.4, radius_meters: 15, checkpoint_order: 2, is_mandatory: 1, status: 'ACTIVE' });
    const cp1 = rutaTest.checkpoints[0];
    const rutero = await opWith('u-rut', 'PRUT1', 'Crea rutas', ['rondas.rutas_crear']);
    await allowed('rutas: crear crea una ruta', () => setDoc(rref(rutero, 'rondas_rutas', 'ruta-op1'), { ...rutaTest, id: 'ruta-op1', route_code: 'R-950', checkpoints: [] }));
    await allowed('rutas: crear edita nombre y color', () => updateDoc(rref(rutero, 'rondas_rutas', 'ruta-op1'), { name: 'Renombrada', color: '#fff', updated_at: sqlTs() }));
    await denied('rutas: crear no desactiva rutas', () => updateDoc(rref(rutero, 'rondas_rutas', 'ruta-op1'), { status: 'INACTIVE', updated_at: sqlTs() }));
    await denied('rutas: crear no agrega puntos', () => updateDoc(rref(rutero, 'rondas_rutas', 'ruta-op1'), { checkpoints: [cp('cpx', 'X')], updated_at: sqlTs() }));
    await denied('rutas: crear no asigna guardias', () => setDoc(rref(rutero, 'rondas_asignaciones', 'asig-rut'), { ...asig, id: 'asig-rut' }));
    const rutaElim = await opWith('u-rel2', 'PRUT2', 'Elimina rutas', ['rondas.rutas_eliminar']);
    await allowed('rutas: eliminar desactiva una ruta', () => updateDoc(rref(rutaElim, 'rondas_rutas', 'ruta-op1'), { status: 'INACTIVE', updated_at: sqlTs() }));
    await denied('rutas: eliminar no crea rutas', () => setDoc(rref(rutaElim, 'rondas_rutas', 'ruta-op2'), { ...rutaTest, id: 'ruta-op2', route_code: 'R-951' }));
    await denied('rutas: eliminar no cambia el nombre', () => updateDoc(rref(rutaElim, 'rondas_rutas', 'ruta-op1'), { name: 'Otra', updated_at: sqlTs() }));
    const ptC = await opWith('u-ptc', 'PPTC1', 'Agrega puntos', ['rondas.puntos_crear']);
    const ptE = await opWith('u-pte', 'PPTE1', 'Renombra puntos', ['rondas.puntos_editar']);
    const ptD = await opWith('u-ptd', 'PPTD1', 'Quita puntos', ['rondas.puntos_eliminar']);
    const withPoints = (list) => ({ checkpoints: list, updated_at: sqlTs() });
    await denied('puntos: renombrar no agrega', () => updateDoc(rref(ptE, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos')])));
    await denied('puntos: eliminar no agrega', () => updateDoc(rref(ptD, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos')])));
    await allowed('puntos: agregar agrega un punto', () => updateDoc(rref(ptC, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos')])));
    await denied('puntos: agregar no renombra', () => updateDoc(rref(ptC, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos bis')])));
    await denied('puntos: eliminar no renombra', () => updateDoc(rref(ptD, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos bis')])));
    await allowed('puntos: renombrar cambia el nombre', () => updateDoc(rref(ptE, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp2', 'Dos bis')])));
    await denied('puntos: agregar no quita', () => updateDoc(rref(ptC, 'rondas_rutas', 'ruta-test'), withPoints([cp1])));
    await denied('puntos: renombrar no quita', () => updateDoc(rref(ptE, 'rondas_rutas', 'ruta-test'), withPoints([cp1])));
    await allowed('puntos: eliminar quita un punto', () => updateDoc(rref(ptD, 'rondas_rutas', 'ruta-test'), withPoints([cp1])));

    const asC = await opWith('u-asc', 'PASC1', 'Crea asignaciones', ['rondas.asignaciones_crear']);
    const asE = await opWith('u-ase', 'PASE1', 'Edita asignaciones', ['rondas.asignaciones_editar']);
    const asD = await opWith('u-asd', 'PASD1', 'Quita asignaciones', ['rondas.asignaciones_eliminar']);
    const asigOp = { ...asig, id: 'asig-op' };
    await denied('asignaciones: editar no crea', () => setDoc(rref(asE, 'rondas_asignaciones', 'asig-op'), asigOp));
    await allowed('asignaciones: crear asigna una ruta', () => setDoc(rref(asC, 'rondas_asignaciones', 'asig-op'), asigOp));
    await denied('asignaciones: crear no edita', () => updateDoc(rref(asC, 'rondas_asignaciones', 'asig-op'), { hour_end: '21:00' }));
    await allowed('asignaciones: editar cambia el horario', () => updateDoc(rref(asE, 'rondas_asignaciones', 'asig-op'), { hour_end: '21:00' }));
    await denied('asignaciones: crear no quita', () => deleteDoc(rref(asC, 'rondas_asignaciones', 'asig-op')));
    await allowed('asignaciones: quitar borra la asignacion', () => deleteDoc(rref(asD, 'rondas_asignaciones', 'asig-op')));

    await setDoc(rref(guard, 'rondas_alertas', 'al-op'), { ...alerta, id: 'al-op' });
    const alVer = await opWith('u-alv', 'PALV1', 'Ve alertas', ['rondas.alertas_ver']);
    const alAck = await opWith('u-ala', 'PALA1', 'Atiende alertas', ['rondas.alertas_atender']);
    const alDel = await opWith('u-ald', 'PALD1', 'Borra alertas', ['rondas.alertas_eliminar']);
    const ack = (uid) => ({ acknowledged: 1, acknowledged_by: uid, acknowledged_at: sqlTs() });
    await allowed('alertas: ver lee el panel de alertas', () => getDocs(rcol(alVer, 'rondas_alertas')));
    await denied('alertas: ver no atiende', () => updateDoc(rref(alVer, 'rondas_alertas', 'al-op'), ack('u-alv')));
    await denied('alertas: borrar no atiende', () => updateDoc(rref(alDel, 'rondas_alertas', 'al-op'), ack('u-ald')));
    await allowed('alertas: atender marca la alerta', () => updateDoc(rref(alAck, 'rondas_alertas', 'al-op'), ack('u-ala')));
    await denied('alertas: atender no borra', () => deleteDoc(rref(alAck, 'rondas_alertas', 'al-op')));
    await allowed('alertas: borrar quita la alerta', () => deleteDoc(rref(alDel, 'rondas_alertas', 'al-op')));

    const monitor = await opWith('u-mon', 'PMON1', 'Mapa en vivo', ['rondas.monitoreo_ver']);
    const monHist = await opWith('u-mnh', 'PMNH1', 'Historial de ubicaciones', ['rondas.monitoreo_historial']);
    await allowed('monitoreo: ver lee las posiciones en vivo', () => getDocs(rcol(monitor, 'rondas_en_vivo')));
    await denied('monitoreo: ver no lee el historial de ubicaciones', () => getDocs(rcol(monitor, 'rondas_ubicaciones')));
    await denied('monitoreo: ver no lee las alertas', () => getDocs(rcol(monitor, 'rondas_alertas')));
    await denied('monitoreo: ver no lee los incidentes', () => getDocs(rcol(monitor, 'rondas_incidentes')));
    await denied('monitoreo: ver no lee los drones', () => getDocs(rcol(monitor, 'rondas_drones')));
    await allowed('monitoreo: el historial lee las ubicaciones', () => getDocs(rcol(monHist, 'rondas_ubicaciones')));
    await allowed('monitoreo: el historial tambien trae el mapa en vivo (cuelga de el)', () => getDocs(rcol(monHist, 'rondas_en_vivo')));
    const rutV = await opWith('u-rtv', 'PRTV1', 'Ve rutas', ['rondas.rutas_ver']);
    const asV = await opWith('u-asv', 'PASV1', 'Ve asignaciones', ['rondas.asignaciones_ver']);
    const recV = await opWith('u-rcv', 'PRCV1', 'Ve recorridos', ['rondas.recorridos_ver']);
    await allowed('rutas: ver lee rutas', () => getDocs(rcol(rutV, 'rondas_rutas')));
    await denied('rutas: ver no lee asignaciones', () => getDocs(rcol(rutV, 'rondas_asignaciones')));
    await denied('rutas: ver no lee recorridos', () => getDocs(rcol(rutV, 'rondas_visitas')));
    await allowed('asignaciones: ver lee la programacion', () => getDocs(rcol(asV, 'rondas_asignaciones')));
    await denied('asignaciones: ver no lee rutas', () => getDocs(rcol(asV, 'rondas_rutas')));
    await allowed('recorridos: ver lee las visitas a puntos', () => getDocs(rcol(recV, 'rondas_visitas')));
    await denied('recorridos: ver no lee rutas', () => getDocs(rcol(recV, 'rondas_rutas')));

    await setDoc(rref(guard, 'rondas_incidentes', 'inc-op'), { ...incidente, id: 'inc-op' });
    const incV = await opWith('u-inv', 'PINV1', 'Ve incidentes', ['rondas.incidentes_ver']);
    const incR = await opWith('u-inr', 'PINR1', 'Resuelve incidentes', ['rondas.incidentes_resolver']);
    const incRep = await opWith('u-inp', 'PINP1', 'Reporta incidentes', ['rondas.incidentes_reportar']);
    await allowed('incidentes: ver lee los incidentes', () => getDocs(rcol(incV, 'rondas_incidentes')));
    await denied('incidentes: ver no los resuelve', () => updateDoc(rref(incV, 'rondas_incidentes', 'inc-op'), { status: 'CLOSED' }));
    await allowed('incidentes: resolver cierra el incidente', () => updateDoc(rref(incR, 'rondas_incidentes', 'inc-op'), { status: 'CLOSED', resolved_by: 'u-inr', resolved_at: sqlTs() }));
    await allowed('incidentes: reportar abre uno a su nombre', () => setDoc(rref(incRep, 'rondas_incidentes', 'inc-rep'), { ...incidente, id: 'inc-rep', reported_by: 'u-inp' }));
    await denied('incidentes: reportar no resuelve', () => updateDoc(rref(incRep, 'rondas_incidentes', 'inc-rep'), { status: 'RESOLVED' }));

    const drOp = await opWith('u-dro', 'PDRO1', 'Opera drones', ['rondas.drones_operar']);
    const drReg = await opWith('u-drr', 'PDRR1', 'Registra drones', ['rondas.drones_registrar']);
    await allowed('drones: operar cambia el estado', () => updateDoc(rref(drOp, 'rondas_drones', 'dron-test'), { status: 'ACTIVE' }));
    await denied('drones: operar no registra', () => setDoc(rref(drOp, 'rondas_drones', 'dron-op'), { ...dron, id: 'dron-op' }));
    await allowed('drones: registrar da de alta uno', () => setDoc(rref(drReg, 'rondas_drones', 'dron-op'), { ...dron, id: 'dron-op' }));
    await denied('drones: registrar no los opera', () => updateDoc(rref(drReg, 'rondas_drones', 'dron-op'), { status: 'DISPATCHED' }));

    // Patrulla: iniciar, marcar, terminar y compartir la ubicacion
    const turnoDe = (uid, id, extra = {}) => ({ id, company_id: A, guard_id: uid, route_id: 'ruta-test', scheduled_start: sqlTs(), status: 'SCHEDULED', created_at: sqlTs(), ...extra });
    const p1 = await opWith('u-p1', 'PPA01', 'Patrulla iniciar', ['rondas.patrulla_iniciar']);
    const p2 = await opWith('u-p2', 'PPA02', 'Patrulla marcar', ['rondas.patrulla_marcar']);
    const p3 = await opWith('u-p3', 'PPA03', 'Patrulla terminar', ['rondas.patrulla_terminar']);
    const p4 = await opWith('u-p4', 'PPA04', 'Patrulla rastrear', ['rondas.patrulla_rastrear']);
    await allowed('patrulla: iniciar crea su turno', () => setDoc(rref(p1, 'rondas_turnos', 'turno-p1'), turnoDe('u-p1', 'turno-p1')));
    await allowed('patrulla: iniciar hace el check-in', () => updateDoc(rref(p1, 'rondas_turnos', 'turno-p1'), { status: 'ACTIVE', actual_start: sqlTs() }));
    await allowed('patrulla: iniciar abre una ronda', () => setDoc(rref(p1, 'rondas_rondas', 'ronda-p1'), { ...ronda, id: 'ronda-p1', shift_id: 'turno-p1', guard_id: 'u-p1' }));
    await denied('patrulla: iniciar no marca puntos', () => setDoc(rref(p1, 'rondas_visitas', 'visita-p1'), { ...visita, id: 'visita-p1', guard_id: 'u-p1' }));
    await denied('patrulla: iniciar no termina el turno', () => updateDoc(rref(p1, 'rondas_turnos', 'turno-p1'), { status: 'COMPLETED', actual_end: sqlTs() }));
    await denied('patrulla: iniciar no comparte la ubicacion', () => setDoc(rref(p1, 'rondas_en_vivo', 'u-p1'), { ...posicion, user_id: 'u-p1' }));
    await allowed('patrulla: marcar registra la visita a un punto', () => setDoc(rref(p2, 'rondas_visitas', 'visita-p2'), { ...visita, id: 'visita-p2', guard_id: 'u-p2' }));
    await denied('patrulla: marcar no abre rondas', () => setDoc(rref(p2, 'rondas_rondas', 'ronda-p2'), { ...ronda, id: 'ronda-p2', guard_id: 'u-p2' }));
    await denied('patrulla: marcar no crea turnos', () => setDoc(rref(p2, 'rondas_turnos', 'turno-p2'), turnoDe('u-p2', 'turno-p2')));
    await setDoc(rref(admin, 'rondas_turnos', 'turno-p3'), turnoDe('u-p3', 'turno-p3', { status: 'ACTIVE' }));
    await denied('patrulla: terminar no inicia el turno', () => updateDoc(rref(p3, 'rondas_turnos', 'turno-p3'), { status: 'ACTIVE', actual_start: sqlTs() }));
    await allowed('patrulla: terminar cierra su turno', () => updateDoc(rref(p3, 'rondas_turnos', 'turno-p3'), { status: 'COMPLETED', actual_end: sqlTs() }));
    await allowed('patrulla: rastrear comparte la ubicacion en vivo', () => setDoc(rref(p4, 'rondas_en_vivo', 'u-p4'), { ...posicion, user_id: 'u-p4' }));
    await allowed('patrulla: rastrear guarda el historial', () => setDoc(rref(p4, 'rondas_ubicaciones', 'ubi-p4'), { ...posicion, user_id: 'u-p4' }));
    await denied('patrulla: rastrear no inicia turnos', () => setDoc(rref(p4, 'rondas_turnos', 'turno-p4'), turnoDe('u-p4', 'turno-p4')));
    await allowed('patrulla: quien patrulla borra su posicion al terminar', () => deleteDoc(rref(p4, 'rondas_en_vivo', 'u-p4')));

    // Personal y configuracion
    const supAs = await opWith('u-sas', 'PSAS1', 'Asigna supervisores', ['rondas.supervisores_asignar']);
    await allowed('supervisores: asignar pone al guardia a cargo de un supervisor', () => setDoc(rref(supAs, 'rondas_personal', 'u-pedro'), { id: 'u-pedro', company_id: A, supervisor_id: 'u-samuel', updated_at: sqlTs() }, { merge: true }));
    await denied('supervisores: asignar no edita el expediente', () => setDoc(rref(supAs, 'rondas_personal', 'u-pedro'), { id: 'u-pedro', company_id: A, document_id: '123', updated_at: sqlTs() }, { merge: true }));
    const cfgRondas = await opWith('u-crn', 'PCRN1', 'Config de rondas', ['rondas.ajustes_panicovecinos']);
    await allowed('rondas: guardar la configuracion', () => setDoc(rref(cfgRondas, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 1, updated_at: sqlTs() }, { merge: true }));
    await denied('rondas: quien solo ve alertas no guarda la configuracion', () => setDoc(rref(alVer, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 0 }, { merge: true }));
    await allowed('rondas: el administrador de siempre conserva todo (rutas, puntos, asignaciones, alertas, drones, configuracion)', async () => {
        await updateDoc(rref(admin, 'rondas_rutas', 'ruta-test'), withPoints([cp1, cp('cp9', 'Nueve')]));
        await updateDoc(rref(admin, 'rondas_rutas', 'ruta-test'), withPoints([cp1]));
        await setDoc(rref(admin, 'rondas_asignaciones', 'asig-adm'), { ...asig, id: 'asig-adm' });
        await deleteDoc(rref(admin, 'rondas_asignaciones', 'asig-adm'));
        await setDoc(rref(admin, 'rondas_config', 'general'), { company_id: A, neighbor_panic_enabled: 1, updated_at: sqlTs() }, { merge: true });
        await updateDoc(rref(admin, 'rondas_drones', 'dron-test'), { status: 'ACTIVE' });
    });
    await allowed('rondas: el supervisor de siempre sigue patrullando y administrando', async () => {
        await setDoc(rref(sup, 'rondas_turnos', 'turno-sup'), turnoDe('u-samuel', 'turno-sup'));
        await setDoc(rref(sup, 'rondas_visitas', 'visita-sup'), { ...visita, id: 'visita-sup', guard_id: 'u-samuel' });
        await setDoc(rref(sup, 'rondas_en_vivo', 'u-samuel'), { ...posicion, user_id: 'u-samuel' });
        await setDoc(rref(sup, 'rondas_rutas', 'ruta-sup'), { ...rutaTest, id: 'ruta-sup', route_code: 'R-960' });
    });
    await denied('rondas: un supervisor al que se le quita "marcar puntos" ya no marca', async () => {
        await createUserAs(admin, mkUser('u-sup2', 'Supervisor sin marcar', 'supervisor', { privilegios: { 'rondas.patrulla_marcar': false } }), 'PSU20');
        const s2 = await loginAs('PSU20');
        return setDoc(rref(s2, 'rondas_visitas', 'visita-s2'), { ...visita, id: 'visita-s2', guard_id: 'u-sup2' });
    });
    await allowed('rondas: ese mismo supervisor sigue iniciando turnos', async () => {
        const s2 = await loginAs('PSU20');
        return setDoc(rref(s2, 'rondas_turnos', 'turno-s2'), turnoDe('u-sup2', 'turno-s2'));
    });

    // ───────── SISDEL: llaves nuevas ─────────
    console.log('\nPrivilegios por accion: SISDEL');
    await createUserAs(admin, mkUser('u-v30', 'Vecino Treinta', 'vecino', { casa: 'Casa 30' }), 'PV030');
    const sinEstado = await opWith('u-ses', 'PSES1', 'Edita sin estado', ['usuarios.editar']);
    const conEstado = await opWith('u-ces', 'PCES1', 'Edita con estado', ['usuarios.estado']);
    await allowed('usuarios: editar cambia el telefono', () => updateDoc(uref(sinEstado, 'u-v30'), { phone: '5555-3030' }));
    await denied('usuarios: editar sin "estado" no desactiva', () => updateDoc(uref(sinEstado, 'u-v30'), { active: false }));
    await allowed('usuarios: "estado" desactiva a un usuario', () => updateDoc(uref(conEstado, 'u-v30'), { active: false }));
    await allowed('usuarios: "estado" lo reactiva', () => updateDoc(uref(conEstado, 'u-v30'), { active: true }));
    await denied('usuarios: sin "pago" nadie cambia el estado de pago a mano', () => updateDoc(uref(sinEstado, 'u-v30'), { paymentStatus: 'moroso' }));

    const vehNuevo = (id, owner = 'u-ana') => ({ id, condominioId: A, userId: owner, plate: `P-${id}`, plateNorm: `P${id}`.replace(/-/g, ''), brand: '', model: '', color: '', marbeteCode: `M${id}`.slice(0, 8), createdAt: ts() });
    const vehC = await opWith('u-vc', 'PVEC1', 'Crea vehiculos', ['vehiculos.crear']);
    const vehE = await opWith('u-ve', 'PVEE1', 'Edita vehiculos', ['vehiculos.editar']);
    const vehD = await opWith('u-vd', 'PVED1', 'Elimina vehiculos', ['vehiculos.eliminar']);
    await allowed('vehiculos: crear registra un vehiculo', () => setDoc(rref(vehC, 'vehiculos', 'veh-op'), vehNuevo('veh-op')));
    await denied('vehiculos: crear no edita', () => updateDoc(rref(vehC, 'vehiculos', 'veh-op'), { color: 'rojo' }));
    await denied('vehiculos: crear no elimina', () => deleteDoc(rref(vehC, 'vehiculos', 'veh-op')));
    await allowed('vehiculos: editar cambia el color', () => updateDoc(rref(vehE, 'vehiculos', 'veh-op'), { color: 'azul' }));
    await denied('vehiculos: editar no crea', () => setDoc(rref(vehE, 'vehiculos', 'veh-op2'), vehNuevo('veh-op2')));
    await denied('vehiculos: eliminar no edita', () => updateDoc(rref(vehD, 'vehiculos', 'veh-op'), { color: 'verde' }));
    await allowed('vehiculos: eliminar quita el vehiculo', () => deleteDoc(rref(vehD, 'vehiculos', 'veh-op')));
    await denied('vehiculos: quien gestiona visitas no crea visitas sin "crear visitas"', () => setDoc(rref(vehC, 'visitas', 'vis-veh'), { id: 'vis-veh', condominioId: A, userId: 'u-ana', visitorName: 'x', visitDate: localDate(0), status: 'pending', createdAt: ts() }));

    const msgEnv = await opWith('u-men', 'PMEN1', 'Envia mensajes', ['mensajes.enviar']);
    const msgDel = await opWith('u-mel', 'PMEL1', 'Elimina mensajes', ['mensajes.eliminar']);
    const msgOne = (id) => ({ id, condominioId: A, fromName: 'Prueba', toRole: 'all', subject: 'Aviso', body: 'x', read: false, createdAt: ts() });
    await allowed('mensajes: enviar publica un mensaje', () => setDoc(rref(msgEnv, 'mensajes', 'msg-op'), msgOne('msg-op')));
    await denied('mensajes: enviar no elimina', () => deleteDoc(rref(msgEnv, 'mensajes', 'msg-op')));
    await allowed('mensajes: eliminar borra un mensaje', () => deleteDoc(rref(msgDel, 'mensajes', 'msg-op')));
    await denied('mensajes: quien no recibe mensajes no los lee', async () => { const sinMsg = await (async () => { await createUserAs(admin, mkUser('u-nom', 'No recibe', 'operador', { privilegios: { 'mensajes.recibir': false, 'usuarios.panel': true, 'usuarios.ver': true } }), 'PNOM1'); return loginAs('PNOM1'); })(); return getDocs(query(rcol(sinMsg, 'mensajes'), where('toRole', 'in', ['all', 'operador']))); });

    // Panico: atender, resolver, cancelar, contactos
    await setDoc(rref(ana, 'alertas_panico', 'pan-x1'), panico('pan-x1'));
    await setDoc(rref(ana, 'alertas_panico', 'pan-x2'), panico('pan-x2'));
    const pAt = await opWith('u-pat', 'PPAT1', 'Atiende panico', ['panico.atender']);
    const pRes = await opWith('u-pre', 'PPRE1', 'Resuelve panico', ['panico.resolver']);
    await allowed('panico: atender marca la alerta como atendida', () => updateDoc(rref(pAt, 'alertas_panico', 'pan-x1'), { status: 'ATTENDED', attendedBy: 'u-pat', attendedByName: 'Atiende', attendedAt: ts() }));
    await denied('panico: atender no la resuelve', () => updateDoc(rref(pAt, 'alertas_panico', 'pan-x2'), { status: 'RESOLVED', resolvedBy: 'u-pat', resolvedByName: 'Atiende', resolvedAt: ts() }));
    await allowed('panico: resolver la cierra', () => updateDoc(rref(pRes, 'alertas_panico', 'pan-x2'), { status: 'RESOLVED', resolvedBy: 'u-pre', resolvedByName: 'Resuelve', resolvedAt: ts() }));
    await createUserAs(admin, mkUser('u-v31', 'Vecino sin cancelar', 'vecino', { casa: 'Casa 31', privilegios: { 'panico.cancelar': false } }), 'PV031');
    await createUserAs(admin, mkUser('u-v32', 'Vecino que cancela', 'vecino', { casa: 'Casa 32' }), 'PV032');
    const v31 = await loginAs('PV031');
    const v32 = await loginAs('PV032');
    await setDoc(rref(v31, 'alertas_panico', 'pan-x3'), panico('pan-x3', { userId: 'u-v31', userName: 'Vecino sin cancelar' }));
    await setDoc(rref(v32, 'alertas_panico', 'pan-x4'), panico('pan-x4', { userId: 'u-v32', userName: 'Vecino que cancela' }));
    await denied('panico: un vecino sin "cancelar" no cancela su alerta', () => updateDoc(rref(v31, 'alertas_panico', 'pan-x3'), { status: 'CANCELLED', cancelledAt: ts() }));
    await allowed('panico: el vecino de siempre si la cancela', () => updateDoc(rref(v32, 'alertas_panico', 'pan-x4'), { status: 'CANCELLED', cancelledAt: ts() }));
    const pVer = await opWith('u-pvr', 'PPVR1', 'Ve panico', ['panico.ver']);
    const pCon = await opWith('u-pcn', 'PPCN1', 'Ve contactos', ['panico.contactos']);
    await allowed('panico: ver lee las alertas', () => getDocs(query(rcol(pVer, 'alertas_panico'), where('status', 'in', ['ACTIVE', 'ATTENDED']))));
    await denied('panico: ver sin "contactos" no lee los familiares', () => getDocs(rcol(pVer, 'emergencia')));
    await allowed('panico: contactos lee los familiares de emergencia', () => getDocs(rcol(pCon, 'emergencia')));

    // Garita: verificar codigos e ingresos
    const gVer = await opWith('u-gve', 'PGVE1', 'Verifica codigos', ['garita.verificar']);
    const gIng = await opWith('u-gin', 'PGIN1', 'Registra ingresos', ['garita.ingreso']);
    equal('garita: verificar valida un codigo de vecino', (await httpsCallable(gVer.functions, 'verifyAccessCode')({ code: 'VA101' })).data.user?.name, 'Ana García');
    await denied('garita: registrar ingresos no valida codigos', () => httpsCallable(gIng.functions, 'verifyAccessCode')({ code: 'VA101' }));
    await allowed('garita: ingreso marca la entrada de una visita', () => updateDoc(rref(gIng, 'visitas', 'vis-sec'), { status: 'entered', enteredAt: ts() }));
    await denied('garita: verificar no marca entradas', () => updateDoc(rref(gVer, 'visitas', 'vis-sec'), { status: 'entered', enteredAt: ts() }));
    await denied('garita: verificar no escribe el historial', () => setDoc(rref(gVer, 'camera_logs', 'log-ver'), { id: 'log-ver', condominioId: A, plate: 'X', status: 'Authorized', reason: '', createdAt: ts() }));
    await allowed('garita: ingreso escribe el historial', () => setDoc(rref(gIng, 'camera_logs', 'log-ing'), { id: 'log-ing', condominioId: A, plate: 'X', status: 'Authorized', reason: '', createdAt: ts() }));

    // Vecino: historial, visitas temporales, contactos y quitar vehiculos
    await createUserAs(admin, mkUser('u-v33', 'Vecino sin historial', 'vecino', { casa: 'Casa 33', privilegios: { 'vecino.historial': false } }), 'PV033');
    await createUserAs(admin, mkUser('u-v34', 'Vecino sin temporales', 'vecino', { casa: 'Casa 34', privilegios: { 'vecino.temporal': false } }), 'PV034');
    await createUserAs(admin, mkUser('u-v35', 'Vecino sin contactos', 'vecino', { casa: 'Casa 35', privilegios: { 'vecino.contactos': false } }), 'PV035');
    await createUserAs(admin, mkUser('u-v36', 'Vecino sin quitar vehiculos', 'vecino', { casa: 'Casa 36', privilegios: { 'vecino.vehiculos_quitar': false } }), 'PV036');
    const v33 = await loginAs('PV033');
    const v34 = await loginAs('PV034');
    const v35 = await loginAs('PV035');
    const v36 = await loginAs('PV036');
    await allowed('vecino: ver su historial de visitas', () => getDocs(query(rcol(ana, 'visitas'), where('userId', '==', 'u-ana'))));
    await denied('vecino: sin "historial" no lee sus visitas', () => getDocs(query(rcol(v33, 'visitas'), where('userId', '==', 'u-v33'))));
    const visitaVecino = (uid, id, extra = {}) => ({ id, condominioId: A, userId: uid, visitorName: 'Visita', visitorInfo: '', vehiclePlate: '', plateNorm: '', visitDate: localDate(0), visitTime: null, casa: '', qrCode: id.toUpperCase(), status: 'pending', visitType: null, endDate: null, enteredAt: null, createdAt: ts(), ...extra });
    await allowed('vecino: sin "temporales" si registra una visita de un dia', () => setDoc(rref(v34, 'visitas', 'vis-v34'), visitaVecino('u-v34', 'vis-v34')));
    await denied('vecino: sin "temporales" no registra un acceso temporal', () => setDoc(rref(v34, 'visitas', 'vis-v34b'), visitaVecino('u-v34', 'vis-v34b', { visitType: 'temporal', endDate: localDate(5) })));
    await allowed('vecino: de siempre registra un acceso temporal', () => setDoc(rref(ana, 'visitas', 'vis-ana-temp'), visitaVecino('u-ana', 'vis-ana-temp', { visitType: 'temporal', endDate: localDate(5) })));
    await denied('vecino: sin "contactos" no guarda sus contactos de emergencia', () => setDoc(rref(v35, 'emergencia', 'u-v35'), { userId: 'u-v35', contacts: [] }));
    await allowed('vecino: de siempre guarda sus contactos de emergencia', () => setDoc(rref(ana, 'emergencia', 'u-ana'), { userId: 'u-ana', contacts: [] }));
    await setDoc(rref(v36, 'vehiculos', 'veh-v36'), vehNuevo('veh-v36', 'u-v36'));
    await denied('vecino: sin "quitar vehiculos" no borra su vehiculo', () => deleteDoc(rref(v36, 'vehiculos', 'veh-v36')));
    await setDoc(rref(ana, 'vehiculos', 'veh-ana-q'), vehNuevo('veh-ana-q', 'u-ana'));
    await allowed('vecino: de siempre quita su vehiculo', () => deleteDoc(rref(ana, 'vehiculos', 'veh-ana-q')));

    // Privilegios y plantillas
    const plPriv = await opWith('u-ppr', 'PPPR1', 'Asigna privilegios', ['usuarios.privilegios']);
    const plTpl = await opWith('u-ppt', 'PPPT1', 'Asigna y gestiona plantillas', ['usuarios.privilegios', 'plantillas.gestionar']);
    const plantillaOp = { id: 'plt-op', condominioId: A, name: 'De prueba', role: 'operador', description: '', claves: ['usuarios.ver'], updatedAt: ts() };
    await allowed('plantillas: asignar privilegios lee las plantillas', () => getDocs(rcol(plPriv, 'plantillas_privilegios')));
    await denied('plantillas: asignar privilegios sin "gestionar plantillas" no las guarda', () => setDoc(rref(plPriv, 'plantillas_privilegios', 'plt-op'), plantillaOp));
    await allowed('plantillas: gestionar plantillas las guarda', () => setDoc(rref(plTpl, 'plantillas_privilegios', 'plt-op'), plantillaOp));
    await denied('plantillas: sin gestionarlas no las borra', () => deleteDoc(rref(plPriv, 'plantillas_privilegios', 'plt-op')));
    await allowed('plantillas: gestionar plantillas las borra', () => deleteDoc(rref(plTpl, 'plantillas_privilegios', 'plt-op')));
    await denied('plantillas: una accion suelta sin su paraguas no sirve', () => createUserAs(admin, mkUser('u-nope', 'Sin paraguas', 'operador', { privilegios: { 'plantillas.gestionar': true, 'usuarios.panel': true, 'usuarios.ver': true } }), 'PNOP1').then(async () => { const nope = await loginAs('PNOP1'); return setDoc(rref(nope, 'plantillas_privilegios', 'plt-nope'), { ...plantillaOp, id: 'plt-nope' }); }));

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
