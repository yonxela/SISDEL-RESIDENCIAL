# SISDEL Comunities (garita.app)

Control de acceso para condominios: panel master, administrador, vecino y garita con cámara LPR.

## Roles

| Rol | Página | Alcance |
| --- | --- | --- |
| `master` | `master.html` | Todos los condominios. |
| `admin` | `admin.html` | Su condominio: usuarios, códigos, vehículos, visitas y mensajes. |
| `policia` | `garita.html` | Verifica códigos y QR, registra ingresos. |
| `vecino` | `vecino.html` | Sus visitas, vehículos y mensajes. |
| `admin` (finanzas) | `finanzas.html` | Sistema Financiero del condominio (OIKOS): cuotas, ingresos, egresos, estados de cuenta y reportes. |
| `auditor` | `auditor.html` | Lee todo su condominio menos los códigos de acceso; no puede escribir. Reportes por rango de fechas con exportación CSV e impresión. |

## Stack

- **Frontend:** HTML + Vanilla JS, sin build. SDK de Firebase por CDN.
- **Base de datos:** Firestore, proyecto `sisdel-datacenter`.
- **Backend:** Cloud Functions (Node 22) en `functions/`.
- **Login:** código de acceso validado en el servidor, que entrega un token de Firebase Auth.

## Estructura de datos

```
condominios/{condoId}
    usuarios/{userId}
    visitas/{visitId}
    vehiculos/{vehicleId}
    mensajes/{msgId}
    camera_logs/{logId}
    finanzas_residentes/{userId}    datos financieros del vecino (DPI, lote, notas, finiquito)
    finanzas_movimientos/{id}       cargos, pagos y egresos del Sistema Financiero
    finanzas_config/oikos_settings  cuota, dia de cobro, moneda
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
| `firestore.rules` | Permisos por rol y por condominio. |
| `functions/src/auth.js` | Login y verificación de códigos en garita. |
| `functions/src/anpr/` | Webhook de la cámara LPR. |
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

Luego abrir http://127.0.0.1:5050. Los códigos de prueba están en `scripts/dev-seed.json`.

## Deploy

Siempre desde `main`, uno a la vez.

```bash
firebase deploy --only firestore,functions,hosting
```

## Cámara LPR

La cámara envía a `https://garita.app/api/lpr?condominioId=<id del condominio>`.
También se aceptan `/api/anpr`, `/LAPI/*` y `/NotificationInfo/*`.
