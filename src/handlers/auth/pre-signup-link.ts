import {
  CognitoIdentityProviderClient,
  AdminLinkProviderForUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';
import { logger } from '../../lib/logger.js';

/**
 * Cognito Pre-SignUp trigger for external-provider (Google) sign-ups.
 *
 * Reviewers are pre-created by the admin as NATIVE Cognito users keyed by their
 * email. When such a reviewer signs in with Google for the first time, Cognito
 * fires this trigger with `triggerSource = PreSignUp_ExternalProvider`. We look
 * up the existing native user by email and link the Google identity to it with
 * AdminLinkProviderForUser, so both resolve to the same principal and the
 * reviewer keeps their group membership (admin/revisor).
 *
 * If no native user exists for the email, we do nothing (sign-up stays blocked
 * because selfSignUpEnabled is false) — only people the admin provisioned can
 * get in.
 */

const EXTERNAL_PROVIDER_SOURCE = 'PreSignUp_ExternalProvider';
const client = new CognitoIdentityProviderClient({});

/** Parse the `Google_<sub>` userName Cognito uses for a federated sign-in. */
function parseProvider(userName: string): { providerName: string; providerUserId: string } | null {
  const idx = userName.indexOf('_');
  if (idx <= 0) return null;
  const providerName = userName.slice(0, idx);
  const providerUserId = userName.slice(idx + 1);
  if (!providerName || !providerUserId) return null;
  // Normalise the casing Cognito expects for the destination link call.
  return {
    providerName: providerName.toLowerCase() === 'google' ? 'Google' : providerName,
    providerUserId,
  };
}

export const handler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent,
): Promise<PreSignUpTriggerEvent> => {
  if (event.triggerSource !== EXTERNAL_PROVIDER_SOURCE) {
    // Native sign-ups are disabled anyway; nothing to link.
    return event;
  }

  const email = event.request.userAttributes.email;
  const userPoolId = event.userPoolId;
  const provider = parseProvider(event.userName);

  if (!email || !provider) {
    logger.warn('Pre-signup link skipped: missing email or unparseable provider', {
      email: Boolean(email),
      userName: event.userName,
    });
    return event;
  }

  // Find the native user the admin pre-created for this email.
  const found = await client.send(
    new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `email = "${email}"`,
      Limit: 1,
    }),
  );

  const nativeUser = found.Users?.find((u) =>
    // A native user has no external identities; skip any already-federated row.
    (u.Attributes ?? []).every((a) => a.Name !== 'identities'),
  );

  if (!nativeUser?.Username) {
    logger.info('No pre-provisioned user for email; leaving sign-up to Cognito policy', {
      email,
    });
    return event;
  }

  await client.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: nativeUser.Username,
      },
      SourceUser: {
        ProviderName: provider.providerName,
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: provider.providerUserId,
      },
    }),
  );

  logger.info('Linked Google identity to pre-provisioned reviewer', {
    email,
    nativeUsername: nativeUser.Username,
  });

  return event;
};
