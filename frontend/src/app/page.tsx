import { Inbox, ListChecks, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';
import { BackendStatus } from '@/components/backend-status';
import { GoogleIcon } from '@/components/google-icon';
import { getCurrentUser } from '@/lib/session';

const steps = [
  {
    icon: Inbox,
    title: 'Connect Gmail',
    text: 'Sign in with Google, then separately allow read-only access to the mailboxes you use for applications.',
  },
  {
    icon: ListChecks,
    title: 'We find your applications',
    text: 'Confirmations, assessments, interviews, offers and rejections are grouped into one card per application.',
  },
  {
    icon: ShieldCheck,
    title: 'You stay in control',
    text: 'We never store full emails, never send or delete mail, and you can disconnect and delete everything anytime.',
  },
];

const AUTH_ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled. You can try again whenever you like.',
  expired: 'That sign-in link expired or was already used. Please try again.',
  unverified_email: 'Your Google account email is not verified, so we can’t sign you in.',
  failed: 'Something went wrong while signing in with Google. Please try again.',
};

export default async function HomePage({ searchParams }: { searchParams: Promise<{ auth_error?: string }> }) {
  if (await getCurrentUser()) redirect('/app');
  const { auth_error: authError } = await searchParams;
  const errorMessage = authError ? (AUTH_ERRORS[authError] ?? AUTH_ERRORS.failed) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-16 sm:px-6 sm:py-24">
      <header className="mb-12">
        <p className="mb-3 text-[13px] font-semibold text-ink-tertiary">Job Tracker</p>
        <h1 className="text-[32px] leading-tight font-bold tracking-tight sm:text-[40px]">
          Every job application, tracked from your inbox.
        </h1>
        <p className="mt-4 max-w-xl text-[16px] text-ink-secondary">
          Connect Gmail once. Your applications, interviews and results appear in one calm dashboard.
        </p>

        {errorMessage && (
          <p
            role="alert"
            className="mt-6 max-w-xl rounded-lg border border-line bg-status-rejected-bg px-3 py-2 text-[13px] text-status-rejected-ink"
          >
            {errorMessage}
          </p>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {/* A plain link: sign-in is a full-page redirect to Google, not a client-side fetch. */}
          <a
            href="/api/auth/google/login"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-[14px] font-semibold text-ink transition-colors hover:bg-surface-muted"
          >
            <GoogleIcon className="h-4 w-4" />
            Continue with Google
          </a>
          <span className="text-[13px] text-ink-tertiary">This only signs you in. Gmail access is asked for separately.</span>
        </div>
      </header>

      <section aria-label="How it works" className="grid gap-3 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, text }) => (
          <article key={title} className="rounded-lg border border-line bg-surface p-4">
            <Icon aria-hidden className="mb-3 h-4 w-4 text-ink-secondary" strokeWidth={1.75} />
            <h2 className="mb-1 text-[14px] font-semibold">{title}</h2>
            <p className="text-[13px] text-ink-secondary">{text}</p>
          </article>
        ))}
      </section>

      <footer className="mt-auto pt-16">
        <BackendStatus />
      </footer>
    </main>
  );
}
