// PKCE (RFC 7636) helpers and random values for OAuth.
import { createHash, randomBytes } from 'node:crypto';

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: 43 characters. */
export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 code challenge. */
export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function randomToken(bytes = 16): string {
  return base64url(randomBytes(bytes));
}
