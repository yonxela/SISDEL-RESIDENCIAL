// Pruebas del registro de ingresos y salidas (accesos.js): sin emuladores ni navegador.
// El modulo (que arma cada registro igual en la garita y en la camara), lo que la camara guarda de cada lectura (decide.js con una
// base de mentira), que las reglas, la garita, el nucleo y el reporte esten conectados, y que la copia del servidor sea identica.
// Las reglas contra Firestore y la garita en un navegador se prueban en test-emulator.mjs y test-garita-accesos.mjs.
// Uso: node test-accesos.mjs (tambien corre con npm test).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const A = require('../accesos.js');
const { decideAccess } = require('../functions/src/anpr/decide.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

console.log('\nEl modulo');
equal('functions/src/accesos.js es identico a accesos.js', read('functions/src/accesos.js'), read('accesos.js'));
const base = { id: 'a1', condominioId: 'c1', direction: 'entrada', kind: 'residente', via: 'qr', source: 'garita' };
equal('un registro minimo lleva sus campos fijos y nada de mas', A.build({ ...base, at: '2026-11-20T15:00:00.000Z' }), { id: 'a1', condominioId: 'c1', at: '2026-11-20T15:00:00.000Z', day: '2026-11-20', direction: 'entrada', kind: 'residente', via: 'qr', outcome: 'autorizado', moroso: false, source: 'garita' });
equal('el dia es el de Guatemala (UTC-6), no el de Greenwich: 21:00 en Guatemala todavia es el mismo dia', [A.guatemalaDay('2026-11-21T03:00:00.000Z'), A.guatemalaDay('2026-11-21T05:59:59.000Z'), A.guatemalaDay('2026-11-21T06:00:00.000Z')], ['2026-11-20', '2026-11-20', '2026-11-21']);
equal('un registro completo de una visita', A.build({ ...base, kind: 'visita', via: 'lista', at: '2026-11-20T15:00:00.000Z', status: 'Reminder', moroso: true, userId: 'u-ana', name: 'Ana García', casa: 'Casa 12', fase: '2',
    plate: 'p 123 abc', visitId: 'v1', visitorName: '  Roberto   Herrera ', visitType: 'temporal', reason: 'Visita: Roberto', guardId: 'u-pedro', guardName: 'Pedro' }),
    { id: 'a1', condominioId: 'c1', at: '2026-11-20T15:00:00.000Z', day: '2026-11-20', direction: 'entrada', kind: 'visita', via: 'lista', outcome: 'aviso_mora', moroso: true, source: 'garita',
        userId: 'u-ana', name: 'Ana García', casa: 'Casa 12', fase: '2', plate: 'P123ABC', visitId: 'v1', visitorName: 'Roberto Herrera', visitType: 'temporal', reason: 'Visita: Roberto', guardId: 'u-pedro', guardName: 'Pedro' });
equal('el resultado sale del estado de la camara (Authorized, Reminder, otro) o se da directo', [A.build({ ...base, status: 'Authorized' }).outcome, A.build({ ...base, status: 'Reminder' }).outcome, A.build({ ...base, status: 'Denied' }).outcome, A.build({ ...base, status: 'Error' }).outcome, A.build({ ...base, outcome: 'denegado' }).outcome], ['autorizado', 'aviso_mora', 'denegado', 'denegado', 'denegado']);
equal('sin condominio, movimiento, tipo, medio o procedencia validos no hay registro', [{ ...base, condominioId: '' }, { ...base, direction: 'pasa' }, { ...base, kind: 'mascota' }, { ...base, via: 'telepatia' }, { ...base, source: 'otro' }, null, undefined].map((i) => A.build(i)), [null, null, null, null, null, null, null]);
equal('los campos opcionales vacios no se guardan', Object.keys(A.build({ ...base, name: '', casa: '   ', plate: '', reason: null })).sort(), ['at', 'condominioId', 'day', 'direction', 'id', 'kind', 'moroso', 'outcome', 'source', 'via']);
equal('un texto muy largo se corta a 300 letras y la placa a 20', [A.build({ ...base, reason: 'x'.repeat(500) }).reason.length, A.build({ ...base, plate: 'A'.repeat(50) }).plate.length], [300, 20]);
equal('moroso es verdadero o falso (nunca un texto)', [A.build({ ...base, moroso: 'si' }).moroso, A.build({ ...base, moroso: true }).moroso], [false, true]);
equal('todo lo que arma esta entre los campos permitidos', Object.keys(A.build({ ...base, status: 'Authorized', userId: 'u', name: 'n', casa: 'c', fase: 'f', plate: 'p', vehicleId: 'v', visitId: 'i', visitorName: 'n', visitType: 't', reason: 'r', guardId: 'g', guardName: 'g', moroso: true })).every((k) => A.FIELDS.includes(k)), true);
equal('quien es: el vecino, o el visitante en una visita; los nombres de cada cosa', [A.who({ kind: 'residente', name: 'Ana' }), A.who({ kind: 'visita', name: 'Ana', visitorName: 'Roberto' }), A.label('direction', 'salida'), A.label('kind', 'vehiculo'), A.label('via', 'lista'), A.label('outcome', 'aviso_mora'), A.label('via', 'raro')], ['Ana', 'Roberto', 'Salida', 'Vehículo de vecino', 'Lista de visitas', 'Con aviso de mora', 'raro']);

console.log('\nLas reglas de Firestore piden lo mismo que el modulo');
{
    const rules = read('firestore.rules');
    const block = rules.slice(rules.indexOf('match /accesos/{accessId}'), rules.indexOf('// ── Bitacora: el rastro'));
    const listOf = (re) => { const m = block.match(re); return m ? [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]) : null; };
    equal('hasOnly: las mismas claves que FIELDS', listOf(/hasOnly\(\[([^\]]*)\]/), A.FIELDS);
    equal('hasAll: los campos fijos mas guardId', listOf(/hasAll\(\[([^\]]*)\]/), [...A.REQUIRED, 'guardId']);
    equal('los movimientos, los tipos, los medios y los resultados de la lista', [listOf(/d\.direction in \[([^\]]*)\]/), listOf(/d\.kind in \[([^\]]*)\]/), listOf(/d\.via in \[([^\]]*)\]/), listOf(/d\.outcome in \[([^\]]*)\]/)], [A.DIRECTIONS, A.KINDS, A.VIAS, A.OUTCOMES]);
    yes('la garita lo escribe a su nombre (guardId = quien esta conectado), con su id y su condominio', /d\.guardId == request\.auth\.uid/.test(block) && /d\.id == accessId && d\.condominioId == condoId && d\.source == 'garita'/.test(block));
    yes('un ingreso pide garita.ingreso y una salida garita.salida', /request\.resource\.data\.direction == 'entrada' \? pGaritaIngreso\(condoId\) : pGaritaSalida\(condoId\)/.test(block));
    yes('solo se agrega: no se cambia ni se borra', /allow update, delete: if false;/.test(block));
    yes('se lee como el historial de la camara', /allow read: if isMaster\(\) \|\| pGaritaCamara\(condoId\);/.test(block));
    yes('los textos tienen su largo maximo y moroso es booleano', /d\.moroso is bool/.test(block) && /accessText\(d, 'reason', 300\)/.test(block) && /accessText\(d, 'plate', 20\)/.test(block));
}

console.log('\nLo que la camara guarda de cada lectura (decide.js con una base de mentira)');
{
    // Una base minima: colecciones con documentos y consultas where encadenadas (==, >=)
    const store = {
        usuarios: { 'u-ana': { name: 'Ana García', casa: 'Casa 12', fase: '2', paymentStatus: 'al_dia', active: true }, 'u-maria': { name: 'María López', casa: 'Casa 23', paymentStatus: 'moroso', morosoSince: new Date().toISOString(), active: true }, 'u-baja': { name: 'Baja', casa: 'Casa 9', paymentStatus: 'al_dia', active: false } },
        vehiculos: { 'veh-1': { userId: 'u-ana', plateNorm: 'P987XYZ' }, 'veh-2': { userId: 'u-maria', plateNorm: 'P111MOR' }, 'veh-3': { userId: 'u-baja', plateNorm: 'P444BAJ' } },
        visitas: {
            'vis-1': { userId: 'u-ana', visitorName: 'Roberto Herrera', vehiclePlate: 'P-123-ABC', status: 'pending', visitDate: new Date().toISOString().slice(0, 10), casa: 'Casa 12' },
            'vis-t': { userId: 'u-ana', visitorName: 'Luis Pérez', vehiclePlate: 'M456DEF', status: 'entered', visitType: 'temporal', endDate: '2099-01-01', visitDate: '2020-01-01', casa: 'Casa 12' },
            'vis-b': { userId: 'u-baja', visitorName: 'Invitado de baja', vehiclePlate: 'P555BAJ', status: 'pending', visitDate: new Date().toISOString().slice(0, 10), casa: 'Casa 9' }
        }
    };
    const query = (docs) => ({
        where(field, op, value) { return query(docs.filter(([, d]) => (op === '==' ? d[field] === value : d[field] >= value))); },
        async get() { return { docs: docs.map(([id, d]) => ({ id, data: () => d })) }; }
    });
    const condoRef = { collection: (name) => ({ ...query(Object.entries(store[name])), doc: (id) => ({ async get() { return { exists: !!store[name][id], data: () => store[name][id] }; } }) }) };
    const condo = { reminderEnabled: true, gracePeriodDays: 15 };

    const resident = await decideAccess(condoRef, condo, 'P987XYZ');
    equal('el vecino al dia: autorizado, con quien es y su vehiculo', [resident.status, resident.subject], ['Authorized', { kind: 'vehiculo', userId: 'u-ana', name: 'Ana García', casa: 'Casa 12', fase: '2', moroso: false, vehicleId: 'veh-1' }]);
    const moroso = await decideAccess(condoRef, condo, 'P111MOR');
    equal('el moroso con gracia: aviso, y queda como moroso', [moroso.status, moroso.subject.moroso, moroso.subject.userId, moroso.subject.casa], ['Reminder', true, 'u-maria', 'Casa 23']);
    const visit = await decideAccess(condoRef, condo, 'P123ABC');
    equal('la visita programada: es una visita, con su visitante y el vecino que la autoriza', [visit.status, visit.visitIdToMark, visit.subject], ['Authorized', 'vis-1', { kind: 'visita', userId: 'u-ana', name: 'Ana García', casa: 'Casa 12', fase: '2', moroso: false, visitId: 'vis-1', visitorName: 'Roberto Herrera', visitType: '' }]);
    const temporal = await decideAccess(condoRef, condo, 'M456DEF');
    equal('el vecino temporal: es una visita de tipo temporal y no se vuelve a marcar', [temporal.status, temporal.visitIdToMark, temporal.subject.kind, temporal.subject.visitType, temporal.subject.visitId], ['Authorized', null, 'visita', 'temporal', 'vis-t']);
    const unknown = await decideAccess(condoRef, condo, 'P000ZZZ');
    equal('una placa que no es de nadie: denegada y sin sujeto', [unknown.status, unknown.reason, unknown.subject], ['Denied', 'Placa no registrada', null]);
    const inactive = await decideAccess(condoRef, condo, 'P444BAJ');
    equal('el vehiculo de un vecino dado de baja: denegado, sin sujeto (nadie lo reclama)', [inactive.status, inactive.subject], ['Denied', null]);
    const blockedVisit = await decideAccess(condoRef, condo, 'P555BAJ');
    equal('una visita cuyo vecino esta dado de baja: denegada, pero queda de quien era la visita', [blockedVisit.status, blockedVisit.subject && blockedVisit.subject.kind, blockedVisit.subject && blockedVisit.subject.visitId, blockedVisit.subject && blockedVisit.subject.userId], ['Denied', 'visita', 'vis-b', 'u-baja']);
    // Y el registro que sale de cada decision es valido para las reglas
    const record = A.build({ id: 'x', condominioId: 'c1', direction: 'entrada', via: 'camara', source: 'camara', status: visit.status, kind: visit.subject.kind, plate: 'P123ABC', ...visit.subject, reason: visit.reason });
    equal('el registro de la camara se arma sin campos desconocidos y sin guardia', [!!record, Object.keys(record).every((k) => A.FIELDS.includes(k)), record.guardId, record.source, record.via], [true, true, undefined, 'camara', 'camara']);
}

console.log('\nConexiones: la camara, la garita, el nucleo y el reporte');
{
    const webhook = read('functions/src/anpr/webhook.js'), garita = read('garita.html'), core = read('sisdel-core.js'), reports = read('reportes-ui.js'), admin = read('admin.html');
    yes('el webhook anota cada lectura como una ENTRADA por camara, despues del historial y sin frenar la respuesta (con su error aparte)',
        /require\('\.\.\/accesos'\)/.test(webhook) && /direction: 'entrada', via: 'camara', source: 'camara', status: decision\.status/.test(webhook)
        && /await writeLog\(condoRef\.collection\('camera_logs'\)[\s\S]{0,200}\}\);\s*try \{ await writeAccess\(condoRef, condominioId, plateNumber, decision\); \}\s*catch \(accessError\) \{ logger\.error\('ANPR no pudo guardar el acceso'/.test(webhook));
    yes('garita.html carga accesos.js antes del nucleo y guarda cada ingreso y cada salida (logAccess) con el medio que corresponde',
        garita.indexOf('accesos.js') > 0 && garita.indexOf('accesos.js') < garita.indexOf('sisdel-core.js') && /await logAccess\('entrada', verification\);/.test(garita) && /await logAccess\('salida', verification\);/.test(garita)
        && /accessVia = 'lista';/.test(garita) && /accessVia = 'codigo';/.test(garita) && /accessVia = 'qr';/.test(garita) && /currentVerification = \{ obj, type, via: accessVia \};/.test(garita));
    yes('si no se pudo guardar el movimiento se avisa en pantalla (el movimiento ya ocurrio)', /El movimiento se hizo, pero no se pudo guardar en el registro de accesos/.test(garita));
    yes('el nucleo ofrece createAccess (con el guardia de la sesion), getAccessBetween y getFirstAccessAt',
        /async function createAccess\(condominioId, input\)/.test(core) && /source: 'garita', guardId: session\.userId \|\| '', guardName: session\.userName \|\| ''/.test(core) && /createAccess, getAccessBetween, getFirstAccessAt,/.test(core) && /access: 'accesos'/.test(core));
    yes('el administrador carga accesos.js y su reporte "Registro de ingresos y salidas" es el primero de Garita',
        /accesos\.js\?v=/.test(admin) && /GARITA_REPORTS = \[\s*\{ id: 'garita-accesos', label: 'Registro de ingresos y salidas'/.test(reports) && /async function buildAccesos\(def,/.test(reports) && /if \(def\.id === 'garita-accesos'\) \{ await buildAccesos\(/.test(reports));
    const versions = (file, name) => (read(file).match(new RegExp(`${name}\\.js\\?v=(\\w+)`)) || [])[1];
    yes('garita.html y admin.html cargan accesos.js con la misma version', versions('garita.html', 'accesos') && versions('garita.html', 'accesos') === versions('admin.html', 'accesos'));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
process.exit(failures.length ? 1 : 0);
