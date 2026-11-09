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

- **Catálogo:** `privilegios.js` (26 privilegios agrupados por módulo). Es la fuente única: lo cargan las páginas y `functions/src/privilegios.js` es una copia idéntica (una prueba falla si difieren).
- **Cada rol trae los suyos por defecto** y son exactamente los accesos que el rol ya tenía. Un usuario sin privilegios asignados no pierde ni gana nada.
- **Lo que asigna el administrador se guarda en `usuarios/{id}.privilegios`**, solo las diferencias con su rol: `{ "finanzas.usar": false }` quita un privilegio, `{ "visitas.gestionar": true }` lo agrega. Vacío = los del rol.
- **Las reglas de Firestore lo leen del documento del usuario** (como ya hacían con `role` y `active`): el cambio aplica al instante, sin volver a iniciar sesión, y no depende del token. Las funciones `pXxx` de `firestore.rules` llevan los roles por defecto de cada clave; `scripts/test-privilegios.mjs` verifica que coincidan con el catálogo.
- **Las páginas muestran solo lo permitido** (`SISDEL.can('clave')`, `SISDEL.requireAuth([], 'pagina.html')`). Lo que se oculta en pantalla también lo bloquean las reglas.
- **El login manda a cada usuario a la página que le toca**: la de su rol y, si el administrador se la quitó, la primera a la que sí puede entrar. Un usuario sin acceso a ninguna página no entra.
- **Quién cambia privilegios:** `usuarios.privilegios` (por defecto solo `admin`; solo un administrador o un operador puede tenerlo) y el master. Nadie cambia los suyos. Crear, editar o eliminar administradores y operadores también exige `usuarios.privilegios`. Con `usuarios.crear` solo se registran vecinos (los guardias, con `guardias.crear`); auditor, supervisor, administrador y operador exigen además `usuarios.privilegios`, porque quien crea una cuenta conoce su código.
- **Códigos de acceso:** un código nuevo solo puede apuntar a un usuario que se crea en la misma escritura (salvo `usuarios.codigos`), así nadie "secuestra" la cuenta de otro. Quien ve códigos no ve los de administradores y operadores sin `usuarios.privilegios`.
- **Eliminar usuarios** también borra sus visitas, vehículos y códigos, y solo en esa misma operación: `usuarios.eliminar` no sirve para vaciar el registro de visitas.
- **Plantillas:** `privilegios.js` trae siete del sistema (Secretaria, Contador, Jefe de seguridad, Garitero, Consulta, Administrador delegado, Administrador sin finanzas); cada condominio guarda las suyas en `plantillas_privilegios`.

Dónde se usa: en `admin.html` (crear usuario con rol, cargo y plantilla; botón de escudo en cada usuario para abrir el editor de privilegios), también en `master.html`, y en `garita.html`, `auditor.html`, `vecino.html`, `finanzas.html` y `rondin/` (ver `rondin/js/sisdel-api.js`).

| Privilegio | Qué permite | Lo traen por defecto |
| --- | --- | --- |
| `usuarios.panel` | Entrar al panel de administración. Abre admin.html: lista de usuarios, estadísticas y mensajes. | `admin` |
| `usuarios.ver` | Ver usuarios y vecinos. Consultar la lista de vecinos y personal (sin códigos de acceso). | `admin`, `policia`, `supervisor`, `auditor` |
| `usuarios.crear` | Crear usuarios. Registrar vecinos con su código de acceso. Crear guardias, auditores, supervisores, administradores y operadores exige además Asignar privilegios (los guardias también los crea quien tiene Registrar guardias). | `admin` |
| `guardias.crear` | Registrar guardias. Crear guardias (solo ese rol) y ver el código de acceso de los guardias; con él se puede entrar como cualquier guardia. | `admin`, `supervisor` |
| `usuarios.editar` | Editar usuarios. Cambiar nombre, casa, teléfono, cargo y estado de un usuario (activarlo o desactivarlo) y su estado de pago. | `admin` |
| `usuarios.eliminar` | Eliminar usuarios **(sensible)**. Borrar usuarios con su código, vehículos y visitas (necesita poder ver los códigos de acceso). | `admin` |
| `usuarios.codigos` | Ver y cambiar códigos de acceso **(sensible)**. Ver y reemplazar el código de los vecinos, guardias, auditores y supervisores. Equivale a poder entrar como cualquiera de ellos; los de administradores y operadores solo con Asignar privilegios. | `admin` |
| `usuarios.privilegios` | Asignar privilegios **(sensible)**. Cambiar los privilegios de otros usuarios y crear, editar o eliminar administradores y operadores. Equivale a control total del condominio: darlo solo a administradores de confianza. Solo puede tenerlo un administrador o un operador. | `admin` |
| `mensajes.enviar` | Enviar y borrar mensajes. Escribir avisos para vecinos y guardias y borrar los enviados. | `admin` |
| `mensajes.historial` | Ver todos los mensajes. Leer los mensajes enviados a cualquier grupo, no solo los propios. | `admin`, `auditor` |
| `visitas.ver` | Ver visitas y vehículos. Consultar las visitas y los vehículos de todos los vecinos. | `admin`, `policia`, `auditor` |
| `visitas.gestionar` | Gestionar visitas y vehículos. Crear, editar y borrar visitas y vehículos de cualquier vecino, y limpiar el historial de la cámara. | `admin` |
| `garita.operar` | Operar la garita. Abre garita.html: escanear códigos y placas, verificar vecinos y registrar ingresos. | `admin`, `policia` |
| `garita.camara` | Ver el historial de la cámara. Consultar los accesos y lecturas de la cámara de placas. | `admin`, `policia`, `auditor` |
| `vecino.visitas` | Crear pases de visita. El vecino genera y cancela los pases de sus visitas. | `vecino` |
| `vecino.vehiculos` | Registrar sus vehículos. El vecino registra y quita sus vehículos. | `vecino` |
| `panico.activar` | Usar el botón de pánico. Enviar una alerta de pánico a la garita y a la administración. | `vecino`, `policia`, `supervisor` |
| `panico.ver` | Ver alertas de pánico. Ver las alertas y los contactos de emergencia de los vecinos. | `admin`, `policia`, `supervisor`, `auditor` |
| `panico.atender` | Atender alertas de pánico. Marcar las alertas como atendidas o resueltas. | `admin`, `policia`, `supervisor` |
| `finanzas.ver` | Leer datos financieros. Ver cuotas, cargos y pagos de los residentes (solo lectura). | `admin`, `auditor` |
| `finanzas.usar` | Usar el Sistema Financiero **(sensible)**. Abre finanzas.html: cargos, pagos, egresos y reportes. Para registrar residentes nuevos o cambiar sus datos desde ahí también necesita Crear usuarios y Editar usuarios. | `admin` |
| `rondas.ver` | Ver el panel de rondas. Consultar rutas, turnos, rondas, incidentes y la posición de los guardias (solo lectura). | `admin`, `supervisor`, `auditor` |
| `rondas.gestionar` | Administrar rondas. Crear rutas y asignaciones, resolver incidentes, manejar drones y la configuración de rondas. | `admin`, `supervisor` |
| `rondas.patrullar` | Patrullar. Iniciar turnos y rondas, marcar puntos de control y reportar incidentes desde el teléfono. | `policia`, `supervisor` |
| `auditoria.ver` | Entrar al panel de auditoría. Abre auditor.html: usuarios, visitas, vehículos, accesos, mensajes y reportes (cada pestaña pide su privilegio de lectura). | `auditor` |
| `auditoria.exportar` | Exportar reportes. Descargar los reportes del panel de auditoría en CSV. | `auditor` |

Para agregar un privilegio: una entrada en `privilegios.js` (con sus roles por defecto), copiar el archivo a `functions/src/privilegios.js`, una función `pXxx` en `firestore.rules` y usarla en la regla que corresponda, y mostrar u ocultar lo que corresponda en la página. `cd scripts && npm test` avisa si algo no coincide.

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
| `privilegios-ui.js` | Editor de privilegios por tarjetas (admin.html y master.html). |
| `firestore.rules` | Permisos por privilegio (con los del rol por defecto) y por condominio. |
| `functions/src/auth.js` | Login (con destino según privilegios) y verificación de códigos en garita. |
| `functions/src/anpr/` | Webhook de la cámara LPR. |
| `rondin/` | SISDEL RONDÍN sin modificar su diseño; `rondin/js/sisdel-api.js` lo conecta con la base de SISDEL. |
| `rondas-core.js`, `panico-alertas.js` | Botón de pánico del vecino y alertas de pánico en garita y admin. |
| `functions/src/rondas/` | Avisos de pánico por WhatsApp y limpieza diaria de rondas. |
| `functions/src/finanzas/` | Mora automática: cuotas del mes y estado de pago de cada vecino según el Sistema Financiero. |
| `finanzas/` | Sistema Financiero (OIKOS), copia sin modificar de MULTISYS. |
| `finanzas.html`, `finanzas-sync.js` | Abren OIKOS dentro de SISDEL y sincronizan sus datos con Firestore. |
| `scripts/` | Pruebas, datos de prueba y migración. No se publican. |

## Desarrollo local

```bash
firebase emulators:start --only auth,firestore,functions,hosting
```

```bash
cd scripts && npm run seed && npm test
```

`npm test` corre cuatro archivos sin emuladores (privilegios, sincronización financiera, mora y limpieza de rondas) y uno contra los emuladores (`test-emulator.mjs`: login, reglas por rol, privilegios por usuario, cámara, finanzas y rondas). Con los emuladores arriba: `npm run seed` antes de cada corrida (el login se bloquea tras muchos intentos fallidos).

Luego abrir http://127.0.0.1:5050. Los códigos de prueba están en `scripts/dev-seed.json`.

## Deploy

Siempre desde `main`, uno a la vez.

```bash
firebase deploy --only firestore,functions,hosting
```

## Cámara LPR

La cámara envía a `https://garita.app/api/lpr?condominioId=<id del condominio>`.
También se aceptan `/api/anpr`, `/LAPI/*` y `/NotificationInfo/*`.
