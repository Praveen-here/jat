import type { NormalizedEmail } from '../email/types';

/**
 * Provider-neutral mailbox interface. The sync engine only talks to this, so another provider
 * (e.g. Outlook via Microsoft Graph delta queries) can be added by writing one adapter.
 * Implementations: GmailProvider (real API) and FakeMailProvider (tests).
 */
export interface MessageRef {
  id: string;
  threadId: string | null;
}

export interface ListPage {
  refs: MessageRef[];
  nextPageToken?: string;
}

/**
 * 'headers' fetches sender, subject and snippet only (for triage); 'full' includes the body.
 * Either way the result exists only in memory; bodies are never stored.
 */
export type FetchDetail = 'headers' | 'full';

export type FetchResult =
  | { kind: 'ok'; message: NormalizedEmail }
  | { kind: 'gone'; id: string }
  | { kind: 'error'; id: string; code: string };

export interface ChangesPage {
  /** New messages since the checkpoint, already excluding spam, trash, drafts, sent and chats. */
  added: MessageRef[];
  nextPageToken?: string;
  /** The mailbox's current checkpoint (Gmail historyId). */
  checkpoint: string;
}

export interface MailProvider {
  getProfile(): Promise<{ address: string; checkpoint: string }>;
  /** Search the mailbox. Newest first, paginated. */
  listMessages(query: string, pageToken?: string): Promise<ListPage>;
  getMessages(ids: string[], detail: FetchDetail): Promise<FetchResult[]>;
  /** Changes since a checkpoint. Throws CheckpointExpiredError when it's too old. */
  listChanges(checkpoint: string, pageToken?: string): Promise<ChangesPage>;
}

/** The provider no longer has history that old: a recovery scan is needed (Gmail: HTTP 404). */
export class CheckpointExpiredError extends Error {
  constructor() {
    super('Sync checkpoint expired');
    this.name = 'CheckpointExpiredError';
  }
}

/** Access was revoked or expired (Google: invalid_grant). The user must reconnect. */
export class AuthRevokedError extends Error {
  constructor(readonly code = 'invalid_grant') {
    super(`Mailbox access revoked: ${code}`);
    this.name = 'AuthRevokedError';
  }
}

/** A failure that isn't the mailbox's fault and is worth retrying later (rate limit, 5xx, network). */
export class ProviderUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Mail provider unavailable: ${code}`);
    this.name = 'ProviderUnavailableError';
  }
}
