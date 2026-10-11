import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { ApplicationsTable } from '@/components/applications-table';
import { AutoRefresh } from '@/components/auto-refresh';
import { ConnectGmailCard } from '@/components/connect-gmail';
import { JobEmailsTable } from '@/components/job-emails-table';
import { STATUS } from '@/components/status';
import { SyncProgress } from '@/components/sync-progress';
import { getApplications, getCurrentUser, getJobEmails, getMailAccounts, isImporting } from '@/lib/session';

export const metadata = { title: 'Applications · Job Tracker' };

type View = 'applications' | 'review' | 'emails';

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/');
  const requested = (await searchParams).view;
  const view: View = requested === 'review' || requested === 'emails' ? requested : 'applications';

  const [{ accounts }, applications, emails] = await Promise.all([
    getMailAccounts(),
    getApplications(view === 'review' ? 'review' : 'all'),
    view === 'emails' ? getJobEmails('all') : Promise.resolve(null),
  ]);
  const importing = accounts.some(isImporting);
  const { counts } = applications;
  const statusSummary = ['APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED'].filter((s) => counts.byStatus[s]);

  const tabs: Array<{ id: View; label: string; href: string }> = [
    { id: 'applications', label: `Applications (${counts.all})`, href: '/app' },
    { id: 'review', label: `Needs review (${counts.review})`, href: '/app?view=review' },
    { id: 'emails', label: 'All job emails', href: '/app?view=emails' },
  ];

  return (
    <AppShell user={user} current="applications">
      <AutoRefresh active={importing} />
      <h1 className="text-[28px] font-bold tracking-tight">Applications</h1>
      <p className="mt-1 text-[14px] text-ink-secondary">
        {statusSummary.length
          ? statusSummary.map((s) => `${counts.byStatus[s]} ${STATUS[s]?.label.toLowerCase()}`).join(' · ')
          : 'Your job and internship applications, found automatically in your email.'}
      </p>

      {accounts.length === 0 ? (
        <div className="mt-10">
          <ConnectGmailCard />
        </div>
      ) : (
        <>
          <ul className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {accounts.map((account) => (
              <li key={account.id} className="min-w-0 rounded-md border border-line bg-surface px-3 py-2 sm:min-w-[280px]">
                <p className="truncate text-[13px] font-semibold">{account.address}</p>
                <SyncProgress account={account} />
              </li>
            ))}
            <li className="flex items-center px-1">
              <Link href="/app/settings" className="text-[13px] font-semibold text-accent hover:underline">
                Manage
              </Link>
            </li>
          </ul>

          <nav aria-label="Views" className="mt-8 flex w-fit gap-1 rounded-lg bg-surface-muted p-0.5 text-[13px]">
            {tabs.map((tab) => (
              <Link
                key={tab.id}
                href={tab.href}
                aria-current={view === tab.id ? 'page' : undefined}
                className={`rounded-md px-2.5 py-1 font-semibold ${view === tab.id ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-secondary hover:text-ink'}`}
              >
                {tab.label}
              </Link>
            ))}
          </nav>

          <div className="mt-4">
            {view === 'emails' && emails ? (
              <JobEmailsTable items={emails.items} counts={emails.counts} view="all" />
            ) : (
              <ApplicationsTable
                items={applications.items}
                emptyText={
                  view === 'review'
                    ? 'Nothing needs your review.'
                    : importing
                      ? 'Your applications will appear here as the import finishes.'
                      : 'No applications found yet.'
                }
              />
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
