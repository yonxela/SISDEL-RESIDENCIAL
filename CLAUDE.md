# CLAUDE.md - SISDEL Comunities (garita.app)

Instrucciones para cualquier sesion de Claude Code en este repo, en cualquier PC.

## Que es
Control de acceso para condominios (garita.app): paneles master, admin, vecino, garita y auditor, con camara LPR.
Multi-empresa: el rol `master` ve todo; `admin`, `policia`, `vecino`, `auditor` y `supervisor` solo su condominio.
El `auditor` lo crea el admin: lee todo su condominio (menos los codigos de acceso), no escribe nada y tiene reportes con exportacion CSV.
Sistema Financiero (finanzas.html): es OIKOS, traido de MULTISYS. Ver la seccion "Sistema Financiero" abajo.
Rondas (rondas.html y rondin.html): traido de SISDEL RONDIN. Ver la seccion "Rondas" abajo.
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
- Antes de publicar cambios en reglas, funciones o sisdel-core.js: levantar emuladores y correr `cd scripts && npm run seed && npm test` (362 pruebas: 121 sin emuladores (sincronizacion financiera, mora, logica de rondas y avisos) y 241 contra los emuladores).
- Cuando cambia sisdel-core.js, subir la version en los HTML (`sisdel-core.js?v=AAAAMMDD`).
- El repo es PUBLICO: nunca subir respaldos, codigos de acceso ni llaves. Los respaldos van fuera del repo.
- Al terminar cambios en una pagina, abrir el link para que el usuario pruebe.

## Sistema Financiero (OIKOS)
- `finanzas/` es una copia SIN MODIFICAR de `apps/web/public/admin-finance/` de MULTISYS (index.html + vendor/). No se edita aqui: si cambia en MULTISYS, se vuelve a copiar entero. Es la excepcion a la regla de emojis e iconos SVG.
- `finanzas.html` lo abre en un iframe con `?msid=<condoId>&msname=&msdirector=`; el bloque de entrada de OIKOS salta su login propio.
- `finanzas-sync.js` conecta el localStorage de OIKOS con Firestore. Una sola base de vecinos: los residentes de OIKOS son los vecinos de SISDEL (nombre, casa y telefono en `usuarios`); DPI, lote, notas y finiquito en `finanzas_residentes/{mismo id}`, que solo leen admin, auditor y master. Movimientos en `finanzas_movimientos`, configuracion en `finanzas_config/oikos_settings`.
- Nada se borra (OIKOS anula con `deleted: true`). Cada vecino se cobra desde el mes en que entra al sistema (`feeFrom`), y un condominio nuevo arranca en quetzales y cobro manual.
- Los residentes se ingresan en OIKOS: cada residente nuevo se crea como vecino de SISDEL con su codigo. Las placas se siguen registrando en el panel admin.
- Mora automatica (`functions/src/finanzas/`): se activa sola con el primer cargo del condominio (`condominios/{id}.moraAutomatica`). Desde ahi `paymentStatus` y `morosoSince` los escribe solo el servidor (las reglas no dejan al admin cambiarlos) y el panel admin muestra "Calculado por el Sistema Financiero".
  - Moroso para la garita = debe MAS de una cuota vencida (OIKOS muestra mora desde la primera). La cuota del mes vence pasado el dia de cobro + dias de gracia de OIKOS; la camara aplica despues la gracia del condominio (reminderEnabled/gracePeriodDays).
  - Se recalcula al registrar o anular un cargo o pago (`onFinanceMovement`), al cambiar cuota/dia/gracia/modo (`onFinanceSettings`) y cada dia a las 05:00 de Guatemala (`dailyFinance`, que tambien crea las cuotas del mes en modo automatico, con el mismo id que OIKOS: fee_<vecino>_<AAAA-MM>).
  - `mora.js` replica funciones de OIKOS; si se vuelve a copiar OIKOS desde MULTISYS, revisar que sigan iguales.

## Rondas (traido de SISDEL RONDIN)
- RONDIN era un servidor aparte (Express + SQLite en Render). Aqui se rehizo sobre la misma base de SISDEL: los guardias son los usuarios `policia`, los vecinos los de siempre. Las pipas y los drones de RONDIN quedaron fuera.
- `supervisor`: rol nuevo que maneja guardias y rutas (entra a rondas.html). El director general usa el admin y la pestaña Reportes. El auditor ve rondas.html en solo lectura.
- Paginas: `rondas.html` (panel: en vivo, rutas en mapa, asignaciones, rondas, incidentes, alertas, reportes) y `rondin.html` (app del guardia en el celular; funciona sin señal y guarda al volver). Mapas con Leaflet + OpenStreetMap (CDN unpkg).
- Logica pura en `rondas-logic.js` (puntaje: % de puntos obligatorios, completa desde 80 %, igual que RONDIN); datos en `rondas-core.js`; colecciones `rondas_*` por condominio (ver README).
- Un punto se marca por GPS (dentro del radio) o con su codigo impreso (pestaña Rutas, "Codigos para imprimir"). Las visitas no se editan ni se borran.
- Boton de panico: vecinos (vecino.html, mantener 2 s) y guardias (rondin.html) crean `alertas_panico`; `panico-alertas.js` las muestra con sonido en garita, rondin, rondas y admin. `onPanicCreated` avisa por WhatsApp a la central, al admin y supervisores y a los contactos de emergencia del vecino (`emergencia/{userId}`, hasta 5).
- WhatsApp: UltraMsg (principal) y Meta (respaldo), claves en `_privado/whatsapp`. Las carga una persona con `cd scripts && GOOGLE_CLOUD_QUOTA_PROJECT=sisdel-datacenter node set-whatsapp.mjs --target=prod` (sin claves, la alerta queda registrada como "WhatsApp sin configurar"). Con `--probar` verifica las claves con el proveedor sin enviar mensajes; con `--ver` muestra que esta configurado. En el emulador el proveedor es "simulado".
- `dailyRondas` (03:00 de Guatemala) cierra turnos de mas de 16 h y rondas de mas de 6 h, y borra posiciones de mas de 30 dias.

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
