// Pruebas de la actualizacion de datos de los vecinos (sisdel-actualizaciones.js): limpieza y comparacion de cada dato, revision
// de lo que escribe el vecino, la solicitud que se guarda y lo que ve y aplica quien revisa. Sin emuladores.
// Uso: node test-actualizaciones.mjs (tambien corre con npm test)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../sisdel-actualizaciones.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FALLA ${name} ${detail}`); }
}
function equal(name, actual, expected) {
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `-> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

console.log('\nCampos');
equal('los siete campos, en orden', A.KEYS, ['casa', 'phone', 'email', 'nit', 'dpi', 'propietario', 'direccion']);
equal('van a usuarios: lote, telefono y correo; a la ficha de Finanzas: NIT, DPI, propietario y direccion', A.FIELDS.map((f) => `${f.key}:${f.target}`),
    ['casa:usuarios', 'phone:usuarios', 'email:usuarios', 'nit:finanzas', 'dpi:finanzas', 'propietario:finanzas', 'direccion:finanzas']);
equal('el nombre que ve la gente', [A.labelOf('casa'), A.labelOf('nit'), A.labelOf('dpi'), A.labelOf('xx')], ['Lote o casa', 'NIT', 'DPI', 'xx']);

console.log('\nLimpiar lo escrito');
equal('DPI: solo digitos (con espacios y guiones)', A.clean('dpi', ' 2345 67890 1234 '), '2345678901234');
equal('NIT: mayusculas y sin espacios', A.clean('nit', ' 1234567-k '), '1234567-K');
equal('NIT: c/f en cualquier forma queda C/F', [A.clean('nit', 'c/f'), A.clean('nit', 'C.F.'), A.clean('nit', 'cf'), A.clean('nit', ' C / F ')], ['C/F', 'C/F', 'C/F', 'C/F']);
equal('correo en minusculas', A.clean('email', '  Ana@Correo.COM '), 'ana@correo.com');
equal('telefono: sin letras', A.clean('phone', 'Tel: 5555 - 1234 ext'), '5555 - 1234');
equal('lote: espacios de mas', A.clean('casa', '  Lote   A 012 '), 'Lote A 012');
equal('largo maximo', A.clean('direccion', 'x'.repeat(300)).length, 160);

console.log('\nEl mismo dato escrito distinto no es un cambio');
ok('DPI con espacios = sin espacios', A.same('dpi', '2345 67890 1234', '2345678901234'));
ok('NIT en minusculas o con espacios', A.same('nit', '1234567-k', '1234567-K ') && A.same('nit', '1234567-8', '12345678'));
ok('C/F es C/F', A.same('nit', 'C/F', 'cf') && !A.same('nit', 'C/F', '1234567-8'));
ok('telefono con o sin codigo de pais', A.same('phone', '5555-1234', '+502 5555 1234') && A.same('phone', '55551234', '5555 1234') && !A.same('phone', '5555-1234', '5555-1235'));
ok('lote sin importar mayusculas ni espacios', A.same('casa', 'a 012', ' A  012') && !A.same('casa', 'A 012', 'A 013'));
ok('correo sin importar mayusculas', A.same('email', 'ANA@x.com', 'ana@x.com'));
ok('vacio contra vacio', A.same('propietario', '', null));

console.log('\nRevisar lo que escribe el vecino');
const good = { casa: 'A 012', phone: '5555-1234', email: '', nit: '1234567-8', dpi: '2345 67890 1234' };
equal('todo bien: sin errores', A.validate(good), {});
equal('falta el lote y el telefono', Object.keys(A.validate({ casa: '', phone: '', nit: 'C/F', dpi: '2345678901234' })), ['casa', 'phone']);
ok('telefono muy corto', !!A.validate({ ...good, phone: '5555' }).phone);
ok('telefono con codigo de pais es valido', !A.validate({ ...good, phone: '+502 5555 1234' }).phone);
ok('correo mal escrito', !!A.validate({ ...good, email: 'ana@correo' }).email && !A.validate({ ...good, email: 'ana@correo.com' }).email);
ok('el correo es opcional', !A.validate({ ...good, email: '' }).email);
ok('NIT: C/F vale, con K vale, letras no', !A.validate({ ...good, nit: 'c/f' }).nit && !A.validate({ ...good, nit: '1234567-K' }).nit && !!A.validate({ ...good, nit: 'abc' }).nit && !!A.validate({ ...good, nit: '12' }).nit);
ok('NIT vacio pide escribirlo o marcar que no tiene', /marque/.test(A.validate({ ...good, nit: '' }).nit) && !A.validate({ ...good, nit: '' }, { noNit: true }).nit);
ok('DPI: 13 numeros', !!A.validate({ ...good, dpi: '12345' }).dpi && !!A.validate({ ...good, dpi: '12345678901234' }).dpi && !A.validate({ ...good, dpi: '1234 56789 0123' }).dpi);
ok('DPI vacio pide escribirlo o marcar que no lo tiene', /marque/.test(A.validate({ ...good, dpi: '' }).dpi) && !A.validate({ ...good, dpi: '' }, { noDpi: true }).dpi);
ok('direccion muy larga', !!A.validate({ ...good, direccion: 'x'.repeat(161) }).direccion);

console.log('\nLa solicitud');
const user = { id: 'u1', condominioId: 'c1', name: '  Ana   García ', casa: 'A 012', phone: '5555-1234', email: '' };
const ficha = { nit: '1234567-8', dpi: '2345678901234', propietario: '', direccion: 'Calle 1' };
const same1 = A.buildRequest({ user, ficha, values: { casa: 'a 012', phone: '+502 5555 1234', email: '', nit: '12345678', dpi: '2345 67890 1234', propietario: '', direccion: 'Calle 1' }, now: '2026-11-23T10:00:00.000Z' });
ok('quien confirma sin cambiar nada: solicitud "sin cambios"', same1.sinCambios === true && same1.changed.length === 0 && same1.status === 'pendiente' && same1.origin === 'primer-ingreso');
equal('trae quien es, su lote de ese dia y cuando', [same1.userId, same1.condominioId, same1.name, same1.casa, same1.createdAt], ['u1', 'c1', 'Ana García', 'A 012', '2026-11-23T10:00:00.000Z']);
equal('lo que no cambia se guarda como estaba (no como lo escribio)', [same1.proposed.phone, same1.proposed.nit, same1.proposed.casa], ['5555-1234', '1234567-8', 'A 012']);
const changed = A.buildRequest({ user, ficha, values: { casa: 'A 013', phone: '5555-9999', email: 'ana@correo.com', nit: 'C/F', dpi: '2345678901234', propietario: '', direccion: 'Calle 1' }, origin: 'mis-datos' });
equal('lo que cambia: lote, telefono, correo y NIT', changed.changed, ['casa', 'phone', 'email', 'nit']);
ok('no es "sin cambios" y dice de donde viene', changed.sinCambios === false && changed.origin === 'mis-datos');
equal('lo actual y lo propuesto', [changed.current.nit, changed.proposed.nit, changed.current.phone, changed.proposed.phone], ['1234567-8', 'C/F', '5555-1234', '5555-9999']);
const noNit = A.buildRequest({ user: { ...user }, ficha: {}, values: { casa: 'A 012', phone: '5555-1234', nit: '', dpi: '' }, noNit: true, noDpi: true });
ok('"no tengo NIT" queda C/F y "no tengo DPI" queda vacio, con su marca', noNit.proposed.nit === 'C/F' && noNit.proposed.dpi === '' && noNit.noNit === true && noNit.noDpi === true);
const keepDpi = A.buildRequest({ user, ficha, values: { casa: 'A 012', phone: '5555-1234', nit: '1234567-8', dpi: '' }, noDpi: true });
ok('"no tengo DPI" no borra un DPI que ya estaba', keepDpi.proposed.dpi === '2345678901234' && keepDpi.noDpi === false && keepDpi.sinCambios === true);
equal('un campo que no viene queda como estaba; uno vacio lo borra', (({ changed, proposed }) => ({ changed, direccion: proposed.direccion }))(A.buildRequest({ user, ficha, values: { casa: 'A 012', phone: '5555-1234', nit: '1234567-8', dpi: '2345678901234', direccion: '' } })), { changed: ['direccion'], direccion: '' });
ok('el origen se limita a los dos conocidos', A.buildRequest({ user, ficha, values: {}, origin: 'otro' }).origin === 'primer-ingreso');
equal('el documento solo trae lo conocido', Object.keys(changed).sort(), ['casa', 'changed', 'condominioId', 'createdAt', 'current', 'name', 'noDpi', 'noNit', 'origin', 'proposed', 'sinCambios', 'status', 'userId']);

console.log('\nLo que ve y aplica quien revisa');
equal('filas: solo lo que cambia, con su nombre', A.changedRows(changed).map((r) => [r.label, r.current, r.proposed]),
    [['Lote o casa', 'A 012', 'A 013'], ['Teléfono', '5555-1234', '5555-9999'], ['Correo electrónico', '', 'ana@correo.com'], ['NIT', '1234567-8', 'C/F']]);
equal('una solicitud sin cambios no trae filas', A.changedRows(same1), []);
equal('aplicar todo: usuarios (lote, telefono, correo) y ficha (NIT)', (({ usuarios, finanzas, keys }) => ({ usuarios, finanzas, keys }))(A.applyPlan(changed)),
    { usuarios: { casa: 'A 013', phone: '5555-9999', email: 'ana@correo.com' }, finanzas: { nit: 'C/F' }, keys: ['casa', 'phone', 'email', 'nit'] });
equal('aplicar solo lo elegido', (({ usuarios, finanzas }) => ({ usuarios, finanzas }))(A.applyPlan(changed, ['phone'])), { usuarios: { phone: '5555-9999' }, finanzas: {} });
equal('no se aplica nada que la solicitud no traiga como cambio', A.applyPlan(changed, ['dpi', 'direccion', 'xx']).keys, []);
equal('una solicitud sin cambios no aplica nada', A.applyPlan(same1).keys, []);
const users = [{ id: 'u1', role: 'vecino', name: 'Ana García', casa: 'A 012' }, { id: 'u2', role: 'vecino', name: 'Beto Núñez', casa: 'a 013' }, { id: 'u3', role: 'vecino', name: 'Inactivo', casa: 'A 014', active: false }, { id: 'g1', role: 'policia', name: 'Guardia', casa: 'A 013' }];
ok('aviso: otro vecino ya tiene ese lote', A.warnings(changed, users).some((w) => /A 013 ya lo tiene Beto Núñez/.test(w)));
ok('aviso: un vecino desactivado o un guardia no cuentan', !A.warnings({ ...changed, proposed: { ...changed.proposed, casa: 'A 014' } }, users).some((w) => /ya lo tiene/.test(w)));
ok('aviso: el lote que ya es suyo no es choque', !A.warnings({ ...changed, changed: ['phone'] }, users).some((w) => /ya lo tiene/.test(w)));
ok('aviso: cambio en el sistema desde que la envio', A.warnings(changed, users, { phone: '5555-0000', casa: 'A 012' }).some((w) => /Cambió en el sistema.*Teléfono/.test(w)) && !A.warnings(changed, users, { phone: '5555-1234' }).some((w) => /Cambió/.test(w)));
ok('aviso: dijo que no tiene NIT o DPI', A.warnings(noNit, users).filter((w) => /no tiene/.test(w)).length === 2);
equal('una linea por solicitud', [A.summarize(same1), A.summarize(A.buildRequest({ user, ficha, values: { casa: 'A 012', phone: '5555-9999', nit: '', dpi: '2345678901234' }, noNit: true }))],
    ['Confirmó sus datos (sin cambios)', 'Teléfono: 5555-1234 → 5555-9999 · NIT: 1234567-8 → C/F']);
ok('el vecino cambia su solicitud solo mientras esta pendiente', A.editable({ status: 'pendiente' }) && !A.editable({ status: 'aplicada' }) && !A.editable({ status: 'rechazada' }) && !A.editable(null));
equal('la mas reciente de varias', A.latest([{ id: 'a', createdAt: '2026-11-20T10:00:00Z' }, { id: 'b', createdAt: '2026-11-23T10:00:00Z' }, { id: 'c', createdAt: '2026-11-21T10:00:00Z' }]).id, 'b');
equal('sin solicitudes: null', A.latest([]), null);

console.log(`\n${passed} pruebas pasaron, ${failures.length} fallaron`);
if (failures.length) { console.log('Fallaron:\n - ' + failures.join('\n - ')); process.exit(1); }
