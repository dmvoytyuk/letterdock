import type { ConversationParticipant, ConversationRow } from '../../../../shared/ipc';

/** Names for the first line of a conversation row (DESIGN-SPEC 3.10.2): up to 3, then "+N". */
export interface ParticipantView {
  shown: { label: string; unread: boolean; me: boolean }[];
  more: number;
}

function fullNameOf(p: ConversationParticipant): string {
  return p.name?.trim() || p.address;
}

function firstNameOf(p: ConversationParticipant): string {
  const full = fullNameOf(p);
  if (!p.name?.trim()) return full;
  return full.split(/\s+/)[0] ?? full;
}

export function participantView(list: ConversationParticipant[]): ParticipantView {
  const first = list.slice(0, 3);
  const firsts = first.filter((p) => !p.isMe).map((p) => firstNameOf(p).toLowerCase());
  const unique = new Set(firsts).size === firsts.length;
  return {
    shown: first.map((p) => ({
      label: p.isMe ? 'me' : unique ? firstNameOf(p) : fullNameOf(p),
      unread: p.hasUnread,
      me: p.isMe,
    })),
    more: Math.max(0, list.length - first.length),
  };
}

/** Plain text of the participants, for tooltips and screen readers. */
export function participantText(list: ConversationParticipant[]): string {
  const v = participantView(list);
  return v.shown.map((s) => s.label).join(', ') + (v.more > 0 ? ` and ${v.more} more` : '');
}

/**
 * "Anna, Bob, me +2 (3)": names with an unread message are bold; the count never gets cut off,
 * only the names are shortened with an ellipsis.
 */
export function ConversationParticipants({ conv }: { conv: ConversationRow }) {
  const v = participantView(conv.participants);
  return (
    <span className="cparts">
      <span className="cn">
        {v.shown.map((s, i) => (
          <span key={i} className={s.unread ? 'u' : undefined}>
            {s.label}
            {i < v.shown.length - 1 ? ', ' : ''}
          </span>
        ))}
        {v.more > 0 ? ` +${v.more}` : ''}
      </span>
      <span className="cc">({conv.count})</span>
    </span>
  );
}
