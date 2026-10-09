// "Save as .eml": fetch the raw message, ask where to put it, write the bytes. The pieces that touch
// Electron and the file system are passed in, so the logic can be tested without a window.
import { join } from 'node:path';
import type { SaveEmlRes } from '../shared/ipc';
import { emlFileName } from '../shared/fileName';

export interface SaveEmlDeps {
  /** Asks the engine for the raw bytes (rejects with HOST_UNREACHABLE when offline). */
  fetchSource: (messageId: number) => Promise<{ data: Uint8Array; subject: string }>;
  /** The folder the dialog starts in. */
  defaultDir: () => string;
  /** The native save dialog. Returns the chosen path, or null when the user cancelled. */
  chooseFile: (defaultPath: string) => Promise<string | null>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
}

export async function saveEml(deps: SaveEmlDeps, messageId: number): Promise<SaveEmlRes> {
  // Fetch first: an offline problem is reported before any dialog opens.
  const src = await deps.fetchSource(messageId);
  const target = await deps.chooseFile(join(deps.defaultDir(), emlFileName(src.subject)));
  if (!target) return { saved: false };
  const path = /\.eml$/i.test(target) ? target : `${target}.eml`;
  await deps.writeFile(path, src.data);
  return { saved: true, path };
}
