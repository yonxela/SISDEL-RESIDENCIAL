// Pruebas del catalogo de privilegios (privilegios.js) y de que todo el sistema lo respete: sin emuladores.
// Verifica el catalogo, que la copia de las functions sea identica, que las reglas de Firestore usen las
// mismas claves y los mismos roles por defecto, que cada pagina pida su privilegio de entrada y que un
// usuario sin privilegios asignados conserve exactamente el acceso que su rol tenia antes.
// Uso: node test-privilegios.mjs (tambien corre con npm test).
import fs from 'node:fs';
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
equal('las claves no se repiten', new Set(P.KEYS).size, P.KEYS.length);
yes('cada clave tiene la forma modulo.accion', P.KEYS.every((k) => /^[a-z]+\.[a-z]+$/.test(k)));
yes('cada clave tiene etiqueta y descripcion', P.ITEMS.every((i) => i.label && i.description));
yes('los roles por defecto existen', P.ITEMS.every((i) => i.roles.every((r) => P.ROLES.includes(r))));
yes('las dependencias (requires) existen', P.ITEMS.every((i) => (i.requires || []).every((r) => P.KEYS.includes(r))));
yes('ninguna clave se requiere a si misma', P.ITEMS.every((i) => !(i.requires || []).includes(i.key)));
yes('las paginas piden claves que existen', P.PAGES.every((p) => p.role || p.any.every((k) => P.KEYS.includes(k))));
equal('el operador no trae privilegios por defecto', Object.keys(P.defaultsOf('operador')), []);
equal('hay 26 privilegios', P.KEYS.length, 26);
yes('las dependencias por defecto se cumplen en cada rol (si tiene X tiene lo que X necesita)',
    P.ROLES.every((role) => keysOn(role).every((k) => (P.itemOf(k).requires || []).every((r) => keysOn(role).includes(r)))));

// ───────── Copia en las functions ─────────
console.log('\nCopia en las functions');
equal('functions/src/privilegios.js es identico a privilegios.js', read('functions/src/privilegios.js'), read('privilegios.js'));

// ───────── Compatibilidad: los privilegios por defecto de cada rol son el acceso que tenia ─────────
console.log('\nCompatibilidad con los roles de siempre');
equal('admin', keysOn('admin'), ['usuarios.panel', 'usuarios.ver', 'usuarios.crear', 'guardias.crear', 'usuarios.editar', 'usuarios.eliminar', 'usuarios.codigos', 'usuarios.privilegios', 'mensajes.enviar', 'mensajes.historial', 'visitas.ver', 'visitas.gestionar', 'garita.operar', 'garita.camara', 'panico.ver', 'panico.atender', 'finanzas.ver', 'finanzas.usar', 'rondas.ver', 'rondas.gestionar']);
equal('policia', keysOn('policia'), ['usuarios.ver', 'visitas.ver', 'garita.operar', 'garita.camara', 'panico.activar', 'panico.ver', 'panico.atender', 'rondas.patrullar']);
equal('supervisor', keysOn('supervisor'), ['usuarios.ver', 'guardias.crear', 'panico.activar', 'panico.ver', 'panico.atender', 'rondas.ver', 'rondas.gestionar', 'rondas.patrullar']);
equal('auditor', keysOn('auditor'), ['usuarios.ver', 'mensajes.historial', 'visitas.ver', 'garita.camara', 'panico.ver', 'finanzas.ver', 'rondas.ver', 'auditoria.ver', 'auditoria.exportar']);
equal('vecino', keysOn('vecino'), ['vecino.visitas', 'vecino.vehiculos', 'panico.activar']);
yes('el auditor sigue siendo solo lectura (ningun privilegio de escritura)',
    !keysOn('auditor').some((k) => /\.(crear|editar|eliminar|gestionar|enviar|usar|atender|patrullar|operar|activar|privilegios|codigos)$/.test(k)));
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
equal('toOverrides del operador son sus claves', P.toOverrides('operador', ['garita.operar', 'usuarios.ver']), { 'usuarios.ver': true, 'garita.operar': true });
equal('toOverrides acepta un mapa', P.toOverrides('operador', { 'garita.operar': true, 'usuarios.ver': false }), { 'garita.operar': true });
equal('ida y vuelta: las diferencias reproducen el conjunto', keysOn('auditor', P.toOverrides('auditor', ['usuarios.ver', 'mensajes.enviar'])).join(), 'usuarios.ver,mensajes.enviar');
equal('cleanOverrides descarta claves ajenas y valores que no son booleanos', P.cleanOverrides({ 'garita.operar': false, otra: true, 'usuarios.ver': 1 }), { 'garita.operar': false });

// Dependencias
const set = new Set();
P.toggle(set, 'finanzas.usar', true);
equal('activar finanzas.usar activa lo que necesita', sorted([...set]), sorted(['finanzas.usar', 'finanzas.ver', 'usuarios.ver']));
P.toggle(set, 'usuarios.ver', false);
equal('quitar usuarios.ver quita lo que depende de el', [...set], ['finanzas.ver']);
equal('cascade avisa que se activaria', sorted(P.cascade(new Set(), 'garita.operar', true)), sorted(['usuarios.ver', 'visitas.ver']));

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
yes('los ids de las plantillas no se repiten', new Set(P.TEMPLATES.map((t) => t.id)).size === P.TEMPLATES.length);
yes('cada plantilla cumple sus dependencias', P.TEMPLATES.every((t) => t.claves.every((k) => (P.itemOf(k).requires || []).every((r) => t.claves.includes(r)))));
yes('toda plantilla de operador deja entrar a alguna pagina', P.TEMPLATES.filter((t) => t.role === 'operador').every((t) => P.landing('operador', P.toOverrides('operador', t.claves))));
yes('el administrador delegado no asigna privilegios', !P.templateById('sys-admin-delegado').claves.includes('usuarios.privilegios'));
yes('el administrador sin finanzas no tiene finanzas', !P.templateById('sys-admin-sin-finanzas').claves.some((k) => k.startsWith('finanzas.')));
equal('buscar una plantilla propia', P.templateById('mia', [{ id: 'mia', name: 'Mia' }]).name, 'Mia');

// ───────── Reglas de Firestore ─────────
console.log('\nReglas de Firestore');
const rules = read('firestore.rules');
const camel = (key) => 'p' + key.split('.').map((s) => s[0].toUpperCase() + s.slice(1)).join('');
const wrappers = [...rules.matchAll(/function (p[A-Z]\w*)\(c\) \{ return can\(c, '([a-z.]+)', \[([^\]]*)\]\); \}/g)]
    .map((m) => ({ fn: m[1], key: m[2], roles: m[3].split(',').map((r) => r.trim().replace(/'/g, '')).filter(Boolean) }));
// Privilegios que solo deciden que pagina se abre: las reglas no tienen nada que cuidar
const PAGE_ONLY = ['usuarios.panel', 'auditoria.ver', 'auditoria.exportar'];
yes('las reglas definen can(condoId, clave, roles)', /function can\(condoId, key, roles\)/.test(rules));
yes('can() lee el mapa privilegios del documento del usuario', /memberDoc\(condoId\)\.get\('privilegios', \{\}\)\.get\(key, memberRole\(condoId\) in roles\) == true/.test(rules));
yes('cada funcion pXxx usa el nombre de su clave', wrappers.every((w) => w.fn === camel(w.key)));
yes('cada clave de las reglas existe en el catalogo', wrappers.every((w) => P.KEYS.includes(w.key)));
yes('los roles por defecto de las reglas son los del catalogo', wrappers.every((w) => JSON.stringify(sorted(w.roles)) === JSON.stringify(sorted(P.itemOf(w.key).roles))));
equal('cada privilegio del catalogo tiene su funcion en las reglas (salvo los de pagina)', sorted(P.KEYS.filter((k) => !PAGE_ONLY.includes(k))), sorted(wrappers.map((w) => w.key)));
yes('cada funcion pXxx se usa en alguna regla', wrappers.every((w) => (rules.match(new RegExp(`\\b${w.fn}\\(`, 'g')) || []).length > 1));
yes('las reglas ya no preguntan por el rol del usuario para dar acceso (isAdmin, isStaff...)', !/\b(isAdmin|isStaff|isGuard|isSupervisor|isAuditor)\(/.test(rules));
yes('los roles validos de usuarios incluyen al operador', /role in \['vecino', 'policia', 'admin', 'auditor', 'supervisor', 'operador'\]/.test(rules));
yes('nadie se cambia sus propios privilegios', /pUsuariosPrivilegios\(condoId\) && userId != request\.auth\.uid/.test(rules));
yes('un codigo nuevo solo apunta a un usuario que se crea en la misma escritura (salvo usuarios.codigos)', /newUserCode\(\)/.test(rules) && /pUsuariosCodigos\(c\) && manageable\(c, codeTargetRole\(\)\)/.test(rules));

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
yes('el servidor pide garita.operar para verificar codigos', /has\(me\.data\(\)\.role, me\.data\(\)\.privilegios, 'garita\.operar'\)/.test(read('functions/src/auth.js')));
yes('el login decide el destino con el catalogo', /privilegios\.landing\(user\.role, user\.privilegios\)/.test(read('functions/src/auth.js')));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
