import { AlertCircle, ArrowLeft, CalendarClock, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { dateTimeFormat, eventLabel, formatWhen, longDateFormat, StatusPill, staleDays, TYPE_LABEL } from '@/components/status';
import { getApplication, getCurrentUser } from '@/lib/session';

export const metadata = { title: 'Application · Job Tracker' };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/');
  const result = await getApplication((await params).id);
  if (!result) notFound();
  const { application: app, timeline } = result;
  const stale = staleDays(app.lastActivityAt, app.status);

  const properties: Array<[string, React.ReactNode]> = [
    ['Status', <StatusPill key="s" status={app.status} detail={app.statusDetail} />],
    ['Role', app.role ?? <span className="text-ink-tertiary">Unknown</span>],
    ['Type', TYPE_LABEL[app.employmentType] ?? <span className="text-ink-tertiary">Unknown</span>],
    ['Applied', app.appliedAt ? longDateFormat.format(new Date(app.appliedAt)) : <span className="text-ink-tertiary">Confirmation email not found</span>],
    ['Last activity', longDateFormat.format(new Date(app.lastActivityAt))],
    ['Next', app.nextEventAt ? formatWhen(app.nextEventAt) : <span className="text-ink-tertiary">—</span>],
    ['Platform', app.platform ?? <span className="text-ink-tertiary">—</span>],
  ];

  return (
    <AppShell user={user} current="applications">
      <Link href="/app" className="inline-flex items-center gap-1 text-[13px] text-ink-secondary hover:text-ink">
        <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> Applications
      </Link>
      <h1 className="mt-3 text-[28px] font-bold tracking-tight">{app.company ?? 'Unknown company'}</h1>
      {app.role && <p className="mt-0.5 text-[15px] text-ink-secondary">{app.role}</p>}

      {(app.needsReview || app.statusConflict || stale) && (
        <div role="status" className="mt-5 space-y-1 rounded-lg bg-status-review-bg px-3 py-2 text-[13px] text-status-review-ink">
          {app.statusConflict && (
            <p className="flex items-start gap-1.5">
              <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Emails disagree: something arrived after a rejection or withdrawal. It may be a different application.
            </p>
          )}
          {timeline.some((e) => e.pending) && (
            <p className="flex items-start gap-1.5">
              <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Some emails are only possibly part of this application, so they don’t change its status yet.
            </p>
          )}
          {!app.company && <p>The company couldn’t be identified from the emails.</p>}
          {app.needsReview && !app.statusConflict && app.company && !timeline.some((e) => e.pending) && <p>Please check this application. One of its emails was hard to read (offers are always checked).</p>}
          {stale && <p>No news for {stale} days. You may want to follow up.</p>}
        </div>
      )}

      {/* Notion-style properties list */}
      <dl className="mt-6 grid max-w-xl grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
        {properties.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-tertiary">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-10 text-[16px] font-semibold">Timeline</h2>
      <ol className="mt-4 border-l border-line">
        {timeline.map((entry) => (
          <li key={entry.id} className="relative pb-5 pl-5 last:pb-0">
            <span aria-hidden className={`absolute top-1.5 -left-[4.5px] h-2 w-2 rounded-full ${entry.pending ? 'border border-ink-tertiary bg-surface' : 'bg-accent'}`} />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="text-[14px] font-semibold">{eventLabel(entry.type, entry.detail)}</p>
              <p className="text-[12px] text-ink-tertiary">{dateTimeFormat.format(new Date(entry.occurredAt))}</p>
              {entry.pending && <span className="text-[12px] font-semibold text-status-review-ink">Possibly related, not counted yet</span>}
            </div>
            {(entry.scheduledAt || entry.deadlineAt) && (
              <p className="mt-1 inline-flex items-center gap-1 text-[13px]">
                <CalendarClock aria-hidden className="h-3.5 w-3.5 text-accent" />
                {entry.scheduledAt ? `Scheduled ${formatWhen(entry.scheduledAt)}` : `Due ${formatWhen(entry.deadlineAt!)}`}
              </p>
            )}
            {entry.subject && <p className="mt-1 text-[13px] text-ink-secondary">“{entry.subject}”</p>}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-tertiary">
              {entry.sender && <span>from {entry.sender.name ? `${entry.sender.name} · ` : ''}{entry.sender.address}</span>}
              {entry.account && <span>in {entry.account}</span>}
              {entry.gmailUrl && (
                <a href={entry.gmailUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                  Open in Gmail <ExternalLink aria-hidden className="h-3 w-3" />
                </a>
              )}
            </p>
          </li>
        ))}
      </ol>
    </AppShell>
  );
}
