/**
 * Minimal Gmail API client. Grows in the sync step (messages, history).
 * Errors carry only the HTTP status and Google's short reason code, never response bodies.
 */
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Gmail API error ${status}: ${reason}`);
    this.name = 'GmailApiError';
  }

  /** The Gmail API is switched off in the Google Cloud project. */
  get isApiDisabled(): boolean {
    return this.status === 403 && (this.reason === 'accessNotConfigured' || this.reason === 'SERVICE_DISABLED');
  }

  /** Quota exceeded: slow down and retry (docs/plan §6.8). */
  get isRateLimited(): boolean {
    return (
      this.status === 429 ||
      (this.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED'].includes(this.reason))
    );
  }

  get isTransient(): boolean {
    return this.isRateLimited || this.status >= 500;
  }
}

export async function gmailError(response: Response): Promise<GmailApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
  };
  const reason =
    body.error?.errors?.[0]?.reason ?? body.error?.details?.find((d) => d.reason)?.reason ?? body.error?.status ?? 'unknown';
  return new GmailApiError(response.status, reason);
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal: number;
}

export async function getProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<GmailProfile> {
  const response = await fetchImpl(`${GMAIL_API}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await gmailError(response);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    emailAddress: String(body.emailAddress),
    historyId: String(body.historyId),
    messagesTotal: Number(body.messagesTotal ?? 0),
  };
}
