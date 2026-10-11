/**
 * Provider-neutral view of one email, as the classifier sees it. Exists only in worker memory
 * during processing; never stored. Built by gmail/normalize.ts (real) or tests/corpus (fake).
 */
export interface EmailAddress {
  address: string;
  name: string | null;
  domain: string;
}

export interface CalendarEvent {
  start: Date | null;
  end: Date | null;
  summary: string | null;
  organizerDomain: string | null;
  location: string | null;
}

export interface NormalizedEmail {
  id: string;
  threadId: string | null;
  internalDate: Date;
  labelIds: string[];
  /** 'headers' = metadata only (triage); 'full' = body included. */
  detail: 'headers' | 'full';
  from: EmailAddress | null;
  replyTo: EmailAddress | null;
  subject: string;
  snippet: string;
  messageIdHeader: string | null;
  /** Bulk-mail signals: List-Unsubscribe, List-Id, Precedence: bulk/list. */
  bulk: boolean;
  /** Cleaned plain text: quotes and signatures trimmed, capped in size. Empty for 'headers'. */
  text: string;
  /** Links with tracking redirects unwrapped. Never fetched. */
  links: Array<{ href: string; text: string }>;
  calendar: CalendarEvent | null;
  attachmentNames: string[];
  isForward: boolean;
}
