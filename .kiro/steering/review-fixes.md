# Decisiones de la revisión post-tarea 5

Correcciones aplicadas tras la revisión de código de las tareas 1–5. Respétalas
al continuar con las tareas siguientes para no reintroducir los problemas.

## Persistencia: unicidad con transacciones (no dos PutCommand)

La unicidad de atributos únicos (nombre de módulo, email de revisor) se enforcea
escribiendo el item centinela y el item real en un **único `TransactWriteItems`**,
nunca en dos `PutCommand` separados. Dos escrituras separadas pueden dejar un
centinela huérfano que vuelve el nombre/email permanentemente inutilizable.

- `ModuleRepo.create/updateName/delete` ya usan `TransactWriteCommand`.
- `ReviewerRepo.create` ya usa `TransactWriteCommand`.
- Para mapear el fallo a 409 usa `isTransactionConflict(err)` (exportado desde
  `module-repo.ts`), que cubre tanto `ConditionalCheckFailedException` como
  `TransactionCanceledException`.

Al implementar la tarea 6 (crear/gestionar revisores y asignaciones), sigue este
mismo patrón para cualquier nueva restricción de unicidad.

## DocumentStore: presigned POST (no PUT)

`DocumentStore.createUpload(docId, { maxBytes, expiresInSeconds })` devuelve
`{ key, url, fields }` y usa **presigned POST** con `content-length-range` para
imponer el tamaño máximo (R4.2). Un presigned PUT no puede limitar el tamaño.

Implicación para la tarea 7 y el contrato OpenAPI: el endpoint de carga debe
exponer `url` + `fields`; el cliente sube con un POST `multipart/form-data`
(el archivo va al final), no con un PUT.

## Listados: Scan paginado con nota de costo

`ModuleRepo.list`, `DocumentRepo.list` y `ReviewerRepo.list` usan el helper
`scanAllByType` (`src/repositories/dynamo/scan.ts`), que pagina siguiendo
`LastEvaluatedKey`. Un Scan filtrado cobra por toda la tabla; es aceptable a
escala de evento. Si el dato crece, migra estos listados a un GSI con partición
`TYPE#<Entity>` en lugar de un Scan filtrado.

## Dominio

- `Reviewer.role` es de tipo `UserRole` (enum), no el literal `'revisor'`. El
  mapper lee el valor almacenado con fallback a `UserRole.REVIEWER`.
- Validación de módulos: reutiliza `updateModuleSchema` / `createModuleSchema`
  desde `lib/validation.ts`; no redefinas schemas inline en los handlers.

## Eventos

`EventBridgePublisher.publish` es fire-and-forget pero inspecciona
`FailedEntryCount` y loguea los fallos parciales (un 200 con fallos no es éxito).

## S3

`DocumentStore.readContent` distingue objeto inexistente (`NotFoundError`, 404)
de otros fallos de S3 (`UpstreamError`, 502).

## Dependencias

Se agregó `@aws-sdk/s3-presigned-post` para el presigned POST.

---

# Decisiones de la revisión post-tarea 10

Correcciones aplicadas tras revisar las tareas 6–10 (build + lint + 328 tests en
verde). Respétalas al continuar.

## Worker de clasificación: partial batch failures

`runClassification` devuelve `SQSBatchResponse` (`{ batchItemFailures }`) y aísla
cada item en su propio try/catch. La Lambda (`classification-worker/index.ts`)
devuelve ese resultado. **La infra (tarea 15.4) DEBE habilitar
`ReportBatchItemFailures` en el event source mapping SQS→Lambda**, si no, el
reporte de fallos parciales no surte efecto. Items de origen S3 (sin messageId)
no tienen canal de reintento parcial: su fallo se relanza para que Lambda
reintente la invocación.

## Idempotencia de clasificación

`ClassificationService.classify` salta documentos ya en estado terminal
(`CLASSIFIED` / `NEEDS_MANUAL_CLASSIFICATION`) sin reprocesar ni republicar
eventos. El outcome incluye `classifiedNow: boolean`; el worker **solo encola
scheduling cuando `classifiedNow === true`**, evitando mensajes de scheduling
duplicados en redelivery. `CLASSIFICATION_FAILED` sí se reprocesa (permite
recuperación).

## Alta/baja de revisores (Cognito ↔ Dynamo)

- `ReviewerService.create`: si la escritura en Dynamo falla tras crear el usuario
  en Cognito, se compensa con `cognito.deleteUser(email)` para no dejar usuarios
  huérfanos ni emails irregistrables.
- `CognitoAdmin.createReviewer`: si `AdminAddUserToGroup` falla, se hace rollback
  del usuario creado.
- `CognitoAdmin.disableUser(username)` y `deleteUser(username)` reciben el
  **email** (el pool usa el email como `Username`), NO el `sub`.
  `ReviewerService.deactivate` pasa `reviewer.email`.

## OAuth de Google: callback SIN JWT authorizer (importante para infra)

El flujo cambió para ser CSRF-seguro:
- `GET /v1/integrations/google/authorize-url` (autenticado): genera un `state`
  aleatorio (`randomUUID`), lo persiste ligado al reviewer vía
  `tokenStore.saveState` (TTL 10 min) y lo pasa a Google.
- `GET /v1/integrations/google/callback` (**NO autenticado**): llega por redirect
  del navegador sin JWT. La identidad sale de `tokenStore.consumeState(state)`
  (uso único). Maneja el `error`/`error_description` de Google (deny → 502).
- `DELETE /v1/integrations/google` (autenticado): desvincula.

**Tarea 15.3 (ApiStack): la ruta del callback NO debe ir detrás del JWT
authorizer.** Las otras dos rutas de integración sí. El `OAuthTokenStore` ahora
expone `saveState`/`consumeState` además de los métodos de refresh token.

## Mitigación de inyección de prompt

`prompt.ts` encierra el contenido no confiable entre `<<<DOCUMENT>>>` /
`<<<END_DOCUMENT>>>`, **elimina esos tokens del contenido** antes de insertarlo, y
el system prompt instruye tratar ese bloque como datos, nunca instrucciones. El
guard de `moduleId` inválido se mantiene.

---

# Hallazgos MENORES pendientes (abordar cuando toque cada tarea)

Detectados en la revisión pero NO corregidos aún (no bloquean). Resuélvelos en la
tarea relacionada:

1. **Backoff en reintentos de IA** (`classification-service.ts`): hoy reintenta en
   loop apretado sin backoff y reintenta errores no transitorios (4xx). Añadir
   backoff exponencial y no reintentar errores de validación del proveedor.
2. **Scheduling: horario laboral y timezone** (`slot-finder.ts`,
   `google-calendar-provider.ts`): hoy agenda a cualquier hora UTC dentro de la
   ventana. Si se requiere horario laboral / zona horaria del revisor, acotarlo y
   enviar `timeZone` en el evento. La lógica de solape en sí es correcta.
3. **Dedup de agendado** (tarea 11 / `scheduling-service.ts`): un re-run de
   `scheduleFor` puede crear eventos de calendario duplicados (los ReviewRecord se
   sobrescriben por clave, pero los eventos de Google no). Añadir idempotencia por
   documento al consumir la cola de scheduling.
4. **`confirmUpload` no verifica que el objeto exista en S3** antes de pasar a
   CLASSIFYING (`document-service.ts`): considerar `headObject` o confiar solo en
   el trigger S3 ObjectCreated.
5. **`description` de módulo no llega al prompt** (`classification-service.ts`
   mapea solo `{id,name}`): pasar también `description` para mejor clasificación.
6. **`assignment-service`**: `remove` no verifica existencia (DELETE inexistente
   devuelve 204 silencioso) y `updatePermission` hace read-then-write redundante
   (el repo ya tiene `ConditionExpression`). Unificar y mapear el fallo condicional.
7. **Eventos faltantes**: `reassignModule` y `setApprovalPolicy` no publican
   evento (solo auditoría). Publicar evento si a los consumidores les interesa.
8. **Caché de secrets sin expiración** (`secrets.ts`): una rotación de clave no se
   refleja hasta reciclar el contenedor. Aceptable, tenerlo presente.
9. **Access token de Google sin caché** (`google-calendar-provider.ts`): refresca
   en cada getBusy y cada schedule (2 refresh por revisor por documento). Cachear
   el access token de corta duración si la latencia importa.
