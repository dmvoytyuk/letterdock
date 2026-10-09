// DESIGN-SPEC 1.7. The engine stores the light-mode hex; we map it to the dark variant in dark mode.
export interface PaletteColor {
  name: string;
  light: string;
  dark: string;
}
export const PALETTE: PaletteColor[] = [
  { name: 'Blue', light: '#0F6CBD', dark: '#479EF5' },
  { name: 'Teal', light: '#0E7C7B', dark: '#3FC1BF' },
  { name: 'Green', light: '#107C10', dark: '#54B054' },
  { name: 'Olive', light: '#5E7C00', dark: '#A3C93A' },
  { name: 'Gold', light: '#9A6700', dark: '#F2C661' },
  { name: 'Orange', light: '#C74B00', dark: '#FF9A5C' },
  { name: 'Red', light: '#C42B1C', dark: '#FF7B6E' },
  { name: 'Pink', light: '#C239B3', dark: '#E98AE0' },
  { name: 'Purple', light: '#5B4BD1', dark: '#A79CF5' },
  { name: 'Indigo', light: '#3B4BA8', dark: '#8B9BEB' },
  { name: 'Brown', light: '#8A5A44', dark: '#D0A58F' },
  { name: 'Slate', light: '#5B6670', dark: '#A9B4BE' },
];

export function resolveAccountColor(stored: string | null, dark: boolean, index = 0): string {
  if (!stored) {
    const p = PALETTE[index % PALETTE.length]!;
    return dark ? p.dark : p.light;
  }
  const hit = PALETTE.find((p) => p.light.toLowerCase() === stored.toLowerCase());
  if (hit) return dark ? hit.dark : hit.light;
  return stored;
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black text, whichever reads better on the given tile color. */
export function onColor(bg: string): string {
  return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#0B0B0B') ? '#FFFFFF' : '#0B0B0B';
}

export function isHexColor(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v);
}
