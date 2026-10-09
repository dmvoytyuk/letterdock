import { useEffect, useId, useMemo, useState } from 'react';
import type { FolderId } from '../../../../shared/ipc';
import { Banner, Button, Dialog } from '../../components/ui';
import { useApp } from '../../store/app';
import { registerRun, useRules } from '../../store/rules';
import { useUi, type RunRulesRequest } from '../../store/ui';
import { asAppError, call } from '../../lib/api';
import { folderTitle } from '../../lib/actions';
import { orderFolders } from '../sidebar/Sidebar';

/** Hosted once in the app: opens when `ui.runRules` is set (the Run now button, the folder menu). */
export function RunRuleHost() {
  const req = useUi((s) => s.runRules);
  if (!req) return null;
  return <RunRuleDialog key={`${req.ruleId}-${req.folderId ?? ''}`} request={req} onClose={() => useUi.getState().set({ runRules: null })} />;
}

function RunRuleDialog({ request, onClose }: { request: RunRulesRequest; onClose: () => void }) {
  const rules = useRules((s) => s.rules);
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const [ruleChoice, setRuleChoice] = useState<number | 'all'>(request.ruleId);
  const [folderChoice, setFolderChoice] = useState<FolderId | 'allInboxes' | null>(request.folderId ?? null);
  const [total, setTotal] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ruleSel = useId();
  const folderSel = useId();
  const progress = useRules((s) => (runId ? s.progress[runId] : undefined));

  const rule = ruleChoice === 'all' ? undefined : rules.find((r) => r.id === ruleChoice);
  // A rule for one account can only look at that account's folders.
  const accountId = rule?.accountId ?? null;

  const options = useMemo(() => {
    const scope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
    return scope.map((a) => {
      const mine = folders.filter((f) => f.accountId === a.id && f.selectable);
      const { main, more } = orderFolders(mine);
      return { account: a, folders: [...main, ...more] };
    });
  }, [accounts, folders, accountId]);

  // Default folder: the Inbox (all Inboxes for a rule of every account).
  const resolvedFolder: FolderId | 'allInboxes' =
    folderChoice !== null && (folderChoice === 'allInboxes' || options.some((o) => o.folders.some((f) => f.id === folderChoice)))
      ? folderChoice
      : 'allInboxes';

  // "This will check 248 messages."
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      setTotal(null);
      call('rules.countMatches', {
        rule: { accountId, matchMode: 'all', conditions: [{ field: 'hasAttachment' }] },
        ...(resolvedFolder === 'allInboxes' ? {} : { folderId: resolvedFolder }),
      })
        .then((r) => alive && setTotal(r.total))
        .catch(() => alive && setTotal(null));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [accountId, resolvedFolder]);

  const running = runId !== null && (!progress || progress.state === 'running');
  // The run is over: the toast comes from the store; close the dialog.
  useEffect(() => {
    if (progress && progress.state !== 'running') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state]);

  const start = async () => {
    setStarting(true);
    setError(null);
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    registerRun(id, rule?.name ?? null);
    setRunId(id);
    try {
      await call('rules.runNow', { ruleId: ruleChoice, folderId: resolvedFolder, runId: id });
    } catch (e) {
      setRunId(null);
      setError(asAppError(e).message);
    } finally {
      setStarting(false);
    }
  };
  const stop = () => {
    if (runId) void call('rules.cancelRun', { runId }).catch(() => undefined);
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const forFolderMenu = request.ruleId === 'all';

  return (
    <Dialog title={forFolderMenu ? 'Run rules on this folder' : 'Run rule now'} size="sm" onClose={running ? stop : onClose} busy={starting}>
      <p>
        {rule ? `Apply '${rule.name}' to messages already in a folder.` : 'Apply your rules to messages already in a folder.'}
      </p>
      {request.ruleId === 'all' ? (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor={ruleSel}>Rules</label>
          <select id={ruleSel} className="inp" disabled={running} value={ruleChoice === 'all' ? 'all' : String(ruleChoice)} onChange={(e) => setRuleChoice(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All enabled rules</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor={folderSel}>Folder</label>
        <select
          id={folderSel}
          className="inp"
          disabled={running}
          value={String(resolvedFolder)}
          onChange={(e) => setFolderChoice(e.target.value === 'allInboxes' ? 'allInboxes' : Number(e.target.value))}
        >
          <option value="allInboxes">{accountId ? 'Inbox' : 'All Inboxes'}</option>
          {options.map((o) => (
            <optgroup key={o.account.id} label={o.account.displayName}>
              {o.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderTitle(f)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {running ? (
        <div className="runprog">
          <div className="bar" role="progressbar" aria-label="Rule progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <p className="hint" role="status">
            Checked {(progress?.done ?? 0).toLocaleString()} of {(progress?.total ?? total ?? 0).toLocaleString()} messages...
          </p>
        </div>
      ) : (
        <p className="hint" style={{ margin: '4px 0 0' }} aria-live="polite">
          {total === null ? 'Counting messages...' : `This will check ${total.toLocaleString()} ${total === 1 ? 'message' : 'messages'}.`}
        </p>
      )}
      {error ? (
        <div style={{ marginTop: 8 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}
      <div className="foot">
        {running ? (
          <Button onClick={stop}>Cancel</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={starting} disabled={ruleChoice !== 'all' && !rule} onClick={() => void start()}>
              {forFolderMenu ? 'Run rules' : 'Run rule'}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
