// The Unsubscribe dialogs and steps (DESIGN-SPEC 3.13.1). This file loads the first time the user
// presses Unsubscribe (dynamic import), so it costs nothing at start-up.
import { useEffect, useState } from 'react';
import type { MessageHeader, UnsubscribeInfo, UnsubscribeMethodKind } from '../../../../shared/ipc';
import { Button, Dialog, TextField } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useApp } from '../../store/app';
import { useUi, type UnsubscribeRequest } from '../../store/ui';
import { useList } from '../../store/list';
import { useUndo, undoWithToken } from '../../store/undo';
import { toast, toastError } from '../../store/toasts';
import { asAppError, call } from '../../lib/api';
import { applyToMessages } from '../../lib/actions';
import { senderName } from '../../lib/format';
import { openRuleEditor } from '../rules/ruleActions';

type Ctx = Pick<UnsubscribeRequest, 'header' | 'info' | 'onDone' | 'onBusy'>;

const close = () => useUi.getState().set({ unsubscribe: null });

function listLabel(h: MessageHeader, info: UnsubscribeInfo): string {
  return info.listName || senderName(h.from);
}

/** Start from the button: the extra confirm for an unknown sender, else straight to the first method. */
export function beginUnsubscribe(ctx: Ctx): void {
  const method = ctx.info.methods[0]?.kind;
  if (!method) return;
  if (ctx.info.auth === 'unknown') {
    useUi.getState().set({ unsubscribe: { ...ctx, method, step: 'unknown' } });
    return;
  }
  proceed({ ...ctx, method });
}

function proceed(r: Ctx & { method: UnsubscribeMethodKind }): void {
  if (r.method === 'one-click') void run(r, 'one-click');
  else useUi.getState().set({ unsubscribe: { ...r, step: r.method === 'mailto' ? 'mailto' : 'page' } });
}

/** "Move all from this sender to Trash" (from the toast or the remembered line). */
export function askTrashFromSender(h: MessageHeader, info: UnsubscribeInfo): void {
  useUi.getState().set({
    unsubscribe: { header: h, info, method: info.methods[0]?.kind ?? 'page', step: 'trash', onDone: () => undefined, onBusy: () => undefined },
  });
}

/** "Create rule": From contains the address, move to Trash. Nothing is saved until the user saves. */
export function createUnsubscribeRule(h: MessageHeader, info: UnsubscribeInfo): void {
  const address = info.sender ?? h.from?.address;
  if (!address) return;
  openRuleEditor({
    prefill: {
      name: `Unsubscribed: ${senderName(h.from)}`,
      accountId: h.accountId,
      conditions: [{ field: 'from', value: address }],
      actions: { delete: true },
    },
  });
}

async function run(r: Ctx & { method: UnsubscribeMethodKind }, method: UnsubscribeMethodKind): Promise<void> {
  r.onBusy(true);
  try {
    const res = await call('unsubscribe.run', { messageId: r.header.id, method });
    if (!res.ok) throw res.error ?? new Error('failed');
    r.onDone({ ok: true, method });
    const name = senderName(r.header.from);
    if (method === 'page') {
      toast('Finish unsubscribing in your browser.', { duration: 4000 });
    } else {
      toast(
        method === 'one-click'
          ? `Unsubscribed from ${listLabel(r.header, r.info)}`
          : `Unsubscribe request sent to ${name}. It can take a few days.`,
        {
          actionLabel: 'Move all from this sender to Trash',
          onAction: () => askTrashFromSender(r.header, r.info),
          secondaryLabel: 'Create rule',
          onSecondary: () => createUnsubscribeRule(r.header, r.info),
          duration: 10000,
        },
      );
    }
  } catch {
    r.onDone({ ok: false, method });
    const hasPage = r.info.methods.some((m) => m.kind === 'page');
    toastError("Couldn't unsubscribe automatically.", {
      duration: 0,
      actionLabel: hasPage ? 'Open unsubscribe page' : 'Retry',
      onAction: () =>
        hasPage
          ? useUi.getState().set({ unsubscribe: { ...r, method: 'page', step: 'page' } })
          : void run(r, method),
    });
  } finally {
    r.onBusy(false);
  }
}

export default function UnsubscribeHost() {
  const req = useUi((s) => s.unsubscribe);
  if (!req) return null;
  switch (req.step) {
    case 'unknown':
      return <UnknownDialog req={req} />;
    case 'mailto':
      return <MailtoDialog req={req} />;
    case 'page':
      return <PageDialog req={req} />;
    case 'trash':
      return <TrashDialog req={req} />;
  }
}

function UnknownDialog({ req }: { req: UnsubscribeRequest }) {
  return (
    <Dialog
      title="We can't confirm who sent this"
      size="md"
      onClose={close}
      initialFocus=".foot .btn:not(.primary):not(.danger)"
      leading={<span className="dlg-lead-ic"><Icon name="warn" size={20} /></span>}
    >
      <div role="alertdialog" aria-label="We can't confirm who sent this">
        <p className="dlg-p">
          This message does not prove who it is from. Unsubscribing from a fake sender can tell spammers that your address is active. If you don&apos;t know this sender, use Report spam instead.
        </p>
      </div>
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          onClick={() => {
            close();
            void applyToMessages([req.header.id], { type: 'spam' });
          }}
        >
          Report spam
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            close();
            proceed(req);
          }}
        >
          Unsubscribe anyway
        </Button>
      </div>
    </Dialog>
  );
}

function MailtoDialog({ req }: { req: UnsubscribeRequest }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === req.header.accountId));
  const m = req.info.methods.find((x) => x.kind === 'mailto');
  return (
    <Dialog title="Unsubscribe by email?" size="sm" onClose={close} initialFocus=".foot .btn:not(.primary)">
      <p className="dlg-p">
        Letterdock will send a short email to {m?.address} from {account?.email} to ask them to stop.
      </p>
      <TextField label="To" value={m?.address ?? ''} readOnly />
      <TextField label="Subject" value={m?.subject || 'unsubscribe'} readOnly />
      <TextField label="From" value={account?.email ?? ''} readOnly />
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => {
            close();
            void run(req, 'mailto');
          }}
        >
          Send
        </Button>
      </div>
    </Dialog>
  );
}

function PageDialog({ req }: { req: UnsubscribeRequest }) {
  const host = req.info.methods.find((x) => x.kind === 'page')?.host ?? '';
  const online = useApp((s) => s.online);
  return (
    <Dialog title="Open the unsubscribe page?" size="sm" onClose={close} initialFocus=".foot .btn:not(.primary)">
      <p className="dlg-p">This opens a web page from {host} in your browser. You may need to finish there.</p>
      {!online ? <p className="hint">You&apos;re offline. Try again when you are connected.</p> : null}
      <div className="foot">
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!online}
          onClick={() => {
            close();
            void run(req, 'page');
          }}
        >
          Open page
        </Button>
      </div>
    </Dialog>
  );
}

function TrashDialog({ req }: { req: UnsubscribeRequest }) {
  const accounts = useApp((s) => s.accounts);
  const address = req.info.sender ?? req.header.from?.address ?? '';
  const accountName = accounts.find((a) => a.id === req.header.accountId)?.displayName ?? '';
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // The number comes from a count query run only now.
  useEffect(() => {
    let alive = true;
    call('messages.countFromSender', { accountId: req.header.accountId, address })
      .then((r) => alive && setCount(r.count))
      .catch(() => alive && setCount(0));
    return () => {
      alive = false;
    };
  }, [req.header.accountId, address]);
  return (
    <Dialog title="Move to Trash?" size="sm" onClose={close} busy={busy} initialFocus=".foot .btn:not(.primary)">
      <p className="dlg-p" aria-live="polite">
        {count === null
          ? 'Counting...'
          : `Move ${count} ${count === 1 ? 'message' : 'messages'} from ${address} in ${accountName} to Trash?`}
      </p>
      <div className="foot">
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!count}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await call('messages.trashFromSender', { accountId: req.header.accountId, address });
              close();
              const token = res.undoToken;
              if (token) useUndo.getState().push(token, res.succeeded.length);
              toast(`${res.succeeded.length} ${res.succeeded.length === 1 ? 'message' : 'messages'} moved to Trash`, {
                duration: 6000,
                ...(token ? { actionLabel: 'Undo', onAction: () => void undoWithToken(token) } : {}),
              });
              void useList.getState().refresh();
            } catch (e) {
              close();
              toastError(asAppError(e).message);
            }
          }}
        >
          Move to Trash
        </Button>
      </div>
    </Dialog>
  );
}
