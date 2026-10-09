// Printing a message through the system print dialog (DESIGN-SPEC 3.9).
// The open message view registers a function that returns the sanitized LIGHT body for printing,
// so Ctrl+P (which lives outside the view) can reach it.
import type { MessageId } from '../../../shared/ipc';
import { call } from './api';
import { toast, toastError, useToasts } from '../store/toasts';

export interface PrintSource {
  messageId: MessageId;
  /** Sanitized light body, or undefined for a plain text message. Null while the body is still loading. */
  getBodyHtml: () => string | undefined | null;
}

let source: PrintSource | null = null;

/** Called by the message view while it is on screen. Returns the unregister function. */
export function registerPrintSource(s: PrintSource): () => void {
  source = s;
  return () => {
    if (source === s) source = null;
  };
}

/** Removes remote images that were blocked, so no empty image box is printed. */
export function cleanForPrint(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('img[data-blocked-src]').forEach((img) => img.remove());
  doc.querySelectorAll('[data-blocked-src]').forEach((el) => el.removeAttribute('data-blocked-src'));
  return doc.body.innerHTML;
}

export async function printMessage(messageId: MessageId, bodyHtml?: string): Promise<void> {
  let preparing: number | null = window.setTimeout(() => {
    preparing = null;
    toast('Preparing to print...', { duration: 2500 });
  }, 1000);
  try {
    await call('message.print', { messageId, ...(bodyHtml ? { bodyHtml: cleanForPrint(bodyHtml) } : {}) });
  } catch {
    toastError("Couldn't print this message.", {
      actionLabel: 'Retry',
      onAction: () => void printMessage(messageId, bodyHtml),
    });
  } finally {
    if (preparing !== null) window.clearTimeout(preparing);
    for (const t of useToasts.getState().items) {
      if (t.message === 'Preparing to print...') useToasts.getState().dismiss(t.id);
    }
  }
}

/** Ctrl+P and the "Print" menu items. `messageId` must be the message that is open. */
export function printOpenMessage(messageId: MessageId | undefined): void {
  if (messageId === undefined) {
    toast('Select one message to print it.');
    return;
  }
  if (!source || source.messageId !== messageId) {
    toast('The message is not ready to print yet.');
    return;
  }
  const html = source.getBodyHtml();
  if (html === null) {
    toast('The message is still loading.');
    return;
  }
  void printMessage(messageId, html);
}
