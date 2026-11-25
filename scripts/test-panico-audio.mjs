// Pruebas del audio de doble via entre la garita y el vecino que pidio ayuda (functions/src/panico-audio.js, panicAudio) con una
// base de datos simulada en memoria (sin emuladores): quien puede llamar y contestar, la llamada (oferta, respuesta, colgar), la
// llamada sin contestar, la alerta cerrada y los servidores de enlace (STUN, TURN fijo y Cloudflare).
// Uso: node test-panico-audio.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// ── Base de datos en memoria (con subcolecciones) ──
const store = new Map();
const snapOf = (path) => ({ exists: store.has(path), data: () => (store.has(path) ? { ...store.get(path) } : undefined), id: path.split('/').pop(), ref: docRef(path) });
function docRef(path) {
    return {
        path, id: path.split('/').pop(),
        get: async () => snapOf(path),
        delete: async () => { store.delete(path); },
        set: async (data) => { store.set(path, { ...data }); },
        update: async (data) => { if (!store.has(path)) throw new Error('no existe'); store.set(path, { ...store.get(path), ...data }); },
        collection: (name) => collectionRef(`${path}/${name}`)
    };
}
function collectionRef(path, filters = []) {
    return {
        doc: (id) => docRef(`${path}/${id}`),
        where: (f, op, v) => collectionRef(path, [...filters, [f, op, v]]),
        get: async () => {
            const docs = [...store.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
                .filter((k) => filters.every(([f, , v]) => store.get(k)[f] === v)).map(snapOf);
            return { docs, size: docs.length, empty: !docs.length };
        }
    };
}
const fakeDb = {
    doc: docRef, collection: (p) => collectionRef(p),
    runTransaction: async (fn) => fn({ get: async (r) => r.get(), set: (r, d) => store.set(r.path, { ...d }), update: (r, d) => store.set(r.path, { ...store.get(r.path), ...d }) })
};
const firebasePath = require.resolve('../functions/src/firebase.js');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: fakeDb, auth: {} } };
const { panicAudio, _test } = require('../functions/src/panico-audio.js');

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const SECRET_A = 'A'.repeat(43);
const SECRET_B = 'B'.repeat(43);
const ago = (ms) => new Date(Date.now() - ms).toISOString();
function seed() {
    store.clear();
    _test.resetIceCache();
    const person = (id, role, code, extra = {}) => {
        store.set(`condominios/c1/usuarios/${id}`, { name: `Nombre ${id}`, role, active: true, ...extra });
        if (code) store.set(`codigos/${code}`, { condominioId: 'c1', userId: id, role });
    };
    person('u-ana', 'vecino', 'VA101');
    person('u-maria', 'vecino', 'VM102');
    person('u-pedro', 'policia', 'VP103');
    person('u-sofia', 'auditor', 'VS104');
    person('u-sinpermiso', 'policia', 'VP105', { privilegios: { 'panico.atender': false } });
    // Dos telefonos de la casa de Ana vinculados al QR; A envio la alerta del QR
    store.set(`condominios/c1/panico_dispositivos/${sha256(SECRET_A)}`, { userId: 'u-ana', codeHash: sha256('VA101') });
    store.set(`condominios/c1/panico_dispositivos/${sha256(SECRET_B)}`, { userId: 'u-ana', codeHash: sha256('VA101') });
    const alert = (id, extra) => store.set(`condominios/c1/alertas_panico/${id}`, { source: 'vecino', userId: 'u-ana', status: 'ACTIVE', createdAt: ago(60000), ...extra });
    alert('al-qr', { deviceId: sha256(SECRET_A) });
    alert('al-portal', {});
    alert('al-cerrada', { status: 'RESOLVED' });
    alert('al-vieja', { createdAt: ago(7 * 3600 * 1000) });
    store.set('condominios/c1/alertas_panico/al-guardia', { source: 'guardia', userId: 'u-pedro', status: 'ACTIVE', createdAt: ago(1000) });
}
const staff = (uid, data) => panicAudio.run({ auth: { uid, token: { condominioId: 'c1' } }, data: { c: 'c1', ...data }, rawRequest: { headers: {} } });
const qr = (secret, data) => panicAudio.run({ auth: null, data: { c: 'c1', secret, ...data }, rawRequest: { headers: {} } });
const codeOf = async (p) => { try { await p; return 'sin error'; } catch (e) { return e.code || e.message; } };

console.log('\nQuien puede');
seed();
{
    const ice = await staff('u-pedro', { action: 'ice', alertId: 'al-qr' });
    equal('la garita (quien atiende alertas) recibe los servidores de enlace: sin configurar, solo STUN', [ice.ok, ice.iceServers.length, String(ice.iceServers[0].urls[0]).startsWith('stun:')], [true, 1, true]);
    equal('quien no atiende alertas (auditor) no llama', await codeOf(staff('u-sofia', { action: 'offer', alertId: 'al-qr', sdp: SDP })), 'permission-denied');
    equal('un guardia al que se le quito "Atender alertas" tampoco', await codeOf(staff('u-sinpermiso', { action: 'ice', alertId: 'al-qr' })), 'permission-denied');
    equal('otro vecino no entra a la llamada de Ana', await codeOf(staff('u-maria', { action: 'poll', alertId: 'al-portal' })), 'permission-denied');
    equal('sin sesion ni telefono vinculado, nada', await codeOf(panicAudio.run({ auth: null, data: { c: 'c1', action: 'ice', alertId: 'al-qr' }, rawRequest: { headers: {} } })), 'permission-denied');
    equal('una sesion de otro condominio, nada', await codeOf(panicAudio.run({ auth: { uid: 'u-pedro', token: { condominioId: 'c2' } }, data: { c: 'c1', action: 'ice', alertId: 'al-qr' }, rawRequest: { headers: {} } })), 'permission-denied');
    equal('el telefono que envio la alerta del QR si contesta', (await qr(SECRET_A, { action: 'poll', alertId: 'al-qr' })).ok, true);
    equal('otro telefono de la casa no (recibe el aviso, no la llamada)', await codeOf(qr(SECRET_B, { action: 'poll', alertId: 'al-qr' })), 'permission-denied');
    equal('el portal contesta la alerta que salio del portal, no la del QR', [(await staff('u-ana', { action: 'poll', alertId: 'al-portal' })).ok, await codeOf(staff('u-ana', { action: 'poll', alertId: 'al-qr' }))], [true, 'permission-denied']);
    equal('una alerta de un guardia no tiene audio (no hay telefono de vecino que conteste)', await codeOf(staff('u-pedro', { action: 'offer', alertId: 'al-guardia', sdp: SDP })), 'not-found');
    store.set(`codigos/VA999`, { condominioId: 'c1', userId: 'u-ana', role: 'vecino' });
    store.delete('codigos/VA101');
    equal('si le cambiaron el codigo al vecino, el telefono vinculado con el viejo ya no entra', await codeOf(qr(SECRET_A, { action: 'poll', alertId: 'al-qr' })), 'permission-denied');
}

console.log('\nLa llamada');
seed();
{
    const offer = await staff('u-pedro', { action: 'offer', alertId: 'al-qr', sdp: SDP });
    equal('la garita llama y queda la llamada (sin grabar nada)', [offer.ok, typeof offer.callId, store.get('condominios/c1/alertas_panico/al-qr/audio/llamada').state, store.get('condominios/c1/alertas_panico/al-qr/audio/llamada').byName], [true, 'string', 'llamando', 'Nombre u-pedro']);
    const poll = await qr(SECRET_A, { action: 'poll', alertId: 'al-qr' });
    equal('el telefono del vecino ve que lo llaman, con la oferta y quien llama', [poll.call && poll.call.callId, poll.call && poll.call.offer === SDP, poll.call && poll.call.byName], [offer.callId, true, 'Nombre u-pedro']);
    equal('mientras no contesta, la garita espera', (await staff('u-pedro', { action: 'wait', alertId: 'al-qr', callId: offer.callId })).state, 'llamando');
    equal('contestar otra llamada (otro numero) no sirve', (await qr(SECRET_A, { action: 'answer', alertId: 'al-qr', callId: 'otra', sdp: SDP })).ok, false);
    equal('el telefono contesta solo', (await qr(SECRET_A, { action: 'answer', alertId: 'al-qr', callId: offer.callId, sdp: SDP })).ok, true);
    const wait = await staff('u-pedro', { action: 'wait', alertId: 'al-qr', callId: offer.callId });
    equal('la garita recibe la respuesta: conectados', [wait.state, wait.answer === SDP], ['conectado', true]);
    equal('el vecino no llama y la garita no contesta', [await codeOf(qr(SECRET_A, { action: 'offer', alertId: 'al-qr', sdp: SDP })), await codeOf(staff('u-pedro', { action: 'answer', alertId: 'al-qr', callId: offer.callId, sdp: SDP }))], ['permission-denied', 'permission-denied']);
    await staff('u-pedro', { action: 'hangup', alertId: 'al-qr', callId: offer.callId });
    const after = await qr(SECRET_A, { action: 'poll', alertId: 'al-qr' });
    equal('la garita cuelga: el telefono lo ve y queda quien colgo', [after.call, after.state, after.callId, store.get('condominios/c1/alertas_panico/al-qr/audio/llamada').endedBy], [undefined, 'colgado', offer.callId, 'garita']);
    const again = await staff('u-pedro', { action: 'offer', alertId: 'al-qr', sdp: SDP });
    await qr(SECRET_A, { action: 'hangup', alertId: 'al-qr', callId: again.callId });
    equal('el vecino tambien puede colgar', [(await staff('u-pedro', { action: 'wait', alertId: 'al-qr', callId: again.callId })).state, store.get('condominios/c1/alertas_panico/al-qr/audio/llamada').endedBy], ['colgado', 'vecino']);
    const ring = await staff('u-pedro', { action: 'offer', alertId: 'al-portal', sdp: SDP });
    store.get('condominios/c1/alertas_panico/al-portal/audio/llamada').at = ago(2 * 60 * 1000);
    equal('una llamada que nadie contesta en 90 segundos: sin respuesta, y el telefono ya no la ve', [(await staff('u-pedro', { action: 'wait', alertId: 'al-portal', callId: ring.callId })).state, (await staff('u-ana', { action: 'poll', alertId: 'al-portal' })).call], ['sin_respuesta', undefined]);
    equal('contestarla tarde no sirve', (await staff('u-ana', { action: 'answer', alertId: 'al-portal', callId: ring.callId, sdp: SDP })).ok, false);
    equal('una oferta que no es una llamada de audio se rechaza', await codeOf(staff('u-pedro', { action: 'offer', alertId: 'al-qr', sdp: '<script>' })), 'invalid-argument');
    equal('una accion desconocida se rechaza', await codeOf(staff('u-pedro', { action: 'grabar', alertId: 'al-qr' })), 'invalid-argument');
}

console.log('\nAlerta cerrada');
seed();
{
    equal('una alerta resuelta ya no se llama', (await staff('u-pedro', { action: 'offer', alertId: 'al-cerrada', sdp: SDP })).ok, false);
    equal('y el telefono deja de preguntar (open: false)', (await staff('u-ana', { action: 'poll', alertId: 'al-cerrada' })).open, false);
    equal('una alerta de mas de 6 horas tampoco', (await staff('u-ana', { action: 'poll', alertId: 'al-vieja' })).open, false);
}

console.log('\nServidores de enlace (TURN)');
seed();
{
    store.set('_privado/webrtc', { iceServers: [{ urls: ['turns:turn.ejemplo.com:443'], username: 'u', credential: 'c' }] });
    _test.resetIceCache();
    const fixed = await staff('u-pedro', { action: 'ice', alertId: 'al-qr' });
    equal('con un TURN fijo configurado: STUN y el TURN', [fixed.iceServers.length, fixed.iceServers[1].urls[0]], [2, 'turns:turn.ejemplo.com:443']);
    store.set('_privado/webrtc', { cloudflare: { keyId: 'llave123', apiToken: 'x'.repeat(30) } });
    _test.resetIceCache();
    const realFetch = globalThis.fetch;
    let asked = null;
    globalThis.fetch = async (url, init) => { asked = { url, auth: init.headers.Authorization }; return { ok: true, json: async () => ({ iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'temp', credential: 'temp-pass' } }) }; };
    const cf = await staff('u-pedro', { action: 'ice', alertId: 'al-qr' });
    equal('con Cloudflare: pide credenciales cortas con su llave y las entrega junto al STUN', [cf.iceServers.length, cf.iceServers[1].username, /keys\/llave123\/credentials\/generate$/.test(asked.url), asked.auth === `Bearer ${'x'.repeat(30)}`], [2, 'temp', true, true]);
    asked = null;
    await staff('u-pedro', { action: 'ice', alertId: 'al-qr' });
    equal('no se le pide a Cloudflare en cada llamada (10 minutos de memoria)', asked, null);
    _test.resetIceCache();
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    equal('si Cloudflare falla, queda el STUN (el audio intenta igual)', (await staff('u-pedro', { action: 'ice', alertId: 'al-qr' })).iceServers.length, 1);
    globalThis.fetch = realFetch;
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
