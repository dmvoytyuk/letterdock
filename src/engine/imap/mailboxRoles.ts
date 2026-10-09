import type { FolderRole } from '../../shared/ipc';

const SPECIAL_USE: Record<string, FolderRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\flagged': 'flagged',
};

const NAME_HEURISTICS: [RegExp, FolderRole][] = [
  [
    /^(sent|sent items|sent mail|sent messages|posta inviata|inviati|gesendet|envoy[eé]s?|enviados)$/i,
    'sent',
  ],
  [/^(drafts?|bozze|entw[uü]rfe|brouillons|borradores)$/i, 'drafts'],
  [/^(trash|deleted items|deleted messages|bin|cestino|papierkorb|corbeille|papelera)$/i, 'trash'],
  [/^(junk|junk e-?mail|spam|bulk mail|posta indesiderata)$/i, 'junk'],
  [/^(archive|archives|archivio|archiv|archivo)$/i, 'archive'],
];

export interface ListEntry {
  path: string;
  name: string;
  specialUse?: string | null;
}

/**
 * Map a LIST entry to a folder role: INBOX by name, then SPECIAL-USE, then name heuristics
 * (for servers without SPECIAL-USE). Only the leaf name is matched by heuristics.
 */
export function mapRole(entry: ListEntry): FolderRole | null {
  if (entry.path.toUpperCase() === 'INBOX') return 'inbox';
  if (entry.specialUse) {
    const r = SPECIAL_USE[entry.specialUse.toLowerCase()];
    if (r) return r;
  }
  for (const [re, role] of NAME_HEURISTICS) {
    if (re.test(entry.name)) return role;
  }
  return null;
}

/** Make sure each role is held by at most one folder (first wins; INBOX always wins 'inbox'). */
export function dedupeRoles<T extends { role: FolderRole | null }>(folders: T[]): T[] {
  const seen = new Set<FolderRole>();
  return folders.map((f) => {
    if (!f.role) return f;
    if (seen.has(f.role)) return { ...f, role: null };
    seen.add(f.role);
    return f;
  });
}

/** Order used when syncing folders after discovery (ARCHITECTURE 5.4). */
export function syncPriority(role: FolderRole | null): number {
  switch (role) {
    case 'inbox':
      return 0;
    case 'sent':
      return 1;
    case 'drafts':
      return 2;
    case 'archive':
      return 3;
    case 'trash':
      return 5;
    case 'junk':
      return 6;
    default:
      return 4;
  }
}
