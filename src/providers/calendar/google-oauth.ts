import { UpstreamError } from '../../lib/errors.js';

/**
 * Google OAuth 2.0 helper: builds the consent URL and exchanges codes/refresh
 * tokens for access tokens (R6.8). Transport is injectable for tests.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleOAuth {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Build the consent URL. `state` carries the reviewer id through the flow. */
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /** Exchange an authorization code for tokens; returns the refresh token. */
  async exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string }> {
    const json = await this.tokenRequest({
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri,
    });
    if (!json.refresh_token) {
      throw new UpstreamError('Google', 'No refresh_token returned from token exchange');
    }
    return { refreshToken: json.refresh_token, accessToken: json.access_token ?? '' };
  }

  /** Exchange a refresh token for a fresh access token. */
  async refreshAccessToken(refreshToken: string): Promise<string> {
    const json = await this.tokenRequest({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!json.access_token) {
      throw new UpstreamError('Google', 'No access_token returned from refresh');
    }
    return json.access_token;
  }

  private async tokenRequest(
    extra: Record<string, string>,
  ): Promise<{ access_token?: string; refresh_token?: string }> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      ...extra,
    });
    try {
      const res = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { access_token?: string; refresh_token?: string };
    } catch (err) {
      throw new UpstreamError('Google', err instanceof Error ? err.message : String(err));
    }
  }
}
