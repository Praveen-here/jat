import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';
import type { Logger } from '../lib/logger';

/** All application tables live in the `app` schema (kept out of Supabase's exposed `public`). */
export const APP_SCHEMA = 'app';

/** Table types mirror the SQL migrations. Add a table here when a migration adds one. */
export interface UsersTable {
  id: string;
  primary_email: string;
  display_name: string | null;
  timezone: Generated<string>;
  last_active_at: Date | null;
  created_at: Generated<Date>;
  deleted_at: Date | null;
}

export interface AuthIdentitiesTable {
  id: string;
  user_id: string;
  provider: 'google';
  provider_subject: string;
  email: string;
  created_at: Generated<Date>;
  last_login_at: Generated<Date>;
}

export interface SessionsTable {
  id_hash: string;
  user_id: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface OAuthFlowsTable {
  state_hash: string;
  purpose: 'login' | 'connect';
  browser_binding_hash: string;
  code_verifier: string;
  nonce: string;
  user_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  consumed_at: Date | null;
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

export interface MailAccountsTable {
  id: string;
  user_id: string;
  provider: 'gmail';
  provider_subject: string;
  address: string;
  status: MailAccountStatus;
  status_reason: string | null;
  granted_scopes: string[];
  connected_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MailAccountCredentialsTable {
  mail_account_id: string;
  kek_id: string;
  wrapped_dek: Buffer;
  token_iv: Buffer;
  refresh_token_ciphertext: Buffer;
  obtained_at: Generated<Date>;
  last_refreshed_at: Date | null;
  last_refresh_error: string | null;
}

export type BackfillState = 'pending' | 'enumerating' | 'fetching' | 'done';

export interface SyncStatesTable {
  mail_account_id: string;
  checkpoint: string | null;
  checkpoint_updated_at: Date | null;
  backfill_state: Generated<BackfillState>;
  backfill_window_start: Date;
  backfill_run_id: string | null;
  backfill_completed_at: Date | null;
  last_success_at: Date | null;
  last_attempt_at: Date | null;
  consecutive_failures: Generated<number>;
  first_failure_at: Date | null;
  next_sync_at: Generated<Date>;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  lease_version: Generated<string>;
}

export interface SyncRunsTable {
  id: string;
  mail_account_id: string;
  kind: 'backfill' | 'gap_recovery';
  status: Generated<'running' | 'succeeded' | 'failed'>;
  query_version: number;
  cursor: Generated<Record<string, string>>;
  window_start: Date;
  listed: Generated<number>;
  error_code: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

export type SourceMessageState =
  | 'discovered'
  | 'retry'
  | 'awaiting_match'
  | 'matched'
  | 'irrelevant'
  | 'duplicate'
  | 'skipped_gone'
  | 'failed';

export interface SourceMessagesTable {
  id: string;
  user_id: string;
  mail_account_id: string;
  provider_message_id: string;
  provider_thread_id: string | null;
  internal_date: Date | null;
  rfc822_message_id_hash: string | null;
  state: Generated<SourceMessageState>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  last_error_code: string | null;
  discovered_by_run_id: string | null;
  discovered_at: Generated<Date>;
  processed_at: Date | null;
  duplicate_of_id: string | null;
  sender_domain: string | null;
  sender_address_hash: string | null;
  sender_enc: Buffer | null;
  subject_enc: Buffer | null;
  snippet_enc: Buffer | null;
  classifier_version: number | null;
  extractor_version: number | null;
  ai_state: 'pending' | 'done' | null;
  ai_retry_at: Date | null;
}

export interface MessageClassificationsTable {
  id: string;
  source_message_id: string;
  user_id: string;
  version: number;
  category: string;
  confidence: number;
  needs_review: boolean;
  rule_hits: string[];
  is_current: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface MessageExtractionsTable {
  id: string;
  source_message_id: string;
  user_id: string;
  version: number;
  is_current: Generated<boolean>;
  company_display: string | null;
  company_key: string | null;
  company_source: string | null;
  company_confidence: number | null;
  role_title: string | null;
  role_key: string | null;
  role_confidence: number | null;
  employment_type: string;
  req_id: string | null;
  application_ref: string | null;
  job_posting_id: string | null;
  job_url: string | null;
  platform: string | null;
  event_at: Date | null;
  deadline_at: Date | null;
  event_source: string | null;
  next_step: string | null;
  created_at: Generated<Date>;
}

export interface ApplicationsTable {
  id: string;
  user_id: string;
  company_display: string | null;
  company_key: string | null;
  role_title: string | null;
  role_key: string | null;
  employment_type: Generated<string>;
  platform: string | null;
  origin: 'auto' | 'inferred';
  status: string;
  status_event_id: string | null;
  status_detail: string | null;
  status_conflict: Generated<boolean>;
  needs_review: Generated<boolean>;
  applied_at: Date | null;
  first_seen_at: Date;
  last_activity_at: Date;
  next_event_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApplicationIdentifiersTable {
  user_id: string;
  kind: 'req_id' | 'application_ref' | 'job_posting_id';
  value: string;
  application_id: string;
}

export interface MessageApplicationLinksTable {
  source_message_id: string;
  application_id: string;
  user_id: string;
  decision: 'identifier' | 'confident' | 'probable' | 'ambiguous' | 'new';
  score: number;
  needs_review: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ApplicationEventsTable {
  id: string;
  application_id: string;
  user_id: string;
  source_message_id: string | null;
  event_type: string;
  occurred_at: Date;
  scheduled_at: Date | null;
  deadline_at: Date | null;
  pending: Generated<boolean>;
  detail: string | null;
  dedupe_key: string;
  created_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  auth_identities: AuthIdentitiesTable;
  sessions: SessionsTable;
  oauth_flows: OAuthFlowsTable;
  mail_accounts: MailAccountsTable;
  mail_account_credentials: MailAccountCredentialsTable;
  sync_states: SyncStatesTable;
  sync_runs: SyncRunsTable;
  source_messages: SourceMessagesTable;
  message_classifications: MessageClassificationsTable;
  message_extractions: MessageExtractionsTable;
  applications: ApplicationsTable;
  application_identifiers: ApplicationIdentifiersTable;
  message_application_links: MessageApplicationLinksTable;
  application_events: ApplicationEventsTable;
}

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Without a listener, an idle client losing its connection would crash the process.
  pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema(APP_SCHEMA);
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('select 1');
}
