/** Email categories (docs/plan §7.5). */
export const CATEGORIES = [
  'APPLICATION_RECEIVED',
  'ASSESSMENT_INVITE',
  'ASSESSMENT_REMINDER',
  'ASSESSMENT_COMPLETED',
  'INTERVIEW_INVITE',
  'INTERVIEW_RESCHEDULED',
  'INTERVIEW_CANCELLED',
  'SHORTLISTED',
  'OFFER',
  'REJECTION',
  'INFO_REQUEST',
  'WITHDRAWAL_CONFIRMATION',
  'RECRUITER_OUTREACH',
  'JOB_ALERT',
  'NEWSLETTER_MARKETING',
  'UNRELATED',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Emails about one of the user's own applications: these become timeline events. */
export const LIFECYCLE_CATEGORIES: ReadonlySet<Category> = new Set([
  'APPLICATION_RECEIVED',
  'ASSESSMENT_INVITE',
  'ASSESSMENT_REMINDER',
  'ASSESSMENT_COMPLETED',
  'INTERVIEW_INVITE',
  'INTERVIEW_RESCHEDULED',
  'INTERVIEW_CANCELLED',
  'SHORTLISTED',
  'OFFER',
  'REJECTION',
  'INFO_REQUEST',
  'WITHDRAWAL_CONFIRMATION',
]);

/** Kept (with minimal fields) for the user to see; everything else is dropped. */
export function isRelevant(category: Category): boolean {
  return LIFECYCLE_CATEGORIES.has(category) || category === 'RECRUITER_OUTREACH';
}

export const CATEGORY_LABELS: Record<Category, string> = {
  APPLICATION_RECEIVED: 'Application received',
  ASSESSMENT_INVITE: 'Assessment invite',
  ASSESSMENT_REMINDER: 'Assessment reminder',
  ASSESSMENT_COMPLETED: 'Assessment completed',
  INTERVIEW_INVITE: 'Interview invite',
  INTERVIEW_RESCHEDULED: 'Interview rescheduled',
  INTERVIEW_CANCELLED: 'Interview cancelled',
  SHORTLISTED: 'Shortlisted',
  OFFER: 'Offer',
  REJECTION: 'Rejection',
  INFO_REQUEST: 'Information requested',
  WITHDRAWAL_CONFIRMATION: 'Withdrawn',
  RECRUITER_OUTREACH: 'Recruiter outreach',
  JOB_ALERT: 'Job alert',
  NEWSLETTER_MARKETING: 'Newsletter',
  UNRELATED: 'Unrelated',
};
