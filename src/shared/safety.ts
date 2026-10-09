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
