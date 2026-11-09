# CLAUDE.md - SISDEL Comunities (garita.app)

Instrucciones para cualquier sesion de Claude Code en este repo, en cualquier PC.

## Que es
Control de acceso para condominios (garita.app): paneles master, admin, vecino, garita y auditor, con camara LPR.
Multi-empresa: el rol `master` ve todo; `admin`, `policia`, `vecino`, `auditor`, `supervisor` y `operador` solo su condominio.
El `auditor` lo crea el admin: lee todo su condominio (menos los codigos de acceso), no escribe nada y tiene reportes con exportacion CSV.
Privilegios por usuario (idea de MULTISYS): el admin de cada condominio decide que puede ver o usar cada usuario. Ver la seccion "Privilegios por usuario" abajo.
Sistema Financiero (finanzas.html): es OIKOS, traido de MULTISYS. Ver la seccion "Sistema Financiero" abajo.
Rondas (rondin/): es SISDEL RONDIN con su mismo diseno. Ver la seccion "Rondas" abajo.
Estructura de datos y archivos: ver README.md.

## Infraestructura
- Front: Vercel sirve garita.app directo desde la rama `main` de GitHub. Cada push a `main` publica solo.
- Backend: Firebase, proyecto `sisdel-datacenter` (Firestore, Auth, Functions en us-central1, Hosting espejo en sisdel-datacenter.web.app). Plan Blaze con la cuenta de facturacion "Garita.app" y alerta de 5 USD al mes.
- La camara envia a garita.app/api/lpr; Vercel lo reenvia a la Cloud Function `anprWebhook` (ver vercel.json).
- El sistema anterior (Supabase) ya no se usa; sus datos se importaron el 2026-11-05.
- Acceso: GitHub `yonxela` (dueno) y `SisdelNir` (colaborador con push). Firebase: yonxela es Owner; la cuenta del papa de Yonathan es Editor + Cloud Run Admin (publica todo, no cambia permisos ni facturacion). Vercel publica los commits de cualquier colaborador porque el repo es publico.

## Reglas de trabajo
- Comentarios y textos en espanol; variables y funciones en ingles. Sin emojis en codigo ni interfaces: iconos SVG.
- Una tarea = una sesion = un worktree propio. Nunca dos sesiones sobre la misma carpeta.
- Deploy siempre desde `main` y de a uno a la vez: commit -> ff a main -> push (Vercel publica el front) -> `firebase deploy --only ...` desde el checkout de main.
- Trabajan dos personas en PCs distintas: antes de empezar una tarea y antes de cada `firebase deploy`, `git pull --ff-only` en main. Nunca publicar algo que no este en origin/main: un deploy desde un checkout viejo revierte en produccion las reglas o funciones del otro. Avisarse antes de publicar reglas o funciones.
- Antes de publicar cambios en reglas, funciones, privilegios.js o sisdel-core.js: levantar emuladores y correr `cd scripts && npm run seed && npm test` (716 pruebas: 250 sin emuladores (privilegios y paginas, sincronizacion financiera, mora, avisos de panico y limpieza de rondas) y 466 contra los emuladores). Antes de cada corrida contra emuladores, `npm run seed` (el login se bloquea tras muchos intentos fallidos).
- Cuando cambia sisdel-core.js, privilegios.js o privilegios-ui.js, subir la version en los HTML (`sisdel-core.js?v=AAAAMMDD` y `privilegios.js?v=` con la misma version: una prueba lo exige).
- El repo es PUBLICO: nunca subir respaldos, codigos de acceso ni llaves. Los respaldos van fuera del repo.
- Al terminar cambios en una pagina, abrir el link para que el usuario pruebe.

## Privilegios por usuario
- Modelo: cada rol trae privilegios por defecto (campo `roles` de cada clave en `privilegios.js`) y son EXACTAMENTE el acceso que el rol tenia antes de este modulo. `usuarios/{id}.privilegios` guarda solo las diferencias (`{ clave: true|false }`); sin el campo, el usuario conserva el acceso de su rol (por eso no hubo migracion de datos). `usuarios/{id}.cargo` es el puesto (texto libre). El rol `operador` no trae ninguno: es el personal a la medida.
- Catalogo unico: `privilegios.js` (UMD: navegador y Node), 26 claves `modulo.accion` en grupos. `functions/src/privilegios.js` es una COPIA IDENTICA: al cambiar uno, `cp privilegios.js functions/src/privilegios.js` (la prueba falla si difieren). Tambien trae las paginas (`PAGES`, con su privilegio de entrada), `landing()` (a donde manda el login) y plantillas del sistema.
- Las reglas leen el mapa del documento del usuario (no el token): `can(condoId, clave, roles)` y una funcion `pXxx(c)` por clave con los roles por defecto. `scripts/test-privilegios.mjs` lee `firestore.rules` y verifica claves y roles contra el catalogo. Las reglas ya no preguntan por el rol para dar acceso (no volver a usar `isAdmin`, `isStaff`...: usar `pXxx`). `usuarios.panel`, `auditoria.ver` y `auditoria.exportar` solo deciden que pagina se abre o que boton se muestra (no tienen regla).
- Anti-escalada (no aflojar sin pensarlo; cada punto tiene prueba en `test-emulator.mjs`): quien crea una cuenta conoce su codigo y entra con ella, asi que `usuarios.crear` solo registra vecinos (guardias: `guardias.crear`; auditor, supervisor, admin y operador exigen ademas `usuarios.privilegios`). Nadie cambia sus propios `privilegios` ni `role` (solo el master); cambiar `privilegios` o `role`, y crear, editar o eliminar `admin` u `operador`, exige `usuarios.privilegios`; solo un `admin` u `operador` puede tener `usuarios.privilegios` (`onlyRoles` en el catalogo, `validUser` en las reglas), por eso `manageable()` puede decidir por el rol. Un codigo nuevo solo apunta a un usuario que se crea en la misma escritura (salvo `usuarios.codigos`, con el rol real del usuario y, sobre admin/operador, solo con `usuarios.privilegios`); quien ve codigos (`usuarios.codigos`) no ve ni borra los de admin/operador sin `usuarios.privilegios` (el cliente filtra `role in [vecino, policia, auditor, supervisor]`); `usuarios.eliminar` solo borra visitas, vehiculos y expedientes de un usuario que deja de existir en la misma escritura (`ownerGone`); nadie se elimina a si mismo. `usuarios.privilegios` equivale a control total del condominio: solo a administradores de confianza. Ver codigos o crear cuentas de guardia permite entrar como esa persona: tambien es sensible.
- Datos escritos por usuarios de menor confianza (nombres, telefonos, mensajes) se escapan siempre al pintarlos (`esc`), y los ids de la base no van dentro de `onclick`.
- Paginas: `SISDEL.can('clave')` muestra u oculta botones; `SISDEL.requireAuth([], 'pagina.html')` vuelve a leer la ficha del usuario (privilegios, rol y estado vigentes) y lo manda a la pagina que le toque. El login (`functions/src/auth.js`) devuelve `session.privilegios` y el destino; un usuario sin ninguna pagina no entra. Lo que se oculta en pantalla tambien lo bloquean las reglas: no confiar solo en la pagina.
- RONDIN no se modifica (`rondin/js/app.js`, `css/style.css`, `i18n.js` y `finanzas/` siguen sin tocar): `rondin/js/sisdel-api.js` decide la pantalla por privilegios (`rondas.gestionar` = administra, `rondas.patrullar` = guardia, `rondas.ver` = solo lectura) y manda a su pagina de inicio a quien no tiene acceso.
- UI: `admin.html` (crear usuario con rol, cargo y plantilla; boton de escudo en cada usuario; activar o desactivar) y `master.html` abren `privilegios-ui.js` (editor por tarjetas, plantillas del sistema y propias del condominio en `plantillas_privilegios`). Para agregar un privilegio: entrada en `privilegios.js` + copia en functions + funcion `pXxx` y su uso en las reglas + ocultar o mostrar en la pagina + prueba en `test-emulator.mjs` (seccion "Privilegios por usuario").
- Orden de publicacion: reglas y functions primero (son compatibles con el front viejo: los usuarios de siempre no notan nada), el front (push a main) despues. Con el front antes que las reglas, el modal de usuario nuevo avisa de falta de permisos al leer las plantillas. Para crear `operador` y usar privilegios hacen falta las tres cosas.

## Sistema Financiero (OIKOS)
- `finanzas/` es una copia SIN MODIFICAR de `apps/web/public/admin-finance/` de MULTISYS (index.html + vendor/). No se edita aqui: si cambia en MULTISYS, se vuelve a copiar entero. Es la excepcion a la regla de emojis e iconos SVG.
- `finanzas.html` lo abre en un iframe con `?msid=<condoId>&msname=&msdirector=`; el bloque de entrada de OIKOS salta su login propio.
- `finanzas.html` entra con el privilegio `finanzas.usar` (lectura: `finanzas.ver`). Para registrar residentes nuevos o cambiar sus datos desde OIKOS tambien hacen falta `usuarios.crear` y `usuarios.editar`.
- `finanzas-sync.js` conecta el localStorage de OIKOS con Firestore. Una sola base de vecinos: los residentes de OIKOS son los vecinos de SISDEL (nombre, casa y telefono en `usuarios`); DPI, lote, notas y finiquito en `finanzas_residentes/{mismo id}`, que solo leen admin, auditor y master. Movimientos en `finanzas_movimientos`, configuracion en `finanzas_config/oikos_settings`.
- Nada se borra (OIKOS anula con `deleted: true`). Cada vecino se cobra desde el mes en que entra al sistema (`feeFrom`), y un condominio nuevo arranca en quetzales y cobro manual.
- Los residentes se ingresan en OIKOS: cada residente nuevo se crea como vecino de SISDEL con su codigo. Las placas se siguen registrando en el panel admin.
- Mora automatica (`functions/src/finanzas/`): se activa sola con el primer cargo del condominio (`condominios/{id}.moraAutomatica`). Desde ahi `paymentStatus` y `morosoSince` los escribe solo el servidor (las reglas no dejan al admin cambiarlos) y el panel admin muestra "Calculado por el Sistema Financiero".
  - Moroso para la garita = debe MAS de una cuota vencida (OIKOS muestra mora desde la primera). La cuota del mes vence pasado el dia de cobro + dias de gracia de OIKOS; la camara aplica despues la gracia del condominio (reminderEnabled/gracePeriodDays).
  - Se recalcula al registrar o anular un cargo o pago (`onFinanceMovement`), al cambiar cuota/dia/gracia/modo (`onFinanceSettings`) y cada dia a las 05:00 de Guatemala (`dailyFinance`, que tambien crea las cuotas del mes en modo automatico, con el mismo id que OIKOS: fee_<vecino>_<AAAA-MM>).
  - `mora.js` replica funciones de OIKOS; si se vuelve a copiar OIKOS desde MULTISYS, revisar que sigan iguales.

## Rondas: SISDEL RONDIN (rondin/)
- Es el programa RONDIN con su mismo diseno y opciones: `rondin/index.html`, `rondin/css/style.css`, `rondin/js/app.js` e `i18n.js` son copias SIN MODIFICAR de `RONDIN/public` (como OIKOS: si cambia RONDIN, se vuelven a copiar y se revisa que sus llamadas `/api/...` sigan existiendo en el adaptador). Es la excepcion a la regla de emojis e iconos SVG. Las pipas quedaron fuera; Rondin Air (drones) esta incluido.
- `rondin/js/sisdel-api.js` reemplaza al servidor de RONDIN (Express + SQLite en Render): define `API`, un `io()` sobre Firestore (tiempo real) y atiende los `fetch('/api/...')`. Responde las mismas rutas con los datos de SISDEL.
- Una sola base: empresa = condominio; guardias = `policia`, supervisores = `supervisor`, director general = `admin` (el `auditor` ve lo mismo en solo lectura; con privilegios a la medida, un `operador` puede ser cualquiera de ellos: ver "Privilegios por usuario"); el PIN de RONDIN es el codigo de acceso de SISDEL. Vecinos = los de SISDEL: DPI en `finanzas_residentes.dpi` (el del Sistema Financiero), familiares en `emergencia/{userId}`. Un vecino creado en RONDIN entra al Sistema Financiero desde ese mes (`feeFrom`).
- Datos propios con el formato de RONDIN (`company_id`, `guard_id`, fechas `AAAA-MM-DD HH:MM:SS` en UTC): `rondas_rutas` (con sus puntos), `rondas_asignaciones`, `rondas_turnos`, `rondas_rondas`, `rondas_visitas`, `rondas_ubicaciones`, `rondas_en_vivo`, `rondas_incidentes`, `rondas_alertas` (panel de alertas), `rondas_fotos`, `rondas_personal` (expediente del guardia), `rondas_config/general`, `rondas_drones`.
- El supervisor registra guardias (solo `policia`) y ve sus codigos; no ve los de los demas. `rondas.html` y `rondin.html` solo redirigen a `rondin/`.
- Boton de panico: guardias (RONDIN) y vecinos (RONDIN o vecino.html) crean `alertas_panico`. En vecino.html el boton aparece solo si RONDIN > Configuracion > "Vecinos usaran boton de panico" esta activo. `panico-alertas.js` (con `rondas-core.js`, que quedo solo para panico y contactos) los muestra en garita y admin; RONDIN tiene su propia alarma. `onPanicCreated` avisa por WhatsApp a la central, al admin y supervisores y a los familiares del vecino (hasta 5).
- WhatsApp: UltraMsg (principal) y Meta (respaldo), claves en `_privado/whatsapp`. Las carga una persona con `cd scripts && GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node set-whatsapp.mjs --target=prod` (sin claves, la alerta queda registrada como "WhatsApp sin configurar"). Con `--probar` verifica las claves con el proveedor sin enviar mensajes; con `--ver` muestra que esta configurado. En el emulador el proveedor es "simulado".
- `dailyRondas` (03:00 de Guatemala) cierra turnos de mas de 16 h y rondas de mas de 6 h (con su puntaje: % de puntos obligatorios, completa desde 80 %, igual que RONDIN) y borra posiciones de mas de 30 dias y alertas del panel de mas de 90.

## Requisitos en una PC nueva
- `node` 22 o mas, `firebase-tools`, `gcloud`, `gh` y Java 21 o mas (lo piden los emuladores).
- En Mac con Homebrew: `brew install node gh firebase-cli openjdk@21` y `brew install --cask gcloud-cli`. `openjdk@21` no queda en el PATH: agregar `$(brew --prefix openjdk@21)/bin` en `~/.zprofile`.
- En este repo, `git config user.email` con el correo noreply de GitHub (el repo es publico y el correo de cada commit queda visible).
- Entrar con una cuenta de Google con acceso al proyecto: `firebase login` y `gcloud auth login`. Para los scripts de `scripts/` tambien `gcloud auth application-default login`.
- `npm ci` dentro de `functions/` y dentro de `scripts/`.
- Si node se cuelga al importar firebase-admin, o el emulador dice "Timeout after 10000" al cargar functions: `rm -rf node_modules && npm ci` en esa carpeta.
- Puertos de emuladores: auth 9099, functions 5001, firestore 8080, hosting 5050, UI 4000.

## Herramientas y diagnostico
- `scripts/set-master-code.mjs --target=prod --generate` (con `GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter`): genera un codigo master nuevo, guarda solo su hash en `_privado/auth`, cierra las sesiones master abiertas y muestra el codigo una sola vez. Lo corre una persona en su terminal: el modo automatico de Claude no deja escribir credenciales en produccion.
- `scripts/migrate-supabase.mjs`: importacion del sistema anterior (ya hecha).
- Coleccion `_diag`: cada pagina guarda cuanto tardo en cargar (login, sesion, datos, red, navegador). Solo el master la lee; se consulta con el admin SDK desde `scripts/` para diagnosticar lentitud.
- Bitacora de logins en Cloud Logging: servicio `login`, campo `jsonPayload.outcome` (ok, not_found, blocked, condo_inactive, user_inactive).
