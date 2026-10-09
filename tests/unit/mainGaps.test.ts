// Main-process pieces: the new channels' request checks, "Save as .eml", the Undo relay from the
// message window, the quit-prompt state, and file names. No Electron window is ever created.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QuitState } from '../../src/main/quitGuard';
import { relayUndoToMain, type RelayTarget } from '../../src/main/undoRelay';
import { SavedPaths, saveEml, type SaveEmlDeps } from '../../src/main/saveEml';
import { emlFileName, safeFileStem } from '../../src/shared/fileName';
import { isKnownChannel, schemas } from '../../src/main/ipcSchemas';
import { MAIN_CHANNELS, isMainChannel } from '../../src/shared/channels';
import { AppException } from '../../src/shared/errors';

// handlers.ts needs these names from electron; none of them is used by the code under test here.
const electron = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  showSaveDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Users\\test\\Downloads', getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: electron.showSaveDialog },
  nativeTheme: {},
  shell: { showItemInFolder: electron.showItemInFolder },
  ipcMain: {},
  Notification: {},
}));

describe('request checks of the new channels', () => {
  it('accepts deletePermanent with confirm, on messages and on conversations', () => {
    expect(
      schemas['messages.apply'].safeParse({ messageIds: [1], action: { type: 'deletePermanent' }, confirm: true })
        .success,
    ).toBe(true);
    expect(
      schemas['conversations.act'].safeParse({
        threadIds: ['t:1'],
        scope: { kind: 'unifiedInbox' },
        action: { type: 'deletePermanent' },
        confirm: false,
      }).success,
    ).toBe(true);
    expect(
      schemas['messages.apply'].safeParse({ messageIds: [1], action: { type: 'deletePermanent' }, confirm: 'yes' })
        .success,
    ).toBe(false);
  });

  it('accepts sort, direction and the cursor key of conversations.list, and nothing else', () => {
    const base = { scope: { kind: 'unifiedInbox' }, limit: 50 };
    const ok = (x: object) => schemas['conversations.list'].safeParse({ ...base, ...x }).success;
    expect(ok({ cursor: null })).toBe(true);
    expect(ok({ cursor: { date: 5, id: 7, key: 'anna' }, sort: 'sender', direction: 'desc' })).toBe(true);
    expect(ok({ cursor: null, sort: 'subject' })).toBe(true);
    expect(ok({ cursor: null, sort: 'account' })).toBe(false);
    expect(ok({ cursor: null, direction: 'up' })).toBe(false);
    expect(ok({ cursor: { date: 5, id: 7, key: 'x'.repeat(501) } })).toBe(false);
  });

  it('checks folders.count, contacts.get, compose.clearPaused, messages.saveEml and ui.showUndo', () => {
    expect(schemas['folders.count'].safeParse({ folderId: 3 }).success).toBe(true);
    expect(schemas['folders.count'].safeParse({ folderId: 'allInboxes', accountId: 'a1' }).success).toBe(true);
    expect(schemas['folders.count'].safeParse({ folderId: 'allInboxes', accountId: null }).success).toBe(true);
    expect(schemas['folders.count'].safeParse({ folderId: 'inbox' }).success).toBe(false);
    expect(schemas['contacts.get'].safeParse({ address: 'a@b.co' }).success).toBe(true);
    expect(schemas['contacts.get'].safeParse({ address: 'a' }).success).toBe(false);
    expect(schemas['compose.clearPaused'].safeParse({ draftId: 'd1' }).success).toBe(true);
    expect(schemas['compose.clearPaused'].safeParse({}).success).toBe(false);
    expect(schemas['messages.saveEml'].safeParse({ messageId: 4 }).success).toBe(true);
    expect(schemas['messages.saveEml'].safeParse({ messageId: -1 }).success).toBe(false);
    expect(schemas['ui.showUndo'].safeParse({ label: 'Message archived', undoToken: 'tok', count: 2 }).success).toBe(true);
    expect(schemas['ui.showUndo'].safeParse({ label: '', undoToken: 'tok' }).success).toBe(false);
    expect(schemas['ui.showUndo'].safeParse({ label: 'x', undoToken: '' }).success).toBe(false);
  });

  it('routes saveEml and showUndo to main, and the rest to the engine', () => {
    for (const c of ['messages.saveEml', 'ui.showUndo'] as const) {
      expect(isKnownChannel(c)).toBe(true);
      expect(MAIN_CHANNELS).toContain(c);
    }
    for (const c of ['folders.count', 'contacts.get', 'compose.clearPaused']) {
      expect(isKnownChannel(c)).toBe(true);
      expect(isMainChannel(c)).toBe(false);
    }
  });
});

describe('file names for Save as .eml', () => {
  it('uses the subject, cleaned up', () => {
    expect(emlFileName('Quarterly budget review')).toBe('Quarterly budget review.eml');
    expect(emlFileName('Re: Plan A/B <draft> "final"?')).toBe('Re_ Plan A_B _draft_ _final__.eml');
    expect(emlFileName('  line\none\ttab  ')).toBe('line one tab.eml');
  });

  it('never gives a path, a reserved Windows name, an empty name or a dot name', () => {
    expect(emlFileName('..\\..\\Windows\\system32')).not.toMatch(/[\\/]/);
    expect(emlFileName('CON')).toBe('_CON.eml');
    expect(emlFileName('nul.txt')).toBe('_nul.txt.eml');
    expect(emlFileName('')).toBe('message.eml');
    expect(emlFileName(null)).toBe('message.eml');
    expect(emlFileName('...')).toBe('message.eml');
    expect(emlFileName('   ')).toBe('message.eml');
    expect(emlFileName('Hello. ')).toBe('Hello.eml');
  });

  it('cuts very long subjects and keeps letters of other languages', () => {
    const long = emlFileName('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(104);
    expect(long.endsWith('.eml')).toBe(true);
    expect(emlFileName('Fattura di ottobre \u2013 \u4f1a\u8bae')).toBe('Fattura di ottobre \u2013 \u4f1a\u8bae.eml');
    expect(safeFileStem('a:b', 'f')).toBe('a_b');
  });
});

describe('saveEml', () => {
  const bytes = new Uint8Array([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0xff, 0xfe, 0x0d, 0x0a]); // not valid UTF-8
  function deps(over: Partial<SaveEmlDeps> = {}): SaveEmlDeps & { written: { path: string; data: Uint8Array }[]; asked: string[] } {
    const written: { path: string; data: Uint8Array }[] = [];
    const asked: string[] = [];
    return {
      written,
      asked,
      fetchSource: async () => ({ data: bytes, subject: 'Budget: Q4/2026' }),
      defaultDir: () => 'C:\\Users\\test\\Downloads',
      chooseFile: async (p) => {
        asked.push(p);
        return 'C:\\Users\\test\\Desktop\\budget';
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      ...over,
    };
  }

  it('asks with a name made from the subject and writes the exact bytes', async () => {
    const d = deps();
    const res = await saveEml(d, 5);
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]).toMatch(/Downloads[\\/]Budget_ Q4_2026\.eml$/);
    expect(res).toEqual({ saved: true, path: 'C:\\Users\\test\\Desktop\\budget.eml' });
    expect(d.written).toHaveLength(1);
    expect(Array.from(d.written[0]!.data)).toEqual(Array.from(bytes)); // no text conversion
  });

  it('does not add .eml twice', async () => {
    const d = deps({ chooseFile: async () => 'C:\\x\\mail.EML' });
    expect((await saveEml(d, 1)).path).toBe('C:\\x\\mail.EML');
  });

  it('writes nothing when the user cancels the dialog', async () => {
    const d = deps({ chooseFile: async () => null });
    expect(await saveEml(d, 1)).toEqual({ saved: false });
    expect(d.written).toHaveLength(0);
  });

  it('offline: the error comes before any dialog opens, nothing is written', async () => {
    const chooseFile = vi.fn(async () => 'C:\\x\\a.eml');
    const d = deps({
      fetchSource: async () => {
        throw new AppException('HOST_UNREACHABLE', 'You are offline. Connect to the internet to save this message.');
      },
      chooseFile,
    });
    await expect(saveEml(d, 1)).rejects.toMatchObject({ appError: { code: 'HOST_UNREACHABLE' } });
    expect(chooseFile).not.toHaveBeenCalled();
    expect(d.written).toHaveLength(0);
  });

  it('passes a write error on', async () => {
    const d = deps({
      writeFile: async () => {
        throw new Error('EACCES');
      },
    });
    await expect(saveEml(d, 1)).rejects.toThrow('EACCES');
  });
});

describe('Undo relay from the message window', () => {
  function win(over: Partial<{ destroyed: boolean; visible: boolean; minimized: boolean }> = {}) {
    const send = vi.fn();
    const w: RelayTarget = {
      isDestroyed: () => over.destroyed ?? false,
      isVisible: () => over.visible ?? true,
      isMinimized: () => over.minimized ?? false,
      webContents: { send },
    };
    return { w, send };
  }
  const e = { label: 'Message archived', undoToken: 'tok-1', count: 1 };

  it('sends ui:undoAvailable to the main window and says so', () => {
    const { w, send } = win();
    expect(relayUndoToMain(w, e)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('event', {
      type: 'ui:undoAvailable',
      label: 'Message archived',
      undoToken: 'tok-1',
      count: 1,
    });
  });

  it('tells the message window to keep its own Undo when nobody can see the main window', () => {
    for (const over of [{ destroyed: true }, { visible: false }, { minimized: true }]) {
      const { w, send } = win(over);
      expect(relayUndoToMain(w, e)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    }
    expect(relayUndoToMain(null, e)).toBe(false);
  });
});

describe('ui.showUndo and messages.saveEml handlers', () => {
  it('ui.showUndo hands the toast to main and returns whether it was delivered', async () => {
    const { createMainHandlers } = await import('../../src/main/handlers');
    const showUndoInMain = vi.fn(() => true);
    const handlers = createMainHandlers({ showUndoInMain } as never);
    expect(await handlers['ui.showUndo']({ label: 'Deleted', undoToken: 'tk', count: 3 })).toEqual({ delivered: true });
    expect(showUndoInMain).toHaveBeenCalledWith({ label: 'Deleted', undoToken: 'tk', count: 3 });
    showUndoInMain.mockReturnValue(false);
    expect(await handlers['ui.showUndo']({ label: 'Deleted', undoToken: 'tk' })).toEqual({ delivered: false });
    expect(showUndoInMain).toHaveBeenLastCalledWith({ label: 'Deleted', undoToken: 'tk', count: 0 });
  });
});

describe('quit prompt state', () => {
  it('starts unanswered, remembers an answer, and forgets it when the quit is cancelled', () => {
    const q = new QuitState();
    expect(q.confirmed).toBe(false);
    q.confirm();
    expect(q.confirmed).toBe(true);
    q.cancel();
    expect(q.confirmed).toBe(false);
  });

  it('closing the main window through the prompt while a compose window stays open: the next quit asks again', () => {
    const q = new QuitState();
    q.confirm(); // "Quit anyway"
    q.mainWindowClosed({ windowsLeft: 1, quitting: false });
    expect(q.confirmed).toBe(false);
  });

  it('closing the last window keeps the answer, so the quit that follows does not ask twice', () => {
    const q = new QuitState();
    q.confirm();
    q.mainWindowClosed({ windowsLeft: 0, quitting: false });
    expect(q.confirmed).toBe(true);
  });

  it('a quit that is really under way keeps its answer even with windows left', () => {
    const q = new QuitState();
    q.confirm();
    q.mainWindowClosed({ windowsLeft: 2, quitting: true });
    expect(q.confirmed).toBe(true);
  });

  it('a window closing with no answer given changes nothing', () => {
    const q = new QuitState();
    q.mainWindowClosed({ windowsLeft: 1, quitting: false });
    expect(q.confirmed).toBe(false);
  });
});

describe('Show in folder', () => {
  it('SavedPaths remembers a path (any spelling of the same Windows path), forgets the oldest', () => {
    const p = new SavedPaths(2);
    p.add('C:\\Users\\me\\Mail.eml');
    expect(p.has('c:\\users\\me\\mail.eml')).toBe(true);
    expect(p.has('C:\\Users\\me\\other.eml')).toBe(false);
    p.add('C:\\a.eml');
    p.add('C:\\b.eml');
    expect(p.has('C:\\Users\\me\\Mail.eml')).toBe(false);
    expect(p.has('C:\\b.eml')).toBe(true);
  });

  it('the request check wants a non-empty path', () => {
    expect(schemas['app.showItemInFolder'].safeParse({ path: 'C:\\x.eml' }).success).toBe(true);
    expect(schemas['app.showItemInFolder'].safeParse({ path: '' }).success).toBe(false);
    expect(schemas['app.showItemInFolder'].safeParse({}).success).toBe(false);
    expect(isMainChannel('app.showItemInFolder')).toBe(true);
  });

  it('reveals only a file that Save as .eml wrote, and refuses any other path', async () => {
    const { createMainHandlers } = await import('../../src/main/handlers');
    const dir = mkdtempSync(join(tmpdir(), 'ld-eml-'));
    try {
      const target = join(dir, 'note.eml');
      electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
      const handlers = createMainHandlers({
        engine: { request: async () => ({ data: new Uint8Array([65]), subject: 'Note' }) },
        getWindow: () => null,
      } as never);
      // Before anything was saved, nothing can be revealed.
      expect(() => handlers['app.showItemInFolder']({ path: target })).toThrow();
      expect(await handlers['messages.saveEml']({ messageId: 1 })).toEqual({ saved: true, path: target });
      await handlers['app.showItemInFolder']({ path: target });
      expect(electron.showItemInFolder).toHaveBeenCalledWith(target);
      electron.showItemInFolder.mockClear();
      expect(() => handlers['app.showItemInFolder']({ path: 'C:\\Windows\\System32\\cmd.exe' })).toThrow();
      expect(electron.showItemInFolder).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
