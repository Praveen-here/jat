/**
 * Application status as a projection of its event history (docs/plan §9).
 * Events are sorted by EMAIL date, not processing order, so the result is the same however
 * the emails arrived. Every status points back to the event (and email) that set it.
 *
 * Two levels: a broad stage for filtering (APPLIED, ASSESSMENT, INTERVIEW…) and a plain-English
 * detail of where things actually stand ("Shortlisted for interview", "Assessment completed").
 */
export const APP_STATUSES = ['DETECTED', 'APPLIED', 'ASSESSMENT', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** How far along each stage is; terminal stages sit outside this order. */
const RANK: Record<AppStatus, number> = { DETECTED: 0, APPLIED: 1, ASSESSMENT: 2, SHORTLISTED: 3, INTERVIEW: 4, OFFER: 5, REJECTED: 9, WITHDRAWN: 9 };

/** The stage each event belongs to. */
const STAGE_OF: Record<string, AppStatus> = {
  APPLICATION_RECEIVED: 'APPLIED',
  ASSESSMENT_INVITE: 'ASSESSMENT',
  ASSESSMENT_REMINDER: 'ASSESSMENT',
  ASSESSMENT_COMPLETED: 'ASSESSMENT',
  SHORTLISTED: 'SHORTLISTED',
  INTERVIEW_INVITE: 'INTERVIEW',
  INTERVIEW_RESCHEDULED: 'INTERVIEW',
  INTERVIEW_CANCELLED: 'INTERVIEW',
  OFFER: 'OFFER',
  REJECTION: 'REJECTED',
  WITHDRAWAL_CONFIRMATION: 'WITHDRAWN',
};

/**
 * Events that start a stage. The others (reminders, reschedules, completions) refine the current
 * stage, and only move an application forward, never back: a late reminder isn't a regression.
 */
const STAGE_STARTERS = new Set(['APPLICATION_RECEIVED', 'ASSESSMENT_INVITE', 'SHORTLISTED', 'INTERVIEW_INVITE', 'OFFER', 'REJECTION', 'WITHDRAWAL_CONFIRMATION']);

export const TERMINAL: ReadonlySet<AppStatus> = new Set(['REJECTED', 'WITHDRAWN']);

export interface ProjectableEvent {
  id: string;
  eventType: string;
  occurredAt: Date;
  scheduledAt: Date | null;
  deadlineAt: Date | null;
  /** Probable matches: shown, but don't change the status until the user confirms. */
  pending: boolean;
  /** For SHORTLISTED: 'assessment' | 'interview' when known. */
  detail?: string | null;
}

export interface Projection {
  status: AppStatus;
  /** Plain-English current state, e.g. "Shortlisted for assessment". */
  statusDetail: string;
  statusEventId: string | null;
  /** E.g. an interview invite after a rejection: maybe reopened, maybe a wrong match. */
  conflict: boolean;
  appliedAt: Date | null;
  firstSeenAt: Date;
  lastActivityAt: Date;
  /** Next upcoming interview or assessment deadline, if any. */
  nextEventAt: Date | null;
  terminalAt: Date | null;
}

function describe(event: ProjectableEvent, stageBefore: AppStatus): string {
  switch (event.eventType) {
    case 'APPLICATION_RECEIVED':
      return 'Applied';
    case 'ASSESSMENT_INVITE':
      return 'Assessment invited';
    case 'ASSESSMENT_REMINDER':
      return 'Assessment pending';
    case 'ASSESSMENT_COMPLETED':
      return 'Assessment completed';
    case 'SHORTLISTED':
      return event.detail === 'assessment' ? 'Shortlisted for assessment' : event.detail === 'interview' ? 'Shortlisted for interview' : 'Shortlisted';
    case 'INTERVIEW_INVITE':
      return 'Interview scheduled';
    case 'INTERVIEW_RESCHEDULED':
      return 'Interview rescheduled';
    case 'INTERVIEW_CANCELLED':
      return 'Interview cancelled';
    case 'OFFER':
      return 'Offer received';
    case 'REJECTION':
      return stageBefore === 'INTERVIEW' ? 'Rejected after interview' : stageBefore === 'ASSESSMENT' ? 'Rejected after assessment' : stageBefore === 'SHORTLISTED' ? 'Rejected after shortlist' : 'Rejected';
    case 'WITHDRAWAL_CONFIRMATION':
      return 'Withdrawn';
    case 'INFO_REQUEST':
      return 'Documents requested';
    default:
      return 'In progress';
  }
}

const DEFAULT_DETAIL: Record<AppStatus, string> = {
  DETECTED: 'In progress',
  APPLIED: 'Applied',
  ASSESSMENT: 'Assessment invited',
  SHORTLISTED: 'Shortlisted',
  INTERVIEW: 'Interview scheduled',
  OFFER: 'Offer received',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export function project(events: ProjectableEvent[], now: Date = new Date()): Projection {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const active = ordered.filter((e) => !e.pending);

  let status: AppStatus = 'DETECTED';
  let statusDetail = DEFAULT_DETAIL.DETECTED;
  let statusEventId: string | null = null;
  let conflict = false;
  let terminalAt: Date | null = null;
  let interviewAt: Date | null = null;
  let deadline: Date | null = null;

  for (const event of active) {
    const stage = STAGE_OF[event.eventType];
    if (stage && STAGE_STARTERS.has(event.eventType)) {
      if (TERMINAL.has(status) && !TERMINAL.has(stage)) conflict = true;
      statusDetail = describe(event, status);
      status = stage;
      statusEventId = event.id;
      terminalAt = TERMINAL.has(stage) ? event.occurredAt : null;
    } else if (stage && !TERMINAL.has(status)) {
      // Refinements: update the detail within the same stage, or move forward if this is the
      // first sign of a later stage (e.g. "assessment completed" with no invite seen).
      if (stage === status || RANK[stage] > RANK[status]) {
        status = stage;
        statusDetail = describe(event, status);
        statusEventId = event.id;
      }
    } else if (event.eventType === 'INFO_REQUEST' && !TERMINAL.has(status)) {
      statusDetail = describe(event, status);
      if (status === 'DETECTED') statusEventId = event.id;
    }

    // Upcoming dates: a reschedule replaces the interview time, a cancellation clears it,
    // completing an assessment clears its deadline.
    if (event.eventType === 'INTERVIEW_INVITE' || event.eventType === 'INTERVIEW_RESCHEDULED') {
      interviewAt = event.scheduledAt ?? interviewAt;
    } else if (event.eventType === 'INTERVIEW_CANCELLED') {
      interviewAt = null;
    }
    if (event.eventType === 'ASSESSMENT_INVITE' || event.eventType === 'ASSESSMENT_REMINDER' || event.eventType === 'SHORTLISTED') {
      deadline = event.deadlineAt ?? event.scheduledAt ?? deadline;
    } else if (event.eventType === 'ASSESSMENT_COMPLETED') {
      deadline = null;
    }
  }

  const upcoming = [interviewAt, deadline].filter((d): d is Date => !!d && d.getTime() > now.getTime() && !TERMINAL.has(status));
  const applied = active.find((e) => e.eventType === 'APPLICATION_RECEIVED');
  return {
    status,
    statusDetail,
    statusEventId,
    conflict,
    appliedAt: applied?.occurredAt ?? null,
    firstSeenAt: ordered[0]?.occurredAt ?? now,
    lastActivityAt: ordered.at(-1)?.occurredAt ?? now,
    nextEventAt: upcoming.length ? new Date(Math.min(...upcoming.map((d) => d.getTime()))) : null,
    terminalAt,
  };
}
