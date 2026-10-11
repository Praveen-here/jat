import { Inbox, LayoutList, LogOut, Mail, Settings, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CurrentUser } from '@/lib/session';

type Section = 'applications' | 'settings';

const NAV: Array<{ label: string; icon: LucideIcon; href?: string; section?: Section }> = [
  { label: 'Applications', icon: LayoutList, href: '/app', section: 'applications' },
  { label: 'Review', icon: Inbox },
  { label: 'Other recruiting email', icon: Mail },
  { label: 'Settings', icon: Settings, href: '/app/settings', section: 'settings' },
];

/** Notion-style layout: quiet sidebar on the left, page content on the right. */
export function AppShell({ user, current, children }: { user: CurrentUser; current: Section; children: ReactNode }) {
  const displayName = user.name ?? user.email;
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-canvas px-2 py-3 md:flex">
        <p className="px-2 pb-4 text-[13px] font-semibold text-ink">Job Tracker</p>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV.map(({ label, icon: Icon, href, section }) => {
            const itemClass = 'flex h-7 items-center gap-2 rounded-md px-2 text-[13px]';
            const icon = <Icon aria-hidden className="h-4 w-4" strokeWidth={1.75} />;
            if (!href) {
              return (
                <span key={label} aria-disabled className={`${itemClass} text-ink-tertiary`}>
                  {icon}
                  {label}
                  <span className="ml-auto text-[11px]">soon</span>
                </span>
              );
            }
            const active = section === current;
            return (
              <Link
                key={label}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`${itemClass} transition-colors ${
                  active ? 'bg-surface-muted font-semibold text-ink' : 'text-ink-secondary hover:bg-surface-muted'
                }`}
              >
                {icon}
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-line px-2 pt-3">
          <p className="truncate text-[13px] font-semibold" title={displayName}>
            {displayName}
          </p>
          <p className="truncate text-[12px] text-ink-tertiary" title={user.email}>
            {user.email}
          </p>
          <SignOutButton className="mt-2" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 md:hidden">
          <p className="text-[13px] font-semibold">Job Tracker</p>
          <nav aria-label="Main" className="flex items-center gap-1">
            <Link href="/app" className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-surface-muted">
              Applications
            </Link>
            <Link href="/app/settings" className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-surface-muted">
              Settings
            </Link>
            <SignOutButton />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8 sm:py-12">{children}</main>
      </div>
    </div>
  );
}

/** A plain form POST: works without JavaScript, and the browser sends Origin for CSRF checks. */
function SignOutButton({ className = '' }: { className?: string }) {
  return (
    <form action="/api/auth/logout" method="post" className={className}>
      <button
        type="submit"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-secondary transition-colors hover:bg-surface-muted hover:text-ink"
      >
        <LogOut aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
        Sign out
      </button>
    </form>
  );
}
