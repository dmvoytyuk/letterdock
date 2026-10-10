import { describe, expect, it } from 'vitest';
import {
  TRACKER_DOMAINS,
  displayDomain,
  isHiddenPixel,
  isTracker,
  isTrackerUrl,
  summarizeTrackers,
  trackerListSize,
  trackerNoticeText,
} from '../../src/shared/trackers';

describe('tracker list', () => {
  it('has about 300 entries, all lower case, no spaces, no scheme', () => {
    expect(trackerListSize()).toBeGreaterThanOrEqual(250);
    expect(trackerListSize()).toBeLessThanOrEqual(400);
    for (const d of TRACKER_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
      expect(d).not.toMatch(/\s|:\/\//);
    }
  });

  it('does not list content hosts', () => {
    for (const d of ['mcusercontent.com', 'gallery.mailchimp.com', 'cloudfront.net', 'gstatic.com', 'googleusercontent.com']) {
      expect(isTrackerUrl(`https://${d}/img.png`)).toBe(false);
    }
  });
});

describe('isTrackerUrl', () => {
  it('matches the registered domain and everything below it', () => {
    expect(isTrackerUrl('https://open.convertkit.com/o/1.gif')).toBe(true);
    expect(isTrackerUrl('https://u123.ct.sendgrid.net/wf/open?upn=abc')).toBe(true);
    expect(isTrackerUrl('https://a.b.mandrillapp.com/track/open.php')).toBe(true);
    expect(isTrackerUrl('http://MANDRILLAPP.com/x')).toBe(true);
    expect(isTrackerUrl('https://www.list-manage.com/track/open.php?u=1')).toBe(true);
  });

  it('does not match look-alike hosts', () => {
    expect(isTrackerUrl('https://notmandrillapp.com/x.gif')).toBe(false);
    expect(isTrackerUrl('https://mandrillapp.com.evil.example/x.gif')).toBe(false);
    expect(isTrackerUrl('https://example.com/logo.png')).toBe(false);
  });

  it('uses path hints for hosts that also serve real content', () => {
    expect(isTrackerUrl('https://www.facebook.com/email_open_log_pic.php?mid=1')).toBe(true);
    expect(isTrackerUrl('https://www.facebook.com/images/logo.png')).toBe(false);
    expect(isTrackerUrl('https://www.linkedin.com/emimp/ip_abc.gif')).toBe(true);
    expect(isTrackerUrl('https://www.linkedin.com/company/logo.png')).toBe(false);
  });

  it('uses the generic open-tracking paths on any host', () => {
    expect(isTrackerUrl('https://links.brand.example/track/open?x=1')).toBe(true);
    expect(isTrackerUrl('https://links.brand.example/wf/open?upn=1')).toBe(true);
  });

  it('ignores things that are not web addresses', () => {
    expect(isTrackerUrl('cid:logo')).toBe(false);
    expect(isTrackerUrl('data:image/gif;base64,AAAA')).toBe(false);
    expect(isTrackerUrl('not a url')).toBe(false);
  });
});

describe('isHiddenPixel', () => {
  it('is true for 1x1 and 0x0, by attributes or style', () => {
    expect(isHiddenPixel({ width: '1', height: '1' })).toBe(true);
    expect(isHiddenPixel({ width: '0', height: '0' })).toBe(true);
    expect(isHiddenPixel({ width: '1px', height: '1px' })).toBe(true);
    expect(isHiddenPixel({ style: 'width:1px;height:1px' })).toBe(true);
    expect(isHiddenPixel({ style: 'WIDTH: 1px !important; height: 1px' })).toBe(true);
    expect(isHiddenPixel({ width: '1', style: 'height:1px' })).toBe(true);
  });

  it('is true for hidden images', () => {
    expect(isHiddenPixel({ style: 'display:none' })).toBe(true);
    expect(isHiddenPixel({ style: 'color:red; visibility: hidden' })).toBe(true);
    expect(isHiddenPixel({ style: 'opacity:0' })).toBe(true);
    expect(isHiddenPixel({ hidden: true })).toBe(true);
    expect(isHiddenPixel({ width: '0', height: '40' })).toBe(true);
  });

  it('is false for real pictures, including thin lines', () => {
    expect(isHiddenPixel({ width: '600', height: '300' })).toBe(false);
    expect(isHiddenPixel({ width: '100%', height: 'auto' })).toBe(false);
    expect(isHiddenPixel({ width: '600', height: '1' })).toBe(false); // a divider line
    expect(isHiddenPixel({ style: 'height:1px;width:100%' })).toBe(false);
    expect(isHiddenPixel({ style: 'opacity:0.5' })).toBe(false);
    expect(isHiddenPixel({})).toBe(false);
  });
});

describe('summarizeTrackers / notice text', () => {
  it('counts each tracking image once and lists hosts without duplicates', () => {
    const s = summarizeTrackers([
      { src: 'https://open.convertkit.com/a.gif', width: '1', height: '1' },
      { src: 'https://open.convertkit.com/b.gif' },
      { src: 'https://example.com/hero.png', width: '600', height: '200' },
      { src: 'https://news.example.org/p.gif', width: '1', height: '1' },
    ]);
    expect(s.count).toBe(3);
    expect(s.domains).toEqual(['open.convertkit.com']);
    expect(isTracker({ src: 'https://example.com/hero.png' })).toBe(false);
  });

  it('writes the notice the way the design says', () => {
    const t = (domains: string[], count: number) => trackerNoticeText({ domains, count });
    expect(t(['open.convertkit.com'], 1)).toBe('Blocked 1 tracker from convertkit.com');
    expect(t(['mailchimp.com', 'list-manage.com'], 2)).toBe('Blocked 2 trackers from mailchimp.com and list-manage.com');
    expect(t(['a.com', 'b.com', 'c.com', 'd.com'], 4)).toBe('Blocked 4 trackers from a.com, b.com and 2 more');
    expect(t([], 1)).toBe('Blocked 1 hidden tracking image');
    expect(t([], 3)).toBe('Blocked 3 hidden tracking images');
    expect(t([], 0)).toBe('');
  });

  it('shortens host names to the registered domain', () => {
    expect(displayDomain('www.open.convertkit.com')).toBe('convertkit.com');
    expect(displayDomain('click.news.example.co.uk')).toBe('example.co.uk');
    expect(displayDomain('example.com')).toBe('example.com');
  });
});
