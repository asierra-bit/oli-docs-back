# Guía para cerrar el MVP de Oli's Docs

Fecha: 7 de octubre de 2026. Esta guía propone el trabajo; no acredita que los servicios estén desplegados ni que los cambios descritos ya existan.

## Decisión: ajustar el backend actual

Conviene conservar `oli-docs` y conectar `oli-docs-front` mediante un contrato común. Ya existen entidades, servicios, repositorios, proveedores de IA/Calendar, infraestructura CDK y pruebas del núcleo. Una reescritura volvería a implementar esas piezas y seguiría necesitando resolver identidad, permisos, rutas y persistencia del frontend.

El frontend sirve de referencia para la experiencia. Sus roles, productos, versiones, estados y acciones de demostración deben adaptarse al MVP acordado. No todos representan capacidades reales del backend.

Trabajar por hitos: implementar, desplegar lo necesario, probar con personas reales y cerrar el hito antes del siguiente. Las interfaces propuestas abajo son cambios por construir, salvo cuando se indica que ya existen.

## 0. Fijar el recorrido y preparar el código

Decisiones propuestas para la primera versión:

- Alta por invitación: el admin autoriza un correo; la persona entra con Google. No hay registro público.
- Dos roles: `admin` y `revisor`. El rol controla permisos; las skills controlan elegibilidad para revisar.
- Skills inicialmente equivalentes a módulos: Pagos, Control escolar, Ventas. Usar ids de módulos persistidos.
- Un revisor principal por documento. Conservar la posibilidad futura de varios sin exigirla en la UI inicial.
- La IA clasifica el tema; reglas del backend seleccionan al revisor y reservan la agenda.
- Corregir guarda una nueva revisión del Markdown. Validar aprueba una versión concreta; rechazar conserva motivo. Solicitar cambios, si se mantiene en la interfaz, debe tener un estado distinto de rechazo.
- Cada revisor conecta su Calendar. La revisión puede existir sin agenda conectada, con el agendado pendiente y visible.

Prueba objetivo: el admin crea a Alan con las tres skills; sube un MD de pagos; Alan recibe la revisión, conecta Google Calendar, lee el documento, guarda una corrección y valida la versión resultante.

Antes del primer despliegue:

1. Preservar y revisar los cambios locales de ambos repositorios.
2. Instalar dependencias desde sus lockfiles con una versión de Node compatible; el frontend declara Node >=22.12.
3. Corregir el import sin usar en `src/handlers/http/integration-handler.ts` que actualmente rompe `npm run build`.
4. Actualizar las pruebas del callback Calendar para los redirects 302 y los errores actuales.
5. Incorporar pruebas de los fallos reales: autorización del contenido, mensaje S3 dentro de SQS y correcciones persistidas.
6. Actualizar `api/openapi.json` junto con cada cambio de contrato y consumir esos contratos en el front.

Comprobaciones del backend:

```bash
cd /Users/alexis/Documents/Proyectos/oli-docs
npm ci
npm run build
npm test
```

**Salida:** build y pruebas pasan; el recorrido y sus estados están acordados. La auditoría previa obtuvo 387/389 pruebas aprobadas, pero los E2E usan IA, Calendar y repositorios simulados.

## 1. Preparar AWS y el entorno de desarrollo

Crear o seleccionar una cuenta/entorno de desarrollo y una región. `us-east-1` es el valor actual del proyecto; confirmar también disponibilidad del modelo de IA antes de fijarla.

En AWS Console:

1. Preparar una identidad de despliegue con permisos para CDK/CloudFormation y los servicios de esta guía; usar sesiones temporales.
2. Mantener MFA para administración de la cuenta y configurar un presupuesto/alerta de gasto.
3. Definir nombres y etiquetas de entorno: aplicación, `dev` y responsable.
4. Instalar AWS CLI y usar el perfil `oli-dev`. Si ya existe IAM Identity Center, conservar su flujo SSO. Si se usa acceso de consola, `aws login` permite una sesión temporal y requiere CLI >=2.32.0. Al ejecutar esta fase con Codex, el inicio de sesión se realiza después de autorizar esa acción.

Diagnóstico de identidad y región, una vez autenticado:

```bash
aws --version
aws sts get-caller-identity --profile oli-dev
export AWS_PROFILE='oli-dev'
export AWS_REGION='us-east-1'
export CDK_DEFAULT_REGION='us-east-1'
```

El id de cuenta debe coincidir con el entorno elegido. Preparar CDK para esa combinación cuenta/región. En el ejemplo siguiente, sustituir `123456789012` por el id real:

```bash
cd /Users/alexis/Documents/Proyectos/oli-docs/infra
npx cdk bootstrap aws://123456789012/us-east-1 --profile oli-dev
```

CDK crea los recursos de despliegue del stack `CDKToolkit`; no crea todavía la aplicación. [Documentación de bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html). Los métodos de acceso dependen de la identidad utilizada. [Acceso mediante AWS CLI](https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html).

**Salida:** cuenta y región identificadas, sesión válida y bootstrap preparado.

## 2. Preparar Google para el login

En Google Cloud Console:

1. Crear un proyecto de desarrollo para Oli's Docs.
2. Configurar Google Auth Platform: Branding, Audience y Data Access.
3. Elegir audiencia Internal si el proyecto pertenece al Workspace de BIT y todos los usuarios pertenecen a esa organización; en otro caso, configurar External y los usuarios de prueba.
4. Crear un cliente OAuth de tipo Web application.
5. Registrar el redirect de Cognito según el prefijo de dominio que se usará:

```text
https://<prefijo>.auth.<region>.amazoncognito.com/oauth2/idpresponse
```

Para login, Cognito solicita `openid email profile`. Google devuelve la identidad a Cognito; luego Cognito devuelve el código al frontend `/auth/callback`. Son redirects diferentes. [Federación social en Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html).

Guardar el client secret en AWS Secrets Manager, en la región elegida. Nombre propuesto para dev: `oli-docs/dev/google-client`. Crear el secreto desde la consola con esta estructura:

```json
{"clientSecret":"VALOR_REAL_DEL_SECRETO"}
```

El client id es configuración pública. El secret y los refresh tokens permanecen en el backend. La lectura del secreto JSON ya está implementada en Calendar; no es una brecha pendiente.

**Salida:** client id, secreto almacenado y redirect Cognito registrados. El permiso Calendar se agrega en el hito 6.

## 3. Reparar CDK y desplegar la base

Servicios de esta versión:

| Servicio | Uso | Estado en el repo |
|---|---|---|
| Cognito | Login Google, usuarios y grupos | Existe; necesita ajustes |
| DynamoDB | Usuarios, skills, documentos, revisiones y auditoría | Existe en DataStack |
| S3 de documentos | Markdown original y revisiones | Existe; completar versiones y CORS |
| API Gateway HTTP API + Lambda | API y reglas de negocio | Existen; completar contratos y CORS |
| SQS + DLQ + Lambda workers | Clasificación, asignación y agenda | Existen; reparar mensajes y reintentos |
| Secrets Manager | Credenciales Google y refresh tokens | Proveedor existente |
| Bedrock | Clasificación del tema | Proveedor existente; probar un modelo real |
| S3 de frontend + CloudFront | Publicar Astro por HTTPS | Hosting por agregar |
| CloudWatch | Logs y alarmas | Completar para el recorrido |
| EventBridge | Chequeo de revisiones vencidas | Stack existente; montar al cerrar el piloto |

Mantener DynamoDB y las consultas actuales para este alcance. El Markdown va en S3; Dynamo guarda metadatos y referencias. Productos múltiples, chat de consulta, RAG, Drive, Gmail, reportes y triage quedan fuera de esta entrega.

Ajustes previos al deploy:

1. Resolver el ciclo del AuthStack: policy IAM del trigger → UserPool → Lambda de pre-signup → policy. El synth auditado emitió `CloudFormation-Validate::F3004`, aunque terminó con código 0. Revisar el wiring y eliminar esa referencia circular antes de desplegar.
2. Corregir `email` inmutable que se mapea desde Google, y verificar permisos de escritura del app client sobre atributos mapeados. [Requisitos de mapeo Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html).
3. Hacer que `infra/bin/app.ts` reciba entorno, URLs del frontend y configuración Google; rechazar valores de ejemplo como `REPLACE_VIA_CONTEXT`.
4. Configurar CORS en API Gateway y bucket de documentos para el origen exacto del frontend de dev. Usar permisos por rol/recurso en el backend además de la navegación del front.
5. Agregar `AdminDeleteUser` a la Lambda de revisores: se utiliza para compensar altas fallidas.
6. Exponer outputs: API URL, UserPoolId, UserPoolClientId, dominio Cognito, nombre de tabla, bucket y colas.
7. Separar secretos por entorno y pasar el mismo client id/secret id a Cognito y a las Lambdas de Calendar. Las Lambdas necesitan permisos para leer el secreto.

Configuración pública inicial en `infra/cdk.context.json` —archivo propuesto, por crear—:

```json
{
  "googleClientId": "CLIENT_ID_REAL.apps.googleusercontent.com",
  "googleClientSecretId": "oli-docs/dev/google-client",
  "hostedUiDomainPrefix": "PREFIJO_UNICO_DE_DEV"
}
```

Estas tres claves ya se leen en AuthStack. El entorno, URLs y variables Google para API/workers deben conectarse en código; no basta con agregar claves al JSON.

Después de reparar la infraestructura:

```bash
cd /Users/alexis/Documents/Proyectos/oli-docs/infra
npx cdk list --profile oli-dev
npx cdk synth --profile oli-dev
npx cdk diff --profile oli-dev
npx cdk deploy OliDocs-Data OliDocs-Auth OliDocs-Api --profile oli-dev
```

Leer también advertencias de synth/diff. `NodejsFunction` empaqueta las Lambdas durante CDK: `build:lambdas` no es un requisito separado de este despliegue. Los nombres anteriores son los actuales; si se parametrizan por entorno, usar los que devuelva `cdk list`.

Inicialmente se puede probar el frontend en `http://localhost:4321` contra AWS dev. Registrar ese origen y callback de manera explícita. Después, agregar hosting privado S3 + CloudFront, publicar por HTTPS y actualizar callbacks/orígenes al dominio de dev. [Acceso privado desde CloudFront a S3](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

**Salida:** recursos base desplegados, outputs guardados y API accesible desde el frontend. Workers se despliegan cuando se habilite su flujo.

## 4. Crear el primer admin y cerrar login, sesión y roles

Implementar un script administrativo idempotente, fuera de la API pública, para:

1. Crear o encontrar el usuario Cognito del correo elegido.
2. Incorporarlo al grupo `admin`.
3. Crear el perfil local en DynamoDB con el mismo `sub` de Cognito y rol admin.
4. Permitir repetir la operación sin duplicados y reportar fallas parciales.

Actualmente no existe este procedimiento. Evitar que “el primero que se registre” reciba admin.

Corregir el trigger de vinculación Google: comprobar correo verificado, invitación existente y proveedor esperado; rechazar explícitamente a quien no esté autorizado. Deshabilitar registro público por sí solo no define toda la política de admisión federada. [Creación y admisión de usuarios](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html).

Agregar `GET /v1/me` para obtener identidad y permisos reales. Respuesta propuesta:

```json
{
  "id": "COGNITO_SUB",
  "email": "alan@bit.lat",
  "name": "Alan",
  "role": "revisor",
  "active": true,
  "calendar": {"status": "not_connected"}
}
```

Configurar el frontend con los outputs reales:

```dotenv
PUBLIC_API_URL=https://API_REAL.execute-api.us-east-1.amazonaws.com
PUBLIC_COGNITO_DOMAIN=PREFIJO_REAL.auth.us-east-1.amazoncognito.com
PUBLIC_COGNITO_CLIENT_ID=APP_CLIENT_ID_REAL
PUBLIC_COGNITO_REDIRECT_URI=http://localhost:4321/auth/callback
```

Sustituir `demoUser`/`useDemoRole` por la sesión real en navegación, cuenta y revisiones. Completar validación del retorno OAuth, renovación/expiración y logout que borre la sesión local y cierre la sesión del proveedor de la app cuando corresponda. El bootstrap debe pedir información según el rol. Ante un 401/403/error de API, mostrar el estado real; las muestras solo se activan en un modo demo explícito.

**Salida:** el admin entra con Google; su id y rol coinciden en Cognito/API/front; un correo no invitado no entra; salir o vencer la sesión no deja el panel operativo.

## 5. Registrar revisores y skills

Desde la cuenta admin:

1. Crear módulos Pagos, Control escolar y Ventas con la API existente de módulos.
2. Crear a Alan por correo/nombre mediante `/v1/reviewers`.
3. Asignarle los ids de esos módulos con permiso `edit` mediante las rutas de assignments existentes.
4. Refrescar el store después del alta y de cada modificación. El nuevo usuario debe aparecer sin depender de datos de muestra.
5. Implementar edición de skills y desactivación; evitar tags que no se correspondan con un módulo guardado.
6. Ajustar la invitación para el login Google: la experiencia no debe dirigir al revisor a establecer una contraseña que no va a usar.

Revisar que Cognito y Dynamo usen el mismo `sub`. El revisor no puede modificar su rol; la API protege administración, contenido y acciones de revisión. Los usuarios desactivados deben perder acceso a las operaciones protegidas y dejar de ser candidatos para nuevas asignaciones.

**Salida:** Alan inicia con Google y ve su perfil; sus tres skills sobreviven a recarga; no puede dar de alta usuarios ni acceder a documentos ajenos.

## 6. Conectar el Calendar de cada persona

Habilitar Google Calendar API en el proyecto Google. Agregar autorización por persona desde onboarding y Mi cuenta, accesible al revisor.

Scopes para la integración REST actual:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.events.freebusy
```

El primero permite crear eventos; el segundo cubre disponibilidad. `calendar.events` solo no alcanza para `freeBusy`. [Crear eventos](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Consultar disponibilidad](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

Después de desplegar la API, registrar en Google el redirect exacto:

```text
<ApiUrl>/v1/integrations/google/callback
```

Pasar por CDK a integrations y scheduling worker:

```dotenv
GOOGLE_CLIENT_ID=CLIENT_ID_REAL.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET_ID=oli-docs/dev/google-client
GOOGLE_REDIRECT_URI=https://API_REAL/v1/integrations/google/callback
FRONT_URL=http://localhost:4321
```

`ApiUrl` es el output completo, incluido `https://`; no anteponerle otro prefijo. Hacer un segundo deploy de la API con esa configuración y usarla también al desplegar workers. Esto evita inventar la URL antes de que exista. Al publicar el frontend, cambiar `FRONT_URL` a su URL HTTPS.

Completar el flujo existente: URL de consentimiento → `state` ligado al usuario → intercambio de código → refresh token protegido por persona → redirect al front. Mantener acceso offline para el agendado en segundo plano. [OAuth de aplicaciones web](https://developers.google.com/identity/protocols/oauth2/web-server).

Agregar consulta persistida del estado Calendar en `/me` o `GET /v1/integrations/google/status`. Permitir desconexión/reconexión. Comprobar que la cuenta Google autorizada corresponde al revisor; no inferir identidad solo por el correo escrito en la UI. Guardar el `state` OAuth en almacenamiento con expiración y consumo condicional, para que sea efectivamente de un solo uso.

**Salida:** Alan conecta su agenda, el estado sobrevive a recarga y se comprueba disponibilidad con su autorización mediante una prueba del proveedor backend. Desconectar/revocar se refleja correctamente. La creación automática de eventos se prueba en el hito 10, cuando estén desplegados los workers.

### Dónde encaja el MCP de Google

Para cerrar este MVP, la ruta recomendada es la API REST ya existente detrás de `CalendarProvider`. El backend ejecuta disponibilidad/agendado y valida quién puede hacerlo. MCP es una interfaz opcional para que un agente consuma herramientas; no reemplaza OAuth ni la autorización por revisor.

Google ofrece un MCP remoto de Calendar en **Developer Preview**, sujeto al programa correspondiente. Si se decide incorporarlo, seguir su guía: acceso al programa, habilitar Calendar API y Calendar MCP API, configurar OAuth y conectar un cliente Streamable HTTP. El endpoint documentado es `https://calendarmcp.googleapis.com/mcp/v1`. [Configuración oficial del MCP Calendar](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server).

En Oli's Docs, esa alternativa requiere implementar un adaptador de `CalendarProvider`, comprobar las herramientas/scopes de lectura y escritura disponibles para el proyecto, mantener credenciales por usuario y demostrar funcionamiento en segundo plano. La prueba debe verificar que una orden para Alan no puede utilizar la agenda de otra persona. Conservar el proveedor REST permite avanzar mientras se evalúa esa alternativa.

## 7. Cargar y leer Markdown real antes de automatizar

Conectar `/carga` al bootstrap administrativo. Aceptar `.md` y realizar el flujo existente: crear metadatos → presigned POST multipart a S3 → confirmar carga.

Cambios pendientes:

- Verificar existencia y tamaño del objeto en la confirmación; no marcarlo cargado solo porque el cliente lo solicita.
- Usar el `documentId` real en la fila de carga. Reemplazar temporizadores/progreso ficticio por estados de servidor.
- Entregar Markdown crudo, versión y secciones con ids estables para lectura/edición.
- Autorizar lectura a admin y al revisor asignado; conservar las restricciones para los demás.
- Completar `/reviews/mine` con metadatos útiles y el detalle de la revisión con contenido y anotaciones, o exponer endpoints equivalentes por recurso.
- Implementar un endpoint o script administrativo que cree un ReviewRecord para un documento/revisor concretos y usarlo para demostrar lectura antes de incorporar IA. Las rutas existentes de assignments asignan skills a módulos; no crean una revisión documental. Este mecanismo manual también servirá para resolver documentos sin candidato automático.

Mantener Astro estático con páginas contenedoras que resuelvan ids en cliente: por ejemplo `/documento?id=<id>` y `/revisiones?revision=<id>`. No generar las únicas rutas desde documentos de muestra. Quitar la inconsistencia entre producto `oli` del adaptador y `academic/togie` de la maqueta; para el MVP puede existir un único espacio documental.

**Salida:** un MD nuevo abre mediante URL directa y recarga sin reconstruir el front; Alan lo lee y otro revisor recibe 403 al intentar abrirlo.

## 8. Guardar correcciones y cerrar las decisiones humanas

Implementar escritura de Markdown por versión, manteniendo el original. Definir una ruta de guardado de contenido/revisión con control de concurrencia: el cliente envía la versión de partida y el servidor devuelve conflicto si ya cambió.

Registrar qué versión revisa cada ReviewRecord. Aprobar esa versión exacta. Guardar anotaciones como comentarios, además del contenido corregido; no usar un comentario como sustituto de la edición del archivo.

Resultados:

| Acción | Comportamiento requerido |
|---|---|
| Guardar corrección | Persiste Markdown y nueva revisión; todavía no lo aprueba |
| Validar | Aprueba la versión revisada y registra persona/fecha |
| Rechazar | Conserva el documento y motivo; no lo publica |
| Solicitar cambios, si se mantiene | Estado propio y posibilidad de nueva revisión; no equivale a rechazo |

Actualizar enums, servicios, contrato, adaptadores y UI juntos. No mostrar una aprobación antes de que contenido y decisión estén guardados. Las correcciones deben conservarse al recargar y poder recuperarse si falla el envío final.

**Salida:** el admin y Alan ven la misma versión corregida y el mismo estado después de recargar. Aprobar nunca deja publicada una versión anterior a los cambios.

## 9. Habilitar clasificación IA y selección del revisor

En Bedrock, seleccionar y probar un modelo disponible en la región elegida; resolver acceso del modelo y permisos de invocación antes de conectar la cola. Para modelos de terceros, comprobar los requisitos de Marketplace y, cuando corresponda, el formulario de primer uso. [Acceso a modelos](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

Configurar `AI_PROVIDER=bedrock` y `AI_MODEL` por entorno. El proveedor actual usa formato Anthropic `InvokeModel` y un modelo de 2024 por defecto; no cambiar solo el id a un modelo de otro proveedor. Como mejora del adaptador, utilizar Converse con límites explícitos de salida para los modelos compatibles. [Invocación mediante Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html).

Separar dos decisiones:

1. IA: clasificar el documento entre los módulos válidos, con confianza y explicación guardadas. Baja confianza → cola visible para clasificación manual del admin.
2. Backend: filtrar candidatos activos, skill del módulo y permiso `edit`; seleccionar un revisor principal con una regla reproducible.

Regla inicial propuesta: menor número de revisiones pendientes; disponibilidad Calendar como desempate; último criterio estable para evitar selección arbitraria. Si no hay candidato, dejar el documento pendiente de asignación y mostrarlo al admin. Esta regla es una propuesta de MVP, no una capacidad existente.

Reparar el worker para desempaquetar notificaciones S3 dentro de `SQS.body.Records`. Probar el mismo formato que manda AWS. La clasificación manual debe disparar la asignación igual que la clasificación IA.

Desplegar Workers después de estas correcciones:

```bash
cd /Users/alexis/Documents/Proyectos/oli-docs/infra
npx cdk synth --profile oli-dev
npx cdk diff OliDocs-Workers --profile oli-dev
npx cdk deploy OliDocs-Workers --profile oli-dev
```

**Salida:** MD de pagos se asigna al candidato esperado; baja confianza y ausencia de candidatos tienen salida manual; repetir el mensaje no duplica la revisión.

## 10. Automatizar agendado y recuperación

Con Calendar conectado y workers reales:

1. Estimar duración de la revisión.
2. Buscar un espacio con disponibilidad conocida, zona horaria, horario laboral y antelación configurados.
3. Crear el evento con enlace a la revisión y guardar `eventId`/horario.
4. Si faltan permisos o falla Google, mantener la revisión asignada y el agendado pendiente con motivo/reintento.
5. Al conectar Calendar, reintentar las revisiones pendientes de agenda.

Corregir dos comportamientos actuales: una falla de `freeBusy` no significa agenda libre, y la existencia de cualquier ReviewRecord no significa que todo el trabajo del documento esté terminado.

Implementar idempotencia por documento/versión/revisor y una identidad determinista del evento o mecanismo equivalente. Una interrupción entre crear evento y guardar resultado no debe crear otra cita al reintentar. Honrar fallas parciales SQS y permitir recuperar mensajes desde DLQ después de corregir su causa. [Lambda y SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html).

**Salida:** una revisión crea una sola cita, en horario válido; fallas y reintentos no pierden documentos ni duplican eventos.

## 11. Publicar y ejecutar el piloto completo

Agregar/publicar el hosting del front en HTTPS si todavía se usa localhost. Actualizar URLs públicas en la compilación Astro y callbacks/orígenes en Cognito, Google, API Gateway y S3. Las variables `PUBLIC_*` del front deben incorporarse en el build.

Desplegar el stack existente de vencimientos y completar logs/retención/alertas para errores de Lambda y mensajes DLQ:

```bash
cd /Users/alexis/Documents/Proyectos/oli-docs/infra
npx cdk diff OliDocs-Events --profile oli-dev
npx cdk deploy OliDocs-Events --profile oli-dev
```

Pruebas de aceptación con admin, Alan y otro revisor:

- [ ] Alta real y skills persistidas.
- [ ] Login Google y roles correctos; rechazo de no invitados.
- [ ] Conectar, desconectar y reconectar Calendar por persona.
- [ ] Subir un MD y ver el estado de servidor.
- [ ] Clasificar/asignar al candidato esperado; resolver baja confianza manualmente.
- [ ] Abrir la revisión y el Markdown por URL directa.
- [ ] Impedir lectura/edición de una revisión ajena.
- [ ] Crear una cita real; reintentar sin duplicados.
- [ ] Guardar corrección, recargar y aprobar esa versión.
- [ ] Rechazar con motivo; solicitar cambios tiene significado propio si se conserva.
- [ ] Mostrar fallas reales sin sustituirlas por datos demo.
- [ ] Desactivar a un revisor impide acceso y nuevas asignaciones.

El MVP queda cerrado cuando este recorrido pasa en AWS y Google reales. Los E2E con fakes continúan siendo útiles para lógica, pero no sustituyen este piloto.

## Archivos que concentran el trabajo

| Frente | Backend | Frontend |
|---|---|---|
| AWS/CDK | `infra/bin/app.ts`, `infra/lib/{auth,api,data,workers,events}-stack.ts` | Build y hosting Astro |
| Sesión/roles | `src/handlers/auth/*`, nuevo handler `/me`, `src/providers/cognito/*` | `src/lib/auth.ts`, `bootstrap.ts`, navegación y layouts |
| Revisores/skills | `reviewer-service.ts`, `assignment-service.ts`, handlers/repos | `UsersView.tsx`, gestión de módulos, store |
| MD/permisos/versiones | `document-service.ts`, `document-handler.ts`, `document-store.ts`, entidades | `UploadsView.tsx`, `DocumentDetail.tsx`, rutas de detalle |
| Revisión | `review-record-service.ts`, `approval-service.ts`, contrato | `ReviewsView.tsx`, editor, adaptadores |
| IA/asignación | `classification-service.ts`, workers, `scheduling-service.ts` | Estados reales y resolución manual admin |
| Google/agenda | `integration-handler.ts`, `providers/calendar/*`, configuración CDK | Onboarding/Mi cuenta, estado persistido de conexión |

La primera entrega de implementación debe cerrar los hitos 0–4: código compilable, infraestructura base, primer admin y login con sesión real. Después, avanzar una capacidad completa por hito.
