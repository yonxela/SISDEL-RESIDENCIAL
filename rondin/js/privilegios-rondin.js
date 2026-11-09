/* ═══════════════════════════════════════════════════════════════
   SISDEL RONDIN - Privilegios por usuario (rondas.*)
   ───────────────────────────────────────────────────────────────
   RONDIN (app.js, style.css, i18n.js) se usa tal cual. Este archivo define, con datos y
   funciones puras (se prueban en scripts/test-rondas-privilegios.mjs), que privilegio
   exige cada ruta /api/..., cada pantalla del menu y cada boton, y los aplica:

     - route() de sisdel-api.js revisa ROUTES antes de atender una llamada (403 si falta).
       Es la barrera de este lado: cubre API.*, fetch y la consola.
     - install() oculta con una hoja de estilos lo que el usuario no puede usar, deja
       entrar solo a las pantallas permitidas (App.navigate) y avisa si intenta una accion
       sin privilegio (metodos de App envueltos).

   Lo que se guarda lo garantizan firestore.rules (por coleccion y operacion). Ocultar
   pantallas de LECTURA con estilos (panel, expediente del guardia...) es solo de pantalla.
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.RondinPrivilegios = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const r = (name) => 'rondas.' + name;
    const list = (...names) => names.map(r);

    // Rutas /api/... -> privilegios (basta UNO). Las rutas que no aparecen no exigen privilegio extra
    // (sesion, configuracion publica, latido). Cada fila: [metodo, expresion de la ruta, privilegios].
    const ROUTES = [
        ['GET', /^\/api\/users$/, list('guardias_ver', 'supervisores_ver', 'asignaciones_ver', 'monitoreo_ver', 'recorridos_ver', 'rutas_ver')],
        ['GET', /^\/api\/users\/supervisors$/, list('supervisores_ver')],
        ['PUT', /^\/api\/users\/[^/]+\/assign-supervisor$/, list('supervisores_asignar')],
        ['POST', /^\/api\/users$/, ['guardias.crear', 'usuarios.crear']],
        ['PUT', /^\/api\/users\/[^/]+$/, ['usuarios.editar']],
        ['DELETE', /^\/api\/users\/[^/]+$/, ['usuarios.eliminar', 'usuarios.editar']],

        ['GET', /^\/api\/routes$/, list('rutas_ver', 'monitoreo_ver', 'recorridos_ver', 'asignaciones_ver', 'patrulla_iniciar', 'patrulla_marcar', 'patrulla_terminar')],
        ['GET', /^\/api\/routes\/[^/]+$/, list('rutas_ver', 'monitoreo_ver', 'recorridos_ver', 'asignaciones_ver', 'patrulla_iniciar', 'patrulla_marcar', 'patrulla_terminar')],
        ['GET', /^\/api\/checkpoints$/, list('rutas_ver', 'monitoreo_ver', 'recorridos_ver', 'patrulla_marcar')],
        ['POST', /^\/api\/routes$/, list('rutas_crear')],
        ['PUT', /^\/api\/routes\/checkpoints\/[^/]+$/, list('puntos_editar')],
        ['DELETE', /^\/api\/routes\/checkpoints\/[^/]+$/, list('puntos_eliminar')],
        ['POST', /^\/api\/routes\/[^/]+\/checkpoints$/, list('puntos_crear')],
        ['PUT', /^\/api\/routes\/[^/]+$/, list('rutas_crear')],
        ['DELETE', /^\/api\/routes\/[^/]+$/, list('rutas_eliminar')],

        ['GET', /^\/api\/route-assignments$/, list('asignaciones_ver', 'monitoreo_ver', 'recorridos_ver', 'rutas_ver', 'patrulla_iniciar')],
        ['POST', /^\/api\/route-assignments$/, list('asignaciones_crear')],
        ['PUT', /^\/api\/route-assignments\/[^/]+$/, list('asignaciones_editar')],
        ['DELETE', /^\/api\/route-assignments\/[^/]+$/, list('asignaciones_eliminar')],
        ['GET', /^\/api\/my-assignment$/, list('patrulla_iniciar', 'patrulla_marcar', 'patrulla_terminar')],

        ['GET', /^\/api\/shifts$/, list('panel_ver', 'monitoreo_ver', 'recorridos_ver', 'asignaciones_ver', 'patrulla_iniciar', 'patrulla_terminar')],
        ['POST', /^\/api\/shifts$/, list('patrulla_iniciar', 'asignaciones_crear')],
        ['POST', /^\/api\/shifts\/[^/]+\/checkin$/, list('patrulla_iniciar')],
        ['POST', /^\/api\/shifts\/[^/]+\/checkout$/, list('patrulla_terminar')],
        ['POST', /^\/api\/rounds\/start$/, list('patrulla_iniciar')],
        ['GET', /^\/api\/rounds$/, list('panel_ver', 'patrulla_iniciar', 'patrulla_marcar')],
        ['POST', /^\/api\/checkpoint-visits$/, list('patrulla_marcar')],
        ['GET', /^\/api\/checkpoint-visits\/(today|by-route\/[^/]+|history\/[^/]+)$/, list('recorridos_ver', 'monitoreo_ver', 'rutas_ver')],

        ['POST', /^\/api\/tracking$/, list('patrulla_rastrear')],
        ['GET', /^\/api\/tracking\/live$/, list('monitoreo_ver')],
        ['GET', /^\/api\/tracking\/history$/, list('monitoreo_historial')],

        ['GET', /^\/api\/incidents$/, list('incidentes_ver')],
        ['POST', /^\/api\/incidents$/, list('incidentes_reportar', 'gestionar')],
        ['PUT', /^\/api\/incidents\/[^/]+$/, list('incidentes_resolver')],

        ['GET', /^\/api\/alerts$/, list('alertas_ver')],
        ['PUT', /^\/api\/alerts\/[^/]+\/acknowledge$/, list('alertas_atender')],
        ['DELETE', /^\/api\/alerts\/[^/]+$/, list('alertas_eliminar')],

        ['POST', /^\/api\/panic$/, ['panico.activar']],
        ['GET', /^\/api\/panic$/, ['panico.ver']],
        ['PUT', /^\/api\/panic\/[^/]+$/, ['panico.atender']],

        ['GET', /^\/api\/dashboard\/(stats|compliance|recent-activity|route-stats)$/, list('panel_ver')],
        ['GET', /^\/api\/dg\/(summary|critical-alerts|route-stats)$/, list('panel_ver')],
        ['GET', /^\/api\/dg\/ai-report$/, list('reportes_ver')],
        ['GET', /^\/api\/dg\/weekly-report$/, list('reportes_imprimir')],

        ['GET', /^\/api\/neighbors$/, list('vecinos_ver')],
        ['POST', /^\/api\/neighbors$/, ['usuarios.crear']],
        ['PUT', /^\/api\/neighbors\/[^/]+$/, ['usuarios.editar']],
        ['DELETE', /^\/api\/neighbors\/[^/]+$/, ['usuarios.eliminar']],
        ['GET', /^\/api\/neighbors\/panic-events$/, ['panico.ver']],

        ['GET', /^\/api\/drones$/, list('drones_ver')],
        ['POST', /^\/api\/drones$/, list('drones_registrar')],
        ['POST', /^\/api\/drones\/[^/]+\/telemetry$/, list('drones_operar')],
        ['GET', /^\/api\/drones\/[^/]+\/telemetry\/latest$/, list('drones_ver')],

        ['PUT', /^\/api\/companies\/[^/]+(\/config)?$/, list('ajustes_panicovecinos')]
    ];

    // Privilegios (basta uno) que abren cada pantalla del menu; el orden es el de la barra lateral
    const PAGES = {
        dashboard: list('panel_ver'),
        monitoreo_ruta: list('rutas_ver', 'asignaciones_ver', 'recorridos_ver'),
        drones: list('drones_ver'),
        monitoring: list('monitoreo_ver'),
        alerts: list('alertas_ver'),
        guardias: list('guardias_ver'),
        supervisores: list('supervisores_ver'),
        incidents: list('incidentes_ver'),
        vecinos: list('vecinos_ver'),
        config: list('ajustes_ver')
    };
    const PAGE_ORDER = Object.keys(PAGES);

    // Botones y bloques: sin ninguno de los privilegios se ocultan. Los botones de RONDIN se pintan con
    // innerHTML en cada pantalla, asi que se eligen por su atributo onclick (la hoja sobrevive a los repintados).
    const HIDE = [
        [list('rutas_crear'), ['button[onclick="App.showNewMonitorRoute()"]', 'button[onclick="App.showRouteModal()"]']],
        [list('rutas_eliminar'), ['button[onclick^="App.deleteRoute("]']],
        [list('puntos_crear'), ['button[onclick^="App.addCheckpoint("]']],
        [list('puntos_editar'), ['button[onclick^="App.editCheckpointName("]']],
        [list('puntos_eliminar'), ['button[onclick^="App.deleteCheckpoint("]']],
        [list('asignaciones_crear'), ['button[onclick^="App.assignGuardToRoute("]']],
        [list('asignaciones_editar'), ['button[onclick^="App.editAssignment("]']],
        [list('asignaciones_eliminar'), ['button[onclick^="App.deleteAssignment("]']],
        [list('asignaciones_ver'), ['[id^="sched_"]']],
        [list('recorridos_ver'), ['button[onclick^="App.showRouteTimeline("]', 'button[onclick^="App.showRouteVisits("]', '[onclick*="App.showRouteMap("]']],
        [list('drones_operar'), ['button[onclick^="Swal.fire(\'Comando Enviado\'"]', 'button[onclick^="Swal.fire(\'Atenci"]', 'button[onclick^="Swal.fire({title:\'SmartTrack"]']],
        [list('alertas_ver'), ['button.alert-bell', '#alert-dot']],
        [list('alertas_atender'), ['button[onclick^="App.ackAlert("]']],
        [['guardias.crear', 'usuarios.crear'], ['button[onclick="App.showGuardiaModal()"]']],
        [['usuarios.crear'], ['button[onclick="App.showSupervisorModal()"]', 'button[onclick="App.showNeighborModal()"]']],
        [list('guardias_expediente'), ['button[onclick^="App.viewGuardia("]']],
        [list('supervisores_asignar'), ['button[onclick^="App.assignGuardToSupervisor("]', 'button[onclick^="App.unassignGuard("]']],
        [['usuarios.editar'], ['button[onclick^="App.editNeighbor("]']],
        [['usuarios.eliminar'], ['button[onclick^="App.deleteNeighbor("]']],
        [list('ajustes_panicovecinos'), ['#cfg-panic-toggle', 'label:has(> #cfg-panic-toggle)']],
        [list('reportes_ver'), ['.card:has(#dgTrendChart)', '.card:has(> .card-body#dg-ai-report)']],
        [list('reportes_imprimir'), ['button[onclick="App.printDgReport()"]']],
        [list('patrulla_iniciar'), ['#btn-start-round']],
        [list('patrulla_terminar'), ['#btn-end-round']],
        [list('incidentes_reportar'), ['button[onclick="App.guardReportIncident()"]']],
        [['panico.activar'], ['button[onclick="App.activatePanic()"]']],
        [list('patrulla_marcar'), ['#btn-send-checkpoint']]
    ];

    // Metodos de App que abren una accion: sin privilegio avisan y no hacen nada
    const GUARDED = {
        showNewMonitorRoute: list('rutas_crear'), showRouteModal: list('rutas_crear'), deleteRoute: list('rutas_eliminar'),
        addCheckpoint: list('puntos_crear'), editCheckpointName: list('puntos_editar'), deleteCheckpoint: list('puntos_eliminar'),
        assignGuardToRoute: list('asignaciones_crear'), editAssignment: list('asignaciones_editar'), deleteAssignment: list('asignaciones_eliminar'),
        ackAlert: list('alertas_atender'), viewGuardia: list('guardias_expediente'),
        showGuardiaModal: ['guardias.crear', 'usuarios.crear'], showSupervisorModal: ['usuarios.crear'],
        assignGuardToSupervisor: list('supervisores_asignar'), unassignGuard: list('supervisores_asignar'),
        showNeighborModal: ['usuarios.crear', 'usuarios.editar'], editNeighbor: ['usuarios.editar'], deleteNeighbor: ['usuarios.eliminar'],
        toggleNeighborPanic: list('ajustes_panicovecinos'), printDgReport: list('reportes_imprimir'),
        guardStartRound: list('patrulla_iniciar'), guardEndRound: list('patrulla_terminar'), confirmCheckpointVisit: list('patrulla_marcar'),
        guardReportIncident: list('incidentes_reportar'), activatePanic: ['panico.activar']
    };

    const hasAny = (can, keys) => keys.some((k) => can(k));

    // Privilegios que exige una llamada a la API; null si no exige ninguno
    function routeKeys(method, path) {
        const found = ROUTES.find(([m, re]) => m === method && re.test(path));
        return found ? found[2] : null;
    }
    function canRoute(method, path, can) {
        const keys = routeKeys(method, path);
        return !keys || hasAny(can, keys);
    }

    function pageAllowed(page, can) { return !(page in PAGES) ? false : hasAny(can, PAGES[page]); }
    function firstPage(can) { return PAGE_ORDER.find((p) => pageAllowed(p, can)) || null; }

    function cssFor(can) {
        const rules = [];
        PAGE_ORDER.forEach((page) => {
            if (!pageAllowed(page, can)) rules.push(`a.nav-item[data-page="${page}"] { display: none !important; }`);
        });
        HIDE.forEach(([keys, selectors]) => {
            if (!hasAny(can, keys)) rules.push(selectors.join(',\n') + ' { display: none !important; }');
        });
        return rules.join('\n');
    }

    // Aplica lo anterior sobre la pagina viva. App es el objeto global de RONDIN (const App = {...}).
    function install(App, can, doc, ui = {}) {
        const deny = ui.deny || (() => {});
        let style = doc.getElementById('rondin-privilegios');
        if (!style) { style = doc.createElement('style'); style.id = 'rondin-privilegios'; doc.head.appendChild(style); }
        style.textContent = cssFor(can);

        // Pantallas: App.init siempre arranca en el tablero; sin privilegio se lleva a la primera permitida.
        // Las pantallas huerfanas (routes, users, shifts) y las que no existen aqui nunca se abren.
        const navigate = App.navigate;
        if (typeof navigate === 'function') {
            App.navigate = function (page, ...rest) {
                if (page in PAGES && pageAllowed(page, can)) return navigate.call(this, page, ...rest);
                const next = firstPage(can);
                if (!next) { ui.noPages && ui.noPages(); return undefined; }
                return navigate.call(this, next, ...rest);
            };
        }
        Object.entries(GUARDED).forEach(([name, keys]) => {
            const original = App[name];
            if (typeof original !== 'function') return;
            App[name] = function (...args) {
                if (!hasAny(can, keys)) { deny(); return undefined; }
                return original.apply(this, args);
            };
        });
        return { firstPage: firstPage(can) };
    }

    return {
        install,
        internals: { ROUTES, PAGES, PAGE_ORDER, HIDE, GUARDED, routeKeys, canRoute, pageAllowed, firstPage, cssFor }
    };
});
