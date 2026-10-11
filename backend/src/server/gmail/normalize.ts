import {
  cleanBodyText,
  extractHtmlLinks,
  extractTextLinks,
  htmlToText,
  parseAddress,
  parseCalendar,
} from '../email/normalize';
import type { NormalizedEmail } from '../email/types';

/** Gmail API `Message` resource (only the fields we use). */
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

const MAX_PARTS = 50;

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Flattens the MIME tree (depth-first), capped at MAX_PARTS. */
function flattenParts(root: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  const stack = root ? [root] : [];
  while (stack.length && out.length < MAX_PARTS) {
    const part = stack.shift()!;
    out.push(part);
    if (part.parts) stack.unshift(...part.parts);
  }
  return out;
}

export function normalizeGmailMessage(message: GmailMessage, detail: 'headers' | 'full'): NormalizedEmail {
  const headers = new Map<string, string>();
  for (const h of message.payload?.headers ?? []) {
    const name = h.name.toLowerCase();
    if (!headers.has(name)) headers.set(name, h.value.slice(0, 2000));
  }
  const precedence = headers.get('precedence')?.toLowerCase() ?? '';

  const email: NormalizedEmail = {
    id: message.id,
    threadId: message.threadId ?? null,
    internalDate: new Date(Number(message.internalDate ?? 0)),
    labelIds: message.labelIds ?? [],
    detail,
    from: parseAddress(headers.get('from')),
    replyTo: parseAddress(headers.get('reply-to')),
    subject: (headers.get('subject') ?? '').trim(),
    snippet: decodeSnippet(message.snippet ?? ''),
    messageIdHeader: headers.get('message-id') ?? null,
    bulk: headers.has('list-unsubscribe') || headers.has('list-id') || precedence === 'bulk' || precedence === 'list',
    text: '',
    links: [],
    calendar: null,
    attachmentNames: [],
    isForward: false,
  };
  if (detail === 'headers') return email;

  let plain = '';
  let html = '';
  for (const part of flattenParts(message.payload)) {
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.filename) email.attachmentNames.push(part.filename.slice(0, 200));
    const data = part.body?.data;
    if (!data) continue;
    if (mime === 'text/plain' && !part.filename && !plain) plain = decodeBase64Url(data);
    else if (mime === 'text/html' && !part.filename && !html) html = decodeBase64Url(data);
    else if (mime === 'text/calendar' && !email.calendar) email.calendar = parseCalendar(decodeBase64Url(data));
  }

  const body = plain || (html ? htmlToText(html) : '');
  const cleaned = cleanBodyText(body);
  email.text = cleaned.text;
  email.isForward = cleaned.isForward;
  email.links = html ? extractHtmlLinks(html) : extractTextLinks(plain);
  return email;
}

function decodeSnippet(snippet: string): string {
  return snippet.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Headers to request with format=metadata (triage needs these and nothing else). */
export const TRIAGE_HEADERS = ['From', 'Reply-To', 'Subject', 'Message-ID', 'List-Unsubscribe', 'List-Id', 'Precedence'];
