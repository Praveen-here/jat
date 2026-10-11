import 'server-only';
import { cookies } from 'next/headers';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

export type MailAccountStatus =
  | 'connected'
  | 'backfilling'
  | 'active'
  | 'recovering'
  | 'reauth_required'
  | 'paused'
  | 'error'
  | 'disconnecting';

export interface SyncSummary {
  backfillState: 'pending' | 'enumerating' | 'fetching' | 'done' | null;
  windowStart: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string | null;
  lastErrorCode: string | null;
  /** Emails the search found so far. */
  found: number;
  /** Of those, how many have been read. */
  processed: number;
  failed: number;
  /** AI double-check (runs after the fast first sort). */
  aiPending: number;
  aiDone: number;
}

export interface MailAccount {
  id: string;
  address: string;
  status: MailAccountStatus;
  statusReason: string | null;
  connectedAt: string;
  sync: SyncSummary | null;
}

/** True while the first import (or a catch-up scan) is still running. */
export function isImporting(account: MailAccount): boolean {
  return ['connected', 'backfilling', 'recovering'].includes(account.status) || (account.sync?.aiPending ?? 0) > 0;
}

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

/**
 * Server-side GET to the backend, forwarding the browser's cookies.
 * Returns null when signed out, on errors, or if the backend is unreachable.
 */
async function backendGet<T>(path: string): Promise<T | null> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) return null;
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return (await backendGet<{ user: CurrentUser }>('/api/me'))?.user ?? null;
}

export interface JobEmail {
  id: string;
  receivedAt: string;
  account: string;
  category: string;
  confidence: number;
  needsReview: boolean;
  company: string | null;
  role: string | null;
  employmentType: string;
  platform: string | null;
  eventAt: string | null;
  deadlineAt: string | null;
  subject: string | null;
  sender: { name: string | null; address: string } | null;
  snippet: string | null;
  gmailUrl: string;
}

export async function getJobEmails(view: 'all' | 'review'): Promise<{ items: JobEmail[]; counts: { all: number; review: number } }> {
  return (
    (await backendGet<{ items: JobEmail[]; counts: { all: number; review: number } }>(`/api/job-emails?view=${view}`)) ?? {
      items: [],
      counts: { all: 0, review: 0 },
    }
  );
}

export interface ApplicationSummary {
  id: string;
  company: string | null;
  role: string | null;
  employmentType: string;
  platform: string | null;
  origin: 'auto' | 'inferred';
  status: string;
  statusDetail: string | null;
  statusConflict: boolean;
  needsReview: boolean;
  appliedAt: string | null;
  firstSeenAt: string;
  lastActivityAt: string;
  nextEventAt: string | null;
  emailCount: number;
}

export interface TimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  scheduledAt: string | null;
  deadlineAt: string | null;
  pending: boolean;
  detail: string | null;
  decision: string | null;
  account: string | null;
  subject: string | null;
  sender: { name: string | null; address: string } | null;
  gmailUrl: string | null;
}

export type ApplicationList = { items: ApplicationSummary[]; counts: { all: number; review: number; byStatus: Record<string, number> } };

export async function getApplications(view: 'all' | 'review'): Promise<ApplicationList> {
  return (await backendGet<ApplicationList>(`/api/applications?view=${view}`)) ?? { items: [], counts: { all: 0, review: 0, byStatus: {} } };
}

export async function getApplication(id: string): Promise<{ application: ApplicationSummary; timeline: TimelineEntry[] } | null> {
  return backendGet(`/api/applications/${encodeURIComponent(id)}`);
}

export async function getMailAccounts(): Promise<{ accounts: MailAccount[]; limit: number }> {
  return (await backendGet<{ accounts: MailAccount[]; limit: number }>('/api/mail-accounts')) ?? { accounts: [], limit: 5 };
}
