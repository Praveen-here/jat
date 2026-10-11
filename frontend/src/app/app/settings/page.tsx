import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { ConnectGmailButton, ConnectGmailCard } from '@/components/connect-gmail';
import { DisconnectButton } from '@/components/disconnect-button';
import { AutoRefresh } from '@/components/auto-refresh';
import { SyncProgress } from '@/components/sync-progress';
import { getCurrentUser, getMailAccounts, isImporting, type MailAccountStatus } from '@/lib/session';

export const metadata = { title: 'Settings · Job Tracker' };

type Tone = 'success' | 'warning' | 'error';

/** Messages for ?connect=… and ?disconnect=… set by the backend after redirects. */
const NOTICES: Record<string, { tone: Tone; text: string }> = {
  'connect:connected': { tone: 'success', text: 'Gmail connected.' },
  'connect:reconnected': { tone: 'success', text: 'Gmail reconnected. Access has been renewed.' },
  'connect:denied': { tone: 'warning', text: 'Connection cancelled. Nothing was connected.' },
  'connect:expired': { tone: 'warning', text: 'That connection attempt expired or was already used. Please try again.' },
  'connect:scope_missing': {
    tone: 'warning',
    text: 'Gmail access wasn’t granted. On Google’s screen, keep the “View your email messages and settings” box ticked.',
  },
  'connect:no_refresh_token': {
    tone: 'error',
    text: 'Google didn’t grant lasting access. Please try connecting again.',
  },
  'connect:linked_elsewhere': {
    tone: 'error',
    text: 'That Gmail account is already connected to a different Job Tracker account.',
  },
  'connect:limit_reached': { tone: 'warning', text: 'You can connect up to 5 Gmail accounts. Disconnect one first.' },
  'connect:gmail_api_disabled': {
    tone: 'error',
    text: 'The Gmail API is turned off in the Google Cloud project. Enable it (APIs & Services → Library → Gmail API), then try again.',
  },
  'connect:failed': { tone: 'error', text: 'Something went wrong while connecting Gmail. Please try again.' },
  'disconnect:done': { tone: 'success', text: 'Disconnected. Access was revoked and the stored data deleted.' },
  'disconnect:done_not_revoked': {
    tone: 'warning',
    text: 'Disconnected and stored data deleted, but Google couldn’t be reached to revoke access. You can remove it at myaccount.google.com → Security → Third-party connections.',
  },
  'disconnect:not_found': { tone: 'warning', text: 'That account was already disconnected.' },
  'sync:queued': { tone: 'success', text: 'Sync requested. It will start within a minute.' },
  'sync:too_soon': { tone: 'warning', text: 'A sync just ran. Please wait a minute before trying again.' },
  'sync:not_found': { tone: 'warning', text: 'That account can’t be synced right now.' },
};

/** Asks the worker to sync this mailbox at its next tick (within a minute). */
function SyncNowButton({ accountId }: { accountId: string }) {
  return (
    <form action={`/api/mail-accounts/${accountId}/sync`} method="post">
      <button type="submit" className="h-7 rounded-md px-2 text-[13px] text-ink-secondary transition-colors hover:bg-surface-muted hover:text-ink">
        Sync now
      </button>
    </form>
  );
}

const TONE_STYLES: Record<Tone, string> = {
  success: 'bg-status-offer-bg text-status-offer-ink',
  warning: 'bg-status-assessment-bg text-status-assessment-ink',
  error: 'bg-status-rejected-bg text-status-rejected-ink',
};

const STATUS: Record<MailAccountStatus, { label: string; className: string }> = {
  connected: { label: 'Starting', className: 'bg-status-detected-bg text-status-detected-ink' },
  backfilling: { label: 'Importing', className: 'bg-status-applied-bg text-status-applied-ink' },
  active: { label: 'Syncing', className: 'bg-status-offer-bg text-status-offer-ink' },
  recovering: { label: 'Catching up', className: 'bg-status-applied-bg text-status-applied-ink' },
  reauth_required: { label: 'Reconnect needed', className: 'bg-status-assessment-bg text-status-assessment-ink' },
  paused: { label: 'Paused', className: 'bg-status-detected-bg text-status-detected-ink' },
  error: { label: 'Sync problem', className: 'bg-status-rejected-bg text-status-rejected-ink' },
  disconnecting: { label: 'Disconnecting', className: 'bg-status-detected-bg text-status-detected-ink' },
};

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string; disconnect?: string; sync?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/');
  const [{ accounts, limit }, params] = await Promise.all([getMailAccounts(), searchParams]);
  const notice =
    (params.connect && (NOTICES[`connect:${params.connect}`] ?? NOTICES['connect:failed'])) ||
    (params.disconnect && NOTICES[`disconnect:${params.disconnect}`]) ||
    (params.sync && NOTICES[`sync:${params.sync}`]) ||
    null;

  return (
    <AppShell user={user} current="settings">
      <AutoRefresh active={accounts.some(isImporting)} />
      <h1 className="text-[28px] font-bold tracking-tight">Settings</h1>

      {notice && (
        <p role="status" className={`mt-6 rounded-lg px-3 py-2 text-[13px] ${TONE_STYLES[notice.tone]}`}>
          {notice.text}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-[16px] font-semibold">Connected Gmail accounts</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Applications from all connected accounts appear together. Up to {limit} accounts.
        </p>

        {accounts.length === 0 ? (
          <div className="mt-4">
            <ConnectGmailCard />
          </div>
        ) : (
          <>
            <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
              {accounts.map((account) => {
                const status = STATUS[account.status];
                return (
                  <li key={account.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-[14px] font-semibold">{account.address}</p>
                      <p className="text-[12px] text-ink-tertiary">
                        Connected {dateFormat.format(new Date(account.connectedAt))}
                      </p>
                      <SyncProgress account={account} />
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${status.className}`}>
                      {status.label}
                    </span>
                    {account.status === 'reauth_required' ? (
                      <ConnectGmailButton label="Reconnect" variant="secondary" />
                    ) : (
                      <SyncNowButton accountId={account.id} />
                    )}
                    <DisconnectButton accountId={account.id} address={account.address} />
                  </li>
                );
              })}
            </ul>
            {accounts.length < limit && (
              <div className="mt-4">
                <ConnectGmailButton label="Connect another Gmail account" variant="secondary" />
              </div>
            )}
          </>
        )}
      </section>
    </AppShell>
  );
}
