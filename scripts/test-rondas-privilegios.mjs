// Pruebas de los privilegios de RONDIN (rondin/js/privilegios-rondin.js y su uso en sisdel-api.js): sin emuladores.
// Uso: node test-rondas-privilegios.mjs (tambien corre con npm test).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const R = require('../rondin/js/privilegios-rondin.js').internals;
const PRIV = require('../privilegios.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const api = readFileSync(path.join(here, '../rondin/js/sisdel-api.js'), 'utf8');
const indexHtml = readFileSync(path.join(here, '../rondin/index.html'), 'utf8');

let passed = 0;
const failures = [];
function equal(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FALLA ${name} -> esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
}

const canOf = (role, overrides = {}) => (key) => PRIV.has(role, overrides, key);
const allowed = (can, calls) => calls.map(([m, p]) => R.canRoute(m, p, can));
const T = true;
const F = false;

// Llamadas de RONDIN agrupadas
const READS = [
    ['GET', '/api/users'], ['GET', '/api/users/supervisors'], ['GET', '/api/routes'], ['GET', '/api/routes/r1'], ['GET', '/api/route-assignments'],
    ['GET', '/api/shifts'], ['GET', '/api/rounds'], ['GET', '/api/checkpoint-visits/today'], ['GET', '/api/checkpoint-visits/by-route/r1'],
    ['GET', '/api/checkpoint-visits/history/r1'], ['GET', '/api/tracking/live'], ['GET', '/api/tracking/history'], ['GET', '/api/incidents'],
    ['GET', '/api/alerts'], ['GET', '/api/dashboard/stats'], ['GET', '/api/dashboard/compliance'], ['GET', '/api/dashboard/recent-activity'],
    ['GET', '/api/dg/summary'], ['GET', '/api/dg/critical-alerts'], ['GET', '/api/dg/ai-report'], ['GET', '/api/dg/weekly-report'],
    ['GET', '/api/neighbors'], ['GET', '/api/drones']
];
const MANAGE = [
    ['POST', '/api/routes'], ['PUT', '/api/routes/r1'], ['DELETE', '/api/routes/r1'], ['POST', '/api/routes/r1/checkpoints'],
    ['PUT', '/api/routes/checkpoints/c1'], ['DELETE', '/api/routes/checkpoints/c1'], ['POST', '/api/route-assignments'],
    ['PUT', '/api/route-assignments/a1'], ['DELETE', '/api/route-assignments/a1'], ['PUT', '/api/alerts/a1/acknowledge'], ['DELETE', '/api/alerts/a1'],
    ['PUT', '/api/incidents/i1'], ['PUT', '/api/users/u1/assign-supervisor'], ['PUT', '/api/companies/c/config'], ['POST', '/api/drones'],
    ['POST', '/api/drones/d1/telemetry']
];
const PATROL = [
    ['GET', '/api/my-assignment'], ['POST', '/api/shifts'], ['POST', '/api/shifts/s1/checkin'], ['POST', '/api/shifts/s1/checkout'], ['POST', '/api/rounds/start'],
    ['POST', '/api/checkpoint-visits'], ['POST', '/api/tracking'], ['POST', '/api/incidents'], ['POST', '/api/panic']
];

console.log('\nAcceso de siempre de los roles (no cambia con los privilegios nuevos)');
const admin = canOf('admin');
const supervisor = canOf('supervisor');
const auditor = canOf('auditor');
const guard = canOf('policia');
equal('el administrador lee todo y administra todo', [allowed(admin, READS).every(Boolean), allowed(admin, MANAGE).every(Boolean)], [T, T]);
equal('el administrador puede reportar un incidente, como antes', allowed(admin, [['POST', '/api/incidents']]), [T]);
equal('el administrador no patrulla', allowed(admin, [['POST', '/api/shifts/s1/checkin'], ['POST', '/api/tracking'], ['POST', '/api/checkpoint-visits'], ['POST', '/api/panic']]), [F, F, F, F]);
equal('el supervisor lee, administra y patrulla', [allowed(supervisor, READS).every(Boolean), allowed(supervisor, MANAGE).every(Boolean), allowed(supervisor, PATROL).every(Boolean)], [T, T, T]);
equal('el auditor lee todo y no escribe nada', [allowed(auditor, READS).every(Boolean), allowed(auditor, MANAGE).some(Boolean), allowed(auditor, PATROL).some(Boolean)], [T, F, F]);
equal('el guardia patrulla y no administra ni lee el panel', [
    allowed(guard, PATROL).every(Boolean), allowed(guard, MANAGE).some(Boolean),
    allowed(guard, [['GET', '/api/users'], ['GET', '/api/alerts'], ['GET', '/api/dashboard/stats'], ['GET', '/api/tracking/live'], ['GET', '/api/incidents']]).some(Boolean)
], [T, F, F]);
equal('el guardia lee su ruta y sus turnos', allowed(guard, [['GET', '/api/routes/r1'], ['GET', '/api/shifts'], ['GET', '/api/routes']]), [T, T, T]);
equal('el vecino no usa las rutas de rondas', allowed(canOf('vecino'), [...READS, ...MANAGE]).some(Boolean), F);

console.log('\nOperador a la medida');
// Igual que la pantalla de privilegios: al activar una accion se activan su paraguas y lo que necesita
const op = (...keys) => {
    const set = new Set();
    keys.forEach((k) => PRIV.toggle(set, k, true));
    return canOf('operador', PRIV.toOverrides('operador', set));
};
const onlyAlerts = op('rondas.alertas_ver');
equal('con solo "ver alertas" lee alertas y nada mas', [
    allowed(onlyAlerts, [['GET', '/api/alerts']])[0], allowed(onlyAlerts, [['GET', '/api/incidents'], ['GET', '/api/dashboard/stats'], ['GET', '/api/tracking/live'], ['GET', '/api/neighbors'], ['GET', '/api/drones']]).some(Boolean)
], [T, F]);
equal('con solo "ver alertas" no puede atender ni borrar', allowed(onlyAlerts, [['PUT', '/api/alerts/a1/acknowledge'], ['DELETE', '/api/alerts/a1']]), [F, F]);
equal('su unica pantalla es Alertas', [R.firstPage(onlyAlerts), R.PAGE_ORDER.filter((p) => R.pageAllowed(p, onlyAlerts))], ['alerts', ['alerts']]);
const ackOnly = op('rondas.alertas_ver', 'rondas.alertas_atender');
equal('"atender alertas" arrastra gestionar y ver, pero no borrar', [allowed(ackOnly, [['PUT', '/api/alerts/a1/acknowledge']])[0], allowed(ackOnly, [['DELETE', '/api/alerts/a1'], ['POST', '/api/routes']]).some(Boolean)], [T, F]);
const routesOnly = op('rondas.rutas_ver', 'rondas.rutas_crear', 'rondas.puntos_crear');
equal('rutas: crea rutas y puntos pero no los elimina ni los renombra', allowed(routesOnly, [['POST', '/api/routes'], ['POST', '/api/routes/r1/checkpoints'], ['DELETE', '/api/routes/r1'], ['DELETE', '/api/routes/checkpoints/c1'], ['PUT', '/api/routes/checkpoints/c1']]), [T, T, F, F, F]);
const patrolPartial = op('rondas.patrullar', 'rondas.patrulla_iniciar', 'rondas.patrulla_terminar');
equal('guardia sin marcar puntos ni rastrear', allowed(patrolPartial, [['POST', '/api/shifts/s1/checkin'], ['POST', '/api/shifts/s1/checkout'], ['POST', '/api/checkpoint-visits'], ['POST', '/api/tracking'], ['POST', '/api/incidents']]), [T, T, F, F, F]);
const panelOnly = op('rondas.panel_ver');
equal('solo el panel principal no ve la inteligencia operativa ni el reporte semanal', allowed(panelOnly, [['GET', '/api/dashboard/stats'], ['GET', '/api/dg/summary'], ['GET', '/api/dg/ai-report'], ['GET', '/api/dg/weekly-report']]), [T, T, F, F]);
const noExpediente = op('rondas.guardias_ver');
equal('ver guardias no trae el expediente (privilegio aparte)', [noExpediente('rondas.guardias_ver'), noExpediente('rondas.guardias_expediente')], [T, F]);
const unused = op();
equal('un operador sin privilegios no entra a ninguna pantalla', [R.firstPage(unused), allowed(unused, [...READS, ...MANAGE, ...PATROL]).some(Boolean)], [null, F]);

console.log('\nPantallas y hoja de estilos');
equal('el administrador ve todas las pantallas', R.PAGE_ORDER.every((p) => R.pageAllowed(p, admin)), T);
equal('el administrador no pierde ningun boton', R.cssFor(admin).includes('.card:has(#dgTrendChart)') || /btn-start-round|guardReportIncident|activatePanic/.test(R.cssFor(admin)), T);
equal('el guardia solo oculta lo de administrar (no sus botones)', ['#btn-start-round', '#btn-end-round', 'App.guardReportIncident', 'App.activatePanic', '#btn-send-checkpoint'].some((s) => R.cssFor(guard).includes(s)), F);
equal('el auditor ve las pantallas pero no los botones de escritura', [
    R.PAGE_ORDER.filter((p) => !R.pageAllowed(p, auditor)),
    ['App.showNewMonitorRoute', 'App.deleteRoute', 'App.assignGuardToRoute', 'App.ackAlert', 'App.assignGuardToSupervisor', '#cfg-panic-toggle'].every((s) => R.cssFor(auditor).includes(s))
], [[], T]);
equal('el auditor sigue viendo el reporte semanal y la inteligencia operativa', [R.cssFor(auditor).includes('printDgReport'), R.cssFor(auditor).includes('dgTrendChart')], [F, F]);
equal('las pantallas huerfanas nunca se abren', ['routes', 'users', 'shifts', 'companies'].map((p) => R.pageAllowed(p, admin)), [F, F, F, F]);
equal('un operador solo ve su menu', (() => {
    const css = R.cssFor(onlyAlerts);
    return ['dashboard', 'monitoreo_ruta', 'drones', 'monitoring', 'guardias', 'supervisores', 'incidents', 'vecinos', 'config'].every((p) => css.includes(`data-page="${p}"`)) && !css.includes('data-page="alerts"');
})(), T);

console.log('\nCobertura: ninguna ruta ni privilegio queda sin cubrir');
const names = PRIV.ITEMS.filter((i) => i.key.startsWith('rondas.')).map((i) => i.key);
const used = new Set();
R.ROUTES.forEach(([, , keys]) => keys.forEach((k) => used.add(k)));
Object.values(R.PAGES).forEach((keys) => keys.forEach((k) => used.add(k)));
R.HIDE.forEach(([keys]) => keys.forEach((k) => used.add(k)));
Object.values(R.GUARDED).forEach((keys) => keys.forEach((k) => used.add(k)));
equal('toda clave de rondas.* (salvo los tres accesos) se usa en el bloqueo de RONDIN', names.filter((k) => !['rondas.ver', 'rondas.gestionar', 'rondas.patrullar'].includes(k) && !used.has(k)), []);
equal('el bloqueo no menciona claves que no existen en el catalogo', [...used].filter((k) => !PRIV.ITEMS.some((i) => i.key === k)), []);

// Toda ruta del adaptador exige un privilegio, salvo la lista de rutas abiertas
const registered = [...api.matchAll(/\bon\('(GET|POST|PUT|DELETE)',\s*'([^']+)'/g)].map((m) => [m[1], m[2].replace(/:[A-Za-z]+/g, 'x1')]);
const OPEN = [
    ['POST', '/api/auth/login'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['GET', '/api/companies'], ['GET', '/api/companies/all'],
    ['POST', '/api/companies/x1/reset-dg-pin'], ['POST', '/api/companies/master-login'], ['GET', '/api/neighbors/by-code/x1'], ['POST', '/api/neighbors/panic'],
    ['GET', '/api/fcm/config'], ['POST', '/api/fcm/token'], ['GET', '/api/ping']
];
const openKey = (m, p) => OPEN.some(([om, op2]) => om === m && op2 === p);
const uncovered = registered.filter(([m, p]) => !openKey(m, p) && R.routeKeys(m, p) === null);
equal('hay rutas registradas en el adaptador', registered.length > 60, T);
equal('toda ruta del adaptador exige un privilegio o esta en la lista de rutas abiertas', uncovered, []);

console.log('\nUso en el adaptador');
equal('route() revisa el privilegio de la ruta antes de atenderla', /RondinPrivilegios\.internals\.canRoute\(method, path, can\)/.test(api), T);
equal('el adaptador instala los privilegios antes de que App.init pinte', /RondinPrivilegios\.install\(App, can, document/.test(api), T);
equal('el modulo se carga antes que el adaptador', indexHtml.indexOf('privilegios-rondin.js') > 0 && indexHtml.indexOf('privilegios-rondin.js') < indexHtml.indexOf('sisdel-api.js'), T);
equal('las escuchas en tiempo real se abren segun el privilegio de lo que escuchan', ['rondas.monitoreo_ver', 'rondas.recorridos_ver', 'rondas.incidentes_ver', 'rondas.alertas_ver', 'rondas.drones_ver'].every((k) => api.includes(`can('${k}')`)), T);
equal('despachar un dron exige operarlo', /can\('rondas\.drones_operar'\)/.test(api), T);
equal('el expediente del guardia es un privilegio aparte', /can\('rondas\.guardias_expediente'\)/.test(api), T);
equal('el tablero tolera lecturas sin permiso', /const orEmpty = /.test(api), T);
equal('el modulo y el adaptador comparten version en el HTML', (() => {
    const v = (f) => (indexHtml.match(new RegExp(f.replace('.', '\\.') + '\\?v=(\\d+[a-z]?)')) || [])[1];
    return v('privilegios-rondin.js') === v('sisdel-api.js') && !!v('sisdel-api.js');
})(), T);

console.log(`\nResultado: ${passed} correctas, ${failures.length} fallas`);
if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
process.exit(failures.length ? 1 : 0);
