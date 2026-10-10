// Windows toast XML with action buttons (DESIGN-SPEC 3.13.3). Pure functions, so they can be tested.
//
// Electron 44 takes a `toastXml` option on Windows ("superseding all properties") and reports every
// click, reply and button press through `Notification.handleActivation(cb)`, which also works after
// a cold start. `cb` gets the raw `arguments` string of the thing that was pressed. We put what we
// need into that string: what to do, the account and the message.
//
// The buttons use activationType="background": pressing one runs the work without bringing any
// window to the front.

export type ToastAction = 'open' | 'read' | 'archive';

export interface ToastContext {
  accountId: string;
  messageId: number;
}

export interface ToastButton {
  action: Exclude<ToastAction, 'open'>;
  label: string;
}

export interface ToastXmlSpec {
  title: string;
  body: string;
  silent: boolean;
  context: ToastContext;
  buttons: ToastButton[];
  /** Absolute path of the app icon (shown small at the left). Optional. */
  iconPath?: string;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(s: string): string {
  // Characters XML 1.0 does not allow at all are dropped; the rest is escaped.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

/** `a=read&acc=...&msg=42` (values URL-encoded). */
export function encodeActivationArgs(action: ToastAction, ctx: ToastContext): string {
  const q = new URLSearchParams({ a: action, acc: ctx.accountId, msg: String(ctx.messageId) });
  return q.toString();
}

export interface ParsedActivation {
  action: ToastAction;
  accountId: string;
  messageId: number;
}

/** Reads the `arguments` string of an activation. Returns null for anything that is not ours or not valid. */
export function parseActivationArgs(raw: string | undefined | null): ParsedActivation | null {
  if (!raw || raw.length > 600) return null;
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const a = q.get('a');
  const acc = q.get('acc');
  const msg = q.get('msg');
  if (a !== 'open' && a !== 'read' && a !== 'archive') return null;
  if (!acc || acc.length > 100) return null;
  if (!msg || !/^\d{1,12}$/.test(msg)) return null;
  return { action: a, accountId: acc, messageId: Number(msg) };
}

export function buildToastXml(spec: ToastXmlSpec): string {
  const launch = escapeXml(encodeActivationArgs('open', spec.context));
  const text = (s: string) => (s ? `<text>${escapeXml(s)}</text>` : '');
  const image = spec.iconPath
    ? `<image placement="appLogoOverride" src="${escapeXml(`file:///${spec.iconPath.replace(/\\/g, '/')}`)}"/>`
    : '';
  const buttons = spec.buttons
    .map(
      (b) =>
        `<action content="${escapeXml(b.label)}" arguments="${escapeXml(
          encodeActivationArgs(b.action, spec.context),
        )}" activationType="background"/>`,
    )
    .join('');
  return (
    `<toast launch="${launch}" activationType="foreground">` +
    `<visual><binding template="ToastGeneric">${image}${text(spec.title)}${text(spec.body)}</binding></visual>` +
    (spec.silent ? '<audio silent="true"/>' : '') +
    (buttons ? `<actions>${buttons}</actions>` : '') +
    '</toast>'
  );
}
