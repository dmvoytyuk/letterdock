// @vitest-environment jsdom
// Tracker notice (DESIGN-SPEC 3.13.7): trackers are taken out of BOTH variants, also after "Load images".
import { describe, expect, it } from 'vitest';
import * as trackers from '../../src/shared/trackers';
import { sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

const run = (html: string) => sanitizeEmailHtml(html, {}, trackers);

describe('sanitizeEmailHtml with the tracker list', () => {
  it('keeps known trackers and hidden pixels out of the allowed variant too', () => {
    const out = run(
      '<img src="https://pics.example.org/photo.png" width="300"><img src="https://open.convertkit.com/o/a.gif"><img src="https://x.unknown.example/p.gif" width="1" height="1">',
    );
    expect(out.trackers.count).toBe(2);
    expect(out.trackers.domains).toEqual(['open.convertkit.com']);
    expect(out.allowed).not.toContain('convertkit');
    expect(out.allowed).not.toContain('x.unknown.example');
    expect(out.blocked).not.toContain('convertkit');
    // the real picture still loads after "Load images" (through the local cache)
    expect(out.allowed).toContain('letterdock-img://');
    expect(out.hasRemote).toBe(true);
  });

  it('a message with only trackers has no remote images to ask about', () => {
    const out = run('<p>hi</p><img src="https://track.mailchimpapp.net/p.gif"><img src="//a.sendgrid.net/wf/open?u=1">');
    expect(out.trackers.count).toBe(2);
    expect(out.hasRemote).toBe(false);
    expect(trackers.trackerNoticeText(out.trackers)).toMatch(/^Blocked 2 trackers from /);
  });

  it('does nothing and never throws without the list', () => {
    const out = sanitizeEmailHtml('<img src="https://open.convertkit.com/o/a.gif">');
    expect(out.trackers).toEqual({ count: 0, domains: [] });
    expect(out.hasRemote).toBe(true);
  });

  it('links are not touched', () => {
    const out = run('<a href="https://open.convertkit.com/click?x=1">go</a>');
    expect(out.trackers.count).toBe(0);
    expect(out.blocked).toContain('convertkit.com/click');
  });
});
