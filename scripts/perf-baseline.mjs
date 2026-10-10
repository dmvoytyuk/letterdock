// Performance baseline for Letterdock:  npm run perf
//
//   npm run perf                                   measure everything, write perf/current.json
//   npm run perf -- --out perf/baseline-0.5.4.json write the result to another file (a new baseline)
//   npm run perf -- --compare perf/baseline-0.5.4.json
//                                                  measure, then print the change against that baseline
//                                                  and mark every metric that got more than 10% worse
//   npm run perf -- --compare perf/baseline-0.5.4.json --current perf/current.json
//                                                  only compare two saved results (no measuring)
//   Other flags:  --only engine,bundles,renderer   run some parts only (compare uses the metrics both files have)
//                 --runs N        repeats per measurement (default 7)
//                 --memruns N     fresh processes used for the memory numbers (default 5)
//                 --warm N        warm calls per engine operation and run (default 5)
//                 --threshold P   regression limit in percent (default 10)
//                 --no-fail       exit 0 even when a regression is found (default: exit code 1)
//                 --reseed        rebuild the cached 50k-message test mailbox
//
// What is measured (every number is lower = better; the file stores median and p90 of N samples)
//   engine    (tests/perf/enginePerf.test.ts, run through vitest; Node, not Electron)
//     A seeded mailbox: 3 accounts, 50 000 messages, 5 000 distinct people (contacts), 200 long
//     conversations of 25 messages (plus one conversation per other message), ~600 downloaded bodies.
//     - engine.coldStart.*      open database + start the engine; "ready" = first inbox page answered
//     - engine.messages.list.*  unified inbox, 100 rows: page 1 and page 2, first call and warm calls
//     - engine.conversations.list.*  same for conversations
//     - engine.search.local.*   six queries: word, very common word (1 call per run), from:, "phrase", body-only word, is:unread + word
//     - engine.messages.get.cached   open an already downloaded body
//     - engine.memory.*, engine.sqlite.*  RSS, JS heap, external, SQLite cache/mmap/file sizes after a
//       forced GC and the warm calls. Measured in MEMRUNS separate fresh processes (one engine each),
//       NOT in the timing process: inside one process RSS grows ~15 MB per engine, and it is +380 MB
//       when the seed was built in the same process (that fooled the 0.5.4 -> HEAD comparison once).
//   bundles   (electron-vite build into a temp folder; one sample each, so median = the value)
//     - bundle.main.*, bundle.preload.*, bundle.renderer.<index|compose|viewer>.*  raw and gzip bytes
//   renderer  (headless Chromium + the Vite dev server + the fake backend demo scenario)
//     - renderer.firstRow.*     navigation start -> first message row painted (two animation frames later)
//     - renderer.scroll.*       frame times while a list of 1000 rows is scrolled from top to bottom
//       (the demo has fewer rows, so messages.list is padded to 1000 rows inside the page; product
//       code is not touched). Headless Chromium draws in software, so look at changes, not at 60 fps.
//
// How to compare (the normal flow before and after a feature)
//   1. Check out the new code, run:   npm run perf -- --compare perf/baseline-0.5.4.json
//   2. Read the table. "REGRESSION" = median more than 10% worse AND more than the noise floor
//      (1 ms, 3 MB, 2 KB, 2 points) worse. "better" = the same in the other direction.
//   3. Exit code is 1 when there is a regression (use --no-fail to ignore it).
//   4. Use the same --runs as the baseline (the default 7) for the timings. Memory does not depend on --runs.
//   5. Noise: run it twice on an idle machine before you believe a single flag. Always compare on the
//      same computer; the file stores the CPU and Node version it was made on.
//
// First use needs (one time):  npm install   and   npx playwright install chromium
// The 50k-message mailbox is built on the first run (about a minute) and cached in the temp folder.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const RUNS = Number(opt('runs', 7));
const WARM = Number(opt('warm', 5));
const MEMRUNS = Number(opt('memruns', 5));
const THRESHOLD = Number(opt('threshold', 10));
const COMPARE = opt('compare', null);
const CURRENT = opt('current', null);
const OUT = resolve(root, opt('out', CURRENT ?? 'perf/current.json'));
const ONLY = new Set(opt('only', 'engine,bundles,renderer').split(','));

// ---------- statistics ----------
const percentile = (sorted, p) => {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
function summarize(unit, samples, note) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    unit,
    median: round(percentile(s, 0.5)),
    p90: round(percentile(s, 0.9)),
    min: round(s[0]),
    max: round(s[s.length - 1]),
    n: s.length,
    ...(note ? { note } : {}),
    samples: samples.map(round),
  };
}
const round = (v) => Math.round(v * 1000) / 1000;

const log = (...a) => console.log('[perf]', ...a);
const metrics = {};
const details = {};
const addMetric = (name, unit, samples, note) => (metrics[name] = summarize(unit, samples, note));

// ---------- compare only ----------
if (CURRENT && COMPARE) {
  process.exit(
    compare(
      JSON.parse(readFileSync(resolve(root, COMPARE), 'utf8')),
      JSON.parse(readFileSync(OUT, 'utf8')),
    ),
  );
}

// ---------- engine ----------
function runEngine() {
  log(
    `engine: ${RUNS} runs x (1 cold start + ${WARM} warm calls per operation) on the 50k mailbox`,
  );
  const tmp = mkdtempSync(join(tmpdir(), 'letterdock-perf-out-'));
  const outFile = join(tmp, 'engine.json');
  if (flag('reseed')) {
    for (const d of readdirSync(tmpdir()))
      if (d.startsWith('letterdock-perf-seed-'))
        rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
  const vitest = (extraEnv) =>
    spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/perf/enginePerf.test.ts'],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          PERF: '1',
          PERF_OUT: outFile,
          PERF_RUNS: String(RUNS),
          PERF_WARM: String(WARM),
          ...extraEnv,
        },
      },
    );
  // 1. build the seed (if missing) in a process of its own; 2. timings in one process;
  // 3. memory in MEMRUNS fresh processes.
  if (vitest({ PERF_SEED_ONLY: '1' }).status !== 0) throw new Error('Seeding the mailbox failed.');
  const r = vitest({});
  if (r.status !== 0 || !existsSync(outFile))
    throw new Error('The engine benchmark failed (see the output above).');
  const memSamples = {};
  const isMem = (k) => /^engine.(memory|sqlite)./.test(k);
  for (let i = 0; i < MEMRUNS; i++) {
    rmSync(outFile, { force: true });
    log(`engine memory: fresh process ${i + 1}/${MEMRUNS}`);
    const m = vitest({ PERF_RUNS: '1' });
    if (m.status !== 0 || !existsSync(outFile)) throw new Error('The memory run failed.');
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(outFile, 'utf8')).metrics))
      if (isMem(k))
        (memSamples[k] ??= { unit: v.unit, note: v.note, samples: [] }).samples.push(v.samples[0]);
  }
  const res = JSON.parse(readFileSync(outFile, 'utf8'));
  // the timing process did not give the memory numbers (see the header); keep the fresh-process ones.
  for (const [name, m] of Object.entries(res.metrics))
    if (!isMem(name)) addMetric(name, m.unit, m.samples, m.note);
  for (const [name, m] of Object.entries(memSamples))
    addMetric(name, m.unit, m.samples, `fresh process, ${m.note ?? ''}`.trim());
  details.dataset = res.dataset;
  details.itemCounts = res.itemCounts;
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- bundles ----------
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
function fileInfo(path) {
  const buf = readFileSync(path);
  return { raw: buf.length, gzip: gz(buf) };
}
function runBundles() {
  const outDir = join(root, 'node_modules', '.cache', 'letterdock-perf', 'out');
  rmSync(outDir, { recursive: true, force: true });
  log('bundles: electron-vite build (production)');
  const t0 = performance.now();
  const r = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      '--outDir',
      outDir,
      '--logLevel',
      'warn',
    ],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) throw new Error('electron-vite build failed.');
  const buildMs = performance.now() - t0;
  addMetric(
    'bundle.build.timeMs',
    'ms',
    [buildMs],
    'one full electron-vite build (noisy; informational)',
  );

  const files = {};
  const one = (key, rel) => {
    const p = join(outDir, rel);
    if (!existsSync(p)) return;
    const f = fileInfo(p);
    files[rel] = f;
    addMetric(`bundle.${key}.raw`, 'B', [f.raw]);
    addMetric(`bundle.${key}.gzip`, 'B', [f.gzip]);
  };
  // The main process: both entry files share chunks, so also report the sum of everything under out/main.
  let mainRaw = 0;
  let mainGz = 0;
  const walkMain = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walkMain(p);
      else if (e.name.endsWith('.js')) {
        const f = fileInfo(p);
        mainRaw += f.raw;
        mainGz += f.gzip;
      }
    }
  };
  walkMain(join(outDir, 'main'));
  addMetric(
    'bundle.main.total.raw',
    'B',
    [mainRaw],
    'every .js file under out/main (index + engine + shared chunks)',
  );
  addMetric('bundle.main.total.gzip', 'B', [mainGz]);
  one('main.index', 'main/index.js');
  one('main.engine', 'main/engine.js');
  one('preload.index', 'preload/index.js');
  one('preload.index', 'preload/index.mjs');

  // Renderer: what each window loads = scripts, preloaded chunks and stylesheets named in its html.
  const rdir = join(outDir, 'renderer');
  let totalRaw = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else totalRaw += statSync(p).size;
    }
  };
  walk(rdir);
  addMetric(
    'bundle.renderer.allFiles.raw',
    'B',
    [totalRaw],
    'every file under out/renderer (fonts, images too)',
  );
  for (const entry of ['index', 'compose', 'viewer']) {
    const html = readFileSync(join(rdir, `${entry}.html`), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) =>
      m[1].replace(/^\.\//, '').replace(/^\//, ''),
    );
    const sums = { js: { raw: 0, gzip: 0 }, css: { raw: 0, gzip: 0 } };
    for (const ref of new Set(refs)) {
      const f = fileInfo(join(rdir, ref));
      const kind = ref.endsWith('.css') ? 'css' : 'js';
      sums[kind].raw += f.raw;
      sums[kind].gzip += f.gzip;
      files[`renderer/${ref}`] = {
        ...f,
        usedBy: [...(files[`renderer/${ref}`]?.usedBy ?? []), entry],
      };
    }
    for (const kind of ['js', 'css']) {
      addMetric(
        `bundle.renderer.${entry}.${kind}.raw`,
        'B',
        [sums[kind].raw],
        'all files this window loads at start (shared chunks count in each window)',
      );
      addMetric(`bundle.renderer.${entry}.${kind}.gzip`, 'B', [sums[kind].gzip]);
    }
  }
  // Every renderer chunk by name (hash removed), including the ones loaded later (lazy).
  for (const f of readdirSync(join(rdir, 'assets'))) {
    const m = /^(.*)-[A-Za-z0-9_-]{8}.(js|css)$/.exec(f);
    if (!m) continue;
    const info = fileInfo(join(rdir, 'assets', f));
    files[`renderer/assets/${f}`] = { ...files[`renderer/assets/${f}`], ...info };
    addMetric(`bundle.renderer.chunk.${m[1]}.${m[2]}.raw`, 'B', [info.raw]);
    addMetric(`bundle.renderer.chunk.${m[1]}.${m[2]}.gzip`, 'B', [info.gzip]);
  }
  details.bundleFiles = files;
  rmSync(outDir, { recursive: true, force: true });
}

// ---------- renderer ----------
/* global window, document, requestAnimationFrame, MutationObserver */
async function runRenderer() {
  const [{ createServer }, { default: react }, { chromium }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
    import('playwright'),
  ]);
  log(
    `renderer: Vite dev server + headless Chromium, ${RUNS} runs each (first row, scroll of 1000 rows)`,
  );
  const server = await createServer({
    root: join(root, 'src', 'renderer'),
    configFile: false,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'warn',
  });
  await server.listen();
  const base = server.resolvedUrls.local[0].replace(/\/$/, '');
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    await server.close();
    throw new Error(
      `Could not start Chromium (${e.message}). Run: npx playwright install chromium`,
      { cause: e },
    );
  }
  const URL_ = `${base}/?fake=1&scenario=demo`;
  const VIEWPORT = { width: 1440, height: 900 };
  const newPage = async (init) => {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
    });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`  page error: ${e.message}`));
    return { ctx, page };
  };
  try {
    // One unmeasured visit: Vite turns each source file into JavaScript on its first request, and may
    // optimise dependencies and reload once. Measured visits start with an empty browser cache anyway.
    {
      const { ctx, page } = await newPage();
      await page.goto(URL_);
      await page.locator('[role="option"]').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
      await ctx.close();
    }

    // -- first row painted --
    const first = [];
    const dcl = [];
    const firstInit = () => {
      window.__ttfr = null;
      const mo = new MutationObserver(() => {
        if (window.__ttfr !== null || !document.querySelector('[role="option"]')) return;
        window.__ttfr = -1; // found; waiting for the paint
        requestAnimationFrame(() =>
          requestAnimationFrame(() => (window.__ttfr = performance.now())),
        );
      });
      mo.observe(document, { childList: true, subtree: true });
    };
    for (let i = 0; i < RUNS; i++) {
      const { ctx, page } = await newPage(firstInit);
      await page.goto(URL_, { waitUntil: 'commit' });
      await page.waitForFunction(() => window.__ttfr > 0, null, { timeout: 60000, polling: 'raf' });
      first.push(await page.evaluate(() => window.__ttfr));
      dcl.push(
        await page.evaluate(
          () => performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
        ),
      );
      await ctx.close();
    }
    addMetric(
      'renderer.firstRow.paintMs',
      'ms',
      first,
      'navigation start -> first message row painted (dev server, fake backend adds ~120 ms per call)',
    );
    addMetric(
      'renderer.firstRow.domContentLoadedMs',
      'ms',
      dcl,
      'navigation start -> DOMContentLoaded',
    );

    // -- scroll over 1000 rows --
    const padInit = () => {
      const ROWS = 1000;
      const patch = (api) => {
        if (api.__padded) return;
        api.__padded = true;
        const orig = api.invoke.bind(api);
        const cache = new Map();
        api.invoke = async (channel, req) => {
          if (channel !== 'messages.list' && channel !== 'conversations.list')
            return orig(channel, req);
          const conv = channel === 'conversations.list';
          const idOf = (m) => (conv ? m.latest.id : m.id);
          const dateOf = (m) => (conv ? m.latest.date : m.date);
          const key = channel + JSON.stringify(req.scope);
          let rows = cache.get(key);
          if (!rows) {
            const real = await orig(channel, { ...req, cursor: null, limit: 200 });
            const t = real.items;
            rows = [];
            if (t.length) {
              const top = dateOf(t[0]);
              for (let i = 0; i < ROWS; i++) {
                const src = t[i % t.length];
                if (i < t.length) rows.push(src);
                else {
                  const id = 5_000_000 + i;
                  const date = top - (i + 1) * 60_000;
                  rows.push(
                    conv
                      ? {
                          ...src,
                          threadId: `pad-${i}`,
                          folderMessageIds: [id],
                          messageIds: [id],
                          latest: { ...src.latest, id, date, title: `${src.latest.title} (${i})` },
                        }
                      : { ...src, id, date, subject: `${src.subject} (${i})` },
                  );
                }
              }
            }
            cache.set(key, rows);
            window.__paddedRows = ROWS;
          }
          const at = req.cursor ? rows.findIndex((m) => idOf(m) === req.cursor.id) : -1;
          const after = req.cursor ? rows.slice(at + 1) : rows;
          const items = after.slice(0, req.limit ?? 50);
          const last = items[items.length - 1];
          return {
            items,
            nextCursor:
              after.length > items.length && last ? { date: dateOf(last), id: idOf(last) } : null,
            canLoadOlderFromServer: false,
            total: req.cursor ? null : rows.length,
          };
        };
      };
      // The fake backend installs window.api before React renders; patch it on the first DOM change.
      const mo = new MutationObserver(() => {
        if (window.api && window.api.invoke) {
          patch(window.api);
          mo.disconnect();
        }
      });
      mo.observe(document, { childList: true, subtree: true });
    };
    const medians = [];
    const p90s = [];
    const jank = [];
    const heaps = [];
    for (let i = 0; i < RUNS; i++) {
      const { ctx, page } = await newPage(padInit);
      await page.goto(URL_);
      await page.locator('[role="option"]').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500); // let the first page settle
      const res = await page.evaluate(async () => {
        const el = document.querySelector('.msg-scroll');
        const deltas = [];
        const STEP = 120; // px per frame: about two rows
        let last = performance.now();
        let stuck = 0;
        await new Promise((done) => {
          const step = (t) => {
            deltas.push(t - last);
            last = t;
            const before = el.scrollTop;
            el.scrollTop = before + STEP;
            const atEnd = el.scrollTop - before < 1; // could not move: end of what is loaded
            stuck = atEnd ? stuck + 1 : 0;
            if (stuck > 90 || deltas.length > 6000) return done();
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0;
        return {
          deltas: deltas.slice(1),
          rows: window.__paddedRows ?? 0,
          scrollHeight: el.scrollHeight,
          heap,
        };
      });
      if (res.rows !== 1000)
        throw new Error(
          'The list was not padded to 1000 rows; the scroll measurement is not valid.',
        );
      const d = res.deltas.slice(0, -90); // drop the idle frames at the very end
      const s = [...d].sort((a, b) => a - b);
      medians.push(percentile(s, 0.5));
      p90s.push(percentile(s, 0.9));
      jank.push((d.filter((x) => x > 25).length / d.length) * 100);
      heaps.push(res.heap);
      details.scrollFramesPerRun = [...(details.scrollFramesPerRun ?? []), d.length];
      await ctx.close();
    }
    addMetric(
      'renderer.scroll.frameMedianMs',
      'ms',
      medians,
      'time between animation frames while scrolling 1000 rows (headless, software drawing)',
    );
    addMetric(
      'renderer.scroll.frameP90Ms',
      'ms',
      p90s,
      '90th percentile of the frame time, per run',
    );
    addMetric('renderer.scroll.slowFramePct', '%', jank, 'share of frames longer than 25 ms');
    if (heaps.some((h) => h > 0))
      addMetric('renderer.scroll.jsHeapMB', 'MB', heaps, 'JS heap in the page after the scroll');
    details.browser = `chromium ${browser.version()}`;
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------- compare ----------
var FLOOR = { ms: 1, MB: 3, B: 2048, '%': 2 };
function fmt(v, unit) {
  if (v === undefined || v === null) return '-';
  if (unit === 'B') return `${(v / 1024).toFixed(1)} KB`;
  if (unit === 'ms') return v >= 100 ? `${v.toFixed(0)} ms` : `${v.toFixed(2)} ms`;
  if (unit === 'MB') return `${v.toFixed(1)} MB`;
  if (unit === '%') return `${v.toFixed(1)} %`;
  return String(v);
}
function pct(a, b) {
  return a === 0 ? (b === 0 ? 0 : Infinity) : ((b - a) / a) * 100;
}
function sgn(p) {
  return !isFinite(p) ? 'new' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function compare(base, cur) {
  const names = [...new Set([...Object.keys(base.metrics), ...Object.keys(cur.metrics)])];
  const rows = [];
  let regressions = 0;
  for (const name of names) {
    const a = base.metrics[name];
    const b = cur.metrics[name];
    if (!a || !b) {
      rows.push([
        name,
        fmt(a?.median, a?.unit),
        fmt(b?.median, b?.unit),
        '',
        '',
        '',
        a ? 'missing now' : 'new metric',
      ]);
      continue;
    }
    const dm = pct(a.median, b.median);
    const dp = pct(a.p90, b.p90);
    const floor = FLOOR[a.unit] ?? 0;
    let mark = '';
    if (dm > THRESHOLD && b.median - a.median > floor) {
      mark = 'REGRESSION';
      regressions++;
    } else if (dm < -THRESHOLD && a.median - b.median > floor) mark = 'better';
    rows.push([
      name,
      fmt(a.median, a.unit),
      fmt(b.median, b.unit),
      sgn(dm),
      fmt(a.p90, a.unit),
      fmt(b.p90, b.unit) + ` (${sgn(dp)})`,
      mark,
    ]);
  }
  const head = [
    'metric',
    'base median',
    'new median',
    'change',
    'base p90',
    'new p90 (change)',
    '',
  ];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  for (const r of all)
    console.log(
      r
        .map((c, i) => String(c).padEnd(w[i]))
        .join('  ')
        .trimEnd(),
    );
  console.log(
    `\nBaseline: ${base.meta?.label ?? '?'} (${base.meta?.commit?.slice(0, 7) ?? '?'}, ${base.meta?.cpu ?? '?'})`,
  );
  console.log(
    `Current:  ${cur.meta?.label ?? '?'} (${cur.meta?.commit?.slice(0, 7) ?? '?'}, ${cur.meta?.cpu ?? '?'})`,
  );
  if (base.meta?.cpu && cur.meta?.cpu && base.meta.cpu !== cur.meta.cpu)
    console.log('WARNING: made on different computers; the comparison is not reliable.');
  console.log(
    `${regressions} regression(s) over ${THRESHOLD}% (and over the noise floor: 1 ms, 3 MB, 2 KB, 2 points).`,
  );
  return regressions > 0 && !flag('no-fail') ? 1 : 0;
}

// ---------- main ----------
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (ONLY.has('engine')) runEngine();
  if (ONLY.has('bundles')) runBundles();
  if (ONLY.has('renderer')) await runRenderer();
  const result = {
    meta: {
      label: `${pkg.name} ${pkg.version}`,
      version: pkg.version,
      commit: git(['rev-parse', 'HEAD']),
      dirty:
        git(['status', '--porcelain', '--', 'src', 'electron.vite.config.ts', 'package.json']) !==
        '',
      date: new Date().toISOString(),
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: `${cpus()[0]?.model.trim() ?? '?'} x${cpus().length}`,
      ramGB: Math.round(totalmem() / 1073741824),
      runs: RUNS,
      warmCallsPerRun: WARM,
      parts: [...ONLY],
      ...details,
    },
    metrics,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  log(`saved ${OUT}`);
  console.log('');
  if (COMPARE)
    process.exit(compare(JSON.parse(readFileSync(resolve(root, COMPARE), 'utf8')), result));
  // No baseline given: print a plain table.
  const rows = Object.entries(metrics).map(([k, m]) => [
    k,
    fmt(m.median, m.unit),
    fmt(m.p90, m.unit),
    `n=${m.n}`,
  ]);
  const w = [0, 1, 2, 3].map((i) =>
    Math.max(...rows.map((r) => r[i].length), ['metric', 'median', 'p90', 'n'][i].length),
  );
  for (const r of [['metric', 'median', 'p90', 'n'], ...rows])
    console.log(
      r
        .map((c, i) => c.padEnd(w[i]))
        .join('  ')
        .trimEnd(),
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
