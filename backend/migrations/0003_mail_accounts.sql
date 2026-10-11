-- 0003_mail_accounts: connected Gmail mailboxes and their encrypted credentials.

create table app.mail_accounts (
  id               uuid primary key,
  user_id          uuid not null references app.users (id) on delete cascade,
  provider         text not null check (provider in ('gmail')),
  -- Google's stable account id (`sub`) for the mailbox; the address can change.
  provider_subject text not null,
  address          text not null,
  status           text not null check (status in (
                     'connected', 'backfilling', 'active', 'recovering',
                     'reauth_required', 'paused', 'error', 'disconnecting')),
  status_reason    text,
  granted_scopes   text[] not null,
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- A mailbox can be linked to only one app user at a time.
create unique index mail_accounts_provider_subject_key on app.mail_accounts (provider, provider_subject);
create index mail_accounts_user_id_idx on app.mail_accounts (user_id);

-- Refresh tokens, envelope-encrypted (see server/crypto/vault.ts). Kept in their own table so
-- ordinary queries on mail_accounts never touch them. Deleted together with the account.
create table app.mail_account_credentials (
  mail_account_id          uuid primary key references app.mail_accounts (id) on delete cascade,
  kek_id                   text not null,
  wrapped_dek              bytea not null,
  token_iv                 bytea not null,
  refresh_token_ciphertext bytea not null,
  obtained_at              timestamptz not null default now(),
  last_refreshed_at        timestamptz,
  last_refresh_error       text
);
