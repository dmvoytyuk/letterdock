// Makes every picture for the website and the README:  npm run site:screenshots
//
//   node scripts/make-site-screenshots.mjs [--only hero-dark,rules] [--keep-server]
//
// What it does
//   1. Starts the Vite dev server for the renderer (the fake backend only exists in dev mode).
//   2. Opens Chromium (Playwright) on  /?fake=1&scenario=demo , the invented demo data in
//      src/renderer/src/dev/demoData.ts (made-up people and brands, example.com/.org/.net only).
//   3. For each entry in SHOTS: sets the window size, light or dark theme and a fixed clock
//      (Tuesday 10:24), puts the app in the wanted state, and takes a picture at 2x.
//   4. Draws the missing window frame (round corners, minimize/maximize/close glyphs), scales
//      the picture to the exact size from the website spec, and writes
//      site/screenshots/<name>.png (palette-optimized) and <name>.webp (quality 82), plus the
//      native 2x capture for the screenshot viewer: site/screenshots/full/<name>.png and .webp.
//   5. Makes site/og.png (1200x630 social card) and the favicons from build/icon.svg.
//
// Needs (one time):  npm install   and   npx playwright install chromium
// Re-run it after any UI change, before a release, so the pictures stay current.
// Nothing is sent over the network and no real data is used.
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const outDir = join(siteDir, 'screenshots');
const fullDir = join(outDir, 'full');
mkdirSync(fullDir, { recursive: true });

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1]).split(',') : null;

// Tuesday 13 October 2026, 10:24 (UTC; the browser also runs in UTC).
const FIXED_TIME = new Date('2026-10-13T10:24:00Z');
const DEMO = 'fake=1&scenario=demo';

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowOf = (page, text) => page.locator('[role="option"]', { hasText: text }).first();

/** The app asks for a persisted UI state; this is the one every picture starts from. */
function uiState(extra = {}) {
  return JSON.stringify({
    state: {
      sidebarCollapsed: false,
      sidebarW: 264,
      listW: 380,
      density: 'comfortable',
      emailDarkMode: 'auto',
      showAccountBadge: false,
      showStatusBar: true,
      expanded: { a1: true, a2: true },
      moreOpen: {},
      recentFolders: {},
      recentSearches: [],
      ...extra,
    },
    version: 1,
  });
}

/** Window frame the browser does not have: round corners, a thin border and the three caption glyphs. */
const FRAME_CSS = `
  html, body { background: transparent !important; }
  body { border-radius: 8px; overflow: hidden; }
  body::after { content: ''; position: fixed; inset: 0; border-radius: 8px; pointer-events: none; z-index: 99999;
    box-shadow: inset 0 0 0 1px rgba(128,128,128,.45); }
  /* the quick-action buttons and focus ring of the cursor row are hover/keyboard helpers, not part of the picture */
  .row .hov { display: none !important; }
  .row.focus, .row:focus-visible { outline: none !important; box-shadow: none !important; }
  .fake-caption { position: absolute; right: 0; top: 0; height: 36px; display: flex; z-index: 50; pointer-events: none; }
  .fake-caption span { width: 46px; height: 36px; display: grid; place-items: center; }
  .fake-caption svg { width: 10px; height: 10px; stroke: currentColor; fill: none; stroke-width: 1; }
`;
const CAPTION_HTML = `<span><svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg></span><span><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></span><span><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg></span>`;

async function decorate(page) {
  await page.addStyleTag({ content: FRAME_CSS });
  await page.evaluate((html) => {
    const bar = document.querySelector('.titlebar');
    if (!bar || bar.querySelector('.fake-caption')) return;
    const d = document.createElement('div');
    d.className = 'fake-caption';
    d.style.color = getComputedStyle(document.body).color;
    d.innerHTML = html;
    bar.appendChild(d);
  }, CAPTION_HTML);
}

// ---------- the pictures ----------
// Each entry: name, size [w,h], theme, url (default main window), state(page) to reach the wanted view, and
// optional `ui` (extra persisted UI state), `frame` (false: not an app window) or `crop` ({x,y,w,h} in CSS px).
const SHOTS = [];
const shot = (s) => SHOTS.push(s);

/** Moves the keyboard focus out of the list, so the selected row has no hover buttons or focus ring. */
const blurList = async (page) => {
  await page.mouse.click(150, 18);
  await page.mouse.move(5, 5);
  await sleep(200);
};
const openMessage = async (page, text, wait = 1200) => {
  await rowOf(page, text).click();
  await sleep(wait);
  await blurList(page);
};
const openSettings = async (page, section) => {
  await page.keyboard.press('Control+,');
  await page.locator('.snav').waitFor();
  await page.locator('.snav button', { hasText: section }).click();
  await sleep(700);
  await page.mouse.move(5, 5);
};
/** Runs a dev hook the fake backend offers (see runScenario in fakeApi.ts). */
const scenario = (page, name) => page.evaluate((n) => window.__fakeScenario(n), name);

const hero = async (page) => openMessage(page, 'Brightloop', 1800);
shot({ name: 'hero-dark', size: [1600, 1000], theme: 'dark', state: hero });
shot({ name: 'hero-light', size: [1600, 1000], theme: 'light', state: hero });
// Phone crop: the list and the reading pane only, the sidebar is cut away.
shot({ name: 'hero-mobile-dark', size: [1000, 1000], viewport: [1600, 1000], crop: { x: 266, y: 0, width: 1000, height: 1000 }, theme: 'dark', state: hero });
shot({ name: 'hero-mobile-light', size: [1000, 1000], viewport: [1600, 1000], crop: { x: 266, y: 0, width: 1000, height: 1000 }, theme: 'light', state: hero });
shot({ name: 'light', size: [1600, 1000], theme: 'light', state: async (page) => {
  await page.getByRole('treeitem', { name: /^Work/ }).locator('..').getByRole('treeitem', { name: /Inbox/ }).first().click();
  await sleep(500);
  await openMessage(page, 'Invoice #1187', 1500);
} });

shot({ name: 'unified-inbox', size: [1000, 700], theme: 'light', state: (page) => openMessage(page, 'Team lunch') });
shot({ name: 'conversations', size: [1000, 700], theme: 'light', state: (page) => openMessage(page, 'Weekend plans', 1800) });
shot({ name: 'rules', size: [1000, 700], theme: 'light', state: (page) => openSettings(page, 'Rules') });
shot({ name: 'offline', size: [1000, 700], theme: 'light', state: async (page) => {
  await openMessage(page, 'Photos from the lake');
  await scenario(page, 'outboxQueued');
  await scenario(page, 'offline');
  await page.context().setOffline(true);
  await sleep(1200);
} });
shot({ name: 'email-dark', size: [1000, 700], theme: 'dark', state: (page) => openMessage(page, 'Pinewood Bakery', 1800) });
shot({ name: 'image-privacy', size: [1000, 700], theme: 'light', state: (page) => openMessage(page, 'Northfield Library', 1800) });
shot({ name: 'search', size: [1000, 700], theme: 'light', state: async (page) => {
  const box = page.getByPlaceholder(/Search/).first();
  await box.click();
  await box.fill('invoice');
  await box.press('Enter');
  await sleep(1500);
  await page.mouse.move(5, 5);
} });
// Notifications are set in two places: Settings > Notifications and "Keep running in the background" in General.
// This picture puts a piece of each side by side in one frame (a figure, not one window).
shot({ name: 'notifications', size: [1000, 700], theme: 'dark', build: async (cap) => {
  const W = 720, HA = 340, HB = 250, GAP = 20; // CSS px
  const clip = (height) => ({ x: 232, y: 56, width: W, height });
  const a = await cap({ name: 'notifications-a', size: [1000, 700], crop: clip(HA), state: (page) => openSettings(page, 'Notifications') });
  const b = await cap({ name: 'notifications-b', size: [1000, 700], crop: clip(HB), state: (page) => openSettings(page, 'General') });
  const card = (buf, h) => sharp(buf).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${h * 2}"><rect x="1" y="1" width="${W * 2 - 2}" height="${h * 2 - 2}" rx="24" fill="none" stroke="#888" stroke-opacity=".5" stroke-width="2"/></svg>`) }]).png().toBuffer();
  const top = Math.round((700 - (HA + GAP + HB)) / 2) * 2;
  return sharp({ create: { width: 2000, height: 1400, channels: 4, background: '#202020' } })
    .composite([{ input: await card(a, HA), left: (2000 - W * 2) / 2, top }, { input: await card(b, HB), left: (2000 - W * 2) / 2, top: top + (HA + GAP) * 2 }])
    .png().toBuffer();
} });
shot({ name: 'update', size: [1000, 500], theme: 'light', state: async (page) => {
  await scenario(page, 'updateReady');
  await sleep(800);
} });
shot({ name: 'settings-accounts', size: [1000, 700], theme: 'light', state: (page) => openSettings(page, 'Accounts') });
shot({ name: 'add-account', size: [800, 600], theme: 'light', state: async (page) => {
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: /Add account/ }).first().click();
  await page.getByLabel(/Email/i).first().fill('anna@example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText(/app password/i).first().waitFor();
  await sleep(500);
} });
// The compose window is its own page. Its "Send later" menu is open.
shot({
  name: 'send-later', size: [900, 650], theme: 'light', ready: '[contenteditable="true"]',
  url: '/compose.html',
  hash: '#req=' + encodeURIComponent(JSON.stringify({ mode: 'new', accountId: 'a1', mailto: 'mailto:priya@example.com?subject=Slides%20for%20Thursday' })),
  state: async (page) => {
    await sleep(800);
    const ed = page.locator('[contenteditable="true"]').first();
    await ed.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('Hi Priya,\n\nHere are the slides for Thursday. Could you take a quick look before the meeting?\n\nThanks,');
    await page.getByRole('button', { name: /More send options/ }).click();
    await sleep(500);
  },
});

// ---------- run ----------
/** Opens one fresh browser context, reaches the state of `s` and returns the 2x PNG (transparent corners). */
async function capture(browser, base, s) {
  const [w, h] = s.size;
  const ctx = await browser.newContext({
    viewport: { width: s.viewport?.[0] ?? w, height: s.viewport?.[1] ?? h },
    deviceScaleFactor: 2,
    colorScheme: s.theme,
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  await ctx.addInitScript((ui) => {
    try {
      localStorage.setItem('letterdock.ui', ui);
    } catch {
      /* ignore */
    }
  }, uiState(s.ui));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn(`  [${s.name}] page error: ${e.message}`));
  const url = s.url ?? '/';
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`${base}${url}${url.includes('?') ? '&' : '?'}${DEMO}${s.hash ?? ''}`);
  await page.waitForSelector(s.ready ?? '.panes', { timeout: 20000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(500);
  if (s.frame !== false) await decorate(page);
  await s.state?.(page);
  await sleep(300);
  const raw = await page.screenshot({ omitBackground: true, ...(s.crop ? { clip: s.crop } : {}) });
  await ctx.close();
  return raw;
}

async function main() {
  const server = await createServer({
    root: join(root, 'src', 'renderer'),
    configFile: false,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'warn',
  });
  await server.listen();
  const base = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch();
  const written = [];
  try {
    for (const s of SHOTS) {
      if (only && !only.includes(s.name)) continue;
      const raw = s.build ? await s.build((o) => capture(browser, base, { theme: s.theme, ...o })) : await capture(browser, base, s);
      written.push(...(await writeImage(s.name, raw, s.size[0], s.size[1])));
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (!only || only.includes('og')) written.push(...(await makeOg()));
  if (!only || only.includes('icons')) await makeIcons();
  const total = written.reduce((n, f) => n + statSync(f).size, 0);
  console.log(`\nWrote ${written.length} images, ${(total / 1024 / 1024).toFixed(2)} MB in total.`);
}

/** Scale to the exact size, write an optimized PNG and a WebP twin. */
async function writeImage(name, raw, w, h) {
  const img = sharp(raw).resize(w, h, { kernel: 'lanczos3' });
  const png = join(outDir, `${name}.png`);
  const webp = join(outDir, `${name}.webp`);
  await img.clone().png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(png);
  await img.clone().webp({ quality: 82, effort: 6 }).toFile(webp);
  // Full resolution (native 2x capture) for the viewer; the no-JS link opens the PNG.
  const fpng = join(fullDir, `${name}.png`);
  const fwebp = join(fullDir, `${name}.webp`);
  const full = sharp(raw);
  const fm = await full.metadata();
  await full.clone().png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(fpng);
  await full.clone().webp({ quality: 82, effort: 6 }).toFile(fwebp);
  console.log(`${name}: ${w}x${h}  png ${(statSync(png).size / 1024).toFixed(0)} KB  webp ${(statSync(webp).size / 1024).toFixed(0)} KB  | full ${fm.width}x${fm.height} png ${(statSync(fpng).size / 1024).toFixed(0)} KB  webp ${(statSync(fwebp).size / 1024).toFixed(0)} KB`);
  return [png, webp, fpng, fwebp];
}

/** Social card 1200x630: brand blue, icon, name, one line, and a tilted piece of the light hero picture. */
async function makeOg() {
  const W = 1200, H = 630;
  const fonts = { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' };
  const icon = new Resvg(readFileSync(join(root, 'build', 'icon.svg')), { fitTo: { mode: 'width', value: 160 } }).render().asPng();
  const bg = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F6CBD"/><stop offset="1" stop-color="#0A5AA6"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
  ).render().asPng();
  const text = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Segoe UI Variable Display, Segoe UI, Arial, sans-serif" fill="#FFFFFF">
      <text x="64" y="388" font-size="72" font-weight="700">Letterdock</text>
      <text x="64" y="452" font-size="40">All your email accounts</text>
      <text x="64" y="502" font-size="40">in one free app.</text></svg>`,
    { font: fonts },
  ).render().asPng();
  // A piece of the hero (list + reading pane), tilted, with a soft shadow.
  const piece = await sharp(join(outDir, 'hero-light.png')).extract({ left: 266, top: 36, width: 1100, height: 760 }).resize(640).png().toBuffer();
  const rounded = await sharp(piece)
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="442"><rect width="640" height="442" rx="14"/></svg>'), blend: 'dest-in' }])
    .png().toBuffer();
  const tilted = await sharp(rounded).rotate(-4, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const { width: tw, height: th } = await sharp(tilted).metadata();
  const shadow = await sharp(tilted).ensureAlpha().modulate({ brightness: 0 }).blur(18).png().toBuffer();
  const left = 600, top = 120;
  const place = async (buf, dx, dy, o = 1) => {
    const meta = await sharp(buf).metadata();
    const l = left + dx, t = top + dy;
    const cw = Math.min(meta.width, W - l), ch = Math.min(meta.height, H - t);
    const cropped = await sharp(buf).extract({ left: 0, top: 0, width: cw, height: ch }).png().toBuffer();
    const faded = o === 1 ? cropped : await sharp(cropped).ensureAlpha(o).png().toBuffer();
    return { input: faded, left: l, top: t };
  };
  void tw; void th;
  const out = join(siteDir, 'og.png');
  const layers = [
    { input: icon, left: 64, top: 150 },
    { input: text, left: 0, top: 0 },
    await place(shadow, 0, 16, 0.35),
    await place(tilted, 0, 0),
  ];
  await sharp(bg).composite(layers).png({ palette: true, quality: 90, effort: 10 }).toFile(out);
  console.log(`og: 1200x630  png ${(statSync(out).size / 1024).toFixed(0)} KB`);
  return [out];
}

/** favicon.svg, favicon.ico (16, 32 from the small design, 48 from the master) and the 180 px touch icon. */
async function makeIcons() {
  const master = readFileSync(join(root, 'build', 'icon.svg'));
  const small = readFileSync(join(root, 'build', 'icon-small.svg'));
  const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(siteDir, 'favicon.svg'), master);
  writeFileSync(join(siteDir, 'favicon.ico'), await pngToIco([render(small, 16), render(small, 32), render(master, 48)]));
  const touch = await sharp(render(master, 180)).flatten({ background: '#0F6CBD' }).png().toBuffer();
  writeFileSync(join(siteDir, 'apple-touch-icon.png'), touch);
  console.log('icons: favicon.svg, favicon.ico, apple-touch-icon.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
