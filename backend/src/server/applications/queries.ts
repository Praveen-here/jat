import { sql, type Kysely } from 'kysely';
import { contentAad, openText } from '../crypto/content';
import type { Database } from '../db/pool';

/** Read models for the app. Every query is scoped to the signed-in user. */
export interface ApplicationSummary {
  id: string;
  company: string | null;
  role: string | null;
  employmentType: string;
  platform: string | null;
  origin: 'auto' | 'inferred';
  status: string;
  /** Plain-English state, e.g. "Shortlisted for assessment". */
  statusDetail: string | null;
  statusConflict: boolean;
  needsReview: boolean;
  appliedAt: Date | null;
  firstSeenAt: Date;
  lastActivityAt: Date;
  nextEventAt: Date | null;
  emailCount: number;
}

export async function listApplications(
  db: Kysely<Database>,
  userId: string,
  view: 'all' | 'review',
): Promise<{ items: ApplicationSummary[]; counts: { all: number; review: number; byStatus: Record<string, number> } }> {
  const [rows, statusCounts] = await Promise.all([
    db
      .selectFrom('applications as a')
      .leftJoin('message_application_links as l', 'l.application_id', 'a.id')
      .select([
        'a.id', 'a.company_display', 'a.role_title', 'a.employment_type', 'a.platform', 'a.origin', 'a.status', 'a.status_detail', 'a.status_conflict',
        'a.needs_review', 'a.applied_at', 'a.first_seen_at', 'a.last_activity_at', 'a.next_event_at',
        (eb) => eb.fn.count<string>('l.source_message_id').as('email_count'),
      ])
      .where('a.user_id', '=', userId)
      .$if(view === 'review', (qb) => qb.where('a.needs_review', '=', true))
      .groupBy('a.id')
      .orderBy('a.last_activity_at', 'desc')
      .limit(500)
      .execute(),
    db
      .selectFrom('applications')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n'), sql<string>`count(*) filter (where needs_review)`.as('review')])
      .where('user_id', '=', userId)
      .groupBy('status')
      .execute(),
  ]);

  const byStatus: Record<string, number> = {};
  let all = 0;
  let review = 0;
  for (const s of statusCounts) {
    byStatus[s.status] = Number(s.n);
    all += Number(s.n);
    review += Number(s.review);
  }
  return {
    counts: { all, review, byStatus },
    items: rows.map((r) => ({
      id: r.id,
      company: r.company_display,
      role: r.role_title,
      employmentType: r.employment_type,
      platform: r.platform,
      origin: r.origin,
      status: r.status,
      statusDetail: r.status_detail,
      statusConflict: r.status_conflict,
      needsReview: r.needs_review,
      appliedAt: r.applied_at,
      firstSeenAt: r.first_seen_at,
      lastActivityAt: r.last_activity_at,
      nextEventAt: r.next_event_at,
      emailCount: Number(r.email_count),
    })),
  };
}

export interface TimelineEntry {
  id: string;
  type: string;
  occurredAt: Date;
  scheduledAt: Date | null;
  deadlineAt: Date | null;
  pending: boolean;
  /** For shortlists: what for. */
  detail: string | null;
  decision: string | null;
  account: string | null;
  subject: string | null;
  sender: { name: string | null; address: string } | null;
  gmailUrl: string | null;
}

function decrypt(key: Buffer, sealed: Buffer | null, rowId: string, field: 'subject' | 'sender'): string | null {
  if (!sealed) return null;
  try {
    return openText(key, sealed, contentAad(rowId, field));
  } catch {
    return null;
  }
}

/** One application with its timeline: every email linked to it, oldest first. */
export async function getApplication(
  db: Kysely<Database>,
  contentKey: Buffer,
  userId: string,
  applicationId: string,
): Promise<{ application: ApplicationSummary; timeline: TimelineEntry[] } | null> {
  const app = await db.selectFrom('applications').selectAll().where('id', '=', applicationId).where('user_id', '=', userId).executeTakeFirst();
  if (!app) return null;

  // Every linked email, with its event if it created one (some only confirm an existing event).
  const rows = await db
    .selectFrom('message_application_links as l')
    .innerJoin('source_messages as s', 's.id', 'l.source_message_id')
    .innerJoin('mail_accounts as m', 'm.id', 's.mail_account_id')
    .innerJoin('message_classifications as c', (j) => j.onRef('c.source_message_id', '=', 's.id').on('c.is_current', '=', true))
    .leftJoin('application_events as e', 'e.source_message_id', 's.id')
    .select([
      's.id', 's.provider_message_id', 's.internal_date', 's.subject_enc', 's.sender_enc', 'm.address', 'c.category', 'l.decision',
      'e.scheduled_at', 'e.deadline_at', 'e.pending', 'e.detail',
    ])
    .where('l.application_id', '=', applicationId)
    .where('l.user_id', '=', userId)
    .orderBy('s.internal_date', 'asc')
    .execute();

  const timeline: TimelineEntry[] = rows.map((r) => {
    const sender = decrypt(contentKey, r.sender_enc, r.id, 'sender');
    return {
      id: r.id,
      type: r.category,
      occurredAt: r.internal_date ?? new Date(0),
      scheduledAt: r.scheduled_at,
      deadlineAt: r.deadline_at,
      pending: r.pending ?? false,
      detail: r.detail,
      decision: r.decision,
      account: r.address,
      subject: decrypt(contentKey, r.subject_enc, r.id, 'subject'),
      sender: sender ? (JSON.parse(sender) as TimelineEntry['sender']) : null,
      gmailUrl: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(r.address)}#all/${encodeURIComponent(r.provider_message_id)}`,
    };
  });

  return {
    application: {
      id: app.id,
      company: app.company_display,
      role: app.role_title,
      employmentType: app.employment_type,
      platform: app.platform,
      origin: app.origin,
      status: app.status,
      statusDetail: app.status_detail,
      statusConflict: app.status_conflict,
      needsReview: app.needs_review,
      appliedAt: app.applied_at,
      firstSeenAt: app.first_seen_at,
      lastActivityAt: app.last_activity_at,
      nextEventAt: app.next_event_at,
      emailCount: rows.length,
    },
    timeline,
  };
}
