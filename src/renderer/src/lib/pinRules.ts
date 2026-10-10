// Where Pin is offered (DESIGN-SPEC 3.13.6): folder lists and All inboxes. Not in Unread, Flagged,
// Snoozed, search, Outbox or Scheduled, and not while a filter is on (pins are ignored there).
import type { View } from '../store/ui';

export function canPinHere(view: View, unreadOnly = false): boolean {
  if (unreadOnly) return false;
  return view.kind === 'all' || view.kind === 'account' || view.kind === 'folder';
}
