import { Archive, BadgeCheck, CircleDashed, FileCode, ListChecks, MessagesSquare, Send, Undo2, XCircle, type LucideIcon } from 'lucide-react';

/** Application status pills: pastel palette + icon + text (never colour alone). */
export const STATUS: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  DETECTED: { label: 'Detected', icon: CircleDashed, className: 'bg-status-detected-bg text-status-detected-ink' },
  APPLIED: { label: 'Applied', icon: Send, className: 'bg-status-applied-bg text-status-applied-ink' },
  ASSESSMENT: { label: 'Assessment', icon: FileCode, className: 'bg-status-assessment-bg text-status-assessment-ink' },
  SHORTLISTED: { label: 'Shortlisted', icon: ListChecks, className: 'bg-status-shortlisted-bg text-status-shortlisted-ink' },
  INTERVIEW: { label: 'Interview', icon: MessagesSquare, className: 'bg-status-interview-bg text-status-interview-ink' },
  OFFER: { label: 'Offer', icon: BadgeCheck, className: 'bg-status-offer-bg text-status-offer-ink' },
  REJECTED: { label: 'Rejected', icon: XCircle, className: 'bg-status-rejected-bg text-status-rejected-ink' },
  WITHDRAWN: { label: 'Withdrawn', icon: Undo2, className: 'bg-status-withdrawn-bg text-status-withdrawn-ink' },
  CLOSED: { label: 'Closed', icon: Archive, className: 'bg-status-detected-bg text-status-detected-ink' },
};

/** Stage colour + icon, with the plain-English detail ("Shortlisted for assessment") as the text. */
export function StatusPill({ status, detail }: { status: string; detail?: string | null }) {
  const s = STATUS[status] ?? STATUS.DETECTED!;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap ${s.className}`}>
      <Icon aria-hidden className="h-3 w-3" strokeWidth={2} />
      {detail || s.label}
    </span>
  );
}

/** What one email meant, for the timeline ("Shortlisted for interview"). */
export function eventLabel(type: string, detail?: string | null): string {
  if (type === 'SHORTLISTED' && detail === 'assessment') return 'Shortlisted for assessment';
  if (type === 'SHORTLISTED' && detail === 'interview') return 'Shortlisted for interview';
  return EVENT_LABEL[type] ?? type;
}

const dateOnlyFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * Formats an interview/test time. Dates the email gave without a time are stored as 00:00 IST
 * and shown as just the date, never as "12:00 am".
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const ist = new Date(date.getTime() + 330 * 60_000);
  const midnight = ist.getUTCHours() === 0 && ist.getUTCMinutes() === 0;
  return midnight ? dateOnlyFormat.format(date) : dateTimeFormat.format(date);
}

/** What each email meant, for timelines. */
export const EVENT_LABEL: Record<string, string> = {
  APPLICATION_RECEIVED: 'Application received',
  ASSESSMENT_INVITE: 'Assessment invitation',
  ASSESSMENT_REMINDER: 'Assessment reminder',
  ASSESSMENT_COMPLETED: 'Assessment completed',
  INTERVIEW_INVITE: 'Interview invitation',
  INTERVIEW_RESCHEDULED: 'Interview rescheduled',
  INTERVIEW_CANCELLED: 'Interview cancelled',
  SHORTLISTED: 'Shortlisted',
  OFFER: 'Offer',
  REJECTION: 'Rejection',
  INFO_REQUEST: 'Information requested',
  WITHDRAWAL_CONFIRMATION: 'Application withdrawn',
};

export const TYPE_LABEL: Record<string, string> = { internship: 'Internship', full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract' };

export const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
export const longDateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const dateTimeFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** No news for this long on an open application: probably ghosted (a derived flag, not a status). */
export const STALE_DAYS = 45;
export function staleDays(lastActivityAt: string, status: string, now = Date.now()): number | null {
  if (['REJECTED', 'WITHDRAWN', 'OFFER', 'CLOSED'].includes(status)) return null;
  const days = Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000);
  return days >= STALE_DAYS ? days : null;
}
