# Requirements Document

## Introduction

Este documento define los requisitos para el **backend** de un sistema web de revisión de documentos Markdown (`.md`) desplegado sobre AWS. El sistema permite que un administrador cargue documentación, defina módulos temáticos (ej. ventas, marca) y gestione revisores con permisos por módulo. Al subir un documento, una IA clasifica automáticamente a qué módulo pertenece, el sistema identifica a los revisores asignados a ese módulo, consulta su Google Calendar y agenda un bloque de revisión. Cada revisor realiza su revisión en un registro independiente (sin edición compartida), dejando anotaciones y marcando secciones o el documento completo como correcto o incorrecto. La aprobación final es configurable ("todos aprueban" o "al menos uno aprueba").

El alcance de esta entrega es **únicamente el backend**: API, funciones Lambda, almacenamiento de datos, integración con IA y agendado. El frontend lo desarrolla **otro equipo** y **queda fuera del alcance de esta sesión/spec**, por lo que la prioridad es exponer endpoints claros y bien documentados (contrato HTTP + OpenAPI). No se construye ninguna UI, componente web, ni assets de cliente aquí.

**Stack objetivo:** Node.js + TypeScript, AWS Lambda + API Gateway, DynamoDB, S3, Cognito (multi-rol con permisos por módulo y nivel lectura/edición), Amazon Bedrock como IA por defecto (con adapter para OpenAI/OpenRouter), Google Calendar para agendado. Infraestructura con AWS CDK (TypeScript).

**Restricción transversal:** El presupuesto está acotado (es para un evento). Toda decisión debe priorizar arquitectura serverless, pago por uso y bajo costo operativo.

### Glosario

- **Módulo:** categoría temática de documentación (ej. "ventas", "marca").
- **Documento:** archivo Markdown (`.md`) cargado en el sistema.
- **Registro de revisión (review record):** instancia independiente de revisión de un documento por un revisor concreto. Varios registros pueden existir en paralelo para el mismo documento.
- **Anotación:** comentario que un revisor adjunta a una sección o al documento completo dentro de su registro de revisión.
- **Veredicto:** marca de "correcto" o "incorrecto" sobre una sección o sobre el documento completo.
- **Política de aprobación:** regla que determina cuándo un documento se considera aprobado ("todos aprueban" o "al menos uno aprueba").

---

## Requirements

### Requirement 1: Gestión de módulos por el administrador

**User Story:** Como administrador, quiero crear y gestionar módulos temáticos, para organizar la documentación y controlar qué revisa cada usuario.

#### Acceptance Criteria

1. WHEN un administrador autenticado envía una solicitud para crear un módulo con un nombre THEN el sistema SHALL persistir el módulo con un identificador único y devolver el módulo creado.
2. IF un usuario sin rol de administrador solicita crear, actualizar o eliminar un módulo THEN el sistema SHALL rechazar la solicitud con un error de autorización (403).
3. WHEN un administrador solicita listar los módulos THEN el sistema SHALL devolver todos los módulos existentes.
4. WHEN un administrador actualiza el nombre de un módulo existente THEN el sistema SHALL persistir el cambio y devolver el módulo actualizado.
5. IF un administrador intenta crear un módulo con un nombre que ya existe THEN el sistema SHALL rechazar la solicitud con un error de conflicto (409).
6. WHEN un administrador intenta eliminar un módulo que tiene documentos o asignaciones vinculadas THEN el sistema SHALL rechazar la eliminación con un error de conflicto (409) indicando las dependencias.

### Requirement 2: Gestión de revisores por el administrador

**User Story:** Como administrador, quiero crear revisores y gestionar sus cuentas, para que puedan participar en el proceso de revisión.

#### Acceptance Criteria

1. WHEN un administrador crea un revisor con correo electrónico y nombre THEN el sistema SHALL registrar el usuario en Cognito con el rol "revisor" y devolver su identificador.
2. IF un administrador intenta crear un revisor con un correo ya registrado THEN el sistema SHALL rechazar la solicitud con un error de conflicto (409).
3. WHEN un administrador solicita listar los revisores THEN el sistema SHALL devolver todos los revisores con sus asignaciones de módulo.
4. WHEN un administrador desactiva un revisor THEN el sistema SHALL impedir que ese revisor se autentique y conservar sus registros de revisión históricos.
5. IF un usuario sin rol de administrador solicita crear o gestionar revisores THEN el sistema SHALL rechazar la solicitud con un error de autorización (403).

### Requirement 3: Asignación de módulos a revisores con nivel de permiso

**User Story:** Como administrador, quiero asignar módulos a cada revisor con un nivel de permiso (solo-lectura o edición), para controlar qué puede ver y hacer cada revisor.

#### Acceptance Criteria

1. WHEN un administrador asigna un módulo a un revisor con un nivel de permiso ("read" o "edit") THEN el sistema SHALL persistir la asignación y devolver la asignación creada.
2. IF se intenta crear una asignación con un nivel de permiso distinto de "read" o "edit" THEN el sistema SHALL rechazar la solicitud con un error de validación (400).
3. IF se asigna un módulo o revisor que no existe THEN el sistema SHALL rechazar la solicitud con un error de validación (400).
4. WHEN un administrador actualiza el nivel de permiso de una asignación existente THEN el sistema SHALL persistir el nuevo nivel.
5. WHEN un administrador elimina una asignación THEN el sistema SHALL quitar el vínculo entre el revisor y el módulo.
6. IF un revisor con permiso "read" sobre un módulo intenta crear o modificar un registro de revisión de un documento de ese módulo THEN el sistema SHALL rechazar la operación con un error de autorización (403).
7. WHEN se consultan las asignaciones de un revisor THEN el sistema SHALL devolver la lista de módulos con su nivel de permiso correspondiente.

### Requirement 4: Carga de documentos Markdown

**User Story:** Como administrador, quiero subir documentación inicial en formato Markdown (uno o varios archivos), para que entre al flujo de revisión.

#### Acceptance Criteria

1. WHEN un administrador solicita subir un documento `.md` THEN el sistema SHALL proporcionar un mecanismo de carga del contenido hacia S3 (ej. URL prefirmada) y registrar los metadatos del documento en la base de datos.
2. IF el archivo cargado no tiene extensión `.md` o excede el tamaño máximo configurado (parámetro configurable, default 5 MB) THEN el sistema SHALL rechazar la carga con un error de validación (400).
3. WHEN se registra un documento THEN el sistema SHALL asignarle un identificador único, almacenar su contenido en S3 y guardar metadatos (nombre, ruta en S3, estado, fecha de carga, módulo si está determinado).
4. WHEN un administrador sube varios documentos en una operación THEN el sistema SHALL procesar cada documento de forma individual e informar el resultado por cada archivo.
5. WHEN un documento se carga correctamente THEN el sistema SHALL iniciar el flujo de clasificación por IA (Requirement 5).
6. IF la carga del contenido a S3 no se confirma THEN el sistema SHALL mantener el documento en un estado "pendiente de contenido" y no iniciar la clasificación.

### Requirement 5: Clasificación automática del módulo mediante IA

**User Story:** Como sistema, quiero analizar el contenido de cada documento con IA, para determinar automáticamente a qué módulo pertenece.

#### Acceptance Criteria

1. WHEN un documento se carga correctamente THEN el sistema SHALL enviar su contenido a un proveedor de IA para clasificarlo contra la lista de módulos existentes.
2. WHEN la IA devuelve un módulo THEN el sistema SHALL asociar el documento a ese módulo y actualizar el estado del documento a "clasificado".
3. IF la IA no puede determinar un módulo con confianza suficiente THEN el sistema SHALL marcar el documento para clasificación manual y notificarlo en su estado ("needs_manual_classification").
4. The system SHALL usar Amazon Bedrock como proveedor de IA por defecto.
5. The system SHALL exponer una capa de abstracción (adapter) que permita cambiar el proveedor de IA a OpenAI u OpenRouter mediante configuración, sin cambios en la lógica de clasificación.
6. WHEN un administrador reasigna manualmente el módulo de un documento THEN el sistema SHALL sobrescribir la clasificación de la IA y registrar que fue una clasificación manual.
7. IF la llamada al proveedor de IA falla THEN el sistema SHALL reintentar según una política configurada y, si persiste el fallo, dejar el documento en estado "classification_failed" sin bloquear otras operaciones.

### Requirement 6: Identificación de revisores y agendado en Google Calendar

**User Story:** Como sistema, quiero identificar a los revisores asignados al módulo de un documento y agendar automáticamente un bloque de revisión en su Google Calendar, para que la revisión quede planificada sin intervención manual.

#### Acceptance Criteria

1. WHEN un documento queda clasificado en un módulo THEN el sistema SHALL identificar a todos los revisores asignados a ese módulo.
2. WHEN se identifican los revisores de un documento THEN el sistema SHALL consultar la disponibilidad en el Google Calendar de cada revisor.
3. WHEN se encuentra disponibilidad THEN el sistema SHALL crear un evento de calendario con un bloque de duración estimada para la revisión y vincular el evento al registro de revisión correspondiente.
4. The system SHALL calcular la duración estimada del bloque de revisión en función de un criterio configurable (ej. tamaño o número de secciones del documento).
5. IF un revisor no ha autorizado el acceso a su Google Calendar THEN el sistema SHALL crear el registro de revisión igualmente y marcar el agendado como "no agendado" para ese revisor, sin bloquear el flujo.
6. IF la llamada a la API de Google Calendar falla THEN el sistema SHALL reintentar según una política configurada y registrar el fallo sin bloquear la creación del registro de revisión.
7. WHEN se agenda un bloque THEN el sistema SHALL evitar solapamientos con eventos existentes del revisor dentro de la ventana consultada.
8. The system SHALL exponer un endpoint para que un revisor vincule su cuenta de Google Calendar mediante OAuth 2.0. El sistema almacenará el refresh token de forma segura para consultas y creación de eventos posteriores. Un revisor podrá desvincular su calendario en cualquier momento.

### Requirement 7: Registros de revisión independientes y paralelos

**User Story:** Como revisor, quiero realizar mi revisión en un registro independiente, para que mi trabajo no interfiera con el de otros revisores del mismo documento.

#### Acceptance Criteria

1. WHEN un documento es clasificado y tiene revisores asignados THEN el sistema SHALL crear un registro de revisión independiente por cada revisor asignado.
2. The system SHALL mantener los registros de revisión de un mismo documento como instancias separadas sin edición compartida entre revisores.
3. WHEN un revisor consulta sus revisiones pendientes THEN el sistema SHALL devolver únicamente los registros de revisión que le pertenecen.
4. IF un revisor intenta acceder al registro de revisión de otro revisor THEN el sistema SHALL rechazar la solicitud con un error de autorización (403).
5. WHEN varios revisores están asignados al mismo documento THEN el sistema SHALL permitir que cada uno avance en su propio registro de forma concurrente sin bloqueos entre ellos.
6. WHEN se crea un registro de revisión THEN el sistema SHALL inicializarlo en estado "pending".

### Requirement 8: Anotaciones y veredictos dentro de un registro de revisión

**User Story:** Como revisor, quiero dejar anotaciones y marcar secciones o el documento completo como correcto o incorrecto, para registrar el resultado de mi revisión.

#### Acceptance Criteria

1. WHEN un revisor con permiso de edición agrega una anotación a una sección o al documento dentro de su registro THEN el sistema SHALL persistir la anotación con su autor, destino (sección o documento) y marca de tiempo.
2. WHEN un revisor marca una sección como "correcto" o "incorrecto" dentro de su registro THEN el sistema SHALL persistir el veredicto asociado a esa sección.
3. WHEN un revisor marca el documento completo como "correcto" o "incorrecto" dentro de su registro THEN el sistema SHALL persistir el veredicto a nivel de documento.
4. IF un revisor con permiso de solo-lectura intenta crear anotaciones o veredictos THEN el sistema SHALL rechazar la operación con un error de autorización (403).
5. WHEN un revisor edita o elimina una anotación que él mismo creó THEN el sistema SHALL aplicar el cambio dentro de su propio registro.
6. WHEN un revisor envía (submit) su registro de revisión THEN el sistema SHALL cambiar el estado del registro a "completed" y registrar el veredicto final del revisor para ese documento.
7. IF un revisor envía su registro sin haber emitido un veredicto a nivel de documento THEN el sistema SHALL rechazar el envío con un error de validación (400).
8. WHEN un registro de revisión ha sido enviado ("completed") THEN el sistema SHALL impedir modificaciones posteriores salvo que un administrador lo reabra.

### Requirement 9: Política de aprobación configurable del documento

**User Story:** Como administrador, quiero configurar cómo se aprueba un documento ("todos aprueban" o "al menos uno aprueba"), para adaptar el proceso a distintas necesidades.

#### Acceptance Criteria

1. The system SHALL permitir configurar la política de aprobación por documento o módulo con los valores "all" (todos aprueban) o "any" (al menos uno aprueba).
2. IF no se especifica política de aprobación THEN el sistema SHALL aplicar un valor por defecto configurable.
3. WHEN todos los registros de revisión de un documento han sido enviados THEN el sistema SHALL evaluar la política de aprobación para determinar el estado final del documento.
4. WHEN la política es "all" y todos los veredictos a nivel de documento son "correcto" THEN el sistema SHALL marcar el documento como "approved".
5. WHEN la política es "all" y al menos un veredicto a nivel de documento es "incorrecto" THEN el sistema SHALL marcar el documento como "rejected".
6. WHEN la política es "any" y al menos un veredicto a nivel de documento es "correcto" THEN el sistema SHALL marcar el documento como "approved".
7. WHEN la política es "any" y todos los veredictos a nivel de documento son "incorrecto" THEN el sistema SHALL marcar el documento como "rejected".
8. WHEN el estado final de aprobación de un documento se determina THEN el sistema SHALL registrar la fecha y la política aplicada, y exponerlo mediante la API.
9. IF uno o más registros de revisión de un documento permanecen en estado "pending" por más tiempo que un plazo configurable (default 7 días) THEN el sistema SHALL notificar al administrador. Un administrador podrá forzar la evaluación de la política de aprobación excluyendo los registros no enviados, registrando qué registros fueron excluidos y la razón.

### Requirement 10: Autenticación y autorización multi-rol

**User Story:** Como responsable del sistema, quiero autenticación y autorización basada en roles y permisos por módulo, para proteger las operaciones sensibles.

#### Acceptance Criteria

1. The system SHALL usar Amazon Cognito para autenticar usuarios y emitir tokens.
2. The system SHALL soportar al menos dos roles: "admin" y "revisor".
3. WHEN un endpoint requiere autenticación THEN el sistema SHALL rechazar solicitudes sin un token válido con un error de autenticación (401).
4. WHEN un endpoint requiere un rol específico THEN el sistema SHALL rechazar a usuarios sin ese rol con un error de autorización (403).
5. WHEN un revisor opera sobre documentos THEN el sistema SHALL verificar que tenga asignación al módulo del documento y el nivel de permiso adecuado antes de permitir la operación.
6. The system SHALL registrar las operaciones sensibles (altas de usuarios, cambios de asignaciones, cambios de política de aprobación) para auditoría.

### Requirement 11: Exposición clara de la API para el equipo de frontend

**User Story:** Como equipo de frontend, quiero endpoints bien definidos y documentados, para integrar la interfaz sin ambigüedades.

#### Acceptance Criteria

1. The system SHALL exponer la funcionalidad mediante una API HTTP a través de API Gateway.
2. The system SHALL devolver respuestas con códigos de estado HTTP coherentes y cuerpos de error con una estructura uniforme (código, mensaje, detalles).
3. The system SHALL documentar los endpoints, métodos, parámetros, cuerpos de solicitud y respuesta, y códigos de error (ej. especificación OpenAPI).
4. The system SHALL usar formatos de datos consistentes (JSON) y nombres de campo estables entre endpoints.
5. WHEN la API cambia de forma incompatible THEN el sistema SHALL versionar la API para no romper a los clientes existentes.

### Requirement 12: Arquitectura serverless y bajo costo

**User Story:** Como responsable del presupuesto, quiero una arquitectura serverless de pago por uso, para minimizar el costo de un sistema usado durante un evento.

#### Acceptance Criteria

1. The system SHALL implementar el cómputo mediante AWS Lambda y la exposición mediante API Gateway.
2. The system SHALL usar DynamoDB con capacidad bajo demanda (pay-per-request) para el almacenamiento de datos.
3. The system SHALL usar S3 para almacenar el contenido de los documentos Markdown.
4. The system SHALL definir toda la infraestructura con AWS CDK en TypeScript.
5. The system SHALL evitar recursos con costo fijo continuo cuando exista una alternativa serverless de pago por uso equivalente.
6. The system SHALL aplicar límites y políticas de reintento razonables en las llamadas a servicios de IA y Google Calendar para controlar el costo.

### Requirement 13: Eventos del sistema para integración y notificaciones

**User Story:** Como responsable del sistema, quiero que las acciones importantes generen eventos internos, para poder conectar notificaciones u otras integraciones sin acoplar la lógica.

#### Acceptance Criteria

1. The system SHALL publicar eventos internos (vía EventBridge o SNS) para: documento cargado, documento clasificado, clasificación manual requerida, revisión agendada, registro de revisión completado, documento aprobado, documento rechazado, plazo de revisión vencido.
2. Cada evento incluirá: tipo de evento, identificador del recurso, timestamp y actor (si aplica).
3. Los eventos son informativos — el flujo principal NO depende de sus consumidores.
4. IF la publicación de un evento falla THEN el sistema registrará el fallo en logs sin bloquear la operación principal.
