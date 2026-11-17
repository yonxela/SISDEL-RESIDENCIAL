// Activa el aviso de UltraMsg para el chat de WhatsApp con los residentes (OIKOS > Chats WhatsApp).
// UltraMsg avisa al servidor de cada mensaje que entra, de cada mensaje que sale y de cada palomita (entregado, leido)
// en https://garita.app/api/whatsapp?token=<clave> (vercel.json lo pasa a la funcion whatsappWebhook).
// Lo corre una persona en su terminal: cambia la configuracion de la cuenta de UltraMsg y guarda una clave en produccion.
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node whatsapp-webhook.mjs --target=prod --ver       (como esta, sin claves)
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node whatsapp-webhook.mjs --target=prod --activar   (clave nueva y aviso)
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node whatsapp-webhook.mjs --target=prod --quitar    (apaga el aviso)
// --url=https://otro.dominio cambia la direccion base (por defecto https://garita.app).
// Del lado del servidor solo se guarda la huella de la clave (_privado/whatsapp.webhookTokenHash); la clave misma queda
// solo en la direccion que se le da a UltraMsg. Activar de nuevo cambia la clave (la anterior deja de servir).
import crypto from 'node:crypto';
import readline from 'node:readline';
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const db = connect(target);
const ref = db.doc('_privado/whatsapp');
const BASE = String(args.url || 'https://garita.app').replace(/\/+$/, '');
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const maskUrl = (u) => String(u || '').replace(/token=[^&]+/i, 'token=****');

function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let answered = false;
        rl.on('close', () => { if (!answered) { console.log('\nCancelado: no se cambio nada.'); process.exit(1); } });
        rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer.trim()); });
    });
}

const config = (await ref.get()).data() || {};
const ultra = config.ultramsgInstance && config.ultramsgToken;
const api = (path) => `https://api.ultramsg.com/${encodeURIComponent(config.ultramsgInstance)}/${path}`;

async function ultraSettings() {
    const res = await fetch(`${api('instance/settings')}?token=${encodeURIComponent(config.ultramsgToken)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
async function setUltraSettings(values) {
    const res = await fetch(api('instance/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: config.ultramsgToken, ...values })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
const on = (v) => v === true || v === 'true' || v === 1 || v === '1';

console.log(`Destino: ${target === 'prod' ? 'PRODUCCION' : 'emulador'}`);
console.log(`  Clave del aviso en el servidor: ${config.webhookTokenHash ? `si (activada ${config.webhookActivatedAt || ''})` : 'no'}`);
let current = null;
if (ultra) {
    try {
        current = await ultraSettings();
        console.log(`  UltraMsg avisa a: ${current.webhook_url ? maskUrl(current.webhook_url) : '(nadie)'}`);
        console.log(`  Avisos: mensajes que entran ${on(current.webhook_message_received) ? 'si' : 'no'}, que salen ${on(current.webhook_message_create) ? 'si' : 'no'}, palomitas ${on(current.webhook_message_ack) ? 'si' : 'no'}`);
    } catch (error) {
        console.log(`  UltraMsg: no se pudo leer su configuracion (${error.message}).`);
    }
} else {
    console.log(`  UltraMsg: ${config.provider === 'simulado' ? 'simulado (emulador)' : 'sin configurar (cargue las claves con set-whatsapp.mjs)'}`);
}

if (args.activar) {
    if (target === 'prod' && !ultra) { console.log('Primero cargue las claves de UltraMsg con set-whatsapp.mjs.'); process.exit(1); }
    const mine = current && current.webhook_url && String(current.webhook_url).startsWith(`${BASE}/api/whatsapp`);
    if (current && current.webhook_url && !mine) console.log(`\nATENCION: UltraMsg ya avisa a otra direccion (${maskUrl(current.webhook_url)}); se reemplaza.`);
    if (target === 'prod' && (await ask('\nEsto cambia la configuracion de UltraMsg y crea una clave nueva. Escriba ACTIVAR para seguir: ')) !== 'ACTIVAR') {
        console.log('Cancelado: no se cambio nada.');
        process.exit(1);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const url = `${BASE}/api/whatsapp?token=${token}`;
    const now = new Date().toISOString();
    await ref.set({ webhookTokenHash: sha256(token), webhookActivatedAt: now, updatedAt: now }, { merge: true });
    if (ultra) {
        try {
            await setUltraSettings({ webhook_url: url, webhook_message_received: 'true', webhook_message_create: 'true', webhook_message_ack: 'true', webhook_message_download_media: 'true' });
            const after = await ultraSettings();
            console.log(`\nListo: UltraMsg avisa a ${maskUrl(after.webhook_url)} (entran ${on(after.webhook_message_received) ? 'si' : 'no'}, salen ${on(after.webhook_message_create) ? 'si' : 'no'}, palomitas ${on(after.webhook_message_ack) ? 'si' : 'no'}).`);
            console.log('Desde ahora los mensajes llegan a OIKOS > Chats WhatsApp.');
        } catch (error) {
            console.log(`\nLa clave quedo guardada, pero UltraMsg no acepto el cambio (${error.message}).`);
            console.log('Péguelo a mano en el panel de UltraMsg (Instance > Settings > Webhook URL) y marque los avisos');
            console.log('"on message received", "on message create" y "on message ack". La direccion (no la comparta):');
            console.log(`  ${url}`);
        }
    } else {
        console.log(`\nEmulador: clave guardada. Direccion de prueba: ${url}`);
    }
} else if (args.quitar) {
    if (target === 'prod' && (await ask('\nEsto apaga el aviso de UltraMsg (el chat deja de recibir mensajes). Escriba QUITAR para seguir: ')) !== 'QUITAR') {
        console.log('Cancelado: no se cambio nada.');
        process.exit(1);
    }
    const now = new Date().toISOString();
    if (ultra) {
        try { await setUltraSettings({ webhook_url: '', webhook_message_received: 'false', webhook_message_create: 'false', webhook_message_ack: 'false' }); }
        catch (error) { console.log(`UltraMsg no acepto el cambio (${error.message}); quitelo a mano en su panel.`); }
    }
    // La huella se reemplaza por nada (los avisos que lleguen se rechazan); queda la fecha en que se apago
    await ref.set({ webhookTokenHash: null, webhookDisabledAt: now, updatedAt: now }, { merge: true });
    console.log('Aviso apagado.');
}
process.exit(0);
