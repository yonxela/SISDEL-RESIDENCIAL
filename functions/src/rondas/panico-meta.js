// Alertas de panico por el WhatsApp OFICIAL de Meta, con plantillas aprobadas. No importa firebase: se prueba con
// scripts/test-panico-meta.mjs.
//
// Por que (pedido del usuario el 2026-11-25): en la semana de pruebas muchos vecinos van a mandar alertas y pruebas, y cada aviso a
// un familiar, a la PNC o al propio vecino es un contacto nuevo para el numero de UltraMsg, que WhatsApp restringe (2026-11-17). Con
// la API oficial el numero es de una cuenta de empresa y un aviso con PLANTILLA aprobada llega aunque esa persona nunca le haya
// escrito. El texto de la plantilla es fijo (lo aprueba Meta): las indicaciones, la nota a los familiares y la firma que el
// condominio escribe en Configuracion > Boton de panico NO van por este camino (si van por UltraMsg).
//
// Configuracion en _privado/whatsapp (no secreta; se carga con scripts/set-whatsapp-plantillas.mjs --panico):
//   panicChannel: 'meta'      la alerta, el aviso a los familiares y la prueba salen por Meta con plantilla; sin esto, como siempre
//   metaTemplates.panico | panicoFamilia | prueba = { name, language, params: [datos de PANIC_VARIABLES en el orden de {{1}}...] }
// Una alerta DE VERDAD que Meta no deja salir (plantilla sin aprobar, numero con problemas) se intenta por el camino de siempre
// (UltraMsg y de respaldo Meta en texto libre): en una emergencia importa que el aviso llegue. Una PRUEBA no: no cae a UltraMsg,
// porque escribirle desde ahi al vecino y a la garita es justo lo que hace que WhatsApp restrinja el numero.
const meta = require('./meta-estado');

// Datos de una alerta que una plantilla puede usar
const PANIC_VARIABLES = ['condominio', 'nombre', 'lote', 'hora', 'ubicacion', 'telefono', 'contacto'];
// Las plantillas que se enviaron a Meta el 2026-11-25 (Utilidad, espanol), con el dato de cada hueco
const DEFAULT_TEMPLATES = {
    panico: {
        name: 'alerta_panico', language: 'es', params: ['condominio', 'nombre', 'lote', 'hora', 'ubicacion', 'telefono'],
        body: 'ALERTA DE PÁNICO en {{1}}. {{2}}, del lote {{3}}, presionó el botón de pánico a las {{4}}. Ubicación: {{5}}. Teléfono del vecino: {{6}}. Por favor atienda la emergencia de inmediato.'
    },
    panicoFamilia: {
        name: 'alerta_panico_familia', language: 'es', params: ['condominio', 'nombre', 'hora', 'ubicacion', 'contacto'],
        body: 'Aviso de {{1}}: {{2}} presionó su botón de pánico a las {{3}}. Ubicación: {{4}}. La garita ya recibió la alerta. Si puede, comuníquese al {{5}} para saber cómo está.'
    },
    prueba: {
        name: 'prueba_sin_novedad', language: 'es', params: ['nombre', 'lote', 'condominio', 'hora'],
        body: 'PRUEBA - NO ES UNA EMERGENCIA. {{1}}, del lote {{2}} en {{3}}, probó su botón de pánico a las {{4}}: todo sin novedad.'
    }
};
const PANIC_KINDS = Object.keys(DEFAULT_TEMPLATES);
const KIND_LABEL = { panico: 'Alerta de panico (garita, PNC, central y personal)', panicoFamilia: 'Aviso a los familiares', prueba: 'Prueba "todo sin novedad"' };

const usesPanicMeta = (config) => !!(config && config.panicChannel === 'meta' && config.metaToken && config.metaPhoneId);
const panicTemplate = (config, kind) => meta.normalizeTemplate(config && config.metaTemplates && config.metaTemplates[kind], PANIC_VARIABLES);

// Hora de Guatemala (UTC-6, sin horario de verano) en 12 horas: "10:35 PM" (con "p. m." la plantilla quedaria "p. m.. Ubicacion")
function gtTime(iso) {
    const t = Date.parse(iso || '');
    const d = new Date((Number.isFinite(t) ? t : Date.now()) - 6 * 3600000);
    const h = d.getUTCHours();
    return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// "Lote A001" -> "A001" (la plantilla ya dice "del lote")
const loteOf = (casa) => String(casa || '').trim().replace(/^lote\s+/i, '').trim();
// 50244440001 -> 4444-0001 (Guatemala); otro pais con +
function displayPhone(digits) {
    const d = String(digits || '').replace(/\D/g, '');
    if (!d) return '';
    return d.length === 11 && d.startsWith('502') ? `${d.slice(3, 7)}-${d.slice(7)}` : `+${d}`;
}

// Los datos de la alerta para los huecos de las plantillas. `garitaPhone`: el primer telefono de garita configurado (para que un
// familiar sepa a donde llamar si el vecino no tiene telefono en su ficha)
function panicVars({ alert, condoName, garitaPhone }) {
    const a = alert || {};
    const guard = a.source === 'guardia';
    const name = String(a.userName || '').trim();
    const hasGps = a.lat != null && a.lng != null;
    return {
        condominio: String(condoName || '').trim() || 'su condominio',
        nombre: guard ? `Guardia ${name || 'de turno'}` : (name || 'Un vecino'),
        lote: loteOf(a.casa) || (guard ? 'sin lote (alerta de un guardia)' : 'sin lote registrado'),
        hora: gtTime(a.createdAt),
        ubicacion: hasGps ? `https://maps.google.com/?q=${a.lat},${a.lng}` : 'no disponible (el teléfono no envió su GPS)',
        telefono: String(a.phone || '').trim() || 'no registrado',
        contacto: String(a.phone || '').trim() || displayPhone(garitaPhone) || 'número de la garita'
    };
}
// Para el mensaje de prueba de Configuracion > Boton de panico (plantilla de prueba, sin datos de un vecino)
function testVars(condoName) {
    return { ...panicVars({ alert: { source: 'vecino', userName: 'La administración', casa: 'de prueba' }, condoName }), hora: gtTime() };
}

// Manda UN aviso de panico. opts: { tipo: 'panico' | 'panicoFamilia' | 'prueba', vars, errors, drill }.
// deps: { sendTemplate(config, to, tpl, params) -> { ok, code, error }, legacy(config, to, message) -> canal | null }.
// Devuelve el canal usado ('META', 'ULTRAMSG'...) o null; los motivos de lo que fallo quedan en opts.errors (nunca el token).
async function sendPanicMessage(config, to, message, opts, deps) {
    const { tipo, vars, errors, drill } = opts || {};
    const note = (text) => { if (Array.isArray(errors)) errors.push(text); };
    if (!usesPanicMeta(config)) return deps.legacy(config, to, message);
    const tpl = PANIC_KINDS.includes(tipo) ? panicTemplate(config, tipo) : null;
    if (tpl) {
        let r;
        try { r = await deps.sendTemplate(config, to, tpl, meta.templateParams(tpl, vars)); } catch (e) { r = { ok: false, code: 0, error: 'Meta no respondió' }; }
        if (r && r.ok) return 'META';
        note(`Meta (${(r && r.code) || 0}): ${(r && r.error) || 'rechazado'}`);
    } else {
        note(`Falta la plantilla de Meta para "${tipo || 'sin tipo'}"`);
    }
    if (drill) return null;
    return deps.legacy(config, to, message);
}

module.exports = {
    PANIC_VARIABLES, DEFAULT_TEMPLATES, PANIC_KINDS, KIND_LABEL, usesPanicMeta, panicTemplate, gtTime, loteOf, displayPhone,
    panicVars, testVars, sendPanicMessage
};
