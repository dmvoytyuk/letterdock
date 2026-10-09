import { forwardRef } from 'react';
import { AccountBadge, Button } from '../../components/ui';
import { pendingText, syncKindOf, syncText } from '../../components/Sync';
import { useApp } from '../../store/app';
import { useAccountColor } from '../../lib/hooks';
import { call } from '../../lib/api';
import { reportActionError, toast } from '../../store/toasts';

export function syncAll(): void {
  call('sync.all').catch((e) => reportActionError(e));
  toast('Checking all accounts...');
}

/**
 * The list of accounts with their sync state and "Sync now". The title bar button opens it below
 * the button, the status bar opens it above the bar (DESIGN-SPEC 4.5 and 4.8).
 */
export const SyncPopover = forwardRef<HTMLDivElement, { placement: 'below' | 'above' }>(function SyncPopover(
  { placement },
  ref,
) {
  const accounts = useApp((s) => s.accounts);
  const statuses = useApp((s) => s.statuses);
  const authRequired = useApp((s) => s.authRequired);
  const online = useApp((s) => s.online);
  const colorOf = useAccountColor();
  const kinds = accounts.map((a) => ({ a, kind: syncKindOf(statuses[a.id], !!authRequired[a.id], online) }));

  const pos =
    placement === 'below'
      ? { left: 'auto', right: 0, top: 36 }
      : { left: 12, right: 'auto', top: 'auto', bottom: 'calc(100% + 8px)' };
  return (
    <div
      ref={ref}
      className="sdrop"
      role="dialog"
      aria-label="Sync status"
      style={{ width: 340, minWidth: 0, zIndex: 80, ...pos }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontWeight: 600, flex: 1 }}>Accounts</b>
        <Button size="sm" icon="sync" onClick={syncAll}>
          Check all
        </Button>
      </div>
      {accounts.length === 0 ? <div className="hint">No accounts yet.</div> : null}
      <div className="scroll" style={{ maxHeight: 320 }}>
        {kinds.map(({ a, kind }) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <AccountBadge color={colorOf(a.id)} name={a.displayName} letter={a.badge} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.displayName}</div>
              <div className="hint">{syncText(kind === 'pending' ? 'idle' : kind, statuses[a.id])}</div>
              {kind !== 'offline' && (statuses[a.id]?.pendingCount ?? 0) > 0 ? (
                <div className="hint">{pendingText(statuses[a.id]!.pendingCount)}</div>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => {
                call('sync.account', { accountId: a.id }).catch((e) => reportActionError(e));
              }}
            >
              Sync now
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
});
