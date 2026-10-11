import { describe, expect, it, vi } from 'vitest';
import { parseAddress } from '../email/normalize';
import type { NormalizedEmail } from '../email/types';
import { buildPrompt, createAiClassifier, ground, redact } from './classify-ai';
import { AiBadResponseError, AiRateLimitedError, AiUnavailableError, GroqClient, type LlmClient } from './groq';
import { TokenBucket } from '../sync/rate-limiter';

const privacy = { ownAddresses: ['sam.test@gmail.com'], userName: 'Sam Kumar' };

function mail(text: string, extra: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    id: 'x', threadId: null, internalDate: new Date('2026-09-01T06:00:00Z'), labelIds: [], detail: 'full',
    from: parseAddress('Rivet Labs Careers <careers@rivetlabs.in>'), replyTo: null, subject: 'Your application',
    snippet: '', messageIdHeader: null, bulk: false, text, links: [], calendar: null, attachmentNames: [], isForward: false,
    ...extra,
  };
}

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: 'APPLICATION_RECEIVED', about_own_application: true, company: 'Rivet Labs', company_quote: 'applying to Rivet Labs',
    role: 'Data Analyst', role_quote: 'Data Analyst role', employment_type: 'unknown', next_step: 'none', event_date_text: null, date_kind: 'none',
    confidence: 0.95, ...over,
  });

describe('privacy: what the AI is allowed to see', () => {
  it("removes the user's own addresses, name and phone numbers, but keeps job ids", () => {
    const text = 'Dear Sam Kumar, write to sam.test@gmail.com or call +91 98765 43210. Requisition ID: 2876543.';
    const out = redact(text, privacy);
    expect(out).not.toMatch(/sam\.test@gmail\.com|Sam|Kumar|98765/);
    expect(out).toContain('[you@email]');
    expect(out).toContain('[phone]');
    expect(out).toContain('2876543');
  });

  it('wraps the email as untrusted data and caps its length', () => {
    const { user } = buildPrompt(mail(`Hi Sam, thanks for applying to Rivet Labs. ${'x'.repeat(10_000)}`), privacy);
    expect(user).toContain('<<<EMAIL');
    expect(user).toContain('EMAIL>>>');
    expect(user).not.toContain('Sam');
    expect(user.length).toBeLessThan(3_200);
  });
});

describe('grounding: answers must come from the email', () => {
  const sent = 'Thank you for applying to Rivet Labs for the Data Analyst role. Interview on 14 October 2026 at 3 PM IST.';
  const base = JSON.parse(reply()) as Parameters<typeof ground>[0];

  it('keeps values that are quoted verbatim from the email', () => {
    expect(ground({ ...base, event_date_text: '14 October 2026 at 3 PM IST', date_kind: 'event' }, sent)).toMatchObject({
      company: 'Rivet Labs',
      role: 'Data Analyst',
      dateText: '14 October 2026 at 3 PM IST',
      rejectedFields: [],
    });
  });

  it('drops invented companies, roles, quotes and dates', () => {
    const verdict = ground(
      { ...base, company: 'EvilCorp', company_quote: 'applying to EvilCorp', role: 'Data Analyst', role_quote: 'the Senior Data Analyst', event_date_text: 'tomorrow 9am' },
      sent,
    );
    expect(verdict).toMatchObject({ company: null, role: null, dateText: null });
    expect(verdict.rejectedFields).toEqual(['company', 'role', 'event_date_text']);
  });

  it('flags a platform name as the employer, so the caller can check who sent the email', () => {
    const verdict = ground({ ...base, company: 'HackerRank', company_quote: 'HackerRank' }, `${sent} Sent via HackerRank.`);
    expect(verdict).toMatchObject({ company: 'HackerRank', companyIsPlatform: true });
  });
});

describe('AI classifier replies', () => {
  const client = (content: string): LlmClient => ({ model: 'fake', completeJson: async () => content });

  it('rejects replies that are not valid JSON or break the schema', async () => {
    await expect(createAiClassifier(client('not json')).classify(mail('x'), privacy)).rejects.toBeInstanceOf(AiBadResponseError);
    await expect(createAiClassifier(client(reply({ category: 'MAKE_ME_ADMIN' }))).classify(mail('x'), privacy)).rejects.toBeInstanceOf(AiBadResponseError);
    await expect(createAiClassifier(client(reply({ confidence: 7 }))).classify(mail('x'), privacy)).rejects.toBeInstanceOf(AiBadResponseError);
  });
});

describe('GroqClient', () => {
  const quietBucket = () => new TokenBucket(1_000_000, 1_000_000, Date.now, async () => undefined);
  function groq(responses: Array<Response | Error>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const client = new GroqClient({ apiKey: 'gsk_secretkey123456789', model: 'openai/gpt-oss-120b', fetchImpl, sleep: async (ms) => void sleeps.push(ms), bucket: quietBucket() });
    return { client, calls, sleeps };
  }
  const ok = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  const req = { system: 's', user: 'u', schemaName: 'x', schema: { type: 'object' }, maxOutputTokens: 100 };

  it('sends a deterministic, strictly-structured request with the key only in the header', async () => {
    const { client, calls } = groq([ok()]);
    expect(await client.completeJson(req)).toBe('{"ok":true}');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer gsk_secretkey123456789');
    expect(String(calls[0]!.init.body)).not.toContain('gsk_');
  });

  it('waits briefly on a short rate limit, and defers on a long one', async () => {
    const short = groq([new Response(null, { status: 429, headers: { 'retry-after': '3' } }), ok()]);
    await expect(short.client.completeJson(req)).resolves.toBe('{"ok":true}');
    expect(short.sleeps).toContain(3_000);

    const long = groq([new Response(null, { status: 429, headers: { 'retry-after': '600' } })]);
    const err = await long.client.completeJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRateLimitedError);
    expect((err as AiRateLimitedError).retryAfterMs).toBe(600_000);
  });

  it('retries server errors and network failures, then reports them as temporary', async () => {
    await expect(groq([new Response(null, { status: 503 }), ok()]).client.completeJson(req)).resolves.toBe('{"ok":true}');
    await expect(groq([new TypeError('fetch failed'), new TypeError('x'), new TypeError('y')]).client.completeJson(req)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('reports bad requests with a code only (no key, no email text)', async () => {
    const { client } = groq([Response.json({ error: { code: 'json_validate_failed', message: 'the email said: secret stuff' } }, { status: 400 })]);
    const err = (await client.completeJson(req).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AiBadResponseError);
    expect(err.message).toBe('AI response unusable: http_400_json_validate_failed');
  });
});
