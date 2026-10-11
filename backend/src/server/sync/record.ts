import { sql, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { hmacHex } from '../auth/crypto';
import { shouldFetchBody, type Analysis } from '../classify/analyze';
import { CLASSIFIER_VERSION } from '../classify/classifier';
import { EXTRACTOR_VERSION } from '../classify/extract';
import { contentAad, sealText } from '../crypto/content';
import type { Database } from '../db/pool';
import type { NormalizedEmail } from '../email/types';
import type { FetchResult, MailProvider } from '../mail/provider';

/**
 * Turns fetched emails into ledger records (docs/plan §6.3 step 2, §6.4 triage, §7).
 *
 * What is stored, by design:
 *  - every message: ids, date, a keyed Message-ID fingerprint, and its state;
 *  - job-related messages only: category, extracted fields, sender domain, and the subject,
 *    sender and Gmail snippet ENCRYPTED; never the body;
 *  - everything else: no content at all.
 */
export interface RecordDeps {
  pepper: string;
  contentKey: Buffer;
  userId: string;
  timeZone: string;
}

export type Fetched = FetchResult | { kind: 'triaged_out'; message: NormalizedEmail };

/**
 * Fetches a batch for analysis. Messages found by the job-search queries are fetched in full.
 * New mail from incremental sync is fetched headers-first; only mail that looks job-related
 * has its body downloaded, so personal email bodies are never read.
 */
export async function fetchForAnalysis(
  provider: MailProvider,
  rows: Array<{ provider_message_id: string; discovered_by_run_id: string | null }>,
): Promise<Map<string, Fetched>> {
  const results = new Map<string, Fetched>();
  const full = rows.filter((r) => r.discovered_by_run_id).map((r) => r.provider_message_id);
  const fresh = rows.filter((r) => !r.discovered_by_run_id).map((r) => r.provider_message_id);

  if (fresh.length) {
    for (const result of await provider.getMessages(fresh, 'headers')) {
      if (result.kind !== 'ok') results.set(result.id, result);
      else if (shouldFetchBody(result.message)) full.push(result.message.id);
      else results.set(result.message.id, { kind: 'triaged_out', message: result.message });
    }
  }
  if (full.length) {
    for (const result of await provider.getMessages(full, 'full')) {
      results.set(result.kind === 'ok' ? result.message.id : result.id, result);
    }
  }
  return results;
}

/** Normalises `<ABC@host>` and HMACs it: the same email in two mailboxes gets the same value. */
export function fingerprintMessageId(pepper: string, header: string | null): string | null {
  const normalized = header?.trim().replace(/^<|>$/g, '').toLowerCase();
  return normalized ? hmacHex(pepper, `message-id:${normalized}`) : null;
}

export async function recordFetched(
  trx: Transaction<Database>,
  deps: RecordDeps,
  rowId: string,
  fetched: Extract<Fetched, { message: NormalizedEmail }>,
  /** From analyzeHybrid (rules + AI), computed before the transaction; null for triaged-out mail. */
  analysis: Analysis | null,
  attempts: number,
  /** 'pending' = queue for the AI double-check; 'done' = this IS the AI's result. */
  aiState: 'pending' | 'done' | null = null,
): Promise<Analysis | null> {
  const email = fetched.message;
  const fingerprint = fingerprintMessageId(deps.pepper, email.messageIdHeader);
  const base = {
    provider_thread_id: email.threadId,
    internal_date: email.internalDate,
    rfc822_message_id_hash: fingerprint,
    attempts,
    last_error_code: null,
    processed_at: sql<Date>`now()`,
    ai_state: aiState,
    ai_retry_at: null,
  };

  if (!analysis?.relevant) {
    await trx
      .updateTable('source_messages')
      .set({
        ...base,
        state: 'irrelevant',
        classifier_version: CLASSIFIER_VERSION,
        // Nothing about non-job email is kept beyond the ids above.
        sender_domain: null,
        sender_address_hash: null,
        sender_enc: null,
        subject_enc: null,
        snippet_enc: null,
      })
      .where('id', '=', rowId)
      .execute();
    if (analysis) await saveClassification(trx, deps.userId, rowId, analysis);
    return analysis;
  }

  // The same email already recorded from another connected mailbox?
  const original = fingerprint
    ? await trx
        .selectFrom('source_messages')
        .select('id')
        .where('user_id', '=', deps.userId)
        .where('rfc822_message_id_hash', '=', fingerprint)
        .where('id', '!=', rowId)
        .where('state', 'in', ['awaiting_match', 'matched'])
        .executeTakeFirst()
    : undefined;

  const sender = email.from ? JSON.stringify({ name: email.from.name, address: email.from.address }) : null;
  await trx
    .updateTable('source_messages')
    .set({
      ...base,
      state: original ? 'duplicate' : 'awaiting_match',
      duplicate_of_id: original?.id ?? null,
      sender_domain: email.from?.domain ?? null,
      sender_address_hash: email.from ? hmacHex(deps.pepper, `sender:${email.from.address}`) : null,
      sender_enc: sender ? sealText(deps.contentKey, sender, contentAad(rowId, 'sender')) : null,
      subject_enc: sealText(deps.contentKey, email.subject.slice(0, 300), contentAad(rowId, 'subject')),
      snippet_enc: sealText(deps.contentKey, email.snippet.slice(0, 300), contentAad(rowId, 'snippet')),
      classifier_version: CLASSIFIER_VERSION,
      extractor_version: EXTRACTOR_VERSION,
    })
    .where('id', '=', rowId)
    .execute();
  await saveClassification(trx, deps.userId, rowId, analysis);
  await saveExtraction(trx, deps.userId, rowId, analysis);
  return analysis;
}

async function saveClassification(trx: Transaction<Database>, userId: string, rowId: string, analysis: Analysis) {
  const c = analysis.classification;
  await trx
    .updateTable('message_classifications')
    .set({ is_current: false })
    .where('source_message_id', '=', rowId)
    .where('version', '!=', CLASSIFIER_VERSION)
    .execute();
  const values = {
    category: c.category,
    confidence: c.confidence,
    needs_review: c.needsReview,
    rule_hits: c.ruleHits,
    is_current: true,
  };
  await trx
    .insertInto('message_classifications')
    .values({ id: uuidv7(), source_message_id: rowId, user_id: userId, version: CLASSIFIER_VERSION, ...values })
    .onConflict((oc) => oc.columns(['source_message_id', 'version']).doUpdateSet(values))
    .execute();
}

async function saveExtraction(trx: Transaction<Database>, userId: string, rowId: string, analysis: Analysis) {
  const x = analysis.extraction;
  if (!x) return;
  await trx
    .updateTable('message_extractions')
    .set({ is_current: false })
    .where('source_message_id', '=', rowId)
    .where('version', '!=', EXTRACTOR_VERSION)
    .execute();
  const values = {
    is_current: true,
    company_display: x.company?.display ?? null,
    company_key: x.company?.key ?? null,
    company_source: x.company?.source ?? null,
    company_confidence: x.company?.confidence ?? null,
    role_title: x.role?.title ?? null,
    role_key: x.role?.key ?? null,
    role_confidence: x.role?.confidence ?? null,
    employment_type: x.employmentType,
    req_id: x.reqId,
    application_ref: x.applicationRef,
    job_posting_id: x.jobPostingId,
    job_url: x.jobUrl,
    platform: x.platform,
    event_at: x.eventAt,
    deadline_at: x.deadlineAt,
    event_source: x.eventSource,
    next_step: x.nextStep,
  };
  await trx
    .insertInto('message_extractions')
    .values({ id: uuidv7(), source_message_id: rowId, user_id: userId, version: EXTRACTOR_VERSION, ...values })
    .onConflict((oc) => oc.columns(['source_message_id', 'version']).doUpdateSet(values))
    .execute();
}
