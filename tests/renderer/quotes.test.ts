// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { foldQuotedHtml, setQuoteOpen, splitQuotedText, QUOTE_SHOW, QUOTE_HIDE } from '../../src/renderer/src/lib/quotes';
import { buildSrcdoc, sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

const parse = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

/** Text of a node with a space where a tag was (so "a<br>b" reads "a b"). */
const textOf = (n: Element): string =>
  n.innerHTML
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Text that stays visible (outside the folded parts). */
function visibleText(html: string): string {
  const body = parse(html);
  body.querySelectorAll('.ld-qb, .ld-qt, style').forEach((n) => n.remove());
  return textOf(body);
}
function hiddenText(html: string): string {
  return [...parse(html).querySelectorAll('.ld-qb')].map(textOf).join(' | ');
}

describe('foldQuotedHtml', () => {
  it('Gmail: folds the whole .gmail_quote, including the "wrote:" line', () => {
    const r = foldQuotedHtml(
      '<div dir="ltr">Hi Alex,<br>Here is the plan.</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 5 Oct 2026 at 10:41, Jane &lt;jane@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex"><div>Can you send the plan before Friday?</div></blockquote></div>',
    );
    expect(r.count).toBe(1);
    expect(visibleText(r.html)).toBe('Hi Alex, Here is the plan.');
    expect(hiddenText(r.html)).toContain('Jane <jane@example.com> wrote:');
    expect(hiddenText(r.html)).toContain('Can you send the plan before Friday?');
  });

  it('Apple Mail: blockquote[type=cite] with the "On ... wrote:" line before it', () => {
    const r = foldQuotedHtml(
      '<div>Thanks, see you then.</div><div><br></div><div>On Oct 5, 2026, at 10:41, Jane Cooper &lt;jane@example.com&gt; wrote:</div><br><blockquote type="cite"><div>Are we still on for Thursday?</div></blockquote>',
    );
    expect(r.count).toBe(1);
    expect(visibleText(r.html)).toBe('Thanks, see you then.');
    expect(hiddenText(r.html)).toContain('wrote:');
    expect(hiddenText(r.html)).toContain('Are we still on for Thursday?');
  });

  it('Letterdock and old Mailroom replies: intro line plus blockquote', () => {
    for (const cls of ['letterdock', 'mailroom']) {
      const r = foldQuotedHtml(
        `<p>Reply text</p><div class="${cls}-quote-intro">On Oct 5, 2026, 10:41 AM, Jane wrote:</div><blockquote class="${cls}-quote" style="margin:0">Older text</blockquote>`,
      );
      expect(r.count).toBe(1);
      expect(visibleText(r.html)).toBe('Reply text');
      expect(hiddenText(r.html)).toBe('On Oct 5, 2026, 10:41 AM, Jane wrote: Older text');
    }
  });

  it('Outlook on the web: the #divRplyFwdMsg separator and everything after it', () => {
    const r = foldQuotedHtml(
      '<div>Sounds good.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font><b>From:</b> Jane<br><b>Sent:</b> Monday<br><b>To:</b> Alex<br><b>Subject:</b> Plan</font><div>&nbsp;</div></div><div>Original question about the plan.</div><div>Second old paragraph.</div>',
    );
    expect(r.count).toBe(1);
    expect(visibleText(r.html)).toBe('Sounds good.');
    expect(hiddenText(r.html)).toContain('Original question about the plan.');
    expect(hiddenText(r.html)).toContain('Second old paragraph.');
  });

  it('Outlook desktop: a div with a solid border-top that starts with From: and Sent:', () => {
    const r = foldQuotedHtml(
      '<div class="WordSection1"><p>My answer.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Jane<br><b>Sent:</b> Monday, 5 October 2026 10:41<br><b>Subject:</b> Plan</p></div><p>Old text one.</p><p>Old text two.</p></div>',
    );
    expect(r.count).toBe(1);
    expect(visibleText(r.html)).toBe('My answer.');
    expect(hiddenText(r.html)).toContain('Old text two.');
  });

  it('puts a toggle button in front of the quote: closed, labelled, keyboard reachable', () => {
    const r = foldQuotedHtml('<p>x</p><blockquote type="cite">old</blockquote>');
    const btn = parse(r.html).querySelector<HTMLElement>('[data-ld-toggle]')!;
    expect(btn.getAttribute('role')).toBe('button');
    expect(btn.getAttribute('tabindex')).toBe('0');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe(QUOTE_SHOW);
    expect(btn.textContent).toBe('…');
  });

  it('folds each separate quote and not the same one twice', () => {
    const r = foldQuotedHtml(
      '<p>one</p><blockquote type="cite">q1<blockquote type="cite">nested</blockquote></blockquote><p>two</p><blockquote type="cite">q2</blockquote>',
    );
    expect(r.count).toBe(2);
    expect(visibleText(r.html)).toBe('one two');
    expect(parse(r.html).querySelectorAll('.ld-qw .ld-qw').length).toBe(0);
  });

  it('leaves a message alone when it is only a quote (a forward, nothing of its own)', () => {
    const html = '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------</div><blockquote class="gmail_quote">All the content</blockquote></div>';
    const r = foldQuotedHtml(html);
    expect(r.count).toBe(0);
    expect(r.html).toBe(html);
  });

  it('does not fold a plain blockquote (a pull quote in a newsletter) or ordinary mail', () => {
    expect(foldQuotedHtml('<p>Hello</p><blockquote>"A nice quote", said someone.</blockquote>').count).toBe(0);
    expect(foldQuotedHtml('<p>Hello there</p>').count).toBe(0);
  });

  it('never wraps rows of a table in a div', () => {
    const html = '<table><tbody><tr><td>mine</td></tr><tr id="divRplyFwdMsg"><td>From: x Sent: y</td></tr><tr><td>old</td></tr></tbody></table>';
    expect(foldQuotedHtml(html).count).toBe(0);
  });

  it('survives the sanitizer (the pipeline folds after sanitizing)', () => {
    const s = sanitizeEmailHtml('<p>Hi</p><blockquote type="cite" onclick="x()">old <script>alert(1)</script></blockquote>');
    const r = foldQuotedHtml(s.blocked);
    expect(r.count).toBe(1);
    expect(r.html).not.toMatch(/<script|onclick/i);
  });

  it('setQuoteOpen opens and closes one quote and updates the label', () => {
    const body = parse(foldQuotedHtml('<p>x</p><blockquote type="cite">old</blockquote>').html);
    const btn = body.querySelector('[data-ld-toggle]')!;
    const wrap = body.querySelector('.ld-qw')!;
    expect(setQuoteOpen(btn)).toBe(true);
    expect(wrap.hasAttribute('data-open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe(QUOTE_HIDE);
    expect(setQuoteOpen(btn)).toBe(false);
    expect(wrap.hasAttribute('data-open')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe(QUOTE_SHOW);
  });

  it('the frame CSS hides the quote until opened and styles the pill', () => {
    const doc = buildSrcdoc('<p>x</p>', false);
    expect(doc).toContain('.ld-qb{display:none}');
    expect(doc).toContain('.ld-qw[data-open]>.ld-qb{display:block}');
    expect(doc).toContain('.ld-qt');
  });
});

describe('splitQuotedText', () => {
  it('folds "> " lines with the "On ... wrote:" line before them', () => {
    const parts = splitQuotedText('Sounds good.\n\nOn Mon, 5 Oct 2026 at 10:41, Jane <jane@example.com> wrote:\n> Can you send it?\n> Thanks\n\nBest,\nAlex');
    expect(parts.map((p) => p.quoted)).toEqual([false, true, false]);
    expect(parts[1]!.text).toBe('On Mon, 5 Oct 2026 at 10:41, Jane <jane@example.com> wrote:\n> Can you send it?\n> Thanks');
    expect(parts[0]!.text).toBe('Sounds good.\n');
    expect(parts[2]!.text).toBe('\nBest,\nAlex');
  });

  it('takes an intro that wraps onto two lines', () => {
    const parts = splitQuotedText('Yes.\nOn Mon, 5 Oct 2026 at 10:41 AM Jane Cooper\n<jane@example.com> wrote:\n> old');
    expect(parts.map((p) => p.quoted)).toEqual([false, true]);
    expect(parts[1]!.text.split('\n')).toHaveLength(3);
  });

  it('keeps blank lines inside a quote and nested ">>" levels together', () => {
    const parts = splitQuotedText('Top\n> a\n\n> b\n>> c\nBottom');
    expect(parts.map((p) => p.quoted)).toEqual([false, true, false]);
    expect(parts[1]!.text).toBe('> a\n\n> b\n>> c');
  });

  it('folds everything after "-----Original Message-----"', () => {
    const parts = splitQuotedText('Done.\n\n-----Original Message-----\nFrom: Jane\nSent: Monday\nOld text');
    expect(parts.map((p) => p.quoted)).toEqual([false, true]);
    expect(parts[1]!.text.startsWith('-----Original Message-----')).toBe(true);
  });

  it('does not fold when nothing else is left, or when there is no quote', () => {
    expect(splitQuotedText('> only quoted\n> lines')).toEqual([{ quoted: false, text: '> only quoted\n> lines' }]);
    expect(splitQuotedText('Hello\nworld')).toEqual([{ quoted: false, text: 'Hello\nworld' }]);
  });
});
