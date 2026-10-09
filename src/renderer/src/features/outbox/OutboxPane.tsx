import { useEffect, useState } from 'react';
import type { OutboxItem } from '../../../../shared/ipc';
import { AccountBadge, Button, EmptyState } from '../../components/ui';
import { useApp } from '../../store/app';
import { useOutbox, undoSend } from '../../store/outbox';
import { useAccountColor } from '../../lib/hooks';
import { asAppError, call } from '../../lib/api';
import { toast, toastError } from '../../store/toasts';

/** Mail waiting to be sent, being sent, or that failed (DESIGN-SPEC 3.7, 4.4). */
export function OutboxPane() {
  const items = useOutbox((s) => s.items);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useOutbox.getState().refetch();
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  return (
    <section className="list outbox fill" aria-label="Outbox" id="pane-list" style={{ flex: 1 }}>
      <div className="lhead">
        <h2>Outbox</h2>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="send" title="Nothing waiting to be sent" text="Messages you send wait here until they are on their way." />
      ) : (
        <ul className="obox scroll" aria-label="Messages in the outbox">
          {items.map((it) => (
            <OutboxRow
              key={it.id}
              item={it}
              now={now}
              account={accounts.find((a) => a.id === it.accountId)?.displayName ?? ''}
              letter={accounts.find((a) => a.id === it.accountId)?.badge ?? ''}
              color={colorOf(it.accountId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function statusOf(it: OutboxItem, now: number): { text: string; tone: 'info' | 'bad' | 'busy' } {
  if (it.state === 'failed') return { text: `Couldn't send. ${it.lastError ?? ''}`.trim(), tone: 'bad' };
  if (it.state === 'sending') return { text: 'Sending...', tone: 'busy' };
  if (it.attempts > 0) {
    const secs = Math.max(0, Math.round((it.sendAt - now) / 1000));
    return {
      text: `${it.lastError ? it.lastError + ' ' : ''}Trying again ${secs > 0 ? `in ${secs} seconds` : 'now'}.`,
      tone: 'info',
    };
  }
  const secs = Math.ceil((it.sendAt - now) / 1000);
  return { text: secs > 0 ? `Sending in ${secs} seconds` : 'Waiting to send', tone: 'info' };
}

function OutboxRow({
  item: it,
  now,
  account,
  letter,
  color,
}: {
  item: OutboxItem;
  now: number;
  account: string;
  letter: string;
  color: string;
}) {
  const [busy, setBusy] = useState(false);
  const st = statusOf(it, now);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const err = asAppError(e);
      toastError(err.code === 'CANCELLED' ? 'This message is already being sent.' : err.message);
    } finally {
      setBusy(false);
      void useOutbox.getState().refetch();
    }
  };
  return (
    <li className={`orow ${it.state}`}>
      <AccountBadge color={color} name={account} letter={letter} />
      <div className="otx">
        <div className="osub">{it.subject || '(no subject)'}</div>
        <div className={`ost ${st.tone}`} role={it.state === 'failed' ? 'alert' : undefined}>
          {st.tone === 'busy' ? <i className="spin" /> : null}
          {st.text}
        </div>
        <div className="hint">{account}</div>
      </div>
      <div className="oact">
        {it.state === 'queued' && it.attempts === 0 && it.sendAt > now ? (
          <Button size="sm" disabled={busy} onClick={() => void undoSend(it.id)}>
            Undo send
          </Button>
        ) : null}
        {it.state === 'failed' || (it.state === 'queued' && it.attempts > 0) ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void run(() => call('outbox.retry', { outboxId: it.id }).then(() => toast('Trying again...')))}
          >
            Retry
          </Button>
        ) : null}
        {it.state !== 'sending' && !(it.state === 'queued' && it.attempts === 0) ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await call('outbox.cancel', { outboxId: it.id });
                  if (r.draftId) await call('compose.openWindow', { mode: 'new', draftId: r.draftId });
                })
              }
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await call('outbox.cancel', { outboxId: it.id });
                  if (r.draftId) await call('compose.discard', { draftId: r.draftId });
                  toast('Message deleted.');
                })
              }
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
