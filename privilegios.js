/* ═══════════════════════════════════════════════════════════════
   SISDEL - Catalogo de privilegios
   ───────────────────────────────────────────────────────────────
   Fuente unica de los privilegios que el administrador de cada condominio
   asigna por usuario. Se carga en el navegador (<script src="privilegios.js">)
   y en Node (functions/src/privilegios.js es una copia identica; la prueba
   scripts/test-privilegios.mjs falla si difieren).

   Modelo:
   - Cada rol trae unos privilegios por defecto (campo `roles` de las claves raiz).
     Esos son EXACTAMENTE los accesos que el rol tenia antes de existir este
     modulo: un usuario sin privilegios asignados no pierde ni gana nada.
   - Una clave raiz es un "paraguas" (por ejemplo finanzas.usar). Las acciones
     concretas de ese paraguas (finanzas.pagos.crear, ...) llevan `parent`: sin el
     paraguas no hay ninguna; con el paraguas vienen activas salvo que el
     administrador las quite. Asi quien ya tenia el privilegio amplio no pierde nada.
   - usuarios/{id}.privilegios guarda solo las diferencias:
     { clave: true } agrega un paraguas, { clave: false } quita un paraguas o una accion.
   - El rol `operador` no trae ninguno: es el personal "a la medida".
   - Las reglas de Firestore (firestore.rules, funciones pXxx generadas por
     scripts/generar-reglas-privilegios.mjs) leen ese mapa del documento del
     usuario, asi que aplica al instante y no depende del token.
   - `enforce`: 'reglas' = lo garantizan las reglas de Firestore o el servidor
     (aunque alguien use otra pagina o la consola); 'pantalla' = solo oculta o
     muestra botones y pestanas del navegador.
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

    // Cada clave: label (lo que ve el administrador), description, sub (subgrupo de la tarjeta), roles (quienes la tienen
    // por defecto: solo las claves raiz), parent (paraguas), requires (otras claves que necesita), sensitive (poder amplio:
    // asignar con cuidado), onlyRoles (solo ciertos roles pueden tenerla), enforce ('reglas' o 'pantalla').
    // Los padres van siempre antes que sus hijos.
    const GROUPS = [
        {
            id: 'usuarios', title: 'Usuarios y vecinos', items: [
                { key: 'usuarios.panel', sub: 'Acceso', label: 'Entrar al panel de administración', description: 'Abre admin.html: lista de usuarios, estadísticas y mensajes.', roles: ['admin'], requires: ['usuarios.ver'], enforce: 'pantalla' },
                { key: 'usuarios.estadisticas', sub: 'Acceso', parent: 'usuarios.panel', label: 'Ver las estadísticas del panel', description: 'Usuarios, vecinos, morosos y visitas de hoy, en la parte de arriba del panel.', enforce: 'pantalla' },
                { key: 'usuarios.ver', sub: 'Ver', label: 'Ver usuarios y vecinos', description: 'Consultar la lista de vecinos y personal (sin códigos de acceso).', roles: ['admin', 'policia', 'supervisor', 'auditor'], enforce: 'reglas' },
                { key: 'usuarios.contacto', sub: 'Ver', parent: 'usuarios.ver', label: 'Ver teléfono y correo', description: 'Los datos de contacto de cada usuario en las listas y el detalle.', enforce: 'pantalla' },
                { key: 'usuarios.pagos_ver', sub: 'Ver', parent: 'usuarios.ver', label: 'Ver el estado de pago', description: 'Si un vecino está al día o moroso, y el recuento de morosos.', enforce: 'pantalla' },
                { key: 'usuarios.crear', sub: 'Crear', label: 'Crear usuarios', description: 'Registrar vecinos con su código de acceso. Crear guardias, auditores, supervisores, administradores y operadores exige además Asignar privilegios (los guardias también los crea quien tiene Registrar guardias).', roles: ['admin'], requires: ['usuarios.ver'], enforce: 'reglas' },
                { key: 'guardias.crear', sub: 'Crear', label: 'Registrar guardias', description: 'Crear guardias (solo ese rol) y ver el código de acceso de los guardias; con él se puede entrar como cualquier guardia.', roles: ['admin', 'supervisor'], requires: ['usuarios.ver'], sensitive: true, enforce: 'reglas' },
                { key: 'usuarios.editar', sub: 'Editar', label: 'Editar usuarios', description: 'Cambiar nombre, casa, teléfono y cargo de un usuario.', roles: ['admin'], requires: ['usuarios.ver'], enforce: 'reglas' },
                { key: 'usuarios.estado', sub: 'Editar', parent: 'usuarios.editar', label: 'Activar o desactivar usuarios', description: 'Un usuario desactivado no puede entrar hasta que se vuelva a activar.', sensitive: true, enforce: 'reglas' },
                { key: 'usuarios.pago', sub: 'Editar', parent: 'usuarios.editar', label: 'Cambiar el estado de pago', description: 'Marcar a un vecino como moroso o al día a mano (con la mora automática lo calcula el Sistema Financiero).', sensitive: true, enforce: 'reglas' },
                { key: 'usuarios.emergencia', sub: 'Editar', parent: 'usuarios.editar', label: 'Editar contactos de emergencia de vecinos', description: 'Los familiares a quienes avisa el botón de pánico de un vecino.', enforce: 'reglas' },
                { key: 'usuarios.eliminar', sub: 'Eliminar', label: 'Eliminar usuarios', description: 'Borrar usuarios con su código, vehículos y visitas (necesita poder ver los códigos de acceso).', roles: ['admin'], requires: ['usuarios.ver', 'usuarios.codigos'], sensitive: true, enforce: 'reglas' },
                { key: 'usuarios.codigos', sub: 'Códigos y privilegios', label: 'Ver y cambiar códigos de acceso', description: 'Ver y reemplazar el código de los vecinos, guardias, auditores y supervisores. Equivale a poder entrar como cualquiera de ellos; los de administradores y operadores solo con Asignar privilegios.', roles: ['admin'], requires: ['usuarios.ver'], sensitive: true, enforce: 'reglas' },
                { key: 'usuarios.privilegios', sub: 'Códigos y privilegios', label: 'Asignar privilegios', description: 'Cambiar los privilegios de otros usuarios y crear, editar o eliminar administradores y operadores. Equivale a control total del condominio: darlo solo a administradores de confianza. Solo puede tenerlo un administrador o un operador.', roles: ['admin'], onlyRoles: ['admin', 'operador'], requires: ['usuarios.ver', 'usuarios.editar'], sensitive: true, enforce: 'reglas' },
                { key: 'plantillas.gestionar', sub: 'Códigos y privilegios', parent: 'usuarios.privilegios', label: 'Crear, editar y borrar plantillas', description: 'Las plantillas de privilegios propias del condominio (las del sistema no se pueden cambiar).', enforce: 'reglas' }
            ]
        },
        {
            id: 'mensajes', title: 'Mensajes', items: [
                { key: 'mensajes.recibir', sub: 'Recibir', label: 'Recibir mensajes', description: 'Leer los avisos que la administración manda a su grupo y marcarlos como leídos.', roles: ['admin', 'policia', 'supervisor', 'auditor', 'vecino', 'operador'], enforce: 'reglas' },
                { key: 'mensajes.enviar', sub: 'Enviar', label: 'Enviar mensajes', description: 'Escribir avisos para vecinos y guardias.', roles: ['admin'], enforce: 'reglas' },
                { key: 'mensajes.eliminar', sub: 'Enviar', parent: 'mensajes.enviar', label: 'Borrar mensajes enviados', description: 'Quitar un aviso ya enviado.', enforce: 'reglas' },
                { key: 'mensajes.historial', sub: 'Historial', label: 'Ver todos los mensajes', description: 'Leer los mensajes enviados a cualquier grupo, no solo los propios.', roles: ['admin', 'auditor'], enforce: 'reglas' }
            ]
        },
        {
            id: 'visitas', title: 'Visitas y vehículos', items: [
                { key: 'visitas.ver', sub: 'Ver', label: 'Ver visitas', description: 'Consultar las visitas de todos los vecinos.', roles: ['admin', 'policia', 'auditor'], enforce: 'reglas' },
                { key: 'vehiculos.ver', sub: 'Ver', parent: 'visitas.ver', label: 'Ver vehículos', description: 'Consultar las placas y marbetes de todos los vecinos.', enforce: 'reglas' },
                { key: 'visitas.gestionar', sub: 'Administrar', label: 'Administrar visitas y vehículos', description: 'Acceso a crear, editar y borrar visitas y vehículos de cualquier vecino.', roles: ['admin'], requires: ['visitas.ver', 'vehiculos.ver'], enforce: 'reglas' },
                { key: 'visitas.crear', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Crear visitas', description: 'Registrar una visita a nombre de cualquier vecino.', enforce: 'reglas' },
                { key: 'visitas.editar', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Editar visitas', description: 'Cambiar los datos de una visita.', enforce: 'reglas' },
                { key: 'visitas.eliminar', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Borrar visitas', description: 'Quitar visitas del registro.', sensitive: true, enforce: 'reglas' },
                { key: 'vehiculos.crear', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Registrar vehículos', description: 'Agregar placas a un vecino, al crearlo o después.', enforce: 'reglas' },
                { key: 'vehiculos.editar', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Editar vehículos', description: 'Cambiar los datos de un vehículo.', enforce: 'reglas' },
                { key: 'vehiculos.eliminar', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Quitar vehículos', description: 'Borrar placas de un vecino.', sensitive: true, enforce: 'reglas' },
                { key: 'garita.historial_borrar', sub: 'Administrar', parent: 'visitas.gestionar', label: 'Borrar el historial de la cámara', description: 'Quitar lecturas del historial de accesos de la cámara.', sensitive: true, enforce: 'reglas' }
            ]
        },
        {
            id: 'garita', title: 'Garita y cámara', items: [
                { key: 'garita.operar', sub: 'Operar la garita', label: 'Operar la garita', description: 'Abre garita.html: verificar vecinos y registrar ingresos.', roles: ['admin', 'policia'], requires: ['usuarios.ver', 'visitas.ver', 'vehiculos.ver'], enforce: 'pantalla' },
                { key: 'garita.escanear', sub: 'Operar la garita', parent: 'garita.operar', label: 'Usar el escáner QR', description: 'Abrir la cámara del dispositivo para leer códigos QR de visitas y marbetes.', enforce: 'pantalla' },
                { key: 'garita.verificar', sub: 'Operar la garita', parent: 'garita.operar', label: 'Verificar un código a mano', description: 'Escribir el código de acceso, la placa o el QR para validar a una persona (lo valida el servidor).', enforce: 'reglas' },
                { key: 'garita.ingreso', sub: 'Operar la garita', parent: 'garita.operar', label: 'Registrar ingresos', description: 'Confirmar el ingreso de una visita, un vehículo o un residente.', enforce: 'reglas' },
                { key: 'garita.visitas_dia', sub: 'Operar la garita', parent: 'garita.operar', label: 'Ver las visitas del día', description: 'La lista de visitas esperadas hoy, con su botón Validar.', enforce: 'pantalla' },
                { key: 'garita.morosos', sub: 'Operar la garita', parent: 'garita.operar', label: 'Ver el aviso de morosos', description: 'El recuento de vecinos morosos y la alerta de restricción de acceso.', enforce: 'pantalla' },
                { key: 'garita.camara', sub: 'Cámara de placas', label: 'Ver el historial de la cámara', description: 'Consultar los accesos y lecturas de la cámara de placas.', roles: ['admin', 'policia', 'auditor'], enforce: 'reglas' },
                { key: 'garita.vivo', sub: 'Cámara de placas', parent: 'garita.camara', label: 'Recibir avisos en vivo de la cámara', description: 'Aviso y pantalla grande cada vez que la cámara lee una placa.', enforce: 'pantalla' },
                { key: 'garita.historial', sub: 'Cámara de placas', parent: 'garita.camara', label: 'Ver el historial de accesos del día', description: 'Los últimos ingresos del día en la garita.', enforce: 'pantalla' }
            ]
        },
        {
            id: 'vecino', title: 'Panel del vecino', items: [
                { key: 'vecino.visitas', sub: 'Visitas', label: 'Crear pases de visita', description: 'El vecino genera y cancela los pases de sus visitas.', roles: ['vecino'], enforce: 'reglas' },
                { key: 'vecino.temporal', sub: 'Visitas', parent: 'vecino.visitas', label: 'Crear accesos temporales', description: 'Un pase válido por varios días para un invitado.', enforce: 'reglas' },
                { key: 'vecino.compartir', sub: 'Visitas', parent: 'vecino.visitas', label: 'Compartir y descargar el pase', description: 'Enviar el pase por WhatsApp o descargarlo como imagen.', enforce: 'pantalla' },
                { key: 'vecino.historial', sub: 'Visitas', label: 'Ver sus visitas recientes', description: 'La lista de sus visitas y su estado.', roles: ['vecino'], enforce: 'reglas' },
                { key: 'vecino.vehiculos', sub: 'Vehículos', label: 'Registrar sus vehículos', description: 'El vecino registra sus vehículos.', roles: ['vecino'], enforce: 'reglas' },
                { key: 'vecino.vehiculos_quitar', sub: 'Vehículos', parent: 'vecino.vehiculos', label: 'Quitar sus vehículos', description: 'El vecino borra un vehículo registrado.', enforce: 'reglas' },
                { key: 'vecino.marbete', sub: 'Vehículos', parent: 'vecino.vehiculos', label: 'Ver y descargar su marbete', description: 'El pase vehicular con su código QR.', enforce: 'pantalla' },
                { key: 'vecino.contactos', sub: 'Emergencia', label: 'Editar sus contactos de emergencia', description: 'Los familiares a quienes avisa su botón de pánico.', roles: ['vecino'], enforce: 'reglas' },
                { key: 'panico.activar', sub: 'Emergencia', label: 'Usar el botón de pánico', description: 'Enviar una alerta de pánico a la garita y a la administración.', roles: ['vecino', 'policia', 'supervisor'], enforce: 'reglas' },
                { key: 'panico.cancelar', sub: 'Emergencia', parent: 'panico.activar', label: 'Cancelar su alerta', description: 'El vecino anula su alerta de pánico mientras siga activa.', enforce: 'reglas' }
            ]
        },
        {
            id: 'panico', title: 'Alertas de pánico', items: [
                { key: 'panico.ver', sub: 'Ver', label: 'Ver alertas de pánico', description: 'Ver las alertas activas y su historial.', roles: ['admin', 'policia', 'supervisor', 'auditor'], enforce: 'reglas' },
                { key: 'panico.contactos', sub: 'Ver', parent: 'panico.ver', label: 'Ver los contactos de emergencia', description: 'Los familiares registrados por los vecinos.', enforce: 'reglas' },
                { key: 'panico.avisos', sub: 'Ver', parent: 'panico.ver', label: 'Recibir avisos y sirena', description: 'La barra roja y el sonido cuando llega una alerta nueva.', enforce: 'pantalla' },
                { key: 'panico.atender', sub: 'Atender', label: 'Atender alertas de pánico', description: 'Marcar las alertas como atendidas.', roles: ['admin', 'policia', 'supervisor'], requires: ['panico.ver'], enforce: 'reglas' },
                { key: 'panico.resolver', sub: 'Atender', parent: 'panico.atender', label: 'Resolver alertas de pánico', description: 'Cerrar una alerta con sus notas.', enforce: 'reglas' }
            ]
        },
        {
            id: 'finanzas', title: 'Sistema Financiero (OIKOS)', items: [
                { key: 'finanzas.ver', label: 'Leer datos financieros', description: 'Ver cuotas, cargos y pagos de los residentes (solo lectura).', roles: ['admin', 'auditor'], enforce: 'reglas' },
                { key: 'finanzas.usar', label: 'Usar el Sistema Financiero', description: 'Abre finanzas.html: cargos, pagos, egresos y reportes. Para registrar residentes nuevos o cambiar sus datos desde ahí también necesita Crear usuarios y Editar usuarios.', roles: ['admin'], requires: ['finanzas.ver', 'usuarios.ver'], sensitive: true, enforce: 'reglas' }
            ]
        },
        {
            id: 'rondas', title: 'Rondas de vigilancia (RONDIN)', items: [
                { key: 'rondas.ver', label: 'Ver el panel de rondas', description: 'Consultar rutas, turnos, rondas, incidentes y la posición de los guardias (solo lectura).', roles: ['admin', 'supervisor', 'auditor'], requires: ['usuarios.ver'], enforce: 'reglas' },
                { key: 'rondas.gestionar', label: 'Administrar rondas', description: 'Crear rutas y asignaciones, resolver incidentes, manejar drones y la configuración de rondas.', roles: ['admin', 'supervisor'], requires: ['rondas.ver'], enforce: 'reglas' },
                { key: 'rondas.patrullar', label: 'Patrullar', description: 'Iniciar turnos y rondas, marcar puntos de control y reportar incidentes desde el teléfono.', roles: ['policia', 'supervisor'], requires: ['usuarios.ver'], enforce: 'reglas' }
            ]
        },
        {
            id: 'auditoria', title: 'Auditoría', items: [
                { key: 'auditoria.ver', sub: 'Acceso', label: 'Entrar al panel de auditoría', description: 'Abre auditor.html. Cada pestaña pide además su privilegio de lectura de los datos.', roles: ['auditor'], enforce: 'pantalla' },
                { key: 'auditoria.usuarios', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Usuarios', description: 'La lista de usuarios del condominio (necesita Ver usuarios).', enforce: 'pantalla' },
                { key: 'auditoria.visitas', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Visitas', description: 'Las visitas por rango de fechas (necesita Ver visitas).', enforce: 'pantalla' },
                { key: 'auditoria.vehiculos', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Vehículos', description: 'Las placas y marbetes de todos los vecinos (necesita Ver vehículos).', enforce: 'pantalla' },
                { key: 'auditoria.accesos', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Accesos', description: 'El historial de la cámara y la garita por rango de fechas (necesita Ver el historial de la cámara).', enforce: 'pantalla' },
                { key: 'auditoria.mensajes', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Mensajes', description: 'Todos los mensajes enviados (necesita Ver todos los mensajes).', enforce: 'pantalla' },
                { key: 'auditoria.reportes', sub: 'Pestañas', parent: 'auditoria.ver', label: 'Pestaña Reportes', description: 'El reporte por rango de fechas con gráficas y tablas (necesita ver usuarios, visitas y accesos).', enforce: 'pantalla' },
                { key: 'auditoria.imprimir', sub: 'Reportes', parent: 'auditoria.ver', label: 'Imprimir o guardar en PDF', description: 'El botón Imprimir / PDF del reporte.', enforce: 'pantalla' },
                { key: 'auditoria.exportar', sub: 'Exportar', label: 'Exportar reportes', description: 'Acceso a descargar los reportes del panel de auditoría en CSV.', roles: ['auditor'], requires: ['auditoria.ver'], enforce: 'pantalla' },
                { key: 'auditoria.exportar_accesos', sub: 'Exportar', parent: 'auditoria.exportar', label: 'Exportar accesos (CSV)', description: 'Las lecturas de la cámara y los ingresos del rango.', enforce: 'pantalla' },
                { key: 'auditoria.exportar_visitas', sub: 'Exportar', parent: 'auditoria.exportar', label: 'Exportar visitas (CSV)', description: 'Las visitas del rango con quién las autorizó.', enforce: 'pantalla' },
                { key: 'auditoria.exportar_usuarios', sub: 'Exportar', parent: 'auditoria.exportar', label: 'Exportar usuarios (CSV)', description: 'La lista de usuarios con teléfono, correo y estado de pago.', sensitive: true, enforce: 'pantalla' }
            ]
        }
    ];

    const ITEMS = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id, groupTitle: g.title })));
    // Sin prototipo: una clave como "constructor" no existe en el catalogo
    const BY_KEY = Object.assign(Object.create(null), Object.fromEntries(ITEMS.map((i) => [i.key, i])));
    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const KEYS = ITEMS.map((i) => i.key);

    // ── Paraguas (parent) ──
    // Una clave con `parent` es una accion concreta dentro de otra mas amplia (el "paraguas"). Reglas:
    //  - el paraguas es la puerta: sin el paraguas no hay ninguna de sus acciones;
    //  - con el paraguas, cada accion viene activa salvo que el administrador la quite ({ clave: false });
    //  - los roles por defecto se declaran solo en el paraguas raiz: las acciones los heredan.
    // Asi quien ya tenia el privilegio amplio (por rol o por la asignacion del administrador) conserva todo lo que
    // ese privilegio permitia, y las acciones nuevas se pueden quitar una por una.
    // Los padres van antes que sus hijos en el catalogo (se verifica al cargar).
    ITEMS.forEach((item, index) => {
        if (item.parent && !(BY_KEY[item.parent] && KEYS.indexOf(item.parent) < index)) throw new Error(`privilegios: ${item.key} necesita su paraguas ${item.parent} definido antes`);
        let root = item;
        while (root.parent) root = BY_KEY[root.parent];
        item.root = root.key;
        item.defaultRoles = root.roles || [];
        item.depth = item.parent ? BY_KEY[item.parent].depth + 1 : 0;
    });
    const CHILDREN = Object.assign(Object.create(null), Object.fromEntries(KEYS.map((k) => [k, ITEMS.filter((i) => i.parent === k).map((i) => i.key)])));
    const descendantsOf = (key) => (CHILDREN[key] || []).flatMap((c) => [c, ...descendantsOf(c)]);
    const ancestorsOf = (key) => (BY_KEY[key] && BY_KEY[key].parent ? [...ancestorsOf(BY_KEY[key].parent), BY_KEY[key].parent] : []);

    // Algunos privilegios solo los puede tener ciertos roles (onlyRoles, en el paraguas raiz): asignarlos a otro rol no tiene efecto
    const allowedFor = (key, role) => {
        if (!BY_KEY[key]) return false;
        const only = BY_KEY[BY_KEY[key].root].onlyRoles;
        return !only || only.includes(role);
    };

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

    // Plantillas del sistema: conjuntos completos de claves (paraguas y acciones), con el rol sugerido.
    // Cada condominio puede crear las suyas (condominios/{id}/plantillas_privilegios).
    const tree = (...keys) => keys.flatMap((k) => [k, ...descendantsOf(k)]);
    const adminKeys = ITEMS.filter((i) => i.defaultRoles.includes('admin')).map((i) => i.key);
    const without = (list, ...drop) => list.filter((k) => !drop.includes(k) && !drop.some((d) => ancestorsOf(k).includes(d)));
    const TEMPLATES = [
        {
            id: 'sys-secretaria', name: 'Secretaria / oficina', role: 'operador', system: true,
            description: 'Atiende vecinos: los registra y edita, manda mensajes y ve visitas y alertas.',
            claves: [
                ...tree('usuarios.panel', 'usuarios.ver', 'usuarios.crear'), 'usuarios.editar', 'usuarios.emergencia',
                'mensajes.recibir', ...tree('mensajes.enviar'), 'mensajes.historial',
                ...tree('visitas.ver'), 'visitas.gestionar', 'visitas.crear', 'visitas.editar', 'vehiculos.crear', 'vehiculos.editar',
                'panico.ver', 'panico.contactos'
            ]
        },
        {
            id: 'sys-contador', name: 'Contador / tesorero', role: 'operador', system: true,
            description: 'Solo el Sistema Financiero (residentes, cargos, pagos, egresos y reportes) y los datos de los vecinos que necesita.',
            claves: [...tree('usuarios.ver'), 'usuarios.crear', 'usuarios.editar', 'mensajes.recibir', ...tree('finanzas.ver', 'finanzas.usar')]
        },
        {
            id: 'sys-jefe-seguridad', name: 'Jefe de seguridad', role: 'operador', system: true,
            description: 'Garita, cámara y rondas: opera y administra la vigilancia y registra guardias.',
            claves: [
                'usuarios.ver', 'guardias.crear', ...tree('visitas.ver'), 'mensajes.recibir',
                ...tree('garita.operar', 'garita.camara'), ...tree('panico.activar'), ...tree('panico.ver', 'panico.atender'),
                ...tree('rondas.ver', 'rondas.gestionar', 'rondas.patrullar')
            ]
        },
        {
            id: 'sys-garitero', name: 'Garitero (solo garita)', role: 'operador', system: true,
            description: 'Opera la garita y atiende alertas, sin acceso a rondas ni a la administración.',
            claves: ['usuarios.ver', ...tree('visitas.ver'), 'mensajes.recibir', ...tree('garita.operar', 'garita.camara'), ...tree('panico.ver', 'panico.atender')]
        },
        {
            id: 'sys-consulta', name: 'Consulta (solo lectura)', role: 'operador', system: true,
            description: 'Ve usuarios, visitas, accesos y mensajes en el panel de administración, sin modificar nada.',
            claves: [
                ...tree('usuarios.panel', 'usuarios.ver'), ...tree('visitas.ver'), 'garita.camara', 'garita.historial', 'mensajes.recibir',
                'mensajes.historial', 'panico.ver', 'panico.contactos'
            ]
        },
        {
            id: 'sys-admin-delegado', name: 'Administrador delegado', role: 'admin', system: true,
            description: 'Administra el día a día pero no asigna privilegios, no ve ni cambia códigos de acceso y no elimina usuarios.',
            claves: without(adminKeys, 'usuarios.privilegios', 'usuarios.codigos', 'usuarios.eliminar')
        },
        {
            id: 'sys-admin-sin-finanzas', name: 'Administrador sin finanzas', role: 'admin', system: true,
            description: 'Administrador completo, salvo el Sistema Financiero.',
            claves: without(adminKeys, 'finanzas.ver', 'finanzas.usar')
        }
    ];
    // Privilegios por defecto de un rol: los raiz segun `roles` y, con ellos, todas sus acciones
    function defaultsOf(role) {
        const out = {};
        ITEMS.forEach((i) => { if (i.defaultRoles.includes(role) && allowedFor(i.key, role)) out[i.key] = true; });
        return out;
    }

    function cleanOverrides(overrides) {
        const out = {};
        if (!overrides || typeof overrides !== 'object') return out;
        Object.keys(overrides).forEach((k) => { if (BY_KEY[k] && hasOwn(overrides, k) && typeof overrides[k] === 'boolean') out[k] = overrides[k]; });
        return out;
    }

    // Valor de una clave dada su cadena de paraguas: raiz = asignacion o rol; accion = paraguas activo y no quitada
    function resolve(role, own, key, memo) {
        if (key in memo) return memo[key];
        const item = BY_KEY[key];
        let value;
        if (!allowedFor(key, role)) value = false;
        else if (item.parent) value = resolve(role, own, item.parent, memo) && own[key] !== false;
        else value = key in own ? own[key] : item.roles.includes(role);
        memo[key] = value;
        return value;
    }

    // Privilegios efectivos de un usuario: { clave: true|false } para todas las claves del catalogo
    function effective(role, overrides) {
        if (role === 'master') return Object.fromEntries(KEYS.map((k) => [k, true]));
        const own = cleanOverrides(overrides);
        const memo = {};
        const out = {};
        KEYS.forEach((k) => { out[k] = resolve(role, own, k, memo); });
        return out;
    }

    function has(role, overrides, key) {
        if (role === 'master') return true;
        if (!BY_KEY[key]) return false;
        return resolve(role, cleanOverrides(overrides), key, {});
    }

    // De un conjunto completo de claves activas (arreglo, Set o { clave: bool }) a las diferencias con el rol.
    // Las acciones de un paraguas apagado no se guardan (no hacen falta); las de un paraguas encendido solo
    // se guardan si estan quitadas.
    function toOverrides(role, wanted) {
        const list = Array.isArray(wanted) ? wanted
            : wanted instanceof Set ? [...wanted]
                : Object.keys(wanted || {}).filter((k) => wanted[k] === true);
        const set = new Set(list);
        const out = {};
        const shown = {};
        KEYS.forEach((k) => {
            const item = BY_KEY[k];
            const want = set.has(k) && allowedFor(k, role);
            if (item.parent) {
                if (!shown[item.parent]) { shown[k] = false; return; }
                if (!want) out[k] = false;
                shown[k] = want;
            } else {
                if (want !== item.roles.includes(role)) out[k] = want;
                shown[k] = want;
            }
        });
        return out;
    }

    // Cambia una clave en un conjunto (Set) respetando el paraguas y las dependencias:
    //  - al activar: se activan su paraguas y lo que necesita; con { children: true } tambien todas sus acciones
    //  - al quitar: se quitan sus acciones y lo que depende de ella
    // Devuelve el mismo Set.
    function toggle(set, key, on, options = {}) {
        const item = BY_KEY[key];
        if (!item) return set;
        if (on) {
            set.add(key);
            if (item.parent) toggle(set, item.parent, true);
            (item.requires || []).forEach((r) => toggle(set, r, true));
            if (options.children) descendantsOf(key).forEach((d) => toggle(set, d, true));
        } else {
            set.delete(key);
            (CHILDREN[key] || []).forEach((c) => { if (set.has(c)) toggle(set, c, false); });
            ITEMS.filter((i) => (i.requires || []).includes(key)).forEach((i) => { if (set.has(i.key)) toggle(set, i.key, false); });
        }
        return set;
    }

    // Claves que se activan o quitan en cascada al cambiar `key` (para avisar al administrador)
    function cascade(set, key, on, options = {}) {
        const before = new Set(set);
        const after = toggle(new Set(set), key, on, options);
        return KEYS.filter((k) => k !== key && before.has(k) !== after.has(k));
    }

    // Plantillas guardadas antes de las acciones (solo traen el paraguas): se amplian con todas sus acciones,
    // que es lo que el paraguas permitia. Si la plantilla ya nombra acciones, se respeta tal cual.
    function expandTemplate(claves) {
        const set = new Set((claves || []).filter((k) => BY_KEY[k]));
        [...set].forEach((k) => {
            const kids = CHILDREN[k] || [];
            if (kids.length && !kids.some((c) => set.has(c))) descendantsOf(k).forEach((d) => set.add(d));
        });
        return [...set];
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

    // Claves de una plantilla: las del sistema son exactas; las propias guardadas antes de las acciones se amplian
    function templateKeys(template) {
        return template.system ? (template.claves || []).filter((k) => BY_KEY[k]) : expandTemplate(template.claves);
    }

    return {
        ROLES, ROLE_LABELS, GROUPS, ITEMS, KEYS, PAGES, ROLE_HOME, TEMPLATES,
        defaultsOf, cleanOverrides, effective, has, allowedFor, toOverrides, toggle, cascade,
        canEnter, pagesFor, landing, itemOf, sensitiveKeys, templateById, templateKeys, expandTemplate,
        childrenOf: (key) => (CHILDREN[key] || []).slice(), descendantsOf, ancestorsOf
    };
}));
