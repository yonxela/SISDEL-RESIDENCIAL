// Tope PROPIO de pruebas "todo sin novedad" (simulacros con WhatsApp) de un vecino (pedido del usuario el 2026-11-27: UNION
// EMPRESARIAL, A006 de La Perla, apoya las pruebas y necesita 20 al dia). Lo de siempre es 2 por vecino y 20 por condominio al dia
// (functions/src/rondas/avisos.js DRILL_LIMITS); las pruebas de un vecino con tope propio NO gastan las 20 del condominio
// (functions/src/rondas/pruebas-tope.js). Se guarda en condominios/{c}/panico_config/pruebas = { vecinos: { <userId>: N } }, que solo
// escribe el servidor (las reglas solo dejan 'general') y que la bitacora anota (auditPanicConfig).
//
// Uso (desde scripts/):
//   node set-pruebas-panico.mjs --condo=<id> --casa=A006 --pruebas=20 [--target=prod]    (o --vecino=<id> en vez de --casa)
//   node set-pruebas-panico.mjs --condo=<id> --casa=A006 --quitar [--target=prod]        vuelve al tope de siempre (queda en 0)
//   node set-pruebas-panico.mjs --condo=<id> --ver [--target=prod]                       los vecinos con tope propio
// En la nube: GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter. No toca nada mas.
import { connect, parseArgs } from './admin.mjs';

const MAX = 50;
const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const condoId = String(args.condo || '').trim();
if (!condoId || condoId.includes('/')) {
    console.error('Falta --condo=<id del condominio>.');
    process.exit(1);
}
const db = connect(target);
const condoRef = db.collection('condominios').doc(condoId);
const condo = await condoRef.get();
if (!condo.exists) { console.error(`No existe el condominio ${condoId} (${target}).`); process.exit(1); }
const cfgRef = condoRef.collection('panico_config').doc('pruebas');
const label = (u) => `${u.casa || 'sin lote'} · ${u.name || u.id}`;

async function show() {
    const snap = await cfgRef.get();
    const vecinos = (snap.exists && snap.data().vecinos) || {};
    const ids = Object.keys(vecinos).filter((id) => Number(vecinos[id]) > 0);
    console.log(`\n${condo.data().name} (${target}): pruebas con WhatsApp al dia`);
    console.log('  Lo de siempre: 2 por vecino y 20 en todo el condominio.');
    if (!ids.length) { console.log('  Ningun vecino tiene tope propio.'); return; }
    for (const id of ids) {
        const u = await condoRef.collection('usuarios').doc(id).get();
        console.log(`  ${u.exists ? label({ id, ...u.data() }) : id}: ${Math.min(Number(vecinos[id]), MAX)} al dia (no gastan las 20 del condominio)`);
    }
}

if (args.ver) { await show(); process.exit(0); }

// El vecino: por su id o por su lote/casa (exacto, sin importar mayusculas, espacios ni "Lote"/"Casa" delante)
const norm = (v) => String(v || '').toUpperCase().replace(/^\s*(LOTE|CASA)\s+/, '').replace(/\s+/g, '');
let vecino = null;
if (args.vecino) {
    const u = await condoRef.collection('usuarios').doc(String(args.vecino)).get();
    if (u.exists) vecino = { id: u.id, ...u.data() };
} else if (args.casa) {
    const all = await condoRef.collection('usuarios').where('role', '==', 'vecino').get();
    const found = all.docs.map((d) => ({ id: d.id, ...d.data() })).filter((u) => norm(u.casa) === norm(args.casa));
    if (found.length > 1) {
        console.error(`Hay ${found.length} vecinos con el lote ${args.casa}: use --vecino=<id>.`);
        found.forEach((u) => console.error(`  ${u.id}: ${label(u)}`));
        process.exit(1);
    }
    vecino = found[0] || null;
}
if (!vecino) { console.error('No se encontro al vecino: use --casa=<lote> o --vecino=<id>.'); process.exit(1); }
if (vecino.role !== 'vecino') { console.error(`${label(vecino)} no es un vecino (rol ${vecino.role}).`); process.exit(1); }

let n;
if (args.quitar) n = 0;
else {
    n = Number(args.pruebas);
    if (!Number.isInteger(n) || n < 1 || n > MAX) { console.error(`--pruebas debe ser un numero entero de 1 a ${MAX}.`); process.exit(1); }
}
await cfgRef.set({
    vecinos: { [vecino.id]: n },
    updatedAt: new Date().toISOString(),
    updatedBy: { id: 'script', name: 'scripts/set-pruebas-panico.mjs' }
}, { merge: true });
console.log(n ? `Listo: ${label(vecino)} puede hacer ${n} pruebas con WhatsApp al dia (no gastan las 20 del condominio).`
    : `Listo: ${label(vecino)} vuelve al tope de siempre (2 al dia).`);
await show();
process.exit(0);
