# sst_ws — Backend JD&D IA-Core

Backend Node.js (Express 5 + PostgreSQL/Neon) para la plataforma de gestión de
**Órdenes de Servicio (OS)** de JD&D Consultores.

> 📍 **El estado del proyecto y lo que queda por hacer NO viven aquí**, sino en
> `jdd_consultores_app/HANDOFF.md` (repo del frontend), que es la fuente de
> verdad para los dos proyectos. Léelo antes de empezar: trae el estado por
> módulo, las trampas conocidas y la lista de pendientes priorizada.

> ⚠️ **"Fase 1" y la "Regla de Oro" ya no existen** (la demo se aprobó el
> 27-jul-2026). Están construidos **los 12 módulos** del FRS, encuestas,
> pre-cuentas y reportes incluidos; del FRS solo queda fuera ASG-06 (WhatsApp),
> que él mismo deja en Fase 3. Si un texto de este README suena a "esto no se
> puede tocar todavía", está viejo: manda el HANDOFF.

> 🤖 **Motor principal de extracción = OpenAI** (`gpt-4o-mini`, vía
> `infrastructure/openai/openai-extraction.service.ts` + `services/openai-extraction.bridge.js`).
> Extrae los campos de los PDF; el Excel SIPAB es parsing determinista.
>
> **Gemini ya NO participa en la extracción.** Permanece **solo** en componentes
> auxiliares **PENDIENTES DE MIGRACIÓN** (clasificación de ARL, resumen ejecutivo y
> búsqueda en lenguaje natural); si `GEMINI_API_KEY` está vacío, esos componentes
> usan un **mock** realista. Claude/Claude Code es la herramienta de desarrollo, no
> el producto.

## Requisitos

- Node.js ≥ 20 (probado en 22).
- Acceso a la BD Neon (ya configurado en `.env`).

## Puesta en marcha

```bash
npm install
npm run migrate     # crea/actualiza el esquema sst (idempotente, seguro de repetir)
npm start           # levanta la API en http://localhost:4000
# desarrollo con reload:
npm run dev
# prueba end-to-end del flujo completo (requiere server corriendo):
node scripts/smoke.js
```

> 🚨 **NUNCA correr `npm run seed:demo` contra la BD compartida.** Hace
> **TRUNCATE** de órdenes, borradores y lotes: se lleva por delante el trabajo
> real de los dos equipos y los datos con los que el cliente prueba. Solo tiene
> sentido contra una base local y desechable.
>
> Para probar flujos que mandan correo, levantar una instancia aparte en vez de
> tocar la de todos:
> `PORT=4010 EMAIL_DRIVER=console SMTP_HOST="" npm run dev`

Login por **documento de identidad** + contraseña. Existen **dos cuentas admin
separadas** (configurables en `.env`, ver `docs/06-auth-y-seguridad.md`):

- **Administrador Maestro** (exclusivo del equipo de desarrollo): documento
  `9999999999` / `MAESTRO_PASSWORD` (correo `admin@jdd.com`). Único que puede
  crear/gestionar usuarios internos (`es_maestro`).
- **Cuenta del cliente** (operación diaria): documento `1234567890` (correo
  `juanskpc@gmail.com`, cel `3188887013`). Rol `admin` normal, sin gestión de
  usuarios; su contraseña no cambia con las migraciones.

## Arquitectura

```
db/
  schema.sql     DDL completo (esquema sst): enums, tablas Fase 1 + costuras Fase 2,
                 vistas RPT-01/02, funciones de dominio y triggers.
  seed.sql       Catálogo ARLs, plantillas de formatos, app_settings (umbral 70%).
  migrate.js     Aplica schema+seed y siembra admin + profesionales de ejemplo.
  seed-demo.js   Datos de DEMO completos: usuarios (varios roles), 8 profesionales,
                 lotes, 8 borradores pendientes, 26 OS en todos los estados,
                 historial, documentos, soportes, notificaciones y tablas Fase 2.
src/
  config/        env + pool de PostgreSQL (search_path = sst).
  middleware/    auth (JWT + roles), manejo de errores, uploads (multer).
  services/      storage (local/S3), email (console/SMTP),
                 openai-extraction.bridge (MOTOR PRINCIPAL de extracción PDF → OpenAI),
                 extraction (orquestación: Excel SIPAB determinista + PDF→OpenAI),
                 gemini (AUXILIAR, PENDIENTE DE MIGRACIÓN: clasificación/resumen/búsqueda),
                 pdf (formatos), notify.
  infrastructure/openai/  OpenAIExtractionService (gpt-4o-mini + Structured Outputs).
  queue/         cola async de importación (worker en memoria).
  modules/       auth, professionals, catalog, imports+drafts, orders, files,
                 public (portal M6), notifications, reports.
  app.js/server.js
```

> **Toda la estructura de la BD está en español** (tablas, columnas, enums,
> vistas y funciones). Tablas núcleo: `usuarios`, `profesionales`, `arls`,
> `plantillas`, `lotes_importacion`, `ordenes_servicio`, `historial_estados_orden`,
> `borradores_extraccion`, `documentos_generados`, `enlaces_publicos`,
> `archivos_soporte`, `notificaciones`, `configuracion`.

### Reglas de dominio (en BD, no negociables)

- Estados EST-01: `SIN PROGRAMAR → PROGRAMADA → EN VERIFICACIÓN → EJECUTADA / CANCELADA`.
- La función `sst.cambiar_estado_orden()` valida la transición, exige **motivo** en
  `CANCELADA` y en rechazos de verificación, actualiza la OS y escribe la auditoría
  en `historial_estados_orden` de forma atómica.
- Trigger `fn_bloquear_regresion_ejecutada`: bloquea cualquier retroceso desde `EJECUTADA`.
- Dedup IMP-09 **según la ARL**: `UNIQUE(arl_id, codigo_cronograma, secuencia)` para
  Bolívar y `UNIQUE(arl_id, numero_orden)` (parcial) para AXA/Colmena. `numero_orden`
  y `cronograma+secuencia` son excluyentes por ARL. Ver `docs/04-pipeline-ia.md`.

## Endpoints (prefijo `/api`)

| Módulo | Método | Ruta | Rol |
|---|---|---|---|
| Health | GET | `/health` | — |
| **M1 Auth** | POST | `/auth/login` | — |
| | GET | `/auth/me` | auth |
| | POST | `/auth/forgot-password` | — (rate limited, anti-enumeración) |
| | POST | `/auth/reset-password` | — (token un solo uso, SHA-256 en BD) |
| | POST/GET | `/auth/usuarios` | **maestro** |
| | PUT | `/auth/usuarios/:id` | **maestro** |
| | PATCH | `/auth/usuarios/:id/estado` | **maestro** |
| **CFG-01** | GET/POST | `/professionals` | auth / admin |
| | GET/PUT | `/professionals/:id` | auth / admin |
| | PATCH | `/professionals/:id/estado` | admin |
| Catálogos | GET | `/arls`, `/templates`, `/settings` | auth |
| Config | PUT | `/settings/confidence-threshold` | admin |
| **M2 Import** | POST | `/imports` (multipart `file`) | admin |
| | GET | `/imports`, `/imports/:id`, `/imports/:id/status` | auth |
| | POST | `/imports/:id/confirm` (revisado → a Órdenes) | admin |
| | POST | `/imports/:id/discard` (descarta el lote) | admin |
| **M2/M3 Validación** | GET | `/drafts?status=` , `/drafts/:id` | auth |
| | PUT | `/drafts/:id` (correcciones) | admin |
| | POST | `/drafts/:id/validate` (Validar y Guardar) | admin |
| | POST | `/drafts/:id/discard` | admin |
| **M3 Órdenes** | GET | `/orders?status=&arl_id=&professional_id=&q=` | auth |
| | GET | `/orders/:id`, `/orders/:id/history` | auth |
| | POST | `/orders/:id/status` (genérico) | admin |
| | POST | `/orders/:id/cancel` (motivo) | admin |
| **M5 Asignación** | POST | `/orders/:id/assign` (acepta `franjas[]`) | admin |
| | GET | `/orders/:id/franjas` (tramos de la visita) | auth |
| **M4 Formatos** | POST/GET | `/orders/:id/documents` | admin/auth |
| **M7 Verificación** | POST | `/orders/:id/verify` (→ EJECUTADA) | admin |
| | POST | `/orders/:id/reject` (motivo → PROGRAMADA) | admin |
| | GET | `/orders/:id/supports` | auth |
| Archivos | GET | `/files/documents/:id/download` | auth |
| | GET | `/files/supports/:id/view` (inline VER-01) | auth |
| **M6 Portal público** | GET | `/public/support/:token` | **sin login** |
| | POST | `/public/support/:token/files` | **sin login** |
| **M11 Notif.** | GET | `/notifications`, `/notifications/unread-count` | auth |
| | PATCH/POST | `/notifications/:id/read`, `/notifications/read-all` | auth |
| **M10 Reportes** | GET | `/reports/dashboard` (RPT-01/02) | auth |
| | POST | `/reports/summary/:orderId` (IA) | auth |
| | POST | `/reports/search` (lenguaje natural → filtros) | auth |

## Flujo end-to-end (el ciclo de vida de una OS)

1. `POST /imports` con Excel/PDF → responde `202 PROCESANDO`; el worker clasifica
   la ARL (Excel determinista; PDF con Gemini/mock, PENDIENTE DE MIGRACIÓN), extrae
   los campos con **OpenAI** (Excel = parsing determinista), deduplica y crea los
   borradores en **`PENDIENTE_REVISION`** — visibles solo en la vista previa de
   Importar, **no** en la bandeja de Órdenes.
2. El Admin revisa la vista previa y corrige con `PUT /drafts/:id`; luego
   `POST /imports/:id/confirm` pasa el lote a `PENDIENTE_VALIDACION` y recién ahí
   las órdenes aparecen en Órdenes. (`/imports/:id/discard` descarta el lote.)
3. `POST /drafts/:id/validate` → crea la OS en `SIN PROGRAMAR` + primera auditoría.
4. `POST /orders/:id/assign` → `PROGRAMADA`, genera PDFs, **envía correo** al
   profesional con adjuntos y crea el link público. La visita puede ir **partida
   en franjas** (`sst.franjas_visita`: mañana y tarde, o varios días); el cuerpo
   acepta `franjas[]`, las reemplaza en bloque y deriva `fecha_programada` del
   inicio de la primera. Sin plantillas activas para esa ARL el correo sale **sin
   formatos**: la respuesta lo dice en `formatos_generados`.
5. `POST /public/support/:token/files` (sin login) → sube soportes y pasa a
   `EN VERIFICACIÓN`; avisa a los admins.
6. `POST /orders/:id/verify` → `EJECUTADA`. (`/reject` con motivo vuelve a `PROGRAMADA`.)

## Configuración externa

- **OpenAI (motor principal de extracción):** define `OPENAI_API_KEY` (y opcional
  `OPENAI_MODEL`, default `gpt-4o-mini`) para la extracción real de PDF.
- **Gemini (auxiliar, PENDIENTE DE MIGRACIÓN):** define `GEMINI_API_KEY` para activar
  clasificación de ARL, resúmenes y búsqueda NL reales; sin la key usan mock. **No**
  interviene en la extracción.
- **Correo:** `EMAIL_DRIVER=smtp` + credenciales SMTP (por defecto `console`).
- **Recuperación de contraseña:** `RESET_TOKEN_TTL_MINUTES` (60), `RESET_RATE_MAX`
  (3) por `RESET_RATE_WINDOW_MINUTES` (15), `PASSWORD_MIN_LENGTH` (8). Cuentas
  seed: `MAESTRO_*` y `CLIENTE_*`.
- **Storage:** `STORAGE_DRIVER=local` (default, escribe en `./storage`) o `s3`
  (punto de extensión en `services/storage.service.js`).

## Fuera de alcance

Solo **ASG-06 (WhatsApp)**, que el propio FRS coloca en Fase 3 y declara omisible
si la API tiene costo.

> Este apartado decía que M8 Encuestas, M9 Pre-cuentas, RPT-03..07 y CFG-02..05
> estaban "sin endpoints ni lógica". **Ya no**: los cuatro están construidos y en
> uso (`modules/surveys/`, `modules/billing/`, `reports.routes.js` y las rutas de
> configuración). Lo que sigue pendiente de verdad —deuda de pruebas y remates—
> está en `jdd_consultores_app/HANDOFF.md` §3.
