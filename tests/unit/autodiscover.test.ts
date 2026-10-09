import { describe, expect, it } from 'vitest';
import {
  autoconfigUrls,
  discoverConfig,
  isValidEmail,
  parseAutoconfigXml,
  type DiscoverDeps,
} from '../../src/engine/accounts/autodiscover';
import { domainMatches, findProviderByDomain, findProviderByMx } from '../../src/shared/providers';

const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <incomingServer type="pop3">
      <hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>plain</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>mail.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function deps(over: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return {
    fetchText: async () => null,
    resolveMx: async () => {
      throw new Error('no mx');
    },
    ...over,
  };
}

describe('parseAutoconfigXml', () => {
  it('picks the first secure IMAP server, ignores plain sockets, substitutes placeholders', () => {
    const r = parseAutoconfigXml(XML, 'bob@example.org');
    expect(r).toEqual({
      imap: { host: 'mail.example.org', port: 993, security: 'ssl' },
      smtp: { host: 'smtp.example.org', port: 587, security: 'starttls' },
      username: 'bob',
    });
  });

  it('returns null for garbage, missing servers, or only plain sockets', () => {
    expect(parseAutoconfigXml('not xml at all <<<', 'a@b.co')).toBeNull();
    expect(parseAutoconfigXml('<clientConfig></clientConfig>', 'a@b.co')).toBeNull();
    const plainOnly = XML.replace(/SSL/g, 'plain').replace(/STARTTLS/g, 'plain');
    expect(parseAutoconfigXml(plainOnly, 'a@b.co')).toBeNull();
  });
});

describe('provider table', () => {
  it('matches exact and wildcard domains', () => {
    expect(domainMatches('hotmail.*', 'hotmail.co.uk')).toBe(true);
    expect(domainMatches('hotmail.*', 'nothotmail.com')).toBe(false);
    expect(findProviderByDomain('gmail.com')?.key).toBe('gmail');
    expect(findProviderByDomain('hotmail.it')?.key).toBe('outlook');
    expect(findProviderByDomain('yahoo.co.jp')?.key).toBe('yahoo');
    expect(findProviderByDomain('me.com')?.key).toBe('icloud');
    expect(findProviderByDomain('unknown-domain.xyz')).toBeNull();
  });

  it('recognises Microsoft 365 and Google Workspace by MX', () => {
    expect(findProviderByMx(['acme-com.mail.protection.outlook.com.'])?.key).toBe('microsoft-365');
    expect(findProviderByMx(['aspmx.l.google.com'])?.key).toBe('google-workspace');
    expect(findProviderByMx(['mx.example.net'])).toBeNull();
  });
});

describe('discoverConfig', () => {
  it('returns Gmail with app-password guidance and the 2-Step Verification note', async () => {
    const c = await discoverConfig('Someone@Gmail.com', deps());
    expect(c?.source).toBe('known');
    expect(c?.imap).toEqual({ host: 'imap.gmail.com', port: 993, security: 'ssl' });
    expect(c?.help.authMethod).toBe('app-password');
    expect(c?.appPasswordHelpUrl).toMatch(/^https:\/\//);
    expect(c?.help.notes.join(' ')).toMatch(/2-Step Verification/);
    expect(c?.suggestedAuth).toBe('password');
  });

  it('returns Microsoft OAuth guidance for Outlook.com', async () => {
    const c = await discoverConfig('x@outlook.com', deps());
    expect(c?.oauthRequired).toBe(true);
    expect(c?.oauthProvider).toBe('microsoft');
    expect(c?.suggestedAuth).toBe('oauth2');
    expect(c?.help.authMethod).toBe('microsoft-oauth');
    expect(c?.appPasswordHelpUrl).toBeNull();
  });

  it('uses autoconfig for unknown domains, trying URLs in order, HTTPS only', async () => {
    const asked: string[] = [];
    const c = await discoverConfig(
      'bob@example.org',
      deps({
        fetchText: async (url) => {
          asked.push(url);
          return url.includes('thunderbird') ? XML : null;
        },
      }),
    );
    expect(asked).toEqual(autoconfigUrls('bob@example.org'));
    expect(asked.every((u) => u.startsWith('https://'))).toBe(true);
    expect(c?.source).toBe('autoconfig');
    expect(c?.usernameTemplate).toBe('bob');
    expect(c?.help.authMethod).toBe('password');
  });

  it('falls back to MX hints, then to null (manual)', async () => {
    const mx = await discoverConfig(
      'a@acme.example',
      deps({ resolveMx: async () => ['acme-example.mail.protection.outlook.com'] }),
    );
    expect(mx?.source).toBe('mx');
    expect(mx?.smtp.host).toBe('smtp.office365.com');
    expect(await discoverConfig('a@acme.example', deps())).toBeNull();
  });

  it('maps a custom domain hosted on a known provider (by IMAP host) to its guidance', async () => {
    const m365 = XML.replace(/mail\.%EMAILDOMAIN%/, 'outlook.office365.com');
    const c = await discoverConfig('a@corp.example', deps({ fetchText: async () => m365 }));
    expect(c?.help.authMethod).toBe('microsoft-oauth');
    expect(c?.source).toBe('autoconfig');
  });

  it('rejects invalid addresses', async () => {
    expect(isValidEmail('nope')).toBe(false);
    await expect(discoverConfig('nope', deps())).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT' },
    });
  });
});

describe('discoverConfig returns a substituted username', () => {
  it.each(['gmail.com', 'yahoo.com', 'icloud.com', 'outlook.com'])(
    'known provider %s: username is the real address, not a placeholder',
    async (domain) => {
      const email = `Jane.Doe@${domain}`;
      const cfg = await discoverConfig(email, deps());
      expect(cfg).not.toBeNull();
      expect(cfg!.usernameTemplate).toBe(email);
      expect(cfg!.usernameTemplate).not.toMatch(/%/);
    },
  );

  it('MX-hint path substitutes too', async () => {
    const cfg = await discoverConfig('bob@custom-domain.test', {
      fetchText: async () => null,
      resolveMx: async () => ['aspmx.l.google.com'],
    });
    expect(cfg?.source).toBe('mx');
    expect(cfg?.usernameTemplate).toBe('bob@custom-domain.test');
  });

  it('autoconfig path hosted by a known provider substitutes too', async () => {
    const xml = XML.replace(/mail\.%EMAILDOMAIN%/, 'imap.gmail.com');
    const cfg = await discoverConfig('bob@example.org', deps({ fetchText: async () => xml }));
    expect(cfg?.usernameTemplate).not.toMatch(/%/);
  });
});
