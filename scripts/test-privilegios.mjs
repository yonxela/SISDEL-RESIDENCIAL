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
equal('hay 151 privilegios: 32 paraguas y 119 acciones', [P.KEYS.length, roots.length, kids.length], [151, 32, 119]);
yes('el boton "Limpiar Base de Datos" de OIKOS, su funcion y su privilegio ya no existen', !P.KEYS.some((k) => (k.key || k) === 'finanzas.limpiar') && !/clearDB|btn-clear/.test(fs.readFileSync(new URL('../finanzas/index.html', import.meta.url), 'utf8')) && !/clearDB|btn-clear|'limpiar'/.test(fs.readFileSync(new URL('../finanzas-bloqueo.js', import.meta.url), 'utf8')));
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
yes('cada rol que tiene un paraguas recibe todas sus acciones (menos las que empiezan apagadas, optIn)', P.ROLES.every((role) => roots.filter((r) => P.has(role, {}, r.key)).every((r) => P.descendantsOf(r.key).every((c) => P.has(role, {}, c) === !P.isOptIn(c)))));
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
equal('las acciones heredan el rol por defecto de su paraguas (las optIn no: empiezan apagadas)', roots.every((r) => P.ROLES.every((role) => P.descendantsOf(r.key).every((k) => P.has(role, {}, k) === (P.has(role, {}, r.key) && !P.isOptIn(k))))), true);

// Acciones que empiezan apagadas (optIn): "Cargar cuotas por mes" (pedido del dueno, 2026-11-16)
console.log('\nAcciones optIn (empiezan apagadas)');
equal('cargar cuotas por mes es optIn y nadie lo trae por defecto (ni el administrador)', [P.isOptIn('finanzas.cuotas_meses'), P.has('admin', {}, 'finanzas.cuotas_meses'), 'finanzas.cuotas_meses' in P.defaultsOf('admin'), P.has('operador', { 'finanzas.usar': true }, 'finanzas.cuotas_meses')], [true, false, false, false]);
equal('marcado en el usuario si lo tiene (con su paraguas), sin el paraguas no', [P.has('admin', { 'finanzas.cuotas_meses': true }, 'finanzas.cuotas_meses'), P.has('operador', { 'finanzas.usar': true, 'finanzas.cuotas_meses': true }, 'finanzas.cuotas_meses'), P.has('admin', { 'finanzas.usar': false, 'finanzas.cuotas_meses': true }, 'finanzas.cuotas_meses')], [true, true, false]);
equal('toOverrides guarda la optIn solo si esta marcada', [P.toOverrides('admin', Object.keys(P.defaultsOf('admin'))), P.toOverrides('admin', [...Object.keys(P.defaultsOf('admin')), 'finanzas.cuotas_meses'])], [{}, { 'finanzas.cuotas_meses': true }]);
equal('effective y toOverrides van y vuelven con la optIn marcada', (() => { const o = { 'finanzas.cuotas_meses': true }; const e = P.effective('admin', o); return P.toOverrides('admin', Object.keys(e).filter((k) => e[k])); })(), { 'finanzas.cuotas_meses': true });
equal('marcarla a mano trae su paraguas y lo que necesita', (() => { const set = new Set(); P.toggle(set, 'finanzas.cuotas_meses', true); return ['finanzas.cuotas_meses', 'finanzas.usar', 'finanzas.residentes_editar'].map((k) => set.has(k)); })(), [true, true, true]);
equal('ninguna plantilla la trae (ni del sistema ni propia)', [P.TEMPLATES.some((t) => P.templateKeys(t).includes('finanzas.cuotas_meses')), P.templateKeys({ system: false, claves: ['finanzas.usar', 'finanzas.cuotas_meses'] }).includes('finanzas.cuotas_meses')], [false, false]);

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
    { 'usuarios.ver': true, 'usuarios.contacto': false, 'usuarios.pagos_ver': false, 'garita.operar': true, 'garita.escanear': false, 'garita.verificar': false, 'garita.ingreso': false, 'garita.salida': false, 'garita.visitas_dia': false, 'garita.morosos': false });
equal('toOverrides acepta un mapa', P.toOverrides('operador', { 'garita.operar': true, 'usuarios.ver': false, 'mensajes.recibir': true }),
    { 'garita.operar': true, 'garita.escanear': false, 'garita.verificar': false, 'garita.ingreso': false, 'garita.salida': false, 'garita.visitas_dia': false, 'garita.morosos': false });
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
equal('activar el paraguas con { children: true } trae todas sus acciones menos las optIn', P.descendantsOf('finanzas.usar').every((k) => todo.has(k) === !P.isOptIn(k)), true);
const sin = new Set(todo);
P.toggle(sin, 'finanzas.residentes_ver', false);
equal('quitar una accion quita las que la necesitan (ver residentes)', ['finanzas.residentes_datos', 'finanzas.residentes_crear', 'finanzas.cuotas_mes'].map((k) => sin.has(k)), [false, false, false]);
equal('expandTemplate amplia una plantilla vieja (solo paraguas) con todas sus acciones (menos las optIn)', sorted(P.expandTemplate(['usuarios.ver', 'finanzas.usar', 'finanzas.ver'])), sorted([...withKids('usuarios.ver'), 'finanzas.ver', ...withKids('finanzas.usar')].filter((k) => !P.isOptIn(k))));
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
const childWrappers = [...rules.matchAll(/function (p[A-Z]\w*)\(c\) \{ return (p[A-Z]\w*)\(c\) && (childOk|childOn)\(c, '([a-z._]+)'\); \}/g)]
    .map((m) => ({ fn: m[1], parentFn: m[2], check: m[3], key: m[4] }));
const wrappers = [...rootWrappers, ...childWrappers];
const used = (fn) => (rules.match(new RegExp(`\\b${fn}\\(`, 'g')) || []).length;
yes('las reglas definen can(condoId, clave, roles) y childOk(condoId, clave)', /function can\(condoId, key, roles\)/.test(rules) && /function childOk\(condoId, key\)/.test(rules));
yes('can() lee el mapa privilegios del documento del usuario', /memberDoc\(condoId\)\.get\('privilegios', \{\}\)\.get\(key, memberRole\(condoId\) in roles\) == true/.test(rules));
yes('childOk() deja pasar una accion salvo que este apagada (false) en el documento del usuario', /function childOk\(condoId, key\) \{[\s\S]*?get\(key, true\) == true/.test(rules));
yes('childOn() deja pasar una accion optIn solo si esta marcada (true) en el documento del usuario', /function childOn\(condoId, key\) \{[\s\S]*?get\(key, false\) == true/.test(rules));
yes('cada accion optIn usa childOn en las reglas y las demas childOk', childWrappers.every((w) => (w.check === 'childOn') === P.isOptIn(w.key)));
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
{
    // Panel de Reportes del administrador (admin.html + reportes-ui.js) y salidas de la garita
    const admin = read('admin.html');
    const rp = read('reportes-ui.js');
    const garita = read('garita.html');
    const core = read('sisdel-core.js');
    const fin = read('finanzas.html');
    const oikos = read('finanzas/index.html');
    yes('admin.html tiene el boton Reportes junto a Configuracion, con icono SVG y sin emojis', /id="btnReports"[\s\S]*?<svg[\s\S]*?Reportes\s*<\/button>\s*<button class="btn btn-ghost btn-sm" id="btnConfig"/.test(admin));
    yes('la vista Reportes vive aparte del panel y se abre por direccion (#reportes y #reportes/reporte)', /id="viewReportes"/.test(admin) && admin.includes('/^#reportes(?:\\/([a-z-]+))?$/') && /id="reportesMount"/.test(admin));
    yes('admin.html carga reportes-ui.js antes del script de la pagina', admin.indexOf('reportes-ui.js') > 0 && admin.indexOf('reportes-ui.js') < admin.indexOf('SisdelReportes.available()'));
    yes('el panel, Configuracion y Reportes son vistas exclusivas', /function paintViews\(\)/.test(admin) && /if \(open\) repOpen = false;/.test(admin) && /if \(open\) cfgOpen = false;/.test(admin));
    yes('el boton Reportes solo aparece si hay alguna seccion disponible', /btnReports\.style\.display = canReports \? '' : 'none'/.test(admin) && /const canReports = reportIds\.length > 0/.test(admin));
    // Los datos van en bruto en el modelo (nombres, placas, motivos los escriben otros usuarios) y se escapan al dibujar la tabla
    yes('reportes-ui.js escapa cada celda, encabezado y titulo que dibuja', /function esc\(value\)/.test(rp) && /function tableHtml\(t\)[\s\S]*?return esc\(value\);[\s\S]*?\}/.test(rp) && /\$\{esc\(h\)\}/.test(rp) && /\$\{esc\(t\.title\)\}/.test(rp) && /\$\{esc\(m\.title\)\}/.test(rp) && /\$\{esc\(r\.label\)\}/.test(rp));
    // SISDEL es una constante global de sisdel-core.js (no cuelga de window): leerlo solo de window dejaba el boton oculto
    yes('reportes-ui.js lee SISDEL como constante global y no solo de window', /typeof SISDEL !== 'undefined' \? SISDEL : window\.SISDEL/.test(rp) && (rp.match(/window\.SISDEL/g) || []).length === 1);
    // Cada clave que usa el modulo existe en el catalogo
    const used = [...rp.matchAll(/can\('([a-z_]+\.[a-z_]+)'\)/g)].map((m) => m[1]);
    yes('reportes-ui.js solo usa privilegios del catalogo', used.length > 10 && used.every((k) => P.itemOf(k)));
    yes('las claves de los reportes de OIKOS (FIN_REPORTS) son privilegios de Finanzas', [...rp.matchAll(/key: '(finanzas\.reportes_[a-z]+)'/g)].every((m) => P.itemOf(m[1])) && (rp.match(/key: 'finanzas\.reportes_/g) || []).length === 8);
    // Los accesos directos llegan a pantallas que existen en OIKOS
    const ids = [...rp.matchAll(/\{ id: '([a-z-]+)', key: 'finanzas\.reportes_/g)].map((m) => m[1]);
    equal('los ocho reportes de OIKOS tienen acceso directo', ids, ['income', 'expense-cat', 'month-balance', 'morosos', 'pay-map', 'owners', 'account-statement', 'resumen']);
    yes('cada acceso directo corresponde a una pestana de reportes de OIKOS (o al reporte financiero)', ids.filter((i) => i !== 'resumen').every((i) => oikos.includes(`id="rep-tab-${i}"`) && oikos.includes(`selectReport('${i}')`)) && /function openReportModal\(/.test(oikos));
    // La lista de Reportes de OIKOS trae los mismos cinco que el panel Reportes de SISDEL, en el mismo orden
    const oikosCatalog = oikos.slice(oikos.indexOf('id="rep-catalog"'), oikos.indexOf('id="rep-detail"'));
    const oikosList = [...oikosCatalog.matchAll(/id="rep-tab-([a-z-]+)"/g)].map((m) => m[1]);
    equal('la lista de Reportes de OIKOS es la misma del panel Reportes', oikosList, ids);
    yes('el reporte financiero de la lista abre su ventana', /onclick="openReportModal\(\)" id="rep-tab-resumen"/.test(oikos));
    yes('la barra de Contabilidad ya no tiene el boton "Reporte" (el reporte financiero se abre desde Reportes) y conserva Cargo, Ingreso y Gasto', !/id="lbl-btn-report"/.test(oikos) && !/button onclick="openReportModal\(\)"/.test(oikos) && ["openModal('modal-bulk-charge')", "openModal('modal-income')", "openModal('modal-expense')"].every((a) => oikos.includes(`onclick="${a}"`)) && !/#view-accounting button\[onclick="openReportModal\(\)"\]/.test(read('finanzas-bloqueo.js')));
    yes('la barra de Contabilidad ya no tiene el boton PDF (dependia de la ventana del reporte financiero; el PDF del mes esta en Reportes)', !/exportToPDF/.test(oikos) && !/exportToPDF/.test(read('finanzas-bloqueo.js')));
    // Estado de cuenta de un residente: WhatsApp, Excel, imprimir y PDF, con los mismos datos y la misma mora que la pantalla
    const ecButtons = oikos.slice(oikos.indexOf('id="modal-estado-cuenta"'), oikos.indexOf('<!-- RECEIPT IMAGE VIEWER -->'));
    yes('el Estado de cuenta ofrece Enviar por WhatsApp, Exportar a Excel, Imprimir y Descargar PDF', ['shareEstadoCuentaWhatsApp()', 'exportEstadoCuentaExcel()', 'printEstadoCuenta()', 'downloadEstadoCuentaPDF()'].every((a) => ecButtons.includes(`onclick="${a}"`)) && /Enviar por WhatsApp/.test(ecButtons) && /Exportar a Excel/.test(ecButtons));
    yes('el Excel del Estado de cuenta es un .xlsx de verdad (modulo comun) con montos numericos y con signo', /function exportEstadoCuentaExcel\(\)[\s\S]{0,700}SisdelReportExport\.buildXlsx\(model\)/.test(oikos) && /numeric: \[3, 4\]/.test(oikos) && /const signed = \(row\) => \(row\.tipo === 'Pago' \? 1 : -1\) \* row\.monto;/.test(oikos));
    yes('WhatsApp va al telefono del residente (wa.me/numero) y, sin telefono, deja elegir el contacto', /'https:\/\/wa\.me\/' \+ phone \+ '\?text=' \+ encodeURIComponent\(text\) : SisdelReportExport\.whatsappUrl\(text\)/.test(oikos) && /const model = ecReportModel\(true\);/.test(oikos));
    yes('pantalla, PDF, impresion y Excel usan la misma mora (ecMora) y ya no el saldo guardado del residente', /function ecMora\(\) \{ return sisdelMoraOf\(ecResidentId, sisdelLedgerBalance\(ecResidentId\)\); \}/.test(oikos) && (oikos.match(/ecDebt\(\)/g) || []).length >= 5 && /const ms = ecMora\(\);\s*if \(!ms \|\| typeof SisdelReportesOikos === 'undefined'\) return null;/.test(oikos) && !/r\.balance !== undefined \? r\.balance : sisdelLedgerBalance/.test(oikos));
    yes('Imprimir el Estado de cuenta escapa el nombre, la casa, el condominio y los conceptos (se escriben en una ventana nueva)', (() => {
        const body = (oikos.match(/function printEstadoCuenta\(\) \{[\s\S]*?const w = window\.open/) || [''])[0];
        return /\$\{esc\(r\.name\)\}/.test(body) && /\$\{esc\(r\.unit\)\}/.test(body) && /\$\{esc\(row\.concept\)\}/.test(body) && /\$\{esc\(s\.name \|\| 'OIKOS'\)\}/.test(body) && !/\$\{r\.name\}|\$\{row\.concept\}|\$\{r\.unit\}/.test(body);
    })());
    // Lote o casa (unitType): el formulario, la lista, la herramienta en bloque y los reportes por residente
    yes('el formulario del residente tiene dos botones, Solo lote y Casa con lote, y se los exige a los residentes nuevos', /<input type="hidden" id="res-unit-type" value="">/.test(oikos) && /id="res-type-lote"[^>]*onclick="setResUnitType\('lote'\)"[^>]*><i class="fas fa-vector-square mr-2"><\/i>Solo lote<\/button>/.test(oikos) && /id="res-type-casa"[^>]*onclick="setResUnitType\('casa'\)"[^>]*><i class="fas fa-home mr-2"><\/i>Casa con lote<\/button>/.test(oikos) && /if \(!id && !isUnitType\(val\('res-unit-type'\)\)\) \{ resTab\('datos'\); alert\(/.test(oikos) && /function paintResUnitType\(\)/.test(oikos));
    yes('el tipo se guarda con el residente (unitType: solo lote o casa) y viaja con los datos financieros, no con el vecino de SISDEL', /opt\('unitType', isUnitType\(val\('res-unit-type'\)\) \? val\('res-unit-type'\) : ''\);/.test(oikos) && !/CORE_FIELDS = \[[^\]]*unitType/.test(read('finanzas-sync.js')));
    yes('el tipo efectivo es el que se marco o, si no, el que dice el agua, y lo usan la lista, los reportes y los Recordatorios', /function unitTypeOf\(r\) \{\s*if \(unitTypeMarked\(r\)\) return r\.unitType;\s*return typeof SisdelCuotas !== 'undefined' && SisdelCuotas\.waterUnits\(r\) > 0 \? 'casa' : 'lote';/.test(oikos) && /const hasHouse = unitTypeOf\(r\) === 'casa';/.test(oikos) && /return !!r && unitTypeOf\(r\) === filter;/.test(oikos));
    yes('los ayudantes del tipo son funciones (la lista se pinta al arrancar, antes de que corra una variable declarada mas abajo)', /function isUnitType\(v\) \{ return v === 'lote' \|\| v === 'casa'; \}/.test(oikos) && /function unitTypeLabel\(r\)/.test(oikos) && !/UNIT_TYPES/.test(oikos));
    yes('la lista de Residentes se filtra por tipo, muestra el tipo bajo la referencia y la busqueda entiende "lote" y "casa"', /\.filter\(r => unitTypeMatches\(r, resTypeFilter\)\)/.test(oikos) && /id="res-type-filter" onchange="resTypeChanged\(this\.value\)"/.test(oikos) && />\$\{unitTypeLabel\(r\)\}<\/span>/.test(oikos) && /r\.dpi, unitTypeLabel\(r\)\]/.test(oikos));
    yes('Marcar tipo: una ventana con su X que marca solo a los que no tienen tipo y se puede deshacer', /id="modal-bulk-type"/.test(oikos) && /onclick="closeModal\('modal-bulk-type'\)"[^>]*><i class="fas fa-times sisdel-x-lg">/.test(oikos) && /const targets = res\.filter\(r => !unitTypeMarked\(r\)\);\s*if \(!targets\.length\)[^\n]*\n\s*History\.push\(\);/.test(oikos) && /onclick="applyBulkType\('agua'\)"/.test(oikos));
    yes('Por fase tiene una flecha de seleccion con las fases (cada una con cuantos hay), el aviso sin fases y el boton de asignarlas por sector', /<select id="rem-fase-select"/.test(oikos) && /id="rem-fase-empty"/.test(oikos) && /id="rem-fase-assign" onclick="openAssignFases\(\)"/.test(oikos) && /const items = fases\.map\(f => \[f, faseLabel\(f\)\]\);/.test(oikos) && /Por fase<i class="fas fa-chevron-down/.test(oikos) && !/rem-fase-chips/.test(oikos));
    yes('Fases por sector: una ventana con su X que pone la fase por las letras de la referencia, sin pisar las que ya existen si se marca, y se puede deshacer', /id="modal-assign-fases"/.test(oikos) && /onclick="closeModal\('modal-assign-fases'\)"[^>]*><i class="fas fa-times sisdel-x-lg">/.test(oikos) && /function sectorOfUnit\(r\)[^\n]*match\(\/\^\[A-Za-z\]\+\/\)/.test(oikos) && /if \(keep && String\(r\.fase \|\| ''\)\.trim\(\)\) return false;/.test(oikos) && /if \(!targets\.length\) \{ showToast\('No hay nada que cambiar con eso\.'\); return; \}\s*History\.push\(\);/.test(oikos) && /id="res-assign-fase-btn" onclick="openAssignFases\(\)"/.test(oikos));
    yes('el nombre de una fase dice "Fase" una sola vez (Reportes y Recordatorios)', /function faseLabel\(f\)/.test(oikos) && /escapeHtml\(faseLabel\(f\)\) \+ '<\/option>'/.test(oikos));
    yes('Morosos, la Tabla general y el Listado de propietarios se pueden sacar solo de lotes o solo de casas, y lo dicen en su texto', /<select id="rep-type" onchange="repTypeChanged\(this\.value\)"/.test(oikos) && /const residents = reportResidents\(\);/.test(oikos) && /R\.ownersList\(reportResidents\(\), /.test(oikos) && (oikos.match(/unitTypeFilterText\(repTypeFilter\)/g) || []).length === 3 && /const byResident = key === 'morosos' \|\| key === 'pay-map' \|\| key === 'owners';/.test(oikos));
    // Lo que debe el residente: cuotas y cargos pendientes + mora = TOTAL QUE DEBE, en la pantalla y en las cuatro salidas
    yes('el Estado de cuenta muestra cuotas y cargos pendientes + mora = TOTAL QUE DEBE y la tabla de cuotas pendientes', ['ec-pending', 'ec-overdue', 'ec-upcoming', 'ec-mora', 'ec-total-due', 'ec-pending-wrap', 'ec-pending-body', 'ec-pending-foot'].every((id) => oikos.includes(`id="${id}"`)) && /= Total que debe/.test(oikos) && /Saldo sin mora/.test(oikos));
    yes('el PDF, la impresion, el Excel y WhatsApp traen primero el total que debe y la tabla de cuotas pendientes', /doc\.text\('= TOTAL QUE DEBE'/.test(oikos) && /'= Total que debe', formatMoney\(d\.total\)/.test(oikos) && /label: 'TOTAL QUE DEBE', value: money\(d\.total\)/.test(oikos) && /title: 'Cuotas pendientes y su mora'/.test(oikos) && (oikos.match(/ecPendingTable\(dd\.list, (?:true|false)\)/g) || []).length === 2);
    yes('la impresion y el PDF no parten los montos ni el saldo en dos lineas', (() => {
        const printBody = (oikos.match(/function printEstadoCuenta\(\) \{[\s\S]*?const w = window\.open/) || [''])[0];
        const pdfBody = (oikos.match(/function downloadEstadoCuentaPDF\(\) \{[\s\S]*?doc\.save\(/) || [''])[0];
        return (printBody.match(/white-space:nowrap/g) || []).length >= 10 && (pdfBody.match(/cellWidth: 'wrap'/g) || []).length >= 8;
    })());
    yes('la tabla de cuotas pendientes escapa lo que escriben los usuarios (el concepto de un cargo) en pantalla e impresion', /\$\{ecEsc\(r\.label\)\}/.test(oikos) && /\$\{esc\(r\.label\)\}/.test(oikos));
    yes('el estado de cuenta sin regla de mora no cambia (ecDebt devuelve null y queda el saldo de siempre)', /if \(!ms \|\| typeof SisdelReportesOikos === 'undefined'\) return null;/.test(oikos) && /dd \? 'Saldo sin mora' : 'Saldo'/.test(oikos));
    yes('el PDF del Estado de cuenta cambia los signos que su fuente no tiene (latin1)', /function downloadEstadoCuentaPDF\(\)[\s\S]{0,900}SisdelReportExport\.latin1\(v\)/.test(oikos) && /L\(row\.concept\)/.test(oikos) && /doc\.text\(L\(r\.unit \+ ' - ' \+ r\.name\), 14, 40\);/.test(oikos));
    // Cuota del mes: privilegio con su nombre y, en cobro manual, la clave de quien la aplica
    const auth = read('functions/src/auth.js');
    yes('el privilegio se llama como el boton: "Cuota del mes: aplicarla a todos los residentes" y avisa que pide la clave en cobro manual', (() => { const k = P.itemOf('finanzas.cuotas_mes'); return !!k && /^Cuota del mes/.test(k.label) && /pide la clave/.test(k.description) && k.sensitive === true; })());
    yes('el servidor confirma SOLO la propia clave (usuario, condominio y estado), con 5 intentos y sin registrar el codigo', /const confirmOwnCode = onCall/.test(auth) && /found\.user\.id === uid/.test(auth) && /found\.user\.condominioId === token\.condominioId/.test(auth) && /CONFIRM_LIMIT = \{ max: 5,/.test(auth) && !/logger\.info\('confirmar clave', \{[^}]*code[,: ]/.test(auth) && /module\.exports = \{ login, verifyAccessCode, confirmOwnCode \}/.test(auth) && /confirmOwnCode, deleteCondominio/.test(read('functions/index.js')));
    yes('finanzas.html le da a OIKOS el puente para confirmar la clave', /window\.sisdelConfirmCode = async \(code\) => \{[\s\S]{0,200}httpsCallable\('confirmOwnCode'\)/.test(read('finanzas.html')));
    yes('Cuota del mes en cobro manual pide la clave (y en automatico o fuera de SISDEL queda la pregunta de siempre)', /function feeRunNeedsKey\(settings\) \{ return \(settings\.feeMode \|\| 'auto'\) === 'manual' && !!sisdelConfirmBridge\(\); \}/.test(oikos) && /if \(feeRunNeedsKey\(s\)\) \{ openFeeConfirm\(summary, \(\) => commitFeeRun\(period\)\); return; \}/.test(oikos) && /if \(!confirm\(`¿Aplicar la cuota de/.test(oikos));
    yes('la cuota solo se aplica despues de que el servidor confirme la clave (falla cerrada si no se puede verificar) y se recalcula a quien le toca', /if \(!result \|\| result\.ok !== true\) return fail\('Clave incorrecta/.test(oikos) && /no se aplicó ninguna cuota/.test(oikos) && /function commitFeeRun\(period\) \{[\s\S]{0,400}const targets = feeRunTargets\(\);[\s\S]{0,120}if \(targets\.period !== period\) return;/.test(oikos));
    yes('la ventana de la clave es de contrasena (type=password) dentro de un formulario (al cerrarla se borra la clave) con su X, y si se cierra mientras el servidor verifica no se aplica nada', /id="fc-code"[^>]*type="password"|type="password" id="fc-code"/.test(oikos) && /<form autocomplete="off" onsubmit="event\.preventDefault\(\); submitFeeConfirm\(\)">/.test(oikos) && /onclick="closeModal\('modal-fee-confirm'\)"[^>]*><i class="fas fa-times sisdel-x-lg">/.test(oikos) && /function closeFeeConfirm\(\) \{\s*feeConfirmAction = null;/.test(oikos) && /if \(action && stillOpen\) action\(\);/.test(oikos) && /input\.value = ''; input\.focus\(\)/.test(oikos));
    // Cada reporte ofrece Imprimir, PDF, Excel, WhatsApp y su grafica de barras
    const repDetail = oikos.slice(oikos.indexOf('id="rep-detail"'), oikos.indexOf('id="rep-table-wrap"'));
    yes('la pantalla de Reportes trae grafica, Imprimir, PDF, Excel y WhatsApp', ['toggleReportChart()', 'printCurrentReport()', 'downloadCurrentReportPDF()', 'exportCurrentReportExcel()', 'shareCurrentReportWhatsApp()'].every((f) => repDetail.includes(`onclick="${f}"`)));
    yes('la ventana del reporte financiero trae grafica, Imprimir, PDF, Excel y WhatsApp', ['toggleSummaryChart()', 'printReport()', 'downloadReportPDF()', 'exportReportExcel()', 'shareReportWhatsApp()'].every((f) => oikos.includes(`onclick="${f}"`)));
    yes('todas las graficas de los reportes son de barras', !/chartType: '(?!bar')/.test(oikos) && (oikos.match(/chartType: 'bar'/g) || []).length === 7);
    // Dos funciones con el mismo nombre: la segunda pisa a la primera (asi Imprimir y PDF de Reportes sacaban la ventana del reporte financiero)
    const fnNames = [...oikos.matchAll(/^        (?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    equal('OIKOS no repite nombres de funciones', fnNames.filter((n, i) => fnNames.indexOf(n) !== i), []);
    // Un condominio que solo tiene cuotas y cargos (La Perla al cargarlo) no debe ver ceros sin explicacion
    yes('la ventana del reporte financiero muestra cuotas y cargos emitidos, por cobrar y un aviso sin pagos ni gastos', ['rep-val-chg', 'rep-val-rec', 'rep-sum-notice'].every((id) => oikos.includes(`id="${id}"`)) && /SisdelReportesOikos\.periodSummary\(/.test(oikos));
    yes('la ventana del reporte financiero abre en el ultimo mes con movimientos hasta hoy (no en el mas adelantado)', /const initial = sorted\.find\(k => k <= nowKey\)/.test(oikos));
    yes('los reportes muestran un aviso y explican por que la tabla sale vacia', ['rep-notice', 'rep-notice-text', 'rep-empty-text'].every((id) => oikos.includes(`id="${id}"`)) && (oikos.match(/sisdelNoCashNotice\(/g) || []).length === 3);
    // Residentes: en un condominio grande la lista abre con los que mas deben; los demas se buscan
    yes('la lista de residentes va en orden alfabetico, de 50 en 50 con flechas, y la busqueda busca entre todos', /const RES_PAGE_SIZE = 50;/.test(oikos) && /const byName = \(a, b\) => String\(a\.name \|\| ''\)\.localeCompare\(String\(b\.name \|\| ''\), 'es'/.test(oikos) && /SisdelBusqueda\.filter\(res, search, residentSearchFields\)/.test(oikos) && ['res-list-note', 'res-pager-top', 'res-pager'].every((id) => oikos.includes(`id="${id}"`)) && /oninput="resSearchChanged\(\)"/.test(oikos));
    yes('un selector ordena la lista alfabeticamente, por morosidad (con la mora del dia) o por casa', /<select id="res-order" onchange="resOrderChanged\(this\.value\)"/.test(oikos) && ['value="name"', 'value="debt"', 'value="unit"'].every((v) => oikos.includes(v)) && /Math\.max\(0, -residentShownBalance\(r\)\.shown\)/.test(oikos) && /\(owed\.get\(b\.id\) - owed\.get\(a\.id\)\) \|\| byName\(a, b\)/.test(oikos));
    yes('anterior/siguiente del formulario recorre a todos en el mismo orden (no solo la pagina)', /function visibleResidents\(\) \{ return residentsView\(\)\.ordered; \}/.test(oikos) && /list: ordered\.slice\(start, start \+ RES_PAGE_SIZE\)/.test(oikos));
    yes('la linea entre residentes es mas marcada', oikos.includes('id="residents-table-body" class="text-sm text-slate-700 dark:text-slate-200 divide-y divide-slate-200 dark:divide-slate-600"'));
    // Todas las ventanas tienen la X de cerrar arriba a la derecha (pedido del usuario)
    const oikosModals = [...oikos.matchAll(/<div id="(modal-[\w-]+)"/g)].map((m) => m[1]);
    const oikosSinX = oikosModals.filter((id) => {
        const start = oikos.indexOf(`<div id="${id}"`);
        const next = oikos.indexOf('<div id="modal-', start + 10);
        const chunk = oikos.slice(start, next < 0 ? undefined : next);
        return !/fa-times sisdel-x-(lg|md)/.test(chunk);
    });
    equal('cada ventana de OIKOS tiene la X de cerrar', [oikosModals.length > 10, oikosSinX], [true, []]);
    const sinX = [];
    ['admin.html', 'master.html', 'garita.html', 'vecino.html', 'auditor.html', 'index.html', 'finanzas.html'].forEach((file) => {
        const html = read(file);
        const starts = [...html.matchAll(/<div[^>]*class="[^"]*modal-overlay[^"]*"[^>]*>/g)].map((m) => m.index);
        starts.forEach((start, i) => {
            const chunk = html.slice(start, starts[i + 1]);
            if (!/modal-close/.test(chunk)) sinX.push(`${file}#${(/id="([^"]+)"/.exec(chunk) || [])[1]}`);
        });
    });
    equal('cada ventana de las paginas de SISDEL tiene la X de cerrar', sinX, []);
    yes('las ventanas de RONDIN muestran la X de cerrar (menos los avisos cortos)', /Swal\.fire = function sisdelFire/.test(read('rondin/js/sisdel-api.js')) && /showCloseButton: true/.test(read('rondin/js/sisdel-api.js')) && /!first\.toast/.test(read('rondin/js/sisdel-api.js')));
    // Envio de recordatorios: orden alfabetico, busqueda inteligente, mensaje personalizable y nombres escapados
    const remCode = oikos.slice(oikos.indexOf('function renderRemindersList'), oikos.indexOf('// ========== RESIDENT STATUS REPORTS'));
    yes('los recordatorios van en orden alfabetico y con la busqueda inteligente', /localeCompare\(String\(b\.name \|\| ''\), 'es'/.test(remCode) && /SisdelBusqueda\.filter\(res, text, residentSearchFields\)/.test(remCode) && oikos.includes('id="rem-search"'));
    yes('el mensaje de los recordatorios se personaliza y se guarda en la configuracion del condominio', ['rem-msg-mora', 'rem-msg-save'].every((id) => oikos.includes(`id="${id}"`)) && /s\.reminderMessages = \{ \.\.\.prev, mora:/.test(oikos) && oikos.includes('(nombre|casa|saldo|cuotas|mora|condominio)'));
    // Dos mensajes para elegir (pedido del usuario, 2026-11-16): por morosidad o mensajes varios; el elegido es el que se envia
    yes('la ventana de recordatorios es un 30 % mas ancha (55rem) y elige entre mensaje por morosidad y mensajes varios', /id="modal-reminders"[\s\S]{0,400}max-w-\[55rem\]/.test(oikos) && ['rem-mode-mora', 'rem-mode-varios', 'rem-msg-general', 'tab-rem-all', 'rem-preview'].every((id) => oikos.includes(`id="${id}"`)));
    yes('se envia el texto del mensaje seleccionado y se guardan los tres textos para todos', /if \(currentRemMode === 'varios'\) return pick\('rem-msg-general'/.test(oikos) && /const template = reminderTemplateFor\(r\)/.test(oikos) && /s\.reminderMessages = \{ \.\.\.prev, mora: [^}]*general:/.test(oikos));
    yes('ya no hay texto a quien esta en plazo: el mensaje por morosidad va solo a los morosos (lo guardado antes se conserva)', !oikos.includes('rem-msg-pending') && /if \(currentRemMode !== 'varios' \|\| scope === 'mora'\) return all\.filter\(r => checkIsMoroso\(r\)\)/.test(oikos));
    yes('el saldo de los recordatorios es lo que debe con la mora, igual que los reportes (sisdelOwedOf)', /function reminderOwedOf\(r\) \{\s*const o = sisdelOwedOf\(r\);/.test(oikos));
    yes('los recordatorios escapan nombre, casa y telefono y no meten el telefono en el onclick', !/\$\{r\.name\}/.test(remCode) && /onclick="sendReminder\(this\.dataset\.id\)" data-id="\$\{esc\(r\.id\)\}"/.test(remCode) && !/contactSingleWhatsApp\('\$\{r\.contact\}'/.test(oikos));
    // Listado general de propietarios (pedido del usuario, 2026-11-16): columnas, filtros, grafica, Excel, PDF e impresion
    const ownCode = oikos.slice(oikos.indexOf('function buildOwnersReport'), oikos.indexOf('// ========== REPORTS (mensual del dashboard'));
    yes('el listado de propietarios trae las seis columnas pedidas y su fila de totales', /headers: \['Número de lote', 'Nombre', 'Teléfono', 'Deuda por cuotas', 'Deuda por mora', 'Saldo total'\]/.test(ownCode) && /totals: \['TOTAL'/.test(ownCode) && /numericCols: \[3, 4, 5\]/.test(ownCode));
    yes('el listado de propietarios usa el mismo calculo que Residentes (sisdelOwedOf) y el de ownersList', /owedOf: sisdelOwedOf/.test(ownCode) && /R\.ownersList\(/.test(ownCode));
    yes('el listado de propietarios filtra por periodo (meses), fase, orden y a quienes mostrar, con todo por defecto', ['own-from', 'own-to', 'own-fase', 'own-order', 'own-show', 'rep-owners-filters'].every((id) => oikos.includes(`id="${id}"`)) && /<option value="name">Alfabético<\/option>[\s\S]{0,80}<option value="debt">De mayor a menor deuda<\/option>/.test(oikos) && /<option value="all">Todos los propietarios<\/option>/.test(oikos));
    yes('el listado de propietarios tiene grafica (barras apiladas de cuotas y mora), Excel, PDF, imprimir y WhatsApp como todos', /chartStacked: true/.test(ownCode) && /chartDatasets: \[/.test(ownCode) && /compact: \{/.test(ownCode) && /selectReport\('owners'\)/.test(oikos) && /else if \(currentReportKey === 'owners'\) currentReportData = buildOwnersReport\(\)/.test(oikos));
    yes('imprimir y PDF de los reportes salen en tamano oficio (8.5 x 13 pulgadas) y en horizontal', /@page\{size:13in 8\.5in;margin:10mm\}/.test(oikos) && /new jsPDF\(\{ orientation: 'landscape', unit: 'mm', format: \[215\.9, 330\.2\] \}\)/.test(oikos) && !/isWide/.test(oikos));
    // Chat de WhatsApp con los residentes (pedido del dueno, 2026-11-17)
    const chatItem = P.itemOf('finanzas.whatsapp_chat');
    yes('el chat de WhatsApp es un privilegio propio (paraguas) del administrador, sensible y de reglas', !!chatItem && !chatItem.parent && JSON.stringify(chatItem.roles) === '["admin"]' && chatItem.sensitive === true && chatItem.enforce === 'reglas' && P.has('admin', {}, 'finanzas.whatsapp_chat') && !P.has('operador', { 'finanzas.usar': true }, 'finanzas.whatsapp_chat') && P.has('operador', { 'finanzas.whatsapp_chat': true }, 'finanzas.whatsapp_chat'));
    yes('el administrador sin finanzas no trae el chat de WhatsApp', !P.templateKeys(P.templateById('sys-admin-sin-finanzas')).includes('finanzas.whatsapp_chat'));
    yes('OIKOS tiene la pantalla Chats WhatsApp (menu oculto sin el chat, con el numero de chats sin leer) y el chat de cada residente', oikos.includes('id="view-chats"') && /id="nav-chats" class="nav-item hidden/.test(oikos) && oikos.includes('id="nav-chats-badge"') && /onclick="openResidentChat\(this\.dataset\.id\)" data-id="\$\{esc\(r\.id\)\}"/.test(oikos) && /if \(v === 'chats'\) initChats\(\)/.test(oikos));
    const chatCode = oikos.slice(oikos.indexOf('// ========== SISDEL: CHATS DE WHATSAPP'), oikos.indexOf('// ========== SISDEL: BANCOS'));
    yes('el chat escapa todo lo que pinta y no mete ids en los onclick', /function chatEsc\(/.test(chatCode) && !/\$\{(m|c|r)\.(body|name|phone|id)\}/.test(chatCode) && /onclick="openChat\(this\.dataset\.id\)" data-id="' \+ chatEsc\(c\.id\)/.test(chatCode) && /chatEsc\(m\.body\)/.test(chatCode));
    yes('el chat solo muestra archivos con https y los abre aparte', /\/\^https:\\\/\\\/\/i\.test\(m\.media/.test(chatCode) && /rel="noopener noreferrer"/.test(chatCode));
    yes('enviar, marcar leido y traer lo anterior los hace el servidor (OIKOS no escribe chats)', /api\.send\(target, text\)/.test(chatCode) && /api\.markRead\(/.test(chatCode) && /api\.loadHistory\(/.test(chatCode) && !/collection\('whatsapp_chats'\)/.test(chatCode));
    const chatsJs = read('finanzas-chats.js');
    yes('finanzas.html abre los chats solo con el privilegio y finanzas-chats.js solo lee (whatsapp_chats y wa_mensajes)', /SISDEL\.can\('finanzas\.whatsapp_chat'\) && typeof SisdelFinanzasChats/.test(read('finanzas.html')) && /collection\('wa_mensajes'\)/.test(chatsJs) && !/\.(set|update)\(|batch\(|runTransaction|collection\([^)]*\)\.add\(/.test(chatsJs));
    yes('las reglas dejan leer los chats solo con el chat de WhatsApp y nadie los escribe desde el navegador', /match \/whatsapp_chats\/\{chatId\} \{\s*allow read: if isMaster\(\) \|\| pFinanzasWhatsappChat\(condoId\);\s*allow write: if false;\s*match \/wa_mensajes\/\{msgId\} \{\s*allow read: if isMaster\(\) \|\| pFinanzasWhatsappChat\(condoId\);\s*allow write: if false;/.test(rules) && /match \/whatsapp_sin_asignar\/\{chatId\} \{\s*allow read: if isMaster\(\);\s*allow write: if false;/.test(rules) && /match \/whatsapp_estados\/\{waId\} \{\s*allow read: if isMaster\(\);\s*allow write: if false;/.test(rules));
    yes('el chat respeta las 24 horas del WhatsApp oficial (desactiva la caja de escribir fuera de ellas)', /function chatWindowOf\(c\)/.test(chatCode) && /input\.disabled = !w\.allowed/.test(chatCode));
    // Bancos: pantalla, datos en finanzas.html y bloqueo por privilegios
    yes('OIKOS tiene la pantalla Bancos con su menu (oculto sin bancos) y carga sus calculos', oikos.includes('id="view-banks"') && /id="nav-banks" class="nav-item hidden/.test(oikos) && /<script src="\.\/sisdel-bancos\.js\?v=\w+"><\/script>/.test(oikos) && /\['dashboard', 'residents', 'chats', 'accounting', 'banks', 'reports', 'settings'\]/.test(oikos));
    yes('finanzas.html arranca los bancos solo con el privilegio de verlos', /<script src="finanzas-bancos\.js\?v=\w+"><\/script>/.test(fin) && /SISDEL\.can\('finanzas\.bancos_ver'\) && typeof SisdelFinanzasBancos !== 'undefined'/.test(fin));
    yes('los pagos y gastos no se copian al banco: se leen (ningun set de movimientos de OIKOS en bancos)', !/finanzas_movimientos/.test(read('finanzas-bancos.js')));
    yes('la cuenta favorita solo la cambia el servidor (funcion con el codigo del administrador)', /httpsCallable\('setFavoriteBank'\)/.test(read('finanzas-bancos.js')) && /setFavoriteBank/.test(read('functions/index.js')));
    yes('las reglas protegen cuentas y movimientos de bancos y nadie los borra', /match \/finanzas_bancos\/\{accountId\}[\s\S]*?allow delete: if false;/.test(read('firestore.rules')) && /match \/finanzas_bancos_movs\/\{movId\}[\s\S]*?allow delete: if false;/.test(read('firestore.rules')) && /nearNow\(request\.resource\.data\.openedAt\)/.test(read('firestore.rules')));
    yes('OIKOS carga los calculos de reportes y el modulo de Excel y WhatsApp de SISDEL', /<script src="\.\/sisdel-reportes\.js\?v=\w+"><\/script>/.test(oikos) && /<script src="\.\.\/reportes-export\.js\?v=\w+"><\/script>/.test(oikos));
    yes('finanzas.html abre el reporte pedido en la direccion (#reportes/...) solo la primera vez', /function openReportFromHash\(win\)/.test(fin) && ids.every((i) => fin.includes(i)) && /openReportFromHash\(mounted\.contentWindow\)/.test(fin) && /deepLinkDone/.test(fin));
    yes('el reporte financiero pide su privilegio aun por direccion', /SISDEL\.can\('finanzas\.reportes_resumen'\)/.test(fin));
    // Quien ve cada seccion (se carga el modulo con privilegios de verdad)
    const sandbox = { window: {}, document: {} };
    vm.createContext(sandbox);
    vm.runInContext(rp + '\nthis.SisdelReportes = SisdelReportes;', sandbox);
    const reports = sandbox.SisdelReportes;
    const sectionsFor = (role, overrides) => { sandbox.window.SISDEL = { can: (k) => P.has(role, overrides, k) }; return reports.available(); };
    equal('el administrador ve las cuatro secciones', sectionsFor('admin', {}), ['garita', 'morosos', 'finanzas', 'rondas']);
    equal('el administrador sin finanzas no ve los reportes de OIKOS', sectionsFor('admin', P.toOverrides('admin', P.templateKeys(P.templateById('sys-admin-sin-finanzas')))), ['garita', 'morosos', 'rondas']);
    equal('el administrador delegado ve las cuatro', sectionsFor('admin', P.toOverrides('admin', P.templateKeys(P.templateById('sys-admin-delegado')))), ['garita', 'morosos', 'finanzas', 'rondas']);
    equal('quien tiene la plantilla de consulta ve solo los reportes de garita', sectionsFor('operador', P.toOverrides('operador', P.templateKeys(P.templateById('sys-consulta')))), ['garita']);
    equal('el auditor tiene sus reportes en su panel: no ve el boton del administrador', sectionsFor('auditor', {}), []);
    equal('un guardia o un vecino no ven Reportes', [sectionsFor('policia', {}), sectionsFor('vecino', {})], [[], []]);
    equal('quitar reportes.garita lo oculta aunque pueda leer los datos', sectionsFor('admin', { 'reportes.garita': false }), ['morosos', 'finanzas', 'rondas']);
    equal('sin el paraguas reportes.ver no hay ninguna seccion', sectionsFor('admin', { 'reportes.ver': false }), []);
    equal('quitar la lectura del historial de la camara oculta la seccion de garita', sectionsFor('admin', { 'garita.camara': false }), ['morosos', 'finanzas', 'rondas']);
    // Catalogo en acordeon: categorias con los reportes que cada usuario puede abrir
    const catalogOf = (role, overrides) => { const can = (k) => P.has(role, overrides, k); return reports.catalogFor(can).map((c) => `${c.id}:${c.items.length}`); };
    equal('el administrador ve cuatro categorias, con 7, 1, 8 y 1 reportes', catalogOf('admin', {}), ['garita:7', 'morosos:1', 'finanzas:8', 'rondas:1']);
    equal('la plantilla de consulta ve solo la categoria de garita, con sus 7 reportes', catalogOf('operador', P.toOverrides('operador', P.templateKeys(P.templateById('sys-consulta')))), ['garita:7']);
    equal('quitar un reporte de OIKOS quita solo ese del catalogo', catalogOf('admin', { 'finanzas.reportes_libro': false }), ['garita:7', 'morosos:1', 'finanzas:7', 'rondas:1']);
    equal('sin el reporte financiero se quitan el y el de ingresos y egresos por mes', catalogOf('admin', { 'finanzas.reportes_resumen': false }), ['garita:7', 'morosos:1', 'finanzas:6', 'rondas:1']);
    equal('sin el de morosos se quitan el, el mapa de pagos y el listado de propietarios', catalogOf('admin', { 'finanzas.reportes_morosos': false }), ['garita:7', 'morosos:1', 'finanzas:5', 'rondas:1']);
    equal('sin reportes.ver el catalogo esta vacio', catalogOf('admin', { 'reportes.ver': false }), []);
    equal('un guardia, un vecino y el auditor no tienen catalogo del administrador', [catalogOf('policia', {}), catalogOf('vecino', {}), catalogOf('auditor', {})], [[], [], []]);
    const allDefs = reports.catalogFor(() => true).flatMap((c) => c.items);
    yes('cada reporte tiene un identificador unico y un texto', new Set(allDefs.map((r) => r.id)).size === allDefs.length && allDefs.every((r) => r.label && r.text));
    equal('los reportes de Finanzas y Rondas se abren en OIKOS y RONDIN; los de garita y morosos se arman aqui', [allDefs.filter((r) => r.href).map((r) => r.href.split('#')[0]).filter((h, i, a) => a.indexOf(h) === i), allDefs.filter((r) => !r.href).length], [['finanzas.html', 'rondin/'], 8]);
    yes('el catalogo es un acordeon: arranca cerrado, abre una categoria a la vez y se vuelve con "Volver al catalogo"', rp.includes('Click en una categoría para ver sus reportes.') && /aria-expanded/.test(rp) && /openCat = openCat === b\.dataset\.rpCat \? null/.test(rp) && rp.includes('Volver al catálogo') && /let openCat = null;/.test(rp));
    yes('cada reporte propio ofrece Imprimir, PDF, WhatsApp y Excel con el privilegio reportes.exportar', /actionsHtml\(\{ print: canExport, pdf: canExport, whatsapp: canExport, excel: canExport \}\)/.test(rp) && /const canExport = can\('reportes\.exportar'\)/.test(rp));
    yes('admin.html carga reportes-export.js antes de reportes-ui.js', admin.indexOf('src="reportes-export.js') > 0 && admin.indexOf('src="reportes-export.js') < admin.indexOf('src="reportes-ui.js'));
    const auditorHtml = read('auditor.html');
    yes('el panel del auditor usa los mismos botones: imprimir y PDF con auditoria.imprimir; WhatsApp y Excel con auditoria.exportar', /actionsHtml\(\{ print: can\.imprimir, pdf: can\.imprimir, whatsapp: can\.exportar, excel: can\.exportar \}\)/.test(auditorHtml) && auditorHtml.includes('reportes-export.js') && !/downloadCsv|data-export/.test(auditorHtml));
    yes('el Excel del auditor suma los listados completos solo con el privilegio de cada uno', /can\.exportar && can\.exportarAccesos/.test(auditorHtml) && /can\.exportar && can\.exportarVisitas/.test(auditorHtml) && /can\.exportar && can\.exportarUsuarios/.test(auditorHtml));
    equal('de donde viene cada lectura (vecino, visita o placa desconocida)', ['Vecino permanente: Ana', 'Visita programada: Luis', 'Visita: Luis → Casa 4', 'Placa no registrada', 'Marbete QR: Toyota — Ana', 'Acceso QR: Ana — Casa 4', 'Ana - MOROSO'].map((reason) => reports.logKind({ reason, status: 'Authorized' })),
        ['vecino', 'visita', 'visita', 'desconocido', 'vecino', 'vecino', 'vecino']);
    // Salidas de la garita
    yes('garita.salida es un privilegio con las reglas, dentro de operar la garita', P.itemOf('garita.salida').parent === 'garita.operar' && P.itemOf('garita.salida').enforce === 'reglas');
    yes('el guardia y el administrador de siempre pueden registrar salidas (hereda de operar la garita)', P.has('policia', {}, 'garita.salida') && P.has('admin', {}, 'garita.salida'));
    yes('un auditor no registra salidas', !P.has('auditor', {}, 'garita.salida'));
    yes('garita.html ofrece Registrar Salida solo con el privilegio y confirma antes', /id="btnRegisterExit"/.test(garita) && /salida: SISDEL\.can\('garita\.salida'\)/.test(garita) && /btnExit\.style\.display = g\.salida/.test(garita));
    yes('la visita dentro se reconoce por su ingreso y su salida (un acceso temporal puede volver a entrar)', /function isVisitInside\(visit\)/.test(core) && /exitedAt < visit\.enteredAt/.test(core));
    yes('el nucleo guarda la salida de una visita en la propia visita y la de un vecino en salidas', /updateVisit\(visitId, \{ exitedAt: nowIso\(\) \}\)/.test(core) && /exits: 'salidas'/.test(core) && /createExit, getExitsBetween, getExitsToday/.test(core));
    yes('el historial de la garita muestra las salidas', /badgeText = 'SALIDA'/.test(garita) && /getExitsToday/.test(garita));
    yes('las reglas tienen el bloque de salidas y la salida de visitas', /match \/salidas\/\{exitId\}/.test(read('firestore.rules')) && /pGaritaSalida\(condoId\) && onlyChanges\(\['exitedAt'\]\)/.test(read('firestore.rules')));
    // Boton Copiar: avisa en el propio boton (palomita verde, o cruz roja si no pudo copiar) y despues se restaura
    yes('el boton Copiar cambia a una palomita y luego vuelve a lo de antes', /function flashCopied\(button, copied\)/.test(core) && /points="20 6 9 17 4 12"/.test(core) && /copyText\(button\.getAttribute\('data-copy'\), 'Código copiado'\)\.then\(\(copied\) => flashCopied\(button, copied\)\)/.test(core) && /button\.innerHTML = before\.html;/.test(core) && /button\.style\.color = before\.color;/.test(core));
    yes('si no se pudo copiar el boton muestra una cruz roja y no una palomita', /const mark = copied \? COPY_CHECK : COPY_FAIL;/.test(core) && /<line x1="18" y1="6" x2="6" y2="18"\/>/.test(core));
}
{
    // La X de cerrar de los formularios: arriba a la derecha, en negrita y un 30 % mas grande
    const css = read('styles.css');
    yes('la cabecera de las ventanas va en fila: el titulo a la izquierda y la X a la derecha', /\.modal-header \{[^}]*display: flex;[^}]*justify-content: space-between;/.test(css));
    yes('la X de cerrar mide 52 px (un 30 % mas que los 40 px del boton de icono), va en negrita y pegada a la derecha',
        /\.btn-icon\.modal-close \{[^}]*width: 52px;[^}]*height: 52px;[^}]*margin-left: auto;[^}]*font-size: 1\.3rem;[^}]*font-weight: 800;/.test(css) && /\.btn-icon \{[^}]*width: 40px;[^}]*height: 40px;/.test(css));
    yes('una ventana alta se desplaza en vez de cortarse por arriba (donde esta la X)', /\.modal-overlay \{[^}]*align-items: safe center;[^}]*overflow-y: auto;/.test(css));
    for (const file of ['admin.html', 'master.html', 'vecino.html', 'privilegios-ui.js']) {
        const closers = [...read(file).matchAll(/<button[^>]*(?:id="btnClose[A-Za-z]+"|data-act="close")[^>]*>&times;<\/button>/g)].map((m) => m[0]);
        yes(`${file}: las ${closers.length} X de cerrar usan la clase modal-close`, closers.length > 0 && closers.every((tag) => /class="[^"]*\bmodal-close\b/.test(tag)));
    }
    const oikosX = [...read('finanzas/index.html').matchAll(/onclick="closeModal\('[a-z-]+'\)"[^>]*>\s*<i class="fas fa-times[^"]*"><\/i>/g)].map((m) => m[0]);
    yes('las X de las ventanas de OIKOS (una por ventana, arriba a la derecha) son un 30 % mas grandes', oikosX.length === (read('finanzas/index.html').match(/<div id="modal-[\w-]+"/g) || []).length && oikosX.some((tag) => tag.includes("closeModal('modal-resident')")) && oikosX.every((tag) => /sisdel-x-(lg|md)/.test(tag)) && /\.sisdel-x-lg \{ font-size: 1\.46rem; \}/.test(read('finanzas/index.html')) && /\.sisdel-x-md \{ font-size: 1\.3rem; \}/.test(read('finanzas/index.html')));
    yes('privilegios-ui.js sube de version junto con su X (admin.html y master.html por igual)', (() => {
        const a = read('admin.html').match(/privilegios-ui\.js\?v=(\w+)/); const m = read('master.html').match(/privilegios-ui\.js\?v=(\w+)/);
        return a && m && a[1] === m[1];
    })());
}
yes('el servidor pide garita.verificar para verificar codigos', /has\(me\.data\(\)\.role, me\.data\(\)\.privilegios, 'garita\.verificar'\)/.test(read('functions/src/auth.js')));
yes('el login decide el destino con el catalogo', /privilegios\.landing\(user\.role, user\.privilegios\)/.test(read('functions/src/auth.js')));

// ───────── Sintaxis de las paginas y modulos ─────────
console.log('\nSintaxis');
const syntaxOk = (name, code) => { try { new vm.Script(code, { filename: name }); return true; } catch (e) { console.log(`    ${name}: ${e.message}`); return false; } };
for (const file of ['sisdel-core.js', 'privilegios.js', 'privilegios-ui.js', 'reportes-ui.js', 'reportes-export.js', 'rondin/js/sisdel-api.js', 'rondin/js/privilegios-rondin.js', 'finanzas-sync.js', 'finanzas-bloqueo.js', 'panico-alertas.js', 'rondas-core.js']) {
    yes(`${file} no tiene errores de sintaxis`, syntaxOk(file, read(file)));
}
for (const file of ['index.html', 'admin.html', 'garita.html', 'auditor.html', 'vecino.html', 'master.html', 'finanzas.html', 'finanzas/index.html']) {
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
    yes('OIKOS: "Cerrar Sesión" pasa a "Regresar al panel principal" salvo que finanzas.html sea el unico panel', /function exitToHome\(win\)/.test(fin) && /home === 'finanzas\.html'/.test(fin) && /Regresar al panel principal/.test(fin) && /data-sisdel-exit/.test(fin));
    yes('OIKOS: el boton de regresar actua antes que logout() de OIKOS (fase de captura) y espera a que se guarde todo', /event\.stopPropagation\(\);\s*leave\(\(\) => \{ window\.location\.href = home; \}\);\s*\}, true\);/.test(fin));
    yes('RONDIN: lo mismo en el menu y en la vista del guardia, salvo que RONDIN sea el panel principal', /home !== 'rondin\/'/.test(read('rondin/js/sisdel-api.js')) && /Regresar al panel principal/.test(read('rondin/js/sisdel-api.js')) && /new MutationObserver\(relabel\)/.test(read('rondin/js/sisdel-api.js')));
    yes('RONDIN: la sesion vencida sigue cerrandose sola (API.logout no cambia)', /async logout\(\) \{/.test(read('rondin/js/sisdel-api.js')) && /if \(e\.status === 401\) \{ this\.logout\(\); \}/.test(read('rondin/js/sisdel-api.js')));
    yes('el bloqueo de OIKOS dice que es de pantalla y que las reglas son la barrera real', /no seguridad/.test(bloqueo) && /firestore\.rules/.test(bloqueo));
    yes('el modulo de RONDIN se carga antes que el adaptador, con la misma version', (() => { const h = read('rondin/index.html'); return h.indexOf('privilegios-rondin.js') > 0 && h.indexOf('privilegios-rondin.js') < h.indexOf('sisdel-api.js') && ver(h, 'privilegios-rondin.js') === ver(h, 'sisdel-api.js'); })());
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
        window, document: { addEventListener() {}, createTextNode: (text) => ({ nodeType: 3, textContent: text }) }, sessionStorage, localStorage: {}, performance: { now: () => 0 }, console: { log() {}, warn() {}, error() {} }, setTimeout,
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

// Un solo "Salir" para todo el sistema: en el panel principal cierra la sesion; en los demas, "Regresar al panel principal"
{
    const fakeButton = () => {
        const children = [{ nodeType: 3, textContent: 'Salir' }];
        children[0].remove = () => children.splice(children.indexOf(children[0]), 1);
        const handlers = [];
        return {
            childNodes: children, querySelector: () => null, appendChild: (node) => children.push(node), setAttribute() {},
            addEventListener: (event, handler) => handlers.push(handler), click: () => handlers.forEach((h) => h()),
            text: () => children.map((n) => n.textContent).join('').trim()
        };
    };
    const adminCore = makeCore({ session: sess('admin') });
    const inHome = fakeButton();
    equal('el administrador en su panel principal conserva "Salir"', [adminCore.SISDEL.bindExitButton(inHome, 'admin.html'), inHome.text()], [false, 'Salir']);
    const inGarita = fakeButton();
    equal('el administrador en la garita ve "Regresar al panel principal"', [adminCore.SISDEL.bindExitButton(inGarita, 'garita.html'), inGarita.text()], [true, 'Regresar al panel principal']);
    inGarita.click();
    equal('y ese boton lo lleva a su panel principal sin cerrar la sesion', [adminCore.window.location.href, adminCore.store.has('sisdel_session')], ['admin.html', true]);
    const guardCore = makeCore({ session: sess('policia') });
    equal('el guardia en su garita conserva "Salir"; en Auditoria (si pudiera entrar) regresaria a la garita', [guardCore.SISDEL.bindExitButton(fakeButton(), 'garita.html'), guardCore.SISDEL.bindExitButton(fakeButton(), 'auditor.html')], [false, true]);
    const fiscalCore = makeCore({ session: sess('vecino', P.toOverrides('vecino', P.templateKeys(P.templateById('sys-fiscalizador')))) });
    equal('el fiscalizador: "Salir" en su panel de vecino, "Regresar" en la auditoria y en finanzas', [fiscalCore.SISDEL.bindExitButton(fakeButton(), 'vecino.html'), fiscalCore.SISDEL.bindExitButton(fakeButton(), 'auditor.html'), fiscalCore.SISDEL.bindExitButton(fakeButton(), 'finanzas.html')], [false, true, true]);
    equal('sin boton no hace nada', adminCore.SISDEL.bindExitButton(null, 'admin.html'), false);
    for (const page of ['admin.html', 'garita.html', 'auditor.html', 'vecino.html', 'master.html']) {
        yes(`${page}: su boton de salida pasa por SISDEL.bindExitButton`, new RegExp(`SISDEL\\.bindExitButton\\(document\\.getElementById\\('btnLogout'\\), '${page.replace('.', '\\.')}'\\)`).test(read(page)) && !/btnLogout'\)\.addEventListener\('click', \(\) => SISDEL\.logout\(\)\)/.test(read(page)));
    }
}

// Copiar codigos: el nucleo ofrece el boton y las listas de usuarios lo usan
{
    const c = makeCore({ session: sess('admin') });
    yes('SISDEL ofrece copyText y copyButton', typeof c.SISDEL.copyText === 'function' && typeof c.SISDEL.copyButton === 'function');
    const button = c.SISDEL.copyButton('AB"C<1');
    yes('el boton Copiar lleva el codigo escapado en data-copy', button.includes('data-copy="AB&quot;C&lt;1"') && !button.includes('AB"C<1'));
    yes('el boton Copiar es accesible (titulo y etiqueta)', /title="Copiar código"/.test(button) && /aria-label="Copiar código"/.test(button));
    yes('el boton Copiar de un valor vacio no revienta', c.SISDEL.copyButton(null).includes('data-copy=""'));
    const master = read('master.html');
    const adminPage = read('admin.html');
    yes('master.html: cada usuario, el administrador de cada condominio y la ventana de edicion traen Copiar', (master.match(/SISDEL\.copyButton\(/g) || []).length === 2 && /id="btnCopyEditCode"/.test(master) && /btnCopyEditCode'\)\.setAttribute\('data-copy'/.test(master));
    yes('master.html escapa el codigo, la casa y el telefono al pintarlos', /Code: \$\{esc\(u\.accessCode\)\}/.test(master) && /esc\(u\.casa\)/.test(master) && /Tel: \$\{esc\(a\.phone/.test(master));
    yes('master.html: cada condominio de la lista trae Eliminar junto a Detalles (por data-*, sin el id dentro de onclick)', /data-condo-action="details" data-condo-id="\$\{esc\(c\.id\)\}"/.test(master) && /data-condo-action="delete" data-condo-id="\$\{esc\(c\.id\)\}"/.test(master) && !/onclick="viewCondoDetails\(/.test(master));
    yes('master.html: la lista de condominios escapa nombre y direccion', /<div class="item-name">\$\{esc\(c\.name\)\}/.test(master) && /esc\(c\.address \|\| 'Sin dirección'\)/.test(master));
    yes('master.html: la ventana de borrado no se cierra mientras elimina', /function closeDeleteCondo\(\) \{\s*if \(deleteBusy\) return;/.test(master) && /if \(!deleteTarget \|\| deleteBusy\) return;/.test(master));
    yes('admin.html: Copiar solo aparece donde el usuario ya ve el codigo', /\$\{u\.accessCode \? `<code[^`]*\$\{SISDEL\.copyButton\(u\.accessCode\)\}` : ''\}/.test(adminPage) && /copyEditCode\.style\.display = user\.accessCode \? '' : 'none'/.test(adminPage));
}

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

console.log('\nNombre del condominio (solo el programador, con la clave master)');
{
    const masterHtml = read('master.html');
    const oikosHtml = read('finanzas/index.html');
    const rules = read('firestore.rules');
    yes('el panel master cambia el nombre con la clave master (ventana con su X)', /id="modalRenameCondo"/.test(masterHtml) && /id="renameCondoCode"[^>]*type="password"|type="password"[^>]*id="renameCondoCode"/.test(masterHtml) && /id="btnCloseRenameCondo"/.test(masterHtml) && /SISDEL\.renameCondominio\(/.test(masterHtml));
    yes('el nucleo llama a la funcion del servidor', /httpsCallable\('renameCondominio'\)/.test(read('sisdel-core.js')));
    yes('las reglas no dejan cambiar el nombre directo', /allow update: if isMaster\(\) && !request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['name'/.test(rules) && /request\.resource\.data\.name == officialName\(\)/.test(rules));
    yes('en OIKOS el nombre es de solo lectura y no se guarda desde el campo', /id="cfg-name" readonly/.test(oikosHtml) && /name: oldS\.name,/.test(oikosHtml) && !/name: document\.getElementById\('cfg-name'\)\.value/.test(oikosHtml));
    yes('el nombre de un administrador tambien se cambia solo con la clave master', /data-rename-admin=/.test(masterHtml) && /SISDEL\.renameAdmin\(/.test(masterHtml) && /httpsCallable\('renameAdmin'\)/.test(read('sisdel-core.js')) && /function adminNameKept\(\)/.test(rules) && /allow update: if \(isMaster\(\) && adminNameKept\(\)\)/.test(rules));
    yes('las ventanas Editar no mandan el nombre de un administrador', /isAdminUser \? \{ accessCode: code, casa \}/.test(masterHtml) && /editing\.role === SISDEL\.ROLES\.ADMIN\) delete updates\.name/.test(read('admin.html')));
    yes('la ventana de cambio de nombre queda por encima de las demas', /id="modalRenameCondo" style="display:none; z-index:1100;"/.test(masterHtml));
    yes('el Sistema Financiero abre con el nombre vigente del condominio', /SISDEL\.getCondominio\(condoId\)/.test(read('finanzas.html')) && /msname: condoName/.test(read('finanzas.html')));
}

console.log('\nRecordatorios por WhatsApp a todos (servidor)');
{
    const oikos = read('finanzas/index.html');
    const rules = read('firestore.rules');
    const funcs = read('functions/index.js');
    yes('las funciones del envio estan exportadas', ['startReminderCampaign', 'controlReminderCampaign', 'sendReminderTest', 'processReminderQueue'].every((f) => new RegExp(`\\b${f}\\b`).test(funcs)));
    yes('piden el privilegio de recordatorios y tienen limites', /const KEY = 'finanzas\.residentes_contactar'/.test(read('functions/src/recordatorios.js')) && /CREATE_LIMIT/.test(read('functions/src/recordatorios.js')) && /TEST_LIMIT/.test(read('functions/src/recordatorios.js')));
    yes('el telefono sale de la ficha del vecino, no de lo que manda OIKOS', /normalizePhone\(user\.phone\)/.test(read('functions/src/recordatorios-core.js')) && !/item\.phone|data\.phone[^a-zA-Z]/.test(read('functions/src/recordatorios-core.js').replace(/sendTest[\s\S]*$/, '')));
    yes('las reglas dejan leer el avance al privilegio y no escribir a nadie', /match \/recordatorios_envios\/\{campId\}[\s\S]{0,200}pFinanzasResidentesContactar\(condoId\)[\s\S]{0,120}allow write: if false/.test(rules));
    yes('el privilegio de recordatorios lo hace cumplir el servidor', /finanzas\.residentes_contactar[^}]*enforce: 'reglas'/.test(read('privilegios.js')));
    yes('OIKOS pide el envio por el puente de finanzas.html y sin el puente no hay envio automatico', /window\.sisdelWhatsApp = \{/.test(read('finanzas.html')) && /window\.parent\.sisdelWhatsApp/.test(oikos) && /function sendRemindersToAll/.test(oikos));
    yes('el bloqueo de pantalla cubre las funciones nuevas', /sendRemindersToAll\|sendReminderTest\|controlRemCampaign/.test(read('finanzas-bloqueo.js')));
    yes('las ventanas que abre OIKOS (WhatsApp) escapan del sandbox del iframe: sin esto salia "Se bloqueo api.whatsapp.com"', (() => { const m = /setAttribute\('sandbox', '([^']*)'\)/.exec(read('finanzas.html')); return !!m && m[1].split(' ').includes('allow-popups-to-escape-sandbox') && !m[1].includes('allow-top-navigation'); })());
    yes('Enviar de la fila y Contactar mandan desde el servidor sin pedir telefono', /function remSendOne/.test(oikos) && /bridge\.one\(\{ residentId/.test(oikos) && /one: callServer\('sendReminderOne'\)/.test(read('finanzas.html')) && /contactWhatsApp\(this\.dataset\.id\)/.test(oikos) && /sendReminderOne\b/.test(funcs) && /match \/recordatorios_individuales\/\{msgId\}[\s\S]{0,160}allow write: if false/.test(rules));
    yes('OIKOS avisa cuanto tarda y pide confirmar antes de enviar', /de a poco \(uno cada/.test(oikos) && /¿Enviar\?`\)/.test(oikos) && /SOLO a los \$\{items\.length\} residentes que seleccion/.test(oikos));
    // Seleccion de residentes (pedido del usuario el 2026-11-16): con casillas se envia solo a los elegidos, para una prueba de unos 20
    const bloqueo = read('finanzas-bloqueo.js');
    yes('cada fila de Recordatorios tiene su casilla de seleccion (solo si hay telefono y envio desde el servidor)', /class="rem-pick /.test(oikos) && /remBridge\(\) && hasPhone/.test(oikos) && /onchange="remTogglePick\(this\.dataset\.id, this\.checked\)"/.test(oikos));
    yes('hay buscador + Seleccionar los de la lista, Quitar seleccion y Ver solo los seleccionados', /onclick="remPickAll\(\)"/.test(oikos) && /onclick="remClearPicks\(\)"/.test(oikos) && /id="rem-only-selected"/.test(oikos) && /id="rem-pick-count"/.test(oikos));
    yes('con "Por seleccion" el envio es SOLO a los marcados (sin marcar a nadie no se envia) y el boton lo dice', /const list = sel \? remSelectedSendable\(\) : reminderSendable\(remShownList\)/.test(oikos) && /Enviar a los seleccionados\$\{num\}/.test(oikos) && /Marque al menos un residente con teléfono/.test(oikos));
    yes('la seleccion se limpia al enviar, al cambiar de mensaje y al abrir la ventana', (oikos.match(/remSelected\.clear\(\)/g) || []).length >= 4);
    yes('las funciones de la seleccion piden el mismo privilegio que los recordatorios', /remTogglePick\|remPickAll\|remClearPicks\|remToggleOnlySelected\)\\\(\/, \['residentes_contactar'\]/.test(bloqueo));
    // El servidor sigue sin confiar en la seleccion: solo recibe ids de residente y texto, y toma el telefono de la ficha
    // La ventana se desplaza entera (pedido del usuario, 2026-11-16): con el envio en marcha lo de abajo quedaba fuera de la pantalla
    yes('la ventana de Recordatorios se desplaza entera y la lista tiene su altura (los botones Pausar / Cancelar y la lista se alcanzan)', /id="modal-reminders"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<div class="[^"]*max-h-\[90vh\][^"]*overflow-y-auto[^"]*">/.test(oikos) && /class="overflow-y-auto shrink-0[^"]*max-h-\[60vh\][^"]*" id="reminders-list"/.test(oikos));
    // Pausar y Continuar (pedido del usuario, 2026-11-17)
    yes('el panel de progreso tiene Pausar (en curso), Continuar (en pausa o detenido) y Cancelar, y cancelar es definitivo', /controlRemCampaign\('pause'\)[\s\S]{0,260}Pausar/.test(oikos) && /\(c\.status === 'paused' \|\| c\.status === 'error'\) && \(c\.pending \|\| 0\) > 0\) buttons\.push\([^\n]*controlRemCampaign\('resume'\)[^\n]*Continuar/.test(oikos) && !/c\.status === 'canceled'\) && \(c\.pending/.test(oikos) && /no se podrá continuar/.test(oikos));
    yes('un envio en pausa tambien bloquea el boton de enviar a todos', /remCampaign\.status === 'running' \|\| remCampaign\.status === 'paused'/.test(oikos));
    const core = read('functions/src/recordatorios-core.js');
    yes('el servidor pausa y revisa el estado antes de CADA mensaje (no cada 5)', /action === 'pause'/.test(core) && /where\('status', 'in', \['running', 'paused'\]\)/.test(core) && !/tick\+\+ % 5/.test(core));
    yes('pausar, cancelar y continuar no tocan el turno (lockUntil) de la corrida que esta mandando', !/status: 'canceled', canceledAt: iso, lockUntil/.test(core) && !/status: 'running', lockUntil: 0, errorMessage/.test(core));
    // Control de la conexion de WhatsApp (2026-11-17): UltraMsg acepta los mensajes con la instancia desconectada y los deja en cola
    const waSrc = read('functions/src/rondas/whatsapp.js');
    yes('el servidor comprueba la conexion antes de crear un envio, de mandar a uno, de la prueba y de continuar, y cada pocos mensajes', (core.match(/requireConnected\(whatsapp/g) || []).length >= 4 && /sinceCheck >= CONN_CHECK_EVERY/.test(core) && /stoppedBy = 'conexion'/.test(core) && /whatsapp \? await requireConnected|if \(whatsapp\) await requireConnected/.test(core));
    yes('whatsapp.js expone la conexion y la cola de UltraMsg, y la funcion para la pantalla esta exportada y pide el privilegio', /connection: \(config\) => \(meta\.usesMeta\(config\) \? meta\.connection\(config\) : estado\.connection\(config\)\)/.test(waSrc) && /instance\/status/.test(read('functions/src/rondas/ultramsg-estado.js')) && /checkWhatsAppConnection/.test(funcs) && /wrap\('checkWhatsAppConnection', async \(request\) => \{\s*const \{ uid \} = await authorize\(request\)/.test(read('functions/src/recordatorios.js')));
    yes('el puente de finanzas.html trae el estado y OIKOS lo muestra, bloquea los botones y lo vuelve a comprobar antes de enviar', /status: callServer\('checkWhatsAppConnection'\)/.test(read('finanzas.html')) && /id="rem-wa-status"/.test(oikos) && /function checkRemConnection/.test(oikos) && (oikos.match(/await checkRemConnection\(\)/g) || []).length >= 2 && /const down = !!\(remConn && remConn\.connected === false\)/.test(oikos) && /checkRemConnection\|/.test(bloqueo));
    // Que llego de verdad (2026-11-17): "enviado" solo era "UltraMsg lo acepto"
    const recSrc = read('functions/src/recordatorios.js');
    yes('el servidor mira lo que UltraMsg dice de un envio suelto y de la prueba (no basta con que lo acepte)', /await verifyDelivery\(/.test(core) && (core.match(/verifyDelivery\(\{/g) || []).length >= 2 && /delivery: delivery \? delivery\.state : null/.test(core));
    yes('comprobar entregas y reenviar solo a los que no recibieron: funciones exportadas, con el privilegio y limites, y el puente', ['reconcileReminderCampaign', 'resendReminderCampaign'].every((f) => new RegExp(`\\b${f}\\b`).test(funcs) && new RegExp(`wrap\\('${f}', async \\(request\\) => \\{\\s*const \\{[^}]*\\} = await authorize\\(request\\)`).test(recSrc)) && /RECONCILE_LIMIT/.test(recSrc) && /reconcile: callServer\('reconcileReminderCampaign'\)/.test(read('finanzas.html')) && /resend: callServer\('resendReminderCampaign'\)/.test(read('finanzas.html')));
    yes('reenviar solo toma a los rechazados, sin rastro o sin enviar (nunca a los entregados) y con el texto que ya tenian', /x\.delivery === 'rechazado' \|\| x\.delivery === 'desconocido' \|\| x\.delivery === 'sin_enviar'/.test(core) && /Primero pulse "Comprobar entregas"/.test(core) && /resendOf/.test(core));
    yes('un mismo texto al mismo telefono se manda una sola vez', /mismo mensaje al mismo teléfono/.test(core) && /seenMessages/.test(core));
    yes('OIKOS ya no da por enviado lo que solo UltraMsg acepto: cuenta lo que paso de verdad y tiene Comprobar entregas y Reenviar', /function remOutcome/.test(oikos) && !/if \(result\.sent\) showToast\(`Mensaje enviado a/.test(oikos) && /function reconcileRemCampaign/.test(oikos) && /function resendRemCampaign/.test(oikos) && /id="rem-bulk-delivery"/.test(oikos) && /reconcileRemCampaign\|resendRemCampaign/.test(bloqueo));
    // Quienes recibieron el ultimo mensaje (2026-11-17): listado con boton en Recordatorios
    const wa = read('finanzas.html');
    yes('el listado de quienes recibieron: boton, panel, grupos por lo que WhatsApp confirmo y buscador', /id="rem-rec-btn"/.test(oikos) && /id="rem-recipients"/.test(oikos) && /function remRecGroup/.test(oikos) && /it\.delivery === 'entregado' \|\| it\.delivery === 'enviado'\) return 'recibieron'/.test(oikos) && /SisdelBusqueda\.filter\(rows, query/.test(oikos) && /showRemRecipients\|hideRemRecipients\|setRemRecTab\|renderRemRecipients/.test(bloqueo));
    yes('el puente lee a los destinatarios del envio (sin el texto ni telefonos completos) con el privilegio de recordatorios', /recipients: async \(\{ campaignId \}\) =>/.test(wa) && /collection\('recordatorios_envios'\)\s*\.doc\(String\(campaignId\)\)\.collection\('destinatarios'\)\.get\(\)/.test(wa) && !/text: x\.text|params: x\.params/.test(wa.slice(wa.indexOf('recipients: async'), wa.indexOf('watch: (callback)'))) && /match \/recordatorios_envios\/\{campId\}[\s\S]{0,200}pFinanzasResidentesContactar\(condoId\)/.test(rules));
    // A quienes se envia: por fase y por tipo de propietario (2026-11-17)
    yes('A quienes se envia esta todo en UNA barra de opciones (todos, morosos, pendientes, por fase, solo casas, solo lotes y por seleccion), sin selectores aparte; con casa = el lote paga agua', ['tab-rem-all', 'tab-rem-mora', 'tab-rem-todos', 'tab-rem-fase', 'tab-rem-casas', 'tab-rem-lotes', 'tab-rem-seleccion'].every((id) => oikos.includes(`id="${id}"`)) && !/id="rem-fase"|id="rem-tipo"/.test(oikos) && /id="rem-fase-bar"/.test(oikos) && /<select id="rem-fase-select" onchange="setRemFase\(this\.value\)"/.test(oikos) && /function remScopes/.test(oikos) && /function remPassFilters/.test(oikos) && /SisdelCuotas\.waterUnits\(r\) > 0/.test(oikos) && /function remScopeWho/.test(oikos) && /function remSendLabel/.test(oikos) && /residentes de la fase \$\{remFaseSel\}/.test(oikos) && /setRemFase/.test(bloqueo));
    yes('las casillas y la barra de marcar solo salen en Por seleccion', /const pick = remBridge\(\) && hasPhone && currentRemFilter === 'seleccion'/.test(oikos) && /id="rem-pick-bar" class="hidden /.test(oikos) && /pickBar\.classList\.toggle\('hidden', !sel\)/.test(oikos));
    yes('el cliente no controla la espera de la verificacion (solo el servidor)', !/data\.verify/.test(core) && /verify = \{\}/.test(core));
    yes('el token de UltraMsg nunca se anota ni se devuelve: solo va dentro de la direccion de la consulta', !/logger\.[a-z]+\([^)]*ultramsgToken/.test(waSrc + read('functions/src/rondas/ultramsg-estado.js')) && !/ultramsgToken/.test(read('functions/src/rondas/ultramsg-estado.js').replace(/new URLSearchParams\(\{[^}]*token: config\.ultramsgToken[^}]*\}\)/g, '').replace(/!config\.ultramsgToken/g, '')));
    yes('la seleccion no manda telefonos al servidor (solo residentId, text y los datos de la plantilla)', /const items = list\.map\(remItemFor\)/.test(oikos) && /function remItemFor\(r\) \{\s*return \{ residentId: String\(r\.id\), text: reminderText\(reminderTemplateFor\(r\), r\), \.\.\.\(remMetaMode\(\) \? \{ vars: reminderVars\(r\) \} : \{\}\) \};/.test(oikos) && !/contact|phone/.test((/function remItemFor[\s\S]*?\n        \}/.exec(oikos) || [''])[0]));
    // WhatsApp oficial de Meta con plantillas (2026-11-17): el numero de UltraMsg fue bloqueado por WhatsApp (temporary_block)
    const metaSrc = read('functions/src/rondas/meta-estado.js');
    const setScript = read('scripts/set-whatsapp-plantillas.mjs');
    yes('Meta: manda SOLO por Meta con channel meta (sin caer a UltraMsg) y con plantilla si se pide; el token nunca se anota', /if \(meta\.usesMeta\(config\) && opts\.template\) return \(await sendMetaOfficial/.test(waSrc) && /sendTemplate\(config, to, opts\.template/.test(waSrc) && !/logger\.[a-z]+\([^)]*metaToken/.test(waSrc + metaSrc) && /Authorization: `Bearer \$\{config\.metaToken\}`/.test(metaSrc));
    yes('Meta: las alertas de panico (texto libre, sin plantilla) NO pasan al canal Meta: siguen por UltraMsg y Meta de respaldo', /whatsapp\.send\(config, r\.telefono, r\.mensaje\)/.test(read('functions/src/rondas/index.js')) && /meta\.usesMeta\(config\) && opts\.template/.test(waSrc));
    yes('Meta: el servidor exige la plantilla en el envio, a un residente y la prueba, y la corrida se detiene si falta', (core.match(/templateOrFail\(whatsapp, config/g) || []).length >= 3 && /stoppedBy: 'plantilla'/.test(core) && /paramsOf\(whatsapp, tpl/.test(core) && /renderTemplate\(tpl, params\)/.test(core));
    yes('Meta: el estado de la conexion trae el canal y las plantillas, y con Meta no se consulta el listado de UltraMsg', /channel: onMeta \? 'meta' : 'ultramsg', templates/.test(core) && /if \(templatesOn\(whatsapp, config\)\) return null;/.test(core) && /listMessages: \(config, options\) => \(meta\.usesMeta\(config\) \? null/.test(waSrc));
    yes('Meta: OIKOS muestra el texto de la plantilla (no editable) y manda los datos de cada residente', /id="rem-template-box"/.test(oikos) && /function remMetaMode/.test(oikos) && /function remTemplateAsText/.test(oikos) && /bridge\.one\(\{ residentId: String\(r\.id\), text, mode, \.\.\.\(remMetaMode\(\) \? \{ vars: reminderVars\(r\) \} : \{\}\) \}\)/.test(oikos) && /reminderTemplateReady\(r\) \{\s*if \(remMetaMode\(\) && !remMetaTemplate\(\)\)/.test(oikos));
    yes('Meta: el script de plantillas valida los datos y los huecos, comprueba que esten aprobadas y nunca imprime el token', /normalizeTemplate/.test(setScript) && /bodyParamCount\(tpl\.body\) !== tpl\.params\.length/.test(setScript) && /status === 'APPROVED'/.test(setScript) && !/console\.log\([^)]*metaToken/.test(setScript) && /--canal=meta/.test(setScript));
}

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
