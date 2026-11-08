// Carga las claves de WhatsApp para las alertas de panico (las lee solo el servidor, en _privado/whatsapp).
// Uso (lo corre una persona en su terminal; las claves no se muestran ni quedan en el historial):
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node set-whatsapp.mjs --target=prod
//   node set-whatsapp.mjs --target=prod --ver        (solo muestra que esta configurado, sin claves)
// Proveedores: UltraMsg (principal) y Meta Cloud API (respaldo). Se puede cargar uno o los dos.
// Numero de la central: con codigo de pais, solo digitos (ej. 50212345678).
import readline from 'node:readline';
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const db = connect(target);
const ref = db.doc('_privado/whatsapp');

function ask(question, hidden = false) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) rl._writeToOutput = (text) => { if (text.startsWith(question)) process.stdout.write(question); };
        rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    });
}

const current = (await ref.get()).data() || {};
const describe = (c) => [
    `  Central: ${c.central ? '...' + String(c.central).slice(-4) : '(sin numero)'}`,
    `  UltraMsg: ${c.ultramsgInstance && c.ultramsgToken ? 'configurado' : 'no'}`,
    `  Meta Cloud API: ${c.metaToken && c.metaPhoneId ? 'configurado' : 'no'}`
].join('\n');

if (args.ver) {
    console.log(`WhatsApp en ${target}:\n${describe(current)}`);
    process.exit(0);
}

console.log(`Configurar WhatsApp en ${target}. Deje en blanco para conservar el valor actual.\n${describe(current)}\n`);
const central = (await ask('Numero de la central (con codigo de pais): ')).replace(/\D/g, '');
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
console.log(`\nGuardado en ${target}:\n${describe(next)}`);
process.exit(0);
