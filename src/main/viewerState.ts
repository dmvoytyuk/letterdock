// Pure helpers of the message window (no Electron), so tests can import them.

export interface ViewerSize {
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_VIEWER_SIZE: ViewerSize = { width: 900, height: 760, maximized: false };
const MIN_W = 480;
const MIN_H = 400;

/** Hash value the viewer renderer reads: `#msg=<messageId>`. */
export function viewerHash(messageId: number): string {
  return `msg=${encodeURIComponent(String(messageId))}`;
}

/** Reads a saved size; anything odd falls back to the default. */
export function parseViewerSize(raw: string | null): ViewerSize {
  try {
    const s = JSON.parse(raw ?? '') as Partial<ViewerSize>;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!ok(s.width) || !ok(s.height)) return DEFAULT_VIEWER_SIZE;
    return {
      width: Math.min(8000, Math.max(MIN_W, Math.round(s.width))),
      height: Math.min(8000, Math.max(MIN_H, Math.round(s.height))),
      maximized: s.maximized === true,
    };
  } catch {
    return DEFAULT_VIEWER_SIZE;
  }
}
