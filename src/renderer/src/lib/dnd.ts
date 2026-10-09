import type { AccountId, MessageId } from '../../../shared/ipc';

/** What is being dragged from the message list (the browser hides drag data while hovering). */
export interface DragState {
  ids: MessageId[];
  accountIds: Set<AccountId>;
}
export const DRAG_TYPE = 'application/x-mailroom-messages';

let current: DragState | null = null;
export const getDrag = (): DragState | null => current;

export function startDrag(e: DragEvent, ids: MessageId[], accountIds: AccountId[], label: string): void {
  current = { ids, accountIds: new Set(accountIds) };
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'move';
  dragPill(e, label, ids.length);
}

export function endDrag(): void {
  current = null;
  document.body.classList.remove('dragging-mail');
}

/** A small pill with the subject and a count, instead of the default snapshot of the row. */
export function dragPill(e: DragEvent, label: string, count: number): void {
  const pill = document.createElement('div');
  pill.className = 'drag-pill';
  const text = document.createElement('span');
  text.textContent = label || '(no subject)';
  pill.appendChild(text);
  if (count > 1) {
    const badge = document.createElement('b');
    badge.textContent = `+${count - 1}`;
    pill.appendChild(badge);
  }
  document.body.appendChild(pill);
  e.dataTransfer?.setDragImage(pill, 16, 16);
  document.body.classList.add('dragging-mail');
  setTimeout(() => pill.remove(), 0);
}
