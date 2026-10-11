import { fullJitterDelay, sleep as realSleep } from '../lib/retry';
import { TokenBucket } from '../sync/rate-limiter';

/**
 * Minimal Groq chat-completions client (OpenAI-compatible API) for structured outputs.
 *
 * Safety properties:
 *  - the API key is only ever sent in the Authorization header to api.groq.com;
 *  - errors carry status codes only, never request or response bodies (which contain email text);
 *  - temperature 0 and a strict JSON schema: the reply must match our form exactly;
 *  - client-side pacing keeps us under the free tier's tokens-per-minute limit, and Groq's
 *    `retry-after` is honoured.
 */
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Free-tier budget we pace to (Groq lists 8K tokens/min for gpt-oss-120b; keep headroom). */
export const GROQ_TOKENS_PER_MINUTE = 7_000;

export interface StructuredRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface LlmClient {
  readonly model: string;
  completeJson(request: StructuredRequest): Promise<string>;
}

/** Rate limit hit; try again after `retryAfterMs`. The work should be deferred, not dropped. */
export class AiRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`AI rate limited; retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'AiRateLimitedError';
  }
}

/** AI temporarily unavailable (network, 5xx). Defer and retry later. */
export class AiUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`AI unavailable: ${code}`);
    this.name = 'AiUnavailableError';
  }
}

/** The request or response was unusable (bad request, invalid output). Retrying won't help. */
export class AiBadResponseError extends Error {
  constructor(readonly code: string) {
    super(`AI response unusable: ${code}`);
    this.name = 'AiBadResponseError';
  }
}

export interface GroqClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  bucket?: TokenBucket;
  /** Waits shorter than this are slept through; longer ones defer the work. */
  maxInlineWaitMs?: number;
}

export class GroqClient implements LlmClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bucket: TokenBucket;
  private readonly maxInlineWaitMs: number;

  constructor(private readonly options: GroqClientOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.bucket = options.bucket ?? new TokenBucket(GROQ_TOKENS_PER_MINUTE, GROQ_TOKENS_PER_MINUTE / 60, Date.now, this.sleep);
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? 20_000;
  }

  async completeJson(request: StructuredRequest): Promise<string> {
    // Rough token estimate for pacing: about 4 characters per token in, plus a typical reply (about
    // 300 tokens; max_completion_tokens is only a ceiling). Overshooting is caught by Groq's 429 + retry-after.
    const estimate = Math.min(GROQ_TOKENS_PER_MINUTE, Math.ceil((request.system.length + request.user.length) / 4) + Math.min(300, request.maxOutputTokens));
    await this.bucket.take(estimate);

    const body = JSON.stringify({
      model: this.model,
      temperature: 0,
      max_completion_tokens: request.maxOutputTokens,
      reasoning_effort: 'low',
      include_reasoning: false,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
      },
    });

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        if (attempt < 2) {
          await this.sleep(1_000 + fullJitterDelay(attempt, 1_000, 8_000));
          continue;
        }
        throw new AiUnavailableError('network');
      }

      if (response.status === 429) {
        const retryAfterMs = Math.max(1, Number(response.headers.get('retry-after') ?? '30')) * 1000;
        if (retryAfterMs <= this.maxInlineWaitMs && attempt < 3) {
          await this.sleep(retryAfterMs);
          continue;
        }
        throw new AiRateLimitedError(retryAfterMs);
      }
      if (response.status >= 500) {
        if (attempt < 2) {
          await this.sleep(1_000 + fullJitterDelay(attempt, 1_000, 8_000));
          continue;
        }
        throw new AiUnavailableError(`http_${response.status}`);
      }
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
        throw new AiBadResponseError(`http_${response.status}_${error.error?.code ?? error.error?.type ?? 'error'}`);
      }

      const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) throw new AiBadResponseError('empty_response');
      return content;
    }
  }
}
