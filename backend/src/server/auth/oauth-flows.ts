import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/pool';
import { randomToken, sha256Hex } from './crypto';

export const OAUTH_FLOW_TTL_SECONDS = 10 * 60;

export type OAuthPurpose = 'login' | 'connect';

export interface StartedFlow {
  /** Sent to Google; comes back unchanged. Stored hashed. */
  state: string;
  /** Put into the ID token by Google; checked on return. */
  nonce: string;
  /** PKCE secret; only its hash (challenge) goes to Google. */
  codeVerifier: string;
  /** Set as an HttpOnly cookie; proves the callback is in the browser that started the flow. */
  bindingToken: string;
}

export async function startOAuthFlow(
  db: Kysely<Database>,
  purpose: OAuthPurpose,
  userId: string | null = null,
): Promise<StartedFlow> {
  const flow: StartedFlow = {
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(48),
    bindingToken: randomToken(),
  };
  await db
    .insertInto('oauth_flows')
    .values({
      state_hash: sha256Hex(flow.state),
      purpose,
      browser_binding_hash: sha256Hex(flow.bindingToken),
      code_verifier: flow.codeVerifier,
      nonce: flow.nonce,
      user_id: userId,
      expires_at: new Date(Date.now() + OAUTH_FLOW_TTL_SECONDS * 1000),
    })
    .execute();
  return flow;
}

export interface ConsumedFlow {
  codeVerifier: string;
  nonce: string;
  userId: string | null;
}

/**
 * Atomically marks the flow used. Returns null if the state is unknown, expired, already used,
 * for a different purpose, or started in a different browser.
 */
export async function consumeOAuthFlow(
  db: Kysely<Database>,
  params: { state: string; purpose: OAuthPurpose; bindingToken: string | undefined },
): Promise<ConsumedFlow | null> {
  if (!params.bindingToken) return null;
  const row = await db
    .updateTable('oauth_flows')
    .set({ consumed_at: sql`now()` })
    .where('state_hash', '=', sha256Hex(params.state))
    .where('purpose', '=', params.purpose)
    .where('browser_binding_hash', '=', sha256Hex(params.bindingToken))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returning(['code_verifier', 'nonce', 'user_id'])
    .executeTakeFirst();
  return row ? { codeVerifier: row.code_verifier, nonce: row.nonce, userId: row.user_id } : null;
}
