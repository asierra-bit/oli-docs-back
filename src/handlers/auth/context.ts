import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { UnauthenticatedError } from '../../lib/errors.js';
import { UserRole, type UserRole as UserRoleType } from '../../domain/enums.js';

/**
 * The authenticated principal resolved from the API Gateway JWT authorizer.
 *
 * The HTTP API JWT authorizer validates the Cognito token signature and
 * expiry before invoking the Lambda, so handlers only need to read the
 * verified claims from the event's authorizer context (R10.1–10.3).
 */
export interface AuthContext {
  userId: string;
  email?: string;
  roles: UserRoleType[];
}

/** Cognito places group membership in the `cognito:groups` claim. */
const GROUPS_CLAIM = 'cognito:groups';
const SUBJECT_CLAIM = 'sub';
const EMAIL_CLAIM = 'email';

/**
 * Normalise the `cognito:groups` claim, which may arrive as an array,
 * a comma/space separated string, or a bracketed string depending on the
 * API Gateway payload version.
 */
function parseGroups(raw: unknown): UserRoleType[] {
  if (raw == null) return [];

  let tokens: string[];
  if (Array.isArray(raw)) {
    tokens = raw.map((x) => String(x));
  } else {
    tokens = String(raw)
      .replace(/^\[|\]$/g, '') // strip surrounding brackets if present
      .split(/[,\s]+/);
  }

  const known = new Set<string>([UserRole.ADMIN, UserRole.REVIEWER]);
  return tokens
    .map((t) => t.trim())
    .filter((t) => known.has(t)) as UserRoleType[];
}

/**
 * Extract the authenticated principal from an HTTP API event.
 * Throws UnauthenticatedError if no verified subject is present (R10.3).
 */
export function getAuthContext(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): AuthContext {
  const claims = event.requestContext?.authorizer?.jwt?.claims as
    | Record<string, unknown>
    | undefined;

  const userId = claims?.[SUBJECT_CLAIM];
  if (!claims || typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthenticatedError();
  }

  const email = typeof claims[EMAIL_CLAIM] === 'string' ? (claims[EMAIL_CLAIM] as string) : undefined;

  return {
    userId,
    email,
    roles: parseGroups(claims[GROUPS_CLAIM]),
  };
}

/** Convenience: does the principal hold a given role? */
export function hasRole(ctx: AuthContext, role: UserRoleType): boolean {
  return ctx.roles.includes(role);
}
