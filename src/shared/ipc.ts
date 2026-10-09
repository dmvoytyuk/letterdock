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
}

export interface ListMessagesReq {
  scope: ListScope;
  cursor: PageCursor | null; // null = first page
  limit: number; // 1..200, default 50
  unreadOnly?: boolean;
}
export interface ListMessagesRes {
  items: MessageHeader[];
  nextCursor: PageCursor | null; // null = end of LOCAL data
  canLoadOlderFromServer: boolean; // local end reached but server has older mail
  total: number | null; // total count for scope when cheap, else null
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

// ---------- actions ----------
export type MessageAction =
  | { type: 'markRead'; read: boolean }
  | { type: 'flag'; flagged: boolean }
  | { type: 'move'; destFolderId: FolderId }
  | { type: 'archive' }
  | { type: 'delete' } // to trash, or permanent if already in trash
  | { type: 'spam' } // move to the Junk folder
  | { type: 'notSpam' }; // move from Junk back to the Inbox
export interface ApplyActionReq {
  messageIds: MessageId[];
  action: MessageAction;
}
export interface ApplyActionRes {
  succeeded: MessageId[];
  failed: { id: MessageId; error: AppError }[];
  /**
   * Present after move / archive / delete (to Trash) / spam / notSpam. Pass it to `messages.undo`
   * within UNDO_WINDOW_MS. Absent for read/flag changes and for permanent deletes.
   */
  undoToken?: string;
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

// ---------- own window, print, mailto: ----------
export interface OpenMessageWindowReq {
  messageId: MessageId;
}
export interface PrintMessageReq {
  messageId: MessageId;
  /**
   * The message body as the renderer already sanitized it (ARCHITECTURE section 9), in the LIGHT
   * variant, with remote images either removed or pointing to `mailroom-img:`. Main still treats it
   * as untrusted: the print window runs no scripts and a strict CSP. Omit it to print the plain text.
   */
  bodyHtml?: string;
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

  // messages
  'messages.list': { req: ListMessagesReq; res: ListMessagesRes };
  'messages.get': { req: { messageId: MessageId }; res: MessageBody }; // fetches+caches body if needed
  'messages.getHeaders': { req: { messageIds: MessageId[] }; res: MessageHeader[] };
  'messages.rawSource': { req: { messageId: MessageId }; res: { source: string } };
  'messages.apply': { req: ApplyActionReq; res: ApplyActionRes };
  'messages.undo': { req: UndoReq; res: UndoRes };
  'messages.markAllRead': { req: MarkAllReadReq; res: { count: number } };
  'senders.allowImages': { req: AllowSenderImagesReq; res: void };
  'senders.listAllowed': { req: void; res: string[] };
  /** Open the message in its own window (main). Opening it again focuses the existing window. */
  'message.openWindow': { req: OpenMessageWindowReq; res: void };
  /** Print through the system print dialog (also "Save as PDF"). See PrintMessageReq. */
  'message.print': { req: PrintMessageReq; res: PrintMessageRes };
  'contacts.suggest': { req: ContactSuggestReq; res: ContactSuggestion[] };
  /** Remove a suggestion for good (it is not learned again from old or new mail). */
  'contacts.forget': { req: ContactForgetReq; res: void };
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
  'compose.saveDraft': { req: SaveDraftReq; res: SaveDraftRes };
  'compose.send': { req: SendReq; res: SendRes };
  /** Upload a draft whose server copy is waiting or failed, now (the "Retry" action on a draft row). No-op for other messages. */
  'drafts.retrySave': { req: { messageId: MessageId }; res: void };
  'outbox.list': { req: void; res: OutboxItem[] };
  'outbox.retry': { req: { outboxId: number }; res: void };
  /** Undo send / remove a failed message. Rejects with CANCELLED if it is already being sent. */
  'outbox.cancel': { req: { outboxId: number }; res: OutboxCancelRes };

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
  | { type: 'notify:newMail'; accountId: AccountId; messages: MessageHeader[] }
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
  | { type: 'outbox:changed' }
  | { type: 'send:result'; outboxId: number; ok: boolean; error?: AppError }
  | { type: 'update:status'; status: UpdateStatus }
  /**
   * Sent to every window after `settings.set` or `oauth.setSettings`. Carries the full current
   * values, so a compose or message window can follow the Settings page without asking again.
   */
  | { type: 'settings:changed'; settings: AppSettings; oauth: OAuthSettings }
  | { type: 'ui:openMessage'; messageId: MessageId }
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
