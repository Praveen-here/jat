-- 0002_users_sessions: sign-in with Google and server-side sessions.

create table app.users (
  id             uuid primary key,
  primary_email  text not null,
  display_name   text,
  timezone       text not null default 'Asia/Kolkata',
  settings       jsonb not null default '{}'::jsonb,
  last_active_at timestamptz,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- Users are identified by Google's stable `sub`, never by email address (emails can change).
create table app.auth_identities (
  id               uuid primary key,
  user_id          uuid not null references app.users (id) on delete cascade,
  provider         text not null check (provider in ('google')),
  provider_subject text not null,
  email            text not null,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz not null default now(),
  unique (provider, provider_subject)
);
create index auth_identities_user_id_idx on app.auth_identities (user_id);

-- Only a SHA-256 hash of the cookie token is stored, so a leaked row can't be replayed as a login.
create table app.sessions (
  id_hash             text primary key,
  user_id             uuid not null references app.users (id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at          timestamptz
);
create index sessions_user_id_idx on app.sessions (user_id);
create index sessions_absolute_expires_at_idx on app.sessions (absolute_expires_at);

-- One row per OAuth redirect: single-use, expires after 10 minutes, and bound to the browser
-- that started it (via a hashed cookie value) to block login CSRF.
create table app.oauth_flows (
  state_hash           text primary key,
  purpose              text not null check (purpose in ('login', 'connect')),
  browser_binding_hash text not null,
  code_verifier        text not null,
  nonce                text not null,
  user_id              uuid references app.users (id) on delete cascade,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  consumed_at          timestamptz
);
create index oauth_flows_expires_at_idx on app.oauth_flows (expires_at);
