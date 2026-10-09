// Rules (DESIGN-SPEC 3.12): sort new mail on this PC.
//
// Automatic run: after a sync stored new mail and BEFORE the "new mail" notification is decided
// (AccountSession calls `onNewMail`). Only mail that arrived after the first full sync, dated within the
// last 3 days, once per message (`message.rules_done`), never in Spam, Trash, Drafts or Sent.
// Every change goes through the normal action queue (ActionService), so it is optimistic, follows
// the offline queue and reaches the server like the user's own actions.
import type {
  AppError,
  CountMatchesReq,
  CountMatchesRes,
  CreateRuleReq,
  FolderId,
  MessageAction,
  MessageId,
  Rule,
  RuleActivityItem,
  RuleCondition,
  RuleDraft,
  RulesProgress,
  RunRulesReq,
} from '../../shared/ipc';
import { MAX_RULE_CONDITIONS, MAX_RULES } from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import { fold } from '../contacts/text';
import type { EngineContext, RulesApi } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import type { MessageRow } from '../db/repos/messageRepo';
import {
  RulesRepo,
  rowToRule,
  type ActivityRow,
  type RuleRow,
  type UndoItem,
} from '../db/repos/rulesRepo';
import type { ActionService } from './actionService';

const DAY_MS = 86_400_000;
/** Mail older than this is not sorted automatically. */
export const AUTO_MAX_AGE_MS = 3 * DAY_MS;
/** Rules never touch these folders by themselves ("All Mail" of Gmail holds everything twice). */
const SKIP_ROLES = new Set(['junk', 'trash', 'drafts', 'sent', 'all']);
const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 5;
const DEFAULT_BATCH = 500;

// ---------- matching (pure) ----------

export interface MatchInput {
  from: string;
  toCc: string;
  subject: string;
  hasAttachment: boolean;
}

interface AddrJson {
  name?: string;
  address?: string;
}

function people(json: string): string {
  try {
    return (JSON.parse(json) as AddrJson[]).map((a) => `${a.name ?? ''}\n${a.address ?? ''}`).join('\n');
  } catch {
    return '';
  }
}

export function matchInputOf(r: {
  subject: string;
  from_name: string | null;
  from_addr: string | null;
  to_json: string;
  cc_json: string;
  has_attachments: number;
}): MatchInput {
  return {
    from: fold(`${r.from_name ?? ''}\n${r.from_addr ?? ''}`),
    toCc: fold(`${people(r.to_json)}\n${people(r.cc_json)}`),
    subject: fold(r.subject),
    hasAttachment: r.has_attachments === 1,
  };
}

/** "Contains": case and accent insensitive, the text is literal (no wildcards, no regular expressions). */
export function conditionMatches(c: RuleCondition, m: MatchInput): boolean {
  if (c.field === 'hasAttachment') return m.hasAttachment;
  const needle = fold((c.value ?? '').trim());
  if (needle === '') return false;
  const hay = c.field === 'from' ? m.from : c.field === 'toCc' ? m.toCc : m.subject;
  return hay.includes(needle);
}

export function rulesMatch(
  conditions: RuleCondition[],
  mode: 'all' | 'any',
  m: MatchInput,
): boolean {
  if (conditions.length === 0) return false;
  return mode === 'all'
    ? conditions.every((c) => conditionMatches(c, m))
    : conditions.some((c) => conditionMatches(c, m));
}

// ---------- planning ----------

interface Prepared {
  rule: Rule;
  /** The folder the rule moves to (null: it does not move to a folder). */
  target: FolderRow | null;
}

interface Hit {
  rule: Rule;
  move: { folder: FolderRow; trash: boolean } | null;
  markRead: boolean;
  flag: boolean;
}

interface Item {
  rule: Rule;
  accountId: string;
  subject: string;
  sender: string;
  undo: UndoItem;
  moveName: string | null;
  trash: boolean;
  read: boolean;
  flag: boolean;
}

interface Stats {
  checked: number;
  matched: number;
  moved: number;
  trashed: number;
  markedRead: number;
  flagged: number;
}
const newStats = (): Stats => ({ checked: 0, matched: 0, moved: 0, trashed: 0, markedRead: 0, flagged: 0 });

function describe(items: Item[]): string {
  const parts: string[] = [];
  const names = new Set(items.filter((i) => i.moveName && !i.trash).map((i) => i.moveName!));
  if (items.some((i) => i.trash)) parts.push('moved to Trash');
  for (const n of names) parts.push(`moved to ${n}`);
  if (items.some((i) => i.read)) parts.push('marked as read');
  if (items.some((i) => i.flag)) parts.push('flagged');
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const senderOf = (r: MessageRow): string => r.from_name?.trim() || r.from_addr || '';

export class RulesService implements RulesApi {
  private readonly repo: RulesRepo;
  private runs = new Map<string, { cancelled: boolean }>();
  private refreshQueued = false;

  constructor(
    private readonly ctx: EngineContext,
    private readonly actions: ActionService,
  ) {
    this.repo = new RulesRepo(ctx.db);
    ctx.rules = this;
    // A folder came or went: rules that move into it may have lost their target.
    ctx.hub.observe((e) => {
      if (e.type === 'folders:changed' && !this.refreshQueued) {
        this.refreshQueued = true;
        queueMicrotask(() => {
          this.refreshQueued = false;
          this.refreshTargets();
        });
      }
    });
  }

  // ---------- RulesApi ----------

  hasRulesFor(accountId: string): boolean {
    return this.repo.countForAccount(accountId) > 0;
  }

  afterAccountRemoved(): void {
    this.repo.renumber();
    this.ctx.hub.emit({ type: 'rules:changed' });
    this.ctx.hub.emit({ type: 'rulesActivity:changed' });
  }

  async onNewMail(folder: FolderRow, res: { kind: string; added: number[] }): Promise<void> {
    if (res.kind !== 'incremental' || res.added.length === 0) return;
    if (SKIP_ROLES.has(folder.role ?? '')) return;
    const rows: MessageRow[] = [];
    for (const id of res.added) {
      const r = this.ctx.messages.row(id);
      if (r && (r.rules_done ?? 0) === 0 && r.uid > 0 && r.flag_deleted === 0 && r.flag_draft === 0) rows.push(r);
    }
    if (rows.length === 0) return;
    // Each message is looked at once, whatever the rules say.
    const mark = this.ctx.db.prepare('UPDATE message SET rules_done = 1 WHERE id = ?');
    this.ctx.db.transaction(() => rows.forEach((r) => mark.run(r.id)))();

    const cutoff = this.ctx.now() - AUTO_MAX_AGE_MS;
    const eligible = rows.filter(
      (r) =>
        r.internal_ms >= cutoff &&
        // Mail we moved here ourselves (undo, "not spam") is not new mail.
        !(r.message_id && this.ctx.recentMoves.has(`${r.account_id}|${r.message_id}`)),
    );
    if (eligible.length === 0) return;
    const prepared = this.prepare(this.enabledRules());
    if (prepared.length === 0) return;
    const size = this.ctx.rulesBatchSize ?? DEFAULT_BATCH;
    for (let i = 0; i < eligible.length; i += size) {
      const batch = eligible.slice(i, i + size);
      const out = await this.process(batch, prepared, 'auto');
      this.recordGroups(out.items, false);
    }
  }

  // ---------- rules: list and edit ----------

  list(): Rule[] {
    this.refreshTargets();
    return this.repo.list();
  }

  private enabledRules(): Rule[] {
    return this.repo.list().filter((r) => r.enabled);
  }

  private require(id: number): RuleRow {
    const r = this.repo.row(id);
    if (!r) throw new AppException('NOT_FOUND', 'That rule is no longer there.');
    return r;
  }

  private changed(): void {
    this.ctx.hub.emit({ type: 'rules:changed' });
  }

  private activityChanged(): void {
    this.ctx.hub.emit({ type: 'rulesActivity:changed' });
  }

  /** Check a draft and fill in what the engine owns (the folder path). Returns the row values. */
  private normalize(
    d: RuleDraft,
    keepFolder: { id: number | null; path: string | null; warning: string } | null,
  ): Omit<RuleRow, 'id' | 'position' | 'created_at'> {
    const name = d.name.trim();
    if (name.length < 1 || name.length > 60) {
      throw new AppException('INVALID_INPUT', 'Give the rule a name of 1 to 60 characters.');
    }
    if (d.conditions.length < 1 || d.conditions.length > MAX_RULE_CONDITIONS) {
      throw new AppException('INVALID_INPUT', `A rule needs 1 to ${MAX_RULE_CONDITIONS} conditions.`);
    }
    const conditions: RuleCondition[] = d.conditions.map((c) => {
      if (c.field === 'hasAttachment') return { field: c.field };
      const value = (c.value ?? '').trim();
      if (value === '') throw new AppException('INVALID_INPUT', 'Type some text to look for.');
      if (value.length > 500) throw new AppException('INVALID_INPUT', 'The text to look for is too long.');
      return { field: c.field, value };
    });
    const a = d.actions;
    const wantsMove = a.moveToFolderId !== undefined && a.moveToFolderId !== null;
    if (wantsMove && a.delete) {
      throw new AppException('INVALID_INPUT', 'Move to a folder and Delete cannot be used together.');
    }
    if (!wantsMove && !a.delete && !a.markRead && !a.flag) {
      throw new AppException('INVALID_INPUT', 'Choose what the rule should do.');
    }
    let folderId: number | null = null;
    let folderPath: string | null = null;
    if (wantsMove && keepFolder) {
      // A switched-off rule whose folder is gone keeps pointing at it until the user picks another.
      folderId = keepFolder.id;
      folderPath = keepFolder.path;
    } else if (wantsMove) {
      if (d.accountId === null) {
        throw new AppException('INVALID_INPUT', 'Choose one account to pick a folder.');
      }
      const f = this.ctx.folders.row(a.moveToFolderId!);
      if (!f || f.account_id !== d.accountId) {
        throw new AppException('INVALID_INPUT', 'Choose a folder of the same account.');
      }
      if (f.selectable !== 1) throw new AppException('INVALID_INPUT', 'You cannot move mail into this folder.');
      folderId = f.id;
      folderPath = f.path;
    }
    if (d.accountId !== null && !this.ctx.accounts.get(d.accountId)) {
      throw new AppException('NOT_FOUND', 'Account not found.');
    }
    return {
      name,
      enabled: d.enabled ? 1 : 0,
      account_id: d.accountId,
      match_mode: d.matchMode,
      conditions_json: JSON.stringify(conditions),
      move_folder_id: folderId,
      move_folder_path: folderPath,
      mark_read: a.markRead ? 1 : 0,
      flag: a.flag ? 1 : 0,
      delete_to_trash: a.delete ? 1 : 0,
      stop: a.stop ? 1 : 0,
      run_on: d.trigger,
      warning: wantsMove && keepFolder ? keepFolder.warning : null,
    };
  }

  create(req: CreateRuleReq): Rule {
    if (this.repo.count() >= MAX_RULES) {
      throw new AppException('INVALID_INPUT', `You have ${MAX_RULES} rules. Delete one to add another.`);
    }
    if (req.id !== undefined && this.repo.row(req.id)) {
      throw new AppException('INVALID_INPUT', 'A rule with this id exists already.');
    }
    const v = this.normalize(req, null);
    const order = this.repo.rows().map((r) => r.id);
    const id = this.repo.insert({
      ...v,
      id: req.id,
      position: order.length + 1,
      created_at: this.ctx.now(),
    });
    if (req.position !== undefined) {
      const at = Math.min(Math.max(req.position, 1), order.length + 1) - 1;
      order.splice(at, 0, id);
    } else {
      order.push(id);
    }
    this.repo.setOrder(order);
    this.changed();
    return rowToRule(this.require(id));
  }

  update(id: number, patch: Partial<RuleDraft>): Rule {
    const cur = this.require(id);
    const now = rowToRule(cur);
    const merged: RuleDraft = {
      name: patch.name ?? now.name,
      enabled: patch.enabled ?? now.enabled,
      accountId: patch.accountId !== undefined ? patch.accountId : now.accountId,
      matchMode: patch.matchMode ?? now.matchMode,
      conditions: patch.conditions ?? now.conditions,
      actions: { ...now.actions, ...(patch.actions ?? {}) },
      trigger: patch.trigger ?? now.trigger,
    };
    // Changing the account without choosing a new folder drops the old folder.
    if (patch.accountId !== undefined && patch.accountId !== now.accountId && !patch.actions) {
      merged.actions = { ...merged.actions, moveToFolderId: null, moveToFolderPath: null };
    }
    // A rule whose folder is missing stays off until another folder is chosen.
    const folderChanged =
      patch.actions?.moveToFolderId !== undefined && patch.actions.moveToFolderId !== now.actions.moveToFolderId;
    const stillMissing = !!cur.warning && !folderChanged && now.actions.moveToFolderId != null;
    if (stillMissing && merged.enabled) throw new AppException('INVALID_INPUT', cur.warning!);
    const v = this.normalize(
      merged,
      stillMissing ? { id: cur.move_folder_id, path: cur.move_folder_path, warning: cur.warning! } : null,
    );
    this.repo.save({ ...cur, ...v });
    this.changed();
    return rowToRule(this.require(id));
  }

  delete(id: number): Rule {
    const cur = this.require(id);
    const rule = rowToRule(cur);
    this.repo.delete(id);
    this.repo.renumber();
    this.changed();
    this.activityChanged(); // the activity list shows "(deleted)" now
    return rule;
  }

  reorder(ids: number[]): Rule[] {
    const have = this.repo.rows().map((r) => r.id);
    if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => have.includes(i))) {
      throw new AppException('INVALID_INPUT', 'The list of rules changed. Try again.');
    }
    this.repo.setOrder(ids);
    this.changed();
    return this.repo.list();
  }

  // ---------- target folders ----------

  /** The folder a rule moves to, found by id, else by path. Refreshes the stored id and path. */
  private resolveTarget(row: RuleRow): FolderRow | null {
    if (row.move_folder_id === null && row.move_folder_path === null) return null;
    let f = row.move_folder_id !== null ? this.ctx.folders.row(row.move_folder_id) : null;
    if (f && row.account_id !== null && f.account_id !== row.account_id) f = null;
    if (!f && row.move_folder_path !== null && row.account_id !== null) {
      f = this.ctx.folders.rowByPath(row.account_id, row.move_folder_path);
    }
    if (f && (f.id !== row.move_folder_id || f.path !== row.move_folder_path)) {
      this.repo.save({ ...row, move_folder_id: f.id, move_folder_path: f.path });
    }
    return f;
  }

  private leafName(accountId: string | null, path: string | null): string {
    if (!path) return 'folder';
    const rows = accountId ? this.ctx.folders.rowsForAccount(accountId) : [];
    const delim = rows.find((r) => r.delimiter)?.delimiter ?? null;
    return delim ? (path.split(delim).pop() ?? path) : path;
  }

  /** The target is gone: switch the rule off and say why. */
  private disableForMissingFolder(row: RuleRow): void {
    const name = this.leafName(row.account_id, row.move_folder_path);
    const message = `Folder '${name}' is missing. Edit the rule to choose another.`;
    this.repo.save({ ...row, enabled: 0, warning: message });
    this.repo.insertActivity({
      ts: this.ctx.now(),
      rule_id: row.id,
      rule_name: row.name,
      account_id: row.account_id ?? this.ctx.accounts.list()[0]?.id ?? '',
      count: 0,
      subject: null,
      sender: null,
      summary: `Turned off: folder '${name}' is missing`,
      undo_json: '[]',
      undone: 0,
      run_now: 0,
      kind: 'warning',
    });
    this.changed();
    this.activityChanged();
  }

  /** Check every rule that moves mail: switch off the ones whose folder is gone. */
  refreshTargets(): void {
    for (const row of this.repo.rows()) {
      if (row.move_folder_id === null && row.move_folder_path === null) continue;
      if (row.enabled !== 1) continue;
      if (this.resolveTarget(row) === null) this.disableForMissingFolder(this.repo.row(row.id)!);
    }
  }

  /** Rules to run now, with their target folders. A rule without its folder is switched off and left out. */
  private prepare(rules: Rule[]): Prepared[] {
    const out: Prepared[] = [];
    for (const rule of rules) {
      const row = this.repo.row(rule.id);
      if (!row) continue;
      const wantsFolder = row.move_folder_id !== null || row.move_folder_path !== null;
      const target = wantsFolder ? this.resolveTarget(row) : null;
      if (wantsFolder && !target) {
        if (row.enabled === 1) this.disableForMissingFolder(this.repo.row(rule.id)!);
        continue;
      }
      out.push({ rule, target });
    }
    return out;
  }

  // ---------- evaluating and applying ----------

  private evaluate(
    row: MessageRow,
    folder: FolderRow | null,
    prepared: Prepared[],
    mode: 'auto' | 'manual',
  ): Hit[] {
    const m = matchInputOf(row);
    let moveTaken = false;
    let readDone = row.flag_seen === 1;
    let flagDone = row.flag_flagged === 1;
    const hits: Hit[] = [];
    for (const p of prepared) {
      const rule = p.rule;
      if (rule.accountId !== null && rule.accountId !== row.account_id) continue;
      if (mode === 'auto' && rule.trigger === 'inbox' && folder?.role !== 'inbox') continue;
      if (!rulesMatch(rule.conditions, rule.matchMode, m)) continue;
      const hit: Hit = { rule, move: null, markRead: false, flag: false };
      if (!moveTaken) {
        if (p.target) {
          moveTaken = true; // the first Move wins, even when it changes nothing
          if (p.target.id !== row.folder_id) hit.move = { folder: p.target, trash: false };
        } else if (rule.actions.delete) {
          const trash = this.ctx.folders.rowByRole(row.account_id, 'trash');
          // Delete only ever means "to Trash"; an account without Trash is left alone.
          if (trash) {
            moveTaken = true;
            if (trash.id !== row.folder_id) hit.move = { folder: trash, trash: true };
          }
        }
      }
      if (rule.actions.markRead && !readDone) {
        hit.markRead = true;
        readDone = true;
      }
      if (rule.actions.flag && !flagDone) {
        hit.flag = true;
        flagDone = true;
      }
      if (hit.move || hit.markRead || hit.flag) hits.push(hit);
      if (rule.actions.stop) break;
    }
    return hits;
  }

  /** Evaluate and apply to a batch of messages. Nothing here is permanent: moves go to a folder or Trash. */
  private async process(
    rows: MessageRow[],
    prepared: Prepared[],
    mode: 'auto' | 'manual',
  ): Promise<{ items: Item[]; stats: Stats }> {
    const stats = newStats();
    const plan: { row: MessageRow; hits: Hit[] }[] = [];
    const folderCache = new Map<number, FolderRow | null>();
    for (const row of rows) {
      stats.checked++;
      let folder = folderCache.get(row.folder_id);
      if (folder === undefined) {
        folder = this.ctx.folders.row(row.folder_id);
        folderCache.set(row.folder_id, folder);
      }
      const hits = this.evaluate(row, folder, prepared, mode);
      if (hits.length > 0) {
        stats.matched++;
        plan.push({ row, hits });
      }
    }
    if (plan.length === 0) return { items: [], stats };

    const readIds = new Set<MessageId>();
    const flagIds = new Set<MessageId>();
    const moves = new Map<FolderId, Set<MessageId>>();
    for (const { row, hits } of plan) {
      for (const h of hits) {
        if (h.markRead) readIds.add(row.id);
        if (h.flag) flagIds.add(row.id);
        if (h.move) {
          const set = moves.get(h.move.folder.id) ?? new Set<MessageId>();
          set.add(row.id);
          moves.set(h.move.folder.id, set);
        }
      }
    }
    const ok = async (ids: Set<MessageId>, action: MessageAction): Promise<Set<MessageId>> => {
      if (ids.size === 0) return new Set();
      try {
        const res = await this.actions.applyQuiet([...ids], action);
        return new Set(res.succeeded);
      } catch (e) {
        this.ctx.log.warn({ err: toAppError(e).message }, 'a rule could not change messages');
        return new Set();
      }
    };
    const readOk = await ok(readIds, { type: 'markRead', read: true });
    const flagOk = await ok(flagIds, { type: 'flag', flagged: true });
    const moveOk = new Map<FolderId, Set<MessageId>>();
    for (const [dest, ids] of moves) {
      moveOk.set(dest, await ok(ids, { type: 'move', destFolderId: dest }));
    }

    const items: Item[] = [];
    for (const { row, hits } of plan) {
      for (const h of hits) {
        const moved = !!h.move && !!moveOk.get(h.move.folder.id)?.has(row.id);
        const read = h.markRead && readOk.has(row.id);
        const flag = h.flag && flagOk.has(row.id);
        if (!moved && !read && !flag) continue;
        if (moved) {
          stats.moved++;
          if (h.move!.trash) stats.trashed++;
        }
        if (read) stats.markedRead++;
        if (flag) stats.flagged++;
        items.push({
          rule: h.rule,
          accountId: row.account_id,
          subject: row.subject,
          sender: senderOf(row),
          moveName: moved ? h.move!.folder.name : null,
          trash: moved && h.move!.trash,
          read,
          flag,
          undo: {
            id: row.id,
            fromFolderId: row.folder_id,
            movedToFolderId: moved ? h.move!.folder.id : null,
            readChanged: read,
            flagChanged: flag,
          },
        });
      }
    }
    return { items, stats };
  }

  // ---------- activity ----------

  /** Write the activity entries for items of a batch or a whole run. Returns the entry ids. */
  private recordGroups(items: Item[], runNow: boolean): number[] {
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      const key = `${it.rule.id}|${it.accountId}`;
      const list = groups.get(key) ?? [];
      list.push(it);
      groups.set(key, list);
    }
    const ids: number[] = [];
    for (const list of groups.values()) ids.push(...this.recordRule(list, runNow));
    if (ids.length > 0) this.activityChanged();
    return ids;
  }

  private recordRule(list: Item[], runNow: boolean): number[] {
    const first = list[0]!;
    const base = {
      ts: this.ctx.now(),
      rule_id: first.rule.id,
      rule_name: first.rule.name,
      account_id: first.accountId,
      undone: 0,
      run_now: runNow ? 1 : 0,
      kind: 'change' as const,
    };
    // A Run now, and a burst of more than 5 messages, is one entry.
    if (runNow || list.length > BURST_LIMIT) {
      return [
        this.repo.insertActivity({
          ...base,
          count: list.length,
          subject: list.length === 1 ? first.subject : null,
          sender: list.length === 1 ? first.sender : null,
          summary: describe(list),
          undo_json: JSON.stringify(list.map((i) => i.undo)),
        }),
      ];
    }
    const ids = list.map((i) =>
      this.repo.insertActivity({
        ...base,
        count: 1,
        subject: i.subject,
        sender: i.sender,
        summary: describe([i]),
        undo_json: JSON.stringify([i.undo]),
      }),
    );
    // Single entries of the same rule within a minute that add up to more than 5: one entry.
    const recent = this.repo.recentOfRule(first.rule.id, first.accountId, this.ctx.now() - BURST_WINDOW_MS);
    if (recent.reduce((n, r) => n + r.count, 0) > BURST_LIMIT) {
      const undo: UndoItem[] = recent.flatMap((r) => JSON.parse(r.undo_json) as UndoItem[]);
      const keep = recent[0]!;
      this.repo.updateActivity(keep.id, {
        count: recent.reduce((n, r) => n + r.count, 0),
        subject: null,
        sender: null,
        summary: keep.summary,
        undo_json: JSON.stringify(undo),
      });
      this.repo.deleteActivity(recent.slice(1).map((r) => r.id));
      return [keep.id];
    }
    return ids;
  }

  /** Is this change still as the rule left it? */
  private unchanged(u: UndoItem): boolean {
    const r = this.ctx.messages.row(u.id);
    if (!r || r.flag_deleted === 1) return false;
    if (u.movedToFolderId !== null && r.folder_id !== u.movedToFolderId) return false;
    if (u.readChanged && r.flag_seen !== 1) return false;
    if (u.flagChanged && r.flag_flagged !== 1) return false;
    return true;
  }

  private toItem(a: ActivityRow, ruleIds: Set<number>): RuleActivityItem {
    let undo: UndoItem[] = [];
    try {
      undo = JSON.parse(a.undo_json) as UndoItem[];
    } catch {
      /* nothing to undo */
    }
    return {
      id: a.id,
      ts: a.ts,
      ruleId: a.rule_id !== null && ruleIds.has(a.rule_id) ? a.rule_id : null,
      ruleName: a.rule_name,
      ruleDeleted: a.rule_id === null || !ruleIds.has(a.rule_id),
      accountId: a.account_id,
      count: a.count,
      subject: a.subject,
      sender: a.sender,
      summary: a.summary,
      runNow: a.run_now === 1,
      undone: a.undone === 1,
      canUndo: a.kind === 'change' && a.undone === 0 && undo.some((u) => this.unchanged(u)),
      warning: a.kind === 'warning',
    };
  }

  activityList(): RuleActivityItem[] {
    const ids = new Set(this.repo.rows().map((r) => r.id));
    return this.repo.activity().map((a) => this.toItem(a, ids));
  }

  clearActivity(): void {
    this.repo.clearActivity();
    this.activityChanged();
  }

  /** Reverse the entry: move back, mark unread, unflag. Messages that changed since are left alone. */
  async undoActivity(id: number): Promise<{ restored: number }> {
    const a = this.repo.activityRow(id);
    if (!a) throw new AppException('NOT_FOUND', 'That entry is no longer there.');
    if (a.kind !== 'change') throw new AppException('INVALID_INPUT', 'There is nothing to undo here.');
    if (a.undone === 1) throw new AppException('INVALID_INPUT', 'This was undone already.');
    const undo = JSON.parse(a.undo_json) as UndoItem[];
    const todo = undo.filter((u) => this.unchanged(u));
    if (todo.length === 0) {
      throw new AppException('INVALID_INPUT', "Can't undo. The message was changed since.");
    }
    const back = new Map<FolderId, MessageId[]>();
    const unread: MessageId[] = [];
    const unflag: MessageId[] = [];
    for (const u of todo) {
      if (u.movedToFolderId !== null) {
        back.set(u.fromFolderId, [...(back.get(u.fromFolderId) ?? []), u.id]);
      }
      if (u.readChanged) unread.push(u.id);
      if (u.flagChanged) unflag.push(u.id);
    }
    const restored = new Set<MessageId>();
    if (unread.length > 0) {
      const r = await this.actions.applyQuiet(unread, { type: 'markRead', read: false });
      r.succeeded.forEach((i) => restored.add(i));
    }
    if (unflag.length > 0) {
      const r = await this.actions.applyQuiet(unflag, { type: 'flag', flagged: false });
      r.succeeded.forEach((i) => restored.add(i));
    }
    for (const [folderId, ids] of back) {
      if (!this.ctx.folders.row(folderId)) continue; // the old folder is gone
      const r = await this.actions.applyQuiet(ids, { type: 'move', destFolderId: folderId });
      r.succeeded.forEach((i) => restored.add(i));
    }
    if (restored.size === 0) {
      throw new AppException('INVALID_INPUT', "Can't undo. The message was changed since.");
    }
    this.repo.updateActivity(id, { undone: 1 });
    this.activityChanged();
    return { restored: restored.size };
  }

  // ---------- counting and running ----------

  private folderRowsFor(accountId: string | null, folderId: FolderId | 'allInboxes' | undefined): FolderRow[] {
    if (folderId !== undefined && folderId !== 'allInboxes') {
      const f = this.ctx.folders.row(folderId);
      if (!f) throw new AppException('NOT_FOUND', 'Folder not found.');
      if (accountId !== null && f.account_id !== accountId) {
        throw new AppException('INVALID_INPUT', 'This rule is for another account.');
      }
      return [f];
    }
    return this.ctx.accounts
      .list()
      .filter((a) => accountId === null || a.id === accountId)
      .map((a) => this.ctx.folders.rowByRole(a.id, 'inbox'))
      .filter((f): f is FolderRow => f !== null);
  }

  countMatches(req: CountMatchesReq): CountMatchesRes {
    const conditions = req.rule.conditions
      .filter((c) => c.field === 'hasAttachment' || (c.value ?? '').trim() !== '')
      .map((c) => ({ ...c, value: c.value?.trim() }));
    const folders = this.folderRowsFor(req.rule.accountId, req.folderId);
    if (folders.length === 0) return { matches: 0, total: 0 };
    const marks = folders.map(() => '?').join(',');
    const it = this.ctx.db
      .prepare(
        `SELECT subject, from_name, from_addr, to_json, cc_json, has_attachments FROM message
          WHERE folder_id IN (${marks}) AND flag_deleted = 0 AND flag_draft = 0 AND uid > 0`,
      )
      .iterate(...folders.map((f) => f.id)) as IterableIterator<Parameters<typeof matchInputOf>[0]>;
    let matches = 0;
    let total = 0;
    for (const row of it) {
      total++;
      if (conditions.length > 0 && rulesMatch(conditions, req.rule.matchMode, matchInputOf(row))) matches++;
    }
    return { matches, total };
  }

  runNow(req: RunRulesReq): { runId: string } {
    if (this.runs.has(req.runId)) throw new AppException('INVALID_INPUT', 'This run exists already.');
    let rules: Rule[];
    if (req.ruleId === 'all') {
      rules = this.enabledRules();
    } else {
      const row = this.require(req.ruleId);
      rules = [rowToRule(row)];
    }
    const accountScope = req.ruleId === 'all' ? null : rules[0]!.accountId;
    const folders = this.folderRowsFor(accountScope, req.folderId);
    const run = { cancelled: false };
    this.runs.set(req.runId, run);
    void this.runJob(req, folders, run).finally(() => this.runs.delete(req.runId));
    return { runId: req.runId };
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run) run.cancelled = true;
  }

  private async runJob(req: RunRulesReq, folders: FolderRow[], run: { cancelled: boolean }): Promise<void> {
    const size = this.ctx.rulesBatchSize ?? DEFAULT_BATCH;
    const stats = newStats();
    const items: Item[] = [];
    const folderIds = folders.map((f) => f.id);
    const marks = folderIds.map(() => '?').join(',');
    let total = 0;
    const emit = (p: Partial<RulesProgress> & Pick<RulesProgress, 'state'>) =>
      this.ctx.hub.emit({
        type: 'rules:progress',
        runId: req.runId,
        done: stats.checked,
        total,
        matched: stats.matched,
        moved: stats.moved,
        trashed: stats.trashed,
        markedRead: stats.markedRead,
        flagged: stats.flagged,
        activityIds: [],
        ...p,
      });
    try {
      if (folderIds.length > 0) {
        total = (
          this.ctx.db
            .prepare(
              `SELECT COUNT(*) AS n FROM message WHERE folder_id IN (${marks}) AND flag_deleted = 0 AND flag_draft = 0 AND uid > 0`,
            )
            .get(...folderIds) as { n: number }
        ).n;
      }
      emit({ state: 'running' });
      let lastId = 0;
      const page = this.ctx.db.prepare(
        `SELECT id FROM message WHERE folder_id IN (${marks}) AND id > ? AND flag_deleted = 0 AND flag_draft = 0 AND uid > 0
          ORDER BY id LIMIT ?`,
      );
      while (folderIds.length > 0 && !run.cancelled) {
        const ids = (page.all(...folderIds, lastId, size) as { id: number }[]).map((r) => r.id);
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1]!;
        const rows = ids.map((i) => this.ctx.messages.row(i)).filter((r): r is MessageRow => r !== null);
        // The list of rules is read again for every batch (it may be edited while this runs).
        const rules =
          req.ruleId === 'all'
            ? this.enabledRules()
            : (() => {
                const row = this.repo.row(req.ruleId as number);
                return row ? [rowToRule(row)] : [];
              })();
        const prepared = this.prepare(rules);
        const out = await this.process(rows, prepared, 'manual');
        items.push(...out.items);
        for (const k of Object.keys(stats) as (keyof Stats)[]) stats[k] += out.stats[k];
        emit({ state: 'running' });
        // Let the engine breathe between batches (sync, the UI and other actions go on).
        await new Promise<void>((r) => setImmediate(r));
      }
      const activityIds = this.recordGroups(items, true);
      emit({ state: run.cancelled ? 'cancelled' : 'finished', activityIds });
    } catch (e) {
      const error: AppError = toAppError(e);
      this.ctx.log.warn({ err: error.message }, 'running rules failed');
      const activityIds = this.recordGroups(items, true);
      emit({ state: 'failed', error, activityIds });
    }
  }
}
