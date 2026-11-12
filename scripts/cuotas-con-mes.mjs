// Agrega el mes a la descripcion de las cuotas con desglose que se cobraron antes de que la descripcion lo dijera.
//
// Desde 2026-11-12 la cuota con desglose dice a que mes corresponde ("Por aporte para mantenimiento y servicio de agua
// correspondiente a octubre de 2026 Q 500.00"). Las cobradas entre el 2026-11-09 y esa fecha dicen solo
// "Por aporte para mantenimiento y servicio de agua Q 500.00". Las reglas no dejan cambiar el concepto de un movimiento
// desde OIKOS (los movimientos no se editan), por eso este arreglo se hace con el SDK de administrador.
//
// Solo cambia el CONCEPTO (y updated_at, para que cada equipo con OIKOS abierto tome el texto nuevo). Nunca toca montos,
// fechas, periodos, desglose ni anulaciones. Solo toca una cuota cuyo concepto es EXACTAMENTE el que genero el sistema
// sin mes (si alguien lo cambio, o si la moneda ya no es la misma, se deja como esta).
//
// Uso (desde scripts/):
//   node cuotas-con-mes.mjs                         simulacro en el emulador: lista lo que cambiaria
//   node cuotas-con-mes.mjs --target=prod           simulacro en produccion (con GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter)
//   node cuotas-con-mes.mjs --target=prod --aplicar aplica el cambio
//   --condo=<id>                                    solo ese condominio
import { createRequire } from 'node:module';
import { connect, parseArgs } from './admin.mjs';

const require = createRequire(import.meta.url);
const C = require('../finanzas/sisdel-cuotas.js');

const args = parseArgs();
const target = args.target === 'prod' ? 'prod' : 'emulator';
const apply = args.aplicar === true;
const db = connect(target);

// Concepto nuevo de una cuota que necesita el mes; null si no hay que tocarla
function fixedConcept(tx, currency) {
    if (!tx || tx.type !== 'charge' || tx.kind !== 'fee') return null;
    if (!tx.breakdown || typeof tx.breakdown !== 'object' || !C.monthLabel(tx.period)) return null;
    const old = C.describe(tx.breakdown, currency);
    if (!old || tx.concept !== old) return null;
    // El desglose debe sumar el monto cobrado (asi lo genero el sistema)
    if (Math.abs(C.total(tx.breakdown) - (parseFloat(tx.amount) || 0)) >= 0.005) return null;
    const next = C.describe(tx.breakdown, currency, tx.period);
    return next && next !== tx.concept ? next : null;
}

const condoDocs = args.condo
    ? [await db.doc(`condominios/${String(args.condo)}`).get()].filter((d) => d.exists)
    : (await db.collection('condominios').get()).docs;

console.log(`${target === 'prod' ? 'PRODUCCION' : 'EMULADOR'}: ${apply ? 'APLICANDO' : 'simulacro (no cambia nada)'}`);
let total = 0;
const nowIso = new Date().toISOString();
for (const condo of condoDocs) {
    const settingsSnap = await condo.ref.collection('finanzas_config').doc('oikos_settings').get();
    const currency = (settingsSnap.exists && settingsSnap.data().currency) || 'GTQ';
    const charges = await condo.ref.collection('finanzas_movimientos').where('kind', '==', 'fee').get();
    const changes = [];
    charges.docs.forEach((doc) => {
        const next = fixedConcept(doc.data(), currency);
        if (next) changes.push({ ref: doc.ref, tx: doc.data(), next });
    });
    if (!changes.length) continue;
    console.log(`\n${condo.data().name} (${condo.id}): ${changes.length} cuota(s)`);
    changes.sort((a, b) => String(a.tx.period).localeCompare(String(b.tx.period)));
    changes.forEach(({ tx, next }) => console.log(`  - ${tx.period} ${tx.deleted ? '(anulada) ' : ''}vecino ${tx.resiId}: "${tx.concept}" -> "${next}"`));
    total += changes.length;
    if (apply) {
        for (let i = 0; i < changes.length; i += 400) {
            const batch = db.batch();
            changes.slice(i, i + 400).forEach(({ ref, next }) => batch.update(ref, { concept: next, updated_at: nowIso }));
            await batch.commit();
        }
    }
}
console.log(total
    ? `\n${apply ? 'Actualizadas' : 'Se actualizarian'}: ${total} cuota(s).${apply ? '' : ' Para aplicar: --aplicar'}`
    : '\nNo hay cuotas que necesiten el mes.');
process.exit(0);
