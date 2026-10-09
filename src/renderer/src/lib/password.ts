import { findProviderByHost } from '../../../shared/providers';

/** App passwords never contain spaces (Google shows them in groups of four), so strip all whitespace. */
export function cleanPassword(password: string, appPassword: boolean): string {
  return appPassword ? password.replace(/\s+/g, '') : password;
}

/** True when the IMAP host belongs to a known provider that signs in with an app password. */
export function isAppPasswordProvider(imapHost: string): boolean {
  return findProviderByHost(imapHost)?.authMethod === 'app-password';
}
