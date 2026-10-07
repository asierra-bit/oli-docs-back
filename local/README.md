# Entorno local de Oli's Docs

Levanta el flujo completo del backend **en tu máquina, sin desplegar nada a AWS**: cargar un `.md` → clasificar → asignar revisores → agendar → revisar → aprobar.

## Qué corre y qué se sustituye

| Pieza | Local | Cómo |
|---|---|---|
| Lógica de negocio | ✅ Real | TypeScript (los mismos handlers de producción) |
| DynamoDB | ✅ Real | DynamoDB Local (Docker) |
| S3 (contenido `.md`) | ✅ Real | LocalStack |
| SQS (colas) | ✅ Real | LocalStack |
| API Gateway + Lambda | ✅ Emulado | `http-runner.mjs` (invoca los handlers en `:3000`) |
| Autenticación | ◑ Falseada | El runner inyecta el claim `cognito:groups` desde `LOCAL_AUTH_*` |
| Clasificación IA | ◑ Fake | `FakeAiProvider` (`AI_PROVIDER=fake`) o `openai` con tu key |
| Google Calendar | ◑ Fake | `FakeCalendarProvider` |
| **Cognito + login Google** | ❌ No local | Se valida aparte contra un User Pool de **dev** (no es producción) |

> **El único pedazo que no se puede emular es el login real con Google (Cognito).** Todo lo demás —el flujo de negocio completo— corre offline. El login se prueba por separado contra un User Pool de dev cuando quieras validarlo; no requiere desplegar el resto de la app.

## Requisitos

- Docker + Docker Compose
- Node 20+
- `npx tsx` (se descarga solo la primera vez) para correr los handlers TS sin build

## Puesta en marcha

```bash
# 1. Levantar las dependencias (DynamoDB Local + LocalStack) y provisionar
docker compose -f local/docker-compose.yml up -d

# El contenedor `setup` crea tabla + bucket + colas automáticamente.
# Para re-provisionar manualmente desde el host:
export $(grep -v '^#' local/.env.local | xargs)
node local/setup-infra.mjs

# 2. Cargar las variables de entorno locales
export $(grep -v '^#' local/.env.local | xargs)

# 3. Arrancar la API local (emula API Gateway + Lambda, auth falseada)
npx tsx local/http-runner.mjs
# → Oli's Docs local API on http://localhost:3000
```

## Probar el flujo

```bash
# Actúas como admin (según LOCAL_AUTH_GROUPS=admin en .env.local)

# Crear un módulo ("skill")
curl -s -XPOST localhost:3000/v1/modules -d '{"name":"pagos"}'

# Dar de alta un revisor y asignarlo al módulo
curl -s -XPOST localhost:3000/v1/reviewers -d '{"email":"alan@bit.lat","name":"Alan"}'
curl -s -XPOST localhost:3000/v1/reviewers/<reviewerId>/assignments \
  -d '{"moduleId":"<moduleId>","permission":"edit"}'

# Iniciar la carga de un documento (devuelve el presigned POST a S3 local)
curl -s -XPOST localhost:3000/v1/documents -d '{"name":"manual-pagos.md"}'
```

### Cambiar de usuario/rol

Para probar como **revisor** en vez de admin, edita `local/.env.local`:

```
LOCAL_AUTH_USER_ID=<reviewerId>
LOCAL_AUTH_EMAIL=alan@bit.lat
LOCAL_AUTH_GROUPS=revisor
```

…recarga las variables y reinicia el runner. Luego:

```bash
curl -s localhost:3000/v1/reviews/mine
```

## Disparar los workers (clasificación / agendado)

En AWS, S3 y SQS disparan los workers solos. En local hay dos opciones:

**Automático (recomendado) — el poller:** vigila los documentos cargados y las
colas, y corre los workers en bucle, como en AWS.

```bash
export $(grep -v '^#' local/.env.local | xargs)
npm run local:poller
```

Con el poller corriendo, subir un `.md` en la UI desencadena clasificación y
agendado solo, en un par de segundos.

**Manual (one-shot) — el seed:** carga módulos, revisores y un `.md` de ejemplo
y encadena los workers una vez, para un end-to-end rápido:

```bash
npm run local:seed
```

## Parar todo

```bash
docker compose -f local/docker-compose.yml down
```

Nada de esto toca tu cuenta de AWS. Cuando el flujo completo pase en local, recién ahí se despliega con `npm run cdk:deploy`.

## Scripts sugeridos para `package.json`

```jsonc
"local:up":    "docker compose -f local/docker-compose.yml up -d",
"local:down":  "docker compose -f local/docker-compose.yml down",
"local:setup": "node local/setup-infra.mjs",
"local:api":    "tsx local/http-runner.mjs",
"local:poller": "tsx local/poller.mjs",
"local:seed":   "tsx local/seed.mjs"
```
