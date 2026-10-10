import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import {
  MAX_RULE_CONDITIONS,
  type AccountId,
  type Folder,
  type Rule,
  type RuleActions,
  type RuleCondition,
  type RuleConditionField,
  type RuleDraft,
} from '../../../../shared/ipc';
import { Icon, type IconName } from '../../components/Icon';
import { Banner, Button, Checkbox, Dialog, IconButton } from '../../components/ui';
import { AccountSelect } from '../../components/AccountSelect';
import { useAccountColor } from '../../lib/hooks';
import { useApp } from '../../store/app';
import { useRules } from '../../store/rules';
import { useUi, type RuleEditorRequest } from '../../store/ui';
import { asAppError, call } from '../../lib/api';
import { currentAccountId, folderTitle } from '../../lib/actions';
import { FIELD_LABELS, FIELD_ORDER, canAddCondition, countableConditions, matchCountText, validateRule } from '../../lib/rules';
import { toast } from '../../store/toasts';
import { orderFolders } from '../sidebar/Sidebar';
import { openRunRules } from './ruleActions';

const ROLE_ICON: Record<string, IconName> = { inbox: 'inbox', drafts: 'draft', sent: 'send', archive: 'archive', all: 'archive', junk: 'spam', trash: 'trash' };

function fromRule(r: Rule): RuleDraft {
  return { name: r.name, enabled: r.enabled, accountId: r.accountId, matchMode: r.matchMode, conditions: r.conditions.map((c) => ({ ...c })), actions: { ...r.actions }, trigger: r.trigger };
}

/** Hosted once in the app: opens when `ui.ruleEditor` is set (from Settings, a message, a conversation). */
export function RuleEditorHost() {
  const req = useUi((s) => s.ruleEditor);
  if (!req) return null;
  return <RuleEditorDialog key={req.rule?.id ?? JSON.stringify(req.prefill ?? 'new')} request={req} onClose={() => useUi.getState().set({ ruleEditor: null })} />;
}

function RuleEditorDialog({ request, onClose }: { request: RuleEditorRequest; onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const existing = request.rule;
  const ruleCount = useRules((s) => s.rules.length);

  const initial = useMemo<RuleDraft>(() => {
    if (existing) return fromRule(existing);
    // From a message: that account. From Settings with 2 or more accounts: All accounts. Else the account of the folder in view.
    const fromSettings = !request.prefill && useUi.getState().page === 'settings' && accounts.length >= 2;
    const accountId = request.prefill?.accountId ?? (fromSettings ? null : (currentAccountId() ?? (accounts.length === 1 ? accounts[0]!.id : null)));
    return {
      name: request.prefill?.name ?? `Rule ${ruleCount + 1}`,
      enabled: true,
      accountId,
      matchMode: 'all',
      conditions: request.prefill?.conditions.map((c) => ({ ...c })) ?? [{ field: 'from', value: '' }],
      actions: { markRead: false, flag: false, delete: false, stop: false, ...request.prefill?.actions },
      trigger: 'inbox',
    };
    // The request does not change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState(initial.name);
  const [accountId, setAccountId] = useState<AccountId | null>(initial.accountId);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>(initial.matchMode);
  const [conditions, setConditions] = useState<RuleCondition[]>(initial.conditions);
  const [moveOn, setMoveOn] = useState(!!initial.actions.moveToFolderId);
  const [folderId, setFolderId] = useState<number | null>(initial.actions.moveToFolderId ?? null);
  const [folderPath, setFolderPath] = useState<string | null>(initial.actions.moveToFolderPath ?? null);
  const [markRead, setMarkRead] = useState(initial.actions.markRead);
  const [flag, setFlag] = useState(initial.actions.flag);
  const [del, setDel] = useState(initial.actions.delete);
  const [stop, setStop] = useState(initial.actions.stop);
  const [trigger, setTrigger] = useState(initial.trigger);
  const [touched, setTouched] = useState<{ name: boolean; cond: boolean[]; submit: boolean }>({ name: false, cond: [], submit: false });
  const [note, setNote] = useState('');
  const [picker, setPicker] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ matches: number; total: number } | null>(null);
  const nameId = useId();
  const accountSel = useId();
  const colorOf = useAccountColor();
  const nameRef = useRef<HTMLInputElement>(null);

  const draftNow = (): RuleDraft => {
    const actions: RuleActions = { markRead, flag, delete: del, stop };
    if (moveOn && folderId) {
      actions.moveToFolderId = folderId;
      if (folderPath) actions.moveToFolderPath = folderPath;
    }
    return {
      name: name.trim(),
      enabled: existing && existing.warning && folderId && folderId !== existing.actions.moveToFolderId ? true : initial.enabled,
      accountId,
      matchMode,
      conditions: conditions.map((c) => (c.field === 'hasAttachment' ? { field: c.field } : { field: c.field, value: (c.value ?? '').trim() })),
      actions,
      trigger,
    };
  };

  const errors = validateRule({ name, conditions, actions: { markRead, flag, delete: del, stop, ...(moveOn && folderId ? { moveToFolderId: folderId } : {}) } });
  const moveError = moveOn && !folderId ? 'Choose a folder.' : null;
  const valid = errors.ok && !moveError;
  const dirty = JSON.stringify(draftNow()) !== JSON.stringify(initialDraftAsSaved(initial)) || (moveOn && !folderId);

  // Live match count, 400 ms after the last change (DESIGN-SPEC 3.12.2).
  const countKey = JSON.stringify([accountId, matchMode, countableConditions(conditions)]);
  useEffect(() => {
    const list = countableConditions(conditions);
    if (list.length === 0) return;
    let alive = true;
    const h = setTimeout(() => {
      call('rules.countMatches', { rule: { accountId, matchMode, conditions: list.map((c) => (c.field === 'hasAttachment' ? { field: c.field } : { field: c.field, value: (c.value ?? '').trim() })) } })
        .then((r) => alive && setCount(r))
        .catch(() => alive && setCount(null));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey]);
  const shownCount = countableConditions(conditions).length === 0 ? null : count;

  const close = () => (dirty ? setConfirmDiscard(true) : onClose());

  const changeAccount = (next: AccountId | null) => {
    if (next === accountId) return;
    setAccountId(next);
    if (moveOn || folderId) {
      setMoveOn(false);
      setFolderId(null);
      setFolderPath(null);
      setNote('The folder was cleared because you changed the account.');
    }
  };

  const toggleMove = (on: boolean) => {
    if (on) {
      if (accountId === null) return;
      setMoveOn(true);
      if (del) {
        setDel(false);
        setNote('Delete was turned off because you chose Move to folder.');
      }
      if (!folderId) setPicker(true);
    } else {
      setMoveOn(false);
    }
  };
  const toggleDelete = (on: boolean) => {
    setDel(on);
    if (on && (moveOn || folderId)) {
      setMoveOn(false);
      setNote('Move to folder was turned off because you chose Delete.');
    }
  };

  const save = async () => {
    setTouched((t) => ({ ...t, submit: true, name: true, cond: conditions.map(() => true) }));
    if (!valid) {
      if (errors.name) nameRef.current?.focus();
      else {
        const i = errors.conditions.findIndex((c) => c);
        if (i >= 0) document.getElementById(`${nameId}-v${i}`)?.focus();
      }
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const draft = draftNow();
      if (existing) {
        await call('rules.update', { id: existing.id, patch: draft });
        toast('Rule saved.');
      } else {
        const created = await call('rules.create', draft);
        toast('Rule saved.', { duration: 6000, actionLabel: 'Run it on Inbox now', onAction: () => openRunRules(created.id, 'allInboxes') });
      }
      void useRules.getState().refetchRules();
      onClose();
    } catch (e) {
      setError(asAppError(e).message);
      setSaving(false);
    }
  };

  const setCond = (i: number, patch: Partial<RuleCondition>) =>
    setConditions((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setField = (i: number, field: RuleConditionField) =>
    setConditions((list) => list.map((c, j) => (j === i ? (field === 'hasAttachment' ? { field } : { field, value: c.value ?? '' }) : c)));

  const account = accounts.find((a) => a.id === accountId);
  const mineFolders = folders.filter((f) => f.accountId === accountId);
  const chosenFolder = folderId ? mineFolders.find((f) => f.id === folderId) : undefined;
  const folderShown = chosenFolder ? (chosenFolder.path || chosenFolder.name) : folderPath;

  return (
    <>
      <Dialog
        title={existing ? 'Edit rule' : 'New rule'}
        size="lg"
        onClose={close}
        busy={saving}
        initialFocus={request.prefill ? '.ractions input[type="checkbox"]' : undefined}
      >
        <form
          className="rform"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input
              id={nameId}
              ref={nameRef}
              className={`inp ${errors.name && touched.name ? 'err' : ''}`}
              value={name}
              maxLength={60}
              autoComplete="off"
              aria-invalid={errors.name && touched.name ? true : undefined}
              aria-describedby={errors.name && touched.name ? `${nameId}-err` : undefined}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            />
            {errors.name && touched.name ? (
              <div className="bad" id={`${nameId}-err`}>
                <Icon name="warn" />
                {errors.name}
              </div>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={accountSel} id={`${accountSel}-lbl`}>Account</label>
            <AccountSelect
              id={accountSel}
              labelledBy={`${accountSel}-lbl`}
              accounts={accounts}
              value={accountId}
              allLabel="All accounts"
              colorOf={colorOf}
              onChange={changeAccount}
            />
          </div>

          <div className="rsec">
            <div className="rsechead">
              <h4>IF</h4>
              {conditions.length >= 2 ? (
                <select className="inp inline" aria-label="Match" value={matchMode} onChange={(e) => setMatchMode(e.target.value as 'all' | 'any')}>
                  <option value="all">Match all of these</option>
                  <option value="any">Match any of these</option>
                </select>
              ) : null}
            </div>
            {conditions.map((c, i) => {
              const err = errors.conditions[i];
              const showErr = !!err && (touched.cond[i] || touched.submit);
              return (
                <div key={i} className="rcond" role="group" aria-label={`Condition ${i + 1} of ${conditions.length}`}>
                  <select className="inp rfield" aria-label="Field" value={c.field} onChange={(e) => setField(i, e.target.value as RuleConditionField)}>
                    {FIELD_ORDER.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  {c.field === 'hasAttachment' ? (
                    <span className="rnoval">Has attachment</span>
                  ) : (
                    <div className="rval">
                      <input
                        id={`${nameId}-v${i}`}
                        className={`inp ${showErr ? 'err' : ''}`}
                        value={c.value ?? ''}
                        autoComplete="off"
                        aria-label="Text to look for"
                        aria-invalid={showErr ? true : undefined}
                        aria-describedby={showErr ? `${nameId}-ce${i}` : undefined}
                        onChange={(e) => setCond(i, { value: e.target.value })}
                        onBlur={() => setTouched((t) => ({ ...t, cond: Object.assign([...t.cond], { [i]: true }) }))}
                      />
                      {showErr ? (
                        <div className="bad" id={`${nameId}-ce${i}`}>
                          <Icon name="warn" />
                          {err}
                        </div>
                      ) : null}
                    </div>
                  )}
                  <IconButton icon="x" label="Remove condition" size="sm" disabled={conditions.length === 1} onClick={() => setConditions((l) => l.filter((_, j) => j !== i))} />
                </div>
              );
            })}
            <Button
              size="sm"
              variant="subtle"
              icon="plus"
              disabled={!canAddCondition(conditions.length)}
              title={canAddCondition(conditions.length) ? undefined : `You can use up to ${MAX_RULE_CONDITIONS} conditions.`}
              onClick={() => setConditions((l) => [...l, { field: 'from', value: '' }])}
            >
              Add condition
            </Button>
            <p className="rcount" aria-live="polite">
              {shownCount ? matchCountText(shownCount.matches, shownCount.total, accountId === null) : ''}
            </p>
          </div>

          <div className="rsec ractions">
            <div className="rsechead">
              <h4>THEN</h4>
            </div>
            <div className="rmoverow">
              <Checkbox checked={moveOn} disabled={accountId === null} onChange={toggleMove} label="Move to folder" />
              <button type="button" className="fromsel rfolder" disabled={accountId === null} aria-label={folderShown ? `Folder: ${folderShown}. Change folder` : 'Choose a folder'} onClick={() => setPicker(true)}>
                <span className="fv">{folderShown || 'Choose a folder'}</span>
                <Icon name="chev-d" />
              </button>
            </div>
            {accountId === null ? <p className="hint rhint">Choose one account to pick a folder.</p> : null}
            {moveError && (touched.submit || folderId === null) && touched.submit ? (
              <div className="bad rhint">
                <Icon name="warn" />
                {moveError}
              </div>
            ) : null}
            <Checkbox checked={markRead} onChange={setMarkRead} label="Mark as read" />
            <Checkbox checked={flag} onChange={setFlag} label="Flag" />
            <Checkbox checked={del} onChange={toggleDelete} label="Delete (move to Trash)" />
            {del ? <p className="hint rhint warnT">The message goes to Trash. You can still find it there.</p> : null}
            <Checkbox checked={stop} onChange={setStop} label="Stop processing more rules" />
            {errors.actions && touched.submit ? (
              <div className="bad rhint">
                <Icon name="warn" />
                {errors.actions}
              </div>
            ) : null}
            <p className="sr-only" role="status" aria-live="polite">
              {note}
            </p>
            {note ? <p className="hint rhint">{note}</p> : null}
          </div>

          <div className="rsec">
            <div className="rsechead">
              <h4>WHEN</h4>
            </div>
            <div className="rrunon">
              <label htmlFor={`${nameId}-run`}>Run on</label>
              <select id={`${nameId}-run`} className="inp" value={trigger} onChange={(e) => setTrigger(e.target.value as 'inbox' | 'anyFolder')}>
                <option value="inbox">New mail arriving in Inbox</option>
                <option value="anyFolder">New mail arriving in any folder</option>
              </select>
            </div>
          </div>

          <Banner tone="info">
            This rule runs on this PC, only while Letterdock is running. It doesn&apos;t change filters on Gmail or your provider. Mail that arrives while Letterdock is closed is sorted the next time it starts.
          </Banner>
          {error ? (
            <Banner tone="danger" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}
          <div className="foot">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!valid}>
              Save rule
            </Button>
          </div>
        </form>
      </Dialog>
      {picker && accountId ? (
        <FolderPickDialog
          accountId={accountId}
          accountName={account?.displayName ?? ''}
          currentId={folderId}
          onClose={() => {
            setPicker(false);
            if (!folderId) setMoveOn(false);
          }}
          onPick={(f) => {
            setFolderId(f.id);
            setFolderPath(f.path);
            setMoveOn(true);
            setPicker(false);
          }}
        />
      ) : null}
      {confirmDiscard ? (
        <Dialog title="Discard changes to this rule?" size="sm" onClose={() => setConfirmDiscard(false)} initialFocus=".foot .btn:not(.danger)">
          <div className="foot">
            <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button variant="danger" onClick={onClose}>
              Discard
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** What the editor builds for an unchanged form, to tell whether something was edited. */
function initialDraftAsSaved(d: RuleDraft): RuleDraft {
  return {
    ...d,
    name: d.name.trim(),
    conditions: d.conditions.map((c) => (c.field === 'hasAttachment' ? { field: c.field } : { field: c.field, value: (c.value ?? '').trim() })),
    actions: {
      markRead: d.actions.markRead,
      flag: d.actions.flag,
      delete: d.actions.delete,
      stop: d.actions.stop,
      ...(d.actions.moveToFolderId ? { moveToFolderId: d.actions.moveToFolderId, ...(d.actions.moveToFolderPath ? { moveToFolderPath: d.actions.moveToFolderPath } : {}) } : {}),
    },
  };
}

// ---------- folder picker ----------
function FolderPickDialog({
  accountId,
  accountName,
  currentId,
  onPick,
  onClose,
}: {
  accountId: AccountId;
  accountName: string;
  currentId: number | null;
  onPick: (f: Folder) => void;
  onClose: () => void;
}) {
  const folders = useApp((s) => s.folders);
  const [filter, setFilter] = useState('');
  const [activeRaw, setActive] = useState<number | null>(null);
  const rows = useMemo(() => {
    const mine = folders.filter((f) => f.accountId === accountId && f.selectable);
    const { main, more } = orderFolders(mine);
    const q = filter.trim().toLowerCase();
    return [...main, ...more].filter((f) => !q || folderTitle(f).toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [folders, accountId, filter]);
  const active = activeRaw ?? Math.max(0, rows.findIndex((f) => f.id === currentId));
  const onKey = (e: RKE) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(rows.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = rows[Math.min(active, rows.length - 1)];
      if (f) onPick(f);
    }
  };
  return (
    <Dialog title="Choose a folder" size="sm" onClose={onClose}>
      <p className="hint" style={{ marginBottom: 8 }}>
        Folders of {accountName}
      </p>
      <input
        className="inp"
        placeholder="Find a folder"
        aria-label="Find a folder"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(null);
        }}
        onKeyDown={onKey}
        autoComplete="off"
        aria-controls="rule-folder-list"
      />
      <div id="rule-folder-list" className="movelist scroll" role="listbox" aria-label="Folders" tabIndex={-1}>
        {rows.length === 0 ? <div className="hint" style={{ padding: 12 }}>No folder matches.</div> : null}
        {rows.map((f, i) => (
          <button
            key={f.id}
            type="button"
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            className={`mrow ${i === active ? 'act' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(f)}
          >
            <Icon name={(f.role && ROLE_ICON[f.role]) || 'folder'} />
            <span className="nm">{folderTitle(f)}</span>
            {f.path !== f.name ? <span className="pth">{f.path}</span> : null}
            {f.id === currentId ? <span className="pth">chosen</span> : null}
          </button>
        ))}
      </div>
      <div className="foot">
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}
