# Oli's Docs — Estado del MVP

Resumen de todo lo construido para conectar `oli-docs` (backend) con
`oli-docs-front` (frontend) y dejar un MVP del ciclo de documentación corriendo
en local. Documento vivo para retomar el trabajo.

**Fecha:** 2026-10-07. **Progreso:** ~85% del código escrito · ~35% verificado
en vivo (nada se ha ejecutado; toda la validación fue estática).

---

## 1. El MVP (recordatorio)

Panel multiusuario donde: el **admin** da de alta **revisores** con sus
*skills*, carga documentación `.md`; un **agente** clasifica cada documento y
lo asigna al revisor adecuado; el revisor **valida / corrige / rechaza**; y el
agente **agenda la revisión en el Google Calendar** del revisor. Login con
Google (necesario para el permiso de Calendar).

**Fuera del MVP:** agente de consulta/chat, perfiles de respuesta, resumen
ejecutivo, matriz de capacidades con niveles, entidad Product, triage de Samva.

**Decisiones tomadas:**
- Login = Google como IdP de Cognito + flujo OAuth propio para Calendar (Opción A pragmática).
- Calendar = **per-reviewer** (cada quien conecta su agenda), no org-wide. Zanjado por el código del backend.
- "skills" = **módulos**; "Alan es bueno en pagos" = **Assignment** (Alan ↔ módulo pagos).
- Front: enfoque de **prefetch + store síncrono** (no reescribir pantallas a async).

---

## 2. Qué se construyó

### Backend (`oli-docs`)
- **API Gateway real** (`infra/lib/api-stack.ts`): HTTP API + authorizer JWT + todas las rutas del MVP; callback de Google sin JWT; `FRONT_URL` en env.
- **Login con Google** (`infra/lib/auth-stack.ts`): Google como IdP federado, Hosted UI domain, OAuth code+PKCE en el client, grupos admin/revisor, outputs.
- **Account-linking** (`src/handlers/auth/pre-signup-link.ts` + lambda): vincula la identidad Google con el revisor pre-creado por email.
- **Endpoint de contenido** (`GET /documents/{id}/content`): lee el `.md` de S3 y lo parte en secciones (`document-service.ts` → `getContent`/`splitSections`).
- **GET de asignaciones** (`GET /reviewers/{id}/assignments`): expuesto en el handler.
- **Arreglo #1** (secret JSON): `integration-handler.ts` y `scheduling-worker` parsean `clientSecret` del JSON.
- **Arreglo #2** (redirect): el callback de Calendar responde 302 al front (`?google=linked` / `?google=error`) en vez de JSON. Helper `redirect()` en `response.ts`.

### Frontend (`oli-docs-front`)
- **Cliente HTTP** (`src/lib/api.ts`): tipos del backend, todas las llamadas del MVP, acciones de revisión (approve/reject/addAnnotation), integraciones; JWT desde `localStorage`.
- **Adaptadores** (`src/lib/adapters.ts`): backend→front (estados 8→4, roles, etapas, id de record con `#`). GAPs marcados con `// GAP:`.
- **Store síncrono + bootstrap** (`store.ts`, `bootstrap.ts`, `use-store-ready.ts`): prefetch que hidrata el store; `queries.ts` lee de él.
- **Login real** (`src/lib/auth.ts`, `pages/auth/callback.astro`, `login.astro`): flujo Cognito Hosted UI + Google con PKCE; `.env.example`.
- **Pantallas conectadas:** Mis revisiones (acciones + estado de carga + detalle sembrado), Usuarios (alta real + skills), Carga (subida real de `.md`), Detalle de documento (contenido bajo demanda), Integraciones (Calendar per-reviewer).
- **FileDropzone**: nuevo callback `onFileObjects` para subir archivos reales.

### Entorno local (`oli-docs/local/`)
- `docker-compose.yml` (DynamoDB Local + LocalStack), `setup-infra.mjs`, `http-runner.mjs` (API con auth falseada + CORS), `.env.local`, `seed.mjs` (flujo E2E), y las guías `README.md`, `LOGIN-SETUP.md`, `RUN-E2E.md`.
- Scripts `local:*` en `package.json` + `tsx` como devDependency.

---

## 3. Estado por pieza

| Pieza | Código | Verificado | Nota |
|---|---|---|---|
| Alta de revisores + skills | 100% | 0% | — |
| Carga de `.md` | 100% | 0% | sube a S3 vía presigned |
| Clasificación + agendado | 100% | 0% | workers no auto-disparan en local |
| Mis revisiones (acciones) | 100% | 0% | approve/reject/annotation reales |
| Contenido del documento | 100% | 0% | GET /content |
| Entorno local (Docker+seed) | 100% | 0% | sin ejecutar |
| Login con Google | 90% | 0% | falta config Google/Cognito real |
| Conexión Calendar | 95% | 0% | #1 y #2 ya resueltos |
| Despliegue a AWS | 0% | 0% | intencional (probar local primero) |

---

## 4. Pendientes (en orden)

1. **Correr el E2E en local** (`RUN-E2E.md`) — el verdadero siguiente paso.
   Resolver lo que salte (CORS ya cubierto; vigilar presigned S3 y tsx).
2. **Poller local de colas** — para que los workers se disparen solos en local
   en vez de invocarlos a mano (hoy el seed los encadena).
3. **Configurar login real** (`LOGIN-SETUP.md`) — Google Cloud + Cognito + `.env`.
   Requiere un User Pool de dev (no es desplegar la app entera).
4. **Guard de sesión en el front** — sin JWT, redirigir a `/login`.
5. **`GET /integrations/google/status`** — para que el front sepe si el Calendar
   ya está conectado al cargar (hoy se infiere del retorno `?google=linked`).
6. **Despliegue a AWS** — sólo cuando el flujo pase en local.

---

## 5. Costuras y GAPs conocidos (honestidad)

- **Nada ejecutado en vivo.** Validación 100% estática (sintaxis, balance, mapeo
  de rutas cliente↔backend). El backend preexistente sí tiene tests unitarios.
- **GAPs backend marcados en `adapters.ts`:** sin `Product` (usa `"oli"` fijo),
  sin versionado de documentos (`v1.0`), sin perfil de respuesta, `rejected` vs
  `changes` colapsados.
- **Workers en local:** no hay trigger S3/SQS; se invocan vía seed. Falta el poller (#2).
- **Estado de Calendar:** el front infiere "conectado" del redirect, no de un GET real (#5).
- **El editor de diffs falló toda la sesión;** los cambios se hicieron con
  reemplazos programáticos verificados. No afecta el resultado, pero explica el método.

---

## 6. Mapa de archivos tocados/creados

**Backend:** `infra/lib/{api,auth}-stack.ts`, `infra/bin/app.ts` (deps),
`src/handlers/http/{integration,document,reviewer}-handler.ts`,
`src/handlers/http/response.ts`, `src/handlers/auth/pre-signup-link.ts`,
`src/handlers/lambdas/pre-signup-link/index.ts`,
`src/handlers/lambdas/scheduling-worker/index.ts`,
`src/services/document-service.ts`, `src/lib/config.ts`, `package.json`.

**Frontend:** `src/lib/{api,adapters,store,bootstrap,use-store-ready,auth}.ts`,
`src/lib/queries.ts`, `src/pages/{login,auth/callback}.astro`,
`src/components/molecules/FileDropzone.tsx`,
`src/components/organisms/{revisiones/ReviewsView,usuarios/UsersView,carga/UploadsView,documentos/DocumentDetail,integraciones/IntegrationsView}.tsx`,
`.env.example`.

**Local:** `local/{docker-compose.yml,setup-infra.mjs,http-runner.mjs,seed.mjs,.env.local,README.md,LOGIN-SETUP.md,RUN-E2E.md,MVP-STATUS.md}`.
