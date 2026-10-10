import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSettings, OAuthSettings, OAuthSettingsUpdate, QuickReply } from '../shared/ipc';
import { MAX_QUICK_REPLIES, MAX_RECENT_COMMANDS, QUICK_REPLY_NAME_MAX, QUICK_REPLY_TEXT_MAX } from '../shared/ipc';
import { AppException } from '../shared/errors';
import { BUILT_IN_MICROSOFT_CLIENT_ID } from './buildConfig';
import { isValidTenant } from './oauth/microsoft';

export const DEFAULT_SETTINGS: AppSettings = {
  notifications: { enabled: true, mutedAccountIds: [], showPreview: true, sound: true },
  markReadDelayMs: 1500,
  remoteImages: 'block',
  theme: 'system',
  startMinimizedToTray: false,
  closeToTray: false,
  launchAtLogin: false,
  maxBodyCacheMB: 2048,
  imageCacheMaxMb: 500,
  imageCacheMaxAgeDays: 30,
  maxWorkConnectionsPerAccount: 2,
  verboseLogging: false,
  autoUpdateCheck: true,
  undoSendDelayMs: 5000,
  alwaysShowCcBcc: false,
  rememberComposeBounds: true,
  suggestFromAllAccounts: true,
  groupConversations: false,
  shortcutPreset: 'outlook',
  quickReplies: [],
  recentCommands: [],
  snoozeTimes: { morning: '08:00', evening: '18:00', weekendMorning: '09:00' },
  showTrackerNotice: true,
  notifyActions: true,
  notifySnoozeReturn: true,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keeps only valid quick replies (max 50, name 1-40, text 1-2000, unique names and ids). */
export function sanitizeQuickReplies(v: unknown): QuickReply[] {
  if (!Array.isArray(v)) return [];
  const out: QuickReply[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const q of v) {
    if (out.length >= MAX_QUICK_REPLIES) break;
    if (!q || typeof q !== 'object') continue;
    const r = q as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 100) continue;
    if (typeof r.name !== 'string' || typeof r.text !== 'string') continue;
    const name = r.name.trim();
    if (name.length < 1 || name.length > QUICK_REPLY_NAME_MAX) continue;
    if (r.text.length < 1 || r.text.length > QUICK_REPLY_TEXT_MAX) continue;
    const accountId = typeof r.accountId === 'string' && r.accountId ? r.accountId : null;
    if (names.has(name.toLowerCase()) || ids.has(r.id)) continue;
    names.add(name.toLowerCase());
    ids.add(r.id);
    out.push({ id: r.id, name, text: r.text, accountId });
  }
  return out;
}

interface StoredFile {
  app: Partial<AppSettings>;
  oauth: { microsoft: { clientIdOverride: string; tenant: string } };
}

const DEFAULT_OAUTH = { clientIdOverride: '', tenant: 'common' };

/** Merge stored values over defaults; ignores unknown or wrongly-typed keys. */
export function mergeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  const out: AppSettings = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return out;
  const o = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const v = (stored as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const def = DEFAULT_SETTINGS[key];
    if (Array.isArray(def)) {
      if (Array.isArray(v)) o[key] = v; // elements are checked below
    } else if (def !== null && typeof def === 'object') {
      if (v && typeof v === 'object' && !Array.isArray(v)) o[key] = { ...def, ...v };
    } else if (typeof v === typeof def) {
      o[key] = v;
    }
  }
  if (out.shortcutPreset !== 'gmail') out.shortcutPreset = 'outlook'; // only the two known styles
  out.quickReplies = sanitizeQuickReplies(out.quickReplies);
  out.recentCommands = (Array.isArray(out.recentCommands) ? out.recentCommands : [])
    .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 100)
    .slice(0, MAX_RECENT_COMMANDS);
  for (const k of ['morning', 'evening', 'weekendMorning'] as const) {
    if (typeof out.snoozeTimes[k] !== 'string' || !HHMM.test(out.snoozeTimes[k])) {
      out.snoozeTimes[k] = DEFAULT_SETTINGS.snoozeTimes[k];
    }
  }
  return out;
}

/** Non-secret settings in settings.json. */
export class SettingsStore {
  private file: StoredFile;

  constructor(private readonly path: string) {
    let raw: Partial<StoredFile> = {};
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredFile>;
    } catch {
      /* first run or unreadable: defaults */
    }
    this.file = {
      app: mergeSettings(raw.app),
      oauth: { microsoft: { ...DEFAULT_OAUTH, ...(raw.oauth?.microsoft ?? {}) } },
    };
  }

  get(): AppSettings {
    return structuredClone(this.file.app) as AppSettings;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.file.app = mergeSettings({ ...this.file.app, ...patch });
    this.save();
    return this.get();
  }

  getOAuth(): OAuthSettings {
    const m = this.file.oauth.microsoft;
    const override = m.clientIdOverride.trim();
    return {
      microsoft: {
        clientIdOverride: override,
        builtInClientId: BUILT_IN_MICROSOFT_CLIENT_ID,
        effectiveClientId: override || BUILT_IN_MICROSOFT_CLIENT_ID,
        tenant: m.tenant.trim() || 'common',
      },
    };
  }

  setOAuth(update: OAuthSettingsUpdate): OAuthSettings {
    if (update.microsoft) {
      const clientIdOverride = update.microsoft.clientIdOverride.trim();
      const tenant = update.microsoft.tenant.trim() || 'common';
      if (clientIdOverride && !/^[A-Za-z0-9-]{3,64}$/.test(clientIdOverride)) {
        throw new AppException('INVALID_INPUT', 'The client ID should look like 00000000-0000-0000-0000-000000000000.');
      }
      if (!isValidTenant(tenant)) {
        throw new AppException('INVALID_INPUT', 'Use common, organizations, consumers, a tenant ID or a domain name.');
      }
      this.file.oauth.microsoft = { clientIdOverride, tenant };
      this.save();
    }
    return this.getOAuth();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    renameSync(tmp, this.path);
  }
}
