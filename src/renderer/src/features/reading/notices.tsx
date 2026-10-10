// Small pieces of the light features in the reading pane (DESIGN-SPEC 3.13): the Unsubscribe button, the
// "You unsubscribed" line, the muted line and the Snoozed banner. The dialogs behind them load on first use.
import { useCallback, useEffect, useState } from 'react';
import type { MessageHeader, UnsubscribeInfo } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { useApp } from '../../store/app';
import { call } from '../../lib/api';
import { openSnoozeMenu, setMuted, unsnoozeMessages } from '../../lib/light';
import { senderName } from '../../lib/format';
import { whenText } from '../../lib/schedule';
import { snoozeUntilText } from '../../lib/snooze';

export interface UnsubscribeState {
  info: UnsubscribeInfo | null;
  busy: boolean;
  /** Inline text next to the button ("You're offline. ..."). */
  note: string;
  start: () => void;
}

/**
 * Reads the unsubscribe options of the opened message (stored headers, no network) and starts the flow.
 * `enabled` is false for Sent, Drafts and the message window.
 */
export function useUnsubscribe(header: MessageHeader, enabled: boolean): UnsubscribeState {
  const [info, setInfo] = useState<UnsubscribeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const online = useApp((s) => s.online);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    call('unsubscribe.info', { messageId: header.id })
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [header.id, enabled]);

  const start = useCallback(() => {
    if (!info || !info.available || busy) return;
    const first = info.methods[0]?.kind;
    // One-click and the web page need a connection. An email waits in the Outbox when offline.
    if (!online && first !== 'mailto') {
      setNote("You're offline. Try again when you are connected.");
      return;
    }
    setNote('');
    void import('../light/unsubscribeFlow').then((m) =>
      m.beginUnsubscribe({
        header,
        info,
        onBusy: setBusy,
        onDone: (r) => {
          if (r.ok) setInfo((cur) => (cur ? { ...cur, previous: { at: Date.now(), method: r.method } } : cur));
        },
      }),
    );
  }, [info, busy, online, header]);

  return { info, busy, note, start };
}

/** The ghost button at the right end of header line 3. Not shown when the sender check failed or there is no way to unsubscribe. */
export function UnsubscribeButton({ header, u }: { header: MessageHeader; u: UnsubscribeState }) {
  const info = u.info;
  if (!info || !info.available) return null;
  const who = senderName(header.from);
  const label = info.previous ? 'Unsubscribe again' : 'Unsubscribe';
  return (
    <>
      <button
        type="button"
        className="unsub-btn"
        disabled={u.busy}
        aria-label={`${label} from ${who}`}
        title={`${label} from ${who}`}
        onClick={u.start}
      >
        {u.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="bell-off" />}
        <span className="ulbl">{u.busy ? 'Unsubscribing...' : label}</span>
      </button>
      {u.note ? (
        <span className="unsub-note" role="status">
          {u.note}
        </span>
      ) : null}
    </>
  );
}

function dayText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "You unsubscribed from this sender on 3 Oct 2026. Still getting mail? ..." (DESIGN-SPEC 3.13.1). */
export function UnsubscribeMemory({ header, u }: { header: MessageHeader; u: UnsubscribeState }) {
  const info = u.info;
  const prev = info?.previous;
  if (!info || !prev) return null;
  const asyncFlow = (fn: 'askTrashFromSender' | 'createUnsubscribeRule') =>
    void import('../light/unsubscribeFlow').then((m) => m[fn](header, info));
  return (
    <div className="rnotice" role="status">
      <Icon name="info" />
      <span className="rtxt">
        {prev.method === 'page'
          ? `You opened the unsubscribe page for this sender on ${dayText(prev.at)}.`
          : `You unsubscribed from this sender on ${dayText(prev.at)}. Still getting mail?`}
      </span>
      {prev.method !== 'page' ? (
        <>
          <button type="button" className="link" onClick={() => asyncFlow('askTrashFromSender')}>
            Move to Trash
          </button>
          <button type="button" className="link" onClick={() => asyncFlow('createUnsubscribeRule')}>
            Create rule
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Thin line for a muted conversation, with an Unmute button. */
export function MutedNotice({ header }: { header: MessageHeader }) {
  if (!header.muted) return null;
  return (
    <div className="rnotice" role="status">
      <Icon name="bell-off" />
      <span className="rtxt">You muted this conversation. New messages go straight to Archive.</span>
      <Button size="sm" variant="subtle" onClick={() => void setMuted([header.id], false)}>
        Unmute
      </Button>
    </div>
  );
}

/** Reading pane banner in the Snoozed view. */
export function SnoozedBanner({ header }: { header: MessageHeader }) {
  const until = header.snoozedUntil;
  if (!until) return null;
  return (
    <div className="rbanner snz" role="status">
      <span className="ic">
        <Icon name="alarm" size={20} />
      </span>
      <div className="rtxt">Snoozed until {snoozeUntilText(until)}. It is hidden from your Inbox on this PC only.</div>
      <div className="acts" style={{ margin: 0 }}>
        <Button size="sm" variant="primary" onClick={() => void unsnoozeMessages([header.id])}>
          Unsnooze now
        </Button>
        <Button
          size="sm"
          title={whenText(until)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openSnoozeMenu([header.id], r.left, r.bottom + 2, true);
          }}
        >
          Change time...
        </Button>
      </div>
    </div>
  );
}

/** For the More menu: is Unsubscribe possible, impossible (sender check failed), or not offered? */
export function unsubscribeMenuState(info: UnsubscribeInfo | null): 'ok' | 'failed' | 'none' {
  if (!info) return 'none';
  if (info.available) return 'ok';
  return info.auth === 'failed' && info.methods.length > 0 ? 'failed' : 'none';
}

export const UNSUBSCRIBE_UNAVAILABLE_TIP =
  "We can't confirm who sent this message, so unsubscribing could be unsafe. Use Report spam instead.";
