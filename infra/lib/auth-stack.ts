import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { createNodeLambda } from './lambda-factory.js';

export interface AuthStackProps extends cdk.StackProps {
  /**
   * Google OAuth client id for the "Sign in with Google" IdP. Defaults to a
   * CDK context value (`-c googleClientId=...`) so it is not hardcoded.
   */
  googleClientId?: string;
  /**
   * Secrets Manager secret name/arn holding the Google OAuth client secret.
   * The same secret backs the Calendar OAuth flow (see integration-handler).
   */
  googleClientSecretId?: string;
  /**
   * Allowed callback URLs for the Hosted UI OAuth code flow (the frontend).
   * Defaults to localhost for development.
   */
  callbackUrls?: string[];
  logoutUrls?: string[];
  /** Prefix for the Cognito Hosted UI domain (must be globally unique). */
  hostedUiDomainPrefix?: string;
}

/**
 * Authentication for Oli's Docs.
 *
 * Login is "Sign in with Google" federated through Cognito (R10): the reviewer
 * authenticates with their BIT Google Workspace account and Cognito issues the
 * JWT the API Gateway authorizer validates. Role-based access uses the
 * `admin` / `revisor` groups surfaced in the `cognito:groups` claim.
 *
 * NOTE on Calendar: this IdP only establishes identity (scopes openid/email/
 * profile). The `calendar.events` scope + refresh token are obtained by the
 * separate OAuth flow already implemented in integration-handler.ts, so the
 * reviewer grants Calendar access once, on first use.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: AuthStackProps) {
    super(scope, id, props);

    const googleClientId =
      props?.googleClientId ?? (this.node.tryGetContext('googleClientId') as string | undefined);
    const googleClientSecretId =
      props?.googleClientSecretId ??
      (this.node.tryGetContext('googleClientSecretId') as string | undefined) ??
      'oli-docs/google-oauth';
    const callbackUrls = props?.callbackUrls ?? ['http://localhost:4321/auth/callback'];
    const logoutUrls = props?.logoutUrls ?? ['http://localhost:4321/'];
    const hostedUiDomainPrefix =
      props?.hostedUiDomainPrefix ??
      (this.node.tryGetContext('hostedUiDomainPrefix') as string | undefined) ??
      'oli-docs-auth';

    // --- Pre-signup account-linking trigger ---------------------------------
    // When a reviewer the admin pre-created (a native Cognito user keyed by
    // email) signs in with Google for the first time, Cognito would otherwise
    // create a SEPARATE federated identity. This trigger links the Google
    // identity to the existing native user so "give Alan access" and "Alan
    // signs in with Google" resolve to the same principal, preserving his
    // group membership (admin/revisor).
    const preSignUpFn = createNodeLambda(this, {
      name: 'pre-signup-link',
      timeout: cdk.Duration.seconds(10),
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      lambdaTriggers: {
        preSignUp: preSignUpFn,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The trigger links identities via the admin API, so it needs permission
    // to look up and link users on this very pool.
    preSignUpFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminLinkProviderForUser',
          'cognito-idp:ListUsers',
        ],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // --- Google as identity provider ----------------------------------------
    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      clientId: googleClientId ?? 'REPLACE_VIA_CONTEXT',
      clientSecretValue: cdk.SecretValue.secretsManager(googleClientSecretId, {
        jsonField: 'clientSecret',
      }),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    // --- Groups for role-based access ---------------------------------------
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Administrators',
    });

    new cognito.CfnUserPoolGroup(this, 'ReviewerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'revisor',
      description: 'Document reviewers',
    });

    // --- Hosted UI domain (the "Sign in with Google" page) ------------------
    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: hostedUiDomainPrefix },
    });

    // --- App client (OAuth authorization-code flow via Google) --------------
    this.userPoolClient = this.userPool.addClient('AppClient', {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      generateSecret: false, // public SPA client (PKCE)
    });

    // Ensure the client is created after the Google IdP so the supported
    // provider reference resolves.
    this.userPoolClient.node.addDependency(googleProvider);

    // --- Outputs the frontend / backend need --------------------------------
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'HostedUiDomain', {
      value: `${hostedUiDomainPrefix}.auth.${this.region}.amazoncognito.com`,
    });
  }
}
