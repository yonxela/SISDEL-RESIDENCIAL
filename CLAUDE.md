# CLAUDE.md - SISDEL Comunities (garita.app)

Instrucciones para cualquier sesion de Claude Code en este repo, en cualquier PC.

## Que es
Control de acceso para condominios (garita.app): paneles master, admin, vecino y garita, con camara LPR.
Multi-empresa: el rol `master` ve todo; `admin`, `policia` y `vecino` solo su condominio.
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
- Antes de publicar cambios en reglas, funciones o sisdel-core.js: levantar emuladores y correr `cd scripts && npm run seed && npm test` (107 pruebas).
- Cuando cambia sisdel-core.js, subir la version en los HTML (`sisdel-core.js?v=AAAAMMDD`).
- El repo es PUBLICO: nunca subir respaldos, codigos de acceso ni llaves. Los respaldos van fuera del repo.
- Al terminar cambios en una pagina, abrir el link para que el usuario pruebe.

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

## Pendientes conocidos
- Cambiar el codigo master: tiene 4 caracteres y quedo visible en el historial del repo.
