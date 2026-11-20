/* ═══════════════════════════════════════════════════════════════
   SISDEL - Registro de ingresos y salidas (colección `accesos`)
   ───────────────────────────────────────────────────────────────
   Cada vez que un vecino, un vehículo o una visita ENTRA o SALE queda un registro propio en
   condominios/{id}/accesos/{id}, con campos fijos (no texto suelto) para poder hacer reportes después. Se
   agrega siempre y NUNCA se cambia ni se borra (las reglas de Firestore no lo dejan).

   Lo escribe la garita (garita.html, con su usuario) y la cámara de placas (la función anprWebhook, con el
   servidor). Este módulo arma el registro igual en los dos lados: se carga en el navegador
   (<script src="accesos.js">) y en Node (functions/src/accesos.js es una COPIA IDENTICA; la prueba
   scripts/test-accesos.mjs falla si difieren). Sin dependencias.

   Campos:
     id, condominioId
     at          instante del movimiento (ISO, UTC)
     day         día del movimiento en hora de Guatemala (AAAA-MM-DD): para agrupar sin errores de zona horaria
     direction   entrada | salida
     kind        residente (el vecino mismo, por su código) | vehiculo (su placa o marbete) | visita
     via         camara (lectura de placa) | qr (código leído con la cámara del teléfono) | codigo (escrito a mano) |
                 lista (el guardia eligió la visita en la lista de visitas del día)
     outcome     autorizado | aviso_mora (entró, con aviso de mora) | denegado
     userId, name, casa, fase   el vecino (en una visita, quien la autoriza)
     plate, vehicleId           la placa y el vehículo registrado, si se conoce
     visitId, visitorName, visitType   la visita (visitType: temporal = vecino temporal o acceso por días)
     moroso      el vecino estaba moroso en ese momento
     reason      texto de lo que se vio (el mismo que el historial de la cámara)
     guardId, guardName   quien lo registró en la garita (vacío si fue la cámara)
     source      garita | camara
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelAccesos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DIRECTIONS = ['entrada', 'salida'];
    const KINDS = ['residente', 'vehiculo', 'visita'];
    const VIAS = ['camara', 'qr', 'codigo', 'lista'];
    const OUTCOMES = ['autorizado', 'aviso_mora', 'denegado'];
    const SOURCES = ['garita', 'camara'];
    const TIME_ZONE = 'America/Guatemala';
    const TEXT_MAX = 300;

    // Todas las claves que puede tener un registro (las reglas de Firestore aceptan solo estas)
    const FIELDS = ['id', 'condominioId', 'at', 'day', 'direction', 'kind', 'via', 'outcome', 'userId', 'name', 'casa', 'fase',
        'plate', 'vehicleId', 'visitId', 'visitorName', 'visitType', 'moroso', 'reason', 'guardId', 'guardName', 'source'];
    // Las que siempre trae
    const REQUIRED = ['id', 'condominioId', 'at', 'day', 'direction', 'kind', 'via', 'outcome', 'moroso', 'source'];

    const LABELS = {
        direction: { entrada: 'Entrada', salida: 'Salida' },
        kind: { residente: 'Vecino', vehiculo: 'Vehículo de vecino', visita: 'Visita' },
        via: { camara: 'Cámara de placas', qr: 'QR', codigo: 'Código escrito', lista: 'Lista de visitas' },
        outcome: { autorizado: 'Autorizado', aviso_mora: 'Con aviso de mora', denegado: 'Denegado' },
        source: { garita: 'Garita', camara: 'Cámara' }
    };
    const label = (group, value) => (LABELS[group] && LABELS[group][value]) || String(value == null ? '' : value);

    function text(value, max) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || TEXT_MAX);
    }
    function plateOf(value) {
        return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase().slice(0, 20);
    }

    // Día (AAAA-MM-DD) en hora de Guatemala de un instante ISO; '' si no es una fecha
    function guatemalaDay(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    }

    // El estado del historial de la cámara (Authorized, Reminder, Denied...) como resultado del registro
    function outcomeOfStatus(status) {
        if (status === 'Authorized') return 'autorizado';
        if (status === 'Reminder') return 'aviso_mora';
        return 'denegado';
    }

    // Arma el registro a partir de lo que se sabe. Devuelve null si falta lo esencial (condominio, movimiento, quién o cómo).
    // `id` lo pone quien lo guarda (el id del documento); `at` y `day` se ponen si no vienen.
    function build(input) {
        const i = input || {};
        const direction = text(i.direction, 20);
        const kind = text(i.kind, 20);
        const via = text(i.via, 20);
        const source = text(i.source, 20);
        const condominioId = text(i.condominioId, 128);
        if (!condominioId || !DIRECTIONS.includes(direction) || !KINDS.includes(kind) || !VIAS.includes(via) || !SOURCES.includes(source)) return null;
        const outcome = OUTCOMES.includes(i.outcome) ? i.outcome : (i.status ? outcomeOfStatus(i.status) : 'autorizado');
        const at = i.at && !Number.isNaN(new Date(i.at).getTime()) ? new Date(i.at).toISOString() : new Date().toISOString();
        const record = { id: text(i.id, 128), condominioId, at, day: guatemalaDay(at), direction, kind, via, outcome, moroso: i.moroso === true, source };
        const optional = {
            userId: text(i.userId, 128), name: text(i.name), casa: text(i.casa, 60), fase: text(i.fase, 60),
            plate: plateOf(i.plate), vehicleId: text(i.vehicleId, 128),
            visitId: text(i.visitId, 128), visitorName: text(i.visitorName), visitType: text(i.visitType, 30),
            reason: text(i.reason), guardId: text(i.guardId, 128), guardName: text(i.guardName)
        };
        Object.keys(optional).forEach((key) => { if (optional[key]) record[key] = optional[key]; });
        return record;
    }

    // Lo que se le dice a quien lo mira: Entrada de un vecino, Salida de una visita...
    function describe(record) {
        const r = record || {};
        return `${label('direction', r.direction)} · ${label('kind', r.kind)}`;
    }

    // Nombre que se muestra: el vecino, o el visitante en una visita
    function who(record) {
        const r = record || {};
        return r.kind === 'visita' ? (r.visitorName || '') : (r.name || '');
    }

    return { DIRECTIONS, KINDS, VIAS, OUTCOMES, SOURCES, FIELDS, REQUIRED, LABELS, TEXT_MAX, label, text, plateOf, guatemalaDay, outcomeOfStatus, build, describe, who };
});
