import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE, type PointerEvent as RPE } from 'react';
import { MAX_RULES, type Rule, type RuleActivityItem, type RuleDraft } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge, Button, EmptyState, IconButton, Switch, useMenu, type MenuEntry } from '../../components/ui';
import { useApp } from '../../store/app';
import { useRules } from '../../store/rules';
import { useUi } from '../../store/ui';
import { useAccountColor, useAccountMap } from '../../lib/hooks';
import { asAppError, call } from '../../lib/api';
import { activityTime, ruleSummary } from '../../lib/rules';
import { toast, toastError } from '../../store/toasts';
import { openRuleEditor } from './ruleActions';

/** Settings > Rules (DESIGN-SPEC 3.12.1): the list of rules and the Activity tab. */
export function RulesPage() {
  const tab = useUi((s) => s.rulesTab);
  const rules = useRules((s) => s.rules);
  const full = rules.length >= MAX_RULES;
  const TABS = [
    ['rules', 'Rules'],
    ['activity', 'Activity'],
  ] as const;

  useEffect(() => {
    void useRules.getState().refetchRules();
    void useRules.getState().refetchActivity();
  }, []);

  const onTabKey = (e: RKE<HTMLDivElement>) => {
    const i = TABS.findIndex(([id]) => id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    useUi.setState({ rulesTab: TABS[next]![0] });
    requestAnimationFrame(() => document.getElementById(`rtab-${TABS[next]![0]}`)?.focus());
  };

  return (
    <div className="rulespage">
      <div className="rpHead">
        <h1>Rules</h1>
        <span title={full ? `You have ${MAX_RULES} rules. Delete one to add another.` : undefined}>
          <Button variant="primary" icon="plus" disabled={full} onClick={() => openRuleEditor({})}>
            New rule
          </Button>
        </span>
      </div>
      <p className="lead">
        Rules sort new mail for you, for example move mail from a shop into a folder. They run on this PC while Letterdock is running. They don&apos;t change filters on Gmail or your email provider.
      </p>
      <div className="rtabs" role="tablist" aria-label="Rules" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            id={`rtab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`rpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'on' : ''}
            onClick={() => useUi.setState({ rulesTab: id })}
          >
            {label}
          </button>
        ))}
      </div>
      <div id={`rpanel-${tab}`} role="tabpanel" aria-labelledby={`rtab-${tab}`}>
        {tab === 'rules' ? <RulesList /> : <ActivityList />}
      </div>
    </div>
  );
}

// ---------- the list ----------
function draftOf(r: Rule): RuleDraft {
  return { name: r.name, enabled: r.enabled, accountId: r.accountId, matchMode: r.matchMode, conditions: r.conditions, actions: r.actions, trigger: r.trigger };
}

function RulesList() {
  const rules = useRules((s) => s.rules);
  const loaded = useRules((s) => s.rulesLoaded);
  const folders = useApp((s) => s.folders);
  const accountMap = useAccountMap();
  const colorOf = useAccountColor();
  const [active, setActive] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const [drag, setDrag] = useState<{ id: number; from: number; over: number; dy: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);

  const folderName = (r: Rule): string | null => {
    const f = r.actions.moveToFolderId ? folders.find((x) => x.id === r.actions.moveToFolderId) : undefined;
    return f?.name ?? r.actions.moveToFolderPath ?? null;
  };

  const move = async (id: number, to: number) => {
    const from = rules.findIndex((r) => r.id === id);
    if (from < 0 || to < 0 || to >= rules.length || from === to) return;
    const next = [...rules];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    useRules.setState({ rules: next.map((r, i) => ({ ...r, position: i + 1 })) });
    setAnnounce(`${item!.name} moved to position ${to + 1} of ${rules.length}`);
    try {
      await call('rules.reorder', { ids: next.map((r) => r.id) });
    } catch (e) {
      toastError(asAppError(e).message);
      void useRules.getState().refetchRules();
    }
  };

  const remove = async (r: Rule) => {
    try {
      const gone = await call('rules.delete', { id: r.id });
      toast(`Rule '${gone.name}' deleted.`, {
        duration: 8000,
        actionLabel: 'Undo',
        onAction: () => {
          call('rules.create', { ...draftOf(gone), id: gone.id, position: gone.position }).catch((e) => toastError(asAppError(e).message));
        },
      });
    } catch (e) {
      toastError(asAppError(e).message);
    }
  };

  const toggle = async (r: Rule, enabled: boolean) => {
    useRules.setState((s) => ({ rules: s.rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)) }));
    try {
      await call('rules.update', { id: r.id, patch: { enabled } });
    } catch (e) {
      toastError(asAppError(e).message);
      void useRules.getState().refetchRules();
    }
  };

  const menuFor = (r: Rule, i: number): MenuEntry[] => [
    { label: 'Edit', icon: 'pencil', onSelect: () => openRuleEditor({ rule: r }) },
    { label: 'Run now...', icon: 'play', onSelect: () => useUi.getState().set({ runRules: { ruleId: r.id } }) },
    'sep',
    { label: 'Move up', icon: 'chev-up', disabled: i === 0, onSelect: () => void move(r.id, i - 1) },
    { label: 'Move down', icon: 'chev-d', disabled: i === rules.length - 1, onSelect: () => void move(r.id, i + 1) },
    'sep',
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void remove(r) },
  ];

  const onRowKey = (e: RKE<HTMLDivElement>, r: Rule, i: number) => {
    if (e.target !== e.currentTarget) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-rule-row]') ?? [])];
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
      void move(r.id, to).then(() => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-rule-row="${r.id}"]`)?.focus()));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[Math.min(rows.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      rows[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      void toggle(r, !r.enabled);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRuleEditor({ rule: r });
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void remove(r);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      useMenu.getState().open(rect.left + 60, rect.top + 40, menuFor(r, i));
    }
  };

  // ----- drag with the pointer -----
  const overIndexAt = (y: number): number => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-rule-row]') ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const rc = rows[i]!.getBoundingClientRect();
      if (y < rc.top + rc.height / 2) return i;
    }
    return rows.length - 1;
  };
  const onGripDown = (e: RPE<HTMLButtonElement>, r: Rule, i: number) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    setDrag({ id: r.id, from: i, over: i, dy: 0 });
  };
  const onGripMove = (e: RPE<HTMLButtonElement>) => {
    if (!drag) return;
    setDrag({ ...drag, over: overIndexAt(e.clientY), dy: e.clientY - startY.current });
  };
  const onGripUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.over !== d.from) void move(d.id, d.over);
  };

  if (!loaded) return <div className="hint">Loading rules...</div>;
  if (rules.length === 0) {
    return (
      <EmptyState
        icon="rules"
        title="No rules yet"
        text="Rules can sort new mail for you, for example move newsletters into their own folder."
        action={
          <Button variant="primary" icon="plus" onClick={() => openRuleEditor({})}>
            New rule
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div ref={listRef} className="rlist" role="list" aria-label="Rules">
        {rules.map((r, i) => {
          const acct = r.accountId ? accountMap.get(r.accountId) : undefined;
          const summary = r.warning ? r.warning.message : ruleSummary(r, folderName(r));
          const label = `${r.name}, rule ${i + 1} of ${rules.length}, ${r.enabled ? 'on' : 'off'}`;
          const dragging = drag?.id === r.id;
          const lineClass = drag && drag.over === i && drag.from !== i ? (drag.over > drag.from ? 'drop-after' : 'drop-before') : '';
          return (
            <div role="listitem" key={r.id}>
              <div
                data-rule-row={r.id}
                role="group"
                aria-label={label}
                aria-describedby={`rs-${r.id}`}
                tabIndex={active === r.id || (active === null && i === 0) ? 0 : -1}
                className={`rrow ${r.enabled ? '' : 'off'} ${r.warning ? 'problem' : ''} ${dragging ? 'lift' : ''} ${lineClass}`}
                style={dragging ? { transform: `translateY(${drag!.dy}px)` } : undefined}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setActive(r.id);
                }}
                onKeyDown={(e) => onRowKey(e, r, i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useMenu.getState().open(e.clientX, e.clientY, menuFor(r, i));
                }}
              >
                <span className="rnum" aria-hidden="true">{i + 1}</span>
                <button
                  type="button"
                  className="rgrip"
                  aria-label={`Reorder ${r.name}`}
                  aria-describedby="rgrip-hint"
                  tabIndex={-1}
                  onPointerDown={(e) => onGripDown(e, r, i)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => {
                    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault();
                      void move(r.id, e.key === 'ArrowUp' ? i - 1 : i + 1);
                    }
                  }}
                >
                  <Icon name="grip" />
                </button>
                <Switch checked={r.enabled} ariaLabel={`${r.name}, ${r.enabled ? 'on' : 'off'}`} onChange={(v) => void toggle(r, v)} />
                <div className="rmain">
                  <div className="rname" title={r.name}>{r.name}</div>
                  <div className={`rsum ${r.warning ? 'warn' : ''}`} id={`rs-${r.id}`} title={summary}>
                    {r.warning ? <Icon name="warn" /> : null}
                    <span>{summary}</span>
                  </div>
                </div>
                <div className="racct">
                  {acct ? (
                    <>
                      <AccountBadge color={colorOf(acct.id)} name={acct.displayName} letter={acct.badge} />
                      <span>{acct.displayName}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="stack" />
                      <span>All accounts</span>
                    </>
                  )}
                </div>
                <Button size="sm" variant="subtle" className="rrun" onClick={() => useUi.getState().set({ runRules: { ruleId: r.id } })}>
                  Run now
                </Button>
                <IconButton icon="pencil" label="Edit rule" size="sm" onClick={() => openRuleEditor({ rule: r })} />
                <IconButton icon="trash" label="Delete rule" size="sm" onClick={() => void remove(r)} />
                <IconButton
                  icon="more"
                  label={`More for ${r.name}`}
                  size="sm"
                  className="rmore"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    useMenu.getState().open(rect.left - 120, rect.bottom + 2, menuFor(r, i));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint rfoot">Rules run from top to bottom.</p>
      <span id="rgrip-hint" className="sr-only">Press Alt+Up or Alt+Down to move</span>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </>
  );
}

// ---------- activity ----------
function ActivityList() {
  const activity = useRules((s) => s.activity);
  const loaded = useRules((s) => s.activityLoaded);
  const accounts = useApp((s) => s.accounts);
  const accountMap = useAccountMap();
  const colorOf = useAccountColor();
  const [busy, setBusy] = useState<number | null>(null);
  const showBadge = accounts.length > 1;

  const undo = async (it: RuleActivityItem) => {
    setBusy(it.id);
    try {
      const r = await call('rulesActivity.undo', { id: it.id });
      toast(`Undone. ${r.restored === 1 ? 'The message is' : `${r.restored} messages are`} back where ${r.restored === 1 ? 'it was' : 'they were'}.`);
    } catch (e) {
      toastError(asAppError(e).message);
    } finally {
      setBusy(null);
      void useRules.getState().refetchActivity();
    }
  };

  const clear = async () => {
    try {
      await call('rulesActivity.clear');
      void useRules.getState().refetchActivity();
    } catch (e) {
      toastError(asAppError(e).message);
    }
  };

  const rows = useMemo(() => activity, [activity]);
  if (!loaded) return <div className="hint">Loading...</div>;
  if (rows.length === 0) {
    return <EmptyState icon="rules" title="No rule activity yet" text="When a rule moves or changes a message, you will see it here." />;
  }
  return (
    <>
      <div className="actHead">
        <h2>Rules activity</h2>
        <Button size="sm" variant="subtle" onClick={() => void clear()}>
          Clear list
        </Button>
      </div>
      <ul className="alist" aria-label="Rules activity">
        {rows.map((it) => {
          const acct = accountMap.get(it.accountId);
          return (
            <li key={it.id} className={`arow2 ${it.warning ? 'info' : ''}`}>
              <span className="atime">{activityTime(it.ts)}</span>
              <div className="amain">
                <div className="aline1">
                  <b className="aname">{it.ruleName}</b>
                  {it.ruleDeleted ? <span className="adel">(deleted)</span> : null}
                  <span className="awhat" title={[it.subject, it.sender].filter(Boolean).join(' - ')}>
                    {it.count > 1 ? `${it.count} messages${it.runNow ? ' (Run now)' : ''}` : [it.subject, it.sender].filter(Boolean).join(' from ') || ''}
                  </span>
                </div>
                <div className="aline2">
                  {it.warning ? <Icon name="warn" /> : null}
                  {it.summary}
                </div>
              </div>
              <span className="aacct">
                {showBadge && acct ? <AccountBadge color={colorOf(acct.id)} name={acct.displayName} letter={acct.badge} /> : null}
              </span>
              {it.warning ? <span className="acell" /> : it.undone ? (
                <span className="aundone acell">
                  <Icon name="check" />
                  Undone
                </span>
              ) : (
                <span className="acell" title={it.canUndo ? undefined : "Can't undo. The message was changed since."}>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!it.canUndo || busy === it.id}
                    aria-label={it.canUndo ? `Undo ${it.ruleName}` : "Can't undo. The message was changed since."}
                    onClick={() => void undo(it)}
                  >
                    Undo
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint rfoot">Shows the last 50 actions.</p>
    </>
  );
}
