#!/usr/bin/env node
/**
 * Local HTTP runner for Oli's Docs — no API Gateway, no Cognito.
 *
 * Routes incoming requests to the SAME Lambda handlers used in production by
 * synthesising the APIGatewayProxyEventV2 shape they expect, including a
 * verified-JWT authorizer context. The principal is faked from env
 * (LOCAL_AUTH_*), so you can exercise the full business flow offline and swap
 * the acting user/role without a real identity provider.
 *
 * This mirrors the routes declared in infra/lib/api-stack.ts. When you add a
 * route there, add it here too.
 *
 * Run:
 *   export $(grep -v '^#' local/.env.local | xargs)
 *   node local/http-runner.mjs            # listens on :3000
 *
 * The handlers are TypeScript; run through a loader (tsx) so no build step is
 * needed:  npx tsx local/http-runner.mjs
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.LOCAL_API_PORT ?? 3000);

// --- Route table: [method, pathTemplate, handlerModule] ---------------------
// Path templates use {param} segments, matched to pathParameters.
const ROUTES = [
  ['POST', '/v1/modules', 'modules'],
  ['GET', '/v1/modules', 'modules'],
  ['GET', '/v1/modules/{id}', 'modules'],
  ['PATCH', '/v1/modules/{id}', 'modules'],
  ['DELETE', '/v1/modules/{id}', 'modules'],

  ['POST', '/v1/reviewers', 'reviewers'],
  ['GET', '/v1/reviewers', 'reviewers'],
  ['GET', '/v1/reviewers/{id}', 'reviewers'],
  ['POST', '/v1/reviewers/{id}/deactivate', 'reviewers'],
  ['GET', '/v1/reviewers/{id}/assignments', 'reviewers'],
  ['POST', '/v1/reviewers/{id}/assignments', 'reviewers'],
  ['PATCH', '/v1/reviewers/{id}/assignments/{moduleId}', 'reviewers'],
  ['DELETE', '/v1/reviewers/{id}/assignments/{moduleId}', 'reviewers'],

  ['POST', '/v1/documents', 'documents'],
  ['GET', '/v1/documents', 'documents'],
  ['GET', '/v1/documents/{id}', 'documents'],
  ['GET', '/v1/documents/{id}/content', 'documents'],
  ['POST', '/v1/documents/{id}/confirm-upload', 'documents'],
  ['PATCH', '/v1/documents/{id}/module', 'documents'],
  ['PATCH', '/v1/documents/{id}/approval-policy', 'documents'],
  ['POST', '/v1/documents/{id}/force-approval', 'documents'],

  ['GET', '/v1/reviews/mine', 'review-records'],
  ['GET', '/v1/review-records/{id}', 'review-records'],
  ['POST', '/v1/review-records/{id}/annotations', 'review-records'],
  ['PUT', '/v1/review-records/{id}/sections/{sectionId}/verdict', 'review-records'],
  ['PUT', '/v1/review-records/{id}/document-verdict', 'review-records'],
  ['POST', '/v1/review-records/{id}/submit', 'review-records'],
  ['POST', '/v1/review-records/{id}/reopen', 'review-records'],

  ['GET', '/v1/integrations/google/authorize-url', 'integrations'],
  ['GET', '/v1/integrations/google/callback', 'integrations'],
  ['DELETE', '/v1/integrations/google', 'integrations'],
];

const handlerCache = new Map();
async function loadHandler(name) {
  if (handlerCache.has(name)) return handlerCache.get(name);
  const mod = await import(`../src/handlers/lambdas/${name}/index.ts`);
  handlerCache.set(name, mod.handler);
  return mod.handler;
}

/** Try to match a concrete path against a `/a/{id}/b` template. */
function matchTemplate(template, path) {
  const t = template.split('/').filter(Boolean);
  const p = path.split('/').filter(Boolean);
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{') && t[i].endsWith('}')) {
      params[t[i].slice(1, -1)] = decodeURIComponent(p[i]);
    } else if (t[i] !== p[i]) {
      return null;
    }
  }
  return params;
}

function resolveRoute(method, path) {
  for (const [m, template, handler] of ROUTES) {
    if (m !== method) continue;
    const params = matchTemplate(template, path);
    if (params) return { handler, params, template };
  }
  return null;
}

/** Build the fake verified-JWT claims from env (the local principal). */
function fakeAuthorizer() {
  const groups = (process.env.LOCAL_AUTH_GROUPS ?? 'admin')
    .split(/[,\s]+/)
    .filter(Boolean);
  return {
    jwt: {
      claims: {
        sub: process.env.LOCAL_AUTH_USER_ID ?? 'admin-local',
        email: process.env.LOCAL_AUTH_EMAIL ?? 'admin@bit.lat',
        'cognito:groups': groups,
      },
      scopes: [],
    },
  };
}

// --- CORS (sólo local) ------------------------------------------------------
// El front de desarrollo corre en otro puerto (Astro en :4321), así que el
// navegador exige CORS para llamar a este runner en :3000. Permitimos el origen
// del front (configurable) y los métodos/headers que usa el cliente.
const ALLOWED_ORIGIN = process.env.LOCAL_CORS_ORIGIN ?? '*';

function corsHeaders() {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
  };
}

const server = http.createServer(async (req, res) => {
  // Preflight: responder de inmediato, sin tocar las rutas.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = resolveRoute(req.method, url.pathname);

  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ error: 'NotFound', message: `No route for ${req.method} ${url.pathname}` }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks).toString('utf-8') : undefined;

  const queryStringParameters = Object.fromEntries(url.searchParams.entries());

  const event = {
    version: '2.0',
    routeKey: `${req.method} ${route.template}`,
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : undefined,
    pathParameters: Object.keys(route.params).length ? route.params : undefined,
    body,
    isBase64Encoded: false,
    requestContext: {
      http: { method: req.method, path: url.pathname },
      authorizer: fakeAuthorizer(),
    },
  };

  try {
    const handler = await loadHandler(route.handler);
    const result = await handler(event);
    const status = result?.statusCode ?? 200;
    const headers = { ...(result?.headers ?? { 'content-type': 'application/json' }), ...corsHeaders() };
    res.writeHead(status, headers);
    res.end(result?.body ?? '');
    console.log(`${req.method} ${url.pathname} → ${status}`);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} → 500`, err);
    res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ error: 'InternalError', message: String(err?.message ?? err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Oli's Docs local API on http://localhost:${PORT}`);
  console.log(`Acting as: ${process.env.LOCAL_AUTH_EMAIL ?? 'admin@bit.lat'} [${process.env.LOCAL_AUTH_GROUPS ?? 'admin'}]`);
  console.log('Swap the principal by changing LOCAL_AUTH_* and restarting.\n');
});
