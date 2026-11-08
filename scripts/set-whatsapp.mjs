// Carga las claves de WhatsApp para las alertas de panico (las lee solo el servidor, en _privado/whatsapp).
// Uso (lo corre una persona en su terminal; las claves no se muestran ni quedan en el historial):
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node set-whatsapp.mjs --target=prod
//   node set-whatsapp.mjs --target=prod --ver        (solo muestra que esta configurado, sin claves)
//   node set-whatsapp.mjs --target=prod --probar     (verifica las claves con el proveedor sin enviar mensajes)
//   node set-whatsapp.mjs --target=prod --quitar=ultramsg|meta|todo   (borra esas claves; "todo" deja WhatsApp apagado)
// Proveedores: UltraMsg (principal) y Meta Cloud API (respaldo). Se puede cargar uno o los dos.
// Numero de la central: con codigo de pais, solo digitos (ej. 50212345678).
import readline from 'node:readline';
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const db = connect(target);
const ref = db.doc('_privado/whatsapp');

// Pregunta en la terminal. Con Ctrl+C o Ctrl+D se cancela sin guardar nada.
function ask(question, hidden = false) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let answered = false;
        if (hidden) rl._writeToOutput = (text) => { if (text.startsWith(question)) process.stdout.write(question); };
        rl.on('close', () => {
            if (answered) return;
            console.log('\nCancelado: no se guardo nada.');
            process.exit(1);
        });
        rl.question(question, (answer) => { answered = true; rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    });
}

const current = (await ref.get()).data() || {};
const describe = (c) => [
    `  Central: ${c.central ? '...' + String(c.central).slice(-4) : '(sin numero)'}`,
    `  UltraMsg: ${c.ultramsgInstance && c.ultramsgToken ? 'configurado' : 'no'}`,
    `  Meta Cloud API: ${c.metaToken && c.metaPhoneId ? 'configurado' : 'no'}`
].join('\n');

// Consulta el estado de la cuenta en cada proveedor. No envia ningun mensaje ni muestra las claves.
async function probe(c) {
    const lines = [];
    if (c.provider === 'simulado') lines.push('  Proveedor simulado (emulador): no se envia nada.');
    if (!c.central || String(c.central).length < 10) lines.push('  Central: FALTA el numero completo con codigo de pais.');
    if (c.ultramsgInstance && c.ultramsgToken) {
        try {
            const url = `https://api.ultramsg.com/${encodeURIComponent(c.ultramsgInstance)}/instance/status?token=${encodeURIComponent(c.ultramsgToken)}`;
            const res = await fetch(url);
            const data = await res.json().catch(() => ({}));
            const account = data && data.status && data.status.accountStatus;
            if (res.ok && account && account.status === 'authenticated') {
                lines.push(`  UltraMsg: OK, la instancia esta conectada a WhatsApp (${account.substatus || 'conectada'}).`);
            } else if (res.ok && account) {
                lines.push(`  UltraMsg: la instancia existe pero NO esta conectada (${account.status}). Escanee el codigo QR en el panel de UltraMsg.`);
            } else {
                lines.push(`  UltraMsg: ERROR, las claves no funcionan (${(data && data.error) || `HTTP ${res.status}`}). Revise el ID de instancia y el token.`);
            }
        } catch (error) {
            lines.push(`  UltraMsg: no se pudo consultar (${error.message}).`);
        }
    } else lines.push('  UltraMsg: sin configurar.');
    if (c.metaToken && c.metaPhoneId) {
        try {
            const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(c.metaPhoneId)}?fields=display_phone_number,verified_name`, {
                headers: { Authorization: `Bearer ${c.metaToken}` }
            });
            const data = await res.json().catch(() => ({}));
            lines.push(res.ok
                ? `  Meta: OK, numero ${data.display_phone_number || ''} (${data.verified_name || 'sin nombre'}).`
                : `  Meta: ERROR, las claves no funcionan (${(data.error && data.error.message) || `HTTP ${res.status}`}).`);
        } catch (error) {
            lines.push(`  Meta: no se pudo consultar (${error.message}).`);
        }
    } else lines.push('  Meta Cloud API: sin configurar.');
    return lines.join('\n');
}

if (args.quitar) {
    const what = String(args.quitar);
    if (!['ultramsg', 'meta', 'todo'].includes(what)) {
        console.log('Use --quitar=ultramsg, --quitar=meta o --quitar=todo');
        process.exit(1);
    }
    const next = { ...current, updatedAt: new Date().toISOString() };
    if (what === 'ultramsg' || what === 'todo') { delete next.ultramsgInstance; delete next.ultramsgToken; }
    if (what === 'meta' || what === 'todo') { delete next.metaPhoneId; delete next.metaToken; }
    await ref.set(next);
    console.log(`Quitado (${what}) en ${target}:\n${describe(next)}`);
    process.exit(0);
}

if (args.ver) {
    console.log(`WhatsApp en ${target}:\n${describe(current)}`);
    process.exit(0);
}

if (args.probar) {
    console.log(`Probando WhatsApp en ${target} (no se envia ningun mensaje):\n${await probe(current)}`);
    process.exit(0);
}

console.log(`Configurar WhatsApp en ${target}. Deje en blanco para conservar el valor actual.\n${describe(current)}\n`);
const central = (await ask('Numero de la central (con codigo de pais): ')).replace(/\D/g, '');
if (central && central.length < 10) {
    console.log('El numero de la central debe llevar el codigo de pais y el numero completo (ej. 50212345678). No se guardo nada.');
    process.exit(1);
}
const ultramsgInstance = await ask('UltraMsg - ID de instancia (blanco si no usa UltraMsg): ');
const ultramsgToken = ultramsgInstance ? await ask('UltraMsg - token (no se muestra): ', true) : '';
const metaPhoneId = await ask('Meta - Phone Number ID (blanco si no usa Meta): ');
const metaToken = metaPhoneId ? await ask('Meta - token de acceso (no se muestra): ', true) : '';

const next = { ...current, updatedAt: new Date().toISOString() };
delete next.provider; // "simulado" solo existe en el emulador de pruebas
if (central) next.central = central;
if (ultramsgInstance) { next.ultramsgInstance = ultramsgInstance; next.ultramsgToken = ultramsgToken; }
if (metaPhoneId) { next.metaPhoneId = metaPhoneId; next.metaToken = metaToken; }
await ref.set(next);
console.log(`\nGuardado en ${target}:\n${describe(next)}\n\nProbando las claves (no se envia ningun mensaje):\n${await probe(next)}`);
process.exit(0);
