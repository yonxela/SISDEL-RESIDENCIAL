/* Actualizacion de datos de los vecinos (pedido del usuario el 2026-11-23): el vecino confirma o corrige su lote, telefono,
 * correo, NIT y DPI (y el propietario y la direccion) en su portal; lo que escribe NO cambia la base: queda como una solicitud en
 * condominios/{c}/actualizaciones_datos y la administracion la revisa y la aplica con su propia clave.
 * UMD, logica pura (sin pantalla ni base): la usan vecino.html, actualizaciones-ui.js (admin.html) y scripts/test-actualizaciones.mjs.
 *
 *  - FIELDS: los campos, con el nombre que ve la gente y a donde van al aplicarse (usuarios o la ficha de Finanzas).
 *  - clean / same / validate: limpieza, comparacion y revision de cada dato (el NIT admite C/F; el DPI son 13 digitos).
 *  - buildRequest: el documento de la solicitud (lo actual, lo propuesto y que cambia).
 *  - changedRows / applyPlan / warnings: lo que ve y hace quien revisa.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelActualizaciones = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var FIELDS = [
        { key: 'casa', label: 'Lote o casa', target: 'usuarios', required: true, max: 40 },
        { key: 'phone', label: 'Teléfono', target: 'usuarios', required: true, max: 40 },
        { key: 'email', label: 'Correo electrónico', target: 'usuarios', max: 120 },
        { key: 'nit', label: 'NIT', target: 'finanzas', required: true, max: 20 },
        { key: 'dpi', label: 'DPI', target: 'finanzas', required: true, max: 20 },
        { key: 'propietario', label: 'Nombre del propietario', target: 'finanzas', max: 160 },
        { key: 'direccion', label: 'Dirección', target: 'finanzas', max: 160 }
    ];
    var KEYS = FIELDS.map(function (f) { return f.key; });
    var STATUS = { PENDING: 'pendiente', APPLIED: 'aplicada', REJECTED: 'rechazada', CANCELED: 'cancelada' };
    var STATUS_LABEL = { pendiente: 'Pendiente', aplicada: 'Aplicada', rechazada: 'Rechazada', cancelada: 'Cancelada' };
    var ORIGIN_LABEL = { 'primer-ingreso': 'Primer ingreso', 'mis-datos': 'Cambio de datos' };

    function fieldOf(key) { return FIELDS.filter(function (f) { return f.key === key; })[0] || null; }
    function labelOf(key) { var f = fieldOf(key); return f ? f.label : key; }
    var squash = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); };
    var digits = function (v) { return String(v == null ? '' : v).replace(/\D+/g, ''); };

    // ── NIT: "C/F" (consumidor final) o digitos con verificador (puede ser K) ──
    function nitCore(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-Z]/g, ''); }
    function isCF(v) { return /^C\.?\s*\/?\s*F\.?$/i.test(squash(v)) || nitCore(v) === 'CF'; }

    // El dato como se guarda: sin espacios de mas; el NIT en mayusculas (o C/F); el DPI solo con digitos; el correo en minusculas
    function clean(key, value) {
        var f = fieldOf(key);
        var max = f ? f.max : 160;
        var s = squash(value);
        if (key === 'nit') s = isCF(s) ? 'C/F' : s.toUpperCase().replace(/\s+/g, '');
        else if (key === 'dpi') s = digits(s);
        else if (key === 'email') s = s.toLowerCase();
        else if (key === 'phone') s = s.replace(/[^\d+()\-.\s]/g, '').replace(/\s+/g, ' ').trim();
        return s.slice(0, max);
    }
    // ¿Es el mismo dato aunque este escrito distinto? ("1234 56789 0101" y "1234567890101"; "c/f" y "C/F"; "A 012" y "a 012")
    function same(key, a, b) {
        if (key === 'phone') {
            var da = digits(a), db = digits(b);
            // 5555-1234 y +502 5555-1234 son el mismo numero
            if (da.length === 11 && da.indexOf('502') === 0) da = da.slice(3);
            if (db.length === 11 && db.indexOf('502') === 0) db = db.slice(3);
            return da === db;
        }
        if (key === 'dpi') return digits(a) === digits(b);
        if (key === 'nit') {
            if (isCF(a) && isCF(b)) return true;
            if (isCF(a) !== isCF(b)) return false;
            return nitCore(a) === nitCore(b);
        }
        return squash(a).toLowerCase() === squash(b).toLowerCase();
    }

    // ── Revision de lo que escribe el vecino ──
    // values: lo escrito (ya limpio o no); opts: { noNit, noDpi } (el vecino dice que no tiene). Devuelve { campo: mensaje }
    function validate(values, opts) {
        var o = opts || {};
        var v = values || {};
        var errors = {};
        var casa = clean('casa', v.casa);
        if (!casa) errors.casa = 'Escriba su lote o casa.';
        var phone = clean('phone', v.phone);
        var pd = digits(phone);
        if (!phone) errors.phone = 'Escriba su teléfono.';
        else if (pd.length < 8 || pd.length > 15) errors.phone = 'El teléfono debe tener 8 números (o con código de país).';
        var email = clean('email', v.email);
        if (email && !/^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[A-Za-z]{2,}$/.test(email)) errors.email = 'Ese correo no parece válido.';
        var nit = clean('nit', v.nit);
        if (!o.noNit) {
            var nc = nitCore(nit);
            if (!nit) errors.nit = 'Escriba su NIT, o marque que no tiene (C/F).';
            else if (!isCF(nit) && !(/^\d{4,13}$/.test(nc) || /^\d{3,12}K$/.test(nc))) errors.nit = 'El NIT son números (con un verificador al final, que puede ser K) o C/F.';
        }
        var dpi = clean('dpi', v.dpi);
        if (!o.noDpi) {
            if (!dpi) errors.dpi = 'Escriba su DPI, o marque que no lo tiene.';
            else if (dpi.length !== 13) errors.dpi = 'El DPI tiene 13 números.';
        }
        ['propietario', 'direccion'].forEach(function (k) {
            if (squash(v[k]).length > 160) errors[k] = 'Es muy largo (máximo 160 letras).';
        });
        return errors;
    }

    // ── La solicitud ──
    // user: el vecino (usuarios/{id}); ficha: finanzas_residentes/{id} o null. Devuelve los cuatro datos de lo actual.
    function currentOf(user, ficha) {
        var u = user || {};
        var f = ficha || {};
        return {
            casa: clean('casa', u.casa), phone: clean('phone', u.phone), email: clean('email', u.email),
            nit: clean('nit', f.nit), dpi: clean('dpi', f.dpi), propietario: clean('propietario', f.propietario), direccion: clean('direccion', f.direccion)
        };
    }
    // Lo propuesto a partir de lo escrito. Quien dice "no tengo NIT" queda con C/F; quien dice "no tengo DPI" deja su DPI como estaba.
    function proposedOf(values, current, opts) {
        var o = opts || {};
        var v = values || {};
        var out = {};
        // Un campo que no viene (undefined) queda como estaba; uno vacio ('') es borrarlo
        KEYS.forEach(function (k) { out[k] = v[k] === undefined ? ((current || {})[k] || '') : clean(k, v[k]); });
        if (o.noNit && !out.nit) out.nit = 'C/F';
        if (o.noDpi && !out.dpi) out.dpi = (current && current.dpi) || '';
        return out;
    }
    function changedKeys(current, proposed) {
        return KEYS.filter(function (k) { return !same(k, (current || {})[k], (proposed || {})[k]); });
    }
    // El documento que se guarda en actualizaciones_datos (sin id): lo ve la administracion tal cual.
    function buildRequest(input) {
        var i = input || {};
        var current = currentOf(i.user, i.ficha);
        var proposed = proposedOf(i.values, current, { noNit: !!i.noNit, noDpi: !!i.noDpi });
        var changed = changedKeys(current, proposed);
        // Lo que no cambia se guarda como estaba (asi la lista no muestra un NIT "distinto" por un espacio)
        KEYS.forEach(function (k) { if (changed.indexOf(k) < 0) proposed[k] = current[k]; });
        return {
            userId: String((i.user && i.user.id) || i.userId || ''),
            condominioId: String(i.condominioId || (i.user && i.user.condominioId) || ''),
            name: squash((i.user && i.user.name) || ''),
            casa: current.casa,
            status: STATUS.PENDING,
            origin: i.origin === 'mis-datos' ? 'mis-datos' : 'primer-ingreso',
            current: current,
            proposed: proposed,
            changed: changed,
            sinCambios: changed.length === 0,
            noNit: !!i.noNit && proposed.nit === 'C/F',
            noDpi: !!i.noDpi && !proposed.dpi,
            createdAt: i.now || new Date().toISOString()
        };
    }

    // ── Lo que ve y hace quien revisa ──
    // Las filas de la tabla "actual / lo que escribio el vecino": solo lo que cambia
    function changedRows(doc) {
        var d = doc || {};
        return (Array.isArray(d.changed) ? d.changed : []).filter(function (k) { return KEYS.indexOf(k) >= 0; }).map(function (k) {
            return { key: k, label: labelOf(k), current: ((d.current || {})[k]) || '', proposed: ((d.proposed || {})[k]) || '' };
        });
    }
    // Que se escribe y donde al aplicar los campos elegidos: { usuarios: {...}, finanzas: {...}, keys: [...] }
    function applyPlan(doc, selectedKeys) {
        var d = doc || {};
        var wanted = Array.isArray(selectedKeys) ? selectedKeys : (Array.isArray(d.changed) ? d.changed : []);
        var plan = { usuarios: {}, finanzas: {}, keys: [] };
        wanted.forEach(function (k) {
            var f = fieldOf(k);
            if (!f || (d.changed || []).indexOf(k) < 0) return;
            var value = ((d.proposed || {})[k]);
            if (value == null) return;
            plan[f.target][k] = value;
            plan.keys.push(k);
        });
        return plan;
    }
    // Avisos para quien revisa: users = los usuarios del condominio (para ver si otro vecino ya tiene ese lote); live = lo que dice hoy
    // la base de ese vecino ({ casa, phone, ... }, para ver si cambio desde que el vecino envio su solicitud)
    function warnings(doc, users, live) {
        var d = doc || {};
        var out = [];
        var proposed = d.proposed || {};
        if ((d.changed || []).indexOf('casa') >= 0 && proposed.casa) {
            var other = (users || []).filter(function (u) { return u && u.id !== d.userId && u.role === 'vecino' && u.active !== false && same('casa', u.casa, proposed.casa); })[0];
            if (other) out.push('El lote ' + proposed.casa + ' ya lo tiene ' + (squash(other.name) || 'otro vecino') + '.');
        }
        if (live) {
            var moved = (d.changed || []).filter(function (k) { return live[k] !== undefined && !same(k, live[k], (d.current || {})[k]); });
            if (moved.length) out.push('Cambió en el sistema desde que el vecino la envió: ' + moved.map(labelOf).join(', ') + '.');
        }
        if (d.noNit) out.push('Dijo que no tiene NIT (queda C/F).');
        if (d.noDpi) out.push('Dijo que no tiene DPI.');
        return out;
    }
    // Una linea por solicitud para el listado y el Excel: "Teléfono: 5555-1234 → 5555-9999 · NIT: C/F → 1234567-8"
    function summarize(doc) {
        var rows = changedRows(doc);
        if (!rows.length) return 'Confirmó sus datos (sin cambios)';
        return rows.map(function (r) { return r.label + ': ' + (r.current || '(vacío)') + ' → ' + (r.proposed || '(vacío)'); }).join(' · ');
    }
    // ¿Puede el vecino cambiar su solicitud? Solo mientras la administracion no la haya revisado
    function editable(doc) { return !!doc && doc.status === STATUS.PENDING; }
    // De varias solicitudes de un vecino, la mas reciente
    function latest(docs) {
        return (docs || []).slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })[0] || null;
    }

    return {
        FIELDS: FIELDS, KEYS: KEYS, STATUS: STATUS, STATUS_LABEL: STATUS_LABEL, ORIGIN_LABEL: ORIGIN_LABEL,
        fieldOf: fieldOf, labelOf: labelOf, clean: clean, same: same, isCF: isCF, validate: validate,
        currentOf: currentOf, proposedOf: proposedOf, changedKeys: changedKeys, buildRequest: buildRequest,
        changedRows: changedRows, applyPlan: applyPlan, warnings: warnings, summarize: summarize, editable: editable, latest: latest
    };
});
