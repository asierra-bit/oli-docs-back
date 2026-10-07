# Configuración del login con Google (Cognito + Google Cloud)

Guía para dejar operativo el login real de Oli's Docs de punta a punta. Cubre
los dos usos de OAuth con Google, la configuración en Google Cloud, en AWS
(Cognito) y en el front (`.env`), y los **desajustes conocidos** que hay que
resolver al cablearlo.

> **El login real NO corre en local.** Cognito no tiene emulador gratuito, así
> que esta configuración apunta a un User Pool real (puede ser uno de **dev**,
> que no es producción). El resto del flujo de negocio sí corre offline (ver
> `local/README.md`). El entorno local falsea la identidad en el runner.

---

## 1. Las dos piezas de OAuth con Google (no confundirlas)

Oli's Docs usa Google OAuth para **dos cosas distintas**, y conviene que
compartan el **mismo cliente OAuth** de Google Cloud:

| Pieza | Para qué | Scopes | Quién redirige |
|---|---|---|---|
| **Login (autenticación)** | "Entrar con Google" vía Cognito | `openid email profile` | Google → **Cognito Hosted UI** → front `/auth/callback` |
| **Calendar (autorización)** | El agente agenda en el Calendar de cada revisor | `calendar.events` | Google → **API Gateway** `/v1/integrations/google/callback` |

El login lo gestiona **Cognito** (federación con Google como IdP). Calendar es
un flujo **propio** del backend (`integration-handler.ts`), per-reviewer: cada
revisor autoriza su propio Calendar y el backend guarda un refresh token por
persona.

---

## 2. Google Cloud Console

1. **Crea un proyecto** (o usa el de BIT).
2. **Pantalla de consentimiento OAuth**: tipo *Internal* (sólo cuentas
   `@bit.lat` del Workspace). Agrega los scopes `openid`, `email`, `profile` y
   `https://www.googleapis.com/auth/calendar.events`.
3. **Credenciales → Crear credencial → ID de cliente OAuth → Aplicación web.**
4. **Orígenes autorizados de JavaScript:** no son necesarios para este flujo.
5. **URIs de redireccionamiento autorizados** — agrega **las dos**:
   - **Login (Cognito Hosted UI):**
     `https://<hostedUiDomainPrefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`
     (p. ej. `https://oli-docs-auth.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`)
   - **Calendar (API Gateway):** la URL del endpoint
     `GET /v1/integrations/google/callback` de tu HTTP API
     (p. ej. `https://abc123.execute-api.us-east-1.amazonaws.com/v1/integrations/google/callback`)
6. Guarda el **Client ID** y el **Client secret** que te da Google.

> El `redirect_uri` que el navegador use SIEMPRE debe coincidir **exactamente**
> con uno de los registrados aquí, o Google rechaza con `redirect_uri_mismatch`.

---

## 3. AWS — Secrets Manager y despliegue del AuthStack

### 3.1 Guardar el client secret

El `auth-stack.ts` lee el secreto con `jsonField: 'clientSecret'`, así que
**guárdalo como JSON**:

```bash
aws secretsmanager create-secret \
  --name 'oli-docs/google-oauth' \
  --secret-string '{"clientSecret":"EL-SECRET-DE-GOOGLE"}'
```

> ⚠️ **Desajuste conocido #1 (secreto JSON vs crudo).** El AuthStack espera el
> secreto como **JSON** (`{"clientSecret":"..."}`). Pero el flujo de Calendar
> (`integration-handler.ts`) lo lee con `secrets.getSecret(...)`, que devuelve
> el **SecretString crudo** — esperaría el secret pelado, no un JSON. Con el
> secreto en JSON, el login funciona pero el intercambio de Calendar recibiría
> el JSON entero como "secret" y fallaría. **Resolución recomendada:** que el
> flujo de Calendar también parsee el campo `clientSecret` del JSON (un
> `JSON.parse(...).clientSecret` en el `getDeps()` de `integration-handler.ts`).
> Así ambos leen el mismo formato.

### 3.2 Desplegar con los valores por contexto

```bash
cd oli-docs
npm run build:lambdas          # empaqueta los Lambdas (incluye pre-signup-link)
cd infra
npx cdk deploy OliDocs-Auth \
  -c googleClientId='EL-CLIENT-ID.apps.googleusercontent.com' \
  -c hostedUiDomainPrefix='oli-docs-auth' \
  -c googleClientSecretId='oli-docs/google-oauth'
```

Si cambiaste las URLs del front (no localhost), pasa también los
`callbackUrls`/`logoutUrls` reales (hoy están como props del stack con default
localhost — ajústalos en `app.ts` o conviértelos en context).

### 3.3 Anota los outputs

El deploy imprime:

- `UserPoolId`
- `UserPoolClientId`
- `HostedUiDomain` → `<prefix>.auth.<region>.amazoncognito.com`
- `ApiUrl` (del `OliDocs-Api`)

---

## 4. Front — archivo `.env`

Copia `.env.example` a `.env` y rellena con los outputs:

```bash
PUBLIC_API_URL=https://<ApiUrl>            # o http://localhost:3000 en local
PUBLIC_COGNITO_DOMAIN=oli-docs-auth.auth.us-east-1.amazoncognito.com
PUBLIC_COGNITO_CLIENT_ID=<UserPoolClientId>
PUBLIC_COGNITO_REDIRECT_URI=http://localhost:4321/auth/callback
```

- `PUBLIC_COGNITO_REDIRECT_URI` debe ser una de las **callbackUrls** del
  UserPoolClient (sección 3.2) y, a su vez, estar servida por el front
  (`/auth/callback`, que ya existe).
- Sin estas tres variables, el front detecta que el login no está configurado y
  **cae al modo maqueta** (el botón lleva a `/`).

---

## 5. Flujo completo, de punta a punta

```
Usuario → /login → "Continuar con Google"
  → loginWithGoogle() arma PKCE y va a Cognito Hosted UI
    → Cognito federa con Google (IdP) → consentimiento Google
      → Google redirige a Cognito (/oauth2/idpresponse)
        → trigger Pre-SignUp vincula la identidad Google con el usuario
          nativo que el admin dio de alta (por email)
        → Cognito redirige al front: /auth/callback?code=...
          → handleCallback() canjea el code por id_token (PKCE) y lo guarda
            como `oli_jwt`
            → api.ts manda `Authorization: Bearer <id_token>` en cada llamada
              → el authorizer JWT del API Gateway valida (audience = client id)
```

Calendar (aparte, per-reviewer, desde Integraciones):

```
Revisor → Integraciones → "Conectar mi Calendar"
  → GET /v1/integrations/google/authorize-url (con su JWT)
    → consentimiento Google (scope calendar.events)
      → Google redirige al backend /v1/integrations/google/callback
        → el backend guarda el refresh token del revisor
```

---

## 6. Desajustes conocidos a resolver

1. **Secreto JSON vs crudo** (sección 3.1) — alinear cómo lee el secret el
   flujo de Calendar.
2. **El callback de Calendar responde JSON, no redirect.** Hoy
   `integration-handler.ts` termina con `return ok({ linked: true })`, así que
   el revisor se queda viendo un JSON en vez de volver a la app. El front
   (`IntegrationsView`) espera volver con `?google=linked`. **Resolución:** que
   el callback responda un **302** a `${FRONT_URL}/integraciones?google=linked`
   (y `?google=error` si falla).
3. **Account-linking requiere usuario pre-creado.** El trigger `pre-signup-link`
   sólo vincula si el admin ya dio de alta al revisor (por email). Si entra
   alguien `@bit.lat` sin alta, no se crea solo (`selfSignUpEnabled: false`) y
   verá el error `sin-acceso`. Esto es intencional.
4. **Dominio restringido a BIT.** Para rechazar cuentas no-`@bit.lat`, la
   pantalla de consentimiento *Internal* ya lo cubre; si usas un proyecto
   *External*, hay que validar el dominio del `email` en el trigger.

---

## 7. Checklist rápido

- [ ] Cliente OAuth creado en Google Cloud con los **dos** redirect URIs.
- [ ] Scopes `openid email profile` + `calendar.events` en el consentimiento.
- [ ] Secret en Secrets Manager (`oli-docs/google-oauth`) — formato alineado (#1).
- [ ] `OliDocs-Auth` desplegado con los `-c` de contexto.
- [ ] Outputs anotados (`UserPoolClientId`, `HostedUiDomain`, `ApiUrl`).
- [ ] `.env` del front con los `PUBLIC_COGNITO_*` y `PUBLIC_API_URL`.
- [ ] Un usuario de prueba dado de alta por el admin (para el account-linking).
- [ ] Callback de Calendar devuelto como 302 (#2) si vas a probar Calendar.
