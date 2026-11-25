// Servidor de enlace (TURN) para el audio de doble via entre la garita y el vecino que pidio ayuda (functions/src/panico-audio.js).
// En redes de celular muchas veces no hay camino directo entre los dos telefonos y el audio no conecta: un TURN lo pasa.
// Se guarda en _privado/webrtc (solo lo lee el servidor; nunca va a una pagina tal cual: el servidor da credenciales de 24 horas).
// Uso (lo corre una persona; con GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter para --target=prod):
//   node set-audio-enlace.mjs --target=prod --ver                       (dice que hay configurado, sin mostrar claves)
//   CF_TURN_KEY_ID=... CF_TURN_TOKEN=... node set-audio-enlace.mjs --target=prod --cloudflare
//        (Cloudflare Realtime > TURN: el "Turn Token ID" y su "API Token"; recomendado: el servidor pide credenciales cortas)
//   TURN_URLS="turns:turn.ejemplo.com:443,turn:turn.ejemplo.com:3478" TURN_USER=... TURN_PASS=... node set-audio-enlace.mjs --target=prod --turn
//        (cualquier otro proveedor con usuario y clave fijos)
//   node set-audio-enlace.mjs --target=prod --quitar                    (vuelve a solo STUN)
// Las claves van por variables de entorno para que no queden en el historial de la terminal.
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const db = connect(target);
const ref = db.doc('_privado/webrtc');
const now = new Date().toISOString();

if (args.ver) {
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : {};
    if (d.cloudflare && d.cloudflare.keyId) console.log(`Cloudflare TURN configurado (key ${String(d.cloudflare.keyId).slice(0, 6)}..., desde ${d.updatedAt || '?'})`);
    else if (Array.isArray(d.iceServers) && d.iceServers.length) console.log(`TURN fijo configurado: ${d.iceServers.map((s) => [].concat(s.urls).join(' ')).join(' | ')} (desde ${d.updatedAt || '?'})`);
    else console.log('Sin servidor de enlace: el audio usa solo STUN (conecta en muchas redes, no en todas).');
    process.exit(0);
}
if (args.quitar) {
    await ref.set({ cloudflare: null, iceServers: [], updatedAt: now });
    console.log('Listo: el audio vuelve a usar solo STUN.');
    process.exit(0);
}
if (args.cloudflare) {
    const keyId = String(process.env.CF_TURN_KEY_ID || '').trim();
    const apiToken = String(process.env.CF_TURN_TOKEN || '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId) || apiToken.length < 20) { console.error('Faltan CF_TURN_KEY_ID y CF_TURN_TOKEN (variables de entorno).'); process.exit(1); }
    // Se prueba antes de guardar: Cloudflare debe dar credenciales con esa llave
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 600 })
    });
    if (!res.ok) { console.error(`Cloudflare no dio credenciales con esa llave (HTTP ${res.status}). No se guardo nada.`); process.exit(1); }
    await ref.set({ cloudflare: { keyId, apiToken }, iceServers: [], updatedAt: now });
    console.log('Listo: Cloudflare TURN configurado (probado). Las paginas reciben credenciales de 24 horas.');
    process.exit(0);
}
if (args.turn) {
    const urls = String(process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter((u) => /^turns?:[^\s]+$/.test(u));
    const username = String(process.env.TURN_USER || '');
    const credential = String(process.env.TURN_PASS || '');
    if (!urls.length || !username || !credential) { console.error('Faltan TURN_URLS, TURN_USER y TURN_PASS (variables de entorno).'); process.exit(1); }
    await ref.set({ cloudflare: null, iceServers: [{ urls, username, credential }], updatedAt: now });
    console.log(`Listo: TURN fijo configurado (${urls.join(' ')}).`);
    process.exit(0);
}
console.error('Use --ver, --cloudflare, --turn o --quitar (ver el encabezado de este archivo).');
process.exit(1);
