-- 0004_sync: Gmail synchronisation state, run history, and the message ledger.
-- Design: docs/plan/01-oauth-and-sync.md §6.

-- One row per connected mailbox: where sync has got to, who is running it, when to run next.
create table app.sync_states (
  mail_account_id        uuid primary key references app.mail_accounts (id) on delete cascade,
  -- Gmail historyId: incremental sync resumes from here. Opaque text, compared numerically.
  checkpoint             text,
  checkpoint_updated_at  timestamptz,
  backfill_state         text not null default 'pending'
                           check (backfill_state in ('pending', 'enumerating', 'fetching', 'done')),
  backfill_window_start  timestamptz not null,
  backfill_run_id        uuid,
  backfill_completed_at  timestamptz,
  last_success_at        timestamptz,
  last_attempt_at        timestamptz,
  consecutive_failures   integer not null default 0,
  first_failure_at       timestamptz,
  next_sync_at           timestamptz not null default now(),
  last_error_code        text,
  -- Lease: at most one worker syncs a mailbox at a time. lease_version is a fencing token:
  -- every write made under a lease checks it, so a stalled worker can't overwrite newer progress.
  lease_owner            text,
  lease_expires_at       timestamptz,
  lease_version          bigint not null default 0
);
create index sync_states_next_sync_at_idx on app.sync_states (next_sync_at);

-- One row per sync run: progress counters and resumable cursors.
create table app.sync_runs (
  id               uuid primary key,
  mail_account_id  uuid not null references app.mail_accounts (id) on delete cascade,
  kind             text not null check (kind in ('backfill', 'gap_recovery')),
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  query_version    integer not null,
  -- { "<query family>": "<next page token>" | "done" }
  cursor           jsonb not null default '{}'::jsonb,
  window_start     timestamptz not null,
  listed           integer not null default 0,
  error_code       text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index sync_runs_account_started_idx on app.sync_runs (mail_account_id, started_at desc);

-- The message ledger: one row per (mailbox, Gmail message). The unique key makes every sync
-- path idempotent: backfill, incremental and recovery can all discover the same message safely.
-- No email content is stored here.
create table app.source_messages (
  id                      uuid primary key,
  user_id                 uuid not null references app.users (id) on delete cascade,
  mail_account_id         uuid not null references app.mail_accounts (id) on delete cascade,
  provider_message_id     text not null,
  provider_thread_id      text,
  internal_date           timestamptz,
  -- HMAC of the RFC 5322 Message-ID header: finds the same email in two connected mailboxes.
  rfc822_message_id_hash  text,
  state                   text not null default 'discovered' check (state in (
                            'discovered', 'retry', 'awaiting_classification', 'skipped_gone', 'failed')),
  attempts                integer not null default 0,
  next_attempt_at         timestamptz not null default now(),
  last_error_code         text,
  discovered_by_run_id    uuid,
  discovered_at           timestamptz not null default now(),
  processed_at            timestamptz,
  unique (mail_account_id, provider_message_id)
);
create index source_messages_work_idx on app.source_messages (mail_account_id, next_attempt_at)
  where state in ('discovered', 'retry');
create index source_messages_user_msgid_idx on app.source_messages (user_id, rfc822_message_id_hash);
