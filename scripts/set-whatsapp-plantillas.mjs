// Carga el canal y las PLANTILLAS del WhatsApp oficial de Meta en _privado/whatsapp (no son secretas; el token de Meta se carga
// aparte con set-whatsapp.mjs). Las plantillas se crean y aprueban en Meta (Administrador de WhatsApp > Plantillas de mensajes);
// aqui solo se le dice al sistema cual usar y que dato va en cada hueco ({{1}}, {{2}}...).
// Uso (lo corre una persona en su terminal):
//   GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node set-whatsapp-plantillas.mjs --target=prod            (pregunta las plantillas)
//   node set-whatsapp-plantillas.mjs --target=prod --ver                    (muestra lo configurado, sin claves)
//   node set-whatsapp-plantillas.mjs --target=prod --probar                 (pregunta a Meta si estan APROBADAS; no envia nada)
//   node set-whatsapp-plantillas.mjs --target=prod --canal=meta|ultramsg    (por donde salen los avisos)
//   node set-whatsapp-plantillas.mjs --target=prod --panico                 (carga las 3 plantillas de las alertas de panico)
//   node set-whatsapp-plantillas.mjs --target=prod --canal-panico=meta|ultramsg   (por donde salen las alertas de panico)
// Alertas de panico (functions/src/rondas/panico-meta.js): alerta_panico, alerta_panico_familia y prueba_sin_novedad, con sus
// datos fijos; con --canal-panico=meta la alerta, el aviso a familiares y la prueba salen por Meta (los recordatorios no cambian).
// Tipos de aviso: "mora" (Mensaje por morosidad) y "general" (Mensajes varios).
// Datos que puede llevar un hueco: nombre, casa, saldo, cuotas, mora, condominio (en el orden de {{1}}, {{2}}...).
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { connect, parseArgs } from './admin.mjs';

const require = createRequire(import.meta.url);
const meta = require('../functions/src/rondas/meta-estado.js');
const panicMeta = require('../functions/src/rondas/panico-meta.js');

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const db = connect(target);
const ref = db.doc('_privado/whatsapp');
const current = (await ref.get()).data() || {};
const API = 'https://graph.facebook.com/v21.0';

function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let answered = false;
        rl.on('close', () => { if (!answered) { console.log('\nCancelado: no se guardo nada.'); process.exit(1); } });
        rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer.trim()); });
    });
}

const describe = (c) => {
    const t = c.metaTemplates || {};
    const one = (key) => {
        const tpl = meta.normalizeTemplate(t[key]);
        return tpl ? `${tpl.name} (${tpl.language}; huecos: ${tpl.params.join(', ') || 'ninguno'})` : '(sin plantilla)';
    };
    return [
        `  Canal de los avisos: ${c.channel === 'meta' ? 'WhatsApp oficial de Meta (solo Meta)' : 'UltraMsg (como siempre)'}`,
        `  Meta (token y numero): ${c.metaToken && c.metaPhoneId ? 'configurado' : 'FALTA (use set-whatsapp.mjs)'}`,
        `  Cuenta de WhatsApp Business (WABA): ${c.metaWabaId ? 'configurada' : 'no (se pide al cargar plantillas; sirve para comprobar que esten aprobadas)'}`,
        `  Plantilla de mora: ${one('mora')}`,
        `  Plantilla de mensajes varios: ${one('general')}`,
        `  Canal de las alertas de panico: ${c.panicChannel === 'meta' ? 'WhatsApp oficial de Meta (con plantilla)' : 'UltraMsg (como siempre)'}`,
        ...panicMeta.PANIC_KINDS.map((key) => {
            const tpl = panicMeta.panicTemplate(c, key);
            return `  ${panicMeta.KIND_LABEL[key]}: ${tpl ? `${tpl.name} (${tpl.language}; huecos: ${tpl.params.join(', ')})` : '(sin plantilla)'}`;
        })
    ].join('\n');
};

// El cuerpo (texto) de una plantilla segun Meta, y su estado. null si no se pudo consultar. No imprime el token.
async function fromMeta(c, name, language) {
    if (!c.metaToken || !c.metaWabaId) return null;
    try {
        const url = `${API}/${encodeURIComponent(c.metaWabaId)}/message_templates?${new URLSearchParams({ name, fields: 'name,status,category,language,components', limit: '20' })}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${c.metaToken}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { error: (data.error && data.error.message) || `HTTP ${res.status}` };
        const rows = Array.isArray(data.data) ? data.data : [];
        const row = rows.find((r) => r.language === language) || rows[0];
        if (!row) return { missing: true };
        const body = (row.components || []).find((x) => x.type === 'BODY');
        return { status: row.status, category: row.category, language: row.language, body: body ? String(body.text || '') : '' };
    } catch (error) {
        return { error: error.message };
    }
}

if (args.ver) {
    console.log(`WhatsApp oficial de Meta en ${target}:\n${describe(current)}`);
    process.exit(0);
}

if (args.probar) {
    console.log(`Comprobando las plantillas en Meta (${target}; no se envia ningun mensaje):`);
    if (!current.metaToken || !current.metaWabaId) {
        console.log('  Faltan el token de Meta (set-whatsapp.mjs) o el ID de la cuenta de WhatsApp Business (se pide al cargar plantillas).');
        process.exit(1);
    }
    for (const key of ['mora', 'general', ...panicMeta.PANIC_KINDS]) {
        const tpl = panicMeta.PANIC_KINDS.includes(key) ? panicMeta.panicTemplate(current, key) : meta.normalizeTemplate((current.metaTemplates || {})[key]);
        if (!tpl) { console.log(`  ${key}: sin plantilla configurada.`); continue; }
        const info = await fromMeta(current, tpl.name, tpl.language);
        if (!info) console.log(`  ${key}: no se pudo consultar.`);
        else if (info.error) console.log(`  ${key}: ERROR de Meta (${info.error}).`);
        else if (info.missing) console.log(`  ${key}: Meta NO tiene una plantilla llamada "${tpl.name}" en ${tpl.language}.`);
        else {
            const same = String(info.body).replace(/\s+/g, ' ').trim() === String(tpl.body).replace(/\s+/g, ' ').trim();
            const notes = [info.status === 'APPROVED' ? 'APROBADA (se puede usar)' : `estado ${info.status}: todavia NO se puede usar`];
            if (info.category && info.category !== 'UTILITY') notes.push(`categoria ${info.category} (un aviso de cobro debe ser UTILITY: cuesta menos y se aprueba mas facil)`);
            if (!same) notes.push('el texto guardado aqui ya NO coincide con el de Meta: vuelva a cargarla');
            console.log(`  ${key} (${tpl.name}): ${notes.join('; ')}.`);
        }
    }
    process.exit(0);
}

// Las 3 plantillas de las alertas de panico, tal como se enviaron a Meta (no pregunta nada: el texto y los datos son fijos)
if (args.panico) {
    const next = { ...current, metaTemplates: { ...(current.metaTemplates || {}) }, updatedAt: new Date().toISOString() };
    for (const key of panicMeta.PANIC_KINDS) {
        const tpl = panicMeta.panicTemplate({ metaTemplates: panicMeta.DEFAULT_TEMPLATES }, key);
        next.metaTemplates[key] = tpl;
        console.log(`  ${panicMeta.KIND_LABEL[key]}: ${tpl.name} (${tpl.language}), huecos: ${tpl.params.join(', ')}.`);
    }
    await ref.set(next);
    console.log(`\nGuardadas en ${target}. Todavia NO cambia nada: cuando Meta las APRUEBE (Administrador de WhatsApp > Plantillas),\n` +
        `active el canal con: node set-whatsapp-plantillas.mjs --target=${target} --canal-panico=meta`);
    process.exit(0);
}

// Por donde salen las alertas de panico (alerta, familiares y prueba). Los recordatorios siguen con --canal
if (args['canal-panico']) {
    const canal = String(args['canal-panico']);
    if (!['meta', 'ultramsg'].includes(canal)) { console.log('Use --canal-panico=meta o --canal-panico=ultramsg'); process.exit(1); }
    if (canal === 'meta') {
        if (!current.metaToken || !current.metaPhoneId) { console.log('No se puede: falta el token o el numero de Meta (use set-whatsapp.mjs).'); process.exit(1); }
        const missing = panicMeta.PANIC_KINDS.filter((key) => !panicMeta.panicTemplate(current, key));
        if (missing.length) { console.log(`No se puede: faltan plantillas de panico (${missing.join(', ')}). Corra antes con --panico.`); process.exit(1); }
    }
    const next = { ...current, updatedAt: new Date().toISOString() };
    if (canal === 'meta') next.panicChannel = 'meta'; else delete next.panicChannel;
    await ref.set(next);
    console.log(canal === 'meta'
        ? `Alertas de panico en ${target}: WhatsApp oficial de Meta con plantilla. Una alerta que Meta no deje salir se intenta por UltraMsg; una prueba no.`
        : `Alertas de panico en ${target}: UltraMsg, como siempre.`);
    process.exit(0);
}

if (args.canal) {
    const canal = String(args.canal);
    if (!['meta', 'ultramsg'].includes(canal)) { console.log('Use --canal=meta o --canal=ultramsg'); process.exit(1); }
    if (canal === 'meta') {
        if (!current.metaToken || !current.metaPhoneId) { console.log('No se puede: falta el token o el numero de Meta (use set-whatsapp.mjs).'); process.exit(1); }
        if (!meta.normalizeTemplate((current.metaTemplates || {}).mora)) { console.log('No se puede: falta la plantilla de mora (corra este script sin opciones).'); process.exit(1); }
    }
    await ref.set({ ...current, channel: canal, updatedAt: new Date().toISOString() });
    console.log(`Canal de los avisos en ${target}: ${canal === 'meta' ? 'WhatsApp oficial de Meta (solo Meta, sin caer a UltraMsg)' : 'UltraMsg'}.`);
    process.exit(0);
}

console.log(`Plantillas de Meta en ${target}. Deje en blanco para conservar lo actual.\n${describe(current)}\n`);
const next = { ...current, metaTemplates: { ...(current.metaTemplates || {}) }, updatedAt: new Date().toISOString() };
const waba = await ask('ID de la cuenta de WhatsApp Business (WABA) (blanco para conservar): ');
if (waba) next.metaWabaId = waba.replace(/\D/g, '');

for (const [key, label] of [['mora', 'Mensaje por morosidad'], ['general', 'Mensajes varios']]) {
    console.log(`\n── ${label} ──`);
    const old = meta.normalizeTemplate(next.metaTemplates[key]);
    const name = (await ask(`Nombre de la plantilla en Meta${old ? ` [${old.name}]` : ''} (blanco para omitir): `)) || (old ? old.name : '');
    if (!name) { console.log('  Se omite.'); continue; }
    const language = (await ask(`Idioma [${old ? old.language : 'es'}]: `)) || (old ? old.language : 'es');
    const paramsText = await ask(`Dato de cada hueco {{1}}, {{2}}... separados por coma (${meta.VARIABLES.join(', ')})${old ? ` [${old.params.join(',')}]` : ''}: `);
    const params = (paramsText ? paramsText.split(',') : old ? old.params : []).map((p) => p.trim().toLowerCase()).filter(Boolean);
    let body = '';
    const info = await fromMeta(next, name, language);
    if (info && info.body) {
        body = info.body;
        console.log(`  Texto tomado de Meta (${info.status}${info.category ? ', ' + info.category : ''}): ${body.slice(0, 120)}${body.length > 120 ? '...' : ''}`);
        if (info.status !== 'APPROVED') console.log('  OJO: todavia no esta APROBADA; el sistema la guarda pero Meta rechazara los envios hasta que lo este.');
    } else {
        if (info && info.error) console.log(`  No se pudo leer de Meta (${info.error}).`);
        if (info && info.missing) console.log('  Meta no tiene una plantilla con ese nombre e idioma.');
        body = await ask(`Pegue el texto aprobado de la plantilla (con {{1}}, {{2}}...)${old && old.body ? ' [conservar el actual]' : ''}: `) || (old ? old.body : '');
    }
    const tpl = meta.normalizeTemplate({ name, language, params, body });
    if (!tpl) { console.log(`  No se guardo: nombre (solo minusculas, numeros y _) o datos invalidos. Datos permitidos: ${meta.VARIABLES.join(', ')}.`); continue; }
    if (meta.bodyParamCount(tpl.body) !== tpl.params.length) {
        console.log(`  No se guardo: el texto tiene ${meta.bodyParamCount(tpl.body)} hueco(s) y usted indico ${tpl.params.length} dato(s).`);
        continue;
    }
    next.metaTemplates[key] = tpl;
    console.log(`  Guardada: ${tpl.name} (${tpl.language}), huecos: ${tpl.params.join(', ') || 'ninguno'}.`);
}

await ref.set(next);
console.log(`\nGuardado en ${target}:\n${describe(next)}\n\nPara que los avisos salgan por Meta: node set-whatsapp-plantillas.mjs --target=${target} --canal=meta`);
process.exit(0);
