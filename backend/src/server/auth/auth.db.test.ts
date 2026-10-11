import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpiredAuthData } from '../jobs/cleanup';
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from '../testing/test-db';
import { sha256Hex } from './crypto';
import { consumeOAuthFlow, startOAuthFlow } from './oauth-flows';
import { createSession, findSessionUser, revokeSession, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './sessions';
import { upsertGoogleUser } from './users';

const identity = { subject: 'google-sub-123', email: 'student@gmail.com', emailVerified: true, name: 'Test Student' };

describe.skipIf(!TEST_DATABASE_URL)('auth (database)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  describe('OAuth flows', () => {
    it('can be consumed exactly once, from the same browser', async () => {
      const flow = await startOAuthFlow(t.db, 'login');
      const params = { state: flow.state, purpose: 'login' as const, bindingToken: flow.bindingToken };

      const first = await consumeOAuthFlow(t.db, params);
      expect(first).toEqual({ codeVerifier: flow.codeVerifier, nonce: flow.nonce, userId: null });
      expect(await consumeOAuthFlow(t.db, params)).toBeNull();
    });

    it('rejects a callback from a different browser (login CSRF)', async () => {
      const flow = await startOAuthFlow(t.db, 'login');
      expect(await consumeOAuthFlow(t.db, { state: flow.state, purpose: 'login', bindingToken: 'other' })).toBeNull();
      expect(await consumeOAuthFlow(t.db, { state: flow.state, purpose: 'login', bindingToken: undefined })).toBeNull();
    });

    it('rejects expired flows and flows for another purpose', async () => {
      const flow = await startOAuthFlow(t.db, 'login');
      const wrongPurpose = { state: flow.state, purpose: 'connect' as const, bindingToken: flow.bindingToken };
      expect(await consumeOAuthFlow(t.db, wrongPurpose)).toBeNull();

      await t.pool.query(`update app.oauth_flows set expires_at = now() - interval '1 second'`);
      expect(await consumeOAuthFlow(t.db, { ...wrongPurpose, purpose: 'login' })).toBeNull();
    });

    it('stores only hashes of the state and browser binding', async () => {
      const flow = await startOAuthFlow(t.db, 'login');
      const { rows } = await t.pool.query('select state_hash, browser_binding_hash from app.oauth_flows');
      expect(rows[0]).toEqual({ state_hash: sha256Hex(flow.state), browser_binding_hash: sha256Hex(flow.bindingToken) });
    });
  });

  describe('users', () => {
    it('creates a user on first sign-in and reuses it after, keyed by Google sub', async () => {
      const created = await upsertGoogleUser(t.db, identity);
      const again = await upsertGoogleUser(t.db, { ...identity, email: 'renamed@gmail.com', name: 'Renamed' });

      expect(again.id).toBe(created.id);
      expect(again.email).toBe('renamed@gmail.com');
      const { rows } = await t.pool.query('select count(*)::int as n from app.users');
      expect(rows[0].n).toBe(1);
    });

    it('handles two first sign-ins racing without creating duplicates', async () => {
      const [a, b] = await Promise.all([upsertGoogleUser(t.db, identity), upsertGoogleUser(t.db, identity)]);
      expect(a.id).toBe(b.id);
    });
  });

  describe('sessions', () => {
    it('finds the user for a valid token and stores only its hash', async () => {
      const user = await upsertGoogleUser(t.db, identity);
      const session = await createSession(t.db, user.id);

      expect(await findSessionUser(t.db, session.token)).toMatchObject({ id: user.id, email: identity.email });
      const { rows } = await t.pool.query('select id_hash from app.sessions');
      expect(rows[0].id_hash).toBe(sha256Hex(session.token));
      expect(rows[0].id_hash).not.toBe(session.token);
    });

    it('rejects unknown, revoked, idle-expired and absolutely-expired sessions', async () => {
      const user = await upsertGoogleUser(t.db, identity);
      const start = new Date('2026-10-01T00:00:00Z');
      const session = await createSession(t.db, user.id, start);

      expect(await findSessionUser(t.db, 'not-a-real-token', start)).toBeNull();
      expect(await findSessionUser(t.db, undefined, start)).toBeNull();
      expect(await findSessionUser(t.db, session.token, new Date(start.getTime() + SESSION_IDLE_MS + 1))).toBeNull();

      await revokeSession(t.db, session.token);
      expect(await findSessionUser(t.db, session.token, start)).toBeNull();
    });

    it('slides the idle window on use but never past the absolute limit', async () => {
      const user = await upsertGoogleUser(t.db, identity);
      const start = new Date('2026-10-01T00:00:00Z');
      const session = await createSession(t.db, user.id, start);

      // Use the session every 6 days: each use keeps it alive…
      for (let day = 6; day < 30; day += 6) {
        const now = new Date(start.getTime() + day * 24 * 3600 * 1000);
        expect(await findSessionUser(t.db, session.token, now)).not.toBeNull();
      }
      // …until the 30-day absolute limit.
      expect(await findSessionUser(t.db, session.token, new Date(start.getTime() + SESSION_ABSOLUTE_MS + 1))).toBeNull();
    });
  });

  it('cleanup removes expired flows and long-dead sessions but keeps live ones', async () => {
    const user = await upsertGoogleUser(t.db, identity);
    await startOAuthFlow(t.db, 'login');
    const live = await createSession(t.db, user.id);
    await createSession(t.db, user.id, new Date('2020-01-01T00:00:00Z'));
    await t.pool.query(`update app.oauth_flows set expires_at = now() - interval '2 days'`);

    expect(await cleanupExpiredAuthData(t.db)).toEqual({ flows: 1, sessions: 1 });
    expect(await findSessionUser(t.db, live.token)).not.toBeNull();
  });
});
