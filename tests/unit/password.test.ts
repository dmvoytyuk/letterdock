import { describe, expect, it } from 'vitest';
import { cleanPassword, isAppPasswordProvider } from '../../src/renderer/src/lib/password';
import { mapNetworkError } from '../../src/engine/imap/errors';

describe('cleanPassword', () => {
  it('strips all whitespace for app-password providers', () => {
    expect(cleanPassword(' abcd efgh\tijkl  mnop\n', true)).toBe('abcdefghijklmnop');
  });
  it('leaves other passwords untouched', () => {
    expect(cleanPassword('my pass word ', false)).toBe('my pass word ');
  });
  it('detects app-password providers by IMAP host', () => {
    expect(isAppPasswordProvider('imap.gmail.com')).toBe(true);
    expect(isAppPasswordProvider('imap.gmx.com')).toBe(false);
    expect(isAppPasswordProvider('mail.example.org')).toBe(false);
  });
});

describe('AUTH_FAILED details', () => {
  it('passes the server reply through without extra data', () => {
    const e = mapNetworkError({
      authenticationFailed: true,
      message: 'Command failed',
      responseText: 'Invalid credentials (Failure)',
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    expect(e.code).toBe('AUTH_FAILED');
    expect(e.details).toBe('[AUTHENTICATIONFAILED] Invalid credentials (Failure) | Command failed');
  });
});
