// Muestra la bitacora de un condominio: quien cambio que y cuando (functions/src/bitacora). Solo lee.
//
// Uso:
//   cd scripts && node ver-bitacora.mjs --condo=<id>                           emulador, ultimas 30 anotaciones
//   node ver-bitacora.mjs --condo=<id> --target=prod                           la nube (con GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter)
//   node ver-bitacora.mjs --condo=<id> --doc=<id del documento>                todo lo que le paso a un documento
//   node ver-bitacora.mjs --condo=<id> --coleccion=finanzas_movimientos --ultimos=100
//   node ver-bitacora.mjs --condo=<id> --json                                  salida completa, sin resumir
import { connect, parseArgs } from './admin.mjs';

const args = parseArgs();
if (!args.condo) { console.error('Falta --condo=<id del condominio>'); process.exit(1); }
const db = connect(args.target === 'prod' ? 'prod' : 'emulator');
const limit = Math.min(1000, Math.max(1, parseInt(args.ultimos, 10) || 30));

let query = db.collection(`condominios/${args.condo}/bitacora`);
// Un solo filtro por consulta (no hace falta ningun indice compuesto); lo demas se filtra aqui
if (args.doc) query = query.where('docId', '==', String(args.doc));
else query = query.orderBy('at', 'desc').limit(args.coleccion ? 1000 : limit);
const snap = await query.get();
let entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
entries.sort((a, b) => (a.at && b.at ? a.at.toMillis() - b.at.toMillis() : 0));
if (args.coleccion) entries = entries.filter((e) => e.collection === String(args.coleccion));
if (!args.doc) entries = entries.slice(-limit);

const short = (v) => { const text = typeof v === 'string' ? v : JSON.stringify(v); return text.length > 60 ? text.slice(0, 57) + '...' : text; };
const when = (e) => (e.at ? e.at.toDate().toLocaleString('es-GT', { timeZone: 'America/Guatemala' }) : '');
if (args.json) {
    console.log(JSON.stringify(entries.map((e) => ({ ...e, at: e.at ? e.at.toDate().toISOString() : null })), null, 2));
} else {
    for (const e of entries) {
        const who = e.actorName ? `${e.actorName} (${e.actorRole})` : (e.actorId || e.actorType);
        const subject = Object.values(e.subject || {}).map(short).join(' · ');
        console.log(`${when(e)}  ${String(e.action).padEnd(9)} ${e.collection}/${e.docId}  por ${who}${subject ? '  [' + subject + ']' : ''}`);
        if (e.action === 'cambiar' || e.action === 'anular' || e.action === 'restaurar') {
            for (const [field, change] of Object.entries(e.changes || {})) console.log(`      ${field}: ${short(change.from)} -> ${short(change.to)}`);
        }
    }
    console.log(`\n${entries.length} anotaciones`);
}
process.exit(0);
