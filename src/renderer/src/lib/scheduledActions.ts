// What the buttons of a scheduled message do (DESIGN-SPEC 3.11.4).
import type { ScheduledItem } from '../../../shared/ipc';
import { asAppError, call } from './api';
import { MIN_AHEAD_MS, whenText } from './schedule';
import { toast, toastError } from '../store/toasts';
import { useScheduled } from '../store/scheduled';

function report(e: unknown): void {
  const err = asAppError(e);
  toastError(err.code === 'CANCELLED' ? 'This message is already being sent.' : err.message);
}

/** Send now: no undo delay, the user asked for it. The row shows "Sending..." and then goes away. */
export async function sendNowScheduled(it: ScheduledItem): Promise<void> {
  try {
    await call('scheduled.sendNow', { id: it.id });
  } catch (e) {
    report(e);
  } finally {
    void useScheduled.getState().refetch();
  }
}

/** Edit: the schedule is paused, the message is a normal draft and opens in a compose window. */
export async function editScheduled(it: ScheduledItem): Promise<void> {
  try {
    // The engine keeps the old send time on the draft (`pausedSendAt`); the compose window reads it.
    const r = await call('scheduled.cancel', { id: it.id });
    await call('compose.openWindow', { mode: 'new', draftId: r.draftId });
  } catch (e) {
    report(e);
  } finally {
    void useScheduled.getState().refetch();
  }
}

export function changeTimeScheduled(it: ScheduledItem): void {
  useScheduled.setState({ pick: it });
}

export async function rescheduleTo(it: ScheduledItem, at: number): Promise<void> {
  try {
    await call('scheduled.reschedule', { id: it.id, sendAt: at });
    toast(`Scheduled for ${whenText(at)}.`);
  } catch (e) {
    report(e);
  } finally {
    void useScheduled.getState().refetch();
  }
}

/** Cancel send: the message becomes a normal draft (it is not deleted). Undo schedules it again. */
export async function cancelScheduled(it: ScheduledItem): Promise<void> {
  try {
    const r = await call('scheduled.cancel', { id: it.id });
    const canUndo = r.sendAt > Date.now() + MIN_AHEAD_MS;
    toast('Send cancelled. The message is in Drafts.', {
      duration: 6000,
      ...(canUndo
        ? {
            actionLabel: 'Undo',
            onAction: () => {
              call('scheduled.create', { draftId: r.draftId, sendAt: r.sendAt })
                .catch(report)
                .finally(() => void useScheduled.getState().refetch());
            },
          }
        : {}),
    });
  } catch (e) {
    report(e);
  } finally {
    void useScheduled.getState().refetch();
  }
}

export function askDeleteScheduled(it: ScheduledItem): void {
  useScheduled.setState({ confirmDelete: it });
}

export async function deleteScheduled(it: ScheduledItem): Promise<void> {
  try {
    await call('scheduled.delete', { id: it.id });
  } catch (e) {
    report(e);
  } finally {
    void useScheduled.getState().refetch();
  }
}
