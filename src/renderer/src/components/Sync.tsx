import type { AccountId, AccountStatus } from '../../../shared/ipc';
import { Icon } from './Icon';
import { useApp } from '../store/app';
import { relativeTime } from '../lib/format';

export type SyncKind = 'idle' | 'syncing' | 'error' | 'auth' | 'offline' | 'disabled' | 'pending';

export function syncKindOf(
  status: AccountStatus | undefined,
  authRequired: boolean,
  online: boolean,
): SyncKind {
  if (authRequired || status?.state === 'auth_failed' || status?.state === 'needs_reauth')
    return 'auth';
  if (status?.state === 'disabled') return 'disabled';
  if (!online || status?.state === 'offline') return 'offline';
  if (status?.state === 'retrying') return 'error';
  if (status?.state === 'connecting' || status?.state === 'syncing') return 'syncing';
  // Last in the order: sign-in, error, offline, syncing, changes waiting (DESIGN-SPEC 4.4.1).
  if ((status?.pendingCount ?? 0) > 0) return 'pending';
  return 'idle';
}

export function useSyncKind(accountId: AccountId): SyncKind {
  const status = useApp((s) => s.statuses[accountId]);
  const auth = useApp((s) => !!s.authRequired[accountId]);
  const online = useApp((s) => s.online);
  return syncKindOf(status, auth, online);
}

/** "1 change waiting to sync" / "3 changes waiting to sync". */
export function pendingText(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} waiting to sync`;
}

export function syncText(kind: SyncKind, status: AccountStatus | undefined): string {
  const waiting = status?.pendingCount ?? 0;
  switch (kind) {
    case 'pending':
      return pendingText(waiting);
    case 'auth':
      return 'Sign in again';
    case 'syncing':
      return 'Syncing';
    case 'error': {
      const secs = status?.nextRetryAt ? Math.max(0, Math.round((status.nextRetryAt - Date.now()) / 1000)) : 0;
      const when = secs > 90 ? `${Math.round(secs / 60)} minutes` : secs > 0 ? `${secs} seconds` : 'a moment';
      return `Can't connect. Will retry in ${when}`;
    }
    case 'offline':
      return waiting > 0 ? `Offline. ${pendingText(waiting)}` : 'Offline';
    case 'disabled':
      return 'Turned off';
    default:
      return `Up to date. Last checked ${relativeTime(status?.lastSyncAt ?? null)}`;
  }
}

export function SyncGlyph({ accountId }: { accountId: AccountId }) {
  const status = useApp((s) => s.statuses[accountId]);
  const kind = useSyncKind(accountId);
  if (kind === 'idle') return null;
  const text = syncText(kind, status);
  return (
    <span className={`sync ${kind === 'error' ? 'warnT' : ''}`} title={text} role="img" aria-label={text}>
      {kind === 'syncing' ? (
        <i className="spin" />
      ) : kind === 'auth' ? (
        <span className="dgl" aria-hidden="true">
          !
        </span>
      ) : kind === 'error' ? (
        <Icon name="warn" />
      ) : kind === 'offline' ? (
        <Icon name="cloud-off" />
      ) : kind === 'pending' ? (
        <Icon name="pending" />
      ) : (
        <Icon name="bell-off" />
      )}
    </span>
  );
}
