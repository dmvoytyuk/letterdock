// Tracker notice (DESIGN-SPEC 3.13.7): which remote images in a mail are tracking pixels.
// Pure functions, no node / electron / DOM imports. The renderer's sanitize pass calls them for each
// <img>; load this file with a dynamic import() the first time an HTML message is opened.
//
// SOURCE OF THE LIST. Compiled by hand from the open / click-tracking domains of well-known email
// service providers, sales-tracking tools and the big social networks' email beacons. Every entry
// is a domain used for tracking (the image URL is a pixel or a redirect), not for content. Content
// hosts (CDNs, image hosts such as mcusercontent.com or gallery.mailchimp.com) are deliberately NOT
// listed, so a real picture is never blocked by the list. Names are from public provider
// documentation and common privacy-list knowledge; there is no machine-copied third-party list here.
// Review before every release and add entries when a new tracker is reported.
//
// MATCHING. A host matches when it equals an entry or ends with "." + entry (so `a.b.mandrillapp.com`
// matches `mandrillapp.com`). Entries with a path (`facebook.com/email_open_log_pic.php`) only match
// when the URL path starts with that path, for hosts that also serve real content.

/** Registered domains (and everything below them) that exist only to track opens and clicks. */
export const TRACKER_DOMAINS: readonly string[] = [
  // Mailchimp / Mandrill / Intuit
  'list-manage.com', 'mandrillapp.com', 'mailchimpapp.net', 'rsgsv.net', 'mcsv.net', 'inbox.mailchimp.com',
  // SendGrid / Twilio
  'sendgrid.net', 'sgrid.co', 'sendgrid.me', 'ct.sendgrid.net', 'email.sendgrid.net',
  // Mailgun / Sinch
  'mailgun.org', 'mailgun.net', 'mg.mailgun.org', 'mailgun.us',
  // Amazon SES click / open tracking
  'awstrack.me', 'r.us-east-1.awstrack.me', 'r.eu-west-1.awstrack.me', 'r.us-west-2.awstrack.me',
  // SparkPost / Bird
  'sparkpostmail.com', 'sparkpostmail1.com', 'spgo.io', 'sparkpost.com/api', 'e.sparkpost.com',
  // Postmark
  'pstmrk.it', 'postmarkapp.com/track', 'pm-bounces.com',
  // HubSpot (marketing and Sales tracking)
  'hubspotemail.net', 'hs-sites.com/__ptq.gif', 'track.hubspot.com', 'hubspot.com/__ptq.gif',
  'hs-analytics.net', 'hubspotlinks.com', 'hubspotfree.net', 'hubspotstarter.net',
  'sidekickopen01.com', 'sidekickopen02.com', 'sidekickopen03.com', 'sidekickopen04.com',
  'sidekickopen05.com', 'sidekickopen06.com', 'sidekickopen07.com', 'sidekickopen08.com',
  'sidekickopen09.com', 'sidekickopen10.com', 'sidekickopen11.com', 'sidekickopen12.com',
  'sidekickopen13.com', 'sidekickopen14.com', 'sidekickopen15.com', 'sidekickopen16.com',
  'sidekickopen17.com', 'sidekickopen18.com', 'sidekickopen19.com', 'sidekickopen20.com',
  'signaux.io', 't.signaux.com', 't.senal.io', 't.sigopn.io', 't.sidekickopen.com',
  // Campaign Monitor (cmail1..cmail20 are its tracking domains)
  'cmail1.com', 'cmail2.com', 'cmail3.com', 'cmail4.com', 'cmail5.com', 'cmail6.com', 'cmail7.com',
  'cmail8.com', 'cmail9.com', 'cmail10.com', 'cmail11.com', 'cmail12.com', 'cmail13.com', 'cmail14.com',
  'cmail15.com', 'cmail16.com', 'cmail17.com', 'cmail18.com', 'cmail19.com', 'cmail20.com',
  'createsend1.com', 'createsend2.com', 'createsend3.com', 'createsend4.com', 'createsend5.com',
  // Constant Contact
  'rs6.net', 'rs6.com', 'r20.rs6.net', 'myemma.com',
  'e2ma.net', 'ccsend.com',
  // Salesforce Marketing Cloud / ExactTarget / Pardot / Eloqua / Oracle Responsys
  'exct.net', 'cl.exct.net', 'image.exct.net', 'pi.pardot.com', 'pardot.com/r', 'go.pardot.com/r',
  'elqtrk.com', 'elq.mk', 'elqimg.com', 'eloqua.com/e/', 'en25.com', 'rsys2.net', 'rsys3.net',
  'rsys4.net', 'rsys5.net', 'ed10.net', 'ed4.net', 'responsys.net', 'sailthru.com/trk', 'trk.sailthru.com',
  // Adobe Campaign / Marketo / Acoustic (Silverpop)
  'mktoresp.com', 'mkto-ab.com', 'mktossl.com', 'mkt41.net', 'mkt51.net',
  'mkt61.net', 'mkt71.net', 'mkt81.net', 'mkt91.net', 'mkt922.com', 'mkt3000.com', 'mkt4000.com',
  'nr.silverpop.com', 'recp.mkt41.net', 'e.acoustic.co',
  'cheetahmail.com', 'cheetahmails.com', 'emltrk.com',
  // Klaviyo / Omnisend / Drip / Customer.io / Iterable / Braze / Brevo (Sendinblue)
  'klaviyomail.com', 'klclick.com', 'klclick1.com', 'klclick2.com', 'klclick3.com', 'trk.klaviyomail.com',
  'omnisrc.com', 'dripemail2.com',
  'customeriomail.com', 'track.customer.io', 'e.customeriomail.com', 'cio-mail.com', 
  'links.iterable.com', 'iterable-mail.com', 'iterablemail.com', 
  'sendibt.com', 'sendibt2.com', 'sendibt3.com', 'sendibm1.com', 'sendibm2.com', 'sendibm3.com',
  'sib.email', 'sibautomation.com', 'brevosend.com',
  // ConvertKit / Kit, Substack-like newsletter tools, Beehiiv, MailerLite, Buttondown, Ghost
  'convertkit-mail.com', 'convertkit-mail2.com', 'kit-mail.com', 'kit-mail2.com', 'open.convertkit.com',
  'links.beehiiv.com', 'link.mail.beehiiv.com',
  'mlsend.com', 'mlsend2.com', 'ml.mailerlite.com', 'mailerlite.io',
  'bnc.lt', 'substack.com/api/v1/email/open', 'mg1.substack.com',
  'mg2.substack.com', 
  // AWeber / GetResponse / ActiveCampaign / Benchmark / Moosend / Mailjet / SendPulse / Emma
  'aweb.com', 'gr-mail.com', 'gr8.com',
  'acemlnb.com', 'acemlna.com', 'acemlnc.com',
  'acemlnd.com', 'bmetrack.com', 'bmbstatic.com', 
  'mjt.lu', 'mjt-link.com', 'mailjet-link.com', 
  'stat-pulse.com', 'sp-mail.net', 'yesmail.com', 'yesmail.net',
  // Intercom / Zendesk / Freshworks / Help Scout / Drift / Mixpanel-style product mail
  'intercom-mail.com', 'intercom-clicks.com', 'intercom-mail-1.com', 'via.intercom.io',
  
  'driftmail.com', 'mixmax.com/api/track', 'mixmax.com/e',
  
  // Sales and recruiting outreach trackers
  'yesware.com', 'yesware.net', 'mailtrack.io', 'mltrk.io', 'mailfoogae.appspot.com', 
  'bananatag.com', 'bl-1.com', 'bl-2.com', 'o.outreach.io', 
  'sdr.salesloft.com', 'sl-trk.com', 'lemlist.com/api/track', 'lemlist.com/tracking',
  'tracking.mailbutler.io',
  'trackapp.io', 'getnotify.com', 'readnotify.com', 'didtheyreadit.com',
  'pointofmail.com', 'whoreadme.com', 'spk.superhuman.com',
  
  'yamm-track.appspot.com', 
  
  
  // Email testing / analytics beacons
  'emltrk.com', '250ok.com',
  'returnpath.net', 
  
  // Retail / marketing automation platforms
  'shopifyemail.com', 'shopifyemail.net', 'e.shopifyemail.com',
  'wixemails.com', 
  'mailupnet.com',
  'emarsys.net', 'emarsys.com/track', 'emsecure.net', 'scarabresearch.com', 'sc.emarsys.net',
  'dotdigital-email.com', 'dmtrk.net', 'dmtrk.com', 'comms.dotdigital.com',
  'slgnt.eu', 'slgnt.us', 'ymlp3.com', 'ymlpsrv.com',
  'vresp.com', 'imakenews.com',
  'mailigen.net',
  'nl2go.com', 'nl2go.link', 'inxmail.de',
  
  
  'cakemail.net', 'flodesk.com/track', 'flodesk.page',
  'zohocampaigns.com/track', 'zcsend.net', 
  'zoho-sender.com', 'maillist-manage.com', 'maillist-manage.eu', 'maillist-manage.in',
  'maillist-manage.com.au', 'tinyletter.com/track', 
  // Social networks' email beacons (path hints keep their real image hosts working)
  'facebook.com/email_open_log_pic.php', 
  'linkedin.com/emimp/', 'linkedin.com/e/v2', 'twitter.com/scribe',
  't.co/i/adsct', 
  
  
  
  
  'doubleclick.net', 'googleadservices.com/pagead', 'google-analytics.com/collect', 'ssl.google-analytics.com',
  'googletagmanager.com/gtm', 'adsrvr.org', 'adnxs.com', 'scorecardresearch.com', 'quantserve.com',
  'omtrdc.net', '2o7.net', 'demdex.net', 'everesttech.net', 'bluekai.com', 'krxd.net', 'rlcdn.com',
  'agkn.com', 'mathtag.com', 'rubiconproject.com/pixel', 'pubmatic.com/track', 'criteo.com/track',
  'criteo.net/track', 'taboola.com/track', 'outbrain.com/track',
  // Retention / CRM platforms and affiliate impression pixels
  'bluecore.com', 'listrakbi.com', 'listrak.com/track', 'crdl.io', 'emv2.com', 'emv3.com', 'agillic.net',
  'emjcd.com', 'impactradius-event.com', 'shareasale-analytics.com', 'tracking.mailtrack.io',
  // Analytics and ad beacons that also appear as email images
  'bat.bing.com', 'clarity.ms', 'px.ads.linkedin.com', 'analytics.twitter.com', 'sb.scorecardresearch.com',
  'matomo.cloud', 'piwik.pro', 'ads.yahoo.com', 'pixel.adsafeprotected.com', 'ib.adnxs.com',
];

/** Path starts that mark an open-tracking pixel on ANY host (very specific on purpose). */
export const TRACKER_PATH_HINTS: readonly string[] = [
  '/wf/open', // SendGrid, Mailchimp-style "web fonts open"
  '/track/open', // many ESPs
  '/tracking/open',
  '/e/o/', // Marketo-style
  '/trk/open',
];

interface Entry {
  host: string;
  path: string | null;
}

let compiled: { byHost: Map<string, Entry[]>; hosts: string[] } | null = null;

function compile(): NonNullable<typeof compiled> {
  if (compiled) return compiled;
  const byHost = new Map<string, Entry[]>();
  const hosts: string[] = [];
  for (const raw of TRACKER_DOMAINS) {
    const slash = raw.indexOf('/');
    const host = (slash >= 0 ? raw.slice(0, slash) : raw).toLowerCase();
    const path = slash >= 0 ? raw.slice(slash) : null;
    const list = byHost.get(host) ?? [];
    list.push({ host, path });
    byHost.set(host, list);
    if (!hosts.includes(host)) hosts.push(host);
  }
  compiled = { byHost, hosts };
  return compiled;
}

/** Number of distinct entries (hosts or host + path) in the list. */
export function trackerListSize(): number {
  return new Set(TRACKER_DOMAINS.map((d) => d.toLowerCase())).size;
}

/** The host to show for a tracker: lower case, no leading `www.`. */
function cleanHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** Registered-domain-ish label for the notice: the last two labels (three for co.uk style). */
export function displayDomain(host: string): string {
  const h = cleanHost(host);
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const sld = parts[parts.length - 2]!;
  if (parts[parts.length - 1]!.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(sld)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** Is this image URL from a known tracking host (or has a specific tracking path)? */
export function isTrackerUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = cleanHost(u.hostname);
  const path = u.pathname.toLowerCase();
  const { byHost } = compile();
  // Walk up the host: a.b.example.com -> b.example.com -> example.com.
  const labels = host.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const entries = byHost.get(labels.slice(i).join('.'));
    if (!entries) continue;
    for (const e of entries) if (e.path === null || path.startsWith(e.path.toLowerCase())) return true;
  }
  return TRACKER_PATH_HINTS.some((p) => path.includes(p));
}

export interface PixelInfo {
  /** The width / height attributes as written (`"1"`, `"0"`, `"1px"`), or undefined. */
  width?: string | null;
  height?: string | null;
  /** The style attribute, if any. */
  style?: string | null;
  /** The `hidden` attribute is set. */
  hidden?: boolean;
}

function dimIsTiny(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(v);
  if (!m) return false;
  return Number(m[1]) <= 1;
}

function styleDim(style: string, prop: 'width' | 'height'): string | null {
  const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m ? m[1]!.trim().replace(/\s*!important\s*$/i, '') : null;
}

/**
 * A 1x1 or 0x0 image, or a hidden one: width / height attributes or inline style at most 1px (both
 * sides, or just one side at 0), `display:none`, `visibility:hidden`, `opacity:0` or the `hidden`
 * attribute. A normal image with only one tiny side (a thin divider line) is NOT a pixel.
 */
export function isHiddenPixel(img: PixelInfo): boolean {
  if (img.hidden) return true;
  const style = img.style ?? '';
  if (/(^|[;\s])display\s*:\s*none\b/i.test(style)) return true;
  if (/(^|[;\s])visibility\s*:\s*hidden\b/i.test(style)) return true;
  if (/(^|[;\s])opacity\s*:\s*0(\.0+)?\s*(;|$|!)/i.test(style)) return true;
  const w = img.width ?? styleDim(style, 'width');
  const h = img.height ?? styleDim(style, 'height');
  const sw = styleDim(style, 'width');
  const sh = styleDim(style, 'height');
  const ww = dimIsTiny(w) ? w : dimIsTiny(sw) ? sw : null;
  const hh = dimIsTiny(h) ? h : dimIsTiny(sh) ? sh : null;
  if (ww !== null && hh !== null) return true;
  // One side zero is invisible as well.
  const zero = (v: string | null | undefined) => v !== null && v !== undefined && /^\s*0+(\.0+)?\s*(px)?\s*$/i.test(v);
  return zero(w) || zero(h) || zero(sw) || zero(sh);
}

export interface TrackerSummary {
  count: number;
  /** Host names, lower case, no duplicates. Hidden pixels from unknown hosts add no domain. */
  domains: string[];
}

/** One image seen by the sanitize pass. */
export interface TrackerCandidate extends PixelInfo {
  /** The image address (http / https). */
  src: string;
}

/** True when the image is a tracker: from the list, or a hidden pixel. */
export function isTracker(c: TrackerCandidate): boolean {
  return isTrackerUrl(c.src) || isHiddenPixel(c);
}

/**
 * Counts the trackers among the images and lists their hosts. One image = one count. A hidden pixel
 * from an unknown host counts but adds no domain (the notice then says "hidden tracking image").
 */
export function summarizeTrackers(images: readonly TrackerCandidate[]): TrackerSummary {
  const domains: string[] = [];
  let count = 0;
  for (const img of images) {
    const listed = isTrackerUrl(img.src);
    if (!listed && !isHiddenPixel(img)) continue;
    count++;
    if (listed) {
      try {
        const h = cleanHost(new URL(img.src).hostname);
        if (!domains.includes(h)) domains.push(h);
      } catch {
        /* unreachable: isTrackerUrl parsed it */
      }
    }
  }
  return { count, domains };
}

/** Text for the notice (DESIGN-SPEC 3.13.7). Empty string when there is nothing to say. */
export function trackerNoticeText(s: TrackerSummary): string {
  if (s.count === 0) return '';
  if (s.domains.length === 0) {
    return s.count === 1 ? 'Blocked 1 hidden tracking image' : `Blocked ${s.count} hidden tracking images`;
  }
  const shown = s.domains.map(displayDomain).filter((d, i, a) => a.indexOf(d) === i);
  const noun = s.count === 1 ? 'tracker' : 'trackers';
  let from: string;
  if (shown.length === 1) from = shown[0]!;
  else if (shown.length === 2) from = `${shown[0]} and ${shown[1]}`;
  else from = `${shown[0]}, ${shown[1]} and ${shown.length - 2} more`;
  return `Blocked ${s.count} ${noun} from ${from}`;
}
