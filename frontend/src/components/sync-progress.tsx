import type { MailAccount } from '@/lib/session';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

/** One line (plus a bar while importing) describing where a mailbox's sync is. */
export function SyncProgress({ account }: { account: MailAccount }) {
  const sync = account.sync;
  if (!sync) return null;

  if (account.status === 'reauth_required') {
    return <p className="text-[12px] text-status-assessment-ink">Google access expired or was removed. Reconnect to keep syncing.</p>;
  }

  const importing = account.status === 'connected' || sync.backfillState !== 'done' || account.status === 'recovering';
  if (importing) {
    const reading = sync.backfillState === 'fetching' || (sync.found > 0 && sync.processed > 0);
    const percent = sync.found > 0 ? Math.round((sync.processed / sync.found) * 100) : 0;
    const label =
      account.status === 'connected' || sync.backfillState === 'pending'
        ? 'Starting import…'
        : account.status === 'recovering'
          ? `Catching up on missed email… ${sync.processed} of ${sync.found} checked`
          : reading
            ? `Reading ${sync.processed} of ${sync.found} possible job emails`
            : `Searching the last 6 months… ${sync.found} possible job emails found`;
    return (
      <div className="space-y-1.5">
        <p className="text-[12px] text-ink-secondary" aria-live="polite">
          {label}
        </p>
        <div
          className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={reading ? percent : undefined}
          aria-label="Import progress"
        >
          <div
            className={`h-full rounded-full bg-accent transition-all ${reading ? '' : 'w-1/3 animate-pulse'}`}
            style={reading ? { width: `${Math.max(percent, 3)}%` } : undefined}
          />
        </div>
      </div>
    );
  }

  // Phase 2: everything is sorted; the AI is double-checking in the background.
  if (sync.aiPending > 0) {
    const total = sync.aiPending + sync.aiDone;
    const percent = Math.round((sync.aiDone / total) * 100);
    return (
      <div className="space-y-1.5">
        <p className="text-[12px] text-ink-secondary" aria-live="polite">
          AI double-checking: {sync.aiDone} of {total} emails checked. Results update as it goes.
        </p>
        <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="AI check progress">
          <div className="h-full rounded-full bg-status-shortlisted-ink transition-all" style={{ width: `${Math.max(percent, 3)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <p className="text-[12px] text-ink-tertiary">
      {sync.lastSuccessAt ? `Synced ${timeAgo(sync.lastSuccessAt)}` : 'Not synced yet'}
      {` · ${sync.processed} possible job email${sync.processed === 1 ? '' : 's'} so far`}
      {sync.failed > 0 && ` · ${sync.failed} couldn’t be read`}
      {sync.lastErrorCode && (
        <span className="text-status-assessment-ink"> · Last attempt failed, retrying automatically</span>
      )}
    </p>
  );
}
