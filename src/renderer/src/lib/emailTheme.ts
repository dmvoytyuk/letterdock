// Dark-theme rendering of HTML email bodies. DESIGN-SPEC 3.6.1 (read it before changing anything here).
//
// Pipeline (all on the sanitized HTML, before the iframe srcdoc is built):
//   classify()  -> plain | simple | designed
//   planBody()  -> chooses a variant: light | simple | transform | darkaware | card
//   verifyContrast() runs later on the loaded iframe document (see ReadingPane).
import * as csstree from 'css-tree';

// ---------- theme constants (same values as the dark tokens in app.css) ----------
export const SURFACE = '#2b2b2b';
export const TEXT1 = '#ffffff';
export const TEXT2 = '#cfcfcf';
export const ACCENT = '#479ef5';
export const ACCENT_H = '#62abf5';
export const BORDER = '#3a3a3a';
export const CODE_BG = '#262626';

export type EmailKind = 'plain' | 'simple' | 'designed';
export interface ClassifyResult {
  kind: EmailKind;
  reasons: string[];
}

// ---------- color parsing ----------
export interface Rgba {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

const NAMED_SRC = 'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';
let NAMED: Map<string, string> | null = null;
function named(name: string): string | undefined {
  if (!NAMED) {
    NAMED = new Map(NAMED_SRC.split(',').map((p) => p.split(':') as [string, string]));
  }
  return NAMED.get(name);
}

/** Words that are valid color values but carry no color of their own. */
const KEEP_WORDS = new Set(['transparent', 'inherit', 'initial', 'unset', 'revert', 'currentcolor', 'none']);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parseAlpha(s: string | undefined): number {
  if (s === undefined) return 1;
  const t = s.trim();
  const v = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
  return Number.isFinite(v) ? clamp(v, 0, 1) : 1;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Parse hex, rgb(a), hsl(a), named colors and `transparent`. Returns null when it cannot be parsed. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const a = parseAlpha(parts[3]);
    if (fn[1]!.startsWith('rgb')) {
      const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
      if (ch.some((v) => !Number.isFinite(v))) return null;
      return { r: clamp(ch[0]!, 0, 255), g: clamp(ch[1]!, 0, 255), b: clamp(ch[2]!, 0, 255), a };
    }
    const h = parseFloat(parts[0]!);
    const sat = parseFloat(parts[1]!) / 100;
    const lig = parseFloat(parts[2]!) / 100;
    if (![h, sat, lig].every(Number.isFinite)) return null;
    const [r, g, b] = hslToRgb(h, clamp(sat, 0, 1), clamp(lig, 0, 1));
    return { r, g, b, a };
  }
  if (/^[a-z]+$/.test(s)) {
    const hex = named(s);
    if (hex) return parseColor('#' + hex);
  }
  return null;
}

export function toCss(c: Rgba): string {
  const r = Math.round(clamp(c.r, 0, 255));
  const g = Math.round(clamp(c.g, 0, 255));
  const b = Math.round(clamp(c.b, 0, 255));
  if (c.a >= 0.999) return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `rgba(${r},${g},${b},${+c.a.toFixed(3)})`;
}

// ---------- OKLCH ----------
export interface Oklch {
  L: number; // 0..1
  C: number;
  h: number; // degrees
}

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
};

export function rgbToOklch(c: Rgba): Oklch {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  const h = C < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (v: [number, number, number]) => v.every((x) => x >= -0.0005 && x <= 1.0005);

/** OKLCH to sRGB. When the color is outside sRGB, chroma is reduced (hue and lightness kept). */
export function oklchToRgb(o: Oklch, alpha = 1): Rgba {
  let lin = oklchToLinear(o.L, o.C, o.h);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = o.C;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(o.L, mid, o.h))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear(o.L, lo, o.h);
  }
  return { r: fromLinear(clamp(lin[0], 0, 1)), g: fromLinear(clamp(lin[1], 0, 1)), b: fromLinear(clamp(lin[2], 0, 1)), a: alpha };
}

// ---------- the color mapping (spec 3.6.1 C) ----------
export type ColorRole = 'bg' | 'text' | 'border';

const NEUTRAL_C = 0.03;

export function isNeutralColor(c: Rgba, role: ColorRole): boolean {
  if (c.a < 0.05) return true;
  const o = rgbToOklch(c);
  if (o.C >= NEUTRAL_C) return false;
  if (role === 'bg') return o.L > 0.96;
  if (role === 'text') return o.L < 0.45;
  return true;
}

/** Chroma below this is "near-white or near-gray": such light backgrounds become dark surfaces. */
const SATURATED_C = 0.06;

/**
 * Designed mode: near-white and near-gray light backgrounds become dark. Saturated brand colors
 * (orange button, yellow banner) keep their hue and chroma, with at most a small drop in lightness;
 * the contrast pass fixes the text on them. Dark and mid-tone backgrounds stay.
 */
export function mapBackground(c: Rgba): Rgba {
  const o = rgbToOklch(c);
  if (o.L < 0.6) return c;
  if (o.C >= SATURATED_C) return oklchToRgb({ L: Math.max(o.L - 0.1, 0.45), C: o.C, h: o.h }, c.a);
  return oklchToRgb({ L: 0.27 + (1 - o.L) * 0.25, C: o.C * 0.8, h: o.h }, c.a);
}

/** Designed mode text: neutral dark and gray text use the theme colors; dark colored text is lightened. */
export function mapText(c: Rgba): Rgba {
  if (c.a < 0.05) return c;
  const o = rgbToOklch(c);
  if (o.C < NEUTRAL_C && o.L < 0.45) return parseColor(o.L < 0.35 ? TEXT1 : TEXT2)!;
  if (o.L < 0.55) return oklchToRgb({ L: clamp(1 - o.L, 0.72, 0.92), C: o.C, h: o.h }, c.a);
  return c;
}

export function mapBorder(c: Rgba): Rgba {
  const o = rgbToOklch(c);
  if (c.a > 0.05 && o.C < NEUTRAL_C && o.L > 0.8) return parseColor(BORDER)!;
  return c;
}

/** Simple mode: only neutral colors are touched. White backgrounds disappear into the theme. */
export function mapSimpleBackground(c: Rgba): Rgba {
  return isNeutralColor(c, 'bg') ? { r: 0, g: 0, b: 0, a: 0 } : c;
}
export const mapSimpleText = mapText;

// ---------- contrast ----------
export function relLuminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Put `top` over an opaque `base`. */
export function composite(top: Rgba, base: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 };
}

// ---------- CSS scanning helpers ----------
const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
const BG_PROPS = new Set(['background-color']);
const TEXT_PROPS = new Set(['color']);
const BORDER_PROPS = new Set([
  'border',
  'border-color',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'border-block',
  'border-inline',
]);

function roleOfProp(prop: string): ColorRole | null {
  if (BG_PROPS.has(prop) || prop === 'background') return 'bg';
  if (TEXT_PROPS.has(prop)) return 'text';
  if (BORDER_PROPS.has(prop)) return 'border';
  return null;
}

type ColorNode = csstree.Hash | csstree.FunctionNode | csstree.Identifier;

/** Find color tokens in a declaration value. `bad` counts tokens that look like colors but cannot be parsed. */
function colorNodes(value: csstree.CssNode): { nodes: ColorNode[]; bad: number } {
  const nodes: ColorNode[] = [];
  let bad = 0;
  csstree.walk(value, {
    enter(n: csstree.CssNode) {
      if (n.type === 'Hash') {
        nodes.push(n);
      } else if (n.type === 'Function') {
        const name = n.name.toLowerCase();
        if (COLOR_FUNCS.has(name)) nodes.push(n);
        else if (name === 'var' || name === 'color-mix' || name === 'oklch' || name === 'oklab' || name === 'lab' || name === 'lch' || name === 'hwb' || name === 'color' || name === 'calc' || name === 'light-dark') bad++;
        return csstree.walk.skip;
      } else if (n.type === 'Identifier') {
        const name = n.name.toLowerCase();
        if (name === 'transparent' || named(name)) nodes.push(n);
      }
      return undefined;
    },
  });
  return { nodes, bad };
}

function nodeColor(n: ColorNode): Rgba | null {
  return parseColor(csstree.generate(n));
}

function replaceNode(n: ColorNode, css: string): void {
  const target = n as unknown as Record<string, unknown>;
  delete target.children;
  delete target.value;
  target.type = 'Identifier';
  target.name = css;
}

const hasImage = (value: string) => /url\(|gradient\(/i.test(value);

/** Every declaration in a stylesheet or a style attribute, with its rule selector (if any). */
interface DeclRef {
  node: csstree.Declaration;
  selector: string | null;
}

function declsOf(ast: csstree.CssNode): DeclRef[] {
  const out: DeclRef[] = [];
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node: csstree.CssNode, _item: csstree.ListItem<csstree.CssNode>, _list: csstree.List<csstree.CssNode>) {
      out.push({ node: node as csstree.Declaration, selector: null });
    },
  });
  return out;
}

function parseSheet(css: string): csstree.CssNode | null {
  try {
    return csstree.parse(css, { context: 'stylesheet' });
  } catch {
    return null;
  }
}
function parseInline(css: string): csstree.CssNode | null {
  try {
    return csstree.parse(css, { context: 'declarationList' });
  } catch {
    return null;
  }
}

// ---------- document parsing ----------
function parseBody(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, 'text/html');
}

// ---------- A. classification ----------
interface Scan {
  nonNeutralBg: boolean;
  image: boolean;
  textColors: Set<string>;
  reasons: string[];
}

function scanDeclaration(prop: string, valueCss: string, valueNode: csstree.CssNode, scan: Scan, topLevel: boolean): void {
  if (prop === 'background-image' || prop === 'background') {
    if (hasImage(valueCss)) {
      scan.image = true;
      if (!scan.reasons.includes('background image or gradient')) scan.reasons.push('background image or gradient');
    }
  }
  const role = roleOfProp(prop);
  if (role === 'bg') {
    const { nodes, bad } = colorNodes(valueNode);
    if (bad > 0) scan.nonNeutralBg = true;
    for (const n of nodes) {
      const c = nodeColor(n);
      if (!c || !isNeutralColor(c, 'bg')) scan.nonNeutralBg = true;
    }
  } else if (role === 'text' && topLevel) {
    const { nodes } = colorNodes(valueNode);
    for (const n of nodes) {
      const c = nodeColor(n);
      if (c && !isNeutralColor(c, 'text')) scan.textColors.add(toCss(c));
    }
  }
}

function isTopLevelSelector(sel: string): boolean {
  return /^(html|body)\b/i.test(sel.trim());
}

/** First-level containers: direct children of body, or of a single wrapper element. */
function firstLevel(body: Element): Element[] {
  const out: Element[] = [body];
  const kids = [...body.children].filter((e) => e.tagName !== 'STYLE');
  out.push(...kids);
  if (kids.length === 1) out.push(...kids[0]!.children);
  return out;
}

function classifyRoot(root: Document): ClassifyResult {
  const scan: Scan = { nonNeutralBg: false, image: false, textColors: new Set(), reasons: [] };
  const body = root.body;

  root.querySelectorAll('style').forEach((st) => {
    const ast = parseSheet(st.textContent ?? '');
    if (!ast) return;
    csstree.walk(ast, {
      visit: 'Rule',
      enter(rule: csstree.CssNode) {
        const r = rule as csstree.Rule;
        const sel = csstree.generate(r.prelude);
        const top = sel.split(',').some((s) => isTopLevelSelector(s));
        csstree.walk(r.block, {
          visit: 'Declaration',
          enter(d: csstree.CssNode) {
            const decl = d as csstree.Declaration;
            scanDeclaration(decl.property.toLowerCase(), csstree.generate(decl.value), decl.value, scan, top);
          },
        });
      },
    });
  });

  const levelOne = new Set(firstLevel(body));
  root.querySelectorAll('[style]').forEach((el) => {
    const ast = parseInline(el.getAttribute('style') ?? '');
    if (!ast) return;
    for (const { node } of declsOf(ast)) {
      scanDeclaration(node.property.toLowerCase(), csstree.generate(node.value), node.value, scan, levelOne.has(el));
    }
  });
  root.querySelectorAll('[bgcolor]').forEach((el) => {
    const c = parseColor(el.getAttribute('bgcolor') ?? '');
    if (!c || !isNeutralColor(c, 'bg')) scan.nonNeutralBg = true;
  });
  if (root.querySelector('[background]')) {
    scan.image = true;
    scan.reasons.push('background image or gradient');
  }
  for (const el of levelOne) {
    const attr = el.tagName === 'FONT' ? el.getAttribute('color') : null;
    const c = attr ? parseColor(attr) : null;
    if (c && !isNeutralColor(c, 'text')) scan.textColors.add(toCss(c));
  }

  const reasons = [...new Set(scan.reasons)];
  if (scan.nonNeutralBg) reasons.push('colored background');
  if (scan.textColors.size > 3) reasons.push('more than 3 text colors');
  return { kind: reasons.length ? 'designed' : 'simple', reasons };
}

/**
 * Decide whether a message is plain text (no HTML), Simple (looks like normal mail) or Designed
 * (newsletter-style colors). Accepts sanitized HTML (string), a parsed document, or null.
 */
export function classify(input: string | Document | null | undefined): ClassifyResult {
  if (input === null || input === undefined) return { kind: 'plain', reasons: [] };
  const doc = typeof input === 'string' ? parseBody(input) : input;
  return classifyRoot(doc);
}

/** True when the sender says it supports dark mode (checked on the raw HTML, before sanitizing). */
export function detectDarkAware(raw: string): boolean {
  if (/prefers-color-scheme\s*:\s*dark/i.test(raw)) return true;
  for (const m of raw.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/name\s*=\s*["']?(color-scheme|supported-color-schemes)\b/i.test(tag) && /content\s*=\s*["'][^"']*dark/i.test(tag)) return true;
  }
  return false;
}

// ---------- height fix: strip sender height rules on html/body ----------
const HEIGHT_PROPS = new Set(['height', 'min-height', 'max-height']);

function stripBodyHeights(root: Document): void {
  root.querySelectorAll('style').forEach((st) => {
    const text = st.textContent ?? '';
    if (!/height/i.test(text)) return;
    const ast = parseSheet(text);
    if (!ast) return;
    let changed = false;
    csstree.walk(ast, {
      visit: 'Rule',
      enter(rule: csstree.CssNode) {
        const r = rule as csstree.Rule;
        const sels = csstree.generate(r.prelude).split(',');
        if (!sels.some((s) => /^(html|body)$/i.test(s.trim()))) return;
        r.block.children.forEach((child, item, list) => {
          if (child.type === 'Declaration' && HEIGHT_PROPS.has(child.property.toLowerCase())) {
            list.remove(item);
            changed = true;
          }
        });
      },
    });
    if (changed) st.textContent = csstree.generate(ast);
  });
}

// ---------- the rewrite engine ----------
interface Mapper {
  bg: (c: Rgba) => Rgba;
  text: (c: Rgba) => Rgba;
  border: (c: Rgba) => Rgba;
}

interface RewriteStats {
  colorDecls: number;
  unparseable: number;
  reasons: string[];
}

function rewriteDeclaration(decl: csstree.Declaration, mapper: Mapper, stats: RewriteStats): void {
  const prop = decl.property.toLowerCase();
  const role = roleOfProp(prop);
  if (prop === 'mix-blend-mode' || prop === 'filter' || prop === 'backdrop-filter') {
    stats.reasons.push(prop);
    return;
  }
  if (!role) return;
  const value = csstree.generate(decl.value).trim().toLowerCase();
  if (KEEP_WORDS.has(value)) return;
  const { nodes, bad } = colorNodes(decl.value);
  if (nodes.length === 0 && bad === 0) return; // e.g. "background: url(...) no-repeat"
  stats.colorDecls++;
  stats.unparseable += bad;
  for (const n of nodes) {
    const c = nodeColor(n);
    if (!c) {
      stats.unparseable++;
      continue;
    }
    const mapped = role === 'bg' ? mapper.bg(c) : role === 'text' ? mapper.text(c) : mapper.border(c);
    if (mapped !== c) replaceNode(n, mapped.a < 0.001 ? 'transparent' : toCss(mapped));
  }
}

function rewriteCss(css: string, inline: boolean, mapper: Mapper, stats: RewriteStats): string | null {
  const ast = inline ? parseInline(css) : parseSheet(css);
  if (!ast) return null;
  for (const { node } of declsOf(ast)) rewriteDeclaration(node, mapper, stats);
  return csstree.generate(ast);
}

function rewriteAttrColor(el: Element, attr: string, role: ColorRole, mapper: Mapper, stats: RewriteStats): void {
  const raw = el.getAttribute(attr);
  if (!raw) return;
  stats.colorDecls++;
  const c = parseColor(raw);
  if (!c) {
    stats.unparseable++;
    return;
  }
  const mapped = role === 'bg' ? mapper.bg(c) : role === 'text' ? mapper.text(c) : mapper.border(c);
  if (mapped !== c) el.setAttribute(attr, mapped.a < 0.001 ? 'transparent' : toCss(mapped));
}

function rewriteDocument(root: Document, mapper: Mapper, stats: RewriteStats): void {
  root.querySelectorAll('style').forEach((st) => {
    const out = rewriteCss(st.textContent ?? '', false, mapper, stats);
    if (out !== null) st.textContent = out;
  });
  root.querySelectorAll('[style]').forEach((el) => {
    const out = rewriteCss(el.getAttribute('style') ?? '', true, mapper, stats);
    if (out !== null) el.setAttribute('style', out);
  });
  root.querySelectorAll('[bgcolor]').forEach((el) => rewriteAttrColor(el, 'bgcolor', 'bg', mapper, stats));
  root.querySelectorAll('font[color]').forEach((el) => rewriteAttrColor(el, 'color', 'text', mapper, stats));
  root.querySelectorAll('[bordercolor]').forEach((el) => rewriteAttrColor(el, 'bordercolor', 'border', mapper, stats));
}

// ---------- limits ----------
const BLOCKISH = 'table,div,p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,tr,td,section,article,center';

/** Rough "is this element wide?" without layout: narrow explicit widths and plain inline buttons are not. */
function isWideContainer(el: Element): boolean {
  if (el.tagName === 'BODY' || el.tagName === 'HTML') return true;
  const w = (el.getAttribute('width') ?? '') + ' ' + (/(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(el.getAttribute('style') ?? '')?.[1] ?? '');
  const px = /(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(w.trim());
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(w);
  if (pct && parseFloat(pct[1]!) < 50) return false;
  if (!pct && px && parseFloat(px[1]!) < 300) return false;
  return !!el.querySelector(BLOCKISH);
}

function hasWideImageContainer(root: Document): boolean {
  const check = (el: Element) => isWideContainer(el);
  for (const el of root.querySelectorAll('[background]')) if (check(el)) return true;
  for (const el of root.querySelectorAll('[style]')) {
    const ast = parseInline(el.getAttribute('style') ?? '');
    if (!ast) continue;
    const img = declsOf(ast).some(
      ({ node }) => /^background(-image)?$/i.test(node.property) && hasImage(csstree.generate(node.value)),
    );
    if (img && check(el)) return true;
  }
  for (const st of root.querySelectorAll('style')) {
    const ast = parseSheet(st.textContent ?? '');
    if (!ast) continue;
    let wide = false;
    csstree.walk(ast, {
      visit: 'Rule',
      enter(rule: csstree.CssNode) {
        if (wide) return;
        const r = rule as csstree.Rule;
        const img = declsOf(r.block).some(
          ({ node }) => /^background(-image)?$/i.test(node.property) && hasImage(csstree.generate(node.value)),
        );
        if (!img) return;
        for (const sel of csstree.generate(r.prelude).split(',')) {
          if (/^(html|body)$/i.test(sel.trim())) {
            wide = true;
            return;
          }
          try {
            for (const el of root.querySelectorAll(sel.trim())) if (check(el)) wide = true;
          } catch {
            wide = true; // a selector we cannot evaluate: do not trust it
          }
        }
      },
    });
    if (wide) return true;
  }
  return false;
}

export const LIMITS = { maxColorDecls: 400, maxUnparseable: 0.1, maxMs: 80 } as const;

// ---------- transforms ----------
export type TransformResult = { ok: true; html: string; ms: number } | { ok: false; reason: string };

const DESIGNED_MAPPER: Mapper = { bg: mapBackground, text: mapText, border: mapBorder };
const SIMPLE_MAPPER: Mapper = { bg: mapSimpleBackground, text: mapSimpleText, border: mapBorder };

export interface TransformOptions {
  /** Ignore the limits (used by the "Show in dark mode" retry). */
  force?: boolean;
  now?: () => number;
}

/** Simple mail: rewrite neutral colors to theme colors. Never fails. */
export function transformSimple(html: string): string {
  const doc = parseBody(html);
  stripBodyHeights(doc);
  const stats: RewriteStats = { colorDecls: 0, unparseable: 0, reasons: [] };
  rewriteDocument(doc, SIMPLE_MAPPER, stats);
  // Links use the accent color from the stylesheet below, not the sender's.
  doc.querySelectorAll('a[style]').forEach((a) => {
    const ast = parseInline(a.getAttribute('style') ?? '');
    if (!ast) return;
    csstree.walk(ast, {
      visit: 'Declaration',
      enter(d: csstree.CssNode, item: csstree.ListItem<csstree.CssNode>, list: csstree.List<csstree.CssNode>) {
        if ((d as csstree.Declaration).property.toLowerCase() === 'color') list.remove(item);
      },
    });
    a.setAttribute('style', csstree.generate(ast));
  });
  return doc.body.innerHTML;
}

/** Designed mail: the conservative OKLCH transform, checked against the limits. */
export function transformDesigned(html: string, opts: TransformOptions = {}): TransformResult {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  try {
    const doc = parseBody(html);
    stripBodyHeights(doc);
    const stats: RewriteStats = { colorDecls: 0, unparseable: 0, reasons: [] };
    if (!opts.force && hasWideImageContainer(doc)) return { ok: false, reason: 'a large background image or gradient' };
    rewriteDocument(doc, DESIGNED_MAPPER, stats);
    if (!opts.force) {
      if (stats.reasons.length) return { ok: false, reason: stats.reasons[0]! };
      if (stats.colorDecls > LIMITS.maxColorDecls) return { ok: false, reason: 'too many color rules' };
      if (stats.colorDecls > 0 && stats.unparseable / stats.colorDecls > LIMITS.maxUnparseable) {
        return { ok: false, reason: 'colors that cannot be converted' };
      }
    }
    const out = doc.body.innerHTML;
    const ms = now() - t0;
    if (!opts.force && ms > LIMITS.maxMs) return { ok: false, reason: 'too slow' };
    return { ok: true, html: out, ms };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ---------- frame CSS ----------
const SIMPLE_CSS =
  'html,body{background:transparent!important}' +
  `body{color:${TEXT1};font-size:14px;line-height:1.5;padding:0}` +
  `a{color:${ACCENT};text-decoration:underline}a:hover{color:${ACCENT_H}}` +
  `blockquote,div[type=cite]{color:${TEXT2};border-left:3px solid ${BORDER}!important;padding-left:12px!important;margin-left:0!important}` +
  `.gmail_quote,.moz-cite-prefix{color:${TEXT2}}` +
  `pre,code{background:${CODE_BG};border-radius:4px;padding:2px 4px}pre{padding:8px 12px}pre code{background:none;padding:0}` +
  `hr{border-color:${BORDER}}`;

const TRANSFORM_CSS =
  'html,body{background:transparent!important}' +
  `body{color:${TEXT1};padding:0}a{color:${ACCENT}}`;

// The sender's own dark rules win (no !important); these are only defaults.
const DARKAWARE_CSS = `html,body{background:transparent}body{color:${TEXT1};padding:0}a{color:${ACCENT}}`;

// ---------- planning ----------
export type Variant = 'light' | 'simple' | 'transform' | 'darkaware' | 'card';

export interface RenderPlan {
  variant: Variant;
  kind: EmailKind;
  /** Body HTML to put into the frame. */
  html: string;
  /** Extra CSS for the frame (after the base CSS). */
  css: string;
  /** Show the paper card around the frame. */
  card: boolean;
  scheme: 'light' | 'dark';
  bodyPadding: number;
  /** After load: 'full' may fall back to the card, 'fix' only repairs colors. */
  verify: 'none' | 'fix' | 'full';
  /** Why the transform was not used (set when the card was chosen automatically). */
  fallbackReason?: string;
  transformMs?: number;
}

export interface PlanInput {
  /** Sanitized body HTML (the blocked or the allowed variant). */
  html: string;
  kind: EmailKind;
  darkAware: boolean;
}

export interface PlanOptions {
  dark: boolean;
  setting: 'auto' | 'light';
  override: 'original' | 'dark' | null;
  /** The verification pass rejected the automatic transform. */
  autoFallback: boolean;
  now?: () => number;
}

const LIGHT_PADDING = 16;

function cardPlan(inp: PlanInput, reason?: string): RenderPlan {
  const doc = parseBody(inp.html);
  stripBodyHeights(doc);
  return {
    variant: 'card',
    kind: inp.kind,
    html: doc.body.innerHTML,
    css: '',
    card: true,
    scheme: 'light',
    // The sender's layout provides its own spacing in Designed mail. Simple mail has none, so give it some.
    bodyPadding: inp.kind === 'designed' ? 0 : 12,
    verify: 'none',
    fallbackReason: reason,
  };
}

export function planBody(inp: PlanInput, opts: PlanOptions): RenderPlan {
  if (!opts.dark) {
    const doc = parseBody(inp.html);
    stripBodyHeights(doc);
    return { variant: 'light', kind: inp.kind, html: doc.body.innerHTML, css: '', card: false, scheme: 'light', bodyPadding: LIGHT_PADDING, verify: 'none' };
  }
  if (opts.override === 'original') return cardPlan(inp);

  const transformPlan = (force: boolean): RenderPlan | string => {
    if (inp.darkAware) {
      const doc = parseBody(inp.html);
      stripBodyHeights(doc);
      return { variant: 'darkaware', kind: inp.kind, html: doc.body.innerHTML, css: DARKAWARE_CSS, card: false, scheme: 'dark', bodyPadding: 0, verify: force ? 'fix' : 'full' };
    }
    const r = transformDesigned(inp.html, { force, now: opts.now });
    if (!r.ok) return r.reason;
    return { variant: 'transform', kind: inp.kind, html: r.html, css: TRANSFORM_CSS, card: false, scheme: 'dark', bodyPadding: 0, verify: force ? 'fix' : 'full', transformMs: r.ms };
  };

  if (opts.override === 'dark') {
    const p = transformPlan(true);
    return typeof p === 'string' ? cardPlan(inp, p) : p;
  }
  if (opts.setting === 'light') return cardPlan(inp);
  if (inp.kind === 'simple') {
    return { variant: 'simple', kind: inp.kind, html: transformSimple(inp.html), css: SIMPLE_CSS, card: false, scheme: 'dark', bodyPadding: 0, verify: 'fix' };
  }
  if (opts.autoFallback) return cardPlan(inp, 'colors could not be made readable');
  const p = transformPlan(false);
  return typeof p === 'string' ? cardPlan(inp, p) : p;
}

// ---------- D. verification pass (runs on the loaded iframe document) ----------
export interface VerifyResult {
  fixed: number;
  total: number;
  unknown: number;
  ms: number;
  /** True when the transform is not trustworthy (too many unknown backgrounds, or too slow). */
  reject: boolean;
}

export interface VerifyOptions {
  /** Count unknown backgrounds / time against the limits (automatic transform only). */
  strict: boolean;
  /** Time already used by the transform. */
  spentMs?: number;
  now?: () => number;
}

const SURFACE_RGB = parseColor(SURFACE)!;

/** Effective background of an element: walks ancestors, composites alpha over the surface. null = unknown (an image). */
function effectiveBackground(el: Element, win: Window): Rgba | null {
  const layers: Rgba[] = [];
  let base: Rgba = SURFACE_RGB;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const cs = win.getComputedStyle(cur);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = parseColor(cs.backgroundColor || 'transparent');
    if (c && c.a > 0.001) {
      if (c.a >= 0.999) {
        base = { ...c, a: 1 };
        break;
      }
      layers.push(c);
    }
  }
  for (let i = layers.length - 1; i >= 0; i--) base = composite(layers[i]!, base);
  return base;
}

/** Make text readable: contrast below 4.5:1 (3:1 for large text) gets white or near-black text. */
export function verifyContrast(doc: Document, opts: VerifyOptions): VerifyResult {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const win = doc.defaultView;
  const res: VerifyResult = { fixed: 0, total: 0, unknown: 0, ms: 0, reject: false };
  if (!win || !doc.body) return res;
  const seen = new Set<Element>();
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    const tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TITLE') continue;
    seen.add(el);
    res.total++;
    const bg = effectiveBackground(el, win);
    if (!bg) {
      res.unknown++;
      continue;
    }
    const cs = win.getComputedStyle(el);
    const fgRaw = parseColor(cs.color || '#000');
    if (!fgRaw) continue;
    const fg = composite(fgRaw, bg);
    const size = parseFloat(cs.fontSize) || 14;
    const weight = cs.fontWeight === 'bold' ? 700 : parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    if (contrastRatio(fg, bg) >= (large ? 3 : 4.5)) continue;
    const onDark = relLuminance(bg) < 0.4;
    el.style.setProperty('color', onDark ? '#ffffff' : '#1a1a1a', 'important');
    res.fixed++;
  }
  res.ms = now() - t0;
  if (opts.strict) {
    if (res.total > 0 && res.unknown / res.total > 0.2) res.reject = true;
    if (res.ms + (opts.spentMs ?? 0) > LIMITS.maxMs) res.reject = true;
  }
  return res;
}
