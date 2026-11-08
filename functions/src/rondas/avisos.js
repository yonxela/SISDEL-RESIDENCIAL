// Mensajes de WhatsApp de las alertas de panico (logica pura, se prueba sin red).
// Traido de SISDEL RONDIN (lib/whatsapp.js), sin emojis y con los datos de SISDEL.

const GT_PREFIX = '502';

// Telefono solo con digitos; un numero de 8 digitos se toma como de Guatemala
function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 8) return GT_PREFIX + digits;
    return digits.length >= 10 ? digits : '';
}

function mapsLink(alert) {
    return alert.lat != null && alert.lng != null ? `https://maps.google.com/?q=${alert.lat},${alert.lng}` : '';
}

function placeLine(alert) {
    return alert.lat != null ? `GPS: ${Number(alert.lat).toFixed(5)}, ${Number(alert.lng).toFixed(5)}` : 'Ubicacion no disponible';
}

// Mensaje para los familiares del vecino
function familyMessage(alert, condoName) {
    const map = mapsLink(alert);
    return [
        '*ALERTA DE EMERGENCIA - SISDEL*',
        '',
        `${alert.userName} activo el boton de panico.`,
        `${condoName}${alert.casa ? ' - ' + alert.casa : ''}`,
        placeLine(alert),
        map,
        '',
        'La garita y la administracion ya fueron avisadas.',
        'Si usted es familiar, mantengase pendiente.',
        '',
        '_Central de Monitoreo SISDEL_'
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

// Mensaje para la central y el personal del condominio
function staffMessage(alert, condoName, notified) {
    const map = mapsLink(alert);
    const who = alert.source === 'guardia' ? 'GUARDIA' : 'VECINO';
    return [
        `*ALERTA DE PANICO (${who}) - SISDEL*`,
        '',
        `Nombre: *${alert.userName}*`,
        `Condominio: ${condoName}`,
        alert.casa ? `Lugar: ${alert.casa}` : '',
        alert.phone ? `Tel: ${alert.phone}` : '',
        placeLine(alert),
        map,
        '',
        alert.source === 'vecino'
            ? (notified.length ? `Familiares avisados: ${notified.join(', ')}` : 'Sin familiares registrados')
            : '',
        '',
        '_Central SISDEL_'
    ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n').replace(/\n+$/, '');
}

// A quien avisar: familiares (solo si es un vecino), la central y el personal del condominio.
// Sin repetidos. Devuelve [{ nombre, telefono, mensaje }]
function recipientsFor({ alert, condoName, contacts = [], staff = [], central = '' }) {
    const out = [];
    const seen = new Set();
    const add = (nombre, phone, mensaje) => {
        const telefono = normalizePhone(phone);
        if (!telefono || seen.has(telefono)) return;
        seen.add(telefono);
        out.push({ nombre, telefono, mensaje });
    };
    const family = alert.source === 'vecino' ? contacts.filter((c) => normalizePhone(c.phone)) : [];
    const notified = family.map((c) => c.name || c.phone);
    const forStaff = staffMessage(alert, condoName, notified);
    add('Central SISDEL', central, forStaff);
    staff.forEach((s) => add(s.name, s.phone, forStaff));
    const forFamily = familyMessage(alert, condoName);
    family.forEach((c) => add(c.name || 'Familiar', c.phone, forFamily));
    return out;
}

module.exports = { normalizePhone, familyMessage, staffMessage, recipientsFor };
