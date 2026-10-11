import type { Kysely } from 'kysely';
import { contentAad, openText } from '../crypto/content';
import type { Database } from '../db/pool';

/** A detected job email as shown in the app (before emails are grouped into applications). */
export interface JobEmail {
  id: string;
  receivedAt: Date;
  account: string;
  category: string;
  confidence: number;
  needsReview: boolean;
  company: string | null;
  role: string | null;
  employmentType: string;
  platform: string | null;
  eventAt: Date | null;
  deadlineAt: Date | null;
  subject: string | null;
  sender: { name: string | null; address: string } | null;
  snippet: string | null;
  gmailUrl: string;
}

function decrypt(key: Buffer, sealed: Buffer | null, rowId: string, field: 'subject' | 'sender' | 'snippet'): string | null {
  if (!sealed) return null;
  try {
    return openText(key, sealed, contentAad(rowId, field));
  } catch {
    return null; // undecryptable (e.g. key rotated): show the row without it
  }
}

export async function listJobEmails(
  db: Kysely<Database>,
  contentKey: Buffer,
  userId: string,
  options: { view: 'all' | 'review'; limit?: number },
): Promise<{ items: JobEmail[]; counts: { all: number; review: number } }> {
  const base = db
    .selectFrom('source_messages as s')
    .innerJoin('mail_accounts as a', 'a.id', 's.mail_account_id')
    .innerJoin('message_classifications as c', (join) => join.onRef('c.source_message_id', '=', 's.id').on('c.is_current', '=', true))
    .leftJoin('message_extractions as e', (join) => join.onRef('e.source_message_id', '=', 's.id').on('e.is_current', '=', true))
    .where('s.user_id', '=', userId)
    .where('s.state', 'in', ['awaiting_match', 'matched']);

  const [rows, counts] = await Promise.all([
    base
      .select([
        's.id',
        's.provider_message_id',
        's.internal_date',
        's.subject_enc',
        's.sender_enc',
        's.snippet_enc',
        'a.address',
        'c.category',
        'c.confidence',
        'c.needs_review',
        'e.company_display',
        'e.role_title',
        'e.employment_type',
        'e.platform',
        'e.event_at',
        'e.deadline_at',
      ])
      .$if(options.view === 'review', (qb) => qb.where('c.needs_review', '=', true))
      .orderBy('s.internal_date', 'desc')
      .limit(options.limit ?? 200)
      .execute(),
    base
      .select((eb) => [
        eb.fn.countAll<string>().as('all'),
        eb.fn.count<string>('c.id').filterWhere('c.needs_review', '=', true).as('review'),
      ])
      .executeTakeFirstOrThrow(),
  ]);

  return {
    counts: { all: Number(counts.all), review: Number(counts.review) },
    items: rows.map((r) => {
      const sender = decrypt(contentKey, r.sender_enc, r.id, 'sender');
      return {
        id: r.id,
        receivedAt: r.internal_date ?? new Date(0),
        account: r.address,
        category: r.category,
        confidence: r.confidence,
        needsReview: r.needs_review,
        company: r.company_display,
        role: r.role_title,
        employmentType: r.employment_type ?? 'unknown',
        platform: r.platform,
        eventAt: r.event_at,
        deadlineAt: r.deadline_at,
        subject: decrypt(contentKey, r.subject_enc, r.id, 'subject'),
        sender: sender ? (JSON.parse(sender) as JobEmail['sender']) : null,
        snippet: decrypt(contentKey, r.snippet_enc, r.id, 'snippet'),
        // Opens the email in the right Gmail account (Gmail web accepts API message ids here).
        gmailUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(r.address)}#all/${encodeURIComponent(r.provider_message_id)}`,
      };
    }),
  };
}
