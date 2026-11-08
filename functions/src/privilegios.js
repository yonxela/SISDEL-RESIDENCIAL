/* ═══════════════════════════════════════════════════════════════
   SISDEL - Catalogo de privilegios
   ───────────────────────────────────────────────────────────────
   Fuente unica de los privilegios que el administrador de cada condominio
   asigna por usuario. Se carga en el navegador (<script src="privilegios.js">)
   y en Node (functions/src/privilegios.js es una copia identica; la prueba
   scripts/test-privilegios.mjs falla si difieren).

   Modelo:
   - Cada rol trae unos privilegios por defecto (campo `roles` de cada clave).
     Esos son EXACTAMENTE los accesos que el rol tenia antes de existir este
     modulo: un usuario sin privilegios asignados no pierde ni gana nada.
   - usuarios/{id}.privilegios guarda solo las diferencias con su rol:
     { clave: true } agrega un privilegio, { clave: false } lo quita.
   - El rol `operador` no trae ninguno: es el personal "a la medida".
   - Las reglas de Firestore (firestore.rules, funciones pXxx) leen ese mapa
     del documento del usuario, asi que aplica al instante y no depende del
     token. La prueba scripts/test-privilegios.mjs verifica que las reglas usen
     las mismas claves y los mismos roles por defecto que este catalogo.
   ═══════════════════════════════════════════════════════════════ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SisdelPrivilegios = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ROLES = ['admin', 'policia', 'supervisor', 'auditor', 'vecino', 'operador'];

    const ROLE_LABELS = {
        master: 'Master', admin: 'Administrador', policia: 'Policía / Guardia', supervisor: 'Supervisor de rondas',
        auditor: 'Auditor', vecino: 'Vecino', operador: 'Operador (privilegios a la medida)'
    };

    // Cada clave: label (lo que ve el administrador), description, roles (quienes la tienen por defecto),
    // requires (otras claves sin las que no funciona), sensitive (poder amplio: asignar con cuidado).
    const GROUPS = [
        {
            id: 'usuarios', title: 'Usuarios y vecinos', items: [
                { key: 'usuarios.panel', label: 'Entrar al panel de administración', description: 'Abre admin.html: lista de usuarios, estadísticas y mensajes.', roles: ['admin'], requires: ['usuarios.ver'] },
                { key: 'usuarios.ver', label: 'Ver usuarios y vecinos', description: 'Consultar la lista de vecinos y personal (sin códigos de acceso).', roles: ['admin', 'policia', 'supervisor', 'auditor'] },
                { key: 'usuarios.crear', label: 'Crear usuarios', description: 'Registrar vecinos, auditores y supervisores con su código de acceso.', roles: ['admin'], requires: ['usuarios.ver'] },
                { key: 'guardias.crear', label: 'Registrar guardias', description: 'Crear guardias (solo ese rol) y ver el código de acceso de los guardias.', roles: ['admin', 'supervisor'], requires: ['usuarios.ver'] },
                { key: 'usuarios.editar', label: 'Editar usuarios', description: 'Cambiar nombre, casa, teléfono y estado de pago, y registrar placas de un vecino.', roles: ['admin'], requires: ['usuarios.ver'] },
                { key: 'usuarios.eliminar', label: 'Eliminar usuarios', description: 'Borrar usuarios con su código, vehículos y visitas.', roles: ['admin'], requires: ['usuarios.ver'], sensitive: true },
                { key: 'usuarios.codigos', label: 'Ver y cambiar códigos de acceso', description: 'Ver el código de cualquier usuario y reemplazarlo por otro.', roles: ['admin'], requires: ['usuarios.ver'], sensitive: true },
                { key: 'usuarios.privilegios', label: 'Asignar privilegios', description: 'Cambiar los privilegios de otros usuarios y crear administradores y operadores. Equivale a control total del condominio: darlo solo a administradores de confianza.', roles: ['admin'], requires: ['usuarios.ver'], sensitive: true }
            ]
        },
        {
            id: 'mensajes', title: 'Mensajes', items: [
                { key: 'mensajes.enviar', label: 'Enviar y borrar mensajes', description: 'Escribir avisos para vecinos y guardias y borrar los enviados.', roles: ['admin'] },
                { key: 'mensajes.historial', label: 'Ver todos los mensajes', description: 'Leer los mensajes enviados a cualquier grupo, no solo los propios.', roles: ['admin', 'auditor'] }
            ]
        },
        {
            id: 'visitas', title: 'Visitas y vehículos', items: [
                { key: 'visitas.ver', label: 'Ver visitas y vehículos', description: 'Consultar las visitas y los vehículos de todos los vecinos.', roles: ['admin', 'policia', 'auditor'] },
                { key: 'visitas.gestionar', label: 'Gestionar visitas y vehículos', description: 'Crear, editar y borrar visitas y vehículos de cualquier vecino, y limpiar el historial de la cámara.', roles: ['admin'], requires: ['visitas.ver'] }
            ]
        },
        {
            id: 'garita', title: 'Garita y cámara', items: [
                { key: 'garita.operar', label: 'Operar la garita', description: 'Abre garita.html: escanear códigos y placas, verificar vecinos y registrar ingresos.', roles: ['admin', 'policia'], requires: ['usuarios.ver', 'visitas.ver'] },
                { key: 'garita.camara', label: 'Ver el historial de la cámara', description: 'Consultar los accesos y lecturas de la cámara de placas.', roles: ['admin', 'policia', 'auditor'] }
            ]
        },
        {
            id: 'vecino', title: 'Panel del vecino', items: [
                { key: 'vecino.visitas', label: 'Crear pases de visita', description: 'El vecino genera y cancela los pases de sus visitas.', roles: ['vecino'] },
                { key: 'vecino.vehiculos', label: 'Registrar sus vehículos', description: 'El vecino registra y quita sus vehículos.', roles: ['vecino'] },
                { key: 'panico.activar', label: 'Usar el botón de pánico', description: 'Enviar una alerta de pánico a la garita y a la administración.', roles: ['vecino', 'policia', 'supervisor'] }
            ]
        },
        {
            id: 'panico', title: 'Alertas de pánico', items: [
                { key: 'panico.ver', label: 'Ver alertas de pánico', description: 'Ver las alertas y los contactos de emergencia de los vecinos.', roles: ['admin', 'policia', 'supervisor', 'auditor'] },
                { key: 'panico.atender', label: 'Atender alertas de pánico', description: 'Marcar las alertas como atendidas o resueltas.', roles: ['admin', 'policia', 'supervisor'], requires: ['panico.ver'] }
            ]
        },
        {
            id: 'finanzas', title: 'Sistema Financiero', items: [
                { key: 'finanzas.ver', label: 'Leer datos financieros', description: 'Ver cuotas, cargos y pagos de los residentes (solo lectura).', roles: ['admin', 'auditor'] },
                { key: 'finanzas.usar', label: 'Usar el Sistema Financiero', description: 'Abre finanzas.html: cargos, pagos, egresos y reportes. Para registrar residentes nuevos o cambiar sus datos desde ahí también necesita Crear usuarios y Editar usuarios.', roles: ['admin'], requires: ['finanzas.ver', 'usuarios.ver'], sensitive: true }
            ]
        },
        {
            id: 'rondas', title: 'Rondas de vigilancia', items: [
                { key: 'rondas.ver', label: 'Ver el panel de rondas', description: 'Consultar rutas, turnos, rondas, incidentes y la posición de los guardias (solo lectura).', roles: ['admin', 'supervisor', 'auditor'] },
                { key: 'rondas.gestionar', label: 'Administrar rondas', description: 'Crear rutas y asignaciones, resolver incidentes, manejar drones y la configuración de rondas.', roles: ['admin', 'supervisor'], requires: ['rondas.ver'] },
                { key: 'rondas.patrullar', label: 'Patrullar', description: 'Iniciar turnos y rondas, marcar puntos de control y reportar incidentes desde el teléfono.', roles: ['policia', 'supervisor'] }
            ]
        },
        {
            id: 'auditoria', title: 'Auditoría', items: [
                { key: 'auditoria.ver', label: 'Entrar al panel de auditoría', description: 'Abre auditor.html: usuarios, visitas, vehículos, accesos, mensajes y reportes (cada pestaña pide su privilegio de lectura).', roles: ['auditor'] },
                { key: 'auditoria.exportar', label: 'Exportar reportes', description: 'Descargar los reportes del panel de auditoría en CSV.', roles: ['auditor'], requires: ['auditoria.ver'] }
            ]
        }
    ];

    const ITEMS = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id, groupTitle: g.title })));
    const BY_KEY = Object.fromEntries(ITEMS.map((i) => [i.key, i]));
    const KEYS = ITEMS.map((i) => i.key);

    // Paginas y quien puede abrirlas. `any`: basta con una clave; `role`: solo ese rol.
    // El orden es el de preferencia cuando el login busca a donde mandar a un usuario.
    const PAGES = [
        { page: 'admin.html', label: 'Administración', any: ['usuarios.panel'] },
        { page: 'garita.html', label: 'Garita', any: ['garita.operar'] },
        { page: 'auditor.html', label: 'Auditoría', any: ['auditoria.ver'] },
        { page: 'finanzas.html', label: 'Finanzas', any: ['finanzas.usar'] },
        { page: 'rondin/', label: 'Rondas', any: ['rondas.ver', 'rondas.patrullar'] },
        { page: 'vecino.html', label: 'Mi panel', role: 'vecino' }
    ];

    // Pagina de inicio de cada rol (el operador no tiene: va a la primera que le corresponda)
    const ROLE_HOME = { admin: 'admin.html', policia: 'garita.html', supervisor: 'rondin/', auditor: 'auditor.html', vecino: 'vecino.html' };

    // Plantillas del sistema: conjuntos completos de claves, con el rol sugerido.
    // Cada condominio puede crear las suyas (condominios/{id}/plantillas_privilegios).
    const adminKeys = ITEMS.filter((i) => i.roles.includes('admin')).map((i) => i.key);
    const without = (list, ...drop) => list.filter((k) => !drop.includes(k));
    const TEMPLATES = [
        {
            id: 'sys-secretaria', name: 'Secretaria / oficina', role: 'operador',
            description: 'Atiende vecinos: los registra y edita, manda mensajes y ve visitas y alertas.',
            keys: ['usuarios.panel', 'usuarios.ver', 'usuarios.crear', 'usuarios.editar', 'mensajes.enviar', 'mensajes.historial', 'visitas.ver', 'visitas.gestionar', 'panico.ver']
        },
        {
            id: 'sys-contador', name: 'Contador / tesorero', role: 'operador',
            description: 'Solo el Sistema Financiero (cargos, pagos y reportes) y los datos de los vecinos que necesita.',
            keys: ['usuarios.ver', 'usuarios.crear', 'usuarios.editar', 'finanzas.ver', 'finanzas.usar']
        },
        {
            id: 'sys-jefe-seguridad', name: 'Jefe de seguridad', role: 'operador',
            description: 'Garita, cámara y rondas: opera y administra la vigilancia y registra guardias.',
            keys: ['usuarios.ver', 'guardias.crear', 'visitas.ver', 'garita.operar', 'garita.camara', 'panico.activar', 'panico.ver', 'panico.atender', 'rondas.ver', 'rondas.gestionar', 'rondas.patrullar']
        },
        {
            id: 'sys-garitero', name: 'Garitero (solo garita)', role: 'operador',
            description: 'Opera la garita y atiende alertas, sin acceso a rondas ni a la administración.',
            keys: ['usuarios.ver', 'visitas.ver', 'garita.operar', 'garita.camara', 'panico.ver', 'panico.atender']
        },
        {
            id: 'sys-consulta', name: 'Consulta (solo lectura)', role: 'operador',
            description: 'Ve usuarios, visitas, accesos y mensajes en el panel de administración, sin modificar nada.',
            keys: ['usuarios.panel', 'usuarios.ver', 'visitas.ver', 'garita.camara', 'mensajes.historial', 'panico.ver']
        },
        {
            id: 'sys-admin-delegado', name: 'Administrador delegado', role: 'admin',
            description: 'Administra el día a día pero no asigna privilegios, no ve ni cambia códigos de acceso y no elimina usuarios.',
            keys: without(adminKeys, 'usuarios.privilegios', 'usuarios.codigos', 'usuarios.eliminar')
        },
        {
            id: 'sys-admin-sin-finanzas', name: 'Administrador sin finanzas', role: 'admin',
            description: 'Administrador completo, salvo el Sistema Financiero.',
            keys: without(adminKeys, 'finanzas.ver', 'finanzas.usar')
        }
    ];

    function defaultsOf(role) {
        const out = {};
        ITEMS.forEach((i) => { if (i.roles.includes(role)) out[i.key] = true; });
        return out;
    }

    function cleanOverrides(overrides) {
        const out = {};
        if (!overrides || typeof overrides !== 'object') return out;
        Object.keys(overrides).forEach((k) => { if (BY_KEY[k] && typeof overrides[k] === 'boolean') out[k] = overrides[k]; });
        return out;
    }

    // Privilegios efectivos de un usuario: { clave: true|false } para todas las claves del catalogo
    function effective(role, overrides) {
        if (role === 'master') return Object.fromEntries(KEYS.map((k) => [k, true]));
        const base = defaultsOf(role);
        const own = cleanOverrides(overrides);
        const out = {};
        KEYS.forEach((k) => { out[k] = k in own ? own[k] : base[k] === true; });
        return out;
    }

    function has(role, overrides, key) {
        if (role === 'master') return true;
        if (!BY_KEY[key]) return false;
        const own = cleanOverrides(overrides);
        return key in own ? own[key] : BY_KEY[key].roles.includes(role);
    }

    // De un conjunto completo de claves activas (arreglo o { clave: bool }) a las diferencias con el rol
    function toOverrides(role, wanted) {
        const set = new Set(Array.isArray(wanted) ? wanted : Object.keys(wanted || {}).filter((k) => wanted[k] === true));
        const base = defaultsOf(role);
        const out = {};
        KEYS.forEach((k) => {
            const want = set.has(k);
            if (want !== (base[k] === true)) out[k] = want;
        });
        return out;
    }

    // Cambia una clave en un conjunto (Set) respetando dependencias: al activar se activan las que necesita,
    // al quitar se quitan las que dependen de ella. Devuelve el mismo Set.
    function toggle(set, key, on) {
        if (!BY_KEY[key]) return set;
        if (on) {
            set.add(key);
            (BY_KEY[key].requires || []).forEach((r) => toggle(set, r, true));
        } else {
            set.delete(key);
            ITEMS.filter((i) => (i.requires || []).includes(key)).forEach((i) => { if (set.has(i.key)) toggle(set, i.key, false); });
        }
        return set;
    }

    // Claves que se activan o quitan en cascada al cambiar `key` (para avisar al administrador)
    function cascade(set, key, on) {
        const before = new Set(set);
        const after = toggle(new Set(set), key, on);
        const changed = KEYS.filter((k) => k !== key && before.has(k) !== after.has(k));
        return changed;
    }

    function canEnter(role, overrides, entry) {
        if (role === 'master') return false;
        if (entry.role) return entry.role === role;
        return entry.any.some((k) => has(role, overrides, k));
    }

    // Paginas a las que puede entrar el usuario, en orden de preferencia (la de su rol primero)
    function pagesFor(role, overrides) {
        const open = PAGES.filter((p) => canEnter(role, overrides, p));
        const home = ROLE_HOME[role];
        return home ? [...open.filter((p) => p.page === home), ...open.filter((p) => p.page !== home)] : open;
    }

    // A donde mandar al usuario al entrar (null si no tiene acceso a ninguna pagina)
    function landing(role, overrides) {
        const pages = pagesFor(role, overrides);
        return pages.length ? pages[0].page : null;
    }

    function itemOf(key) { return BY_KEY[key] || null; }

    function sensitiveKeys() { return ITEMS.filter((i) => i.sensitive).map((i) => i.key); }

    // Plantilla del sistema o personalizada por id
    function templateById(id, custom) {
        return TEMPLATES.concat(custom || []).find((t) => t.id === id) || null;
    }

    return {
        ROLES, ROLE_LABELS, GROUPS, ITEMS, KEYS, PAGES, ROLE_HOME, TEMPLATES,
        defaultsOf, cleanOverrides, effective, has, toOverrides, toggle, cascade,
        canEnter, pagesFor, landing, itemOf, sensitiveKeys, templateById
    };
}));
