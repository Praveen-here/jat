import { AlertCircle, CalendarClock } from 'lucide-react';
import Link from 'next/link';
import type { ApplicationSummary } from '@/lib/session';
import { dateFormat, formatWhen, StatusPill, staleDays, TYPE_LABEL } from './status';

/** Notion-style database table: one row per application, newest activity first. */
export function ApplicationsTable({ items, emptyText }: { items: ApplicationSummary[]; emptyText: string }) {
  if (items.length === 0) {
    return <p className="rounded-lg border border-line bg-surface px-4 py-10 text-center text-[13px] text-ink-secondary">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[760px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-[12px] text-ink-tertiary">
            <th scope="col" className="px-3 py-2 font-semibold">Company</th>
            <th scope="col" className="px-3 py-2 font-semibold">Role</th>
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            <th scope="col" className="px-3 py-2 font-semibold">Applied</th>
            <th scope="col" className="px-3 py-2 font-semibold">Last activity</th>
            <th scope="col" className="px-3 py-2 font-semibold">Next</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Emails</th>
          </tr>
        </thead>
        <tbody>
          {items.map((app) => {
            const stale = staleDays(app.lastActivityAt, app.status);
            const href = `/app/applications/${app.id}`;
            return (
              <tr key={app.id} className="group border-b border-line align-top last:border-0 hover:bg-surface-muted/60">
                <td className="px-3 py-2.5">
                  <Link href={href} className="font-semibold text-ink group-hover:underline">
                    {app.company ?? <span className="text-ink-tertiary">Unknown company</span>}
                  </Link>
                  {app.platform && <p className="mt-0.5 text-[12px] text-ink-tertiary">via {app.platform}</p>}
                </td>
                <td className="px-3 py-2.5">
                  {app.role ?? <span className="text-ink-tertiary">—</span>}
                  {TYPE_LABEL[app.employmentType] && <p className="mt-0.5 text-[12px] text-ink-tertiary">{TYPE_LABEL[app.employmentType]}</p>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusPill status={app.status} detail={app.statusDetail} />
                    {app.needsReview && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-status-review-bg px-2 py-0.5 text-[12px] font-semibold text-status-review-ink">
                        <AlertCircle aria-hidden className="h-3 w-3" />
                        Check
                      </span>
                    )}
                  </div>
                  {stale && <p className="mt-1 text-[12px] text-ink-tertiary">No news for {stale} days</p>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink-secondary">
                  {app.appliedAt ? dateFormat.format(new Date(app.appliedAt)) : <span className="text-ink-tertiary" title="The confirmation email wasn’t found">—</span>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink-secondary">{dateFormat.format(new Date(app.lastActivityAt))}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {app.nextEventAt ? (
                    <span className="inline-flex items-center gap-1 text-ink">
                      <CalendarClock aria-hidden className="h-3.5 w-3.5 text-accent" />
                      {formatWhen(app.nextEventAt)}
                    </span>
                  ) : (
                    <span className="text-ink-tertiary">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right text-ink-secondary">{app.emailCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
