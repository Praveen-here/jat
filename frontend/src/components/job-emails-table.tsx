import { AlertCircle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { JobEmail } from '@/lib/session';

/** Category → label and pastel pill (docs/plan/05-frontend.md §12.0). Text label always shown. */
const CATEGORY: Record<string, { label: string; className: string }> = {
  APPLICATION_RECEIVED: { label: 'Applied', className: 'bg-status-applied-bg text-status-applied-ink' },
  ASSESSMENT_INVITE: { label: 'Assessment', className: 'bg-status-assessment-bg text-status-assessment-ink' },
  ASSESSMENT_REMINDER: { label: 'Assessment reminder', className: 'bg-status-assessment-bg text-status-assessment-ink' },
  ASSESSMENT_COMPLETED: { label: 'Assessment done', className: 'bg-status-assessment-bg text-status-assessment-ink' },
  INTERVIEW_INVITE: { label: 'Interview', className: 'bg-status-interview-bg text-status-interview-ink' },
  INTERVIEW_RESCHEDULED: { label: 'Interview moved', className: 'bg-status-interview-bg text-status-interview-ink' },
  INTERVIEW_CANCELLED: { label: 'Interview cancelled', className: 'bg-status-interview-bg text-status-interview-ink' },
  SHORTLISTED: { label: 'Shortlisted', className: 'bg-status-shortlisted-bg text-status-shortlisted-ink' },
  OFFER: { label: 'Offer', className: 'bg-status-offer-bg text-status-offer-ink' },
  REJECTION: { label: 'Rejected', className: 'bg-status-rejected-bg text-status-rejected-ink' },
  INFO_REQUEST: { label: 'Info requested', className: 'bg-status-review-bg text-status-review-ink' },
  WITHDRAWAL_CONFIRMATION: { label: 'Withdrawn', className: 'bg-status-withdrawn-bg text-status-withdrawn-ink' },
  RECRUITER_OUTREACH: { label: 'Recruiter', className: 'bg-status-detected-bg text-status-detected-ink' },
};

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

const TYPE_LABEL: Record<string, string> = { internship: 'Internship', full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract' };

export function JobEmailsTable({
  items,
  counts,
  view,
}: {
  items: JobEmail[];
  counts: { all: number; review: number };
  view: 'all' | 'review';
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-semibold">Job emails found</h2>
        <nav aria-label="Filter" className="flex gap-1 rounded-lg bg-surface-muted p-0.5 text-[13px]">
          {(['all', 'review'] as const).map((v) => (
            <Link
              key={v}
              href={v === 'all' ? '/app' : '/app?view=review'}
              aria-current={view === v ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1 font-semibold ${view === v ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-secondary hover:text-ink'}`}
            >
              {v === 'all' ? `All (${counts.all})` : `Needs review (${counts.review})`}
            </Link>
          ))}
        </nav>
      </div>
      <p className="mt-1 text-[13px] text-ink-secondary">
        Sorted newest first. Grouping these into one card per application arrives in the next build step.
      </p>

      {items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-line bg-surface px-4 py-8 text-center text-[13px] text-ink-secondary">
          {view === 'review' ? 'Nothing needs your review.' : 'No job emails found yet. They’ll appear here as your inbox syncs.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-ink-tertiary">
                <th scope="col" className="px-3 py-2 font-semibold">Date</th>
                <th scope="col" className="px-3 py-2 font-semibold">Company</th>
                <th scope="col" className="px-3 py-2 font-semibold">Role</th>
                <th scope="col" className="px-3 py-2 font-semibold">Type</th>
                <th scope="col" className="px-3 py-2 font-semibold">When</th>
                <th scope="col" className="px-3 py-2 font-semibold">Source</th>
                <th scope="col" className="px-3 py-2 font-semibold"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const category = CATEGORY[item.category] ?? { label: item.category, className: 'bg-status-detected-bg text-status-detected-ink' };
                const when = item.eventAt ?? item.deadlineAt;
                return (
                  <tr key={item.id} className="border-b border-line align-top last:border-0 hover:bg-surface-muted/60">
                    <td className="px-3 py-2.5 whitespace-nowrap text-ink-secondary">{dateFormat.format(new Date(item.receivedAt))}</td>
                    <td className="px-3 py-2.5">
                      <p className="font-semibold">{item.company ?? <span className="text-ink-tertiary">Unknown</span>}</p>
                      {item.subject && <p className="mt-0.5 line-clamp-1 max-w-[260px] text-[12px] text-ink-tertiary" title={item.subject}>{item.subject}</p>}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.role ?? <span className="text-ink-tertiary">—</span>}
                      {TYPE_LABEL[item.employmentType] && <span className="ml-1.5 text-[12px] text-ink-tertiary">{TYPE_LABEL[item.employmentType]}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap ${category.className}`}>{category.label}</span>
                        {item.needsReview && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-status-review-bg px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap text-status-review-ink">
                            <AlertCircle aria-hidden className="h-3 w-3" />
                            Check
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-ink-secondary">
                      {when ? (
                        <>
                          {item.deadlineAt && !item.eventAt ? 'Due ' : ''}
                          {dateTimeFormat.format(new Date(when))}
                        </>
                      ) : (
                        <span className="text-ink-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-secondary">
                      <p>{item.platform ?? '—'}</p>
                      <p className="text-ink-tertiary">{item.account}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <a
                        href={item.gmailUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-semibold whitespace-nowrap text-accent hover:bg-accent-soft"
                      >
                        Gmail <ExternalLink aria-hidden className="h-3 w-3" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
