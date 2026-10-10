// Runtime validation of every renderer request (ARCHITECTURE section 6).
// The mapped type below makes a missing or wrongly-typed schema a compile error.
import { z } from 'zod';
import type { IpcChannel, IpcReq } from '../shared/ipc';

const id = z.number().int().nonnegative();
const accountId = z.string().min(1).max(100);
const str = (max = 2000) => z.string().max(max);
const address = z.object({ name: str(500).optional(), address: str(500) });
const endpoint = z.object({
  host: str(255),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['ssl', 'starttls']),
});

const newAccountBase = {
  email: str(320),
  authType: z.enum(['password', 'oauth2']),
  oauthProvider: z.enum(['microsoft', 'google']).optional(),
  password: str(1000).optional(),
  oauthSessionId: str(200).optional(),
  username: str(320),
  imap: endpoint,
  smtp: endpoint,
  syncDays: z.number().int().min(1).max(3650).optional(),
  badge: str(4).optional(),
};

const sendReq = z.object({
  draftId: str(100),
  accountId,
  to: z.array(address).max(500),
  cc: z.array(address).max(500),
  bcc: z.array(address).max(500),
  subject: str(2000),
  html: z.string().max(25 * 1024 * 1024),
  attachmentTokens: z.array(str(200)).max(100),
});

const ruleCondition = z.object({
  field: z.enum(['from', 'toCc', 'subject', 'hasAttachment']),
  value: str(500).optional(),
});
const ruleActions = z.object({
  moveToFolderId: id.nullable().optional(),
  moveToFolderPath: str(1000).nullable().optional(),
  markRead: z.boolean(),
  flag: z.boolean(),
  delete: z.boolean(),
  stop: z.boolean(),
});
const ruleDraft = z.object({
  name: str(60),
  enabled: z.boolean(),
  accountId: accountId.nullable(),
  matchMode: z.enum(['all', 'any']),
  conditions: z.array(ruleCondition).min(1).max(6),
  actions: ruleActions,
  trigger: z.enum(['inbox', 'anyFolder']),
});

const prepareCompose = z.object({
  mode: z.enum(['new', 'reply', 'replyAll', 'forward']),
  sourceMessageId: id.optional(),
  accountId: accountId.optional(),
  draftId: str(100).optional(),
  draftMessageId: id.optional(),
  mailto: str(8000).optional(),
});

const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unifiedInbox') }),
  z.object({ kind: z.literal('unifiedFlagged') }),
  z.object({ kind: z.literal('unifiedUnread') }),
  z.object({ kind: z.literal('folder'), folderId: id }),
  z.object({ kind: z.literal('accountInbox'), accountId }),
]);

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markRead'), read: z.boolean() }),
  z.object({ type: z.literal('flag'), flagged: z.boolean() }),
  z.object({ type: z.literal('move'), destFolderId: id }),
  z.object({ type: z.literal('archive') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('deletePermanent') }),
  z.object({ type: z.literal('spam') }),
  z.object({ type: z.literal('notSpam') }),
]);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quickReplies = z
  .array(
    z.object({
      id: str(100).min(1),
      name: z.string().trim().min(1).max(40),
      text: z.string().min(1).max(2000),
      accountId: accountId.nullable(),
    }),
  )
  .max(50)
  .refine((l) => new Set(l.map((q) => q.name.trim().toLowerCase())).size === l.length, 'names must be unique')
  .refine((l) => new Set(l.map((q) => q.id)).size === l.length, 'ids must be unique');

const settingsPatch = z
  .object({
    notifications: z.object({
      enabled: z.boolean(),
      mutedAccountIds: z.array(accountId).max(10000),
      showPreview: z.boolean(),
      sound: z.boolean(),
    }),
    markReadDelayMs: z.number().int().min(-1).max(60000),
    remoteImages: z.enum(['block', 'allowKnownSenders']),
    theme: z.enum(['system', 'light', 'dark']),
    startMinimizedToTray: z.boolean(),
    closeToTray: z.boolean(),
    launchAtLogin: z.boolean(),
    maxBodyCacheMB: z.number().int().min(50).max(100000),
    imageCacheMaxMb: z.number().int().min(50).max(10000),
    imageCacheMaxAgeDays: z.number().int().min(1).max(3650),
    maxWorkConnectionsPerAccount: z.number().int().min(1).max(4),
    verboseLogging: z.boolean(),
    autoUpdateCheck: z.boolean(),
    undoSendDelayMs: z.union([z.literal(0), z.literal(5000), z.literal(10000), z.literal(30000)]),
    alwaysShowCcBcc: z.boolean(),
    rememberComposeBounds: z.boolean(),
    suggestFromAllAccounts: z.boolean(),
    groupConversations: z.boolean(),
    shortcutPreset: z.enum(['outlook', 'gmail']),
    quickReplies,
    recentCommands: z.array(str(100)).max(8),
    snoozeTimes: z.object({ morning: hhmm, evening: hhmm, weekendMorning: hhmm }),
    showTrackerNotice: z.boolean(),
    notifyActions: z.boolean(),
    notifySnoozeReturn: z.boolean(),
  })
  .partial();

const lightTargets = {
  messageIds: z.array(id).min(1).max(1000).optional(),
  threadIds: z.array(str(300).min(1)).min(1).max(1000).optional(),
  scope: scope.optional(),
};
const hasTarget = (r: { messageIds?: unknown; threadIds?: unknown }) =>
  r.messageIds !== undefined || r.threadIds !== undefined;

const none = z.undefined();

type Schemas = { [C in IpcChannel]: z.ZodType<IpcReq<C>> };

export const schemas: Schemas = {
  'accounts.list': none,
  'accounts.discover': z.object({ email: str(320) }),
  'accounts.test': z.object({ input: z.object(newAccountBase) }),
  'accounts.add': z.object({
    ...newAccountBase,
    displayName: str(200),
    color: str(32).optional(),
  }),
  'accounts.update': z.object({
    accountId,
    patch: z
      .object({
        displayName: str(200),
        color: str(32).nullable(),
        signature: str(20000).nullable(),
        syncDays: z.number().int().min(1).max(3650),
        enabled: z.boolean(),
        sortOrder: z.number().int(),
        badge: str(4),
        imap: endpoint,
        smtp: endpoint,
        username: str(320),
      })
      .partial(),
  }),
  'accounts.updateCredentials': z.object({ accountId, password: str(1000) }),
  'accounts.remove': z.object({ accountId }),
  'accounts.reorder': z.object({ orderedIds: z.array(accountId).max(10000) }),
  'accounts.statuses': none,

  'oauth.getSettings': none,
  'oauth.setSettings': z.object({
    microsoft: z.object({ clientIdOverride: str(100), tenant: str(255) }).optional(),
  }),
  'oauth.start': z.object({
    provider: z.enum(['microsoft', 'google']),
    loginHint: str(320).optional(),
  }),
  'oauth.complete': z.object({ sessionId: str(200) }),
  'oauth.cancel': z.object({ sessionId: str(200) }),
  'oauth.reauthorize': z.object({ accountId }),

  'folders.list': z.object({ accountId: accountId.optional() }),
  'folders.counts': none,
  'folders.create': z.object({
    accountId,
    parentPath: str(1000).nullable(),
    name: str(200),
  }),
  'folders.rename': z.object({ folderId: id, newName: str(200) }),
  'folders.delete': z.object({ folderId: id }),
  'folders.empty': z.object({ folderId: id }),
  'folders.count': z.object({
    folderId: z.union([id, z.literal('allInboxes')]),
    accountId: accountId.nullable().optional(),
  }),

  'messages.list': z.object({
    scope,
    cursor: z.object({ date: z.number(), id, key: str(500).optional() }).nullable(),
    limit: z.number().int().min(1).max(200),
    unreadOnly: z.boolean().optional(),
    sort: z.enum(['date', 'sender', 'subject']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
  }),
  'messages.get': z.object({ messageId: id }),
  'messages.getHeaders': z.object({ messageIds: z.array(id).max(500) }),
  'messages.rawSource': z.object({ messageId: id }),
  'messages.saveEml': z.object({ messageId: id }),
  'messages.apply': z.object({
    messageIds: z.array(id).min(1).max(1000),
    action,
    confirm: z.boolean().optional(),
  }),
  'messages.undo': z.object({ undoToken: str(200) }),
  'messages.markAllRead': z.object({
    scope: z.union([scope, z.object({ kind: z.literal('account'), accountId })]),
  }),
  'messages.countFromSender': z.object({ accountId, address: str(320).min(3) }),
  'messages.trashFromSender': z.object({ accountId, address: str(320).min(3) }),
  'unsubscribe.info': z.object({ messageId: id }),
  'unsubscribe.run': z.object({ messageId: id, method: z.enum(['one-click', 'mailto', 'page']) }),
  'unsubscribe.forgetHistory': none,
  'snooze.set': z.object({ ...lightTargets, until: z.number().int() }).refine(hasTarget),
  'snooze.clear': z.object(lightTargets).refine(hasTarget),
  'snooze.list': z.object({ accountId: accountId.optional() }),
  'snooze.count': none,
  'pin.set': z.object({ ...lightTargets, pinned: z.boolean() }).refine(hasTarget),
  'mute.set': z
    .object({
      messageIds: z.array(id).min(1).max(1000).optional(),
      threads: z.array(z.object({ accountId, threadId: str(300).min(1) })).min(1).max(1000).optional(),
      scope: scope.optional(),
      muted: z.boolean(),
    })
    .refine((r) => r.messageIds !== undefined || r.threads !== undefined),
  'conversations.list': z.object({
    scope,
    cursor: z.object({ date: z.number(), id: z.number(), key: str(500).optional() }).nullable(),
    limit: z.number().int().min(1).max(200),
    unreadOnly: z.boolean().optional(),
    sort: z.enum(['date', 'sender', 'subject']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
  }),
  'conversations.get': z.object({ threadId: str(300).min(1), accountId, scope: scope.optional() }),
  'conversations.act': z.object({
    threadIds: z.array(str(300).min(1)).min(1).max(1000),
    scope,
    action,
    confirm: z.boolean().optional(),
  }),
  'senders.allowImages': z.object({ address: str(320), allow: z.boolean() }),
  'senders.listAllowed': none,
  'message.openWindow': z.object({ messageId: id }),
  'message.print': z.object({
    messageId: id,
    bodyHtml: z
      .string()
      .max(10 * 1024 * 1024)
      .optional(),
  }),
  'contacts.suggest': z.object({
    query: str(200),
    accountId: accountId.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  'contacts.forget': z.object({ address: str(320).min(3) }),
  'contacts.get': z.object({ address: str(320).min(3) }),
  'ui.showUndo': z.object({
    label: str(300).min(1),
    undoToken: str(200).min(1),
    count: z.number().int().min(0).max(100000).optional(),
  }),
  'attachments.open': z.object({ attachmentId: id }),
  'attachments.saveAs': z.object({ attachmentId: id }),
  'attachments.cidData': z.object({ messageId: id, contentId: str(500) }),

  'compose.openWindow': prepareCompose,
  'compose.prepare': prepareCompose,
  'compose.pickFiles': none,
  'compose.attachData': z.object({
    filename: str(255),
    contentType: str(200),
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= 25 * 1024 * 1024),
  }),
  'compose.discard': z.object({ draftId: str(100) }),
  'compose.clearPaused': z.object({ draftId: str(100) }),
  'compose.saveDraft': sendReq,
  'compose.send': sendReq,
  'drafts.retrySave': z.object({ messageId: id }),
  'outbox.list': none,
  'outbox.retry': z.object({ outboxId: id }),
  'outbox.cancel': z.object({ outboxId: id }),

  'scheduled.create': z.object({ draftId: str(100), sendAt: z.number().int(), draft: sendReq.optional() }),
  'scheduled.reschedule': z.object({ id, sendAt: z.number().int() }),
  'scheduled.sendNow': z.object({ id }),
  'scheduled.cancel': z.object({ id }),
  'scheduled.delete': z.object({ id }),
  'scheduled.list': z.object({ accountId: accountId.optional() }),
  'scheduled.get': z.object({ id }),
  'scheduled.count': none,
  'scheduled.nextDue': none,

  'rules.list': none,
  'rules.create': ruleDraft.extend({ position: z.number().int().min(1).max(1000).optional(), id: id.optional() }),
  'rules.update': z.object({ id, patch: ruleDraft.partial() }),
  'rules.delete': z.object({ id }),
  'rules.reorder': z.object({ ids: z.array(id).max(100) }),
  'rules.countMatches': z.object({
    rule: ruleDraft.pick({ accountId: true, matchMode: true, conditions: true }),
    folderId: id.optional(),
  }),
  'rules.runNow': z.object({
    ruleId: z.union([id, z.literal('all')]),
    folderId: z.union([id, z.literal('allInboxes')]),
    runId: str(100).min(1),
  }),
  'rules.cancelRun': z.object({ runId: str(100).min(1) }),
  'rulesActivity.list': none,
  'rulesActivity.undo': z.object({ id }),
  'rulesActivity.clear': none,

  'search.local': z.object({
    query: str(1000),
    accountId: accountId.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  'search.server': z.object({
    query: str(1000),
    accountIds: z.array(accountId).max(10000).optional(),
  }),

  'sync.account': z.object({ accountId }),
  'sync.folder': z.object({ folderId: id }),
  'sync.all': none,
  'sync.loadOlder': z
    .object({ folderId: id.optional(), scope: scope.optional() })
    .refine((r) => r.folderId !== undefined || r.scope !== undefined),

  'settings.get': none,
  'settings.set': settingsPatch,
  'images.cacheInfo': none,
  'images.clearCache': none,
  'app.openExternal': z.object({ url: str(8000) }),
  'app.openLogs': none,
  'app.showItemInFolder': z.object({ path: str(4000).min(1) }),
  'app.mailtoStatus': none,
  'app.openDefaultAppsSettings': none,
  'app.info': none,
  'system.networkChanged': z.object({ online: z.boolean() }),
  'log.write': z.object({ level: z.enum(['warn', 'error']), msg: str(4000) }),

  'updates.status': none,
  'updates.check': none,
  'updates.install': none,
};

export function isKnownChannel(c: unknown): c is IpcChannel {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(schemas, c);
}
