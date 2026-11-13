// Sello del servidor de los movimientos del Sistema Financiero (campo server_at).
//
// Cada equipo guarda una copia de los movimientos y, al abrir, pide solo los que cambiaron desde la ultima vez
// (finanzas-sync.js). Para saber "que cambio" sin depender del reloj de cada equipo, el servidor sella con su
// propia hora cada movimiento que se crea o modifica:
// - onFinanceMovement (index.js) lo sella cuando un cambio no trajo un sello nuevo (lo escribio un cliente).
// - recalcCondo (recalc.js), en la tarea diaria, repone los sellos que falten o hayan quedado atrasados.
// Las reglas no dejan que un cliente escriba este campo.
const SERVER_STAMP = 'server_at';
// Un movimiento escrito hace menos de esto y sin sello se sella en la tarea diaria (el disparador fallo). Los
// anteriores a que existiera el sello no hace falta sellarlos: cada equipo los baja en su primera carga.
const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
// Diferencia tolerada entre la ultima escritura del documento y su sello
const SLACK_MS = 2000;

const millis = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null);
const sameStamp = (a, b) => !!a && !!b && typeof a.isEqual === 'function' && a.isEqual(b);

// Tras una escritura: ¿hay que sellar? Si no quedo sello (o quedo algo que no es una fecha del servidor), o si
// quedo el mismo de antes.
function needsStamp(before, after) {
    if (!after) return false;
    if (millis(after[SERVER_STAMP]) === null) return true;
    return !!before && sameStamp(before[SERVER_STAMP], after[SERVER_STAMP]);
}

function withoutStamp(data) {
    const sorted = {};
    Object.keys(data).filter((k) => k !== SERVER_STAMP).sort().forEach((k) => { sorted[k] = data[k]; });
    return JSON.stringify(sorted);
}
// La escritura solo cambio el sello (fue el sellado mismo): no hay nada que recalcular
function onlyStampChanged(before, after) {
    if (!before || !after) return false;
    return !sameStamp(before[SERVER_STAMP], after[SERVER_STAMP]) && withoutStamp(before) === withoutStamp(after);
}

// En la tarea diaria: ¿a este documento le falta el sello o le quedo atrasado?
// updateTime: ultima escritura del documento; stamp: su sello; nowMs: ahora.
function staleStamp(updateTime, stamp, nowMs) {
    const updated = millis(updateTime);
    if (updated === null) return false;
    const stamped = millis(stamp);
    if (stamped === null) return nowMs - updated < RECENT_MS;
    return updated - stamped > SLACK_MS;
}

module.exports = { SERVER_STAMP, RECENT_MS, SLACK_MS, needsStamp, onlyStampChanged, staleStamp };
