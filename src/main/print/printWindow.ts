// Prints a prepared document (see printDocument.ts) through the system print dialog.
// The window is hidden, has no preload, runs no JavaScript and sits in its own in-memory session
// where only data: and the local image cache can load.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, session } from 'electron';
import { IMAGE_SCHEME } from '../../shared/imageProxy';

const PARTITION = 'letterdock-print'; // no "persist:" prefix = in memory only
const GIVE_UP_MS = 10 * 60_000;

export interface PrintDeps {
  /** The handler for letterdock-img: (the local image cache). */
  imagesHandle: (req: Request) => Promise<Response>;
  /** A folder for the one-shot document files (cleaned up after printing). */
  tempDir: string;
}

let sessionReady = false;

function printSession(d: PrintDeps): Electron.Session {
  const ses = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    ses.protocol.handle(IMAGE_SCHEME, d.imagesHandle);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // Allow only the document itself, data: and the image cache. Everything else is cancelled.
    ses.webRequest.onBeforeRequest((details, cb) => {
      const u = details.url.toLowerCase();
      const ok =
        u.startsWith('data:') ||
        u.startsWith(`${IMAGE_SCHEME}:`) ||
        (details.resourceType === 'mainFrame' && u.startsWith('file:'));
      cb({ cancel: !ok });
    });
  }
  return ses;
}

/** Removes leftovers of an earlier run (call once at startup). */
export async function cleanPrintTemp(tempDir: string): Promise<void> {
  const names = await readdir(tempDir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(tempDir, n), { force: true })));
}

/** Resolves true when the page went to the printer / PDF, false when the user cancelled. */
export async function printDocument(html: string, d: PrintDeps): Promise<boolean> {
  await mkdir(d.tempDir, { recursive: true });
  const file = join(d.tempDir, `${randomUUID()}.html`);
  await writeFile(file, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: printSession(d),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  try {
    await new Promise<void>((resolve, reject) => {
      wc.once('did-finish-load', () => resolve());
      wc.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`print page failed: ${code} ${desc}`)),
      );
      void win.loadFile(file);
    });
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), GIVE_UP_MS);
      try {
        wc.print({ silent: false, printBackground: true }, (success) => {
          clearTimeout(timer);
          resolve(success);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await rm(file, { force: true });
  }
}
