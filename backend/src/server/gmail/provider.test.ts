import { describe, expect, it, vi } from 'vitest';
import { CheckpointExpiredError, ProviderUnavailableError } from '../mail/provider';
import { GMAIL_QUOTA, GmailProvider } from './provider';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler) {
  const tokens: boolean[] = [];
  const taken: number[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  ) as unknown as typeof fetch;
  const provider = new GmailProvider({
    getAccessToken: async (force) => {
      tokens.push(force);
      return force ? 'fresh-token' : 'cached-token';
    },
    limiter: { take: async (units) => void taken.push(units) },
    fetchImpl,
    retry: { sleep: async () => undefined, random: () => 0 },
  });
  return { provider, fetchImpl, tokens, taken };
}

const gmailError = (status: number, reason: string) =>
  Response.json({ error: { code: status, errors: [{ reason }], status: 'X' } }, { status });

describe('GmailProvider', () => {
  it('searches with the query, newest-first pages, and pays the list quota', async () => {
    const { provider, taken } = setup((url) => {
      expect(url.pathname).toBe('/gmail/v1/users/me/messages');
      expect(url.searchParams.get('q')).toBe('interview after:1');
      expect(url.searchParams.get('pageToken')).toBe('p2');
      return Response.json({ messages: [{ id: 'a', threadId: 't' }], nextPageToken: 'p3' });
    });
    expect(await provider.listMessages('interview after:1', 'p2')).toEqual({
      refs: [{ id: 'a', threadId: 't' }],
      nextPageToken: 'p3',
    });
    expect(taken).toEqual([GMAIL_QUOTA.list]);
  });

  it('fetches headers-only or full messages, normalises them, and reports deleted ones as gone', async () => {
    const formats: Array<string | null> = [];
    const { provider } = setup((url) => {
      formats.push(url.searchParams.get('format'));
      if (url.pathname.endsWith('/gone')) return gmailError(404, 'notFound');
      return Response.json({
        id: 'ok',
        threadId: 't1',
        internalDate: '1760000000000',
        snippet: 'We received your application',
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Message-Id', value: '<x@y>' }, { name: 'From', value: 'Acme <jobs@acme.com>' }, { name: 'Subject', value: 'Thanks' }],
          body: { data: Buffer.from('We received your application.').toString('base64url') },
        },
      });
    });

    const [ok, gone] = await provider.getMessages(['ok', 'gone'], 'full');
    expect(ok).toMatchObject({ kind: 'ok', message: { id: 'ok', subject: 'Thanks', text: 'We received your application.', messageIdHeader: '<x@y>', internalDate: new Date(1760000000000) } });
    expect(gone).toEqual({ kind: 'gone', id: 'gone' });

    const [headersOnly] = await provider.getMessages(['ok'], 'headers');
    expect(headersOnly).toMatchObject({ kind: 'ok', message: { detail: 'headers', text: '', snippet: 'We received your application' } });
    expect(formats).toEqual(['full', 'full', 'metadata']);
  });

  it('turns history 404 into CheckpointExpiredError', async () => {
    const { provider } = setup(() => gmailError(404, 'notFound'));
    await expect(provider.listChanges('123')).rejects.toBeInstanceOf(CheckpointExpiredError);
  });

  it('returns new and moved-to-inbox messages, skipping spam, drafts, sent, trash and chats', async () => {
    const { provider } = setup((url) => {
      expect(url.searchParams.getAll('historyTypes')).toEqual(['messageAdded', 'labelAdded']);
      return Response.json({
        historyId: '999',
        history: [
          { messagesAdded: [{ message: { id: 'new', threadId: 't', labelIds: ['INBOX', 'UNREAD'] } }] },
          { messagesAdded: [{ message: { id: 'spam', labelIds: ['SPAM'] } }] },
          { messagesAdded: [{ message: { id: 'sent', labelIds: ['SENT'] } }] },
          { messagesAdded: [{ message: { id: 'draft', labelIds: ['DRAFT'] } }] },
          { labelsAdded: [{ message: { id: 'rescued', labelIds: ['INBOX'] }, labelIds: ['INBOX'] }] },
          { labelsAdded: [{ message: { id: 'starred', labelIds: ['INBOX', 'STARRED'] }, labelIds: ['STARRED'] }] },
          { messagesAdded: [{ message: { id: 'new', threadId: 't', labelIds: ['INBOX'] } }] },
        ],
      });
    });
    const page = await provider.listChanges('100');
    expect(page.added.map((m) => m.id)).toEqual(['new', 'rescued']);
    expect(page.checkpoint).toBe('999');
  });

  it('refreshes the access token once after a 401', async () => {
    let calls = 0;
    const { provider, tokens } = setup((_url, init) => {
      calls++;
      const auth = new Headers(init.headers).get('authorization');
      return auth === 'Bearer fresh-token' ? Response.json({ emailAddress: 'me@gmail.com', historyId: '5' }) : new Response(null, { status: 401 });
    });
    expect(await provider.getProfile()).toEqual({ address: 'me@gmail.com', checkpoint: '5' });
    expect(tokens).toEqual([false, true]);
    expect(calls).toBe(2);
  });

  it('retries rate limits and server errors with backoff, then succeeds', async () => {
    const responses = [gmailError(429, 'rateLimitExceeded'), gmailError(403, 'userRateLimitExceeded'), gmailError(503, 'backendError')];
    const { provider, fetchImpl } = setup(() => responses.shift() ?? Response.json({ emailAddress: 'a@b.c', historyId: '1' }));
    await expect(provider.getProfile()).resolves.toEqual({ address: 'a@b.c', checkpoint: '1' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('gives up after repeated failures, and does not retry permanent errors', async () => {
    const { provider, fetchImpl } = setup(() => gmailError(503, 'backendError'));
    await expect(provider.listMessages('q')).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    const permanent = setup(() => gmailError(400, 'invalidArgument'));
    await expect(permanent.provider.listMessages('q')).rejects.toMatchObject({ status: 400 });
    expect(permanent.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('turns network failures into ProviderUnavailableError', async () => {
    const { provider } = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(provider.getProfile()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('aborts a whole batch when Gmail is unavailable, instead of marking messages broken', async () => {
    const { provider } = setup(() => gmailError(503, 'backendError'));
    await expect(provider.getMessages(['a', 'b'], 'full')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
