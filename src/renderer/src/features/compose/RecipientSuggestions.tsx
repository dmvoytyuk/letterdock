// The suggestion list under a recipient field (DESIGN-SPEC 3.7.1). It only draws; the field owns the keys.
import { useEffect, useRef, type ReactNode } from 'react';
import type { ContactSuggestion } from '../../../../shared/ipc';
import { Icon } from '../../components/Icon';
import { AccountBadge } from '../../components/ui';
import { useApp } from '../../store/app';
import { PALETTE } from '../../lib/colors';
import { initials } from '../../lib/format';
import { useAccountColor } from '../../lib/hooks';

const DAY = 86_400_000;

/** Lower case with accents removed, one output character per input character. */
function fold(s: string): string {
  let out = '';
  for (const ch of s) out += ch.normalize('NFD')[0]!.toLowerCase();
  return out;
}

/**
 * Splits `text` so that the part the user typed is bold. The typed text matches at the start of a word
 * in a name, or at the start of an address or of a part after . - _ @ (bold only, no color).
 */
export function highlight(text: string, query: string, kind: 'name' | 'address'): ReactNode {
  const q = fold(query.trim());
  if (!q) return text;
  const hay = fold(text);
  const boundary = kind === 'name' ? /[\s\-'.]/ : /[.\-_@]/;
  let at = -1;
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + 1)) {
    if (i === 0 || boundary.test(hay[i - 1]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function hintOf(c: ContactSuggestion, now = Date.now()): string {
  if (c.isOwn) return 'Your account';
  if (c.sentCount >= 2) return `Sent ${c.sentCount} times`;
  if (now - c.lastUsed <= 30 * DAY) return 'Recent';
  return '';
}

export function optionLabel(c: ContactSuggestion, otherAccountName?: string): string {
  const who = c.name ? `${c.name}, ${c.address}` : c.address;
  if (c.isOwn) return `${who}, your account`;
  if (otherAccountName) return `${who}, from ${otherAccountName}`;
  return c.sentCount >= 2 ? `${who}, sent ${c.sentCount} times` : who;
}

export interface SuggestionsPlacement {
  left: number;
  width: number;
  /** Either top or bottom is set (the list flips above the field when there is no room below). */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function RecipientSuggestions({
  listId,
  items,
  activeIndex,
  query,
  placement,
  removing,
  onPick,
  onHover,
  onForget,
}: {
  listId: string;
  items: ContactSuggestion[];
  activeIndex: number;
  query: string;
  placement: SuggestionsPlacement;
  /** Addresses that are fading out after "Remove from suggestions". */
  removing: ReadonlySet<string>;
  onPick: (c: ContactSuggestion) => void;
  onHover: (index: number) => void;
  onForget: (c: ContactSuggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const accounts = useApp((st) => st.accounts);
  const colorOf = useAccountColor();

  // Keep the active row in view when the list scrolls.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${activeIndex}`)}`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId]);

  return (
    <div
      className="rsug"
      style={{
        left: placement.left,
        width: placement.width,
        top: placement.top,
        bottom: placement.bottom,
        maxHeight: placement.maxHeight,
      }}
      // The input must keep focus: a press on the list never moves it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={listRef} id={listId} role="listbox" aria-label="Suggested contacts" className="rsug-list">
        {items.map((c, i) => {
          // Addresses known only from another account (the setting "Suggest addresses from all my accounts").
          const other = c.otherAccountId ? accounts.find((a) => a.id === c.otherAccountId) : undefined;
          const hint = other && !c.isOwn ? `From ${other.displayName}` : hintOf(c);
          const firstOther = !!other && !items.slice(0, i).some((x) => x.otherAccountId) && i > 0;
          const shownName = c.name ?? c.address;
          const tint = PALETTE[hash(c.address) % PALETTE.length]!;
          const active = i === activeIndex;
          return (
            <div
              key={c.address}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={active}
              aria-label={optionLabel(c, other?.displayName)}
              title={other ? `You know this address from ${other.displayName} (${other.email})` : undefined}
              className={`rsug-row ${active ? 'active' : ''} ${c.isOwn ? 'own' : ''} ${other ? 'other' : ''} ${firstOther ? 'first-other' : ''} ${removing.has(c.address) ? 'removing' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseMove={() => {
                if (!active) onHover(i);
              }}
            >
              <span className="rsug-av" style={{ ['--tint' as string]: tint.light }} aria-hidden="true">
                {initials(shownName)}
              </span>
              <span className="rsug-tx">
                <span className="rsug-nm">{highlight(shownName, query, c.name ? 'name' : 'address')}</span>
                {c.name ? <span className="rsug-ad">{highlight(c.address, query, 'address')}</span> : null}
              </span>
              {other ? (
                <AccountBadge color={colorOf(other.id)} name={other.displayName} letter={other.badge} />
              ) : null}
              {hint ? <span className="rsug-hint">{hint}</span> : null}
              {!c.isOwn ? (
                <button
                  type="button"
                  className="rsug-x ibtn xs"
                  tabIndex={-1}
                  title="Remove from suggestions. This does not delete the contact from your account."
                  aria-label={`Remove ${shownName} from suggestions`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onForget(c);
                  }}
                >
                  <Icon name="x" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
