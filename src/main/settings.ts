import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSettings, OAuthSettings, OAuthSettingsUpdate } from '../shared/ipc';
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
};

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
    if (def !== null && typeof def === 'object') {
      if (v && typeof v === 'object' && !Array.isArray(v)) o[key] = { ...def, ...v };
    } else if (typeof v === typeof def) {
      o[key] = v;
    }
  }
  if (out.shortcutPreset !== 'gmail') out.shortcutPreset = 'outlook'; // only the two known styles
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
