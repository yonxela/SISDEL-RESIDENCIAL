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
                { key: 'finanzas.ver', sub: 'Acceso', label: 'Leer datos financieros', description: 'Leer cuotas, cargos, pagos y egresos (solo lectura). Las reglas dejan leer los datos a quien lo tiene; qué pantallas ve en OIKOS lo decide cada privilegio de abajo.', roles: ['admin', 'auditor'], enforce: 'reglas' },
                { key: 'finanzas.usar', sub: 'Acceso', label: 'Usar el Sistema Financiero', description: 'Abre finanzas.html. Con él vienen todas las pantallas y acciones de abajo; se pueden quitar una por una. Para registrar residentes nuevos o cambiar sus datos desde ahí también necesita Crear usuarios y Editar usuarios.', roles: ['admin'], requires: ['finanzas.ver', 'usuarios.ver'], sensitive: true, enforce: 'reglas' },

                { key: 'finanzas.tablero_ver', sub: 'Tablero', parent: 'finanzas.usar', label: 'Ver el tablero', description: 'Saldo en caja, total de ingresos y gastos, gráfica de tendencia y alerta de residentes en mora.', requires: ['finanzas.ver'], enforce: 'pantalla' },

                { key: 'finanzas.residentes_ver', sub: 'Residentes', parent: 'finanzas.usar', label: 'Ver residentes', description: 'La lista de residentes con su saldo y mora, y el buscador.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.residentes_datos', sub: 'Residentes', parent: 'finanzas.usar', label: 'Ver DPI, lote y observaciones', description: 'Las columnas y campos de datos personales del residente (el DPI viaja con los datos financieros: esto solo lo oculta en pantalla).', requires: ['finanzas.residentes_ver'], sensitive: true, enforce: 'pantalla' },
                { key: 'finanzas.residentes_estado', sub: 'Residentes', parent: 'finanzas.usar', label: 'Ver estado de cuenta y detalle de movimientos', description: 'Abrir el estado de cuenta de un residente y el detalle de cada movimiento.', requires: ['finanzas.residentes_ver'], enforce: 'pantalla' },
                { key: 'finanzas.residentes_crear', sub: 'Residentes', parent: 'finanzas.usar', label: 'Registrar residentes nuevos', description: 'Crea también al vecino en SISDEL con su código de acceso (que se muestra al guardar): equivale a poder entrar como ese vecino.', requires: ['finanzas.residentes_ver', 'usuarios.crear'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.residentes_editar', sub: 'Residentes', parent: 'finanzas.usar', label: 'Editar residentes', description: 'Cambiar nombre, teléfono, DPI, lote y observaciones.', requires: ['finanzas.residentes_ver', 'usuarios.editar'], enforce: 'reglas' },
                { key: 'finanzas.residentes_finiquitar', sub: 'Residentes', parent: 'finanzas.usar', label: 'Finiquitar y reactivar residentes', description: 'Cerrar la relación con un residente (deja de cobrársele) o reactivarlo.', requires: ['finanzas.residentes_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.residentes_eliminar', sub: 'Residentes', parent: 'finanzas.usar', label: 'Eliminar residentes', description: 'Quitar del Sistema Financiero a un residente que no tiene movimientos.', requires: ['finanzas.residentes_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.residentes_contactar', sub: 'Residentes', parent: 'finanzas.usar', label: 'Recordatorios y WhatsApp', description: 'Avisar por WhatsApp a los residentes en mora o con saldo pendiente.', requires: ['finanzas.residentes_ver'], enforce: 'pantalla' },

                { key: 'finanzas.cuotas_mes', sub: 'Cuotas y cargos', parent: 'finanzas.usar', label: 'Cobrar la cuota del mes a todos', description: 'El botón Cuota del mes y la generación automática de cuotas: afecta a todos los residentes.', requires: ['finanzas.residentes_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.cuotas_meses', sub: 'Cuotas y cargos', parent: 'finanzas.usar', label: 'Cargar cuotas por mes a un residente', description: 'Elegir los meses que se le cobran al crear o editar un residente.', requires: ['finanzas.residentes_editar'], enforce: 'reglas' },
                { key: 'finanzas.cuotas_corregir', sub: 'Cuotas y cargos', parent: 'finanzas.usar', label: 'Corregir cuotas duplicadas', description: 'Anular en bloque las cuotas repetidas.', requires: ['finanzas.residentes_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.cargos_crear', sub: 'Cuotas y cargos', parent: 'finanzas.usar', label: 'Crear cargos especiales y multas', description: 'Un cargo a todos los residentes o a uno solo, con el concepto que se elija.', requires: ['finanzas.contabilidad_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.cargos_anular', sub: 'Cuotas y cargos', parent: 'finanzas.usar', label: 'Anular cargos', description: 'Anular una cuota o un cargo especial desde el estado de cuenta.', requires: ['finanzas.residentes_estado'], sensitive: true, enforce: 'reglas' },

                { key: 'finanzas.contabilidad_ver', sub: 'Contabilidad', parent: 'finanzas.usar', label: 'Ver la contabilidad', description: 'La lista de pagos y egresos con sus filtros y detalle.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.comprobantes', sub: 'Contabilidad', parent: 'finanzas.usar', label: 'Imprimir y descargar comprobantes', description: 'El comprobante de un ingreso o egreso y la imagen del documento adjunto.', requires: ['finanzas.contabilidad_ver'], enforce: 'pantalla' },

                { key: 'finanzas.pagos_registrar', sub: 'Pagos', parent: 'finanzas.usar', label: 'Registrar pagos', description: 'Registrar el pago de un residente, con su documento y observaciones.', requires: ['finanzas.contabilidad_ver'], enforce: 'reglas' },
                { key: 'finanzas.pagos_anular', sub: 'Pagos', parent: 'finanzas.usar', label: 'Anular pagos', description: 'Anular un pago ya registrado.', requires: ['finanzas.contabilidad_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'finanzas.egresos_registrar', sub: 'Egresos', parent: 'finanzas.usar', label: 'Registrar egresos', description: 'Registrar un gasto del condominio, con su categoría y documento.', requires: ['finanzas.contabilidad_ver'], enforce: 'reglas' },
                { key: 'finanzas.egresos_anular', sub: 'Egresos', parent: 'finanzas.usar', label: 'Anular egresos', description: 'Anular un gasto ya registrado.', requires: ['finanzas.contabilidad_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'finanzas.reportes_ingresos', sub: 'Reportes', parent: 'finanzas.usar', label: 'Reporte de ingresos por período', description: 'Ingresos por mes con el detalle de cada uno.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.reportes_morosos', sub: 'Reportes', parent: 'finanzas.usar', label: 'Reporte de morosos', description: 'Residentes en mora y meses adeudados, y las listas de al día y morosos.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.reportes_gastos', sub: 'Reportes', parent: 'finanzas.usar', label: 'Reporte de gastos por categoría', description: 'En qué se gasta el dinero del condominio.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.reportes_libro', sub: 'Reportes', parent: 'finanzas.usar', label: 'Estado de cuenta general', description: 'El libro cronológico de pagos y egresos con saldo acumulado.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.reportes_resumen', sub: 'Reportes', parent: 'finanzas.usar', label: 'Reporte financiero mensual o por período', description: 'Ingresos netos, gastos y balance, con su resumen para WhatsApp.', requires: ['finanzas.contabilidad_ver'], enforce: 'pantalla' },
                { key: 'finanzas.reportes_exportar', sub: 'Reportes', parent: 'finanzas.usar', label: 'Exportar e imprimir', description: 'Descargar o imprimir reportes, estados de cuenta y listas en PDF o Excel: saca datos del sistema.', requires: ['finanzas.ver'], sensitive: true, enforce: 'pantalla' },

                { key: 'finanzas.config_ver', sub: 'Configuración', parent: 'finanzas.usar', label: 'Ver la configuración', description: 'La pantalla de configuración con la cuota, el cobro y los conceptos.', requires: ['finanzas.ver'], enforce: 'pantalla' },
                { key: 'finanzas.config_general', sub: 'Configuración', parent: 'finanzas.usar', label: 'Cambiar nombre, idioma, moneda y tema', description: 'Estos datos son comunes a todos los usuarios del condominio.', requires: ['finanzas.config_ver'], enforce: 'reglas' },
                { key: 'finanzas.config_cuota', sub: 'Configuración', parent: 'finanzas.usar', label: 'Cambiar la cuota y el cobro', description: 'Cuota mensual, día de cobro, días de gracia y cobro automático o manual: decide lo que se cobra y quién está en mora.', requires: ['finanzas.config_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.config_conceptos', sub: 'Configuración', parent: 'finanzas.usar', label: 'Editar los conceptos frecuentes', description: 'Los conceptos de ingresos y egresos que se repiten.', requires: ['finanzas.config_ver'], enforce: 'reglas' },

                { key: 'finanzas.deshacer', sub: 'Datos', parent: 'finanzas.usar', label: 'Deshacer y rehacer', description: 'Los botones Deshacer y Rehacer (y Ctrl+Z): pueden devolver una anulación o quitar un alta.', requires: ['finanzas.ver'], sensitive: true, enforce: 'reglas' },
                { key: 'finanzas.limpiar', sub: 'Datos', parent: 'finanzas.usar', label: 'Limpiar la base de datos de este equipo', description: 'Borra la copia local (los datos se restauran desde la nube, pero se pierden cambios pendientes). Pide una contraseña propia de OIKOS.', requires: ['finanzas.config_ver'], sensitive: true, enforce: 'pantalla' }
            ]
        },
        {
            id: 'rondas', title: 'Rondas de vigilancia (RONDIN)', items: [
                { key: 'rondas.ver', sub: 'Acceso', label: 'Ver el panel de rondas', description: 'Abre RONDIN en solo lectura: rutas, turnos, rondas, incidentes y posición de los guardias. Con él vienen todas las pantallas de lectura de abajo.', roles: ['admin', 'supervisor', 'auditor'], requires: ['usuarios.ver'], enforce: 'reglas' },
                { key: 'rondas.gestionar', sub: 'Acceso', label: 'Administrar rondas', description: 'Crear rutas y asignaciones, atender alertas, manejar drones y la configuración. Con él vienen todas las acciones de administración de abajo.', roles: ['admin', 'supervisor'], requires: ['rondas.ver'], enforce: 'reglas' },
                { key: 'rondas.patrullar', sub: 'Acceso', label: 'Patrullar', description: 'La vista del guardia en el teléfono. Con él vienen todas las acciones de patrulla de abajo.', roles: ['policia', 'supervisor'], requires: ['usuarios.ver'], enforce: 'reglas' },

                { key: 'rondas.panel_ver', sub: 'Panel y reportes', parent: 'rondas.ver', label: 'Ver el panel principal', description: 'Los indicadores, el cumplimiento por guardia y la actividad reciente.', enforce: 'pantalla' },
                { key: 'rondas.reportes_ver', sub: 'Panel y reportes', parent: 'rondas.panel_ver', label: 'Ver la inteligencia operativa', description: 'El ranking de guardias, la salud de las rutas, la tendencia semanal y las recomendaciones.', enforce: 'pantalla' },
                { key: 'rondas.reportes_imprimir', sub: 'Panel y reportes', parent: 'rondas.reportes_ver', label: 'Imprimir el reporte semanal', description: 'El reporte del Director General con el desempeño del personal y los incidentes.', sensitive: true, enforce: 'pantalla' },

                { key: 'rondas.rutas_ver', sub: 'Rutas y puntos de control', parent: 'rondas.ver', label: 'Ver rutas y puntos', description: 'El menú Ruta de Monitoreo con sus rutas y puntos de control.', enforce: 'reglas' },
                { key: 'rondas.rutas_crear', sub: 'Rutas y puntos de control', parent: 'rondas.gestionar', label: 'Crear y editar rutas', description: 'La ruta con su nombre, color y descripción.', requires: ['rondas.rutas_ver'], enforce: 'reglas' },
                { key: 'rondas.rutas_eliminar', sub: 'Rutas y puntos de control', parent: 'rondas.gestionar', label: 'Eliminar rutas', description: 'Desactivar una ruta: deja de patrullarse.', requires: ['rondas.rutas_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'rondas.puntos_crear', sub: 'Rutas y puntos de control', parent: 'rondas.gestionar', label: 'Agregar puntos de control', description: 'Un punto nuevo con su ubicación y radio.', requires: ['rondas.rutas_ver'], enforce: 'reglas' },
                { key: 'rondas.puntos_editar', sub: 'Rutas y puntos de control', parent: 'rondas.gestionar', label: 'Renombrar puntos de control', description: 'Cambiar el nombre de un punto.', requires: ['rondas.rutas_ver'], enforce: 'reglas' },
                { key: 'rondas.puntos_eliminar', sub: 'Rutas y puntos de control', parent: 'rondas.gestionar', label: 'Eliminar puntos de control', description: 'Quitar un punto de la ruta.', requires: ['rondas.rutas_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'rondas.asignaciones_ver', sub: 'Asignaciones', parent: 'rondas.ver', label: 'Ver la programación de cobertura', description: 'Qué guardia cubre cada ruta y en qué fechas.', enforce: 'reglas' },
                { key: 'rondas.asignaciones_crear', sub: 'Asignaciones', parent: 'rondas.gestionar', label: 'Asignar guardias a rutas', description: 'Programar el turno de un guardia (12 horas, 24x24 o personalizado).', requires: ['rondas.asignaciones_ver', 'rondas.guardias_ver'], enforce: 'reglas' },
                { key: 'rondas.asignaciones_editar', sub: 'Asignaciones', parent: 'rondas.gestionar', label: 'Editar asignaciones', description: 'Cambiar fechas, horarios o guardia de una asignación.', requires: ['rondas.asignaciones_ver', 'rondas.guardias_ver'], enforce: 'reglas' },
                { key: 'rondas.asignaciones_eliminar', sub: 'Asignaciones', parent: 'rondas.gestionar', label: 'Quitar asignaciones', description: 'Borrar una asignación (se borra el registro).', requires: ['rondas.asignaciones_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'rondas.monitoreo_ver', sub: 'Monitoreo en vivo', parent: 'rondas.ver', label: 'Ver el mapa en vivo', description: 'La posición de los guardias en el mapa (es información de ubicación del personal).', sensitive: true, enforce: 'reglas' },
                { key: 'rondas.monitoreo_historial', sub: 'Monitoreo en vivo', parent: 'rondas.monitoreo_ver', label: 'Ver el historial de ubicaciones', description: 'Dónde estuvo cada guardia en las últimas horas.', sensitive: true, enforce: 'reglas' },
                { key: 'rondas.recorridos_ver', sub: 'Monitoreo en vivo', parent: 'rondas.ver', label: 'Ver visitas a puntos (línea de tiempo, visitas y mapa)', description: 'Qué puntos se marcaron, quién y a qué hora.', enforce: 'reglas' },

                { key: 'rondas.drones_ver', sub: 'Rondín Air (drones)', parent: 'rondas.ver', label: 'Ver Rondín Air', description: 'La pantalla de drones y su última telemetría.', enforce: 'reglas' },
                { key: 'rondas.drones_operar', sub: 'Rondín Air (drones)', parent: 'rondas.gestionar', label: 'Operar y despachar drones', description: 'Los comandos del dron y el despliegue automático cuando suena un pánico.', requires: ['rondas.drones_ver'], sensitive: true, enforce: 'reglas' },
                { key: 'rondas.drones_registrar', sub: 'Rondín Air (drones)', parent: 'rondas.gestionar', label: 'Registrar drones', description: 'Dar de alta un dron.', requires: ['rondas.drones_ver'], enforce: 'reglas' },

                { key: 'rondas.alertas_ver', sub: 'Alertas', parent: 'rondas.ver', label: 'Ver las alertas de rondas', description: 'El menú Alertas, la campana y los avisos de turno iniciado, punto visitado o abandono.', enforce: 'reglas' },
                { key: 'rondas.alertas_atender', sub: 'Alertas', parent: 'rondas.gestionar', label: 'Marcar alertas como atendidas', description: 'El botón de palomita de cada alerta.', requires: ['rondas.alertas_ver'], enforce: 'reglas' },
                { key: 'rondas.alertas_eliminar', sub: 'Alertas', parent: 'rondas.gestionar', label: 'Borrar alertas', description: 'Quitar una alerta del panel (borra evidencia).', requires: ['rondas.alertas_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'rondas.incidentes_ver', sub: 'Incidentes', parent: 'rondas.ver', label: 'Ver incidentes', description: 'El menú Incidentes y los avisos de incidente nuevo.', enforce: 'reglas' },
                { key: 'rondas.incidentes_resolver', sub: 'Incidentes', parent: 'rondas.gestionar', label: 'Resolver y cerrar incidentes', description: 'Cambiar el estado de un incidente.', requires: ['rondas.incidentes_ver'], enforce: 'reglas' },
                { key: 'rondas.incidentes_reportar', sub: 'Incidentes', parent: 'rondas.patrullar', label: 'Reportar incidentes', description: 'El botón Reportar Incidente del guardia, con su foto.', enforce: 'reglas' },

                { key: 'rondas.guardias_ver', sub: 'Guardias y supervisores', parent: 'rondas.ver', label: 'Ver la lista de guardias', description: 'El menú Guardias con su estado y teléfono.', enforce: 'pantalla' },
                { key: 'rondas.guardias_expediente', sub: 'Guardias y supervisores', parent: 'rondas.guardias_ver', label: 'Ver el expediente del guardia', description: 'Sangre, edad, dirección, alergias y contacto de emergencia (datos personales y de salud: esto solo lo oculta en pantalla).', sensitive: true, enforce: 'pantalla' },
                { key: 'rondas.supervisores_ver', sub: 'Guardias y supervisores', parent: 'rondas.ver', label: 'Ver supervisores', description: 'El menú Supervisores con los guardias que tiene cada uno.', enforce: 'pantalla' },
                { key: 'rondas.supervisores_asignar', sub: 'Guardias y supervisores', parent: 'rondas.gestionar', label: 'Asignar guardias a supervisores', description: 'Poner o quitar a un guardia del equipo de un supervisor.', requires: ['rondas.supervisores_ver', 'rondas.guardias_ver'], enforce: 'reglas' },

                { key: 'rondas.vecinos_ver', sub: 'Vecinos y ajustes', parent: 'rondas.ver', label: 'Ver los vecinos en RONDIN', description: 'El menú Vecinos con sus contactos de emergencia (datos personales).', sensitive: true, enforce: 'pantalla' },
                { key: 'rondas.ajustes_ver', sub: 'Vecinos y ajustes', parent: 'rondas.ver', label: 'Ver la configuración de rondas', description: 'El menú Configuración.', enforce: 'pantalla' },
                { key: 'rondas.ajustes_panicovecinos', sub: 'Vecinos y ajustes', parent: 'rondas.gestionar', label: 'Activar el botón de pánico de los vecinos', description: 'Habilita el botón de pánico para todos los vecinos y el menú Vecinos.', requires: ['rondas.ajustes_ver'], sensitive: true, enforce: 'reglas' },

                { key: 'rondas.patrulla_iniciar', sub: 'Vista del guardia (patrulla)', parent: 'rondas.patrullar', label: 'Iniciar turno y ronda', description: 'El botón Iniciar Ronda, con su foto y ubicación.', enforce: 'reglas' },
                { key: 'rondas.patrulla_terminar', sub: 'Vista del guardia (patrulla)', parent: 'rondas.patrullar', label: 'Terminar ronda y turno', description: 'El botón Terminar Ronda.', enforce: 'reglas' },
                { key: 'rondas.patrulla_marcar', sub: 'Vista del guardia (patrulla)', parent: 'rondas.patrullar', label: 'Marcar puntos de control', description: 'Confirmar la visita a cada punto de la ruta.', enforce: 'reglas' },
                { key: 'rondas.patrulla_rastrear', sub: 'Vista del guardia (patrulla)', parent: 'rondas.patrullar', label: 'Compartir la ubicación durante el turno', description: 'Si se quita, el guardia no aparece en el mapa en vivo.', sensitive: true, enforce: 'reglas' }
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
            id: 'sys-cajero', name: 'Cajero (cobra pagos)', role: 'operador', system: true,
            description: 'Solo registra y consulta pagos de los residentes en el Sistema Financiero, con sus comprobantes. No anula ni ve la configuración.',
            claves: [
                'usuarios.ver', 'mensajes.recibir', 'finanzas.ver', 'finanzas.usar', 'finanzas.residentes_ver', 'finanzas.residentes_estado',
                'finanzas.contabilidad_ver', 'finanzas.comprobantes', 'finanzas.pagos_registrar', 'finanzas.reportes_morosos'
            ]
        },
        {
            id: 'sys-auditor-financiero', name: 'Auditor financiero (solo lectura)', role: 'operador', system: true,
            description: 'Ve todo el Sistema Financiero y exporta reportes, sin registrar, anular ni cambiar nada.',
            claves: [
                'usuarios.ver', 'mensajes.recibir', 'finanzas.ver', 'finanzas.usar', 'finanzas.tablero_ver', 'finanzas.residentes_ver', 'finanzas.residentes_datos',
                'finanzas.residentes_estado', 'finanzas.contabilidad_ver', 'finanzas.comprobantes', 'finanzas.reportes_ingresos', 'finanzas.reportes_morosos',
                'finanzas.reportes_gastos', 'finanzas.reportes_libro', 'finanzas.reportes_resumen', 'finanzas.reportes_exportar', 'finanzas.config_ver'
            ]
        },
        {
            id: 'sys-vigilancia-consulta', name: 'Vigilancia (solo lectura)', role: 'operador', system: true,
            description: 'Ve las rondas, el mapa en vivo, los incidentes y las alertas, sin modificar nada.',
            claves: ['usuarios.ver', 'mensajes.recibir', ...tree('rondas.ver'), 'panico.ver']
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
