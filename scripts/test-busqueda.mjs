// Pruebas de la busqueda inteligente (sisdel-busqueda.js) y de las pantallas que la usan: sin emuladores.
// Uso: node test-busqueda.mjs (tambien corre con npm test).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const B = require('../sisdel-busqueda.js');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}
const yes = (name, value) => equal(name, !!value, true);

// Vecinos inventados (nombre, casa, telefono, fase)
const people = [
    { id: 1, name: 'Juan Pérez López', unit: 'A-281', phone: '+50255555678', fase: 'Fase 1' },
    { id: 2, name: 'Susana Juárez', unit: 'B-12', phone: '+50244441234', fase: 'Fase 2' },
    { id: 3, name: 'María José Núñez', unit: '281', phone: '+50277778888', fase: 'Fase 1' },
    { id: 4, name: 'Pedro Juanes', unit: 'C-5', phone: '', fase: '' },
    { id: 5, name: 'ANA CASTAÑEDA', unit: 'A-30', phone: '+50233332222', fase: 'Fase 3' },
    { id: 6, name: 'Ana Lucía Peña', unit: 'A-31', phone: '+50233335555', fase: 'Fase 3' }
];
const fields = (p) => [p.name, p.unit, p.phone, p.fase];
const ids = (text, options) => B.filter(people, text, fields, options).map((p) => p.id);

console.log('\nLo basico: mayusculas, acentos y la enie');
equal('sin acentos ni mayusculas encuentra el nombre con acento', ids('perez'), [1]);
equal('con acento tambien', ids('PÉREZ'), [1]);
equal('la enie vale como n: nunez encuentra Núñez y castaneda a Castañeda', [ids('nunez'), ids('castaneda')], [[3], [5]]);
equal('pena encuentra Peña (y Pedro no)', ids('pena'), [6]);
equal('el texto plegado conserva el largo (los lugares coinciden)', ['Núñez Peña ÁÉÍ', 'a b'].map((t) => B.fold(t).length === t.length), [true, true]);
equal('una letra con acento escrita en dos partes vale como una sola', [B.fold('Pérez'), B.fold('Pérez')], ['perez', 'perez']);

console.log('\nSe busca al escribir: las primeras letras bastan');
equal('"jua" encuentra los nombres que EMPIEZAN con jua (Juan, Juárez, Juanes), no los que lo llevan adentro', ids('jua'), [1, 2, 4]);
equal('"ju" ya trae a los Juan y Juárez', ids('ju'), [1, 2, 4]);
equal('"a" trae a quien tiene una palabra que empieza con a (Ana, o la casa A-281)', ids('a').sort(), [1, 5, 6]);
equal('a medida que se escribe se afina: jua -> juan -> juan pe (con la p ya entra Pedro Juanes: es su apellido)', [ids('jua').length, ids('juan').length, ids('juan pe'), ids('juan per')].map((x) => Array.isArray(x) ? x : x), [3, 2, [1, 4], [1]]);
equal('sin nada escrito salen todos, en su orden', ids(''), [1, 2, 3, 4, 5, 6]);
equal('solo espacios o signos es como no escribir nada', [ids('   '), ids('...')], [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]]);
equal('el limite recorta', ids('', { limit: 2 }), [1, 2]);

console.log('\nVarias palabras, en cualquier orden');
equal('jua per encuentra a Juan Pérez', ids('jua per'), [1]);
equal('el orden no importa: perez jua', ids('perez jua'), [1]);
equal('todas las palabras deben coincidir: juan susana no encuentra a nadie', ids('juan susana'), []);
equal('palabras de campos distintos: nombre y fase', ids('ana fase 3'), [5, 6]);
equal('nombre y casa juntos', ids('juan 281'), [1]);
equal('apellido del medio', ids('lopez'), [1]);

console.log('\nNumeros: casa y telefono');
equal('una casa exacta: 281 encuentra A-281 y 281', ids('281'), [1, 3]);
equal('la casa con letra: a-281 o a 281', [ids('a-281'), ids('a 281')], [[1], [1]]);
equal('el telefono por el final (3 o mas cifras)', ids('5678'), [1]);
equal('el telefono con espacios y signos', [ids('+502 5555 5678'), ids('502 5555')], [[1], [1, 6]]);
equal('con 1 o 2 cifras solo cuenta el principio de una palabra', [ids('28'), ids('81')], [[1, 3], []]);

console.log('\nSi nada empieza igual, se afloja');
equal('"uarez" (de en medio) encuentra Juárez', ids('uarez'), [2]);
equal('con menos de 3 letras no se afloja: "ue" no trae nada', ids('ue'), []);
equal('lo que si empieza igual no se mezcla con lo flojo: "ana" trae Ana y Ana Lucia, no Susana', ids('ana'), [5, 6]);

console.log('\nOrden de los resultados');
equal('el nombre que empieza con lo escrito va antes que el apellido: "ana"', ids('ana'), [5, 6]);
equal('Juan (nombre) antes que Pedro Juanes (apellido)', ids('juan'), [1, 4]);
equal('a igualdad, el orden de siempre', ids('fase 1').slice(0, 2), [1, 3]);

console.log('\nResaltado');
equal('marca lo escrito sin acentos ni mayusculas', B.highlight('Juan Pérez López', 'jua per'), '<mark>Jua</mark>n <mark>Pér</mark>ez López');
equal('sin busqueda solo escapa', B.highlight('Casa <5> & "A"', ''), 'Casa &lt;5&gt; &amp; &quot;A&quot;');
equal('lo que viene de la base nunca se vuelve HTML', B.highlight('<img src=x onerror=alert(1)>', 'img'), '&lt;<mark>img</mark> src=x onerror=alert(1)&gt;');
equal('una busqueda que no coincide no marca nada', B.highlight('Susana', 'xyz'), 'Susana');
equal('palabras repetidas o encimadas se unen', B.highlight('Juan', 'ju jua'), '<mark>Jua</mark>n');
equal('nunca deja una etiqueta abierta aunque la busqueda traiga signos', /^[^<]*(<mark>[^<]*<\/mark>[^<]*)*$/.test(B.highlight('a<b>c', '<b>')), true);

console.log('\nCasos raros');
equal('valores vacios o raros en los campos no rompen', B.filter([{ n: null }, { n: undefined }, { n: 5 }, { n: 'cinco' }], 'cin', (x) => [x.n]).length, 1);
equal('un item sin campos no coincide ni rompe', B.filter([{}], 'a', () => []), []);
equal('lista invalida', [B.filter(null, 'a', fields), B.filter(undefined, '', fields)], [[], []]);
equal('acepta la busqueda ya procesada', B.filter(people, B.query('perez'), fields).length, 1);
equal('texto muy largo no se cuelga', B.filter(people, 'a '.repeat(500), fields).length, 3);
equal('emoji y signos no rompen el plegado', B.fold('Juan 😀 Pérez').length, 'Juan 😀 Pérez'.length);

console.log('\nLas pantallas usan la misma busqueda');
const oikos = read('finanzas/index.html');
const admin = read('admin.html');
const auditor = read('auditor.html');
const version = (html, file) => (html.match(new RegExp(`${file.replace('.', '\\.')}\\?v=(\\w+)`)) || [])[1];
yes('OIKOS, admin y auditor cargan sisdel-busqueda.js con la misma version', version(oikos, 'sisdel-busqueda.js') && version(oikos, 'sisdel-busqueda.js') === version(admin, 'sisdel-busqueda.js') && version(admin, 'sisdel-busqueda.js') === version(auditor, 'sisdel-busqueda.js'));
const rondin = read('rondin/index.html');
const rondinApp = read('rondin/js/app.js');
yes('RONDIN carga el modulo (misma version) y su busqueda de rutas lo usa', version(rondin, 'sisdel-busqueda.js') === version(admin, 'sisdel-busqueda.js') && rondin.indexOf('sisdel-busqueda.js') < rondin.indexOf('js/app.js') && /SisdelBusqueda\.filter\(this\._allMonitorRoutes, q, r => \[r\.name, r\.route_code\]\)/.test(rondinApp) && version(rondin, 'app.js') !== '20260522k');
yes('el modulo se carga antes que el codigo que lo usa', admin.indexOf('sisdel-busqueda.js') < admin.indexOf('const userSearchFields') && auditor.indexOf('sisdel-busqueda.js') < auditor.indexOf('function matches(') && oikos.indexOf('sisdel-busqueda.js') < oikos.indexOf('function renderResidents()'));
yes('la lista de residentes de OIKOS filtra con la busqueda inteligente', /function residentSearchFields\(r\)/.test(oikos) && /SisdelBusqueda\.filter\(res, search, residentSearchFields\)/.test(oikos) && !/n\.includes\(search\) \|\| u\.includes\(search\)/.test(oikos));
yes('la lista de empresas del programador tambien', /SisdelBusqueda\.filter\(companies, search, \(c\) => \[c\.name, c\.nit, c\.director\]\)/.test(oikos));
yes('los usuarios de admin (lista y Configuracion) filtran con la busqueda inteligente', /const userSearchFields = \(u\) => \[u\.name, u\.casa, u\.fase, u\.cargo\]/.test(admin) && (admin.match(/SisdelBusqueda\.filter\(/g) || []).length === 2);
yes('admin ya no pasa la busqueda a minusculas a mano (el modulo la procesa)', !/searchQuery = e\.target\.value\.toLowerCase\(\)/.test(admin) && !/cfgQuery = e\.target\.value\.toLowerCase\(\)/.test(admin));
yes('las cuatro busquedas del auditor usan el modulo y no la coincidencia simple', /function matches\(query, \.\.\.fields\) \{[\s\S]{0,200}SisdelBusqueda\.score\(query, fields\) > 0/.test(auditor) && !/includes\(query\)\)/.test(auditor.split('function matches(')[1].split('const LOG_STATUS')[0]) && !/\.value\.trim\(\)\.toLowerCase\(\)/.test(auditor));

console.log('\nFormulario del residente de OIKOS: tamano, navegacion y buscador');
yes('el formulario se ve un 30 % mas grande (zoom 1.3, con su alto maximo ajustado para no pasar de la pantalla)', /@media \(min-width: 640px\) \{ #modal-resident > div \{ zoom: 1\.3; max-height: calc\(92vh \/ 1\.3\); \} \}/.test(oikos));
yes('tiene Anterior, Siguiente, contador y buscador, fuera del formulario (no cuentan como cambios)', /id="res-prev" onclick="resNavigate\(-1\)"/.test(oikos) && /id="res-next" onclick="resNavigate\(1\)"/.test(oikos) && /id="res-nav-count"/.test(oikos) && oikos.indexOf('id="res-jump"') < oikos.indexOf('id="form-resident"'));
yes('el buscador muestra resultados mientras se escribe (oninput), con el principio de cada palabra', /id="res-jump"[^>]*oninput="resJumpSearch\(\)"/.test(oikos) && /SisdelBusqueda\.filter\(Store\.get\('residents'\), text, residentSearchFields\)/.test(oikos));
yes('los resultados escapan lo que viene de la base y no llevan ids en onclick', /data-res-pick="\$\{esc\(r\.id\)\}"/.test(oikos) && /SisdelBusqueda\.highlight\(r\.name/.test(oikos) && !/onclick="resGoTo\(/.test(oikos));
yes('hay "Guardar y siguiente" (o "agregar otro" al crear) y guarda antes de pasar', /id="btn-res-save-next"/.test(oikos) && /resAfterSave = residentBeingEditedId \? 'next' : 'new'/.test(oikos) && /if \(after === 'next' && id\)/.test(oikos) && /if \(after === 'new'\) \{ openModal\('modal-resident'\); return; \}/.test(oikos));
yes('pasar a otro vecino con cambios sin guardar pregunta antes', /function resGoTo\(id\) \{\s*if \(resIsDirty\(\) && !confirm\(/.test(oikos) && /resMarkClean\(\); resNavRefresh\(\);/.test(oikos));
yes('Anterior y Siguiente recorren la lista tal como se ve (con su busqueda)', /function resNeighbors\(id\) \{\s*let list = visibleResidents\(\);/.test(oikos));
yes('registrar un ingreso y cargar a un residente tienen busqueda dentro de la lista', /initResidentPicker\('inc-resident'\)/.test(oikos) && /initResidentPicker\('bulk-resident'\)/.test(oikos) && /function filterResidentPicker\(selectId\)/.test(oikos));
yes('mientras se busca no queda ningun vecino elegido por accidente', /sel\.selectedIndex = -1;/.test(oikos) && /sel\.size = Math\.min\(6, Math\.max\(2, found\.length\)\)/.test(oikos));
yes('la navegacion y el buscador tambien se ocultan por privilegio (residentes_editar)', /\['#residents-table-body button\[onclick\^="editResident\("\]', '#res-nav', '#res-jump-wrap'\]/.test(read('finanzas-bloqueo.js')));

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
