# Implementation Plan

> Alcance: **solo backend** (API, Lambdas, datos, IA, agendado, infra CDK). El frontend lo construye otro equipo y queda fuera de esta sesión. Cada tarea produce código que compila/pasa tests; las tareas se ejecutan en orden y construyen de forma incremental sobre las anteriores.

- [x] 1. Inicializar el proyecto y las bases del monorepo backend
  - Crear estructura `src/` (`domain/`, `lib/`, `repositories/`, `services/`, `providers/`, `handlers/`) e `infra/` (CDK app).
  - Configurar TypeScript (strict), ESLint/Prettier, Vitest/Jest, esbuild para bundling de Lambdas.
  - Añadir scripts npm: `build`, `test`, `lint`, `cdk:synth`.
  - _Requirements: 12.4_

- [x] 2. Definir el modelo de dominio y utilidades compartidas
  - [x] 2.1 Implementar enums y tipos de dominio (`DocumentStatus`, `ReviewRecordStatus`, `Permission`, `Verdict`, `ApprovalPolicy`) y las entidades (`Module`, `Reviewer`, `Assignment`, `Document`, `ReviewRecord`, `Annotation`, `SectionVerdict`).
    - Tests de invariantes básicas de las entidades.
    - _Requirements: 3.1, 7.6, 8.2, 9.1_
  - [x] 2.2 Implementar `lib/errors` (jerarquía de errores de dominio) y mapa a códigos (`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UPSTREAM_ERROR`).
    - _Requirements: 11.2_
  - [x] 2.3 Implementar `lib/config` (carga de config desde env/SSM: `AI_PROVIDER`, `AI_CONFIDENCE_THRESHOLD`, ventana de agendado, `WORDS_PER_MIN`, política de aprobación por defecto, `REVIEW_TIMEOUT_DAYS` default 7, `MAX_UPLOAD_SIZE_MB` default 5) y `lib/logger` (JSON estructurado).
    - _Requirements: 4.2, 5.5, 6.4, 9.2, 9.9, 12.6_
  - [x] 2.4 Implementar validación de entrada con `zod` y helper de validación reutilizable para handlers.
    - _Requirements: 3.2, 4.2, 11.4_
  - [x] 2.5 Definir la interfaz `EventPublisher` y el tipo `SystemEvent` (type, resourceId, timestamp, actor?, detail?); implementar `EventBridgePublisher` (fire-and-forget: fallo → log, no bloquea) y un `FakeEventPublisher` determinista para tests.
    - Tests: publicación con forma correcta de evento; fallo de EventBridge no propaga excepción (se registra en logs).
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [x] 3. Capa de acceso a datos (DynamoDB single-table + S3)
  - [x] 3.1 Implementar `repositories/dynamo` con el patrón single-table (claves `PK`/`SK`, `GSI1` byModule, `GSI2` byReviewer) y helpers de mapeo entidad↔item.
    - Tests contra DynamoDB Local cubriendo put/get/query por entidad y GSIs.
    - _Requirements: 7.3, 12.2_
  - [x] 3.2 Implementar repositorios por entidad (ModuleRepo, ReviewerRepo, AssignmentRepo, DocumentRepo, ReviewRecordRepo, AnnotationRepo, AuditRepo) con escrituras condicionales para idempotencia/unicidad.
    - Tests: unicidad de nombre de módulo, existencia de asignaciones, consultas por módulo/revisor.
    - _Requirements: 1.5, 3.3, 6.1, 7.3_
  - [x] 3.3 Implementar `repositories/s3` (generar presigned PUT URL, leer contenido, construir `s3Key`).
    - Tests con S3 mock del SDK.
    - _Requirements: 4.1, 4.3_

- [x] 4. Autenticación y autorización (guards)
  - [x] 4.1 Implementar parsing/validación del JWT de Cognito y extracción de rol (`admin`/`revisor`) y `userId` desde el contexto del authorizer.
    - _Requirements: 10.1, 10.2, 10.3_
  - [x] 4.2 Implementar guards: `requireAuth`, `requireRole`, `requireModuleAccess(documentId, level)`, `requireRecordOwner(recordId)`.
    - Tests unitarios de cada guard (401/403, permiso read vs edit, propiedad del registro).
    - _Requirements: 3.6, 7.4, 8.4, 10.4, 10.5_
  - [x] 4.3 Implementar `AuditService`/helper para registrar operaciones sensibles vía AuditRepo.
    - _Requirements: 10.6_

- [x] 5. Gestión de módulos (ModuleService + handlers)
  - [x] 5.1 Implementar `ModuleService` (create con unicidad, list, update, delete con verificación de dependencias).
    - Tests: unicidad (409), delete con dependencias (409).
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_
  - [x] 5.2 Implementar handlers HTTP de `/v1/modules` con guard `requireRole('admin')` y validación zod.
    - _Requirements: 1.1, 1.2, 11.1, 11.2_

- [x] 6. Gestión de revisores y asignaciones
  - [x] 6.1 Implementar `ReviewerService` integrando Cognito Admin API (crear usuario con grupo `revisor`, listar, desactivar) + persistencia en tabla.
    - Tests con Cognito mock: alta, email duplicado (409), desactivación conserva histórico.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 6.2 Implementar `AssignmentService` (assign con validación de permiso read/edit y existencia de módulo/revisor, updatePermission, remove, listForReviewer).
    - Tests: permiso inválido (400), entidades inexistentes (400), listado con niveles.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_
  - [x] 6.3 Implementar handlers de `/v1/reviewers` y `/v1/reviewers/{id}/assignments` con guards admin y auditoría.
    - _Requirements: 2.5, 3.1, 10.6, 11.1_

- [x] 7. Carga de documentos (DocumentService + handlers + S3)
  - [x] 7.1 Implementar `DocumentService.initUpload` (crea metadata `pending_content`, política de aprobación por defecto, presigned URL) y `confirmUpload` (idempotente; publica evento `document.uploaded` vía `EventPublisher`).
    - Tests: validación de extensión `.md` y tamaño máximo configurable (default 5 MB) → 400, estados y respuesta `{documentId, uploadUrl}`, publicación de `document.uploaded` al confirmar.
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 9.2, 13.1_
  - [x] 7.2 Implementar `get`, `list`, `reassignModule` (sobrescribe clasificación → `source: manual`) y `setApprovalPolicy`.
    - Tests: reasignación manual marca source manual; cambio de política.
    - _Requirements: 4.3, 5.6, 9.1_
  - [x] 7.3 Implementar handlers de `/v1/documents*` (incluye `confirm-upload`, `module`, `approval-policy`) con guards y validación. Soportar carga de varios documentos con resultado por archivo.
    - _Requirements: 4.4, 5.6, 9.1, 11.1, 11.2_

- [x] 8. Adapter de IA y clasificación
  - [x] 8.1 Definir la interfaz `AiProvider` e implementar `FakeAiProvider` determinista para tests.
    - _Requirements: 5.5_
  - [x] 8.2 Implementar `BedrockAiProvider` (por defecto) y los adapters `OpenAiProvider` y `OpenRouterAiProvider`, seleccionables por config; claves desde Secrets Manager.
    - Tests con dobles de SDK/HTTP para cada adapter.
    - _Requirements: 5.4, 5.5, 12.6_
  - [x] 8.3 Implementar `ClassificationService.classify(documentId)` (lee contenido + módulos, llama provider, aplica umbral de confianza, actualiza estado y módulo, reintentos y `classification_failed`; publica evento `document.classified` o `document.needs_manual_classification`).
    - Tests: éxito → `classified`; baja confianza → `needs_manual_classification`; fallo → `classification_failed`; publicación del evento correcto.
    - _Requirements: 5.1, 5.2, 5.3, 5.7, 13.1_

- [x] 9. Worker de clasificación (evento S3 + SQS)
  - [x] 9.1 Implementar el handler del Classification Worker: trigger por `ObjectCreated` de S3 y por mensajes SQS de reintento; invoca `ClassificationService`; al terminar encola mensaje de scheduling.
    - Tests del handler con eventos simulados y `FakeAiProvider`.
    - _Requirements: 4.5, 5.1, 5.2, 5.7, 6.1_

- [x] 10. Adapter de calendario y agendado
  - [x] 10.1 Definir `CalendarProvider` e implementar `FakeCalendarProvider` determinista para tests.
    - _Requirements: 6.2, 6.3_
  - [x] 10.2 Implementar `GoogleCalendarProvider` (OAuth 2.0 por revisor con refresh token en Secrets Manager, `freeBusy`, creación de evento) y los endpoints de vinculación `GET /v1/integrations/google/authorize-url`, `GET /v1/integrations/google/callback` y desvinculación `DELETE /v1/integrations/google` (elimina el refresh token almacenado).
    - Tests con dobles HTTP: vinculación/callback almacena token, desvinculación elimina token, autorizado, no autorizado (`calendar_not_authorized`), fallo de API.
    - _Requirements: 6.2, 6.3, 6.5, 6.6, 6.8_
  - [x] 10.3 Implementar `SchedulingService.scheduleFor(documentId)`: resuelve revisores del módulo, crea un `ReviewRecord` `pending` por revisor, calcula duración estimada, elige hueco sin solape, agenda y persiste resultado del agendado; publica evento `review.scheduled` por registro.
    - Tests: 1 record por revisor; cálculo de duración; selección de hueco sin solape; marcado "no agendado" cuando no hay autorización/fallo; publicación de `review.scheduled`.
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.6, 13.1_

- [x] 11. Worker de agendado (SQS)
  - [x] 11.1 Implementar el handler del Scheduling Worker (consume cola de scheduling, invoca `SchedulingService`, DLQ en fallo) con idempotencia por documento.
    - Tests del handler con `FakeCalendarProvider`.
    - _Requirements: 6.6, 7.1_

- [x] 12. Registros de revisión: anotaciones y veredictos
  - [x] 12.1 Implementar `ReviewRecordService`: `listMine`, `get`, `addAnnotation`, `setSectionVerdict`, `setDocumentVerdict`, con guards de permiso edit/read y propiedad del registro.
    - Tests: read-only no puede escribir (403); acceso cruzado prohibido (403); persistencia de anotaciones y veredictos.
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 12.2 Implementar `submit` (exige veredicto de documento, pasa a `completed`, bloquea cambios posteriores; publica evento `review_record.completed`) y `reopen` (solo admin).
    - Tests: submit sin veredicto de documento (400); bloqueo tras completed; reopen admin; publicación de `review_record.completed`.
    - _Requirements: 8.6, 8.7, 8.8, 13.1_
  - [x] 12.3 Implementar handlers de `/v1/reviews/mine` y `/v1/review-records/*` con guards y validación.
    - _Requirements: 7.3, 7.4, 8.1, 11.1, 11.2_

- [x] 13. Política de aprobación
  - [x] 13.1 Implementar `ApprovalService.evaluate(documentId)` (se dispara tras cada submit; sólo evalúa cuando todos los records están `completed`; aplica `all`/`any`; persiste estado, fecha y política; auditoría; publica evento `document.approved` o `document.rejected`).
    - Tests exhaustivos de las 4 combinaciones (all→approved/rejected, any→approved/rejected), el caso "aún faltan records" y la publicación del evento de aprobación/rechazo.
    - _Requirements: 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 13.1_
  - [x] 13.2 Integrar la evaluación de aprobación en el flujo de `submit` del `ReviewRecordService`.
    - _Requirements: 9.3, 9.8_
  - [x] 13.3 Implementar `ApprovalService.forceEvaluate(documentId, excludedRecordIds, reason)` (admin fuerza la evaluación excluyendo records `pending`; persiste qué records se excluyeron y la razón; auditoría) y el handler `POST /v1/documents/{id}/force-approval` con guard `requireRole('admin')`.
    - Tests: evaluación con records excluidos, registro de exclusiones y razón, guard admin (403).
    - _Requirements: 9.9_

- [x] 14. Timeout de revisiones pendientes (Review Timeout Checker)
  - [x] 14.1 Implementar `ReviewTimeoutService.checkExpiredReviews()` (detecta `ReviewRecord` en `pending` cuya antigüedad excede `REVIEW_TIMEOUT_DAYS`; publica evento `review.deadline_expired` por cada uno con `documentId`/`reviewerId`/días vencido; no cambia estado automáticamente).
    - Tests: detección de records vencidos vs dentro de plazo; publicación de `review.deadline_expired`; no muta estado.
    - _Requirements: 9.9, 13.1_
  - [x] 14.2 Implementar el handler del Review Timeout Checker (trigger por EventBridge scheduled rule, idempotente) que invoca `ReviewTimeoutService`.
    - Tests del handler con `FakeEventPublisher` y datos simulados.
    - _Requirements: 9.9, 13.1_

- [x] 15. Infraestructura CDK (TypeScript)
  - [x] 15.1 Implementar `DataStack`: tabla DynamoDB `AppTable` on-demand con `GSI1`/`GSI2`, bucket S3 (privado, SSE-S3, notificación `ObjectCreated`→SQS), colas SQS (classification, scheduling) + DLQs.
    - _Requirements: 12.1, 12.2, 12.3, 12.5_
  - [x] 15.2 Implementar `AuthStack`: Cognito User Pool + App Client, grupos `admin`/`revisor`.
    - _Requirements: 10.1, 10.2_
  - [x] 15.3 Implementar `ApiStack`: HTTP API con JWT authorizer, Lambdas de API (arm64, esbuild), rutas `/v1/*`, permisos a DynamoDB/S3/Cognito/SSM/Secrets y `events:PutEvents` a EventBridge.
    - _Requirements: 11.1, 11.5, 12.1, 12.5, 13.1_
  - [x] 15.4 Implementar `WorkersStack`: Lambdas de clasificación y agendado, event sources (S3→SQS→Lambda y SQS→Lambda), permisos a Bedrock/Secrets/SSM y `events:PutEvents`, alarma básica de profundidad de DLQ.
    - _Requirements: 5.7, 6.6, 12.1, 12.5, 13.1_
  - [x] 15.5 Implementar `EventsStack`: bus EventBridge (default), regla scheduled (diaria) hacia la Lambda del Review Timeout Checker con permisos `events:PutEvents`; sin targets de consumidores predefinidos (los conectan los equipos de integración).
    - _Requirements: 9.9, 13.1, 13.3_

- [x] 16. Contrato de API (OpenAPI) y verificación de extremo a extremo
  - [x] 16.1 Escribir el documento OpenAPI 3 de todos los endpoints `/v1` (incluye `DELETE /v1/integrations/google` y `POST /v1/documents/{id}/force-approval`) con requests, responses y modelo de error como contrato para el equipo de frontend; añadir test que valide respuestas contra el esquema.
    - _Requirements: 6.8, 9.9, 11.2, 11.3, 11.4, 11.5_
  - [x] 16.2 Añadir prueba E2E ligera (con `FakeAiProvider`, `FakeCalendarProvider` y `FakeEventPublisher`): carga → clasificación → scheduling → revisión paralela → submit → evaluación de política de aprobación, verificando los eventos emitidos en cada paso.
    - _Requirements: 4.5, 5.2, 6.1, 7.1, 7.5, 8.6, 9.3, 13.1_
