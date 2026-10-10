// ============================== src/shared/ipc.ts ==============================
// The ONLY boundary between backend (main + engine) and frontend (renderer).
// Normative description: docs/ARCHITECTURE.md section 6 (plus section 0 additions).
// Pure TypeScript: no node / electron imports.

// ---------- primitives ----------
export type AccountId = string;
export type FolderId = number;
export type MessageId = number;
export type EpochMs = number;

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'OAUTH_REAUTH_REQUIRED'
  | 'OAUTH_NOT_CONFIGURED'
  | 'SMTP_AUTH_DISABLED'
  | 'TLS_ERROR'
  | 'HOST_UNREACHABLE'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SERVER_REJECTED'
  | 'QUOTA'
  | 'DB_ERROR'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string; // user-presentable
  retryable: boolean;
  details?: string; // technical, for logs / "show details"
}

export interface Address {
  name?: string;
  address: string;
}

// ---------- domain models ----------
export type AuthType = 'password' | 'oauth2';
export type OAuthProvider = 'microsoft' | 'google';
export type ProviderId = 'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'generic';
export type Security = 'ssl' | 'starttls';

export interface ServerEndpoint {
  host: string;
  port: number;
  security: Security;
}

export interface Account {
  id: AccountId;
  email: string;
  displayName: string;
  color: string | null;
  provider: ProviderId;
  authType: AuthType;
  oauthProvider: OAuthProvider | null;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  username: string;
  syncDays: number;
  signature: string | null;
  enabled: boolean;
  sortOrder: number;
  /** 1-2 characters shown in the account avatar tile (DESIGN-SPEC 1.7). Default: first letter. */
  badge: string;
}

export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'syncing'
  | 'retrying'
  | 'offline'
  | 'auth_failed'
  | 'needs_reauth'
  | 'disabled';

export interface AccountStatus {
  accountId: AccountId;
  state: ConnectionState;
  lastSyncAt: EpochMs | null;
  error: AppError | null;
  nextRetryAt: EpochMs | null;
  /**
   * Changes (read, flag, move, delete) kept on this PC that are not on the server yet.
   * 0 when everything is in sync. Shown as "N changes waiting to sync".
   */
  pendingCount: number;
}

export type FolderRole =
  'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';

export interface Folder {
  id: FolderId;
  accountId: AccountId;
  path: string;
  name: string;
  role: FolderRole | null;
  delimiter: string | null;
  unreadCount: number;
  totalCount: number;
  selectable: boolean;
}

export interface MessageHeader {
  id: MessageId;
  accountId: AccountId;
  folderId: FolderId;
  uid: number;
  messageIdHeader: string | null;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: EpochMs;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  size: number | null;
  bodyCached: boolean;
  /**
   * Drafts only (absent on other messages). True while the latest text of this draft exists only
   * on this PC (not yet on the server). Optional, so older code keeps working.
   */
  localOnly?: boolean;
  /**
   * Drafts only. Server upload state: 'saving' (upload waiting or running), 'queued' (offline, the
   * upload waits for the connection; counted in AccountStatus.pendingCount), 'failed' (online, the
   * upload failed; it is retried automatically, or at once with `drafts.retrySave`), 'saved'.
   */
  draftSync?: DraftSyncState;
  /**
   * Conversation this message belongs to (DESIGN-SPEC 3.10). Present on every message once the
   * engine has threaded it; the same value for all messages of one conversation.
   */
  threadId?: string;
  /** Pinned to the top of its folder on this PC (DESIGN-SPEC 3.13.6). Absent when not pinned. */
  pinned?: boolean;
  /** Part of a muted conversation. Absent when not muted. */
  muted?: boolean;
  /** Came back from snooze at this time and was not read since (the "Snoozed" chip). Absent otherwise. */
  snoozeReturnedAt?: EpochMs;
  /** Only in `snooze.list`: still hidden until this time. */
  snoozedUntil?: EpochMs;
}

export type DraftSyncState = 'saving' | 'queued' | 'failed' | 'saved';

export interface AttachmentInfo {
  id: number; // attachment row id
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface MessageBody {
  id: MessageId;
  header: MessageHeader;
  bcc: Address[];
  replyTo: Address[];
  inReplyTo: string | null;
  references: string | null;
  html: string | null; // RAW, unsanitized. Renderer MUST sanitize (ARCHITECTURE section 9).
  text: string | null;
  attachments: AttachmentInfo[];
  hasRemoteImages: boolean; // hint from engine: html contains http(s) img/src/srcset/url()
  /** The sender is on the "always load images" list (senders.allowImages). */
  senderImagesAllowed: boolean;
  truncated: boolean; // true if over display cap (html/text are null then)
}

// ---------- list scopes & paging ----------
export type ListScope =
  | { kind: 'unifiedInbox' }
  | { kind: 'unifiedFlagged' }
  | { kind: 'unifiedUnread' }
  | { kind: 'folder'; folderId: FolderId }
  | { kind: 'accountInbox'; accountId: AccountId };

export interface PageCursor {
  date: EpochMs;
  id: MessageId;
  /**
   * `conversations.list` / `messages.list` with sort 'sender' or 'subject' only: the sort key of the
   * last row of the page. Pass `nextCursor` back as it is. Never built by the UI.
   */
  key?: string;
}

// ---------- conversations (DESIGN-SPEC 3.10) ----------
export interface ConversationParticipant {
  name: string | null;
  address: string; // lower case
  /** One of the user's own addresses (the UI shows "me"). */
  isMe: boolean;
  hasUnread: boolean;
}

export interface ConversationRow {
  /** Unique across accounts. A conversation never crosses accounts. */
  threadId: string;
  accountId: AccountId;
  /** Messages shown in this view: Message-ID duplicates counted once, drafts not counted. */
  count: number;
  unreadCount: number;
  hasFlag: boolean;
  hasAttachment: boolean;
  /** Distinct senders, most recent first. The UI shows the first 3 and "+N". */
  participants: ConversationParticipant[];
  /** The newest message of the conversation (in the folders this view includes). */
  latest: {
    id: MessageId;
    /** Subject as written. */
    subject: string;
    /** Subject without Re:/Fwd:/AW:/SV: prefixes, for the row title. */
    title: string;
    snippet: string;
    date: EpochMs;
    fromMe: boolean;
    from: Address | null;
  };
  /** The messages that are in the folder being viewed (what actions change). Oldest first. */
  folderMessageIds: MessageId[];
  /** All messages counted in `count` (one id per Message-ID), oldest first. */
  messageIds: MessageId[];
  /** Some message of the conversation in this view is pinned / muted / came back from snooze. Absent when not. */
  pinned?: boolean;
  muted?: boolean;
  snoozeReturnedAt?: EpochMs;
}

/** How `conversations.list` orders the rows (DESIGN-SPEC 3.10.2). */
export type ConversationSort = 'date' | 'sender' | 'subject';
export interface ListConversationsReq {
  scope: ListScope;
  /**
   * `date` = latest date of the conversation, `id` = tie-breaker, `key` = the sort key (sender and
   * subject sorts). Pass `nextCursor` back as it is, with the same `sort` and `direction`.
   */
  cursor: PageCursor | null;
  limit: number; // 1..200, default 50
  unreadOnly?: boolean;
  /**
   * 'date' (default): latest date of the conversation. 'sender': the latest sender (display name,
   * else address). 'subject': the subject without Re:/Fwd: prefixes. Equal keys: newest first.
   */
  sort?: ConversationSort;
  /** Default: 'desc' for date (newest first), 'asc' for sender and subject (A to Z). */
  direction?: 'asc' | 'desc';
}
export interface ListConversationsRes {
  items: ConversationRow[];
  nextCursor: PageCursor | null;
  canLoadOlderFromServer: boolean;
  /** Number of conversations in the view (first page only), else null. */
  total: number | null;
  /**
   * First page only, folder and Inbox views without the unread filter (DESIGN-SPEC 3.13.6): the
   * pinned conversations (max 10 per folder and account). They are NOT in `items`.
   */
  pinned?: ConversationRow[];
}

export interface ConversationMessage {
  header: MessageHeader;
  folderId: FolderId;
  folderRole: FolderRole | null;
  folderName: string;
  /** The message is in the folder (or scope) the user is looking at. Without a scope: false. */
  inCurrentFolder: boolean;
  /** A draft (shown as a collapsed card with a "Draft" chip; not counted). */
  isDraft: boolean;
  fromMe: boolean;
}
export interface GetConversationReq {
  threadId: string;
  accountId: AccountId;
  /** The view the user is in. It decides which folders are included and `inCurrentFolder`. */
  scope?: ListScope;
}
export interface GetConversationRes {
  threadId: string;
  accountId: AccountId;
  /** Title without Re:/Fwd: prefixes. */
  title: string;
  /** Messages counted for the title block ("4 messages"): drafts not counted. */
  count: number;
  /** Oldest first. */
  messages: ConversationMessage[];
}

export interface ConversationActReq {
  threadIds: string[];
  /** The view the user acts in: only the messages that are in it are changed. */
  scope: ListScope;
  /**
   * Archive, delete, move, spam, notSpam: all messages in the view.
   * markRead true: every unread one; markRead false: only the newest.
   * flag false: unflag all of them; flag true: flag only the newest.
   */
  action: MessageAction;
  /**
   * Needed for `deletePermanent`: without `confirm: true` nothing is changed, the answer has
   * `requiresConfirm: true` and `messageCount` (what would be deleted) so the UI can ask first.
   */
  confirm?: boolean;
}
export interface ConversationActRes extends ApplyActionRes {
  threadCount: number;
  /**
   * Messages the action was applied to (for the toast: "Conversation archived (4 messages)"). With
   * `requiresConfirm`: the messages that would be deleted.
   */
  messageCount: number;
}

export interface ListMessagesReq {
  scope: ListScope;
  /** null = first page. Pass `nextCursor` back as it is, with the same `sort` and `direction`. */
  cursor: PageCursor | null;
  limit: number; // 1..200, default 50
  unreadOnly?: boolean;
  /**
   * 'date' (default): message date. 'sender': display name, else address. 'subject': without
   * Re:/Fwd: prefixes. Equal keys: newest first.
   */
  sort?: ConversationSort;
  /** Default: 'desc' for date (newest first), 'asc' for sender and subject (A to Z). */
  direction?: 'asc' | 'desc';
}
export interface ListMessagesRes {
  items: MessageHeader[];
  nextCursor: PageCursor | null; // null = end of LOCAL data
  canLoadOlderFromServer: boolean; // local end reached but server has older mail
  total: number | null; // total count for scope when cheap, else null
  /**
   * First page only, folder / Inbox views without the unread filter (DESIGN-SPEC 3.13.6): the pinned
   * messages (max 10 per folder). They are NOT in `items`. Show them under a "Pinned" header first.
   */
  pinned?: MessageHeader[];
}

// ---------- accounts ----------
export interface DiscoverReq {
  email: string;
}

/**
 * Provider guidance shown in Add Account right after the user types an address
 * (ARCHITECTURE section 0, item 4).
 */
export type AuthMethod = 'app-password' | 'microsoft-oauth' | 'password';
export interface ProviderHelp {
  providerName: string; // 'Gmail', 'iCloud Mail', 'Outlook.com', 'Your mail provider'
  authMethod: AuthMethod;
  /** Where to create an app password (authMethod='app-password'), else null. */
  appPasswordHelpUrl: string | null;
  /** Short, plain-language instructions the UI can show as-is. */
  instructions: string;
  /** Extra caution notes, e.g. the Gmail 2-Step Verification / Workspace admin note. */
  notes: string[];
}

export interface DiscoveredConfig {
  provider: ProviderId;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  usernameTemplate: string; // e.g. '%EMAILADDRESS%'
  suggestedAuth: AuthType;
  oauthProvider: OAuthProvider | null;
  oauthRequired: boolean; // true for outlook.com personal
  appPasswordHelpUrl: string | null;
  help: ProviderHelp;
  source: 'known' | 'autoconfig' | 'mx' | 'probe' | 'none';
}
export interface DiscoverRes {
  config: DiscoveredConfig | null;
}

export interface NewAccountInput {
  email: string;
  displayName: string;
  authType: AuthType;
  oauthProvider?: OAuthProvider;
  password?: string; // when authType='password'. Write-only.
  oauthSessionId?: string; // when authType='oauth2' (from oauth.start/complete)
  username: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  syncDays?: number;
  color?: string;
  badge?: string;
}
export interface TestAccountReq {
  input: Omit<NewAccountInput, 'displayName' | 'color'>;
}
export interface TestAccountRes {
  imap: { ok: boolean; error?: AppError };
  smtp: { ok: boolean; error?: AppError };
}

export interface UpdateAccountReq {
  accountId: AccountId;
  patch: Partial<
    Pick<
      Account,
      | 'displayName'
      | 'color'
      | 'signature'
      | 'syncDays'
      | 'enabled'
      | 'sortOrder'
      | 'badge'
      | 'imap'
      | 'smtp'
      | 'username'
    >
  >;
}
export interface UpdateCredentialsReq {
  accountId: AccountId;
  password: string;
}

// ---------- OAuth ----------
// Section 0: only Microsoft in v1. The app ships a built-in client ID; the user may override it.
export interface OAuthSettings {
  microsoft: {
    /** User override. Empty string = use the built-in ID. */
    clientIdOverride: string;
    /** The ID shipped with the app (null in dev builds without one). */
    builtInClientId: string | null;
    /** What will actually be used: override if set, else built-in, else null. */
    effectiveClientId: string | null;
    tenant: string; // 'common' | 'consumers' | 'organizations' | guid | domain
  };
}
export interface OAuthSettingsUpdate {
  microsoft?: { clientIdOverride: string; tenant: string };
}
export interface OAuthStartReq {
  provider: OAuthProvider;
  loginHint?: string;
}
export interface OAuthStartRes {
  sessionId: string;
  authUrl: string;
} // main has already opened the browser
export interface OAuthCompleteReq {
  sessionId: string;
} // awaits loopback callback
export interface OAuthCompleteRes {
  email: string;
  sessionId: string;
}
export interface OAuthReauthReq {
  accountId: AccountId;
}

// ---------- folders (section 0, item 5) ----------
export interface CreateFolderReq {
  accountId: AccountId;
  /** Path of the parent folder, or null to create at the top level. */
  parentPath: string | null;
  /** Leaf name only; the engine joins it with the server delimiter. */
  name: string;
}
export interface RenameFolderReq {
  folderId: FolderId;
  /** New leaf name only. The folder stays under the same parent. */
  newName: string;
}
export interface DeleteFolderReq {
  folderId: FolderId;
}
export interface FolderCountReq {
  /** One folder, or `'allInboxes'` (the Inbox of `accountId`, or of every account). */
  folderId: FolderId | 'allInboxes';
  /** With 'allInboxes': only this account. With a folder: the folder must belong to it. */
  accountId?: AccountId | null;
}
export interface FolderCountRes {
  /**
   * Messages in it, counted the way "Run rules on this folder" counts them: no drafts, no hidden
   * (deleted) ones, no local-only rows.
   */
  total: number;
  unread: number;
}

// ---------- actions ----------
export type MessageAction =
  | { type: 'markRead'; read: boolean }
  | { type: 'flag'; flagged: boolean }
  | { type: 'move'; destFolderId: FolderId }
  | { type: 'archive' }
  | { type: 'delete' } // to trash, or permanent if already in trash
  /**
   * Shift+Delete: delete for good, from any folder, with no undo. Needs `confirm: true` (see
   * ApplyActionReq). Queued like every other change, so it also works offline.
   */
  | { type: 'deletePermanent' }
  | { type: 'spam' } // move to the Junk folder
  | { type: 'notSpam' }; // move from Junk back to the Inbox
export interface ApplyActionReq {
  messageIds: MessageId[];
  action: MessageAction;
  /**
   * Needed for `deletePermanent`. Without `confirm: true` nothing is changed and the answer has
   * `requiresConfirm: true`.
   */
  confirm?: boolean;
}
export interface ApplyActionRes {
  succeeded: MessageId[];
  failed: { id: MessageId; error: AppError }[];
  /**
   * Present after move / archive / delete (to Trash) / spam / notSpam. Pass it to `messages.undo`
   * within UNDO_WINDOW_MS. Absent for read/flag changes and for permanent deletes.
   */
  undoToken?: string;
  /**
   * `deletePermanent` was asked without `confirm: true`: nothing was changed (`succeeded` is empty).
   * Ask the user ("Delete N messages permanently? This can't be undone."), then send it again with
   * `confirm: true`.
   */
  requiresConfirm?: boolean;
  /** Messages were deleted for good (`deletePermanent`, or `delete` in Trash). They cannot be undone. */
  permanent?: boolean;
}
/** How long an undo token stays valid in the engine. */
export const UNDO_WINDOW_MS = 60_000;
export interface UndoReq {
  undoToken: string;
}
export interface UndoRes {
  /** Messages moved back (ids are the same as before the action). */
  restored: MessageId[];
}
/** Mark everything in a scope as read. `account` = every folder of one account. */
export type MarkAllReadScope = ListScope | { kind: 'account'; accountId: AccountId };
export interface MarkAllReadReq {
  scope: MarkAllReadScope;
}

// ---------- compose / send ----------
export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';
export interface PrepareComposeReq {
  mode: ComposeMode;
  sourceMessageId?: MessageId; // required for reply / replyAll / forward
  accountId?: AccountId; // for 'new'; default = first enabled account
  /** Reopen a saved or undone draft by its draftId (from outbox.cancel or compose.openWindow). */
  draftId?: string;
  /** Edit a draft message that lives in a Drafts folder (mode 'new'). */
  draftMessageId?: MessageId;
  /** A mailto: URL to prefill To / Cc / Subject / body (mode 'new'). */
  mailto?: string;
}
/** Opens the compose window (main process). The window then calls compose.prepare itself. */
export type OpenComposeWindowReq = PrepareComposeReq;
export interface AttachDataReq {
  filename: string;
  contentType: string;
  data: Uint8Array; // pasted or dropped file, max 25 MB
}
export interface DraftAttachment {
  tokenId: string; // opaque token; never a raw path
  filename: string;
  size: number;
  contentType: string;
}
export interface ComposeDraft {
  draftId: string; // local session id (uuid)
  accountId: AccountId;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string; // prefilled incl. quote/signature
  inReplyToMessageId: MessageId | null;
  mode: ComposeMode;
  attachments: DraftAttachment[];
  /**
   * Set when this draft was a scheduled message that "Edit" (or "Cancel send" in the Outbox) turned
   * back into a draft: the time it was scheduled for. The compose window offers "Same time" with
   * it. Kept until `compose.clearPaused`, or until the message is sent, scheduled again or discarded.
   */
  pausedSendAt?: EpochMs | null;
}
export interface PickFilesRes {
  attachments: DraftAttachment[];
}
export interface SendReq {
  draftId: string;
  accountId: AccountId;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  attachmentTokens: string[];
}
export interface SendRes {
  outboxId: number;
  /** The engine always answers `queued`; the result arrives as the `send:result` event. */
  state: 'sent' | 'queued';
  /** When the message really leaves (now + undo-send delay). Until then outbox.cancel undoes it. */
  sendAt: EpochMs;
}
export interface OutboxItem {
  id: number;
  accountId: AccountId;
  subject: string;
  state: 'queued' | 'sending' | 'failed';
  lastError: string | null;
  /** Epoch ms the send starts (during the undo window this is in the future). */
  sendAt: EpochMs;
  attempts: number;
}
export interface OutboxCancelRes {
  /** Pass to compose.openWindow / compose.prepare to get the draft back. null if nothing to restore. */
  draftId: string | null;
}
export type SaveDraftReq = SendReq;
export interface SaveDraftRes {
  savedAt: EpochMs;
}

// ---------- send later (DESIGN-SPEC 3.11) ----------
export type ScheduledStatus = 'scheduled' | 'sending' | 'held' | 'failed';
export interface ScheduledItem {
  id: number;
  accountId: AccountId;
  /** The compose session this message came from (`compose.prepare({ draftId })` reopens it after cancel). */
  draftId: string;
  subject: string;
  to: Address[];
  cc: Address[];
  /** First words of the text, for the list row. */
  snippet: string;
  hasAttachments: boolean;
  sendAt: EpochMs;
  createdAt: EpochMs;
  /**
   * 'scheduled': waits. 'sending': handed to the Outbox, on its way. 'held': more than 24 hours
   * late, not sent by itself (send now, change the time or cancel). 'failed': could not be handed over.
   */
  status: ScheduledStatus;
  /** Why a due message is not leaving right now: no connection, or the account needs a sign-in. */
  waiting: 'offline' | 'signIn' | null;
  lastError: string | null;
  attempt: number;
  /** How long past `sendAt` it is now (0 while in the future). Held: "Due 3 days ago". */
  overdueMs: number;
}
export interface ScheduledDetail {
  item: ScheduledItem;
  /** The frozen message body (raw HTML like `MessageBody.html`: the renderer must sanitize it). */
  html: string;
  bcc: Address[];
  attachments: { filename: string; size: number; contentType: string }[];
}
export interface ScheduleSendReq {
  /** The compose session. */
  draftId: string;
  sendAt: EpochMs;
  /**
   * The message as it is in the editor now. Same checks as `compose.send`. Omit it to schedule the
   * saved text of `draftId` again (undo of "Cancel send").
   */
  draft?: SendReq;
}
export interface ScheduledCancelRes {
  /** Now a normal draft (in Drafts). Open it with `compose.openWindow({ mode: 'new', draftId })`. */
  draftId: string;
  /** The time it was scheduled for (for "Undo" and "Same time"). */
  sendAt: EpochMs;
}
export interface ScheduledCount {
  /** All scheduled messages (including held ones). */
  total: number;
  /** Waiting or on their way (not held). The status bar number. */
  scheduled: number;
  held: number;
  /** Soonest time of a waiting message. */
  nextSendAt: EpochMs | null;
  perAccount: { accountId: AccountId; total: number; scheduled: number; held: number }[];
}
export interface ScheduledNextDue {
  /** Messages (not held) due within the next 24 hours, overdue ones included. */
  count: number;
  nextSendAt: EpochMs | null;
}
export const MAX_SCHEDULED = 100;

// ---------- rules (DESIGN-SPEC 3.12) ----------
export const MAX_RULES = 50;
export const MAX_RULE_CONDITIONS = 6;
export type RuleConditionField = 'from' | 'toCc' | 'subject' | 'hasAttachment';
export interface RuleCondition {
  field: RuleConditionField;
  /** Text to look for (case and accent insensitive, literal). Absent for 'hasAttachment'. */
  value?: string;
}
export interface RuleActions {
  /** Move to this folder (needs a rule for one account). Excludes `delete`. */
  moveToFolderId?: FolderId | null;
  /** Path of that folder; the engine fills it in and keeps it up to date. */
  moveToFolderPath?: string | null;
  markRead: boolean;
  flag: boolean;
  /** Move to Trash (never permanent). Excludes `moveToFolderId`. */
  delete: boolean;
  /** Do not run the rules below this one on a message that matched. */
  stop: boolean;
}
/** 'inbox': new mail arriving in the Inbox. 'anyFolder': new mail in any folder except Spam, Trash, Drafts, Sent. */
export type RuleTrigger = 'inbox' | 'anyFolder';
export interface RuleDraft {
  /** 1 to 60 characters. */
  name: string;
  enabled: boolean;
  /** One account, or null for every account. */
  accountId: AccountId | null;
  matchMode: 'all' | 'any';
  /** 1 to 6. */
  conditions: RuleCondition[];
  /** At least one of move / markRead / flag / delete. */
  actions: RuleActions;
  trigger: RuleTrigger;
}
export interface RuleWarning {
  kind: 'folderMissing';
  /** Plain words for the row: "Folder 'Receipts' is missing. Edit the rule to choose another." */
  message: string;
  folderPath: string | null;
}
export interface Rule extends RuleDraft {
  id: number;
  /** 1-based order; rules run from top to bottom. */
  position: number;
  createdAt: EpochMs;
  /** Set when the engine switched the rule off because its target folder is gone. */
  warning: RuleWarning | null;
}
export interface CreateRuleReq extends RuleDraft {
  /** Put the rule at this place (1-based). Default: the end. Used to undo "Delete rule". */
  position?: number;
  /** Bring back a deleted rule under its old id, so the activity list links to it again. */
  id?: number;
}
export interface CountMatchesReq {
  rule: Pick<RuleDraft, 'accountId' | 'matchMode' | 'conditions'>;
  /** Count in this folder. Default: the Inbox of the rule's account (every Inbox when it has none). */
  folderId?: FolderId;
}
export interface CountMatchesRes {
  /** Messages that match. */
  matches: number;
  /** Messages looked at ("12 of the 248 messages in this Inbox"). */
  total: number;
}
export interface RunRulesReq {
  /** One rule (even a switched-off one) or every enabled rule. */
  ruleId: number | 'all';
  /** A folder, or `'allInboxes'` (the Inboxes of the rule's account, or of all accounts). */
  folderId: FolderId | 'allInboxes';
  /** Made by the UI. Progress events and `rules.cancelRun` use it. */
  runId: string;
}
/** Progress of a Run now. The last event has state 'finished', 'cancelled' or 'failed'. */
export interface RulesProgress {
  runId: string;
  state: 'running' | 'finished' | 'cancelled' | 'failed';
  /** Messages checked so far, and in all. */
  done: number;
  total: number;
  matched: number;
  moved: number;
  trashed: number;
  markedRead: number;
  flagged: number;
  /** Activity entries made by this run (last event only). Undo with `rulesActivity.undo`. */
  activityIds: number[];
  error?: AppError;
}
export interface RuleActivityItem {
  id: number;
  ts: EpochMs;
  /** null once the rule was deleted. */
  ruleId: number | null;
  ruleName: string;
  ruleDeleted: boolean;
  accountId: AccountId;
  /** Messages in this entry (a Run now or a burst is one entry). */
  count: number;
  /** Subject and sender of the message (null for an entry with several messages). */
  subject: string | null;
  sender: string | null;
  /** "Moved to Receipts, marked as read". */
  summary: string;
  runNow: boolean;
  undone: boolean;
  /** false: the message changed since (or is gone). Show "Can't undo. The message was changed since." */
  canUndo: boolean;
  /** An information line (for example a rule that was switched off), not a change to undo. */
  warning: boolean;
}

// ---------- light features (DESIGN-SPEC 3.13) ----------
export const MAX_PINS_PER_FOLDER = 10;
export const MAX_MUTED_PER_ACCOUNT = 500;
export const MAX_QUICK_REPLIES = 50;
export const QUICK_REPLY_NAME_MAX = 40;
export const QUICK_REPLY_TEXT_MAX = 2000;
export const MAX_RECENT_COMMANDS = 8;

export type UnsubscribeAuth = 'verified' | 'unknown' | 'failed';
export type UnsubscribeMethodKind = 'one-click' | 'mailto' | 'page';
/** One way to unsubscribe, in priority order. The URLs themselves stay in main. */
export interface UnsubscribeMethod {
  kind: UnsubscribeMethodKind;
  /** one-click and page: the host the request / the page goes to. */
  host?: string;
  /** mailto: where the email goes. */
  address?: string;
  /** mailto: subject from the link, else "unsubscribe". */
  subject?: string;
}
export interface UnsubscribeInfo {
  /** There is at least one usable method AND the sender check did not fail. */
  available: boolean;
  /** Usable methods, best first. Empty when the message has no List-Unsubscribe header. */
  methods: UnsubscribeMethod[];
  auth: UnsubscribeAuth;
  /** List-Id value if present, else the lower-case sender address. */
  listKey: string | null;
  /** Readable list name (List-Id phrase or sender name), if any. */
  listName: string | null;
  /** Lower-case sender address. */
  sender: string | null;
  /** The user unsubscribed from this list key before (same account). */
  previous?: { at: EpochMs; method: UnsubscribeMethodKind };
  previouslyUnsubscribedAt?: EpochMs;
}
export interface UnsubscribeRunReq {
  messageId: MessageId;
  method: UnsubscribeMethodKind;
}
export interface UnsubscribeRunRes {
  ok: boolean;
  method: UnsubscribeMethodKind;
  error?: AppError;
}
export interface FromSenderReq {
  accountId: AccountId;
  /** Sender address (case does not matter). */
  address: string;
}

/** Which messages a snooze / pin command acts on. Give `messageIds`, or `threadIds` with the view's `scope`. */
export interface LightTargets {
  messageIds?: MessageId[];
  /** Conversations (conversation view). Only their messages that are in `scope` are changed. */
  threadIds?: string[];
  /** The view the user acts in. Without it, threads use the Inbox-like folders of the account. */
  scope?: ListScope;
}
export interface SnoozeSetReq extends LightTargets {
  /** Epoch ms in the future, at most one year ahead. */
  until: EpochMs;
}
export interface SnoozeSetRes {
  snoozed: MessageId[];
  failed: { id: MessageId; error: AppError }[];
  /** Pass to `messages.undo`. */
  undoToken?: string;
}
export interface SnoozeClearRes {
  /** Messages that came back now (unread, at the top). */
  cleared: MessageId[];
  undoToken?: string;
}
export interface SnoozedItem {
  header: MessageHeader;
  snoozedUntil: EpochMs;
}
export interface SnoozeCount {
  total: number;
  nextWakeAt: EpochMs | null;
  perAccount: { accountId: AccountId; total: number }[];
}
export interface PinSetReq extends LightTargets {
  pinned: boolean;
}
export interface PinSetRes {
  ok: boolean;
  /** Set when `ok` is false because of the limit: MAX_PINS_PER_FOLDER. Nothing was changed. */
  limit?: number;
  changed: MessageId[];
  undoToken?: string;
}
export interface MuteSetReq {
  messageIds?: MessageId[];
  /** Conversations of the conversation view. */
  threads?: { accountId: AccountId; threadId: string }[];
  /** Muting archives the conversation's messages that are in this view (default: the folder of each message). */
  scope?: ListScope;
  muted: boolean;
}
export interface MuteSetRes {
  ok: boolean;
  /** Messages archived by muting. */
  archivedCount: number;
  changed: MessageId[];
  undoToken?: string;
}

export interface QuickReply {
  id: string;
  /** 1 to QUICK_REPLY_NAME_MAX characters, unique (case-insensitive). */
  name: string;
  /** Plain text, 1 to QUICK_REPLY_TEXT_MAX characters. */
  text: string;
  /** null = every account. */
  accountId: AccountId | null;
}
export interface SnoozeTimes {
  /** "HH:MM" 24 hour clock. */
  morning: string;
  evening: string;
  weekendMorning: string;
}

// ---------- search ----------
export interface SearchReq {
  query: string;
  accountId?: AccountId;
  limit?: number; // default 100, max 500
  offset?: number;
}
export interface SearchRes {
  items: (MessageHeader & { rank: number })[];
  parsedFilters: string[];
  totalApprox: number;
  coverage: { messagesIndexed: number; bodiesIndexed: number };
}
export interface ServerSearchReq {
  query: string;
  accountIds?: AccountId[];
}
export interface ServerSearchRes {
  added: number;
  items: MessageHeader[];
}

// ---------- per-sender "always load images" ----------
export interface AllowSenderImagesReq {
  address: string;
  allow: boolean;
}

// ---------- contacts (recipient autocomplete) ----------
export interface ContactSuggestReq {
  /** What the user typed so far. Empty = the best-ranked contacts. */
  query: string;
  /** Only contacts seen through this account. Default: all accounts. */
  accountId?: AccountId;
  /** 1..50, default 8. */
  limit?: number;
}
export interface ContactSuggestion {
  address: string; // lower case
  /** Display name, or null when only the address is known. */
  name: string | null;
  /** How many messages the user sent to this address (0 = only received mail from or with it). */
  sentCount: number;
  /** Epoch ms of the latest message sent to it, else the latest one seen. */
  lastUsed: EpochMs;
  /** One of the user's own addresses (ranked low; the UI may show it as "me"). */
  isOwn: boolean;
  /** Set when the request had an `accountId` and the contact is known only through another account (the one that knows it best). Absent for contacts of the requested account. */
  otherAccountId?: AccountId;
}
export interface ContactForgetReq {
  address: string;
}
export interface ContactGetReq {
  address: string;
}
/** What Letterdock knows about one address (the address popover). Always answers, also for unknown addresses. */
export interface ContactInfo {
  /** Lower case, as given (trimmed). */
  address: string;
  /** Display name, or null when only the address is known. */
  name: string | null;
  /** The address is in the contact list (has been seen in mail and was not removed). */
  known: boolean;
  /** How many messages the user sent to this address. */
  sentCount: number;
  /** How many messages came from or with this address. */
  receivedCount: number;
  /** Epoch ms of the latest message sent to it, else the latest one seen; 0 when unknown. */
  lastUsed: EpochMs;
  /** The accounts that know this address, most used first. */
  accountIds: AccountId[];
  /** One of the user's own addresses. */
  isOwn: boolean;
  /** The user removed it from the suggestions ("Remove from suggestions"). */
  forgotten: boolean;
}

// ---------- own window, print, mailto: ----------
export interface OpenMessageWindowReq {
  messageId: MessageId;
}
export interface PrintMessageReq {
  messageId: MessageId;
  /**
   * The message body as the renderer already sanitized it (ARCHITECTURE section 9), in the LIGHT
   * variant, with remote images either removed or pointing to `letterdock-img:`. Main still treats it
   * as untrusted: the print window runs no scripts and a strict CSP. Omit it to print the plain text.
   */
  bodyHtml?: string;
}
export interface SaveEmlReq {
  messageId: MessageId;
}
export interface SaveEmlRes {
  /** false if the user closed the save dialog. */
  saved: boolean;
  /** Where the file was written (only when saved). */
  path?: string;
}
export interface ShowUndoReq {
  /** The text of the toast, for example "Message archived". */
  label: string;
  /** From the action's answer; the toast's Undo button calls `messages.undo` with it. */
  undoToken: string;
  /** How many messages the token covers. */
  count?: number;
}
export interface ShowUndoRes {
  /**
   * The main window got the toast. false: there is no main window the user can see (closed to the
   * tray or minimized); the message window should keep its own Undo panel then.
   */
  delivered: boolean;
}
export interface PrintMessageRes {
  /** false if the user closed the print dialog without printing. */
  printed: boolean;
}
export interface MailtoStatus {
  /** This app is registered as a mailto: handler (always false in unpackaged dev runs). */
  registered: boolean;
  /**
   * Windows says this app is the default for mailto: links. Best effort: Windows keeps the user's
   * choice private, so this may be wrong. Absent in dev runs.
   */
  isDefault?: boolean;
}

// ---------- sync ----------
export interface SyncFolderReq {
  folderId: FolderId;
}
export interface SyncAccountReq {
  accountId: AccountId;
}
/** Give `folderId` for one folder, or `scope` for the list on screen (unified views load every inbox). */
export interface LoadOlderReq {
  folderId?: FolderId;
  scope?: ListScope;
}
export interface LoadOlderRes {
  fetched: number;
  reachedStart: boolean;
}

// ---------- settings (non-secret) ----------
export interface AppSettings {
  notifications: {
    enabled: boolean;
    mutedAccountIds: AccountId[];
    showPreview: boolean;
    sound: boolean;
  };
  markReadDelayMs: number; // 0 = immediately, -1 = never
  remoteImages: 'block' | 'allowKnownSenders'; // default 'block'
  theme: 'system' | 'light' | 'dark';
  startMinimizedToTray: boolean;
  closeToTray: boolean;
  launchAtLogin: boolean;
  /** Size cap (MB) of downloaded message bodies and attachments kept on this PC (50..100000). Oldest-opened are removed first; they download again when opened. */
  maxBodyCacheMB: number;
  /** Size cap of the remote image cache on disk (MB). Default 500. */
  imageCacheMaxMb: number;
  /** Cached images not shown for this many days are removed (7, 30 or 90; default 30). */
  imageCacheMaxAgeDays: number;
  maxWorkConnectionsPerAccount: number; // 1..4
  verboseLogging: boolean;
  autoUpdateCheck: boolean; // section 0, item 7
  /** Undo-send delay in ms: 0 (off), 5000, 10000 or 30000. */
  undoSendDelayMs: number;
  /** Always show the Cc and Bcc fields in new compose windows. Default false. */
  alwaysShowCcBcc: boolean;
  /** Remember size, position and maximized state of compose windows. Default true. When false, compose opens at 760x720, centered. */
  rememberComposeBounds: boolean;
  /** Recipient suggestions also offer addresses known only from the user's other accounts (after the From account's own). Default true. */
  suggestFromAllAccounts: boolean;
  /** Show one row per conversation (DESIGN-SPEC 3.10). Default false. */
  groupConversations: boolean;
  /** Key set of Settings > Shortcuts: Outlook style (default) or Gmail style (adds single-key shortcuts). */
  shortcutPreset: 'outlook' | 'gmail';
  /** Saved text for the compose window (DESIGN-SPEC 3.13.4). Max 50. Array order = menu order. */
  quickReplies: QuickReply[];
  /** The last commands run from the command box, newest first (max 8, DESIGN-SPEC 3.13.5). */
  recentCommands: string[];
  /** Times behind the Snooze menu items (DESIGN-SPEC 3.13.2). */
  snoozeTimes: SnoozeTimes;
  /** Show the "Blocked N trackers" note (DESIGN-SPEC 3.13.7). Blocking itself always stays on. */
  showTrackerNotice: boolean;
  /** Mark as read / Archive buttons on single-message notifications (3.13.3). */
  notifyActions: boolean;
  /** Notify when snoozed mail comes back (3.13.2). */
  notifySnoozeReturn: boolean;
}

// ---------- app updates (section 0, item 7; GitHub Releases via electron-updater) ----------
export type UpdateStatus =
  | { state: 'idle'; currentVersion: string }
  | { state: 'checking'; currentVersion: string }
  | { state: 'upToDate'; currentVersion: string; checkedAt: EpochMs }
  | { state: 'available'; currentVersion: string; newVersion: string; releaseNotes: string | null }
  | { state: 'downloading'; currentVersion: string; newVersion: string; percent: number }
  /** Downloaded. It installs when the app quits, or at once with `updates.install`. */
  | { state: 'ready'; currentVersion: string; newVersion: string; releaseNotes?: string | null }
  | { state: 'error'; currentVersion: string; error: AppError }
  /** Development builds (not installed from the installer) cannot update. The UI hides the controls. */
  | { state: 'unavailable'; currentVersion: string; reason: 'dev-build' };

// ============================ request/response map ============================
export interface FolderCounts {
  unifiedInboxUnread: number;
  perFolder: { folderId: FolderId; unread: number; total: number }[];
}

export interface IpcMethods {
  // accounts
  'accounts.list': { req: void; res: Account[] };
  'accounts.discover': { req: DiscoverReq; res: DiscoverRes };
  'accounts.test': { req: TestAccountReq; res: TestAccountRes };
  'accounts.add': { req: NewAccountInput; res: Account };
  'accounts.update': { req: UpdateAccountReq; res: Account };
  'accounts.updateCredentials': { req: UpdateCredentialsReq; res: void };
  'accounts.remove': { req: { accountId: AccountId }; res: void }; // also deletes secrets + cache
  'accounts.reorder': { req: { orderedIds: AccountId[] }; res: void };
  'accounts.statuses': { req: void; res: AccountStatus[] };

  // oauth (Sign in with Microsoft)
  'oauth.getSettings': { req: void; res: OAuthSettings };
  'oauth.setSettings': { req: OAuthSettingsUpdate; res: OAuthSettings };
  'oauth.start': { req: OAuthStartReq; res: OAuthStartRes };
  'oauth.complete': { req: OAuthCompleteReq; res: OAuthCompleteRes };
  'oauth.cancel': { req: { sessionId: string }; res: void };
  'oauth.reauthorize': { req: OAuthReauthReq; res: void };

  // folders
  'folders.list': { req: { accountId?: AccountId }; res: Folder[] };
  'folders.counts': { req: void; res: FolderCounts };
  'folders.create': { req: CreateFolderReq; res: Folder };
  'folders.rename': { req: RenameFolderReq; res: Folder };
  'folders.delete': { req: DeleteFolderReq; res: void };
  /** Permanently delete every message in Trash or Junk. Other folders: INVALID_INPUT. */
  'folders.empty': { req: { folderId: FolderId }; res: { deleted: number } };
  /** Message count of a folder (or all Inboxes), the way "Run rules on this folder" counts. */
  'folders.count': { req: FolderCountReq; res: FolderCountRes };

  // messages
  'messages.list': { req: ListMessagesReq; res: ListMessagesRes };
  'messages.get': { req: { messageId: MessageId }; res: MessageBody }; // fetches+caches body if needed
  'messages.getHeaders': { req: { messageIds: MessageId[] }; res: MessageHeader[] };
  'messages.rawSource': { req: { messageId: MessageId }; res: { source: string } };
  /**
   * Save the raw message (RFC 822) as a .eml file. Opens a native save dialog (main); the file name
   * comes from the subject. The message is fetched from the server: offline it rejects with
   * HOST_UNREACHABLE.
   */
  'messages.saveEml': { req: SaveEmlReq; res: SaveEmlRes };
  'messages.apply': { req: ApplyActionReq; res: ApplyActionRes };
  'messages.undo': { req: UndoReq; res: UndoRes };
  'messages.markAllRead': { req: MarkAllReadReq; res: { count: number } };
  /** Messages from this sender address in the account, not counting Trash, Junk, Drafts and Sent ("Move all from this sender to Trash"). */
  'messages.countFromSender': { req: FromSenderReq; res: { count: number } };
  /** Move all of them to Trash (one undo token). */
  'messages.trashFromSender': { req: FromSenderReq; res: ApplyActionRes };

  // light features (DESIGN-SPEC 3.13). Everything is computed when asked; nothing runs at start-up.
  /** Unsubscribe options of an opened message (read from stored headers, no network). */
  'unsubscribe.info': { req: { messageId: MessageId }; res: UnsubscribeInfo };
  /** Main: does the one-click POST / opens the page / sends the mailto, and remembers the result. */
  'unsubscribe.run': { req: UnsubscribeRunReq; res: UnsubscribeRunRes };
  'unsubscribe.forgetHistory': { req: void; res: { removed: number } };
  'snooze.set': { req: SnoozeSetReq; res: SnoozeSetRes };
  /** Bring the messages back now (unread, at the top). */
  'snooze.clear': { req: LightTargets; res: SnoozeClearRes };
  'snooze.list': { req: { accountId?: AccountId }; res: SnoozedItem[] };
  'snooze.count': { req: void; res: SnoozeCount };
  'pin.set': { req: PinSetReq; res: PinSetRes };
  'mute.set': { req: MuteSetReq; res: MuteSetRes };
  // conversations (DESIGN-SPEC 3.10)
  'conversations.list': { req: ListConversationsReq; res: ListConversationsRes };
  'conversations.get': { req: GetConversationReq; res: GetConversationRes };
  'conversations.act': { req: ConversationActReq; res: ConversationActRes };
  'senders.allowImages': { req: AllowSenderImagesReq; res: void };
  'senders.listAllowed': { req: void; res: string[] };
  /** Open the message in its own window (main). Opening it again focuses the existing window. */
  'message.openWindow': { req: OpenMessageWindowReq; res: void };
  /** Print through the system print dialog (also "Save as PDF"). See PrintMessageReq. */
  'message.print': { req: PrintMessageReq; res: PrintMessageRes };
  /**
   * The message window did an action that has an Undo (archive, delete, move, spam) and is about to
   * close: main shows the normal Undo toast in the main window (event `ui:undoAvailable`).
   */
  'ui.showUndo': { req: ShowUndoReq; res: ShowUndoRes };
  'contacts.suggest': { req: ContactSuggestReq; res: ContactSuggestion[] };
  /** Remove a suggestion for good (it is not learned again from old or new mail). */
  'contacts.forget': { req: ContactForgetReq; res: void };
  /** What is known about one address (name, counts, accounts, own, removed from suggestions). */
  'contacts.get': { req: ContactGetReq; res: ContactInfo };
  'attachments.open': { req: { attachmentId: number }; res: void }; // saves to cache dir, shell.openPath
  'attachments.saveAs': { req: { attachmentId: number }; res: { saved: boolean } }; // native save dialog
  'attachments.cidData': {
    req: { messageId: MessageId; contentId: string };
    res: { contentType: string; data: Uint8Array } | null;
  };

  // compose / send
  'compose.openWindow': { req: OpenComposeWindowReq; res: void };
  'compose.prepare': { req: PrepareComposeReq; res: ComposeDraft };
  'compose.pickFiles': { req: void; res: PickFilesRes };
  'compose.attachData': { req: AttachDataReq; res: DraftAttachment };
  'compose.discard': { req: { draftId: string }; res: void };
  /** Forget `ComposeDraft.pausedSendAt` (the "scheduling is paused" strip was shown or dismissed). */
  'compose.clearPaused': { req: { draftId: string }; res: void };
  'compose.saveDraft': { req: SaveDraftReq; res: SaveDraftRes };
  'compose.send': { req: SendReq; res: SendRes };
  /** Upload a draft whose server copy is waiting or failed, now (the "Retry" action on a draft row). No-op for other messages. */
  'drafts.retrySave': { req: { messageId: MessageId }; res: void };
  'outbox.list': { req: void; res: OutboxItem[] };
  'outbox.retry': { req: { outboxId: number }; res: void };
  /** Undo send / remove a failed message. Rejects with CANCELLED if it is already being sent. */
  'outbox.cancel': { req: { outboxId: number }; res: OutboxCancelRes };

  // send later (DESIGN-SPEC 3.11). Scheduled mail is kept on this PC only.
  'scheduled.create': { req: ScheduleSendReq; res: ScheduledItem };
  'scheduled.reschedule': { req: { id: number; sendAt: EpochMs }; res: ScheduledItem };
  /** Hand it to the Outbox now, without the undo delay. */
  'scheduled.sendNow': { req: { id: number }; res: ScheduledItem };
  /** Remove the schedule; the message becomes a normal draft (this is also what "Edit" does). */
  'scheduled.cancel': { req: { id: number }; res: ScheduledCancelRes };
  /** Delete it for good: it will not be sent and no draft is kept. */
  'scheduled.delete': { req: { id: number }; res: void };
  'scheduled.list': { req: { accountId?: AccountId }; res: ScheduledItem[] };
  'scheduled.get': { req: { id: number }; res: ScheduledDetail };
  'scheduled.count': { req: void; res: ScheduledCount };
  /** For the quit prompt: messages due within 24 hours. */
  'scheduled.nextDue': { req: void; res: ScheduledNextDue };

  // rules (DESIGN-SPEC 3.12): sort new mail on this PC; changes go through the normal action queue
  'rules.list': { req: void; res: Rule[] };
  'rules.create': { req: CreateRuleReq; res: Rule };
  'rules.update': { req: { id: number; patch: Partial<RuleDraft> }; res: Rule };
  /** Returns the deleted rule (pass it to `rules.create` to undo). */
  'rules.delete': { req: { id: number }; res: Rule };
  'rules.reorder': { req: { ids: number[] }; res: Rule[] };
  'rules.countMatches': { req: CountMatchesReq; res: CountMatchesRes };
  /** Starts the run and answers at once; progress comes as `rules:progress` events. */
  'rules.runNow': { req: RunRulesReq; res: { runId: string } };
  'rules.cancelRun': { req: { runId: string }; res: void };
  'rulesActivity.list': { req: void; res: RuleActivityItem[] };
  /** Reverse what the rule did to the message(s) of this entry. */
  'rulesActivity.undo': { req: { id: number }; res: { restored: number } };
  'rulesActivity.clear': { req: void; res: void };

  // search
  'search.local': { req: SearchReq; res: SearchRes };
  'search.server': { req: ServerSearchReq; res: ServerSearchRes };

  // sync
  'sync.account': { req: SyncAccountReq; res: void }; // returns when kicked off, progress via events
  'sync.folder': { req: SyncFolderReq; res: void };
  'sync.all': { req: void; res: void };
  'sync.loadOlder': { req: LoadOlderReq; res: LoadOlderRes };

  // settings / app
  'settings.get': { req: void; res: AppSettings };
  'settings.set': { req: Partial<AppSettings>; res: AppSettings };
  'images.cacheInfo': { req: void; res: { bytes: number; files: number } };
  'images.clearCache': { req: void; res: { freed: number } };
  'app.openExternal': { req: { url: string }; res: void }; // main validates http/https/mailto only
  'app.openLogs': { req: void; res: void };
  /** Shows a file in Explorer. Only for a path that "Save as .eml" returned a moment ago. */
  'app.showItemInFolder': { req: { path: string }; res: void };
  'app.mailtoStatus': { req: void; res: MailtoStatus };
  /** Opens Windows Settings > Default apps (fixed ms-settings:defaultapps address). */
  'app.openDefaultAppsSettings': { req: void; res: void };
  'app.info': { req: void; res: { version: string; dbPath: string; electron: string } };
  'system.networkChanged': { req: { online: boolean }; res: void };
  'log.write': { req: { level: 'warn' | 'error'; msg: string }; res: void };

  // app updates
  'updates.status': { req: void; res: UpdateStatus };
  'updates.check': { req: void; res: UpdateStatus };
  'updates.install': { req: void; res: void }; // quits and installs a downloaded update
}
export type IpcChannel = keyof IpcMethods;
export type IpcReq<C extends IpcChannel> = IpcMethods[C]['req'];
export type IpcRes<C extends IpcChannel> = IpcMethods[C]['res'];

// ================================ push events ================================
export type AppEvent =
  | { type: 'account:status'; status: AccountStatus }
  | { type: 'account:authRequired'; accountId: AccountId; reason: 'password' | 'oauth' }
  | { type: 'accounts:changed' } // list changed: re-fetch accounts.list
  | { type: 'folders:changed'; accountId: AccountId } // re-fetch folders.list for account
  | ({ type: 'counts:changed' } & FolderCounts)
  | {
      type: 'messages:changed'; // coalesced, <= 4/sec
      folderIds: FolderId[];
      added: MessageId[];
      updated: MessageId[];
      removed: MessageId[];
    }
  | {
      type: 'sync:progress';
      accountId: AccountId;
      folderId: FolderId | null;
      phase: 'folders' | 'initial' | 'incremental' | 'older' | 'idle';
      done: number;
      total: number | null;
    }
  | {
      type: 'notify:newMail';
      accountId: AccountId;
      messages: MessageHeader[];
      /** The account has a folder "Archive" can go to (the notification shows the Archive button). */
      archiveAvailable?: boolean;
    }
  /** Snoozed messages changed (set, cleared, woke up). Refresh lists, counts and the Snoozed view. */
  | { type: 'snooze:changed'; accountId: AccountId }
  /** Snoozed mail came back by itself (not for "Unsnooze now"). Main shows the "Snoozed mail is back" notification. */
  | { type: 'snooze:returned'; accountId: AccountId; messages: MessageHeader[] }
  /**
   * A button on a notification (Mark as read / Archive) did its work in the background. Show the
   * in-app toast only if the main window is visible: "Marked as read" / "Moved to Archive [Undo]"
   * (`undoToken` for `messages.undo`). Sent to the main window only.
   */
  | {
      type: 'notify:actionDone';
      action: 'read' | 'archive';
      accountId: AccountId;
      messageId: MessageId;
      undoToken?: string;
    }
  | {
      type: 'action:failed';
      messageIds: MessageId[];
      error: AppError;
      /** Which account and what kind of change was undone (for the toast text). */
      accountId?: AccountId;
      kind?: 'read' | 'flag' | 'move' | 'delete';
    }
  /** Number of unsynced changes of one account changed (also in AccountStatus.pendingCount). */
  | { type: 'pending:count'; accountId: AccountId; count: number }
  /**
   * Queued changes that could not be applied and were removed: the server mailbox was rebuilt
   * ('uidvalidity') or the message is gone ('gone'). Show a short notice; nothing is reverted.
   */
  | {
      type: 'pending:dropped';
      accountId: AccountId;
      count: number;
      reason: 'uidvalidity' | 'gone';
    }
  /**
   * A folder change that waited in the offline queue (create, rename, delete, empty) met a
   * difference on the server when it was sent. 'exists': the wanted name was taken, so the folder
   * was renamed to `resolvedName` instead. 'gone': the folder no longer exists on the server, the
   * change was dropped and the local folder removed. 'refused': the server refused it for good and
   * the local change was undone. Show a short notice.
   */
  | {
      type: 'folder:conflict';
      accountId: AccountId;
      op: 'create' | 'rename' | 'delete' | 'empty';
      folderName: string;
      reason: 'exists' | 'gone' | 'refused';
      resolvedName?: string;
    }
  /** Conversations changed (new mail, move, flag, merge). Re-fetch these rows. */
  | { type: 'conversations:changed'; accountId: AccountId; threadIds: string[] }
  /** Scheduled messages changed (added, rescheduled, sent, held, ...). Re-fetch `scheduled.list` / `scheduled.count`. */
  | { type: 'scheduled:changed' }
  /**
   * Messages that were due while Letterdock was closed (or the PC slept) are being sent now. Show
   * the persistent toast "Letterdock was closed when N scheduled messages were due...".
   */
  | { type: 'scheduled:due'; count: number; ids: number[] }
  /** A scheduled message could not be sent on time. It is in the Outbox as a failed item. */
  | { type: 'scheduled:failed'; accountId: AccountId; subject: string; outboxId: number; error: AppError }
  /** The rule list changed (also when a rule was switched off because its folder is gone). Re-fetch `rules.list`. */
  | { type: 'rules:changed' }
  /** The activity list changed. Re-fetch `rulesActivity.list`. */
  | { type: 'rulesActivity:changed' }
  | ({ type: 'rules:progress' } & RulesProgress)
  | { type: 'outbox:changed' }
  | { type: 'send:result'; outboxId: number; ok: boolean; error?: AppError }
  | { type: 'update:status'; status: UpdateStatus }
  /**
   * Sent to every window after `settings.set` or `oauth.setSettings`. Carries the full current
   * values, so a compose or message window can follow the Settings page without asking again.
   */
  | { type: 'settings:changed'; settings: AppSettings; oauth: OAuthSettings }
  | { type: 'ui:openMessage'; messageId: MessageId }
  /**
   * Sent to the MAIN window only, after `ui.showUndo` from a message window: show the normal Undo
   * toast (`label`, Undo button calls `messages.undo({ undoToken })`).
   */
  | { type: 'ui:undoAvailable'; label: string; undoToken: string; count: number }
  | { type: 'ui:compose'; mailto: string }
  | { type: 'engine:restarted' }; // renderer must reload state

// ================================ preload API ================================
/** Methods whose request is `void` are called without a second argument. */
export type InvokeArgs<C extends IpcChannel> = [IpcReq<C>] extends [void] ? [] : [req: IpcReq<C>];

export interface PreloadApi {
  invoke<C extends IpcChannel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcRes<C>>;
  on(cb: (e: AppEvent) => void): () => void; // returns unsubscribe
}
declare global {
  interface Window {
    api: PreloadApi;
  }
}
