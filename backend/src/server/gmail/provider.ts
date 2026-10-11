import { withRetry, type RetryOptions } from '../lib/retry';
import {
  AuthRevokedError,
  CheckpointExpiredError,
  ProviderUnavailableError,
  type ChangesPage,
  type FetchDetail,
  type FetchResult,
  type ListPage,
  type MailProvider,
  type MessageRef,
} from '../mail/provider';
import { gmailError, GmailApiError } from './client';
import { normalizeGmailMessage, TRIAGE_HEADERS, type GmailMessage } from './normalize';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Quota cost per method, from Google's usage-limits page (checked 2026-10-11). */
export const GMAIL_QUOTA = { profile: 1, list: 5, get: 20, history: 2 } as const;

/** Labels whose messages we never process (docs/plan §6, assumption A8). */
const EXCLUDED_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT', 'CHAT']);
const PAGE_SIZE = 500;
const FETCH_CONCURRENCY = 10;

export interface GmailProviderDeps {
  /** Returns an access token; `force` bypasses the cache (after a 401). Throws AuthRevokedError. */
  getAccessToken: (force: boolean) => Promise<string>;
  limiter: { take(units: number): Promise<void> };
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryOptions>;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'));
}

export class GmailProvider implements MailProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: GmailProviderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** One API call: quota pacing, retry with backoff on rate limits/5xx/network, one re-auth on 401. */
  private async call<T>(units: number, path: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    try {
      return await withRetry(
        async () => {
          await this.deps.limiter.take(units);
          const url = `${GMAIL_API}${path}${params.size ? `?${params}` : ''}`;
          const send = async (force: boolean) =>
            this.fetchImpl(url, {
              headers: { Authorization: `Bearer ${await this.deps.getAccessToken(force)}` },
              signal: AbortSignal.timeout(30_000),
            });
          let response = await send(false);
          if (response.status === 401) response = await send(true);
          if (!response.ok) throw await gmailError(response);
          return (await response.json()) as T;
        },
        {
          attempts: 6,
          baseMs: 2_000,
          capMs: 5 * 60_000,
          isRetryable: (err) => (err instanceof GmailApiError && err.isTransient) || isNetworkError(err),
          retryAfterMs: () => undefined,
          ...this.deps.retry,
        },
      );
    } catch (err) {
      if (err instanceof AuthRevokedError || err instanceof GmailApiError) throw err;
      if (isNetworkError(err)) throw new ProviderUnavailableError('network');
      throw err;
    }
  }

  async getProfile(): Promise<{ address: string; checkpoint: string }> {
    const body = await this.call<{ emailAddress: string; historyId: string }>(GMAIL_QUOTA.profile, '/profile');
    return { address: body.emailAddress, checkpoint: String(body.historyId) };
  }

  async listMessages(query: string, pageToken?: string): Promise<ListPage> {
    const params = new URLSearchParams({ q: query, maxResults: String(PAGE_SIZE), includeSpamTrash: 'false' });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await this.call<{ messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }>(
      GMAIL_QUOTA.list,
      '/messages',
      params,
    );
    return {
      refs: (body.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId ?? null })),
      nextPageToken: body.nextPageToken,
    };
  }

  /** Fetches and normalises messages. The raw body is dropped as soon as it's normalised. */
  async getMessages(ids: string[], detail: FetchDetail): Promise<FetchResult[]> {
    const results: FetchResult[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const index = next++;
        results[index] = await this.getOne(ids[index]!, detail);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker));
    return results;
  }

  private async getOne(id: string, detail: FetchDetail): Promise<FetchResult> {
    const params = new URLSearchParams({ format: detail === 'full' ? 'full' : 'metadata' });
    if (detail === 'headers') for (const header of TRIAGE_HEADERS) params.append('metadataHeaders', header);
    try {
      const body = await this.call<GmailMessage>(GMAIL_QUOTA.get, `/messages/${encodeURIComponent(id)}`, params);
      return { kind: 'ok', message: normalizeGmailMessage(body, detail) };
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return { kind: 'gone', id };
      // Account-wide problems abort the whole batch; anything else is this message's problem.
      if (err instanceof AuthRevokedError || err instanceof ProviderUnavailableError) throw err;
      if (err instanceof GmailApiError && err.isTransient) throw new ProviderUnavailableError(`http_${err.status}`);
      return { kind: 'error', id, code: err instanceof GmailApiError ? `http_${err.status}_${err.reason}` : 'unexpected' };
    }
  }

  async listChanges(checkpoint: string, pageToken?: string): Promise<ChangesPage> {
    const params = new URLSearchParams({ startHistoryId: checkpoint, maxResults: String(PAGE_SIZE) });
    params.append('historyTypes', 'messageAdded');
    params.append('historyTypes', 'labelAdded');
    if (pageToken) params.set('pageToken', pageToken);

    type HistoryMessage = { id: string; threadId?: string; labelIds?: string[] };
    let body: {
      history?: Array<{
        messagesAdded?: Array<{ message: HistoryMessage }>;
        labelsAdded?: Array<{ message: HistoryMessage; labelIds?: string[] }>;
      }>;
      nextPageToken?: string;
      historyId: string;
    };
    try {
      body = await this.call(GMAIL_QUOTA.history, '/history', params);
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) throw new CheckpointExpiredError();
      throw err;
    }

    const added = new Map<string, MessageRef>();
    const consider = (m: HistoryMessage) => {
      if ((m.labelIds ?? []).some((label) => EXCLUDED_LABELS.has(label))) return;
      added.set(m.id, { id: m.id, threadId: m.threadId ?? null });
    };
    for (const entry of body.history ?? []) {
      for (const { message } of entry.messagesAdded ?? []) consider(message);
      // A message moved into the inbox (e.g. out of spam) counts as new to us.
      for (const change of entry.labelsAdded ?? []) {
        if (change.labelIds?.includes('INBOX')) consider(change.message);
      }
    }
    return { added: [...added.values()], nextPageToken: body.nextPageToken, checkpoint: String(body.historyId) };
  }
}
