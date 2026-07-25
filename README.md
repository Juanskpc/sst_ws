# sst_ws — Backend JD&D IA-Core (Fase 1)

Backend Node.js (Express 5 + PostgreSQL/Neon) para la plataforma de gestión de
**Órdenes de Servicio (OS)** de JD&D Consultores. Implementa el ciclo de vida
completo de **Fase 1** (MVP Táctico). La BD incluye además las tablas de costura
de Fase 2, pero **sin lógica de backend** (Regla de Oro).

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
npm run migrate     # crea el esquema sst: tablas, vistas, funciones, seeds + admin
npm run seed:demo   # (opcional) carga datos de DEMO ricos en TODAS las categorías
npm start           # levanta la API en http://localhost:4000
# desarrollo con reload:
npm run dev
# prueba end-to-end del flujo completo (requiere server corriendo):
node scripts/smoke.js
```

Login por **documento de identidad** + contraseña. Admin inicial (configurable en
`.env`): documento `1234567890` / `Admin123*` (correo `admin@jdd.com` para recuperación).

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
- `UNIQUE(arl_id, codigo_cronograma, secuencia)`: dedup IMP-09.

## Endpoints (prefijo `/api`)

| Módulo | Método | Ruta | Rol |
|---|---|---|---|
| Health | GET | `/health` | — |
| **M1 Auth** | POST | `/auth/login` | — |
| | GET | `/auth/me` | auth |
| | POST | `/auth/forgot-password` | — |
| | POST | `/auth/reset-password` | — |
| | POST | `/auth/usuarios` | admin |
| **CFG-01** | GET/POST | `/professionals` | auth / admin |
| | GET/PUT | `/professionals/:id` | auth / admin |
| | PATCH | `/professionals/:id/estado` | admin |
| Catálogos | GET | `/arls`, `/templates`, `/settings` | auth |
| Config | PUT | `/settings/confidence-threshold` | admin |
| **M2 Import** | POST | `/imports` (multipart `file`) | admin |
| | GET | `/imports`, `/imports/:id`, `/imports/:id/status` | auth |
| **M2/M3 Validación** | GET | `/drafts?status=` , `/drafts/:id` | auth |
| | PUT | `/drafts/:id` (correcciones) | admin |
| | POST | `/drafts/:id/validate` (Validar y Guardar) | admin |
| | POST | `/drafts/:id/discard` | admin |
| **M3 Órdenes** | GET | `/orders?status=&arl_id=&professional_id=&q=` | auth |
| | GET | `/orders/:id`, `/orders/:id/history` | auth |
| | POST | `/orders/:id/status` (genérico) | admin |
| | POST | `/orders/:id/cancel` (motivo) | admin |
| **M5 Asignación** | POST | `/orders/:id/assign` | admin |
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

## Flujo end-to-end (criterios de aceptación Fase 1)

1. `POST /imports` con Excel/PDF → responde `202 PROCESANDO`; el worker clasifica
   la ARL (Excel determinista; PDF con Gemini/mock, PENDIENTE DE MIGRACIÓN), extrae
   los campos con **OpenAI** (Excel = parsing determinista), deduplica y crea borradores.
2. `POST /drafts/:id/validate` → crea la OS en `SIN PROGRAMAR` + primera auditoría.
3. `POST /orders/:id/assign` → `PROGRAMADA`, genera PDFs, **envía correo** al
   profesional con adjuntos y crea el link público.
4. `POST /public/support/:token/files` (sin login) → sube soportes y pasa a
   `EN VERIFICACIÓN`; avisa a los admins.
5. `POST /orders/:id/verify` → `EJECUTADA`. (`/reject` con motivo vuelve a `PROGRAMADA`.)

## Configuración externa

- **OpenAI (motor principal de extracción):** define `OPENAI_API_KEY` (y opcional
  `OPENAI_MODEL`, default `gpt-4o-mini`) para la extracción real de PDF.
- **Gemini (auxiliar, PENDIENTE DE MIGRACIÓN):** define `GEMINI_API_KEY` para activar
  clasificación de ARL, resúmenes y búsqueda NL reales; sin la key usan mock. **No**
  interviene en la extracción.
- **Correo:** `EMAIL_DRIVER=smtp` + credenciales SMTP (por defecto `console`).
- **Storage:** `STORAGE_DRIVER=local` (default, escribe en `./storage`) o `s3`
  (punto de extensión en `services/storage.service.js`).

## Fuera de alcance (Fase 2 — NO implementado)

M8 Encuestas, M9 Pre-cuentas, RPT-03..07, CFG-02..05. Sus tablas existen en el
esquema como costura, pero **no hay endpoints ni lógica**.
