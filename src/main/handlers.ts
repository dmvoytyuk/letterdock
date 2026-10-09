// Handlers for channels the main process owns (see shared/channels.ts).
import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { convert as htmlToText } from 'html-to-text';
import type {
  DraftAttachment,
  IpcReq,
  IpcRes,
  MessageBody,
  MessageHeader,
  PrepareComposeReq,
  AppSettings,
} from '../shared/ipc';
import type { MainChannel } from '../shared/channels';
import { AppException } from '../shared/errors';
import type { PreparedAttachment } from '../shared/internal';
import { isExecutableName, isSafeExternalUrl } from '../shared/safety';
import type { EngineHost } from './engineHost';
import type { OAuthService } from './oauth/service';
import type { Logger } from './logger';
import type { AppUpdater } from './updater';
import type { SettingsStore } from './settings';
import type { ImageDiskCache } from './imageCache/store';
import { computeMailtoStatus, DEFAULT_APPS_URI } from './mailto';
import { buildPrintDocument } from './print/printDocument';
import { printDocument, type PrintDeps } from './print/printWindow';

type MainHandlers = {
  [C in MainChannel]: (req: IpcReq<C>) => Promise<IpcRes<C>> | IpcRes<C>;
};

export interface HandlerDeps {
  settings: SettingsStore;
  imageCache: ImageDiskCache;
  engine: EngineHost;
  log: Logger;
  updater: Pick<AppUpdater, 'status' | 'check' | 'install'>;
  logsDir: string;
  dbPath: string;
  getWindow: () => BrowserWindow | null;
  oauth: OAuthService;
  /** Opens a compose window for the request. */
  openCompose: (req: PrepareComposeReq) => void;
  /** Opens (or focuses) the message window. */
  openViewer: (messageId: number) => void;
  /**
   * Called after a setting was saved: `patch` is the part that changed, or null when the OAuth
   * settings changed. Main applies side effects (login item, log level) and tells every window.
   */
  onSettingsChanged: (patch: Partial<AppSettings> | null) => void;
  print: PrintDeps;
}

export function createMainHandlers(d: HandlerDeps): MainHandlers {
  async function saveAs(prep: PreparedAttachment): Promise<boolean> {
    const win = d.getWindow();
    const opts = { defaultPath: join(app.getPath('downloads'), prep.filename) };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return false;
    await copyFile(prep.path, res.filePath);
    return true;
  }

  return {
    'oauth.getSettings': () => d.settings.getOAuth(),
    'oauth.setSettings': (r) => {
      const next = d.settings.setOAuth(r);
      d.onSettingsChanged(null);
      return next;
    },
    'oauth.start': (r) => d.oauth.start(r),
    'oauth.complete': (r) => d.oauth.complete(r),
    'oauth.cancel': (r) => d.oauth.cancel(r.sessionId),
    'oauth.reauthorize': (r) => d.oauth.reauthorize(r),

    'attachments.open': async (r) => {
      const prep = await d.engine.request<PreparedAttachment>('attachments.prepare', {
        attachmentId: r.attachmentId,
      });
      if (isExecutableName(prep.filename)) {
        const win = d.getWindow();
        const opts = {
          type: 'warning' as const,
          title: 'This file can run programs',
          message: `"${prep.filename}" is a type of file that can run programs on your PC.`,
          detail:
            'Only open it if you trust the sender. You can save it instead and check it first.',
          buttons: ['Save As...', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        };
        const choice = win
          ? await dialog.showMessageBox(win, opts)
          : await dialog.showMessageBox(opts);
        if (choice.response === 0) await saveAs(prep);
        return;
      }
      const err = await shell.openPath(prep.path);
      if (err)
        throw new AppException('INTERNAL', 'Could not open the attachment.', { details: err });
    },
    'attachments.saveAs': async (r) => {
      const prep = await d.engine.request<PreparedAttachment>('attachments.prepare', {
        attachmentId: r.attachmentId,
      });
      return { saved: await saveAs(prep) };
    },

    'compose.openWindow': (r) => d.openCompose(r),
    'message.openWindow': (r) => d.openViewer(r.messageId),
    'message.print': async (r) => {
      const headers = await d.engine.request<MessageHeader[]>('messages.getHeaders', {
        messageIds: [r.messageId],
      });
      const h = headers[0];
      if (!h) throw new AppException('NOT_FOUND', 'Message not found.');
      // The full message gives Bcc and the attachment names. It is cached when the renderer showed it.
      let body: MessageBody | null = null;
      try {
        body = await d.engine.request<MessageBody>('messages.get', { messageId: r.messageId });
      } catch (e) {
        // Without the renderer's HTML we need the body to print anything.
        if (r.bodyHtml === undefined) throw e;
      }
      let text = '';
      if (r.bodyHtml === undefined && body) {
        // No sanitized HTML given: print the plain text (made from the HTML if there is no text part).
        text =
          body.text ??
          (body.html
            ? htmlToText(body.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] })
            : '');
      }
      const html = buildPrintDocument({
        subject: h.subject,
        from: h.from,
        to: h.to,
        cc: h.cc,
        bcc: body?.bcc ?? [],
        attachments: (body?.attachments ?? [])
          .filter((a) => !a.inline)
          .map((a) => ({ filename: a.filename, size: a.size })),
        date: h.date,
        bodyHtml: r.bodyHtml ?? null,
        text,
      });
      return { printed: await printDocument(html, d.print) };
    },
    'compose.pickFiles': async () => {
      // The dialog belongs to whichever window asked (main or a compose window).
      const parent = BrowserWindow.getFocusedWindow() ?? d.getWindow();
      const opts = { title: 'Attach files', properties: ['openFile' as const, 'multiSelections' as const] };
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || res.filePaths.length === 0) return { attachments: [] };
      const files = res.filePaths.map((path) => ({ path, filename: basename(path), contentType: '' }));
      const attachments = await d.engine.request<DraftAttachment[]>('attachments.register', { files });
      return { attachments };
    },

    'settings.get': () => d.settings.get(),
    'settings.set': async (patch) => {
      const next = d.settings.set(patch);
      // Keeps the native caption buttons and window colors in step with the Theme setting.
      if (patch.theme !== undefined) nativeTheme.themeSource = next.theme;
      if (patch.imageCacheMaxMb !== undefined || patch.imageCacheMaxAgeDays !== undefined) {
        d.imageCache.setMaxBytes(next.imageCacheMaxMb * 1024 * 1024);
        d.imageCache.setMaxAgeDays(next.imageCacheMaxAgeDays);
        void d.imageCache.trim().catch(() => undefined);
      }
      await d.engine.request('engine.settings', next).catch(() => undefined);
      d.onSettingsChanged(patch);
      return next;
    },

    'images.cacheInfo': () => d.imageCache.info(),
    'images.clearCache': () => d.imageCache.clear(),

    'app.openExternal': async (r) => {
      if (!isSafeExternalUrl(r.url)) {
        throw new AppException('INVALID_INPUT', 'Only web and email links can be opened.');
      }
      await shell.openExternal(r.url);
    },
    'app.mailtoStatus': () =>
      computeMailtoStatus({
        isPackaged: app.isPackaged,
        registeredCommand: app.isPackaged && app.isDefaultProtocolClient('mailto'),
        currentHandlerName: app.isPackaged ? app.getApplicationNameForProtocol('mailto:') : '',
        appName: app.getName(),
      }),
    'app.openDefaultAppsSettings': async () => {
      // Fixed address on purpose: never built from input.
      await shell.openExternal(DEFAULT_APPS_URI);
    },
    'app.openLogs': async () => {
      await shell.openPath(d.logsDir);
    },
    'app.info': () => ({
      version: app.getVersion(),
      dbPath: d.dbPath,
      electron: process.versions.electron,
    }),
    'log.write': (r) => {
      if (r.level === 'error') d.log.error({ source: 'renderer' }, r.msg);
      else d.log.warn({ source: 'renderer' }, r.msg);
    },

    // Updates from GitHub Releases. status and check never throw: problems are in the status.
    'updates.status': () => d.updater.status(),
    'updates.check': () => d.updater.check(),
    'updates.install': () => d.updater.install(),
  };
}
