// Windows notifications for new mail and sign-in problems (ARCHITECTURE section 8).
// Pure logic: Electron's Notification and the window are injected, so it can be tested.
import type { AppSettings, MessageHeader, MessageId } from '../shared/ipc';

export interface ToastSpec {
  title: string;
  body: string;
  silent: boolean;
  onClick: () => void;
}

export interface NotifierDeps {
  show: (t: ToastSpec) => void;
  settings: () => AppSettings;
  /** True when the main window is on screen and focused: no toast then. */
  isMainFocused: () => boolean;
  accountName: (accountId: string) => Promise<string>;
  /** Bring the app to the front; open this message if given. */
  focusMain: (messageId?: MessageId) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
  /** Gather a burst of mail for this long before showing anything. */
  burstMs?: number;
  /** More than this many messages from one burst become a single toast. */
  groupAbove?: number;
}

const AUTH_THROTTLE_MS = 24 * 3600 * 1000;
const MAX_REMEMBERED = 5000;

export class Notifier {
  private buffers = new Map<string, MessageHeader[]>();
  private shown = new Set<MessageId>();
  private lastAuth = new Map<string, number>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly now: () => number;

  constructor(private readonly d: NotifierDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.now = d.now ?? (() => Date.now());
  }

  private allowed(accountId: string): boolean {
    const n = this.d.settings().notifications;
    return n.enabled && !n.mutedAccountIds.includes(accountId);
  }

  /** Engine event `notify:newMail`. */
  newMail(accountId: string, messages: MessageHeader[]): void {
    if (!this.allowed(accountId) || this.d.isMainFocused()) return;
    const fresh = messages.filter((m) => !this.shown.has(m.id) && !m.seen);
    if (fresh.length === 0) return;
    for (const m of fresh) {
      this.shown.add(m.id);
      if (this.shown.size > MAX_REMEMBERED) this.shown.delete(this.shown.values().next().value!);
    }
    const buf = this.buffers.get(accountId);
    if (buf) {
      buf.push(...fresh);
      return;
    }
    this.buffers.set(accountId, [...fresh]);
    this.setTimer(() => void this.flush(accountId), this.d.burstMs ?? 2500);
  }

  private async flush(accountId: string): Promise<void> {
    const batch = this.buffers.get(accountId) ?? [];
    this.buffers.delete(accountId);
    if (batch.length === 0 || !this.allowed(accountId)) return;
    const name = await this.d.accountName(accountId).catch(() => 'your account');
    const prefs = this.d.settings().notifications;
    const silent = !prefs.sound;
    if (batch.length > (this.d.groupAbove ?? 3)) {
      this.d.show({
        title: `${batch.length} new messages`,
        body: `in ${name}`,
        silent,
        onClick: () => this.d.focusMain(),
      });
      return;
    }
    for (const m of batch) {
      const sender = m.from?.name || m.from?.address || 'Unknown sender';
      this.d.show(
        prefs.showPreview
          ? {
              title: sender,
              body: [m.subject || '(no subject)', m.snippet].filter(Boolean).join('\n').slice(0, 200),
              silent,
              onClick: () => this.d.focusMain(m.id),
            }
          : { title: 'New mail', body: name, silent, onClick: () => this.d.focusMain(m.id) },
      );
    }
  }

  /** Engine event `account:authRequired`: at most one toast per account per 24 hours. */
  async authRequired(accountId: string): Promise<void> {
    if (!this.d.settings().notifications.enabled) return;
    const last = this.lastAuth.get(accountId);
    const now = this.now();
    if (last !== undefined && now - last < AUTH_THROTTLE_MS) return;
    this.lastAuth.set(accountId, now);
    const name = await this.d.accountName(accountId).catch(() => 'An account');
    this.d.show({
      title: `${name} needs you to sign in again`,
      body: 'Open Mailroom to fix it.',
      silent: !this.d.settings().notifications.sound,
      onClick: () => this.d.focusMain(),
    });
  }
}
