// Server autodiscovery (ARCHITECTURE.md section 5.2):
// known table -> Mozilla autoconfig / ISPDB -> MX hint -> manual (config: null).
import { XMLParser } from 'fast-xml-parser';
import type { DiscoveredConfig, Security, ServerEndpoint } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import {
  configFromProvider,
  domainOf,
  findProviderByDomain,
  findProviderByHost,
  findProviderByMx,
  genericHelp,
  substituteEmailPlaceholders,
} from '../../shared/providers';

export interface AutoconfigResult {
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  username: string; // placeholders already substituted
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

function substitute(template: string, email: string): string {
  return substituteEmailPlaceholders(template, email);
}

function socketToSecurity(v: unknown): Security | null {
  const s = String(v ?? '').toUpperCase();
  if (s === 'SSL') return 'ssl';
  if (s === 'STARTTLS') return 'starttls';
  return null; // plain sockets are ignored
}

interface XmlServer {
  '@_type'?: string;
  hostname?: string;
  port?: number | string;
  socketType?: string;
  username?: string;
}

/** Parse a Mozilla autoconfig config-v1.1.xml document. Returns null if unusable. */
export function parseAutoconfigXml(xml: string, email: string): AutoconfigResult | null {
  let doc: unknown;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === 'incomingServer' || name === 'outgoingServer',
      processEntities: false,
    }).parse(xml);
  } catch {
    return null;
  }
  const provider = (doc as { clientConfig?: { emailProvider?: Record<string, unknown> } })
    ?.clientConfig?.emailProvider;
  if (!provider) return null;
  const incoming = (provider.incomingServer as XmlServer[] | undefined) ?? [];
  const outgoing = (provider.outgoingServer as XmlServer[] | undefined) ?? [];

  const pick = (list: XmlServer[], type: string) => {
    for (const s of list) {
      if (s['@_type'] !== type || !s.hostname) continue;
      const security = socketToSecurity(s.socketType);
      const port = Number(s.port);
      if (!security || !Number.isInteger(port) || port <= 0) continue;
      return { s, endpoint: { host: substitute(String(s.hostname), email), port, security } };
    }
    return null;
  };
  const imap = pick(incoming, 'imap');
  const smtp = pick(outgoing, 'smtp');
  if (!imap || !smtp) return null;
  return {
    imap: imap.endpoint,
    smtp: smtp.endpoint,
    username: substitute(String(imap.s.username ?? '%EMAILADDRESS%'), email),
  };
}

export interface DiscoverDeps {
  /** GET text over HTTPS; returns null on any failure / non-200 / oversize. */
  fetchText: (url: string) => Promise<string | null>;
  resolveMx: (domain: string) => Promise<string[]>;
}

export function autoconfigUrls(email: string): string[] {
  const domain = domainOf(email);
  const q = encodeURIComponent(email);
  return [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${q}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
}

export async function discoverConfig(
  rawEmail: string,
  deps: DiscoverDeps,
): Promise<DiscoveredConfig | null> {
  const email = rawEmail.trim();
  if (!isValidEmail(email)) throw new AppException('INVALID_INPUT', 'Enter a valid email address.');
  const domain = domainOf(email);

  // 1. Known providers (no network).
  const known = findProviderByDomain(domain);
  if (known) return configFromProvider(known, 'known', email);

  // 2. Autoconfig / ISPDB.
  for (const url of autoconfigUrls(email)) {
    const xml = await deps.fetchText(url);
    if (!xml) continue;
    const parsed = parseAutoconfigXml(xml, email);
    if (!parsed) continue;
    const byHost = findProviderByHost(parsed.imap.host);
    if (byHost) {
      // Custom domain hosted by a known provider (e.g. Microsoft 365): use its guidance.
      return { ...configFromProvider(byHost, 'autoconfig', email), imap: parsed.imap, smtp: parsed.smtp };
    }
    return {
      provider: 'generic',
      imap: parsed.imap,
      smtp: parsed.smtp,
      usernameTemplate: parsed.username,
      suggestedAuth: 'password',
      oauthProvider: null,
      oauthRequired: false,
      appPasswordHelpUrl: null,
      help: genericHelp(),
      source: 'autoconfig',
    };
  }

  // 3. MX hint (custom domain hosted at Google / Microsoft).
  try {
    const mx = await deps.resolveMx(domain);
    const hit = findProviderByMx(mx);
    if (hit) return configFromProvider(hit, 'mx', email);
  } catch {
    /* no MX info: fall through to manual */
  }

  // 4. Manual entry (the UI pre-fills nothing).
  return null;
}

// ---------- real network deps ----------

export function makeNetworkDeps(timeoutMs = 4000, maxBytes = 256 * 1024): DiscoverDeps {
  return {
    async fetchText(url) {
      if (!url.startsWith('https://')) return null; // HTTPS only
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok || !res.body) return null;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            ctrl.abort();
            return null;
          }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async resolveMx(domain) {
      const { resolveMx } = await import('node:dns/promises');
      const records = await Promise.race([
        resolveMx(domain),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mx timeout')), timeoutMs)),
      ]);
      return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    },
  };
}
