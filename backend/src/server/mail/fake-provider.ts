import { parseAddress } from '../email/normalize';
import type { NormalizedEmail } from '../email/types';
import {
  CheckpointExpiredError,
  type ChangesPage,
  type FetchDetail,
  type FetchResult,
  type ListPage,
  type MailProvider,
} from './provider';

/**
 * In-memory mailbox that behaves like Gmail for sync tests (docs/plan §14.2):
 * paginated search, history checkpoints that can expire, deleted messages, injected failures,
 * and a quota meter. Search is simplified: every "candidate" message matches every query,
 * filtered by the `after:<epoch>` part (so query families overlap, like real ones do).
 */
export interface FakeMessage {
  id: string;
  threadId: string;
  internalDate: Date;
  labelIds: string[];
  messageIdHeader: string | null;
  /** Would Gmail search return it for our candidate queries? */
  candidate: boolean;
  from: string;
  subject: string;
  text: string;
  bulk: boolean;
}

/** Default content: a typical application confirmation (so it classifies as job-related). */
const JOB_EMAIL = {
  from: 'Fake Corp Recruiting <no-reply@greenhouse.io>',
  subject: 'Thank you for applying to Fake Corp',
  text: 'Hi, thank you for applying to Fake Corp. We have received your application for the Backend Engineer role.',
};

type Method = 'getProfile' | 'listMessages' | 'getMessages' | 'listChanges';

const EXCLUDED_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'SENT', 'CHAT']);
const UNITS: Record<Method, number> = { getProfile: 1, listMessages: 5, getMessages: 20, listChanges: 2 };

export class FakeMailProvider implements MailProvider {
  readonly address: string;
  private messages = new Map<string, FakeMessage>();
  private history: Array<{ historyId: number; messageId: string }> = [];
  private historyId = 1000;
  private expiredBefore = 0;
  private nextId = 1;
  private faults = new Map<Method, Error[]>();
  private failingMessages = new Map<string, string>();
  readonly calls: Record<Method, number> = { getProfile: 0, listMessages: 0, getMessages: 0, listChanges: 0 };
  /** Which messages had their full body downloaded. */
  readonly fullyFetched = new Set<string>();
  quotaUnits = 0;
  /** Called at the start of every API call, e.g. to add mail "while" sync runs. */
  onCall?: (method: Method) => void;

  constructor(options: { address?: string; pageSize?: number } = {}) {
    this.address = options.address ?? 'student@gmail.com';
    this.pageSize = options.pageSize ?? 3;
  }

  private readonly pageSize: number;

  // ---- test controls -------------------------------------------------------------------------

  addMessage(options: Partial<Omit<FakeMessage, 'id'>> & { id?: string } = {}): FakeMessage {
    const id = options.id ?? `m${String(this.nextId++).padStart(4, '0')}`;
    const message: FakeMessage = {
      id,
      threadId: options.threadId ?? `t-${id}`,
      internalDate: options.internalDate ?? new Date(),
      labelIds: options.labelIds ?? ['INBOX'],
      messageIdHeader: options.messageIdHeader === undefined ? `<${id}@mail.example>` : options.messageIdHeader,
      candidate: options.candidate ?? true,
      from: options.from ?? JOB_EMAIL.from,
      subject: options.subject ?? JOB_EMAIL.subject,
      text: options.text ?? JOB_EMAIL.text,
      bulk: options.bulk ?? false,
    };
    this.messages.set(id, message);
    this.history.push({ historyId: ++this.historyId, messageId: id });
    return message;
  }

  deleteMessage(id: string): void {
    this.messages.delete(id);
  }

  /** Forget history older than now: any older checkpoint gets "404 / expired". */
  expireHistory(): void {
    this.expiredBefore = this.historyId;
  }

  /** The next `times` calls of `method` throw `error`. */
  failNext(method: Method, error: Error, times = 1): void {
    const queue = this.faults.get(method) ?? [];
    for (let i = 0; i < times; i++) queue.push(error);
    this.faults.set(method, queue);
  }

  /** getMessages reports a per-message error for this id (e.g. malformed message). */
  failMessage(id: string, code = 'malformed'): void {
    this.failingMessages.set(id, code);
  }

  // ---- MailProvider ---------------------------------------------------------------------------

  private enter(method: Method, units = UNITS[method]): void {
    this.calls[method]++;
    this.quotaUnits += units;
    this.onCall?.(method);
    const fault = this.faults.get(method)?.shift();
    if (fault) throw fault;
  }

  async getProfile() {
    this.enter('getProfile');
    return { address: this.address, checkpoint: String(this.historyId) };
  }

  async listMessages(query: string, pageToken?: string): Promise<ListPage> {
    this.enter('listMessages');
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000;
    const matches = [...this.messages.values()]
      .filter((m) => m.candidate && m.internalDate.getTime() > after)
      .filter((m) => !m.labelIds.some((label) => EXCLUDED_LABELS.has(label)))
      .sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime());
    const offset = pageToken ? Number(pageToken) : 0;
    const page = matches.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    return {
      refs: page.map((m) => ({ id: m.id, threadId: m.threadId })),
      nextPageToken: nextOffset < matches.length ? String(nextOffset) : undefined,
    };
  }

  async getMessages(ids: string[], detail: FetchDetail): Promise<FetchResult[]> {
    this.enter('getMessages', UNITS.getMessages * ids.length);
    return ids.map((id): FetchResult => {
      const failing = this.failingMessages.get(id);
      if (failing) return { kind: 'error', id, code: failing };
      const m = this.messages.get(id);
      if (!m) return { kind: 'gone', id };
      if (detail === 'full') this.fullyFetched.add(id);
      return { kind: 'ok', message: this.toEmail(m, detail) };
    });
  }

  private toEmail(m: FakeMessage, detail: FetchDetail): NormalizedEmail {
    return {
      id: m.id,
      threadId: m.threadId,
      internalDate: m.internalDate,
      labelIds: m.labelIds,
      detail,
      from: parseAddress(m.from),
      replyTo: null,
      subject: m.subject,
      snippet: m.text.slice(0, 100),
      messageIdHeader: m.messageIdHeader,
      bulk: m.bulk,
      text: detail === 'full' ? m.text : '',
      links: [],
      calendar: null,
      attachmentNames: [],
      isForward: false,
    };
  }

  async listChanges(checkpoint: string, pageToken?: string): Promise<ChangesPage> {
    this.enter('listChanges');
    const start = Number(checkpoint);
    if (start < this.expiredBefore) throw new CheckpointExpiredError();
    const entries = this.history.filter((h) => h.historyId > start);
    const offset = pageToken ? Number(pageToken) : 0;
    const page = entries.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    return {
      added: page
        .map((h) => this.messages.get(h.messageId))
        .filter((m): m is FakeMessage => !!m && !m.labelIds.some((label) => EXCLUDED_LABELS.has(label)))
        .map((m) => ({ id: m.id, threadId: m.threadId })),
      nextPageToken: nextOffset < entries.length ? String(nextOffset) : undefined,
      checkpoint: String(this.historyId),
    };
  }
}
