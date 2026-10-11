import { Check, Mail, X } from 'lucide-react';

/** Form POST to the backend, which redirects to Google's consent screen. */
export function ConnectGmailButton({ label = 'Connect Gmail', variant = 'primary' }: { label?: string; variant?: 'primary' | 'secondary' }) {
  const styles =
    variant === 'primary'
      ? 'bg-accent text-white hover:brightness-95'
      : 'border border-line bg-surface text-ink hover:bg-surface-muted';
  return (
    <form action="/api/mail-accounts/gmail/connect" method="post">
      <button type="submit" className={`inline-flex h-8 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition ${styles}`}>
        <Mail aria-hidden className="h-4 w-4" strokeWidth={1.75} />
        {label}
      </button>
    </form>
  );
}

const WE_DO = [
  'Look for job-related emails from the last 6 months, then keep checking for new ones',
  'Save only what the tracker needs: company, role, dates, status and a short snippet',
  'Link each item back to the original email in Gmail',
];

const WE_NEVER = [
  'Send, delete, or change any email',
  'Store full emails, or read emails that aren’t about jobs beyond their headers',
  'Share your data, use it for ads, or train AI models on it',
];

/** Pre-consent explainer, shown before Google's screen (docs/plan/01-oauth-and-sync.md §5.3). */
export function ConnectGmailCard() {
  return (
    <section className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-[16px] font-semibold">Connect your Gmail</h2>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-secondary">
        Google will ask you to allow <span className="font-semibold text-ink">“View your email messages and settings”</span>.
        That’s read-only access to the whole mailbox, so here is exactly how we use it.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-tertiary uppercase">We will</h3>
          <ul className="space-y-1.5">
            {WE_DO.map((item) => (
              <li key={item} className="flex gap-2 text-[13px]">
                <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-status-offer-ink" strokeWidth={2} />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-tertiary uppercase">We never</h3>
          <ul className="space-y-1.5">
            {WE_NEVER.map((item) => (
              <li key={item} className="flex gap-2 text-[13px]">
                <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-status-rejected-ink" strokeWidth={2} />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ConnectGmailButton />
        <p className="text-[12px] text-ink-tertiary">
          Google may warn that the app isn’t verified. That’s expected while it’s in testing; choose Continue. You can
          disconnect anytime in Settings.
        </p>
      </div>
    </section>
  );
}
