// Settings > Mail > QUICK REPLIES (DESIGN-SPEC 3.13.4). Loads when the Mail page opens; read only from settings.
import { useId, useRef, useState } from 'react';
import { MAX_QUICK_REPLIES, QUICK_REPLY_NAME_MAX, QUICK_REPLY_TEXT_MAX, type QuickReply } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Button, Dialog, IconButton, SelectField } from '../../components/ui';
import { useApp } from '../../store/app';
import { useAccountColor } from '../../lib/hooks';
import { asAppError } from '../../lib/api';
import { toast, toastError } from '../../store/toasts';
import './quickReplies.css';

const num = (n: number) => n.toLocaleString();

export default function QuickRepliesSettings() {
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const colorOf = useAccountColor();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [narrow, setNarrow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  if (!settings) return null;
  const list = settings.quickReplies;
  const full = list.length >= MAX_QUICK_REPLIES;

  const save = async (next: QuickReply[]): Promise<boolean> => {
    try {
      await useApp.getState().updateSettings({ quickReplies: next });
      return true;
    } catch (e) {
      toastError(asAppError(e).message);
      return false;
    }
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    void save(next);
  };
  const remove = (i: number) => {
    const gone = list[i]!;
    const next = list.filter((_, k) => k !== i);
    void save(next).then((ok) => {
      if (!ok) return;
      toast('Quick reply deleted', {
        duration: 6000,
        actionLabel: 'Undo',
        onAction: () => {
          const cur = useApp.getState().settings?.quickReplies ?? [];
          const back = [...cur];
          back.splice(Math.min(i, back.length), 0, gone);
          void save(back);
        },
      });
    });
  };
  const nameTaken = (name: string, ignoreId: string | null) =>
    list.some((q) => q.id !== ignoreId && q.name.trim().toLowerCase() === name.trim().toLowerCase());

  return (
    <div ref={wrap}>
      <div className="qr-head">
        <h2 id="h-qr">QUICK REPLIES</h2>
        <span className="qr-count" aria-live={list.length >= MAX_QUICK_REPLIES - 3 ? 'polite' : 'off'}>
          {list.length} of {MAX_QUICK_REPLIES}
        </span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>Reusable text you can insert while writing.</p>
      <div className="qr-bar">
        <Button size="sm" icon="plus" disabled={full || editing === 'new'} onClick={() => { setEditing('new'); setNarrow(window.innerWidth < 560); }}>
          New
        </Button>
        {full ? <span className="hint">You can have up to {MAX_QUICK_REPLIES} quick replies.</span> : null}
      </div>
      {editing === 'new' ? (
        narrow ? (
          <Dialog title="New quick reply" size="sm" onClose={() => setEditing(null)}>
            <Editor accounts={accounts} initial={null} taken={(n) => nameTaken(n, null)} onCancel={() => setEditing(null)} onSave={async (q) => { if (await save([...list, q])) setEditing(null); }} />
          </Dialog>
        ) : (
          <Editor accounts={accounts} initial={null} taken={(n) => nameTaken(n, null)} onCancel={() => setEditing(null)} onSave={async (q) => { if (await save([...list, q])) setEditing(null); }} />
        )
      ) : null}
      {list.length === 0 && editing !== 'new' ? (
        <div className="qr-empty">
          <Icon name="msg-text" size={24} />
          <b>No quick replies yet</b>
          <span>Save text you write often, like a thank-you or a meeting reply.</span>
          <Button size="sm" onClick={() => setEditing('new')}>New quick reply</Button>
        </div>
      ) : (
        <ul className="qr-list" aria-labelledby="h-qr">
          {list.map((q, i) =>
            editing === q.id ? (
              <li key={q.id}>
                <Editor
                  accounts={accounts}
                  initial={q}
                  taken={(n) => nameTaken(n, q.id)}
                  onCancel={() => setEditing(null)}
                  onSave={async (nq) => {
                    if (await save(list.map((x) => (x.id === q.id ? nq : x)))) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={q.id} className="qr-row">
                <div className="qr-main">
                  <div className="qr-name">{q.name}</div>
                  <div className="qr-prev">{q.text.replace(/\s+/g, ' ')}</div>
                  <div className="qr-acct">
                    {q.accountId ? (
                      (() => {
                        const a = accounts.find((x) => x.id === q.accountId);
                        return a ? (
                          <>
                            <AccountBadge color={colorOf(a.id)} name={a.displayName} letter={a.badge} /> {a.displayName}
                          </>
                        ) : (
                          'An account that is gone'
                        );
                      })()
                    ) : (
                      'All accounts'
                    )}
                  </div>
                </div>
                <div className="qr-acts">
                  <IconButton icon="pencil" label={`Edit ${q.name}`} size="sm" onClick={() => setEditing(q.id)} />
                  <IconButton icon="chev-up" label={`Move ${q.name} up`} size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="chev-d" label={`Move ${q.name} down`} size="sm" disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="trash" label={`Delete ${q.name}`} size="sm" onClick={() => remove(i)} />
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function Editor({
  accounts,
  initial,
  taken,
  onCancel,
  onSave,
}: {
  accounts: { id: string; displayName: string }[];
  initial: QuickReply | null;
  taken: (name: string) => boolean;
  onCancel: () => void;
  onSave: (q: QuickReply) => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [accountId, setAccountId] = useState<string>(initial?.accountId ?? '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameErr = !name.trim() ? 'Give it a name.' : taken(name) ? 'That name is already used.' : null;
  const textErr = !text.trim() ? 'Add some text.' : null;
  const submit = async () => {
    setTried(true);
    if (nameErr || textErr) return;
    setBusy(true);
    try {
      await onSave({
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim().slice(0, QUICK_REPLY_NAME_MAX),
        text: text.slice(0, QUICK_REPLY_TEXT_MAX),
        accountId: accountId || null,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="qr-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-n`}>Name</label>
        <input
          id={`${id}-n`}
          className={`inp ${tried && nameErr ? 'err' : ''}`}
          value={name}
          maxLength={QUICK_REPLY_NAME_MAX}
          autoFocus
          aria-invalid={tried && nameErr ? true : undefined}
          aria-describedby={tried && nameErr ? `${id}-ne` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {tried && nameErr ? (
          <div className="bad" id={`${id}-ne`}>
            <Icon name="warn" />
            {nameErr}
          </div>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${id}-t`}>Text</label>
        <textarea
          id={`${id}-t`}
          className={`inp ${tried && textErr ? 'err' : ''}`}
          rows={6}
          value={text}
          maxLength={QUICK_REPLY_TEXT_MAX}
          aria-invalid={tried && textErr ? true : undefined}
          aria-describedby={tried && textErr ? `${id}-te` : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {text.length >= 1800 ? (
          <div className="hint qr-counter" aria-live="polite">
            {num(text.length)} / {num(QUICK_REPLY_TEXT_MAX)}
          </div>
        ) : null}
        {tried && textErr ? (
          <div className="bad" id={`${id}-te`}>
            <Icon name="warn" />
            {textErr}
          </div>
        ) : null}
      </div>
      <SelectField label="Use in" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ maxWidth: 280 }}>
        <option value="">All my accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </SelectField>
      <div className="foot">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Save</Button>
      </div>
    </form>
  );
}
