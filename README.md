# SISDEL Comunities (garita.app)

Control de acceso para condominios: panel master, administrador, vecino y garita con cámara LPR.
Cada administrador decide, usuario por usuario, qué módulos y acciones puede ver o usar su personal (ver "Privilegios por usuario").

## Roles

| Rol | Página | Alcance |
| --- | --- | --- |
| `master` | `master.html` | Todos los condominios. |
| `admin` | `admin.html` | Su condominio: usuarios, códigos, vehículos, visitas y mensajes. |
| `policia` | `garita.html` | Verifica códigos y QR, registra ingresos. |
| `vecino` | `vecino.html` | Sus visitas, vehículos y mensajes. |
| `admin` (finanzas) | `finanzas.html` | Sistema Financiero del condominio (OIKOS): cuotas, ingresos, egresos, estados de cuenta y reportes. |
| `supervisor` | `rondin/` | SISDEL RONDÍN: rutas de monitoreo, guardias en vivo, Rondín Air, alertas, incidentes y vecinos. El admin entra como Director General y el auditor en solo lectura. |
| `policia` (rondas) | `rondin/` | Rondín Móvil: iniciar ronda con foto y GPS, puntos de control, incidentes y botón de pánico. |
| `auditor` | `auditor.html` | Lee todo su condominio menos los códigos de acceso; no puede escribir. Reportes por rango de fechas con exportación CSV e impresión. |
| `operador` | la primera página que le toque | Personal a la medida (secretaria, contador, jefe de seguridad...). Empieza sin ningún privilegio: el administrador le asigna lo que necesite. |

El rol da los privilegios por defecto y la página de inicio. Encima de eso, el administrador puede ampliar o restringir cada usuario.

## Privilegios por usuario

Idea tomada del módulo de Configuración de MULTISYS (catálogo de privilegios por módulo, plantillas y editor por tarjetas), adaptada a SISDEL.

- **Catálogo:** `privilegios.js` (138 privilegios agrupados por módulo: SISDEL, Sistema Financiero y RONDIN; ninguna opción queda sin privilegio). Es la fuente única: lo cargan las páginas y `functions/src/privilegios.js` es una copia idéntica (una prueba falla si difieren).
- **Paraguas y acciones:** hay 29 paraguas (los 26 de siempre y tres de lectura de mensajes y del vecino) y 109 acciones que cuelgan de uno (`parent` en el catálogo, hasta cuatro niveles). Sin el paraguas no hay ninguna acción; con él vienen todas, salvo las que el administrador quite (`{ "finanzas.pagos_anular": false }`). Así quien ya tenía el privilegio amplio no pierde nada, y el administrador puede ir quitando de a una. Las acciones heredan los roles por defecto de su paraguas. En el editor, al marcar una acción se marca su paraguas y lo que necesita (`requires`), y al quitarla se quitan las que dependen de ella.
- **Cada rol trae los suyos por defecto** y son exactamente los accesos que el rol ya tenía. Un usuario sin privilegios asignados no pierde ni gana nada.
- **Lo que asigna el administrador se guarda en `usuarios/{id}.privilegios`**, solo las diferencias con su rol: `{ "finanzas.usar": false }` quita un privilegio, `{ "visitas.gestionar": true }` lo agrega. Vacío = los del rol.
- **Las reglas de Firestore lo leen del documento del usuario** (como ya hacían con `role` y `active`): el cambio aplica al instante, sin volver a iniciar sesión, y no depende del token. Las funciones `pXxx` de `firestore.rules` llevan los roles por defecto de cada clave; `scripts/test-privilegios.mjs` verifica que coincidan con el catálogo.
- **Las páginas muestran solo lo permitido** (`SISDEL.can('clave')`, `SISDEL.requireAuth([], 'pagina.html')`). Lo que se oculta en pantalla también lo bloquean las reglas, salvo lo marcado *Pantalla* en la tabla de abajo.
- **Reglas generadas:** las funciones `pXxx` de `firestore.rules` (una por clave que las reglas aplican) las genera `cd scripts && npm run reglas` a partir del catálogo; la prueba falla si están desactualizadas. Un paraguas se lee con `can(c, clave, roles)` y una acción con `pParaguas(c) && childOk(c, clave)`.
- **El login manda a cada usuario a la página que le toca**: la de su rol y, si el administrador se la quitó, la primera a la que sí puede entrar. Un usuario sin acceso a ninguna página no entra.
- **Quién cambia privilegios:** `usuarios.privilegios` (por defecto solo `admin`; solo un administrador o un operador puede tenerlo) y el master. Nadie cambia los suyos. Crear, editar o eliminar administradores y operadores también exige `usuarios.privilegios`. Con `usuarios.crear` solo se registran vecinos (los guardias, con `guardias.crear`); auditor, supervisor, administrador y operador exigen además `usuarios.privilegios`, porque quien crea una cuenta conoce su código.
- **Códigos de acceso:** un código nuevo solo puede apuntar a un usuario que se crea en la misma escritura (salvo `usuarios.codigos`), así nadie "secuestra" la cuenta de otro. Quien ve códigos no ve los de administradores y operadores sin `usuarios.privilegios`.
- **Eliminar usuarios** también borra sus visitas, vehículos y códigos, y solo en esa misma operación: `usuarios.eliminar` no sirve para vaciar el registro de visitas.
- **Plantillas:** `privilegios.js` trae once del sistema (Secretaria, Contador, Jefe de seguridad, Garitero, Consulta, Cajero, Auditor financiero, Vigilancia de consulta, Fiscalizador, Administrador delegado, Administrador sin finanzas); cada condominio guarda las suyas en `plantillas_privilegios`. Las plantillas guardadas antes de las acciones (solo con el paraguas) se amplían con todas sus acciones al aplicarlas.
- **Fiscalizador:** plantilla para un **vecino** (rol `vecino`, sigue entrando a su panel con todo lo suyo) que además consulta los reportes en solo lectura: la auditoría (usuarios, visitas, vehículos, accesos, mensajes y reportes) y el Sistema Financiero (tablero, residentes sin DPI, estado de cuenta, contabilidad y reportes). No escribe nada ni asigna privilegios. En el formulario de usuario nuevo se elige la plantilla y el rol queda en vecino; desde `vecino.html` ve botones hacia Auditoría y Finanzas, y desde la auditoría puede volver a Mi panel. Teléfonos, correos y DPI se ocultan en pantalla (las reglas dejan leer los usuarios y los datos financieros a quien tiene `usuarios.ver` o `finanzas.ver`); los códigos de acceso y los contactos de emergencia sí los niegan las reglas.

Dónde se usa: en `admin.html`, botón **Configuración** (`admin.html#configuracion`): pestañas Usuarios (lista con filtro por rol y Agregar Usuario), Privilegios (usuarios a la izquierda, tarjetas por módulo a la derecha, plantillas y Guardar / Descartar) y Plantillas (las del sistema en solo lectura; las del condominio se crean, editan y borran); el escudo de cada usuario del panel abre el mismo editor en una ventana. También en `master.html`, y en `garita.html`, `auditor.html`, `vecino.html`, `finanzas.html` y `rondin/` (ver `rondin/js/sisdel-api.js`).

<!-- BEGIN tabla-privilegios (scripts/generar-tabla-privilegios.mjs) -->

138 privilegios: 29 paraguas y 109 acciones. **Garantía** dice quién hace cumplir cada uno: *Reglas* = las reglas de Firestore (o el servidor) lo rechazan aunque se salten la pantalla; *Pantalla* = solo oculta o bloquea en la interfaz (lectura de datos que las reglas no separan por campo).

### Usuarios y vecinos

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `usuarios.panel` | Entrar al panel de administración. Abre admin.html: lista de usuarios, estadísticas y mensajes. | `admin` | Pantalla |
| `usuarios.estadisticas` | Ver las estadísticas del panel. Usuarios, vecinos, morosos y visitas de hoy, en la parte de arriba del panel. | los de su paraguas | Pantalla |
| `usuarios.ver` | Ver usuarios y vecinos. Consultar la lista de vecinos y personal (sin códigos de acceso). | `admin`, `policia`, `supervisor`, `auditor` | Reglas |
| `usuarios.contacto` | Ver teléfono y correo. Los datos de contacto de cada usuario en las listas y el detalle. | los de su paraguas | Pantalla |
| `usuarios.pagos_ver` | Ver el estado de pago. Si un vecino está al día o moroso, y el recuento de morosos. | los de su paraguas | Pantalla |
| `usuarios.crear` | Crear usuarios. Registrar vecinos con su código de acceso. Crear guardias, auditores, supervisores, administradores y operadores exige además Asignar privilegios (los guardias también los crea quien tiene Registrar guardias). | `admin` | Reglas |
| `guardias.crear` | Registrar guardias **(sensible)**. Crear guardias (solo ese rol) y ver el código de acceso de los guardias; con él se puede entrar como cualquier guardia. | `admin`, `supervisor` | Reglas |
| `usuarios.editar` | Editar usuarios. Cambiar nombre, casa, teléfono y cargo de un usuario. | `admin` | Reglas |
| `usuarios.estado` | Activar o desactivar usuarios **(sensible)**. Un usuario desactivado no puede entrar hasta que se vuelva a activar. | los de su paraguas | Reglas |
| `usuarios.pago` | Cambiar el estado de pago **(sensible)**. Marcar a un vecino como moroso o al día a mano (con la mora automática lo calcula el Sistema Financiero). | los de su paraguas | Reglas |
| `usuarios.emergencia` | Editar contactos de emergencia de vecinos. Los familiares a quienes avisa el botón de pánico de un vecino. | los de su paraguas | Reglas |
| `usuarios.eliminar` | Eliminar usuarios **(sensible)**. Borrar usuarios con su código, vehículos y visitas (necesita poder ver los códigos de acceso). | `admin` | Reglas |
| `usuarios.codigos` | Ver y cambiar códigos de acceso **(sensible)**. Ver y reemplazar el código de los vecinos, guardias, auditores y supervisores. Equivale a poder entrar como cualquiera de ellos; los de administradores y operadores solo con Asignar privilegios. | `admin` | Reglas |
| `usuarios.privilegios` | Asignar privilegios **(sensible)**. Cambiar los privilegios de otros usuarios y crear, editar o eliminar administradores y operadores. Equivale a control total del condominio: darlo solo a administradores de confianza. Solo puede tenerlo un administrador o un operador. | `admin` | Reglas |
| `plantillas.gestionar` | Crear, editar y borrar plantillas. Las plantillas de privilegios propias del condominio (las del sistema no se pueden cambiar). | los de su paraguas | Reglas |

### Mensajes

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `mensajes.recibir` | Recibir mensajes. Leer los avisos que la administración manda a su grupo y marcarlos como leídos. | `admin`, `policia`, `supervisor`, `auditor`, `vecino`, `operador` | Reglas |
| `mensajes.enviar` | Enviar mensajes. Escribir avisos para vecinos y guardias. | `admin` | Reglas |
| `mensajes.eliminar` | Borrar mensajes enviados. Quitar un aviso ya enviado. | los de su paraguas | Reglas |
| `mensajes.historial` | Ver todos los mensajes. Leer los mensajes enviados a cualquier grupo, no solo los propios. | `admin`, `auditor` | Reglas |

### Visitas y vehículos

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `visitas.ver` | Ver visitas. Consultar las visitas de todos los vecinos. | `admin`, `policia`, `auditor` | Reglas |
| `vehiculos.ver` | Ver vehículos. Consultar las placas y marbetes de todos los vecinos. | los de su paraguas | Reglas |
| `visitas.gestionar` | Administrar visitas y vehículos. Acceso a crear, editar y borrar visitas y vehículos de cualquier vecino. | `admin` | Reglas |
| `visitas.crear` | Crear visitas. Registrar una visita a nombre de cualquier vecino. | los de su paraguas | Reglas |
| `visitas.editar` | Editar visitas. Cambiar los datos de una visita. | los de su paraguas | Reglas |
| `visitas.eliminar` | Borrar visitas **(sensible)**. Quitar visitas del registro. | los de su paraguas | Reglas |
| `vehiculos.crear` | Registrar vehículos. Agregar placas a un vecino, al crearlo o después. | los de su paraguas | Reglas |
| `vehiculos.editar` | Editar vehículos. Cambiar los datos de un vehículo. | los de su paraguas | Reglas |
| `vehiculos.eliminar` | Quitar vehículos **(sensible)**. Borrar placas de un vecino. | los de su paraguas | Reglas |
| `garita.historial_borrar` | Borrar el historial de la cámara **(sensible)**. Quitar lecturas del historial de accesos de la cámara. | los de su paraguas | Reglas |

### Garita y cámara

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `garita.operar` | Operar la garita. Abre garita.html: verificar vecinos y registrar ingresos. | `admin`, `policia` | Pantalla |
| `garita.escanear` | Usar el escáner QR. Abrir la cámara del dispositivo para leer códigos QR de visitas y marbetes. | los de su paraguas | Pantalla |
| `garita.verificar` | Verificar un código a mano. Escribir el código de acceso, la placa o el QR para validar a una persona (lo valida el servidor). | los de su paraguas | Reglas |
| `garita.ingreso` | Registrar ingresos. Confirmar el ingreso de una visita, un vehículo o un residente. | los de su paraguas | Reglas |
| `garita.visitas_dia` | Ver las visitas del día. La lista de visitas esperadas hoy, con su botón Validar. | los de su paraguas | Pantalla |
| `garita.morosos` | Ver el aviso de morosos. El recuento de vecinos morosos y la alerta de restricción de acceso. | los de su paraguas | Pantalla |
| `garita.camara` | Ver el historial de la cámara. Consultar los accesos y lecturas de la cámara de placas. | `admin`, `policia`, `auditor` | Reglas |
| `garita.vivo` | Recibir avisos en vivo de la cámara. Aviso y pantalla grande cada vez que la cámara lee una placa. | los de su paraguas | Pantalla |
| `garita.historial` | Ver el historial de accesos del día. Los últimos ingresos del día en la garita. | los de su paraguas | Pantalla |

### Panel del vecino

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `vecino.visitas` | Crear pases de visita. El vecino genera y cancela los pases de sus visitas. | `vecino` | Reglas |
| `vecino.temporal` | Crear accesos temporales. Un pase válido por varios días para un invitado. | los de su paraguas | Reglas |
| `vecino.compartir` | Compartir y descargar el pase. Enviar el pase por WhatsApp o descargarlo como imagen. | los de su paraguas | Pantalla |
| `vecino.historial` | Ver sus visitas recientes. La lista de sus visitas y su estado. | `vecino` | Reglas |
| `vecino.vehiculos` | Registrar sus vehículos. El vecino registra sus vehículos. | `vecino` | Reglas |
| `vecino.vehiculos_quitar` | Quitar sus vehículos. El vecino borra un vehículo registrado. | los de su paraguas | Reglas |
| `vecino.marbete` | Ver y descargar su marbete. El pase vehicular con su código QR. | los de su paraguas | Pantalla |
| `vecino.contactos` | Editar sus contactos de emergencia. Los familiares a quienes avisa su botón de pánico. | `vecino` | Reglas |
| `panico.activar` | Usar el botón de pánico. Enviar una alerta de pánico a la garita y a la administración. | `vecino`, `policia`, `supervisor` | Reglas |
| `panico.cancelar` | Cancelar su alerta. El vecino anula su alerta de pánico mientras siga activa. | los de su paraguas | Reglas |

### Alertas de pánico

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `panico.ver` | Ver alertas de pánico. Ver las alertas activas y su historial. | `admin`, `policia`, `supervisor`, `auditor` | Reglas |
| `panico.contactos` | Ver los contactos de emergencia. Los familiares registrados por los vecinos. | los de su paraguas | Reglas |
| `panico.avisos` | Recibir avisos y sirena. La barra roja y el sonido cuando llega una alerta nueva. | los de su paraguas | Pantalla |
| `panico.atender` | Atender alertas de pánico. Marcar las alertas como atendidas. | `admin`, `policia`, `supervisor` | Reglas |
| `panico.resolver` | Resolver alertas de pánico. Cerrar una alerta con sus notas. | los de su paraguas | Reglas |

### Sistema Financiero (OIKOS)

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `finanzas.ver` | Leer datos financieros. Leer cuotas, cargos, pagos y egresos (solo lectura). Las reglas dejan leer los datos a quien lo tiene; qué pantallas ve en OIKOS lo decide cada privilegio de abajo. | `admin`, `auditor` | Reglas |
| `finanzas.usar` | Usar el Sistema Financiero **(sensible)**. Abre finanzas.html. Con él vienen todas las pantallas y acciones de abajo; se pueden quitar una por una. Para registrar residentes nuevos o cambiar sus datos desde ahí también necesita Crear usuarios y Editar usuarios. | `admin` | Reglas |
| `finanzas.tablero_ver` | Ver el tablero. Saldo en caja, total de ingresos y gastos, gráfica de tendencia y alerta de residentes en mora. | los de su paraguas | Pantalla |
| `finanzas.residentes_ver` | Ver residentes. La lista de residentes con su saldo y mora, y el buscador. | los de su paraguas | Pantalla |
| `finanzas.residentes_datos` | Ver DPI, lote y observaciones **(sensible)**. Las columnas y campos de datos personales del residente (el DPI viaja con los datos financieros: esto solo lo oculta en pantalla). | los de su paraguas | Pantalla |
| `finanzas.residentes_estado` | Ver estado de cuenta y detalle de movimientos. Abrir el estado de cuenta de un residente y el detalle de cada movimiento. | los de su paraguas | Pantalla |
| `finanzas.residentes_crear` | Registrar residentes nuevos **(sensible)**. Crea también al vecino en SISDEL con su código de acceso (que se muestra al guardar): equivale a poder entrar como ese vecino. | los de su paraguas | Reglas |
| `finanzas.residentes_editar` | Editar residentes. Cambiar nombre, teléfono, DPI, lote y observaciones. | los de su paraguas | Reglas |
| `finanzas.residentes_finiquitar` | Finiquitar y reactivar residentes **(sensible)**. Cerrar la relación con un residente (deja de cobrársele) o reactivarlo. | los de su paraguas | Reglas |
| `finanzas.residentes_eliminar` | Eliminar residentes **(sensible)**. Quitar del Sistema Financiero a un residente que no tiene movimientos. | los de su paraguas | Reglas |
| `finanzas.residentes_contactar` | Recordatorios y WhatsApp. Avisar por WhatsApp a los residentes en mora o con saldo pendiente. | los de su paraguas | Pantalla |
| `finanzas.cuotas_mes` | Cobrar la cuota del mes a todos **(sensible)**. El botón Cuota del mes y la generación automática de cuotas: afecta a todos los residentes. | los de su paraguas | Reglas |
| `finanzas.cuotas_meses` | Cargar cuotas por mes a un residente. Elegir los meses que se le cobran al crear o editar un residente. | los de su paraguas | Reglas |
| `finanzas.cuotas_corregir` | Corregir cuotas duplicadas **(sensible)**. Anular en bloque las cuotas repetidas. | los de su paraguas | Reglas |
| `finanzas.cargos_crear` | Crear cargos especiales y multas **(sensible)**. Un cargo a todos los residentes o a uno solo, con el concepto que se elija. | los de su paraguas | Reglas |
| `finanzas.cargos_anular` | Anular cargos **(sensible)**. Anular una cuota o un cargo especial desde el estado de cuenta. | los de su paraguas | Reglas |
| `finanzas.contabilidad_ver` | Ver la contabilidad. La lista de pagos y egresos con sus filtros y detalle. | los de su paraguas | Pantalla |
| `finanzas.comprobantes` | Imprimir y descargar comprobantes. El comprobante de un ingreso o egreso y la imagen del documento adjunto. | los de su paraguas | Pantalla |
| `finanzas.pagos_registrar` | Registrar pagos. Registrar el pago de un residente, con su documento y observaciones. | los de su paraguas | Reglas |
| `finanzas.pagos_anular` | Anular pagos **(sensible)**. Anular un pago ya registrado. | los de su paraguas | Reglas |
| `finanzas.egresos_registrar` | Registrar egresos. Registrar un gasto del condominio, con su categoría y documento. | los de su paraguas | Reglas |
| `finanzas.egresos_anular` | Anular egresos **(sensible)**. Anular un gasto ya registrado. | los de su paraguas | Reglas |
| `finanzas.reportes_ingresos` | Reporte de ingresos por período. Ingresos por mes con el detalle de cada uno. | los de su paraguas | Pantalla |
| `finanzas.reportes_morosos` | Reporte de morosos. Residentes en mora y meses adeudados, y las listas de al día y morosos. | los de su paraguas | Pantalla |
| `finanzas.reportes_gastos` | Reporte de gastos por categoría. En qué se gasta el dinero del condominio. | los de su paraguas | Pantalla |
| `finanzas.reportes_libro` | Estado de cuenta general. El libro cronológico de pagos y egresos con saldo acumulado. | los de su paraguas | Pantalla |
| `finanzas.reportes_resumen` | Reporte financiero mensual o por período. Ingresos netos, gastos y balance, con su resumen para WhatsApp. | los de su paraguas | Pantalla |
| `finanzas.reportes_exportar` | Exportar e imprimir **(sensible)**. Descargar o imprimir reportes, estados de cuenta y listas en PDF o Excel: saca datos del sistema. | los de su paraguas | Pantalla |
| `finanzas.config_ver` | Ver la configuración. La pantalla de configuración con la cuota, el cobro y los conceptos. | los de su paraguas | Pantalla |
| `finanzas.config_general` | Cambiar nombre, idioma, moneda y tema. Estos datos son comunes a todos los usuarios del condominio. | los de su paraguas | Reglas |
| `finanzas.config_cuota` | Cambiar la cuota y el cobro **(sensible)**. Cuota mensual, día de cobro, días de gracia y cobro automático o manual: decide lo que se cobra y quién está en mora. | los de su paraguas | Reglas |
| `finanzas.config_conceptos` | Editar los conceptos frecuentes. Los conceptos de ingresos y egresos que se repiten. | los de su paraguas | Reglas |
| `finanzas.deshacer` | Deshacer y rehacer **(sensible)**. Los botones Deshacer y Rehacer (y Ctrl+Z): quitan un alta o devuelven una anulación, solo de movimientos hechos en las últimas 2 horas. | los de su paraguas | Reglas |
| `finanzas.limpiar` | Limpiar la base de datos de este equipo **(sensible)**. Borra la copia local (los datos se restauran desde la nube, pero se pierden cambios pendientes). Pide una contraseña propia de OIKOS. | los de su paraguas | Pantalla |

### Rondas de vigilancia (RONDIN)

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `rondas.ver` | Ver el panel de rondas. Abre RONDIN en solo lectura: rutas, turnos, rondas, incidentes y posición de los guardias. Con él vienen todas las pantallas de lectura de abajo. | `admin`, `supervisor`, `auditor` | Reglas |
| `rondas.gestionar` | Administrar rondas. Crear rutas y asignaciones, atender alertas, manejar drones y la configuración. Con él vienen todas las acciones de administración de abajo. | `admin`, `supervisor` | Reglas |
| `rondas.patrullar` | Patrullar. La vista del guardia en el teléfono. Con él vienen todas las acciones de patrulla de abajo. | `policia`, `supervisor` | Reglas |
| `rondas.panel_ver` | Ver el panel principal. Los indicadores, el cumplimiento por guardia y la actividad reciente. | los de su paraguas | Pantalla |
| `rondas.reportes_ver` | Ver la inteligencia operativa. El ranking de guardias, la salud de las rutas, la tendencia semanal y las recomendaciones. | los de su paraguas | Pantalla |
| `rondas.reportes_imprimir` | Imprimir el reporte semanal **(sensible)**. El reporte del Director General con el desempeño del personal y los incidentes. | los de su paraguas | Pantalla |
| `rondas.rutas_ver` | Ver rutas y puntos. El menú Ruta de Monitoreo con sus rutas y puntos de control. | los de su paraguas | Reglas |
| `rondas.rutas_crear` | Crear y editar rutas. La ruta con su nombre, color y descripción. | los de su paraguas | Reglas |
| `rondas.rutas_eliminar` | Eliminar rutas **(sensible)**. Desactivar una ruta: deja de patrullarse. | los de su paraguas | Reglas |
| `rondas.puntos_crear` | Agregar puntos de control. Un punto nuevo con su ubicación y radio. | los de su paraguas | Reglas |
| `rondas.puntos_editar` | Renombrar puntos de control. Cambiar el nombre de un punto. | los de su paraguas | Reglas |
| `rondas.puntos_eliminar` | Eliminar puntos de control **(sensible)**. Quitar un punto de la ruta. | los de su paraguas | Reglas |
| `rondas.asignaciones_ver` | Ver la programación de cobertura. Qué guardia cubre cada ruta y en qué fechas. | los de su paraguas | Reglas |
| `rondas.asignaciones_crear` | Asignar guardias a rutas. Programar el turno de un guardia (12 horas, 24x24 o personalizado). | los de su paraguas | Reglas |
| `rondas.asignaciones_editar` | Editar asignaciones. Cambiar fechas, horarios o guardia de una asignación. | los de su paraguas | Reglas |
| `rondas.asignaciones_eliminar` | Quitar asignaciones **(sensible)**. Borrar una asignación (se borra el registro). | los de su paraguas | Reglas |
| `rondas.monitoreo_ver` | Ver el mapa en vivo **(sensible)**. La posición de los guardias en el mapa (es información de ubicación del personal). | los de su paraguas | Reglas |
| `rondas.monitoreo_historial` | Ver el historial de ubicaciones **(sensible)**. Dónde estuvo cada guardia en las últimas horas. | los de su paraguas | Reglas |
| `rondas.recorridos_ver` | Ver visitas a puntos (línea de tiempo, visitas y mapa). Qué puntos se marcaron, quién y a qué hora. | los de su paraguas | Reglas |
| `rondas.drones_ver` | Ver Rondín Air. La pantalla de drones y su última telemetría. | los de su paraguas | Reglas |
| `rondas.drones_operar` | Operar y despachar drones **(sensible)**. Los comandos del dron y el despliegue automático cuando suena un pánico. | los de su paraguas | Reglas |
| `rondas.drones_registrar` | Registrar drones. Dar de alta un dron. | los de su paraguas | Reglas |
| `rondas.alertas_ver` | Ver las alertas de rondas. El menú Alertas, la campana y los avisos de turno iniciado, punto visitado o abandono. | los de su paraguas | Reglas |
| `rondas.alertas_atender` | Marcar alertas como atendidas. El botón de palomita de cada alerta. | los de su paraguas | Reglas |
| `rondas.alertas_eliminar` | Borrar alertas **(sensible)**. Quitar una alerta del panel (borra evidencia). | los de su paraguas | Reglas |
| `rondas.incidentes_ver` | Ver incidentes. El menú Incidentes y los avisos de incidente nuevo. | los de su paraguas | Reglas |
| `rondas.incidentes_resolver` | Resolver y cerrar incidentes. Cambiar el estado de un incidente. | los de su paraguas | Reglas |
| `rondas.incidentes_reportar` | Reportar incidentes. El botón Reportar Incidente del guardia, con su foto. | los de su paraguas | Reglas |
| `rondas.guardias_ver` | Ver la lista de guardias. El menú Guardias con su estado y teléfono. | los de su paraguas | Pantalla |
| `rondas.guardias_expediente` | Ver el expediente del guardia **(sensible)**. Sangre, edad, dirección, alergias y contacto de emergencia (datos personales y de salud: esto solo lo oculta en pantalla). | los de su paraguas | Pantalla |
| `rondas.supervisores_ver` | Ver supervisores. El menú Supervisores con los guardias que tiene cada uno. | los de su paraguas | Pantalla |
| `rondas.supervisores_asignar` | Asignar guardias a supervisores. Poner o quitar a un guardia del equipo de un supervisor. | los de su paraguas | Reglas |
| `rondas.vecinos_ver` | Ver los vecinos en RONDIN **(sensible)**. El menú Vecinos con sus contactos de emergencia (datos personales). | los de su paraguas | Pantalla |
| `rondas.ajustes_ver` | Ver la configuración de rondas. El menú Configuración. | los de su paraguas | Pantalla |
| `rondas.ajustes_panicovecinos` | Guardar la configuración de rondas **(sensible)**. Activa o desactiva el botón de pánico de todos los vecinos (y con él el menú Vecinos) y guarda el país y el logo de RONDIN. | los de su paraguas | Reglas |
| `rondas.patrulla_iniciar` | Iniciar turno y ronda. El botón Iniciar Ronda, con su foto y ubicación. | los de su paraguas | Reglas |
| `rondas.patrulla_terminar` | Terminar ronda y turno. El botón Terminar Ronda. | los de su paraguas | Reglas |
| `rondas.patrulla_marcar` | Marcar puntos de control. Confirmar la visita a cada punto de la ruta. | los de su paraguas | Reglas |
| `rondas.patrulla_rastrear` | Compartir la ubicación durante el turno **(sensible)**. Si se quita, el guardia no aparece en el mapa en vivo. | los de su paraguas | Reglas |

### Auditoría

| Privilegio | Qué permite | Por defecto | Garantía |
| --- | --- | --- | --- |
| `auditoria.ver` | Entrar al panel de auditoría. Abre auditor.html. Cada pestaña pide además su privilegio de lectura de los datos. | `auditor` | Pantalla |
| `auditoria.usuarios` | Pestaña Usuarios. La lista de usuarios del condominio (necesita Ver usuarios). | los de su paraguas | Pantalla |
| `auditoria.visitas` | Pestaña Visitas. Las visitas por rango de fechas (necesita Ver visitas). | los de su paraguas | Pantalla |
| `auditoria.vehiculos` | Pestaña Vehículos. Las placas y marbetes de todos los vecinos (necesita Ver vehículos). | los de su paraguas | Pantalla |
| `auditoria.accesos` | Pestaña Accesos. El historial de la cámara y la garita por rango de fechas (necesita Ver el historial de la cámara). | los de su paraguas | Pantalla |
| `auditoria.mensajes` | Pestaña Mensajes. Todos los mensajes enviados (necesita Ver todos los mensajes). | los de su paraguas | Pantalla |
| `auditoria.reportes` | Pestaña Reportes. El reporte por rango de fechas con gráficas y tablas (necesita ver usuarios, visitas y accesos). | los de su paraguas | Pantalla |
| `auditoria.imprimir` | Imprimir o guardar en PDF. El botón Imprimir / PDF del reporte. | los de su paraguas | Pantalla |
| `auditoria.exportar` | Exportar reportes **(sensible)**. Acceso a descargar los reportes del panel de auditoría en CSV. | `auditor` | Pantalla |
| `auditoria.exportar_accesos` | Exportar accesos (CSV). Las lecturas de la cámara y los ingresos del rango. | los de su paraguas | Pantalla |
| `auditoria.exportar_visitas` | Exportar visitas (CSV). Las visitas del rango con quién las autorizó. | los de su paraguas | Pantalla |
| `auditoria.exportar_usuarios` | Exportar usuarios (CSV) **(sensible)**. La lista de usuarios con teléfono, correo y estado de pago. | los de su paraguas | Pantalla |

<!-- END tabla-privilegios -->

### Cómo se hace cumplir en el Sistema Financiero (OIKOS) y en RONDIN

OIKOS (`finanzas/`) y RONDIN (`rondin/`) nacieron como copias de MULTISYS y RONDIN, y desde 2026-11-09 se mantienen solo en este repo. Los privilegios se aplican desde fuera (`finanzas.html`, `finanzas-bloqueo.js`, `rondin/js/sisdel-api.js`), sin ensuciar su código. Cada privilegio se aplica en capas:

| Capa | Qué hace | Dónde | ¿Es seguridad? |
| --- | --- | --- | --- |
| Reglas de Firestore | Rechazan la escritura por colección, tipo de movimiento, campos que cambian y operación (puntos agregados, quitados o renombrados...) | `firestore.rules` | **Sí** |
| Filtro de subida (OIKOS) | Descarta lo que el usuario no puede escribir y deja la copia local igual que la nube (sin datos fantasma) | `finanzas-sync.js` | Ayuda (la barrera real son las reglas) |
| Bloqueo de pantalla (OIKOS) | Oculta menús y botones, bloquea clics, formularios y atajos, redirige a la primera pantalla permitida | `finanzas-bloqueo.js`, `finanzas.html` | No |
| Tabla de rutas y pantallas (RONDIN) | `route()` devuelve 403 si falta el privilegio de la ruta; oculta menús y botones; lista blanca de pantallas | `rondin/js/privilegios-rondin.js`, `rondin/js/sisdel-api.js` | Parcial (cubre la API del cliente, no la consola de Firestore) |

Lo que **garantizan las reglas** (columna *Reglas* de la tabla): ver datos financieros (`finanzas.ver`), registrar pagos, egresos, cargos y cuotas (cada tipo de movimiento con su privilegio), anular (por tipo) y deshacer, editar, finiquitar o eliminar residentes, y la configuración (cuota y cobro, datos generales y conceptos por separado); y en RONDIN las rutas, los puntos de control, las asignaciones, las alertas, los incidentes, los drones, la configuración, la patrulla (iniciar, marcar, terminar, compartir la ubicación) y ver el mapa en vivo y el historial de ubicaciones.

Lo que **solo oculta la pantalla** (columna *Pantalla*): ver el tablero, la lista de residentes, el DPI y el lote (viajan con los datos financieros), el estado de cuenta, la contabilidad, cada reporte y su exportación o impresión, la configuración en solo lectura, y en RONDIN el panel, los reportes, el expediente del guardia y las pantallas de lectura. Las reglas leen los datos financieros o de rondas completos a quien tiene `finanzas.ver` o `rondas.ver`: un usuario técnico podría leerlos desde la consola. Separarlos exigiría guardarlos en documentos distintos.

Detalles que conviene saber:

- **Deshacer** (`finanzas.deshacer`, sensible) solo alcanza movimientos hechos en las últimas 2 horas (reglas y filtro de subida): sin ese límite anularía cualquier movimiento aunque no se tenga "anular pagos".
- **Cuotas manuales:** el botón Cuota del mes, los meses de un residente y un cargo con concepto de cuota escriben el mismo tipo de movimiento y las reglas no los distinguen entre sí; basta cualquiera de los tres privilegios. Las cuotas automáticas (`auto: true`) exigen "Cobrar la cuota del mes". Si OIKOS las genera al abrir para alguien sin ese privilegio, el filtro las descarta en silencio.
- **Registrar un pago** también re-sella al residente y avanza el contador de recibos: las reglas admiten esas escrituras operativas (solo `updated_at`, `receiptCounter`, `chargedMonths`...) a quien use el Sistema Financiero.
- **Residente nuevo desde OIKOS** crea también al vecino con su código (`finanzas.residentes_crear` requiere `usuarios.crear`); el toast muestra el código, así que es sensible.

Para agregar un privilegio: una entrada en `privilegios.js` (con `parent` si es una acción, `requires` si depende de otro, `enforce` y sus roles por defecto si es paraguas), copiar el archivo a `functions/src/privilegios.js`, `cd scripts && npm run reglas` (regenera las funciones `pXxx`) y usar la función en la regla que corresponda; mostrar u ocultar lo que corresponda en la página (`finanzas-bloqueo.js`, `rondin/js/privilegios-rondin.js` o la propia página), regenerar la tabla de este README con `node scripts/generar-tabla-privilegios.mjs` y subir la versión (`?v=`) de los scripts que cambiaron en los HTML. `cd scripts && npm test` avisa si algo no coincide.

## Cuota mensual desglosada

En **Sistema Financiero > Configuración** la cuota mensual se escribe por conceptos: **mantenimiento, agua, recolección de basura, electricidad y otros**. La Cuota Mensual es la suma (no se escribe a mano). Al cobrar la cuota, sea automática, con «Cuota del mes» o desde un residente, queda **una sola línea** cuya descripción nombra solo los conceptos que tienen monto:

| Mantenimiento | Agua | Basura | Resultado |
| --- | --- | --- | --- |
| 400 | 100 | | `Por aporte para mantenimiento y servicio de agua Q 500.00` |
| 500 | | | `Por aporte para mantenimiento Q 500.00` |
| 300 | 100 | 50 | `Por aporte para mantenimiento, servicio de agua y recolección de basura Q 450.00` |

El detalle del movimiento muestra además cada concepto con su monto. Las cuotas ya cobradas conservan su descripción; sin desglose configurado la cuota sigue llamándose «Cuota - Mes Año». Cambiar el desglose es un privilegio de la cuota (`finanzas.config_cuota`).

## Stack

- **Frontend:** HTML + Vanilla JS, sin build. SDK de Firebase por CDN.
- **Base de datos:** Firestore, proyecto `sisdel-datacenter`.
- **Backend:** Cloud Functions (Node 22) en `functions/`.
- **Login:** código de acceso validado en el servidor, que entrega un token de Firebase Auth.

## Estructura de datos

```
condominios/{condoId}
    usuarios/{userId}               rol, datos, `cargo` y `privilegios` (solo las diferencias con su rol)
    plantillas_privilegios/{id}     plantillas de privilegios del condominio (nombre, rol sugerido, claves)
    visitas/{visitId}
    vehiculos/{vehicleId}
    mensajes/{msgId}
    camera_logs/{logId}
    finanzas_residentes/{userId}    datos financieros del vecino (DPI, lote, notas, finiquito)
    finanzas_movimientos/{id}       cargos, pagos y egresos del Sistema Financiero
    finanzas_config/oikos_settings  cuota, dia de cobro, moneda
    rondas_config/general           configuracion de RONDIN (boton de panico de vecinos)
    rondas_personal/{userId}        expediente del guardia (DPI, sangre, supervisor)
    rondas_rutas/{id}               rutas con sus puntos de control
    rondas_asignaciones/{id}        que guardia patrulla que ruta y cuando
    rondas_turnos/{id}              turnos (check-in y check-out con GPS y foto)
    rondas_rondas/{id}              cada vuelta a la ruta, con su puntaje
    rondas_visitas/{id}             puntos marcados (no se editan)
    rondas_en_vivo/{userId}         posicion actual de cada guardia
    rondas_ubicaciones/{id}         historial de posiciones (30 dias)
    rondas_incidentes/{id}          incidentes reportados en ronda
    rondas_alertas/{id}             alertas del panel de RONDIN (90 dias)
    rondas_fotos/{id}               fotos comprimidas de turnos e incidentes
    rondas_drones/{id}              Rondin Air: drones y su ultima telemetria
    alertas_panico/{id}             boton de panico de vecinos y guardias
    emergencia/{userId}             contactos de emergencia del vecino
codigos/{codigo}            índice único código -> usuario
mensajes_globales/{msgId}   mensajes del master para todos
camera_logs_huerfanos/      lecturas de cámara sin condominio válido
_privado/                   solo servidor (huella del código master, límites de intentos)
```

Los códigos de acceso no se guardan dentro del usuario. Así un guardia o un vecino no puede leer el código del administrador.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `firebase-client.js` | Conexión a Firebase. En localhost usa los emuladores. |
| `sisdel-core.js` | Capa de datos y sesión. Las páginas solo usan `SISDEL.*`. |
| `privilegios.js`, `functions/src/privilegios.js` | Catálogo de privilegios (copia idéntica en las functions). |
| `privilegios-ui.js` | Editor de privilegios por tarjetas, con paraguas y acciones (admin.html y master.html). |
| `firestore.rules` | Permisos por privilegio (con los del rol por defecto) y por condominio. |
| `functions/src/auth.js` | Login (con destino según privilegios) y verificación de códigos en garita. |
| `functions/src/anpr/` | Webhook de la cámara LPR. |
| `rondin/` | SISDEL RONDÍN con su diseño; `rondin/js/sisdel-api.js` lo conecta con la base de SISDEL. |
| `rondas-core.js`, `panico-alertas.js` | Botón de pánico del vecino y alertas de pánico en garita y admin. |
| `functions/src/rondas/` | Avisos de pánico por WhatsApp y limpieza diaria de rondas. |
| `functions/src/finanzas/` | Mora automática: cuotas del mes y estado de pago de cada vecino según el Sistema Financiero. |
| `finanzas/` | Sistema Financiero (OIKOS), que se mantiene aquí. `finanzas/sisdel-cuotas.js` arma el desglose de la cuota (`functions/src/finanzas/cuotas.js` es su copia idéntica). |
| `finanzas.html`, `finanzas-sync.js` | Abren OIKOS dentro de SISDEL y sincronizan sus datos con Firestore (con el filtro de subida por privilegios). |
| `finanzas-bloqueo.js` | Privilegios dentro de OIKOS: oculta y bloquea en pantalla lo que el usuario no puede usar. |
| `rondin/js/privilegios-rondin.js` | Qué privilegio exige cada ruta, pantalla y botón de RONDIN. |
| `scripts/` | Pruebas, datos de prueba, generadores (`npm run reglas`, `generar-tabla-privilegios.mjs`) y migración. No se publican. |

## Desarrollo local

```bash
firebase emulators:start --only auth,firestore,functions,hosting
```

```bash
cd scripts && npm run seed && npm test
```

`npm test` corre seis archivos sin emuladores (privilegios y páginas, sincronización financiera, bloqueo de pantalla de OIKOS, mora, limpieza de rondas y privilegios de RONDIN) y uno contra los emuladores (`test-emulator.mjs`: login, reglas por rol, privilegios por usuario y por acción, cámara, finanzas y rondas). Con los emuladores arriba: `npm run seed` antes de cada corrida (el login se bloquea tras muchos intentos fallidos).

Luego abrir http://127.0.0.1:5050. Los códigos de prueba están en `scripts/dev-seed.json`.

## Deploy

Siempre desde `main`, uno a la vez.

```bash
firebase deploy --only firestore,functions,hosting
```

## Cámara LPR

La cámara envía a `https://garita.app/api/lpr?condominioId=<id del condominio>`.
También se aceptan `/api/anpr`, `/LAPI/*` y `/NotificationInfo/*`.
