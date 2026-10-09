// Small pure safety checks shared by main and engine.

/** Only http, https and mailto may leave the app (ARCHITECTURE section 6, rule 9). */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

export const EXECUTABLE_EXTENSIONS = [
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
  '.js',
  '.vbs',
  '.msi',
  '.lnk',
  '.scr',
  '.com',
  '.hta',
];

/** Files that can run code. Opening them needs a warning (ARCHITECTURE section 9). */
export function isExecutableName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXECUTABLE_EXTENSIONS.some((e) => lower.endsWith(e));
}

/** C0 control characters (U+0000 to U+001F) and DEL (U+007F). */
export function isControlCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** Does the text contain a control character (line break, tab, NUL, DEL...)? */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isControlCode(text.charCodeAt(i))) return true;
  return false;
}

/** Replaces every control character with `replacement` (default: removes it). */
export function replaceControlChars(text: string, replacement = ''): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += isControlCode(text.charCodeAt(i)) ? replacement : text[i];
  }
  return out;
}
