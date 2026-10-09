// Known provider table (ARCHITECTURE.md section 5.2 + section 0). Data-driven: fixing a
// hostname or help link means editing this table only.
import type {
  AuthMethod,
  DiscoveredConfig,
  OAuthProvider,
  ProviderHelp,
  ProviderId,
  ServerEndpoint,
} from './ipc';

export interface KnownProvider {
  key: string; // unique table key
  id: ProviderId;
  name: string;
  /** Exact domains, or 'prefix.*' wildcards (e.g. 'hotmail.*' matches hotmail.co.uk). */
  domains: string[];
  /** MX host suffixes that identify this provider for custom domains. */
  mxSuffixes?: string[];
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  authMethod: AuthMethod;
  oauthProvider: OAuthProvider | null;
  appPasswordHelpUrl: string | null;
  instructions: string;
  notes: string[];
  /** Provider stores a copy of sent mail itself: do not APPEND to Sent. */
  savesSentCopy: boolean;
  /** Folder roles that duplicate everything and are not synced by default. */
  skipSyncRoles: ('all' | 'flagged')[];
}

const GMAIL_NOTES = [
  'App passwords only work when 2-Step Verification is turned on for your Google account.',
  'If this is a work or school (Google Workspace) account, your admin may block app passwords.',
];

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    key: 'gmail',
    id: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://myaccount.google.com/apppasswords',
    instructions:
      'Gmail needs an app password. Create one in your Google account, then paste it here instead of your normal password. Spaces in the code are fine.',
    notes: GMAIL_NOTES,
    savesSentCopy: true,
    skipSyncRoles: ['all', 'flagged'],
  },
  {
    key: 'google-workspace',
    id: 'gmail',
    name: 'Google Workspace',
    domains: [],
    mxSuffixes: ['aspmx.l.google.com', '.googlemail.com', '.google.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://myaccount.google.com/apppasswords',
    instructions:
      'This address uses Google Workspace. Create an app password in your Google account and paste it here. Spaces in the code are fine.',
    notes: GMAIL_NOTES,
    savesSentCopy: true,
    skipSyncRoles: ['all', 'flagged'],
  },
  {
    key: 'outlook',
    id: 'outlook',
    name: 'Outlook.com',
    domains: ['outlook.com', 'outlook.*', 'hotmail.*', 'live.*', 'msn.com', 'windowslive.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    authMethod: 'microsoft-oauth',
    oauthProvider: 'microsoft',
    appPasswordHelpUrl: null,
    instructions:
      'Microsoft does not allow passwords for this kind of account. Use "Sign in with Microsoft".',
    notes: [],
    savesSentCopy: true,
    skipSyncRoles: [],
  },
  {
    key: 'microsoft-365',
    id: 'outlook',
    name: 'Microsoft 365',
    domains: [],
    mxSuffixes: ['.mail.protection.outlook.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    authMethod: 'microsoft-oauth',
    oauthProvider: 'microsoft',
    appPasswordHelpUrl: null,
    instructions: 'This address uses Microsoft 365. Use "Sign in with Microsoft".',
    notes: ['Your organization admin must allow IMAP and authenticated SMTP for your mailbox.'],
    savesSentCopy: true,
    skipSyncRoles: [],
  },
  {
    key: 'icloud',
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://support.apple.com/102654',
    instructions:
      'iCloud needs an app-specific password. Create one on appleid.apple.com, then paste it here.',
    notes: [
      'Your Apple ID needs two-factor authentication turned on to create app-specific passwords.',
    ],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'yahoo',
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.*', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    instructions:
      'Yahoo needs an app password. Create one in your Yahoo account security page, then paste it here.',
    notes: [],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'aol',
    id: 'yahoo',
    name: 'AOL Mail',
    domains: ['aol.com'],
    imap: { host: 'imap.aol.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://help.aol.com/articles/Create-and-manage-app-password',
    instructions:
      'AOL needs an app password. Create one in your AOL account security page, then paste it here.',
    notes: [],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'fastmail',
    id: 'generic',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imap: { host: 'imap.fastmail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    instructions:
      'Fastmail needs an app password. Create one in Settings > Privacy & Security, then paste it here.',
    notes: [],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'gmx',
    id: 'generic',
    name: 'GMX',
    domains: ['gmx.*'],
    imap: { host: 'imap.gmx.com', port: 993, security: 'ssl' },
    smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' },
    authMethod: 'password',
    oauthProvider: null,
    appPasswordHelpUrl: null,
    instructions: 'Use your normal GMX password.',
    notes: [
      'In GMX settings, turn on "Allow access to this account via external programs (POP3/IMAP)".',
    ],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'mailcom',
    id: 'generic',
    name: 'mail.com',
    domains: ['mail.com'],
    imap: { host: 'imap.mail.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.mail.com', port: 587, security: 'starttls' },
    authMethod: 'password',
    oauthProvider: null,
    appPasswordHelpUrl: null,
    instructions: 'Use your normal mail.com password.',
    notes: ['In mail.com settings, turn on IMAP access.'],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
  {
    key: 'zoho',
    id: 'generic',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'ssl' },
    authMethod: 'app-password',
    oauthProvider: null,
    appPasswordHelpUrl:
      'https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html',
    instructions:
      'If you use two-factor authentication, create an app password in Zoho, then paste it here.',
    notes: ['Turn on IMAP access in Zoho Mail settings.'],
    savesSentCopy: false,
    skipSyncRoles: [],
  },
];

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
}

export function domainMatches(pattern: string, domain: string): boolean {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return domain.startsWith(prefix + '.') && domain.length > prefix.length + 1;
  }
  return pattern === domain;
}

export function findProviderByDomain(domain: string): KnownProvider | null {
  const d = domain.trim().toLowerCase();
  for (const p of KNOWN_PROVIDERS) {
    if (p.domains.some((pat) => domainMatches(pat, d))) return p;
  }
  return null;
}

export function findProviderByMx(mxHosts: string[]): KnownProvider | null {
  const hosts = mxHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  for (const p of KNOWN_PROVIDERS) {
    if (!p.mxSuffixes) continue;
    if (hosts.some((h) => p.mxSuffixes!.some((s) => h === s.replace(/^\./, '') || h.endsWith(s))))
      return p;
  }
  return null;
}

/** Look up by provider key; used to read per-provider flags for a stored account. */
export function findProviderByHost(imapHost: string): KnownProvider | null {
  return KNOWN_PROVIDERS.find((p) => p.imap.host === imapHost.toLowerCase()) ?? null;
}

export function genericHelp(): ProviderHelp {
  return {
    providerName: 'Your mail provider',
    authMethod: 'password',
    appPasswordHelpUrl: null,
    instructions:
      'Enter your email password. If your provider uses two-step sign-in, create an app password in your account settings and use that instead.',
    notes: [],
  };
}

export function helpFor(p: KnownProvider): ProviderHelp {
  return {
    providerName: p.name,
    authMethod: p.authMethod,
    appPasswordHelpUrl: p.appPasswordHelpUrl,
    instructions: p.instructions,
    notes: p.notes,
  };
}

/** Replace %EMAILADDRESS% / %EMAILLOCALPART% / %EMAILDOMAIN% (case-insensitive) with parts of the email. */
export function substituteEmailPlaceholders(template: string, email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf('@');
  const local = at >= 0 ? e.slice(0, at) : e;
  const domain = at >= 0 ? e.slice(at + 1) : '';
  return template
    .replace(/%EMAILADDRESS%/gi, () => e)
    .replace(/%EMAILLOCALPART%/gi, () => local)
    .replace(/%EMAILDOMAIN%/gi, () => domain);
}

export function hasEmailPlaceholder(s: string): boolean {
  return /%EMAIL(ADDRESS|LOCALPART|DOMAIN)%/i.test(s);
}

/** The login name to use: substituted, never a raw placeholder; falls back to the email. */
export function resolveUsername(username: string, email: string): string {
  const u = substituteEmailPlaceholders(username.trim(), email).trim();
  return u || email.trim();
}

export function configFromProvider(
  p: KnownProvider,
  source: DiscoveredConfig['source'],
  email: string,
): DiscoveredConfig {
  const oauth = p.authMethod === 'microsoft-oauth';
  return {
    provider: p.id,
    imap: p.imap,
    smtp: p.smtp,
    usernameTemplate: substituteEmailPlaceholders('%EMAILADDRESS%', email),
    suggestedAuth: oauth ? 'oauth2' : 'password',
    oauthProvider: p.oauthProvider,
    oauthRequired: oauth,
    appPasswordHelpUrl: p.appPasswordHelpUrl,
    help: helpFor(p),
    source,
  };
}
