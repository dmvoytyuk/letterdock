// Inline SVG icons in a Fluent-like outline style (ported from the approved mockup).
const P = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  stack: '<path d="M3 8l9-5 9 5-9 5z"/><path d="m3 13 9 5 9-5"/>',
  'panel-left-close': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  'panel-left-open': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chev-r': '<path d="m9 6 6 6-6 6"/>',
  'chev-d': '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  replyall:
    '<path d="m7 14-5-5 5-5"/><path d="M12 14 7 9l5-5"/><path d="M7 9h8a6 6 0 0 1 6 6v3"/>',
  fwd: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  flag: '<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>',
  unread:
    '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="m3 9 9 6 9-6"/><circle cx="19" cy="5" r="2.5" class="fillme"/>',
  clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5M3 13l3-8h12l3 8v6H3z"/>',
  send: '<path d="M21 3 3 11l7 3 3 7zM10 14l11-11"/>',
  draft: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  spam: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M12 8v5M12 16v.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 17.5v.5"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  'check-sq': '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.600 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  more: '<circle cx="5" cy="12" r="1.3" class="fillme"/><circle cx="12" cy="12" r="1.3" class="fillme"/><circle cx="19" cy="12" r="1.3" class="fillme"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" class="fillme"/><circle cx="4.5" cy="12" r="1" class="fillme"/><circle cx="4.5" cy="18" r="1" class="fillme"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  'cloud-off':
    '<path d="M3 3l18 18M7.500 7.500A5.5 5.5 0 0 0 7 18h11a3.5 3.5 0 0 0 1.500-.3M17 10a5.5 5.5 0 0 0-8.700-3.200"/>',
  'bell-off':
    '<path d="M3 3l18 18M8 5.5A6 6 0 0 1 18 10v3l2 3H8M6 10v4l-2 3h2M10 20a2 2 0 0 0 4 0"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  'mail-open':
    '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
  /** Clock with a back arrow: changes waiting to sync. */
  pending: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  print:
    '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  'open-window':
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
} as const;

export type IconName = keyof typeof P;

export function Icon({
  name,
  size = 16,
  filled,
  label,
  className,
}: {
  name: IconName;
  size?: 16 | 20 | 24 | 48;
  filled?: boolean;
  label?: string;
  className?: string;
}) {
  const html = P[name].replace(/class="fillme"/g, 'fill="currentColor" stroke="none"');
  return (
    <svg
      className={`i${size === 16 ? '' : ' s' + size}${filled ? ' fill' : ''}${className ? ' ' + className : ''}`}
      viewBox="0 0 24 24"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MsLogo() {
  return (
    <span className="msq" aria-hidden="true">
      <i style={{ background: '#F25022' }} />
      <i style={{ background: '#7FBA00' }} />
      <i style={{ background: '#00A4EF' }} />
      <i style={{ background: '#FFB900' }} />
    </span>
  );
}
