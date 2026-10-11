import { convert } from 'html-to-text';
import type { CalendarEvent, EmailAddress } from './types';

/**
 * Safe email normalisation (docs/plan §7.2). Email content is hostile input:
 *  - HTML is converted to text only; it is never rendered or executed, and hidden elements
 *    (a classic way to hide prompt-injection or keyword stuffing) are dropped;
 *  - everything is size-capped before any regular expression sees it, and the regexes used
 *    here avoid nested quantifiers, so matching stays fast on malicious input;
 *  - links are collected and unwrapped by parsing only; they are never fetched.
 */
export const MAX_TEXT_CHARS = 100_000;
const MAX_HTML_CHARS = 500_000;
const MAX_LINKS = 200;

export function parseAddress(raw: string | null | undefined): EmailAddress | null {
  if (!raw) return null;
  const value = raw.slice(0, 500);
  const angle = /<([^<>\s]{3,254})>/.exec(value);
  const address = (angle?.[1] ?? /[^\s<>"',;]{1,64}@[^\s<>"',;]{1,190}/.exec(value)?.[0] ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  let name: string | null = angle ? value.slice(0, angle.index).trim() : null;
  name = name ? name.replace(/^"+|"+$/g, '').trim() || null : null;
  return { address, name, domain: address.slice(at + 1) };
}

export function htmlToText(html: string): string {
  return convert(html.slice(0, MAX_HTML_CHARS), {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: '[style*="display:none"]', format: 'skip' },
      { selector: '[style*="display: none"]', format: 'skip' },
      { selector: '[hidden]', format: 'skip' },
      { selector: 'table', format: 'block' },
      { selector: 'tr', format: 'block' },
      { selector: 'td', format: 'inline' },
    ],
  });
}

const LINK_PATTERN = /<a\b[^>]{0,2000}?href\s*=\s*["']([^"']{1,2000})["'][^>]{0,2000}>([^<]{0,300})/gi;

export function extractHtmlLinks(html: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  for (const match of html.slice(0, MAX_HTML_CHARS).matchAll(LINK_PATTERN)) {
    const href = canonicalUrl(decodeEntities(match[1]!));
    if (href) links.push({ href, text: decodeEntities(match[2]!).trim() });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

export function extractTextLinks(text: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]{1,2000}/g)) {
    const href = canonicalUrl(match[0]);
    if (href) links.push({ href, text: '' });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

const TRACKING_PARAMS = /^(utm_\w+|trk|trkinfo|refid|trackingid|lipi|midtoken|midsig|eid|otptoken|fbclid|gclid|mc_eid|mc_cid)$/i;

/** Unwraps known redirectors and drops tracking parameters. Only http(s) URLs survive. */
export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const wrapped =
    (host === 'www.google.com' && url.pathname === '/url' && (url.searchParams.get('q') ?? url.searchParams.get('url'))) ||
    (host.endsWith('safelinks.protection.outlook.com') && url.searchParams.get('url')) ||
    null;
  if (wrapped && wrapped !== raw) return canonicalUrl(wrapped);
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.hash = '';
  return url.toString();
}

const FORWARD_MARKER = /^-{2,}\s*Forwarded message\s*-{2,}|^Begin forwarded message:/im;
const REPLY_MARKER = /^On .{1,200}wrote:\s*$|^-{2,}\s*Original Message\s*-{2,}|^From: .{1,200}\nSent: /im;

/**
 * Cleans body text: keeps a forwarded email's original content (that's the part that matters),
 * cuts quoted replies, collapses whitespace, and caps the size.
 */
export function cleanBodyText(raw: string): { text: string; isForward: boolean } {
  let text = raw.slice(0, MAX_TEXT_CHARS * 2).replace(/\r\n?/g, '\n');
  const forward = FORWARD_MARKER.exec(text);
  const isForward = !!forward;
  if (forward) text = text.slice(forward.index + forward[0].length);
  const reply = REPLY_MARKER.exec(text);
  if (reply && reply.index > 0) text = text.slice(0, reply.index);
  text = text
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n')
    .replace(/[ \t\u00a0\u202f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, MAX_TEXT_CHARS), isForward };
}

/** Minimal iCalendar reader: first VEVENT's start/end/summary/organizer/location. */
export function parseCalendar(ics: string): CalendarEvent | null {
  const unfolded = ics.slice(0, 200_000).replace(/\r?\n[ \t]/g, '');
  const event = /BEGIN:VEVENT([\s\S]{0,50000}?)END:VEVENT/.exec(unfolded)?.[1];
  if (!event) return null;
  const field = (name: string) => new RegExp(`^${name}((?:;[^:\\n]{0,200})?):([^\\n]{0,1000})$`, 'm').exec(event);
  const date = (name: string): Date | null => {
    const m = field(name);
    return m ? parseIcsDate(m[2]!.trim(), /TZID=([^;:]{1,64})/.exec(m[1]!)?.[1] ?? null) : null;
  };
  const text = (name: string) => field(name)?.[2]?.replace(/\\n/g, ' ').replace(/\\([,;\\])/g, '$1').trim() || null;
  const organizer = field('ORGANIZER')?.[2] ?? '';
  const organizerDomain = /@([a-z0-9.-]{1,190})/i.exec(organizer)?.[1]?.toLowerCase() ?? null;
  return { start: date('DTSTART'), end: date('DTEND'), summary: text('SUMMARY'), organizerDomain, location: text('LOCATION') };
}

function parseIcsDate(value: string, tzid: string | null): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  if (z) return new Date(Date.UTC(...parts));
  return zonedTimeToUtc(parts, tzid ?? 'Asia/Kolkata');
}

/** Minutes east of UTC for a time zone at a given instant (e.g. 330 for Asia/Kolkata). */
export function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return 330; // unknown zone: default to India
  }
}

function zonedTimeToUtc(parts: readonly [number, number, number, number, number, number], timeZone: string): Date {
  const guess = new Date(Date.UTC(...parts));
  return new Date(guess.getTime() - timeZoneOffsetMinutes(timeZone, guess) * 60_000);
}
