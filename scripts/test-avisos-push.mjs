// Pruebas de los avisos en el celular (notificaciones push), sin emuladores:
//  1. functions/src/avisos-push-core.js: que direcciones se aceptan, el texto del aviso, a quien le llega y que hacer con los errores.
//  2. El aviso de verdad: web-push lo cifra con las llaves del telefono y aqui se descifra con la llave privada del "telefono"
//     (lo mismo que hace Chrome o el iPhone al recibirlo), y la firma VAPID dice garita.app.
//  3. avisos-push.js (el navegador) con un telefono de mentira: iPhone sin el icono, permiso negado, activar, otra llave, estado,
//     desactivar y la resincronizacion.
//  4. sw-avisos.js: muestra el aviso y, al tocarlo, abre garita.app (o la pestana con la sesion) y nunca otra pagina.
//  5. Lo que deben tener las paginas, el manifiesto, los iconos, las reglas y las funciones.
// Contra los emuladores: test-avisos-emulador.mjs. Uso: node test-avisos-push.mjs (tambien corre con npm test).
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fnRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

const core = require('../functions/src/avisos-push-core.js');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function phoneKeys() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ecdh, auth, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}

console.log('\nDirecciones de los servicios de avisos');
{
    const { keys } = phoneKeys();
    const ok = (endpoint) => !core.cleanSubscription({ endpoint, keys }).error;
    equal('se aceptan Chrome/Android (Google), iPhone/Safari (Apple), Firefox (Mozilla) y Edge (Microsoft)', [
        ok('https://fcm.googleapis.com/fcm/send/abc:def'), ok('https://web.push.apple.com/QGx3k'), ok('https://updates.push.services.mozilla.com/wpush/v2/gAAA'),
        ok('https://wns2-bl2p.notify.windows.com/w/?token=AAA')
    ], [true, true, true, true]);
    equal('nunca a otra direccion: http, otro servidor, un puerto, usuario en la direccion o un nombre que solo se parece', [
        ok('http://fcm.googleapis.com/fcm/send/x'), ok('https://example.com/push'), ok('https://fcm.googleapis.com:8443/x'), ok('https://a:b@fcm.googleapis.com/x'),
        ok('https://fcm.googleapis.com.evil.com/x'), ok('https://evilfcm.googleapis.com.attacker.net/x'), ok('https://169.254.169.254/latest'), ok('https://xpush.apple.com.evil/x')
    ], [false, false, false, false, false, false, false, false]);
    equal('una direccion demasiado larga o vacia no sirve', [ok('https://fcm.googleapis.com/' + 'a'.repeat(1000)), ok(''), !!core.cleanSubscription(null).error], [false, false, true]);
    equal('las llaves deben tener su tamano (65 y 16 bytes)', [
        !!core.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: keys.p256dh.slice(0, 40), auth: keys.auth } }).error,
        !!core.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: keys.p256dh, auth: 'no es base64!' } }).error,
        !!core.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: {} }).error
    ], [true, true, true]);
    equal('la huella de la direccion es el id del telefono (siempre la misma, sin la direccion)', [core.deviceId('https://fcm.googleapis.com/a') === core.deviceId('https://fcm.googleapis.com/a'), core.deviceId('https://fcm.googleapis.com/a').length, core.deviceId('https://fcm.googleapis.com/a').includes('fcm')], [true, 40, false]);
    equal('el tipo de equipo y el navegador (solo para reconocerlos)', [
        core.platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1'), core.platformOf('Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile'), core.platformOf('Mozilla/5.0 (Macintosh) Chrome/131.0'),
        core.browserOf('Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile'), core.browserOf('Mozilla/5.0 (iPhone) Version/17.4 Mobile/15E148 Safari/604.1'), core.browserOf('Mozilla/5.0 (Linux; Android 14) SamsungBrowser/25.0 Chrome/121')
    ], ['iphone', 'android', 'computadora', 'Chrome', 'Safari', 'Samsung Internet']);
}

console.log('\nEl texto del aviso');
{
    const p = core.messagePayload({ id: 'm1', subject: 'Corte de agua', body: 'Mañana de 8 a 12 no habrá agua.' }, 'Residenciales La Perla');
    equal('titulo = el asunto; el texto dice el condominio y lleva a los mensajes despues de entrar', p, {
        title: 'Corte de agua', body: 'Residenciales La Perla: Mañana de 8 a 12 no habrá agua.', url: '/index.html?next=vecino.html&abrir=mensajes', tag: 'mensaje-m1', kind: 'mensaje'
    });
    const sinAsunto = core.messagePayload({ id: 'm2', subject: '', body: '' }, 'La Perla');
    equal('sin asunto ni texto: un titulo con el condominio y un texto general', [sinAsunto.title, sinAsunto.body], ['Mensaje de La Perla', 'Tiene un mensaje nuevo de la administración.']);
    const largo = core.messagePayload({ id: 'm3', subject: 'A'.repeat(200), body: 'palabra '.repeat(500) }, 'X');
    equal('textos largos se recortan con puntos suspensivos (titulo 80, texto 300) y el aviso cabe en el limite', [largo.title.length, largo.title.endsWith('…'), largo.body.length <= 303, Buffer.byteLength(JSON.stringify(largo)) <= core.PAYLOAD_MAX_BYTES], [80, true, true, true]);
    const emoji = core.messagePayload({ id: 'm4', subject: 'x', body: '😀'.repeat(2000) }, 'X');
    yes('aunque el texto sea de letras que pesan mas (emojis), el aviso cabe en el limite', Buffer.byteLength(JSON.stringify(emoji)) <= core.PAYLOAD_MAX_BYTES);
    equal('los saltos de linea y espacios de mas se juntan (asi se ve completo en la pantalla bloqueada)', core.messagePayload({ id: 'm5', subject: ' Hola \n mundo ', body: 'a\n\n b' }, '').body, 'a b');
    const t = core.testPayload('La Perla');
    equal('el aviso de prueba dice que llegaran los mensajes aunque garita.app este cerrado', [t.title, /aunque tenga garita\.app cerrado/.test(t.body), t.kind], ['Aviso de prueba', true, 'prueba']);
}

console.log('\nA quien le llega');
{
    const users = {
        ana: { role: 'vecino' }, beto: { role: 'vecino', active: false }, gua: { role: 'policia' }, adm: { role: 'admin' }, sinpriv: { role: 'vecino', priv: false }, borrado: { role: 'vecino', deleted: true }
    };
    const dev = (id, userId, extra = {}) => ({ id, userId, endpoint: 'https://fcm.googleapis.com/' + id, ...extra });
    const devices = [dev('1', 'ana'), dev('2', 'ana'), dev('3', 'beto'), dev('4', 'gua'), dev('5', 'adm'), dev('6', 'sinpriv'), dev('7', 'nadie'), dev('8', 'ana', { active: false }), dev('9', 'borrado'), { ...dev('10', 'gua'), endpoint: 'https://fcm.googleapis.com/4' }];
    const has = (u) => u.priv !== false;
    const ids = (toRole) => core.recipientsFor({ toRole }, devices, users, has).map((d) => d.id);
    equal('a los vecinos: los telefonos de vecinos activos con "Recibir mensajes" (los dos de Ana)', ids('vecino'), ['1', '2']);
    equal('a los guardias: solo el de la garita (una direccion repetida va una vez)', ids('policia'), ['4']);
    equal('a todos: tambien el administrador; nunca un usuario inactivo, borrado, sin el privilegio o que ya no existe', ids('all'), ['1', '2', '4', '5']);
    equal('un destinatario desconocido no le llega a nadie', ids('auditor-raro'), []);
}

console.log('\nErrores del servicio y envios');
{
    equal('404 y 410: el telefono ya no recibe (se desactiva); 400 con suscripcion vencida tambien; lo demas es un fallo de ese envio', [
        core.classifyError({ statusCode: 410 }), core.classifyError({ statusCode: 404 }), core.classifyError({ statusCode: 400, body: '{"reason":"VapidPkHashMismatch"}' }), core.classifyError({ statusCode: 403, body: 'BadJwtToken' }),
        core.classifyError({ statusCode: 500 }), core.classifyError({ statusCode: 429 }), core.classifyError(new Error('timeout'))
    ], ['gone', 'gone', 'gone', 'gone', 'error', 'error', 'error']);
    let running = 0; let maxRunning = 0;
    const devs = Array.from({ length: 50 }, (_, i) => ({ id: 'd' + i }));
    const results = await core.sendAll(devs, async (d) => {
        running++; maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        const n = Number(d.id.slice(1));
        if (n % 10 === 3) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
        if (n % 10 === 7) { const e = new Error('Server'); e.statusCode = 503; throw e; }
        return { statusCode: 201 };
    }, 8);
    equal('envia a todos con un limite de envios a la vez y un telefono que falla no detiene a los demas', [results.length, maxRunning <= 8, core.summarize(results)], [50, true, { devices: 50, sent: 40, failed: 5, gone: 5 }]);
    const mine = Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, updatedAt: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
    equal('hasta 10 telefonos por persona: al activar uno nuevo se apagan los mas viejos', core.overLimit(mine, 'nuevo').map((d) => d.id), ['t2', 't1', 't0']);
    equal('al volver a activar uno que ya estaba no se cuenta dos veces', core.overLimit(mine.slice(0, 10), 't3').map((d) => d.id), []);
}

console.log('\nEl aviso de verdad: cifrado para el telefono y firmado por garita.app');
{
    const webpush = fnRequire('web-push');
    const ece = fnRequire('http_ece');
    const phone = phoneKeys();
    const vapid = webpush.generateVAPIDKeys();
    const payload = core.messagePayload({ id: 'm9', subject: 'Reunión', body: 'Asamblea el sábado a las 10.' }, 'La Perla');
    const req = webpush.generateRequestDetails({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phone.keys }, JSON.stringify(payload),
        { vapidDetails: { subject: 'https://garita.app', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: core.TTL_SECONDS, urgency: 'high' });
    const plain = ece.decrypt(req.body, { version: 'aes128gcm', privateKey: phone.ecdh, authSecret: phone.keys.auth }).toString('utf8');
    equal('el telefono lo descifra con su llave y lee exactamente el aviso', JSON.parse(plain), payload);
    equal('va cifrado (aes128gcm), con urgencia alta y espera hasta 3 dias si el telefono esta apagado', [req.headers['Content-Encoding'], req.headers.Urgency, req.headers.TTL, req.method], ['aes128gcm', 'high', 259200, 'POST']);
    const auth = String(req.headers.Authorization || '');
    const jwt = (auth.match(/^vapid t=([^,]+), k=(.+)$/) || [])[1] || '';
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] || '', 'base64').toString('utf8') || '{}');
    equal('la firma dice garita.app, es para el servicio del telefono y trae la llave publica del servidor', [claims.sub, claims.aud, auth.endsWith('k=' + vapid.publicKey)], ['https://garita.app', 'https://fcm.googleapis.com', true]);
    yes('el contenido no viaja en claro', !req.body.toString('latin1').includes('Asamblea'));
    let wrong = false;
    try { ece.decrypt(req.body, { version: 'aes128gcm', privateKey: phoneKeys().ecdh, authSecret: phone.keys.auth }); } catch (e) { wrong = true; }
    yes('otro telefono no lo puede leer', wrong);
}

console.log('\nEl navegador (avisos-push.js) con un telefono de mentira');
const A = require('../avisos-push.js');
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_OLD = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 Version/16.3 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
function fakePhone(o = {}) {
    const calls = [];
    const state = { permission: o.permission || 'default', sub: o.sub || null, registered: !!o.sub, subscribeArgs: null, unsubscribed: 0, ask: o.ask || 'granted' };
    const makeSub = (endpoint, keyBytes) => ({
        endpoint, options: { applicationServerKey: keyBytes ? keyBytes.buffer : null },
        toJSON: () => ({ endpoint, keys: { p256dh: 'P' + endpoint.slice(-3), auth: 'A' + endpoint.slice(-3) } }),
        unsubscribe: async () => { state.unsubscribed++; state.sub = null; return true; }
    });
    if (o.sub) state.sub = makeSub(o.sub.endpoint, o.sub.key ? A.b64ToBytes(o.sub.key) : null);
    const pushManager = {
        getSubscription: async () => state.sub,
        subscribe: async (args) => { state.subscribeArgs = args; state.sub = makeSub('https://fcm.googleapis.com/fcm/send/nuevo' + (++state.n || (state.n = 1)), args.applicationServerKey); return state.sub; }
    };
    const reg = { pushManager };
    const store = new Map();
    const nav = {
        userAgent: o.ua || ANDROID, standalone: o.standalone,
        serviceWorker: o.noSw ? undefined : {
            register: async (url, opts) => { state.swUrl = url; state.swScope = opts && opts.scope; state.registered = true; return reg; },
            get ready() { return Promise.resolve(reg); },
            getRegistration: async () => (state.registered ? reg : undefined)
        }
    };
    if (o.noSw) delete nav.serviceWorker;
    const Notification = { get permission() { return state.permission; }, requestPermission: async () => { state.asked = (state.asked || 0) + 1; state.permission = state.ask; return state.ask; } };
    const win = { isSecureContext: o.secure !== false, matchMedia: () => ({ matches: !!o.standalone }) };
    if (!o.noPush) { win.PushManager = function () {}; win.Notification = Notification; }
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const server = o.server || {};
    const call = async (data) => {
        calls.push(data);
        if (server.offline) { const e = new Error('offline'); e.code = 'functions/unavailable'; throw e; }
        if (data.action === 'config') return { publicKey: server.publicKey || SERVER_KEY };
        if (data.action === 'state') return server.state || { active: true, otherUser: false };
        return { ok: true };
    };
    return { state, calls, store, api: A.create({ navigator: nav, window: win, storage, call }) };
}
const SERVER_KEY = b64u(phoneKeys().ecdh.getPublicKey());
{
    equal('iPhone en Safari (sin el icono): hay que agregar garita.app a la pantalla de inicio', fakePhone({ ua: IPHONE_SAFARI, noPush: true }).api.support().reason, 'ios-instalar');
    equal('iPhone abierto desde el icono: si se puede', fakePhone({ ua: IPHONE_SAFARI, standalone: true }).api.support().reason, 'ok');
    equal('iPhone con iOS 16.3: necesita actualizar (desde 16.4)', fakePhone({ ua: IPHONE_OLD, standalone: true }).api.support().reason, 'ios-viejo');
    equal('Android con Chrome: en el navegador, sin instalar nada', fakePhone({ ua: ANDROID }).api.support(), { ios: false, android: true, standalone: false, iosVersion: null, ok: true, reason: 'ok' });
    equal('un navegador sin avisos, o una pagina sin https', [fakePhone({ ua: ANDROID, noPush: true }).api.support().reason, fakePhone({ secure: false }).api.support().reason], ['sin-soporte', 'inseguro']);

    const denied = fakePhone({ ask: 'denied' });
    equal('si la persona no permite las notificaciones, queda bloqueado y no se suscribe ni avisa al servidor', [await denied.api.enable('u-ana'), denied.state.subscribeArgs, denied.calls.length], [{ ok: false, state: 'bloqueado' }, null, 0]);
    equal('con el permiso ya negado, el estado dice bloqueado sin preguntar al servidor', [(await fakePhone({ permission: 'denied' }).api.status()).state], ['bloqueado']);

    const p = fakePhone();
    const r = await p.api.enable('u-ana');
    equal('activar: pide el permiso, instala sw-avisos.js para todo garita.app y se suscribe con la llave del servidor', [r, p.state.asked, p.state.swUrl, p.state.swScope, p.state.subscribeArgs.userVisibleOnly, A.bytesToB64(p.state.subscribeArgs.applicationServerKey)], [{ ok: true, state: 'activo' }, 1, '/sw-avisos.js', '/', true, SERVER_KEY]);
    const reg = p.calls.find((c) => c.action === 'register');
    equal('al servidor le entrega solo la direccion y las llaves del telefono', [p.calls.map((c) => c.action), Object.keys(reg.subscription), reg.subscription.endpoint], [['config', 'register'], ['endpoint', 'keys'], 'https://fcm.googleapis.com/fcm/send/nuevo1']);
    equal('recuerda en el telefono para quien lo activo (sin llaves)', Object.keys(JSON.parse(p.store.get(A.SYNC_KEY))), ['userId', 'endpoint', 'at']);
    equal('activado: el estado lo confirma con el servidor', (await p.api.status()).state, 'activo');

    const other = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/viejo', key: b64u(phoneKeys().ecdh.getPublicKey()) } });
    await other.api.enable('u-ana');
    equal('una suscripcion hecha con otra llave se rehace (si no, los avisos del servidor no llegarian)', [other.state.unsubscribed, other.calls.find((c) => c.action === 'register').subscription.endpoint], [1, 'https://fcm.googleapis.com/fcm/send/nuevo1']);
    const same = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/mismo', key: SERVER_KEY } });
    await same.api.enable('u-ana');
    equal('con la misma llave se reusa la suscripcion', [same.state.unsubscribed, same.state.subscribeArgs], [0, null]);

    const st = (server) => fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', key: SERVER_KEY }, server }).api.status();
    equal('estado: activo, de otra persona, apagado en el servidor o sin conexion (se confirma despues)', [
        (await st({ state: { active: true } })).state, (await st({ state: { active: false, otherUser: true } })).state, (await st({ state: { active: false } })).state, await st({ offline: true }).then((x) => [x.state, x.unconfirmed])
    ], ['activo', 'otro-usuario', 'inactivo', ['activo', true]]);
    equal('sin suscripcion: inactivo (sin preguntar al servidor)', await (async () => { const f = fakePhone({ permission: 'granted' }); return [(await f.api.status()).state, f.calls.length]; })(), ['inactivo', 0]);

    const off = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/apagar', key: SERVER_KEY } });
    off.store.set(A.SYNC_KEY, JSON.stringify({ userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/fcm/send/apagar', at: Date.now() }));
    equal('desactivar: le avisa al servidor, cancela la suscripcion y recuerda que la persona los apago', [await off.api.disable(), off.calls.map((c) => [c.action, c.endpoint]), off.state.unsubscribed, JSON.parse(off.store.get(A.SYNC_KEY)).off, off.api.isOff()], [{ ok: true, state: 'inactivo' }, [['unregister', 'https://fcm.googleapis.com/fcm/send/apagar']], 1, true, true]);

    const sync = (saved, user) => {
        const f = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/s', key: SERVER_KEY } });
        if (saved) f.store.set(A.SYNC_KEY, JSON.stringify(saved));
        return f.api.sync(user).then((did) => [did, f.calls.map((c) => c.action)]);
    };
    // Automatico (pedido del usuario el 2026-11-23: el vecino solo pone su clave): con el permiso ya dado, el portal deja el telefono listo
    equal('al abrir el portal con el permiso dado: completa el registro solo (sin registro, paso el tiempo, cambio la direccion o entro otra persona)', [
        await sync(null, 'u-ana'),
        await sync({ userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/fcm/send/s', at: Date.now() - 4 * 86400000 }, 'u-ana'),
        await sync({ userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/fcm/send/otra', at: Date.now() }, 'u-ana'),
        await sync({ userId: 'u-otra', endpoint: 'https://fcm.googleapis.com/fcm/send/s', at: Date.now() }, 'u-ana')
    ], [[true, ['config', 'register']], [true, ['config', 'register']], [true, ['config', 'register']], [true, ['config', 'register']]]);
    equal('no repite si es reciente y nunca enciende lo que la persona apago', [
        await sync({ userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/fcm/send/s', at: Date.now() }, 'u-ana'),
        await sync({ off: true, at: Date.now() }, 'u-ana')
    ], [[false, []], [false, []]]);
    const noPerm = fakePhone();
    equal('sin el permiso todavia, al abrir el portal NO pregunta (eso solo despues de un toque)', [await noPerm.api.sync('u-ana'), noPerm.state.asked || 0, noPerm.calls.length], [false, 0, 0]);
    const login = fakePhone();
    const atLogin = await login.api.auto('u-ana', { ask: true });
    equal('al ingresar (con el toque de Ingresar): pregunta, se suscribe y registra el telefono de una vez', [atLogin, login.state.asked, login.calls.map((c) => c.action)], [{ ok: true, state: 'activo' }, 1, ['config', 'register']]);
    const loginNo = fakePhone({ ask: 'denied' });
    equal('si no permite, no insiste: queda bloqueado', [await loginNo.api.auto('u-ana', { ask: true }), loginNo.calls.length], [{ ok: false, state: 'bloqueado' }, 0]);
    const offLogin = fakePhone();
    offLogin.store.set(A.SYNC_KEY, JSON.stringify({ off: true, at: Date.now() }));
    equal('al ingresar tampoco enciende lo que la persona apago; "Activar avisos" si (y borra la marca)', [await offLogin.api.auto('u-ana', { ask: true }), (await offLogin.api.enable('u-ana')).state, offLogin.api.isOff()], [{ ok: false, state: 'apagado' }, 'activo', false]);
    equal('en un iPhone sin el icono no intenta nada (el portal explica como agregarlo)', await fakePhone({ ua: IPHONE_SAFARI, noPush: true }).api.auto('u-ana', { ask: true }), { ok: false, state: 'ios-instalar' });
    equal('la prueba va a ESTE telefono (su direccion)', await (async () => { const f = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/prueba', key: SERVER_KEY } }); await f.api.test(); return f.calls; })(), [{ action: 'test', endpoint: 'https://fcm.googleapis.com/fcm/send/prueba' }]);
    equal('las llaves van y vuelven igual (base64 para la web)', A.bytesToB64(A.b64ToBytes(SERVER_KEY)), SERVER_KEY);
}

console.log('\nEl service worker (sw-avisos.js)');
{
    const src = read('sw-avisos.js');
    function runSw(clients = []) {
        const listeners = {};
        const shown = [];
        const opened = [];
        const ctx = {
            URL,
            location: { origin: 'https://garita.app' },
            skipWaiting: () => {},
            addEventListener: (type, fn) => { listeners[type] = fn; },
            registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
            clients: { claim: async () => {}, matchAll: async () => clients, openWindow: async (url) => { opened.push(url); return {}; } }
        };
        ctx.self = ctx;
        vm.runInNewContext(src, ctx);
        const fire = async (type, ev) => { let p = null; listeners[type]({ ...ev, waitUntil: (x) => { p = x; } }); await p; };
        return { listeners, shown, opened, fire };
    }
    const sw = runSw();
    await sw.fire('push', { data: { json: () => ({ title: 'Corte de agua', body: 'Mañana', url: '/index.html?next=vecino.html&abrir=mensajes', tag: 'mensaje-1', kind: 'mensaje' }) } });
    equal('muestra el aviso con el titulo, el texto, el icono de garita.app y a donde lleva', sw.shown[0], { title: 'Corte de agua', options: { body: 'Mañana', icon: '/icono-app-192.png', badge: '/icono-aviso-badge.png', tag: 'mensaje-1', renotify: true, data: { url: 'https://garita.app/index.html?next=vecino.html&abrir=mensajes', kind: 'mensaje' } } });
    await sw.fire('push', { data: { json: () => ({ title: 'x', url: 'https://otro-sitio.com/robar' }) } });
    equal('nunca lleva a otra pagina (un aviso con otra direccion abre garita.app)', sw.shown[1].options.data.url, 'https://garita.app/index.html');
    await sw.fire('push', { data: null });
    equal('un aviso vacio igual se muestra (el iPhone y Chrome lo exigen)', [sw.shown[2].title, sw.shown[2].options.body], ['garita.app', 'Tiene un mensaje nuevo de la administración.']);
    await sw.fire('push', { data: { json: () => { throw new Error('no json'); }, text: () => 'texto suelto' } });
    equal('un aviso que no es JSON se muestra como texto', sw.shown[3].options.body, 'texto suelto');
    const closeIt = { closed: 0 };
    const notification = { close: () => { closeIt.closed++; }, data: { url: 'https://garita.app/index.html?next=vecino.html&abrir=mensajes', kind: 'mensaje' } };
    await sw.fire('notificationclick', { notification });
    equal('al tocarlo sin garita.app abierto: cierra el aviso y abre la entrada (pide la clave y lleva a los mensajes)', [closeIt.closed, sw.opened], [1, ['https://garita.app/index.html?next=vecino.html&abrir=mensajes']]);
    const posted = [];
    let focused = 0;
    const tab = { url: 'https://garita.app/vecino.html#visitas', postMessage: (m) => posted.push(m), focus: async () => { focused++; } };
    const sw2 = runSw([{ url: 'https://garita.app/admin.html', postMessage: () => {}, focus: async () => {} }, tab]);
    await sw2.fire('notificationclick', { notification });
    equal('con el portal abierto: usa esa pestana (ahi esta la sesion), le pide abrir los mensajes y no abre otra', [posted, focused, sw2.opened], [[{ type: 'sisdel-aviso', kind: 'mensaje' }], 1, []]);
    yes('no guarda paginas ni intercepta pedidos (sin "fetch": una version nueva siempre llega)', !/addEventListener\(\s*['"]fetch/.test(src) && !/caches\./.test(src));
}

console.log('\nPaginas, manifiesto, iconos, reglas y funciones');
{
    const vecino = read('vecino.html');
    const index = read('index.html');
    const admin = read('admin.html');
    const ui = read('avisos-ui.js');
    const manifest = JSON.parse(read('manifest.webmanifest'));
    equal('manifiesto: garita.app como app (standalone) que abre la entrada, con iconos de 192 y 512', [manifest.display, manifest.start_url, manifest.scope, manifest.icons.map((i) => i.sizes + ' ' + i.purpose)], ['standalone', '/index.html', '/', ['192x192 any', '512x512 any', '512x512 maskable']]);
    const png = (file) => { const b = fs.readFileSync(new URL(`../${file}`, import.meta.url)); return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]]; };
    equal('los iconos existen con su tamano (el del aviso con transparencia: Android lo pinta de un color)', [png('icono-app-192.png'), png('icono-app-512.png'), png('icono-app-180.png'), png('icono-aviso-badge.png')], [[192, 192, 2], [512, 512, 2], [180, 180, 2], [96, 96, 6]]);
    for (const [name, html] of [['index.html', index], ['vecino.html', vecino]]) {
        yes(`${name} enlaza el manifiesto y el icono del iPhone (para agregarla a la pantalla de inicio)`, html.includes('<link rel="manifest" href="manifest.webmanifest">') && html.includes('<link rel="apple-touch-icon" href="icono-app-180.png">') && html.includes('<meta name="apple-mobile-web-app-capable" content="yes">'));
    }
    yes('vecino.html carga avisos-push.js y avisos-ui.js con la misma version y monta la pantalla con la funcion pushDevice', (vecino.match(/avisos-push\.js\?v=(\w+)/) || [])[1] === (vecino.match(/avisos-ui\.js\?v=(\w+)/) || [])[1] && /httpsCallable\('pushDevice'\)/.test(vecino) && /SisdelAvisosUI\.mount\(/.test(vecino));
    yes('la ventana vieja de mensajes (que usaba la marca "leido" de todos) ya no esta', !/checkUnreadMessages|msgPopupOverlay/.test(vecino));
    yes('despues de entrar desde un aviso, el login lleva a los mensajes del portal', /get\('abrir'\) === 'mensajes'\) target \+= '#mensajes'/.test(index));
    yes('al ingresar la clave, el vecino activa los avisos de una vez (antes de la ubicacion, pegado al toque de Ingresar)', /<script src="avisos-push\.js\?v=\w+"><\/script>/.test(index) && /await enableNoticesAtLogin\(\);\s*await askLocationAtLogin\(\);/.test(index) && /logged\.role !== 'vecino' \|\| !SISDEL\.can\('mensajes\.recibir'\)/.test(index) && /avisos\.auto\(logged\.userId, \{ ask: true \}\)/.test(index));
    yes('index.html y vecino.html cargan la misma version de avisos-push.js', (index.match(/avisos-push\.js\?v=(\w+)/) || [])[1] === (vecino.match(/avisos-push\.js\?v=(\w+)/) || [])[1]);
    yes('en el portal, el primer toque (fuera del panico, de otras ventanas y de los campos) pregunta si todavia no se permitio', /doc\.addEventListener\('pointerup', firstTouch, true\);/.test(ui) && /#panicBtnHost, \.pb-host, input, textarea, select/.test(ui) && /avisos\.auto\(session\.userId, \{ ask: true \}\)/.test(ui));
    yes('la invitacion no sale a quien apago los avisos', /const show = \['inactivo', 'ios-instalar', 'otro-usuario'\]\.includes\(state\) && !off/.test(ui));
    yes('la ventana de avisos tiene la X de cerrar del sistema', /<button class="btn btn-ghost btn-icon modal-close" type="button" id="avClose"/.test(ui));
    yes('lo que escribe la administracion se escapa al pintarlo (asunto, texto y quien lo manda)', /\$\{esc\(m\.subject \|\| 'Mensaje'\)\}/.test(ui) && /<p>\$\{esc\(m\.body\)\}<\/p>/.test(ui) && /esc\(m\.fromName/.test(ui));
    yes('"nuevo" es por persona y por equipo; la marca "leido" se sigue poniendo para la administracion', /SEEN_PREFIX = 'sisdel_msg_vistos_'/.test(ui) && /SISDEL\.markMessageRead\(m\.id\)/.test(ui));
    yes('sin "Recibir mensajes" no se monta nada', /if \(!canReceive\) return null;/.test(ui));
    // SISDEL es un const global de sisdel-core.js (NO window.SISDEL): asi se publico la primera version y la campana no salia
    const coreCtx = vm.createContext({});
    vm.runInContext("const SISDEL = { marca: 'nucleo' }; var window = this;", coreCtx);
    vm.runInContext(ui, coreCtx);
    equal('la pantalla encuentra a SISDEL aunque sisdel-core.js lo declare con const (no es window.SISDEL)', vm.runInContext('SisdelAvisosUI.coreApi({}).marca', coreCtx), 'nucleo');
    yes('y vecino.html se lo pasa directamente al montarla', /SisdelAvisosUI\.mount\(\{\s*SISDEL,\s*session,/.test(vecino));
    const V = (() => { const ctx = { window: {} }; ctx.window = ctx; vm.runInNewContext(ui, ctx); return ctx.SisdelAvisosUI; })();
    equal('cada estado del telefono ofrece lo que se puede hacer', ['activo', 'inactivo', 'otro-usuario', 'bloqueado', 'ios-instalar', 'ios-viejo', 'sin-soporte'].map((s) => V.phoneView(s, {}).buttons.map((b) => b[0])), [['test', 'disable'], ['enable'], ['enable'], ['enable'], [], [], []]);
    yes('en el iPhone explica como agregar garita.app a la pantalla de inicio y que el permiso se cambia en Ajustes', /Agregar a inicio/.test(V.phoneView('ios-instalar', { ios: true }).steps.join(' ')) && /Ajustes del iPhone > Notificaciones/.test(V.phoneView('bloqueado', { ios: true }).steps.join(' ')));
    yes('administracion: casilla "Avisar tambien en el celular" (marcada) que viaja con el mensaje, cuantos lo tienen activado y el resultado de cada envio',
        /<input type="checkbox" id="msgPush" checked/.test(admin) && /createMessage\(condoId, adminName, target, subject, body, \{ push \}\)/.test(admin) && /action: 'summary'/.test(admin) && /\$\{pushLine\(m\)\}/.test(admin));
    yes('sisdel-core.js guarda push solo si se indica (el front viejo no lo manda y el servidor avisa igual)', /if \(opts && typeof opts\.push === 'boolean'\) data\.push = opts\.push;/.test(read('sisdel-core.js')));
    const rules = read('firestore.rules');
    yes('reglas: nadie lee ni escribe los telefonos desde el navegador (con la direccion y la llave del servidor se mandan avisos)', /match \/push_dispositivos\/\{deviceId\} \{\s*allow read, write: if false;/.test(rules));
    const fnIndex = read('functions/index.js');
    yes('functions exporta pushDevice, onMessagePush y residentMessages', /const \{ pushDevice, onMessagePush, residentMessages \} = require\('\.\/src\/avisos-push'\);/.test(fnIndex) && /pushDevice, onMessagePush, residentMessages,/.test(fnIndex));
    const pkg = JSON.parse(read('functions/package.json'));
    equal('web-push fijo en una version estable (3.6.7, de enero de 2024)', pkg.dependencies['web-push'], '3.6.7');
    const srv = read('functions/src/avisos-push.js');
    yes('el servidor solo simula envios en los emuladores (nunca en produccion)', /const IS_EMULATOR = process\.env\.FUNCTIONS_EMULATOR === 'true';/.test(srv) && /if \(IS_EMULATOR && device\.endpoint\.includes\(FAKE_MARK\)\) return fakeSend/.test(srv));
    yes('la llave privada se crea en _privado/push y nunca sale del servidor (config solo entrega la publica)', /const KEYS_DOC = '_privado\/push';/.test(srv) && /return \{ publicKey: \(await loadKeys\(\)\)\.publicKey \};/.test(srv));
    yes('un mensaje con push: false no avisa; un evento repetido no envia dos veces; con tope por hora', /if \(msg\.push === false \|\| msg\.toRole === 'usuario' \|\| msg\.toRole === 'varios'\) return;/.test(srv) && /cur\.data\(\)\.pushResult\) return false/.test(srv) && /MESSAGE_LIMIT = \{ max: 30, windowMs: 60 \* 60 \* 1000 \}/.test(srv));
    yes('la prueba va solo a un telefono del propio usuario y activo', /d\.active === false \|\| d\.userId !== uid\) fail\('failed-precondition'/.test(srv));
}

console.log('\nMensajes de Finanzas por garita.app (un mensaje por residente)');
{
    equal('se aceptan los mensajes con residente y texto; sin repetir residente; el texto se recorta y queda con saltos de linea normales', core.cleanMessageItems([
        { residentId: 'u-ana', text: '  Hola Ana\r\nDebe Q 300  ' }, { residentId: 'u-ana', text: 'otra vez' }, { residentId: 'u-luis', text: 'Hola Luis' }
    ]), { items: [{ residentId: 'u-ana', text: 'Hola Ana\nDebe Q 300' }, { residentId: 'u-luis', text: 'Hola Luis' }], invalid: 0 });
    equal('no sirven: sin residente, con rutas, sin texto o de mas de 1000 letras (se cuentan)', core.cleanMessageItems([
        { residentId: '', text: 'x' }, { residentId: 'a/b', text: 'x' }, { residentId: '..', text: 'x' }, { residentId: 'u-1', text: '   ' }, { residentId: 'u-2', text: 'x'.repeat(1001) }, { residentId: 'u-3', text: 'bien' }
    ]), { items: [{ residentId: 'u-3', text: 'bien' }], invalid: 5 });
    equal('vacio, sin lista o mas de 1500 de una vez: error con el motivo', [
        !!core.cleanMessageItems([]).error, !!core.cleanMessageItems(null).error, /1500/.test(core.cleanMessageItems(Array.from({ length: 1501 }, (_, i) => ({ residentId: 'u' + i, text: 'x' }))).error || ''),
        !!core.cleanMessageItems([{ residentId: 'u', text: '' }]).error
    ], [true, true, true, true]);
    equal('el asunto que ve el vecino segun el mensaje elegido', [core.messageSubject('mora'), core.messageSubject('varios'), core.messageSubject('x')], ['Aviso de saldo pendiente', 'Aviso de la administración', 'Aviso de saldo pendiente']);

    const oikos = read('finanzas/index.html');
    const fin = read('finanzas.html');
    const bloq = read('finanzas-bloqueo.js');
    const srv = read('functions/src/avisos-push.js');
    const rules = read('firestore.rules');
    const coreJs = read('sisdel-core.js');
    const at = (id) => oikos.indexOf(`id="${id}"`);
    yes('el boton de Residentes se llama "Mensajes" (antes "Recordatorios") y la ventana "Mensajes a los residentes"', /<span id="lbl-btn-rem">Mensajes<\/span>/.test(oikos) && /id="title-modal-rem">Mensajes a los residentes<\/h3>/.test(oikos) && !/>Recordatorios<\/span>/.test(oikos));
    yes('el recuadro "Enviar por garita.app" va arriba de "Enviar desde mi WhatsApp" y del WhatsApp del condominio', at('rem-garita') > 0 && at('rem-garita') < at('rem-manual') && at('rem-manual') < at('rem-bulk') && /onclick="sendRemindersGarita\(\)"/.test(oikos));
    yes('cuenta a toda la lista de la barra (sin pedir telefono); con Por seleccion, a los marcados', /function remGaritaList\(\) \{\s*if \(currentRemFilter === 'seleccion'\) \{\s*return remAllResidents\.filter\(r => remSelected\.has\(String\(r\.id\)\)\)/.test(oikos) && /return remShownList\.slice\(\);/.test(oikos));
    yes('manda a cada residente SU texto (el de la ventana con su nombre y su saldo), confirma antes y no envia el aviso sin escribir', /const items = list\.map\(r => \(\{ residentId: String\(r\.id\), text: reminderText\(remManualTemplate\(r\), r\) \}\)\);/.test(oikos) && /if \(!confirm\(`Se enviará por garita\.app/.test(oikos) && /function reminderTemplateReadyText\(r\)/.test(oikos));
    yes('sin el puente (OIKOS fuera de SISDEL) el recuadro no sale', /box\.classList\.toggle\('hidden', !bridge\);\s*if \(!bridge\) return;\s*const n = remGaritaList\(\)\.length;/.test(oikos));
    yes('finanzas.html ofrece el puente solo con "Mensajes a los residentes" (o el Master) y llama a residentMessages', /if \(session\.role === 'master' \|\| SISDEL\.can\('finanzas\.residentes_contactar'\)\) \{\s*const garita = callServer\('residentMessages'\);/.test(fin));
    yes('el bloqueo de pantalla pide el mismo privilegio', /\|sendRemindersGarita\)\\\(\/, \['residentes_contactar'\]\]/.test(bloq));
    yes('el servidor pide el privilegio (o el Master), un condominio activo, tope de 10 envios por hora y solo vecinos activos que reciben mensajes', /const MSG_CONTACT = 'finanzas\.residentes_contactar';/.test(srv) && /privilegios\.has\(me\.data\(\)\.role, me\.data\(\)\.privilegios, MSG_CONTACT\)/.test(srv) && /SEND_LIMIT = \{ max: 10, windowMs: 60 \* 60 \* 1000 \}/.test(srv) && /'mensajes\.recibir'/.test(srv));
    yes('cada vecino recibe su mensaje personal (toRole usuario) y la administracion un resumen (toRole varios); nada pasa por el aviso automatico', /toRole: 'usuario', toUserId: it\.residentId/.test(srv) && /toRole: 'varios', recipients: recipients\.length/.test(srv) && (srv.match(/push: false, source: 'finanzas'/g) || []).length === 2);
    yes('reglas: el mensaje personal solo lo lee (y lo marca leido) el propio vecino, ademas de quien ve todos', /\(pMensajesRecibir\(condoId\) && resource\.data\.toRole == 'usuario' && resource\.data\.toUserId == request\.auth\.uid\)/.test(rules) && /\|\| \(resource\.data\.toRole == 'usuario' && resource\.data\.toUserId == request\.auth\.uid\)\)\s*&& onlyChanges\(\['read'\]\)/.test(rules));
    yes('el portal pide los mensajes personales del vecino; quien ve todos no los baja uno por uno (ve el resumen)', /where\('toRole', '==', 'usuario'\)\.where\('toUserId', '==', String\(uid\)\)/.test(coreJs) && /where\('toRole', '!=', 'usuario'\)/.test(coreJs));
    yes('la campana del vecino muestra sus mensajes personales', /\(m\.toRole === 'usuario' && m\.toUserId === session\.userId\)/.test(read('avisos-ui.js')));
    yes('Administracion > Mensajes muestra el resumen del envio de Finanzas (a cuantos y el resultado en los celulares)', /m\.toRole === 'varios' \? `\$\{Number\(m\.recipients\) \|\| 0\} vecinos, cada uno con su mensaje/.test(read('admin.html')));
}

console.log('\nApagados por ahora (2026-11-24: "no es practico, solo va a poner mas engorroso el uso de la aplicacion")');
{
    const A2 = require('../avisos-push.js');
    equal('el interruptor de los avisos al celular esta apagado (para retomarlos: true en avisos-push.js)', [A2.ENABLED, A2.create({ call: async () => ({}) }).enabled], [false, false]);
    const sub = fakePhone({ permission: 'granted', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/vieja', key: SERVER_KEY } });
    sub.store.set(A2.SYNC_KEY, JSON.stringify({ userId: 'u-ana', endpoint: 'https://fcm.googleapis.com/fcm/send/vieja', at: Date.now() }));
    equal('un telefono que los activo antes se da de baja solo (servidor y navegador), sin preguntar', [await sub.api.retire(), sub.calls.map((c) => [c.action, c.endpoint]), sub.state.unsubscribed, sub.store.has(A2.SYNC_KEY), sub.state.asked || 0], [true, [['unregister', 'https://fcm.googleapis.com/fcm/send/vieja']], 1, false, 0]);
    const none = fakePhone();
    equal('sin suscripcion no hace nada', [await none.api.retire(), none.calls.length], [false, 0]);
    const index = read('index.html');
    const ui = read('avisos-ui.js');
    const admin = read('admin.html');
    const fin = read('finanzas.html');
    const oikos = read('finanzas/index.html');
    yes('al ingresar NO se pregunta nada mientras esten apagados', /if \(typeof SisdelAvisos === 'undefined' \|\| !SisdelAvisos\.ENABLED\) return;/.test(index));
    yes('el portal: sin el recuadro del telefono, sin invitacion, sin el primer toque, sin sync; da de baja el telefono', /if \(!pushOn\) \{ box\.hidden = true; return; \}/.test(ui) && /if \(!pushOn\) \{ invite\.hidden = true; return; \}/.test(ui) && /if \(pushOn\) doc\.addEventListener\('pointerup', firstTouch, true\);/.test(ui) && /if \(pushOn\) Promise\.resolve\(avisos\.sync\(session\.userId\)\)/.test(ui) && /avisos\.retire\(\)/.test(ui));
    yes('la campana sigue: los mensajes de la administracion (y los de Finanzas) se ven al entrar', /SisdelAvisosUI\.mount\(/.test(read('vecino.html')) && /'Mensajes de la administración'/.test(ui));
    yes('administracion: sin la casilla del celular ni sus lineas, y los mensajes salen con push: false', /const AVISOS_CELULAR = typeof SisdelAvisos !== 'undefined' && SisdelAvisos\.ENABLED === true;/.test(admin) && /if \(pushBox\) pushBox\.hidden = true;/.test(admin) && /if \(!AVISOS_CELULAR\) return '';/.test(admin) && /const push = AVISOS_CELULAR && document\.getElementById\('msgPush'\)\.checked;/.test(admin) && /<script src="avisos-push\.js\?v=\w+"><\/script>/.test(admin));
    yes('Finanzas: "Enviar por garita.app" sigue, sin hablar del celular (el puente dice si los avisos estan encendidos)', /push: typeof SisdelAvisos !== 'undefined' && SisdelAvisos\.ENABLED === true,/.test(fin) && /<script src="avisos-push\.js\?v=\w+"><\/script>/.test(fin) && /id="rem-garita-help">A cada residente le llega <b>su<\/b> mensaje en garita\.app: lo ve en la campana de Mensajes al entrar\./.test(oikos) && /if \(!garitaPush\(\)\) \{ remGaritaUsers = null; paintRemGarita\(\); return; \}/.test(oikos));
    yes('todas las paginas cargan la misma version de avisos-push.js', new Set(['index.html', 'vecino.html', 'admin.html', 'finanzas.html'].map((f) => (read(f).match(/avisos-push\.js\?v=(\w+)/) || [])[1])).size === 1);
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
