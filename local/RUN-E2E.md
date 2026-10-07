# Checklist para correr el end-to-end en local

Orden exacto de comandos para levantar Oli's Docs en tu máquina y verificar el
flujo completo, sin desplegar nada a AWS. Marca cada paso al pasarlo.

> Requisitos: Docker + Docker Compose, Node 20+. El login real con Google NO se
> prueba aquí (necesita Cognito; ver `LOGIN-SETUP.md`). El runner local falsea
> la identidad, así que todo el flujo de negocio sí es verificable offline.

---

## Paso 1 — Dependencias del backend

```bash
cd oli-docs
npm install            # instala tsx (nuevo) y el resto
```

- [ ] `npm install` termina sin errores.

**Qué verificar:** que `tsx` quedó en `node_modules` (lo usan `local:api` y `local:seed`).

---

## Paso 2 — Levantar la infraestructura local

```bash
npm run local:up       # DynamoDB Local + LocalStack (S3/SQS)
```

- [ ] `docker compose` levanta los contenedores `oli-dynamodb` y `oli-localstack`.
- [ ] El contenedor `oli-setup` corre y termina en code 0 (crea tabla + bucket + colas).

**Qué verificar:**
```bash
docker ps                      # oli-dynamodb y oli-localstack en estado healthy
docker logs oli-setup          # debe imprimir "Local infrastructure is ready."
```

Si `oli-setup` corrió antes de que los otros estuvieran listos, re-provisiona a mano:
```bash
export $(grep -v '^#' local/.env.local | xargs)
npm run local:setup
```

---

## Paso 3 — Cargar variables de entorno

```bash
export $(grep -v '^#' local/.env.local | xargs)
```

- [ ] `echo $DYNAMODB_ENDPOINT` imprime `http://localhost:8000`.
- [ ] `echo $AWS_ENDPOINT_URL` imprime `http://localhost:4566`.

---

## Paso 4 — Seed del flujo completo

```bash
npm run local:seed
```

- [ ] Imprime los 7 pasos (módulos → revisor → upload → confirm → clasificación → agendado → revisiones).
- [ ] El documento llega a estado `in_review` o `classified`.
- [ ] "calendar blocks booked (fake)" ≥ 1.
- [ ] Imprime los `LOCAL_AUTH_*` del revisor Alan al final.

**Punto de fricción probable (imports `.ts` con tsx):** el seed importa módulos
`../src/...ts`. Si `tsx` se queja de la extensión, confirma que corres con
`npm run local:seed` (usa tsx), no con `node`.

---

## Paso 5 — Arrancar la API local

```bash
npm run local:api      # http://localhost:3000
```

- [ ] Imprime "Oli's Docs local API on http://localhost:3000".
- [ ] Imprime "Acting as: admin@bit.lat [admin]".

**Prueba rápida:**
```bash
curl -s localhost:3000/v1/modules | head
# Debe devolver los 3 módulos del seed (pagos, control-escolar, ventas).
```

- [ ] `GET /v1/modules` devuelve los módulos del seed.

---

## Paso 6 — Front contra la API local

```bash
cd ../oli-docs-front
npm install
cp .env.example .env
# Edita .env: deja PUBLIC_API_URL=http://localhost:3000 y BORRA (o deja de
# ejemplo) las PUBLIC_COGNITO_* para que el login caiga a modo maqueta.
npm run dev            # http://localhost:4321
```

- [ ] El front abre en `:4321`.
- [ ] En "Usuarios" aparecen los revisores reales del backend (no los de ejemplo).
- [ ] En "Mis revisiones" (como el revisor del seed) aparece su revisión.

**Punto de fricción probable (CORS):** ya añadimos cabeceras CORS al runner. Si
igual aparece un error de CORS en la consola del navegador, fija el origen:
```bash
# en la terminal de la API, antes de local:api
export LOCAL_CORS_ORIGIN=http://localhost:4321
```

---

## Paso 7 — Verificar el flujo real desde la UI

- [ ] **Carga:** sube un `.md` real en "Carga". Debe aparecer un toast "cargado,
      el agente lo está clasificando" (sube a S3 local vía presigned POST).
- [ ] **Clasificación/agendado:** arranca el **poller** en otra terminal para
      que sea automático (como en AWS):
      ```bash
      export $(grep -v '^#' local/.env.local | xargs)
      npm run local:poller
      ```
      Con el poller corriendo, al cargar un `.md` verás en pocos segundos el
      documento pasar a `classified` y aparecer su revisión agendada, sin tocar
      nada. (Sin el poller, el flujo se queda en `classifying`.)
- [ ] **Revisión:** como revisor, aprueba/rechaza una revisión. El toast debe
      reflejar la respuesta real del backend.
- [ ] **Contenido:** abre el detalle de un documento aprobado; debe bajar su
      Markdown desde S3 (`GET /documents/{id}/content`).

**Punto de fricción probable (presigned S3 host):** el presigned POST puede
apuntar a `localstack:4566` (nombre interno) en vez de `localhost:4566`. Si la
subida falla desde el navegador, es esto: hay que forzar que el endpoint S3
público sea `localhost`. Señal: el POST a S3 falla con DNS/host no resuelto.

---

## Resumen de puntos de fricción esperables

| Síntoma | Causa | Solución |
|---|---|---|
| Error CORS en consola | origen no permitido | `export LOCAL_CORS_ORIGIN=http://localhost:4321` |
| Subida a S3 falla (host) | presigned apunta a `localstack` | forzar endpoint S3 a `localhost` |
| `tsx` no resuelve `.ts` | corriste con `node` | usa `npm run local:*` |
| Documento sin contenido | aún no se subió a S3 | completa el upload antes de abrir el detalle |
| Clasificación no corre | poller no arrancado | `npm run local:poller` en otra terminal |

Nada de esto toca AWS. Cuando el flujo pase en local, recién ahí: `npm run cdk:deploy`.
