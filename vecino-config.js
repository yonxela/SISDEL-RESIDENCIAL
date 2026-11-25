/* ═══════════════════════════════════════════════════════════════
   SISDEL - Panel del vecino: lo que TODOS los vecinos del condominio pueden hacer al entrar con su clave
   ───────────────────────────────────────────────────────────────
   Pedido del usuario el 2026-11-24: "cuando el vecino entra con su clave el puede generar su marbete y gestionar sus visitas,
   eso es lo que necesito que este en configuracion para activar o desactivar".
   Documento condominios/{id}/vecino_config/general = { marbete, visitas, temporal, marbeteNote, visitasNote, updatedAt,
   updatedBy { id, name } }. Sin el documento, o sin el campo, esta ENCENDIDO (como siempre): solo un false lo apaga.
   - marbete: ver y descargar el marbete (codigo QR) de sus vehiculos en "Mi Marbete" (de pantalla: vecino.html).
   - visitas: generar pases de visita con codigo QR (las reglas lo exigen: vecinoOpcion en firestore.rules).
   - temporal: accesos temporales de varios dias (solo con visitas encendido; tambien en las reglas).
   - marbeteNote / visitasNote: lo que se le dice al vecino cuando esta apagado (en blanco, el texto de siempre).
   Lo usan vecino.html (aplicar) y vecino-config-ui.js (Configuracion > Panel del vecino de admin.html). UMD: se prueba en Node.
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SisdelVecinoConfig = api;
})(typeof self !== 'undefined' ? self : this, function () {
    const COLLECTION = 'vecino_config';
    const DOC_ID = 'general';
    const NOTE_MAX = 200;
    const DEFAULT_NOTES = {
        marbete: 'El marbete de su vehículo lo entrega la administración del condominio.',
        visitas: 'Por ahora los pases de visita los gestiona la administración del condominio.'
    };
    const DEFAULTS = { marbete: true, visitas: true, temporal: true, marbeteNote: '', visitasNote: '' };

    const cleanNote = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

    // Lo guardado, limpio y con los valores de siempre donde falte (solo un false apaga)
    function clean(data) {
        const d = data && typeof data === 'object' ? data : {};
        return {
            marbete: d.marbete !== false,
            visitas: d.visitas !== false,
            temporal: d.temporal !== false,
            marbeteNote: cleanNote(d.marbeteNote),
            visitasNote: cleanNote(d.visitasNote)
        };
    }

    // Lo que vale de verdad: los accesos temporales son pases, asi que sin pases no hay temporales
    function effective(config) {
        const c = clean(config);
        return { ...c, temporal: c.visitas && c.temporal };
    }

    // Lo que se le dice al vecino cuando algo esta apagado
    function noteFor(config, option) {
        const c = clean(config);
        const own = option === 'marbete' ? c.marbeteNote : c.visitasNote;
        return own || DEFAULT_NOTES[option === 'marbete' ? 'marbete' : 'visitas'];
    }

    // El documento que se guarda (las reglas exigen exactamente estas claves y updatedBy.id = quien guarda)
    function toDoc(config, who, nowIso) {
        const c = clean(config);
        return {
            marbete: c.marbete, visitas: c.visitas, temporal: c.temporal,
            marbeteNote: c.marbeteNote, visitasNote: c.visitasNote,
            updatedAt: nowIso || new Date().toISOString(),
            updatedBy: { id: String((who && who.id) || ''), name: String((who && who.name) || '').slice(0, 120) }
        };
    }

    // ── Navegador (Firestore compat de window.sisdelFirebase) ──
    function ref(db, condominioId) { return db.collection('condominios').doc(condominioId).collection(COLLECTION).doc(DOC_ID); }

    // Devuelve { config, exists, updatedAt, updatedBy } o lanza el error (quien llama decide que hacer si no se pudo leer)
    async function read(db, condominioId) {
        const snap = await ref(db, condominioId).get();
        const data = snap.exists ? snap.data() : null;
        return { config: clean(data), exists: !!snap.exists, updatedAt: data ? data.updatedAt || null : null, updatedBy: data ? data.updatedBy || null : null };
    }

    async function save(db, condominioId, config, who) {
        const doc = toDoc(config, who);
        await ref(db, condominioId).set(doc);
        return doc;
    }

    return { COLLECTION, DOC_ID, NOTE_MAX, DEFAULTS, DEFAULT_NOTES, clean, effective, noteFor, toDoc, read, save };
});
