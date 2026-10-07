import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { getConfig } from '../../lib/config.js';
import { ValidationError, ForbiddenError, UpstreamError, NotFoundError } from '../../lib/errors.js';
import { SecretsManagerReader } from '../../providers/secrets.js';
import { GoogleOAuth } from '../../providers/calendar/google-oauth.js';
import { SecretsOAuthTokenStore } from '../../providers/calendar/token-store.js';
import type { OAuthTokenStore } from '../../providers/calendar/token-store.js';
import { getAuthContext } from '../auth/context.js';
import { requireAuth } from '../auth/guards.js';
import { ok, noContent, redirect, errorResponse } from './response.js';

export interface IntegrationHandlerDeps {
  oauth: GoogleOAuth;
  tokenStore: OAuthTokenStore;
}

let cached: IntegrationHandlerDeps | null = null;

async function getDeps(): Promise<IntegrationHandlerDeps> {
  if (cached) return cached;
  const cfg = getConfig();
  const secrets = new SecretsManagerReader({ region: cfg.region });
  const clientSecret = cfg.googleClientSecretId
    ? parseClientSecret(await secrets.getSecret(cfg.googleClientSecretId))
    : '';
  cached = {
    oauth: new GoogleOAuth({
      clientId: cfg.googleClientId,
      clientSecret,
      redirectUri: cfg.googleRedirectUri,
    }),
    tokenStore: new SecretsOAuthTokenStore('oli-docs/google-oauth', { region: cfg.region }),
  };
  return cached;
}

/** For tests: inject deps and reset the cache. */
export function __setDeps(deps: IntegrationHandlerDeps | null): void {
  cached = deps;
}

/**
 * Routes for a reviewer to link/unlink their Google Calendar (R6.8):
 *   GET    /v1/integrations/google/authorize-url  → consent URL
 *   GET    /v1/integrations/google/callback        → exchange code, store token
 *   DELETE /v1/integrations/google                 → unlink (delete token)
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { oauth, tokenStore } = await getDeps();
    const method = event.requestContext.http.method;
    const path = event.requestContext.http.path;

    if (method === 'GET' && path.endsWith('/authorize-url')) {
      // Reviewer-initiated: must be authenticated.
      const ctx = getAuthContext(event);
      requireAuth(ctx);
      // Generate an unguessable, single-use state bound server-side to this
      // reviewer (CSRF defence). The callback verifies it against the store
      // rather than trusting a predictable value.
      const state = randomUUID();
      await tokenStore.saveState(state, ctx.userId);
      const url = oauth.buildAuthorizeUrl(state);
      return ok({ authorizeUrl: url });
    }

    if (method === 'GET' && path.endsWith('/callback')) {
      // NOTE: this route is NOT behind requireAuth — it is reached via a
      // browser redirect from Google that carries no JWT. Identity comes from
      // the single-use `state` consumed below. The infra must expose this
      // route without the JWT authorizer.
      // Google returns error/error_description when the user denies consent.
      const oauthError = event.queryStringParameters?.error;
      if (oauthError) {
        // The user denied consent (or Google errored). Return them to the app
        // with a flag rather than showing a raw error page.
        return redirect(`${getConfig().frontUrl}/integraciones?google=error`);
      }

      const code = event.queryStringParameters?.code;
      const state = event.queryStringParameters?.state;
      if (!code) {
        throw new ValidationError('Missing authorization code', [
          { field: 'code', issue: 'required' },
        ]);
      }
      if (!state) {
        throw new ValidationError('Missing OAuth state', [
          { field: 'state', issue: 'required' },
        ]);
      }

      // The reviewer is identified by the server-side state binding, NOT by the
      // request principal — a browser redirect from Google won't carry the JWT.
      const reviewerId = await tokenStore.consumeState(state);
      if (!reviewerId) {
        throw new ForbiddenError('Invalid or expired OAuth state');
      }

      const { refreshToken } = await oauth.exchangeCode(code);
      await tokenStore.saveRefreshToken(reviewerId, refreshToken);
      // Browser-reached route: send the reviewer back to the app, not JSON.
      return redirect(`${getConfig().frontUrl}/integraciones?google=linked`);
    }

    if (method === 'DELETE' && path.endsWith('/integrations/google')) {
      // Reviewer-initiated: must be authenticated.
      const ctx = getAuthContext(event);
      requireAuth(ctx);
      await tokenStore.deleteRefreshToken(ctx.userId);
      return noContent();
    }

    return errorResponse(new NotFoundError('Route', `${method} ${path}`));
  } catch (err) {
    return errorResponse(err);
  }
}


/**
 * The Google client secret is stored in Secrets Manager as JSON
 * (`{"clientSecret":"..."}`), the same shape the AuthStack consumes. Older
 * deployments may have stored it as a raw string, so fall back to the raw value
 * if it is not JSON.
 */
function parseClientSecret(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { clientSecret?: string };
    return parsed.clientSecret ?? raw;
  } catch {
    return raw;
  }
}
