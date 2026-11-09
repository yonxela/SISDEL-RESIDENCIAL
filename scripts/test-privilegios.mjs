// Pruebas del catalogo de privilegios (privilegios.js) y de que todo el sistema lo respete: sin emuladores.
// Verifica el catalogo, que la copia de las functions sea identica, que las reglas de Firestore usen las
// mismas claves y los mismos roles por defecto, que cada pagina pida su privilegio de entrada y que un
// usuario sin privilegios asignados conserve exactamente el acceso que su rol tenia antes.
// Uso: node test-privilegios.mjs (tambien corre con npm test).
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = (file) => new URL(`../${file}`, import.meta.url);
const read = (file) => fs.readFileSync(root(file), 'utf8');
const P = require('../privilegios.js');
const server = require('../functions/src/privilegios.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);
const sorted = (list) => [...list].sort();
const keysOn = (role, overrides) => P.KEYS.filter((k) => P.effective(role, overrides)[k]);

// ───────── Catalogo ─────────
console.log('\nCatalogo');
// Los 26 privilegios de antes de las acciones: su acceso por rol no puede cambiar
const LEGACY = ['usuarios.panel', 'usuarios.ver', 'usuarios.crear', 'guardias.crear', 'usuarios.editar', 'usuarios.eliminar', 'usuarios.codigos', 'usuarios.privilegios',
    'mensajes.enviar', 'mensajes.historial', 'visitas.ver', 'visitas.gestionar', 'garita.operar', 'garita.camara', 'panico.activar', 'panico.ver', 'panico.atender',
    'finanzas.ver', 'finanzas.usar', 'rondas.ver', 'rondas.gestionar', 'rondas.patrullar', 'vecino.visitas', 'vecino.vehiculos', 'auditoria.ver', 'auditoria.exportar'];
const roots = P.ITEMS.filter((i) => !i.parent);
const kids = P.ITEMS.filter((i) => i.parent);
equal('las claves no se repiten', new Set(P.KEYS).size, P.KEYS.length);
yes('cada clave tiene la forma modulo.accion', P.KEYS.every((k) => /^[a-z]+\.[a-z_]+$/.test(k)));
yes('cada clave tiene etiqueta y descripcion', P.ITEMS.every((i) => i.label && i.description));
yes('cada clave dice si la garantizan las reglas o solo la pantalla', P.ITEMS.every((i) => ['reglas', 'pantalla'].includes(i.enforce)));
yes('cada clave tiene subgrupo', P.ITEMS.every((i) => i.sub));
yes('los roles por defecto existen', P.ITEMS.every((i) => i.defaultRoles.every((r) => P.ROLES.includes(r))));
yes('los 26 privilegios de siempre siguen existiendo', LEGACY.every((k) => P.KEYS.includes(k)));
yes('hay un privilegio para cada opcion: ya son mas de 130', P.KEYS.length >= 130);
equal('hay 138 privilegios: 29 paraguas y 109 acciones', [P.KEYS.length, roots.length, kids.length], [138, 29, 109]);
yes('solo los paraguas traen roles por defecto', roots.every((i) => Array.isArray(i.roles)) && kids.every((i) => i.roles === undefined));
yes('cada accion cuelga de un paraguas que existe y aparece antes', kids.every((i) => P.KEYS.includes(i.parent) && P.KEYS.indexOf(i.parent) < P.KEYS.indexOf(i.key)));
yes('el arbol tiene como maximo cuatro niveles (paraguas, pantalla, reporte, impresion)', P.ITEMS.every((i) => i.depth <= 3));
yes('una accion es del modulo de su paraguas, salvo vehiculos, plantillas y borrar el historial de la garita', kids.every((i) => i.key.split('.')[0] === i.parent.split('.')[0] || ['vehiculos.ver', 'vehiculos.crear', 'vehiculos.editar', 'vehiculos.eliminar', 'plantillas.gestionar', 'garita.historial_borrar'].includes(i.key)));
equal('asignar privilegios necesita editar usuarios (las reglas piden ambos)', P.itemOf('usuarios.privilegios').requires, ['usuarios.ver', 'usuarios.editar']);
yes('las claves de rondas necesitan ver usuarios (RONDIN lista al personal)', ['rondas.ver', 'rondas.patrullar'].every((k) => P.itemOf(k).requires.includes('usuarios.ver')));
yes('eliminar usuarios necesita ver codigos (el borrado limpia el codigo)', P.itemOf('usuarios.eliminar').requires.includes('usuarios.codigos'));
yes('las dependencias (requires) existen', P.ITEMS.every((i) => (i.requires || []).every((r) => P.KEYS.includes(r))));
yes('ninguna clave se requiere a si misma', P.ITEMS.every((i) => !(i.requires || []).includes(i.key)));
yes('las paginas piden claves que existen', P.PAGES.every((p) => p.role || p.any.every((k) => P.KEYS.includes(k))));
equal('el operador solo trae por defecto recibir mensajes (lo que ya leia) y ninguna pagina', [Object.keys(P.defaultsOf('operador')), P.landing('operador', {})], [['mensajes.recibir'], null]);
yes('las dependencias por defecto se cumplen en cada rol (si tiene X tiene lo que X necesita)',
    P.ROLES.every((role) => keysOn(role).every((k) => (P.itemOf(k).requires || []).every((r) => keysOn(role).includes(r)))));
yes('cada rol que tiene un paraguas recibe todas sus acciones', P.ROLES.every((role) => roots.filter((r) => P.has(role, {}, r.key)).every((r) => P.descendantsOf(r.key).every((c) => P.has(role, {}, c)))));
equal('las claves delicadas estan marcadas como sensibles', ['usuarios.privilegios', 'usuarios.codigos', 'finanzas.usar', 'finanzas.residentes_crear', 'finanzas.deshacer', 'rondas.monitoreo_ver', 'rondas.alertas_eliminar', 'auditoria.exportar'].map((k) => !!P.itemOf(k).sensitive), Array(8).fill(true));
yes('sensitiveKeys devuelve solo claves del catalogo', P.sensitiveKeys().length > 20 && P.sensitiveKeys().every((k) => P.KEYS.includes(k)));
yes('los grupos cubren todas las claves una sola vez', (() => { const seen = P.GROUPS.flatMap((g) => g.items.map((i) => i.key)); return seen.length === P.KEYS.length && new Set(seen).size === P.KEYS.length; })());

// Motor de paraguas
console.log('\nParaguas y acciones');
equal('apagar una accion no toca al paraguas ni a las demas', [P.has('admin', { 'usuarios.estadisticas': false }, 'usuarios.estadisticas'), P.has('admin', { 'usuarios.estadisticas': false }, 'usuarios.panel'), P.has('admin', { 'usuarios.estadisticas': false }, 'usuarios.contacto')], [false, true, true]);
equal('sin el paraguas no hay acciones, aunque se las pongan', [P.has('policia', { 'finanzas.pagos_registrar': true }, 'finanzas.pagos_registrar'), P.has('operador', { 'finanzas.pagos_registrar': true }, 'finanzas.pagos_registrar')], [false, false]);
equal('quitar el paraguas apaga todas sus acciones', P.descendantsOf('finanzas.usar').filter((k) => P.has('admin', { 'finanzas.usar': false }, k)), []);
equal('un operador con el paraguas recibe todas sus acciones', P.descendantsOf('rondas.ver').every((k) => P.has('operador', { 'rondas.ver': true }, k)), true);
equal('el operador con el paraguas y una accion apagada la pierde', P.has('operador', { 'rondas.ver': true, 'rondas.panel_ver': false }, 'rondas.panel_ver'), false);
equal('una accion apagada tambien apaga sus hijas', P.has('operador', { 'rondas.ver': true, 'rondas.monitoreo_ver': false }, 'rondas.monitoreo_historial'), false);
equal('childrenOf / descendantsOf / ancestorsOf', [P.childrenOf('rondas.monitoreo_ver'), P.descendantsOf('rondas.panel_ver'), P.ancestorsOf('rondas.reportes_imprimir')], [['rondas.monitoreo_historial'], ['rondas.reportes_ver', 'rondas.reportes_imprimir'], ['rondas.ver', 'rondas.panel_ver', 'rondas.reportes_ver']]);
yes('las acciones de usuarios.privilegios siguen siendo solo de administradores y operadores', P.descendantsOf('usuarios.privilegios').every((k) => !P.has('policia', { [k]: true, 'usuarios.privilegios': true }, k)));
equal('las acciones heredan el rol por defecto de su paraguas', roots.every((r) => P.ROLES.every((role) => P.descendantsOf(r.key).every((k) => P.has(role, {}, k) === P.has(role, {}, r.key)))), true);

// ───────── Copia en las functions ─────────
console.log('\nCopia en las functions');
equal('functions/src/privilegios.js es identico a privilegios.js', read('functions/src/privilegios.js'), read('privilegios.js'));

// ───────── Compatibilidad: los privilegios por defecto de cada rol son el acceso que tenia ─────────
console.log('\nCompatibilidad con los roles de siempre');
// Los 26 privilegios de siempre: el mismo acceso por rol que antes de las acciones
const legacyOn = (role) => sorted(keysOn(role).filter((k) => LEGACY.includes(k)));
equal('admin', legacyOn('admin'), sorted(['usuarios.panel', 'usuarios.ver', 'usuarios.crear', 'guardias.crear', 'usuarios.editar', 'usuarios.eliminar', 'usuarios.codigos', 'usuarios.privilegios', 'mensajes.enviar', 'mensajes.historial', 'visitas.ver', 'visitas.gestionar', 'garita.operar', 'garita.camara', 'panico.ver', 'panico.atender', 'finanzas.ver', 'finanzas.usar', 'rondas.ver', 'rondas.gestionar']));
equal('policia', legacyOn('policia'), sorted(['usuarios.ver', 'visitas.ver', 'garita.operar', 'garita.camara', 'panico.activar', 'panico.ver', 'panico.atender', 'rondas.patrullar']));
equal('supervisor', legacyOn('supervisor'), sorted(['usuarios.ver', 'guardias.crear', 'panico.activar', 'panico.ver', 'panico.atender', 'rondas.ver', 'rondas.gestionar', 'rondas.patrullar']));
equal('auditor', legacyOn('auditor'), sorted(['usuarios.ver', 'mensajes.historial', 'visitas.ver', 'garita.camara', 'panico.ver', 'finanzas.ver', 'rondas.ver', 'auditoria.ver', 'auditoria.exportar']));
equal('vecino', legacyOn('vecino'), sorted(['vecino.visitas', 'vecino.vehiculos', 'panico.activar']));
yes('recibir mensajes es de todos los roles que ya los leian', ['admin', 'policia', 'supervisor', 'auditor', 'vecino', 'operador'].every((r) => P.has(r, {}, 'mensajes.recibir')));
yes('el auditor sigue siendo solo lectura (ningun privilegio de escritura)',
    !keysOn('auditor').some((k) => /\.(crear|editar|eliminar|gestionar|enviar|usar|atender|patrullar|operar|activar|privilegios|codigos|registrar|anular|resolver|asignar|reportar|iniciar|terminar|marcar|rastrear|cancelar|ingreso|verificar|deshacer|limpiar|finiquitar|corregir|estado|pago|compartir|quitar|temporal)$/.test(k)));
yes('solo el admin asigna privilegios por defecto', P.ROLES.filter((r) => P.has(r, {}, 'usuarios.privilegios')).join() === 'admin');
equal('sin privilegios asignados el efectivo es el del rol', P.effective('policia', undefined), P.effective('policia', {}));
equal('un campo vacio o invalido no cambia nada', keysOn('policia', { 'no.existe': true, 'garita.operar': 'si', 'usuarios.ver': null }), keysOn('policia'));
yes('el master lo tiene todo', P.KEYS.every((k) => P.has('master', undefined, k)));

// Destinos del login: iguales a los de siempre
equal('admin va a admin.html', P.landing('admin', {}), 'admin.html');
equal('policia va a garita.html', P.landing('policia', {}), 'garita.html');
equal('supervisor va a rondin/', P.landing('supervisor', {}), 'rondin/');
equal('auditor va a auditor.html', P.landing('auditor', {}), 'auditor.html');
equal('vecino va a vecino.html', P.landing('vecino', {}), 'vecino.html');
equal('operador sin privilegios no va a ninguna parte', P.landing('operador', {}), null);

// ───────── Sobrescrituras por usuario ─────────
console.log('\nSobrescrituras por usuario');
equal('agregar un privilegio', P.has('policia', { 'finanzas.ver': true }, 'finanzas.ver'), true);
equal('quitar un privilegio del rol', P.has('admin', { 'finanzas.usar': false }, 'finanzas.usar'), false);
equal('lo demas no cambia al quitar uno', P.has('admin', { 'finanzas.usar': false }, 'usuarios.crear'), true);
equal('toOverrides guarda solo las diferencias', P.toOverrides('admin', keysOn('admin').filter((k) => k !== 'finanzas.usar')), { 'finanzas.usar': false });
equal('toOverrides de un conjunto igual al rol es vacio', P.toOverrides('policia', keysOn('policia')), {});
const withKids = (...list) => list.flatMap((k) => [k, ...P.descendantsOf(k)]);
equal('toOverrides del operador son sus paraguas (las acciones vienen con el)', P.toOverrides('operador', withKids('garita.operar', 'usuarios.ver', 'mensajes.recibir')), { 'usuarios.ver': true, 'garita.operar': true });
equal('el operador que no recibe mensajes lo guarda como false (los recibe por defecto)', P.toOverrides('operador', withKids('garita.operar', 'usuarios.ver')), { 'usuarios.ver': true, 'mensajes.recibir': false, 'garita.operar': true });
equal('toOverrides guarda una accion apagada como false', P.toOverrides('operador', ['usuarios.ver', 'garita.operar', 'mensajes.recibir']),
    { 'usuarios.ver': true, 'usuarios.contacto': false, 'usuarios.pagos_ver': false, 'garita.operar': true, 'garita.escanear': false, 'garita.verificar': false, 'garita.ingreso': false, 'garita.visitas_dia': false, 'garita.morosos': false });
equal('toOverrides acepta un mapa', P.toOverrides('operador', { 'garita.operar': true, 'usuarios.ver': false, 'mensajes.recibir': true }),
    { 'garita.operar': true, 'garita.escanear': false, 'garita.verificar': false, 'garita.ingreso': false, 'garita.visitas_dia': false, 'garita.morosos': false });
{
    const wanted = new Set();
    P.toggle(wanted, 'usuarios.ver', true, { children: true });
    P.toggle(wanted, 'mensajes.enviar', true, { children: true });
    equal('ida y vuelta: las diferencias reproducen el conjunto', sorted(keysOn('auditor', P.toOverrides('auditor', wanted))), sorted([...wanted]));
}
yes('ida y vuelta de cada plantilla del sistema: las diferencias reproducen exactamente su conjunto', P.TEMPLATES.every((t) => {
    const wanted = new Set(P.templateKeys(t));
    const got = keysOn(t.role, P.toOverrides(t.role, wanted));
    // lo que da el rol por defecto (p. ej. recibir mensajes) viene aparte de la plantilla
    return sorted(got.filter((k) => !P.defaultsOf(t.role)[k] || wanted.has(k))).join() === sorted([...wanted]).join();
}));
equal('cleanOverrides descarta claves ajenas y valores que no son booleanos', P.cleanOverrides({ 'garita.operar': false, otra: true, 'usuarios.ver': 1 }), { 'garita.operar': false });

// toOverrides acepta un Set (el editor de privilegios le pasa un Set: un error aqui borraba los privilegios al guardar)
equal('toOverrides con un Set', P.toOverrides('operador', new Set(withKids('usuarios.ver', 'garita.operar', 'mensajes.recibir'))), { 'usuarios.ver': true, 'garita.operar': true });
equal('toOverrides con un Set igual al rol es vacio', P.toOverrides('policia', new Set(keysOn('policia'))), {});
equal('toOverrides con Set, arreglo y mapa dan lo mismo', [P.toOverrides('auditor', new Set(['usuarios.ver'])), P.toOverrides('auditor', { 'usuarios.ver': true })], [P.toOverrides('auditor', ['usuarios.ver']), P.toOverrides('auditor', ['usuarios.ver'])]);
equal('toOverrides no guarda acciones de un paraguas que no se muestra', P.toOverrides('operador', ['rondas.panel_ver', 'mensajes.recibir']), {});

// Privilegios que solo pueden tener ciertos roles
yes('usuarios.privilegios solo es para administradores y operadores', JSON.stringify(P.itemOf('usuarios.privilegios').onlyRoles) === JSON.stringify(['admin', 'operador']));
equal('un guardia no puede tener usuarios.privilegios aunque se lo pongan', P.has('policia', { 'usuarios.privilegios': true }, 'usuarios.privilegios'), false);
equal('un operador si', P.has('operador', { 'usuarios.privilegios': true }, 'usuarios.privilegios'), true);
equal('toOverrides descarta lo que el rol no puede tener', P.toOverrides('policia', [...keysOn('policia'), 'usuarios.privilegios', 'plantillas.gestionar']), {});
equal('allowedFor', [P.allowedFor('usuarios.privilegios', 'vecino'), P.allowedFor('usuarios.privilegios', 'admin'), P.allowedFor('garita.operar', 'vecino'), P.allowedFor('no.existe', 'admin'), P.allowedFor('plantillas.gestionar', 'policia')], [false, true, true, false, false]);
equal('una clave heredada del prototipo no existe', [P.itemOf('constructor'), P.itemOf('__proto__'), P.cleanOverrides({ constructor: true })], [null, null, {}]);

// Dependencias
const set = new Set();
P.toggle(set, 'finanzas.usar', true);
equal('activar finanzas.usar activa lo que necesita', sorted([...set]), sorted(['finanzas.usar', 'finanzas.ver', 'usuarios.ver']));
P.toggle(set, 'usuarios.ver', false);
equal('quitar usuarios.ver quita lo que depende de el', [...set], ['finanzas.ver']);
const acciones = new Set();
P.toggle(acciones, 'finanzas.reportes_libro', true);
equal('activar una accion activa su paraguas y lo que necesita', sorted([...acciones]), sorted(['finanzas.reportes_libro', 'finanzas.usar', 'finanzas.ver', 'usuarios.ver']));
P.toggle(acciones, 'finanzas.usar', false);
equal('quitar el paraguas quita sus acciones (y deja lo que necesitaba)', sorted([...acciones]), sorted(['finanzas.ver', 'usuarios.ver']));
const todo = new Set();
P.toggle(todo, 'finanzas.usar', true, { children: true });
equal('activar el paraguas con { children: true } trae todas sus acciones', P.descendantsOf('finanzas.usar').every((k) => todo.has(k)), true);
const sin = new Set(todo);
P.toggle(sin, 'finanzas.residentes_ver', false);
equal('quitar una accion quita las que la necesitan (ver residentes)', ['finanzas.residentes_datos', 'finanzas.residentes_crear', 'finanzas.cuotas_mes'].map((k) => sin.has(k)), [false, false, false]);
equal('expandTemplate amplia una plantilla vieja (solo paraguas) con todas sus acciones', sorted(P.expandTemplate(['usuarios.ver', 'finanzas.usar', 'finanzas.ver'])), sorted([...withKids('usuarios.ver'), 'finanzas.ver', ...withKids('finanzas.usar')]));
equal('expandTemplate respeta una plantilla que ya nombra acciones', sorted(P.expandTemplate(['finanzas.usar', 'finanzas.pagos_registrar'])), sorted(['finanzas.usar', 'finanzas.pagos_registrar']));
equal('cascade avisa que se activaria', sorted(P.cascade(new Set(), 'garita.operar', true)), sorted(['usuarios.ver', 'visitas.ver', 'vehiculos.ver']));

// ───────── Paginas ─────────
console.log('\nPaginas');
const secretaria = P.templateById('sys-secretaria');
const secOverrides = P.toOverrides(secretaria.role, secretaria.claves);
equal('la secretaria entra a administracion', P.landing('operador', secOverrides), 'admin.html');
equal('el contador entra a finanzas', P.landing('operador', P.toOverrides('operador', P.templateById('sys-contador').claves)), 'finanzas.html');
equal('el garitero entra a la garita', P.landing('operador', P.toOverrides('operador', P.templateById('sys-garitero').claves)), 'garita.html');
equal('un admin sin panel cae en la garita', P.landing('admin', { 'usuarios.panel': false }), 'garita.html');
equal('un guardia sin garita cae en rondas', P.landing('policia', { 'garita.operar': false }), 'rondin/');
equal('un guardia sin garita ni rondas no tiene a donde ir', P.landing('policia', { 'garita.operar': false, 'rondas.patrullar': false }), null);
equal('las paginas de un admin empiezan por la suya', P.pagesFor('admin', {})[0].page, 'admin.html');
equal('un vecino solo tiene su panel', P.pagesFor('vecino', {}).map((p) => p.page), ['vecino.html']);
equal('un vecino con privilegios extra sigue empezando por su panel', P.pagesFor('vecino', { 'garita.operar': true }).map((p) => p.page), ['vecino.html', 'garita.html']);
equal('quien tiene privilegios de varias paginas las ve todas (admin)', P.pagesFor('admin', {}).map((p) => p.page), ['admin.html', 'garita.html', 'finanzas.html', 'rondin/']);

// ───────── Plantillas ─────────
console.log('\nPlantillas del sistema');
yes('cada plantilla tiene nombre, rol valido y claves existentes', P.TEMPLATES.every((t) => t.id && t.name && P.ROLES.includes(t.role) && t.claves.every((k) => P.KEYS.includes(k))));
yes('las plantillas del sistema estan marcadas como tales', P.TEMPLATES.every((t) => t.system === true));
yes('cada plantilla trae el paraguas de cada accion que nombra', P.TEMPLATES.every((t) => t.claves.every((k) => !P.itemOf(k).parent || t.claves.includes(P.itemOf(k).parent))));
yes('ninguna plantilla de operador trae privilegios que un operador no puede tener', P.TEMPLATES.filter((t) => t.role === 'operador').every((t) => t.claves.every((k) => P.allowedFor(k, 'operador'))));
yes('hay plantillas de Sistema Financiero y de rondas', ['sys-cajero', 'sys-auditor-financiero', 'sys-vigilancia-consulta'].every((id) => P.templateById(id)));
yes('el cajero cobra pagos pero no anula ni ve la configuracion', (() => { const k = P.templateById('sys-cajero').claves; return k.includes('finanzas.pagos_registrar') && !k.includes('finanzas.pagos_anular') && !k.some((x) => x.startsWith('finanzas.config')); })());
yes('el auditor financiero no escribe nada', P.templateById('sys-auditor-financiero').claves.every((k) => !/(_registrar|_crear|_editar|_anular|_eliminar|_finiquitar|_corregir|_general|_cuota|_conceptos|deshacer|limpiar|cuotas_)/.test(k)));
{
    const fiscal = P.templateById('sys-fiscalizador');
    const ov = P.toOverrides('vecino', P.templateKeys(fiscal));
    const has = (k) => P.has('vecino', ov, k);
    equal('el fiscalizador es una plantilla de vecino: el vecino sigue siendo vecino', [fiscal.role, fiscal.system, P.landing('vecino', ov)], ['vecino', true, 'vecino.html']);
    yes('el fiscalizador conserva todo lo de su panel de vecino (visitas, vehiculos, contactos, pánico, mensajes)', P.ITEMS.filter((i) => i.defaultRoles.includes('vecino')).every((i) => has(i.key)));
    equal('ademas abre la auditoria y el Sistema Financiero', P.pagesFor('vecino', ov).map((p) => p.page), ['vecino.html', 'auditor.html', 'finanzas.html']);
    yes('todas las claves de la plantilla son validas para un vecino (ninguna queda sin efecto)', P.templateKeys(fiscal).every((k) => has(k)));
    equal('el fiscalizador no escribe nada ni asigna privilegios', ['usuarios.crear', 'usuarios.editar', 'usuarios.eliminar', 'usuarios.codigos', 'usuarios.privilegios', 'guardias.crear', 'mensajes.enviar', 'visitas.gestionar', 'vehiculos.crear', 'finanzas.pagos_registrar', 'finanzas.egresos_registrar', 'finanzas.cargos_crear', 'finanzas.cuotas_mes', 'finanzas.config_cuota', 'finanzas.config_general', 'finanzas.residentes_crear', 'finanzas.residentes_editar', 'finanzas.deshacer', 'finanzas.limpiar', 'rondas.ver', 'garita.operar'].filter(has), []);
    equal('el fiscalizador no ve datos personales en pantalla ni contactos de emergencia', ['usuarios.contacto', 'finanzas.residentes_datos', 'finanzas.residentes_contactar', 'panico.contactos', 'auditoria.exportar_usuarios'].filter(has), []);
    yes('un vecino sin la plantilla no abre ningun panel de reportes', P.pagesFor('vecino', {}).map((p) => p.page).join() === 'vecino.html');
}
yes('la plantilla de vigilancia de consulta no administra ni patrulla', P.templateById('sys-vigilancia-consulta').claves.every((k) => !/(gestionar|patrullar|_crear|_editar|_eliminar|_atender|_resolver|_operar|_registrar|_asignar)/.test(k)));
yes('los ids de las plantillas no se repiten', new Set(P.TEMPLATES.map((t) => t.id)).size === P.TEMPLATES.length);
yes('cada plantilla cumple sus dependencias', P.TEMPLATES.every((t) => t.claves.every((k) => (P.itemOf(k).requires || []).every((r) => t.claves.includes(r)))));
yes('toda plantilla de operador deja entrar a alguna pagina', P.TEMPLATES.filter((t) => t.role === 'operador').every((t) => P.landing('operador', P.toOverrides('operador', t.claves))));
yes('el administrador delegado no asigna privilegios', !P.templateById('sys-admin-delegado').claves.includes('usuarios.privilegios'));
yes('el administrador sin finanzas no tiene finanzas', !P.templateById('sys-admin-sin-finanzas').claves.some((k) => k.startsWith('finanzas.')));
equal('buscar una plantilla propia', P.templateById('mia', [{ id: 'mia', name: 'Mia' }]).name, 'Mia');

// ───────── Reglas de Firestore ─────────
console.log('\nReglas de Firestore');
const rules = read('firestore.rules');
const camel = (key) => 'p' + key.split('.').map((x) => x.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')).join('');
// Paraguas: can(c, 'clave', [roles]); acciones: pPadre(c) && childOk(c, 'clave')
const rootWrappers = [...rules.matchAll(/function (p[A-Z]\w*)\(c\) \{ return can\(c, '([a-z._]+)', \[([^\]]*)\]\); \}/g)]
    .map((m) => ({ fn: m[1], key: m[2], roles: m[3].split(',').map((r) => r.trim().replace(/'/g, '')).filter(Boolean) }));
const childWrappers = [...rules.matchAll(/function (p[A-Z]\w*)\(c\) \{ return (p[A-Z]\w*)\(c\) && childOk\(c, '([a-z._]+)'\); \}/g)]
    .map((m) => ({ fn: m[1], parentFn: m[2], key: m[3] }));
const wrappers = [...rootWrappers, ...childWrappers];
const used = (fn) => (rules.match(new RegExp(`\\b${fn}\\(`, 'g')) || []).length;
yes('las reglas definen can(condoId, clave, roles) y childOk(condoId, clave)', /function can\(condoId, key, roles\)/.test(rules) && /function childOk\(condoId, key\)/.test(rules));
yes('can() lee el mapa privilegios del documento del usuario', /memberDoc\(condoId\)\.get\('privilegios', \{\}\)\.get\(key, memberRole\(condoId\) in roles\) == true/.test(rules));
yes('childOk() deja pasar una accion salvo que este apagada (false) en el documento del usuario', /function childOk\(condoId, key\) \{[\s\S]*?get\(key, true\) == true/.test(rules));
yes('cada funcion pXxx usa el nombre de su clave', wrappers.every((w) => w.fn === camel(w.key)));
yes('cada clave de las reglas existe en el catalogo', wrappers.every((w) => P.KEYS.includes(w.key)));
yes('los roles por defecto de las reglas son los del catalogo', rootWrappers.every((w) => JSON.stringify(sorted(w.roles)) === JSON.stringify(sorted(P.itemOf(w.key).roles))));
yes('solo los paraguas llevan roles en las reglas; cada accion usa a su paraguas', rootWrappers.every((w) => !P.itemOf(w.key).parent) && childWrappers.every((w) => P.itemOf(w.key).parent && camel(P.itemOf(w.key).parent) === w.parentFn));
yes('toda clave que dice garantizarse por reglas tiene su funcion en las reglas', P.ITEMS.filter((i) => i.enforce === 'reglas').every((i) => wrappers.some((w) => w.key === i.key)));
yes('toda clave sin funcion en las reglas es solo de pantalla', P.KEYS.filter((k) => !wrappers.some((w) => w.key === k)).every((k) => P.itemOf(k).enforce === 'pantalla'));
const serverSrc = ['functions/src/auth.js', 'functions/src/index.js', 'functions/src/rondas.js'].map((f) => { try { return read(f); } catch { return ''; } }).join('\n');
yes('toda funcion de una accion de reglas se usa en alguna regla o la clave la aplica el servidor', childWrappers.every((w) => used(w.fn) > 1 || serverSrc.includes(`'${w.key}'`)));
yes('todo paraguas con funcion se usa en alguna regla o en la de una accion', rootWrappers.every((w) => used(w.fn) > 1));
yes('las reglas ya no preguntan por el rol del usuario para dar acceso (isAdmin, isStaff...)', !/\b(isAdmin|isStaff|isGuard|isSupervisor|isAuditor)\(/.test(rules));
yes('los roles validos de usuarios incluyen al operador', /role in \['vecino', 'policia', 'admin', 'auditor', 'supervisor', 'operador'\]/.test(rules));
yes('con usuarios.crear solo se crean vecinos; guardias con guardias.crear; los demas roles exigen asignar privilegios',
    /role == 'vecino' && pUsuariosCrear\(c\)/.test(rules) && /role == 'policia' && \(pGuardiasCrear\(c\) \|\| \(pUsuariosCrear\(c\) && pUsuariosPrivilegios\(c\)\)\)/.test(rules)
    && /role in \['auditor', 'supervisor', 'admin', 'operador'\] && pUsuariosCrear\(c\) && pUsuariosPrivilegios\(c\)/.test(rules));
yes('quien ve codigos no ve los de administradores y operadores sin asignar privilegios', /pUsuariosCodigos\(resource\.data\.condominioId\)\s*&& \(pUsuariosPrivilegios\(resource\.data\.condominioId\) \|\| resource\.data\.role in \['vecino', 'policia', 'auditor', 'supervisor'\]\)/.test(rules));
yes('borrar codigos exige poder manejar a ese rol', /\(pUsuariosCodigos\(resource\.data\.condominioId\) \|\| pUsuariosEliminar\(resource\.data\.condominioId\)\)\s*&& manageable\(resource\.data\.condominioId, resource\.data\.role\)/.test(rules));
yes('usuarios.privilegios solo lo puede tener un administrador u operador', /get\('usuarios\.privilegios', false\) != true\s*\|\| request\.resource\.data\.role in \['admin', 'operador'\]/.test(rules));
yes('usuarios.eliminar solo borra visitas, vehiculos y expedientes de un usuario que deja de existir', (rules.match(/pUsuariosEliminar\(condoId\) && ownerGone\(/g) || []).length === 4 && /!existsAfter\(/.test(rules));
yes('el master tambien maneja las plantillas de privilegios', /isMaster\(\) \|\| pPlantillasGestionar\(condoId\)\) && request\.resource\.data\.condominioId == condoId/.test(rules) && /allow read: if isMaster\(\) \|\| pUsuariosPrivilegios\(condoId\);/.test(rules));
yes('nadie se cambia sus propios privilegios', /pUsuariosPrivilegios\(condoId\) && userId != request\.auth\.uid/.test(rules));
yes('un codigo nuevo solo apunta a un usuario que se crea en la misma escritura (salvo usuarios.codigos)', /newUserCode\(\)/.test(rules) && /pUsuariosCodigos\(c\) && manageable\(c, codeTargetRole\(\)\)/.test(rules));
yes('el mapa de privilegios de un usuario admite hasta 300 claves (un operador estrecho guarda cerca de cien en false)', /privilegios\.size\(\) <= 300/.test(rules));
// El bloque de funciones pXxx lo genera scripts/generar-reglas-privilegios.mjs: no se edita a mano
let generated = 'fallo';
try { execFileSync('node', [new URL('./generar-reglas-privilegios.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' }); generated = 'ok'; } catch (e) { generated = String(e.stdout || e.message); }
equal('el bloque de privilegios de las reglas esta al dia con el catalogo (npm run reglas)', generated, 'ok');
// La tabla de privilegios del README tambien se genera del catalogo
let tableState = 'fallo';
try { execFileSync('node', [new URL('./generar-tabla-privilegios.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' }); tableState = 'ok'; } catch (e) { tableState = String(e.stderr || e.message); }
equal('la tabla de privilegios del README esta al dia con el catalogo (node scripts/generar-tabla-privilegios.mjs)', tableState, 'ok');
// Finanzas y Rondas: cada operacion tiene su privilegio en las reglas
yes('Finanzas: cada tipo de movimiento exige su privilegio', ['pFinanzasPagosRegistrar', 'pFinanzasEgresosRegistrar', 'pFinanzasCargosCrear', 'pFinanzasCuotasMes', 'pFinanzasCuotasMeses'].every((fn) => used(fn) > 1));
yes('Finanzas: anular y deshacer son privilegios aparte', ['pFinanzasPagosAnular', 'pFinanzasEgresosAnular', 'pFinanzasCargosAnular', 'pFinanzasCuotasCorregir', 'pFinanzasDeshacer'].every((fn) => used(fn) > 1));
yes('Finanzas: configuracion separada en cuota, datos generales y conceptos', ['pFinanzasConfigCuota', 'pFinanzasConfigGeneral', 'pFinanzasConfigConceptos'].every((fn) => used(fn) > 1));
yes('Finanzas: finiquitar y eliminar residentes son privilegios aparte', used('pFinanzasResidentesFiniquitar') > 1 && used('pFinanzasResidentesEliminar') > 1);
yes('Finanzas: nada se borra, OIKOS anula', (rules.match(/match \/finanzas_(residentes|movimientos|config)\/\{docId\} \{[\s\S]*?allow delete: if false;/g) || []).length === 3);
yes('Rondas: rutas, puntos, asignaciones, alertas, incidentes, drones y patrulla tienen su privilegio', ['pRondasRutasCrear', 'pRondasPuntosCrear', 'pRondasAsignacionesCrear', 'pRondasAlertasAtender', 'pRondasIncidentesResolver', 'pRondasDronesOperar', 'pRondasPatrullaIniciar', 'pRondasPatrullaMarcar', 'pRondasPatrullaRastrear'].every((fn) => used(fn) > 1));
yes('Rondas: ver el mapa en vivo y el historial de ubicaciones son privilegios aparte', used('pRondasMonitoreoVer') > 1 && used('pRondasMonitoreoHistorial') > 1);

// ───────── Paginas y modulos ─────────
console.log('\nPaginas y modulos');
const guard = (file, page) => yes(`${file} pide el privilegio de ${page}`, new RegExp(`requireAuth\\(\\[[^\\]]*\\], '${page.replace('/', '\\/')}'\\)`).test(read(file)));
guard('admin.html', 'admin.html');
guard('garita.html', 'garita.html');
guard('auditor.html', 'auditor.html');
guard('finanzas.html', 'finanzas.html');
guard('vecino.html', 'vecino.html');
yes('master.html sigue entrando por rol', /requireAuth\(\[SISDEL\.ROLES\.MASTER\]\)/.test(read('master.html')));
const sisdelApi = read('rondin/js/sisdel-api.js');
yes('RONDIN decide por privilegios y no por rol', /rondas\.gestionar/.test(sisdelApi) && /rondas\.patrullar/.test(sisdelApi) && !/\['admin', 'supervisor', 'auditor'\]\.includes\(myRole\(\)\)/.test(sisdelApi));
for (const file of ['index.html', 'admin.html', 'garita.html', 'auditor.html', 'vecino.html', 'master.html', 'finanzas.html', 'rondin/index.html']) {
    const html = read(file);
    const core = html.match(/sisdel-core\.js\?v=(\d+[a-z]*)/);
    const cat = html.match(/privilegios\.js\?v=(\d+[a-z]*)/);
    yes(`${file} carga privilegios.js antes que sisdel-core.js y con la misma version`, core && cat && cat[1] === core[1] && html.indexOf('privilegios.js') < html.indexOf('sisdel-core.js'));
}
yes('admin.html carga la pantalla de privilegios', /privilegios-ui\.js/.test(read('admin.html')));
{
    // Configuracion: boton en el encabezado y vista con Usuarios, Privilegios y Plantillas (como en MULTISYS)
    const admin = read('admin.html');
    const ui = read('privilegios-ui.js');
    yes('admin.html tiene el boton Configuracion con icono SVG y sin emojis', /id="btnConfig"[\s\S]*?<svg[\s\S]*?Configuración\s*<\/button>/.test(admin));
    yes('la vista Configuracion tiene sus tres pestanas', ['usuarios', 'privilegios', 'plantillas'].every((t) => new RegExp(`data-cfg="${t}"`).test(admin)) && /id="viewConfig"/.test(admin));
    yes('el panel de siempre queda aparte de la vista Configuracion', /<div id="panelMain">/.test(admin) && /<\/div><!-- \/panelMain -->/.test(admin));
    yes('las pestanas del panel y las de Configuracion no se mezclan', !/querySelectorAll\('\.tab'\)/.test(admin) && (admin.match(/querySelectorAll\('#mainTabs \.tab'\)/g) || []).length === 2);
    const shown = (admin.match(/SISDEL\.canAny\(\[('usuarios\.[a-z]+'(?:, )?)+\]\)/) || [''])[0].match(/usuarios\.[a-z]+/g) || [];
    equal('el boton Configuracion lo ve quien tenga algun paraguas usuarios.* (las acciones cuelgan de ellos)', sorted(shown), sorted(P.ITEMS.filter((i) => i.key.startsWith('usuarios.') && !i.parent).map((i) => i.key)));
    yes('la vista se abre por direccion (#configuracion/pestana)', /#configuracion\(\?:\\\/\(usuarios\|privilegios\|plantillas\)\)\?\$/.test(admin) && /hashchange/.test(admin));
    yes('Configuracion reutiliza la lista, Agregar Usuario y el editor (sin duplicarlos)', /async function openNewUser\(\)/.test(admin) && /btnCfgNewUser'\)\.addEventListener\('click', openNewUser\)/.test(admin)
        && /mountPrivilegesTab\(/.test(admin) && /mountTemplatesTab\(/.test(admin) && (admin.match(/const userRow = /g) || []).length === 1);
    yes('Configuracion sin privilegios usuarios.privilegios queda en solo lectura', /readOnly: !caps\.privilegios/.test(admin) && /canManage: caps\.privilegios/.test(admin));
    yes('privilegios-ui.js ofrece el editor en linea, la ventana y las pestanas', /return \{ renderMatrix, mountEditor, openEditor, mountPrivilegesTab, mountTemplatesTab,/.test(ui));
    yes('la ventana del escudo usa el mismo editor en linea', /const editor = mountEditor\(overlay\.querySelector/.test(ui));
    yes('Marcar todos y Limpiar en el editor y en las plantillas', (ui.match(/data-act="all">Marcar todos/g) || []).length >= 2 && (ui.match(/data-act="none">Limpiar/g) || []).length >= 2);
    yes('las plantillas del sistema son de solo lectura y se duplican', /Duplicar como plantilla propia/.test(ui) && /Plantillas del sistema|Plantilla del sistema: solo se puede ver/.test(ui));
    yes('privilegios-ui.js sube de version en admin.html y master.html por igual', (() => {
        const a = admin.match(/privilegios-ui\.js\?v=(\w+)/); const m = read('master.html').match(/privilegios-ui\.js\?v=(\w+)/);
        return a && m && a[1] === m[1];
    })());
}
yes('el servidor pide garita.verificar para verificar codigos', /has\(me\.data\(\)\.role, me\.data\(\)\.privilegios, 'garita\.verificar'\)/.test(read('functions/src/auth.js')));
yes('el login decide el destino con el catalogo', /privilegios\.landing\(user\.role, user\.privilegios\)/.test(read('functions/src/auth.js')));

// ───────── Sintaxis de las paginas y modulos ─────────
console.log('\nSintaxis');
const syntaxOk = (name, code) => { try { new vm.Script(code, { filename: name }); return true; } catch (e) { console.log(`    ${name}: ${e.message}`); return false; } };
for (const file of ['sisdel-core.js', 'privilegios.js', 'privilegios-ui.js', 'rondin/js/sisdel-api.js', 'rondin/js/privilegios-rondin.js', 'finanzas-sync.js', 'finanzas-bloqueo.js', 'panico-alertas.js', 'rondas-core.js']) {
    yes(`${file} no tiene errores de sintaxis`, syntaxOk(file, read(file)));
}
for (const file of ['index.html', 'admin.html', 'garita.html', 'auditor.html', 'vecino.html', 'master.html', 'finanzas.html']) {
    const inline = [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    yes(`${file}: sus scripts no tienen errores de sintaxis`, inline.length > 0 && inline.every((code, i) => syntaxOk(`${file}#${i}`, code)));
}
yes('master.html carga la pantalla de privilegios', /privilegios-ui\.js/.test(read('master.html')));

// Sistema Financiero y RONDIN: los bloqueos de pantalla estan cargados y conectados
console.log('\nBloqueos de Finanzas y Rondas');
{
    const fin = read('finanzas.html');
    const ver = (html, file) => (html.match(new RegExp(file.replace('.', '\\.') + '\\?v=(\\w+)')) || [])[1];
    yes('finanzas.html carga finanzas-bloqueo.js y finanzas-sync.js con la misma version', ver(fin, 'finanzas-bloqueo.js') && ver(fin, 'finanzas-bloqueo.js') === ver(fin, 'finanzas-sync.js'));
    yes('finanzas.html carga el bloqueo antes de usarlo', fin.indexOf('finanzas-bloqueo.js') > 0 && fin.indexOf('finanzas-bloqueo.js') < fin.indexOf('SisdelFinanzasBloqueo.install'));
    yes('finanzas.html aplica los privilegios al cargar OIKOS y oculta el iframe hasta entonces', /SisdelFinanzasBloqueo\.install\(mounted\.contentWindow, \(key\) => SISDEL\.can\(key\)\)/.test(fin) && /iframe\.classList\.add\('pendiente'\)/.test(fin) && /visibility: hidden/.test(fin));
    yes('finanzas.html le pasa los privilegios a la sincronizacion', /can: \(key\) => SISDEL\.can\(key\)/.test(fin) && /onBlocked:/.test(fin));
    const sync = read('finanzas-sync.js');
    yes('la sincronizacion filtra cada subida con los privilegios (push pasa por gate)', /items = gate\(kind, items\);/.test(sync) && /function revertRejected\(/.test(sync));
    yes('las cuotas automaticas rechazadas no avisan (no son una accion del usuario)', /item\.type === 'charge' && item\.auto === true/.test(sync));
    const bloqueo = read('finanzas-bloqueo.js');
    yes('el bloqueo de OIKOS dice que es de pantalla y que las reglas son la barrera real', /no seguridad/.test(bloqueo) && /firestore\.rules/.test(bloqueo));
    yes('el modulo de RONDIN se carga antes que el adaptador, con la misma version', (() => { const h = read('rondin/index.html'); return h.indexOf('privilegios-rondin.js') > 0 && h.indexOf('privilegios-rondin.js') < h.indexOf('sisdel-api.js') && ver(h, 'privilegios-rondin.js') === ver(h, 'sisdel-api.js'); })());
    yes('app.js, style.css, i18n.js de RONDIN y finanzas/ siguen sin tocar respecto a main', (() => {
        try {
            const out = execFileSync('git', ['diff', '--stat', 'main', '--', 'rondin/js/app.js', 'rondin/css/style.css', 'rondin/js/i18n.js', 'finanzas/'], { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8' });
            return out.trim() === '';
        } catch { return true; }
    })());
}

// ───────── Nucleo de SISDEL (sisdel-core.js) con un navegador y una base simulados ─────────
console.log('\nNucleo de SISDEL');
const CONDO = 'condo-1';
function makeCore({ session, authUid, docs = {}, failWith = null }) {
    const store = new Map();
    if (session) store.set('sisdel_session', JSON.stringify(session));
    const updates = [];
    const sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const window = { location: { href: '' }, SisdelPrivilegios: P };
    const authUser = authUid ? { uid: authUid } : null;
    const docRef = (path) => ({
        id: path.split('/').pop(), parent: { parent: { id: CONDO } },
        get: async () => {
            if (failWith) throw failWith;
            return docs[path] ? { exists: true, id: path.split('/').pop(), data: () => docs[path], ref: docRef(path) } : { exists: false };
        },
        update: async (changes) => { updates.push({ path, changes }); },
        collection: (name) => ({ doc: (id) => docRef(`${path}/${name}/${id}`) })
    });
    window.sisdelFirebase = {
        auth: { onAuthStateChanged: (cb) => { Promise.resolve().then(() => cb(authUser)); return () => {}; }, currentUser: authUser },
        db: { collection: (name) => ({ doc: (id) => docRef(`${name}/${id}`) }) }
    };
    const ctx = vm.createContext({
        window, sessionStorage, localStorage: {}, performance: { now: () => 0 }, console: { log() {}, warn() {}, error() {} }, setTimeout,
        firebase: { firestore: { FieldValue: { delete: () => '__borrar__' } } }
    });
    vm.runInContext(read('sisdel-core.js'), ctx);
    return { SISDEL: vm.runInContext('SISDEL', ctx), window, store, updates };
}
const sess = (role, privilegios = {}, extra = {}) => ({ role, userId: 'u1', userName: 'Prueba', condominioId: CONDO, condominioName: 'Condo', privilegios, ...extra });
const userDoc = (role, privilegios, extra = {}) => ({ [`condominios/${CONDO}/usuarios/u1`]: { role, name: 'Prueba', active: true, ...(privilegios ? { privilegios } : {}), ...extra } });

let core = makeCore({ session: sess('policia') });
yes('SISDEL expone el catalogo', core.SISDEL.PRIV === P);
yes('un guardia puede operar la garita', core.SISDEL.can('garita.operar'));
yes('un guardia no ve las finanzas', !core.SISDEL.can('finanzas.ver'));
equal('inicio del guardia', core.SISDEL.homePage(), 'garita.html');
equal('otros paneles del guardia', core.SISDEL.otherPanels('garita.html').map((p) => p.page), ['rondin/']);
yes('canAny', core.SISDEL.canAny(['finanzas.ver', 'garita.camara']));
core = makeCore({ session: sess('operador', secOverrides) });
yes('la secretaria puede crear usuarios', core.SISDEL.can('usuarios.crear'));
yes('la secretaria no asigna privilegios', !core.SISDEL.can('usuarios.privilegios'));
equal('inicio de la secretaria', core.SISDEL.homePage(), 'admin.html');
equal('privilegios efectivos de la secretaria (cantidad)', Object.values(core.SISDEL.effectivePrivileges()).filter(Boolean).length, new Set([...secretaria.claves, ...Object.keys(P.defaultsOf('operador'))]).size);
core = makeCore({ session: { role: 'master' } });
yes('el master lo puede todo', core.SISDEL.can('usuarios.privilegios') && core.SISDEL.can('finanzas.usar'));
equal('inicio del master', core.SISDEL.homePage(), 'master.html');
equal('el master no tiene paneles de condominio', core.SISDEL.otherPanels('x'), []);
core = makeCore({ session: null });
yes('sin sesion no puede nada', !core.SISDEL.can('usuarios.ver'));
equal('sin sesion el inicio es el login', core.SISDEL.homePage(), 'index.html');

// Un vecino con la plantilla de fiscalizador ve botones hacia sus paneles de reportes y puede volver a su panel
{
    const fiscalOv = P.toOverrides('vecino', P.templateKeys(P.templateById('sys-fiscalizador')));
    const c = makeCore({ session: sess('vecino', fiscalOv) });
    equal('fiscalizador: desde su panel ve los de reportes', c.SISDEL.otherPanels('vecino.html').map((p) => p.page), ['auditor.html', 'finanzas.html']);
    equal('fiscalizador: desde la auditoria puede volver a su panel', c.SISDEL.otherPanels('auditor.html').map((p) => p.page), ['vecino.html', 'finanzas.html']);
    equal('fiscalizador: su inicio sigue siendo su panel de vecino', c.SISDEL.homePage(), 'vecino.html');
    equal('un vecino de siempre no tiene otros paneles', makeCore({ session: sess('vecino') }).SISDEL.otherPanels('vecino.html'), []);
    equal('los demas roles no cambian: la garita sigue ofreciendo solo rondas al guardia', makeCore({ session: sess('policia') }).SISDEL.otherPanels('garita.html').map((p) => p.page), ['rondin/']);
}

// requireAuth: lee de nuevo el usuario, aplica los privilegios vigentes y manda a cada quien a su pagina
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia') });
let result = await core.SISDEL.requireAuth([], 'garita.html');
yes('el guardia entra a la garita', result && result.role === 'policia' && core.window.location.href === '');
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia', { 'garita.operar': false }) });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('si el administrador le quito la garita, lo manda a rondas', [result, core.window.location.href], [null, 'rondin/']);
equal('la sesion guarda los privilegios nuevos', JSON.parse(core.store.get('sisdel_session')).privilegios, { 'garita.operar': false });
core = makeCore({ session: sess('operador'), authUid: 'u1', docs: userDoc('operador', secOverrides) });
result = await core.SISDEL.requireAuth([], 'admin.html');
yes('un operador con privilegios entra aunque su sesion no los trajera', result && core.SISDEL.can('usuarios.crear'));
core = makeCore({ session: sess('operador', secOverrides), authUid: 'u1', docs: userDoc('operador', secOverrides) });
result = await core.SISDEL.requireAuth([], 'finanzas.html');
equal('la secretaria no entra a finanzas: va a su panel', [result, core.window.location.href], [null, 'admin.html']);
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia', { 'garita.operar': false, 'rondas.patrullar': false }) });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('sin ninguna pagina a la que ir, vuelve al login', [result, core.window.location.href], [null, 'index.html']);
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia', undefined, { active: false }) });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('un usuario desactivado sale', [result, core.window.location.href, core.store.has('sisdel_session')], [null, 'index.html', false]);
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: {} });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('un usuario eliminado sale', [result, core.window.location.href], [null, 'index.html']);
core = makeCore({ session: sess('policia'), authUid: 'otro', docs: userDoc('policia') });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('la sesion debe coincidir con el usuario de Firebase', [result, core.window.location.href], [null, 'index.html']);
core = makeCore({ session: null, authUid: null });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('sin sesion va al login', [result, core.window.location.href], [null, 'index.html']);
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia'), failWith: { code: 'unavailable', message: 'offline' } });
result = await core.SISDEL.requireAuth([], 'garita.html');
yes('sin conexion se sigue con los privilegios del login', result && core.window.location.href === '');
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia'), failWith: { code: 'permission-denied', message: 'x' } });
result = await core.SISDEL.requireAuth([], 'garita.html');
equal('si ya no tiene permiso (usuario o condominio inactivo) sale', [result, core.window.location.href], [null, 'index.html']);
core = makeCore({ session: { role: 'master' }, authUid: 'master' });
result = await core.SISDEL.requireAuth([core.SISDEL.ROLES.MASTER]);
yes('el master entra a su panel', result && result.role === 'master');
core = makeCore({ session: { role: 'master' }, authUid: 'master' });
result = await core.SISDEL.requireAuth([], 'admin.html');
equal('el master no entra a paginas de condominio', [result, core.window.location.href], [null, 'master.html']);
core = makeCore({ session: sess('vecino'), authUid: 'u1', docs: userDoc('vecino') });
result = await core.SISDEL.requireAuth([core.SISDEL.ROLES.MASTER]);
equal('master.html (solo por rol) no deja entrar a un vecino', [result, core.window.location.href], [null, 'index.html']);

// refreshAccess
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia') });
equal('sin cambios', await core.SISDEL.refreshAccess(), { ok: true, changed: false });
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('policia', { 'finanzas.ver': true }) });
equal('con cambios', await core.SISDEL.refreshAccess(), { ok: true, changed: true });
core = makeCore({ session: sess('policia'), authUid: 'u1', docs: userDoc('supervisor') });
equal('un cambio de rol tambien cuenta', (await core.SISDEL.refreshAccess()).changed, true);
core = makeCore({ session: sess('operador', { 'usuarios.ver': true }), authUid: 'u1', docs: userDoc('operador', { 'usuarios.ver': true, 'no.existe': true, 'garita.operar': 'si' }) });
equal('las claves invalidas del documento se descartan', (await core.SISDEL.refreshAccess()).changed, false);

// setUserAccess
core = makeCore({ session: sess('admin'), authUid: 'u1', docs: userDoc('admin') });
equal('setUserAccess guarda solo claves validas y recorta el cargo', await core.SISDEL.setUserAccess('u1', { privilegios: { 'finanzas.ver': true, basura: true }, cargo: '  Contadora  ' }), true);
equal('lo que se escribio', [core.updates[0].changes.privilegios, core.updates[0].changes.cargo, typeof core.updates[0].changes.updatedAt], [{ 'finanzas.ver': true }, 'Contadora', 'string']);
await core.SISDEL.setUserAccess('u1', { privilegios: {} });
equal('sin diferencias se borra el campo (vuelve a los del rol)', core.updates[1].changes.privilegios, '__borrar__');
equal('si no se indica el cargo no se toca', 'cargo' in core.updates[1].changes, false);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
