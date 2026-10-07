/**
 * Lambda entry point for the Cognito Pre-SignUp account-linking trigger.
 * Links a reviewer's Google identity to the native user the admin pre-created.
 */
export { handler } from '../../auth/pre-signup-link.js';
