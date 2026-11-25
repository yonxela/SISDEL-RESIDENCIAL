/* ═══════════════════════════════════════════════════════════════
   SISDEL - Avisos de las alertas de panico por WhatsApp (logica pura, se prueba sin red)
   ───────────────────────────────────────────────────────────────
   Traido de SISDEL RONDIN (lib/whatsapp.js), sin emojis y con los datos de SISDEL. Se carga en el navegador
   (<script src="panico-avisos.js">: la vista previa de Configuracion > Boton de panico de admin.html) y en Node
   (functions/src/rondas/avisos.js es una COPIA IDENTICA: la prueba scripts/test-rondas-servidor.mjs falla si difieren).

   Cada condominio configura (condominios/{id}/panico_config/general, pedido del usuario el 2026-11-20):
     phones        hasta 10 telefonos que reciben cada alerta: { kind: garita | pnc | otro, name, phone }
     notifyStaff   avisar tambien al personal que atiende alertas (administradores y supervisores con telefono); si no se dice, si
     staffTitle    titulo del aviso a la garita, la PNC y el personal (ALERTA DE PANICO)
     staffNote     indicaciones para quien recibe el aviso (por ejemplo: "Diríjase de inmediato al lote y llame a la PNC al 110")
     familyNote    lo que se les dice a los familiares
     signature     la firma de los dos mensajes
   Lo esencial del aviso (quien, el condominio, el lote, su telefono, el GPS y el mapa) va SIEMPRE: la configuracion solo cambia
   el titulo, las indicaciones, la nota y la firma, para que ningun texto personalizado deje a la garita sin saber donde ir.
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelPanicoAvisos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const GT_PREFIX = '502';
    const MAX_PHONES = 10;
    const KINDS = ['garita', 'pnc', 'otro'];
    const KIND_LABEL = { garita: 'Garita', pnc: 'PNC', otro: 'Otro' };
    const LIMITS = { name: 60, phone: 20, staffTitle: 60, staffNote: 600, familyNote: 600, signature: 60 };
    const DEFAULT_FAMILY_NOTE = 'La garita y la administracion ya fueron avisadas.\nSi usted es familiar, mantengase pendiente.';

    // Telefono solo con digitos; un numero de 8 digitos se toma como de Guatemala
    function normalizePhone(phone) {
        const digits = String(phone || '').replace(/\D/g, '');
        if (digits.length === 8) return GT_PREFIX + digits;
        return digits.length >= 10 ? digits : '';
    }

    const text = (value, max) => String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
    const oneLine = (value, max) => text(value, max).replace(/\s+/g, ' ');

    // La configuracion limpia (lo que guarde el navegador no se cree: largos, telefonos y tipos se revisan aqui)
    function cleanConfig(raw) {
        const r = raw && typeof raw === 'object' ? raw : {};
        const seen = new Set();
        const phones = (Array.isArray(r.phones) ? r.phones : []).map((p) => {
            const phone = normalizePhone(p && p.phone);
            const kind = KINDS.includes(p && p.kind) ? p.kind : 'otro';
            return { kind, name: oneLine(p && p.name, LIMITS.name) || KIND_LABEL[kind], phone };
        }).filter((p) => p.phone && !seen.has(p.phone) && seen.add(p.phone)).slice(0, MAX_PHONES);
        return {
            phones,
            notifyStaff: r.notifyStaff !== false,
            staffTitle: oneLine(r.staffTitle, LIMITS.staffTitle),
            staffNote: text(r.staffNote, LIMITS.staffNote),
            familyNote: text(r.familyNote, LIMITS.familyNote),
            signature: oneLine(r.signature, LIMITS.signature)
        };
    }

    function mapsLink(alert) {
        return alert.lat != null && alert.lng != null ? `https://maps.google.com/?q=${alert.lat},${alert.lng}` : '';
    }

    function placeLine(alert) {
        return alert.lat != null ? `GPS: ${Number(alert.lat).toFixed(5)}, ${Number(alert.lng).toFixed(5)}` : 'Ubicacion no disponible';
    }

    // Sin dos lineas en blanco seguidas, ni en blanco al principio o al final
    const tidy = (lines) => lines.join('\n').split('\n')
        .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
        .join('\n').replace(/\n+$/, '');

    // Mensaje para los familiares del vecino
    function familyMessage(alert, condoName, cfg) {
        const c = cleanConfig(cfg);
        return tidy([
            '*ALERTA DE EMERGENCIA - SISDEL*',
            '',
            `${alert.userName} activo el boton de panico.`,
            `${condoName}${alert.casa ? ' - ' + alert.casa : ''}`,
            placeLine(alert),
            mapsLink(alert),
            '',
            c.familyNote || DEFAULT_FAMILY_NOTE,
            '',
            `_${c.signature || 'Central de Monitoreo SISDEL'}_`
        ]);
    }

    // Mensaje para la central, la garita, la PNC y el personal del condominio
    function staffMessage(alert, condoName, notified, cfg) {
        const c = cleanConfig(cfg);
        const who = alert.source === 'guardia' ? 'GUARDIA' : 'VECINO';
        return tidy([
            `*${c.staffTitle || 'ALERTA DE PANICO'} (${who}) - SISDEL*`,
            '',
            `Nombre: *${alert.userName}*`,
            `Condominio: ${condoName}`,
            alert.casa ? `Lugar: ${alert.casa}` : '',
            alert.phone ? `Tel: ${alert.phone}` : '',
            placeLine(alert),
            mapsLink(alert),
            '',
            c.staffNote,
            '',
            alert.source === 'vecino'
                ? ((notified || []).length ? `Familiares avisados: ${notified.join(', ')}` : 'Sin familiares registrados')
                : '',
            '',
            `_${c.signature || 'Central SISDEL'}_`
        ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)));
    }

    // ── Simulacro (pedido del usuario el 2026-11-23: los vecinos van a probar el boton y cada prueba escribia, desde el numero del
    // condominio, a sus 5 familiares: contactos nuevos que WhatsApp castiga). La alerta trae simulacro: true y el aviso dice en la
    // primera linea que NO es una emergencia. Al vecino le llega una copia para que vea que su boton funciona y a quien avisaria.
    // Desde el 2026-11-25 es la "Prueba: todo sin novedad" (pedido del usuario): manda la ubicacion y los datos, sin sirena, y la
    // pantalla de la garita la recibe sola (panico-alertas.js, panico-prueba.js)
    const DRILL_TITLE = 'PRUEBA - TODO SIN NOVEDAD (no es una emergencia)';
    // Tope de simulacros CON WhatsApp por dia de Guatemala: por condominio y por vecino (los demas quedan en la pantalla de la garita,
    // sin WhatsApp): asi las pruebas se reparten en varios dias y el numero no manda rafagas
    const DRILL_LIMITS = { perDay: 20, perUser: 2 };
    function isDrill(alert) { return !!alert && alert.simulacro === true; }
    // A quienes se avisaria en una emergencia real (sin nombres): "3 contactos de emergencia, la PNC y la administracion"
    function drillWould(familyCount, cfg, staffCount) {
        const c = cleanConfig(cfg);
        const parts = [];
        if (familyCount > 0) parts.push(`${familyCount} ${familyCount === 1 ? 'contacto' : 'contactos'} de emergencia`);
        if (c.phones.some((p) => p.kind === 'pnc')) parts.push('la PNC');
        if (c.phones.some((p) => p.kind === 'otro')) parts.push('los demas telefonos del condominio');
        if (c.notifyStaff && staffCount > 0) parts.push('la administracion');
        return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : (parts[0] || '');
    }
    // A la central y la garita: los mismos datos de una alerta (para comprobar el GPS y el mapa), marcado como simulacro
    function drillStaffMessage(alert, condoName, would, cfg) {
        const c = cleanConfig(cfg);
        const who = alert.source === 'guardia' ? 'GUARDIA' : 'VECINO';
        return tidy([
            `*${DRILL_TITLE}*`,
            `_Prueba del boton de panico (${who}): todo sin novedad - SISDEL_`,
            '',
            `Nombre: *${alert.userName}*`,
            `Condominio: ${condoName}`,
            alert.casa ? `Lugar: ${alert.casa}` : '',
            alert.phone ? `Tel: ${alert.phone}` : '',
            placeLine(alert),
            mapsLink(alert),
            '',
            'No hay que ir al lugar: el vecino esta comprobando que su boton funciona. La pantalla de la garita la recibe sola.',
            would ? `En una emergencia real tambien se avisaria a: ${would}.` : '',
            '',
            `_${c.signature || 'Central SISDEL'}_`
        ]);
    }
    // Al propio vecino: su boton funciona, si llevo el GPS y a quien avisaria de verdad
    function drillOwnMessage(alert, condoName, would, cfg) {
        const c = cleanConfig(cfg);
        return tidy([
            `*${DRILL_TITLE}*`,
            '',
            `${alert.userName ? alert.userName + ', su' : 'Su'} boton de panico funciona: esta prueba (todo sin novedad) le llego a la garita de ${condoName}.`,
            alert.lat != null ? 'Llevo su ubicacion GPS:' : 'No llevo su ubicacion: active la ubicacion del telefono para que una alerta real diga donde esta.',
            mapsLink(alert),
            '',
            would ? `En una emergencia real tambien se avisaria a: ${would}.` : 'Registre sus contactos de emergencia para que tambien los avisen en una emergencia real.',
            '',
            `_${c.signature || 'Central de Monitoreo SISDEL'}_`
        ]);
    }

    // A quien avisar: la central de SISDEL, los telefonos configurados del condominio (garita, PNC...), el personal que atiende
    // alertas (si el condominio no lo quito) y los familiares (solo si es un vecino). Sin repetidos. [{ nombre, telefono, mensaje, tipo }]
    // Un simulacro (alert.simulacro), solo la central, las garitas y el propio vecino.
    // `tipo` dice que plantilla del WhatsApp oficial de Meta le toca (functions/src/rondas/panico-meta.js): 'panico' (central, garita,
    // PNC y personal), 'panicoFamilia' (familiares) o 'prueba' (simulacro: central, garitas y el propio vecino)
    function recipientsFor({ alert, condoName, contacts = [], staff = [], central = '', config }) {
        const c = cleanConfig(config);
        const out = [];
        const seen = new Set();
        const add = (nombre, phone, mensaje, tipo) => {
            const telefono = normalizePhone(phone);
            if (!telefono || seen.has(telefono)) return;
            seen.add(telefono);
            out.push({ nombre, telefono, mensaje, tipo });
        };
        const family = alert.source === 'vecino' ? contacts.filter((x) => normalizePhone(x.phone)) : [];
        // SIMULACRO: solo la central, las garitas del condominio y el propio vecino; nunca la PNC, otros telefonos, el personal ni
        // los familiares (cada familiar es un contacto nuevo para el numero del condominio: es lo que hace que WhatsApp lo restrinja)
        if (isDrill(alert)) {
            const would = drillWould(family.length, c, staff.length);
            const forStaff = drillStaffMessage(alert, condoName, would, c);
            add('Central SISDEL', central, forStaff, 'prueba');
            c.phones.filter((p) => p.kind === 'garita').forEach((p) => add(p.name, p.phone, forStaff, 'prueba'));
            if (alert.phone) add(alert.userName || 'Vecino', alert.phone, drillOwnMessage(alert, condoName, would, c), 'prueba');
            return out;
        }
        const notified = family.map((x) => x.name || x.phone);
        const forStaff = staffMessage(alert, condoName, notified, c);
        add('Central SISDEL', central, forStaff, 'panico');
        c.phones.forEach((p) => add(p.name, p.phone, forStaff, 'panico'));
        if (c.notifyStaff) staff.forEach((s) => add(s.name, s.phone, forStaff, 'panico'));
        const forFamily = familyMessage(alert, condoName, c);
        family.forEach((x) => add(x.name || 'Familiar', x.phone, forFamily, 'panicoFamilia'));
        return out;
    }

    // Una alerta de ejemplo para la vista previa y el mensaje de prueba
    function sampleAlert(source) {
        return { source: source || 'vecino', userName: 'Nombre del vecino', casa: 'Lote A001', phone: '5555-1234', lat: 14.63491, lng: -90.50693 };
    }
    // El mensaje de prueba de Configuracion > Boton de panico: dice claramente que NO es una emergencia
    function testMessage(condoName, cfg) {
        return ['*PRUEBA - NO ES UNA EMERGENCIA*', '', `Asi le llegaran las alertas de panico de ${condoName}:`, '', staffMessage(sampleAlert('vecino'), condoName, ['Familiar de ejemplo'], cfg)].join('\n');
    }

    return { normalizePhone, cleanConfig, familyMessage, staffMessage, recipientsFor, sampleAlert, testMessage, isDrill, drillWould, drillStaffMessage, drillOwnMessage, MAX_PHONES, KINDS, KIND_LABEL, LIMITS, DEFAULT_FAMILY_NOTE, DRILL_TITLE, DRILL_LIMITS };
});
