import { describe, expect, it } from 'vitest';
import { getProfile, GmailApiError } from './client';

const fetchReturning = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('getProfile', () => {
  it('returns the mailbox address and current history id', async () => {
    const profile = await getProfile(
      'at',
      fetchReturning({ emailAddress: 'me@gmail.com', messagesTotal: 1200, historyId: '98765' }),
    );
    expect(profile).toEqual({ emailAddress: 'me@gmail.com', messagesTotal: 1200, historyId: '98765' });
  });

  it('recognises "Gmail API not enabled" errors', async () => {
    const error = await getProfile(
      'at',
      fetchReturning({ error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } }, 403),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailApiError);
    expect((error as GmailApiError).isApiDisabled).toBe(true);
  });

  it('keeps only the status and reason from error responses', async () => {
    const error = (await getProfile(
      'at',
      fetchReturning({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'details about me@gmail.com' } }, 401),
    ).catch((e: unknown) => e)) as GmailApiError;
    expect(error.status).toBe(401);
    expect(error.reason).toBe('UNAUTHENTICATED');
    expect(error.message).not.toContain('me@gmail.com');
  });
});
