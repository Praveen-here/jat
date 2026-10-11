import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Empty strings in .env ("GOOGLE_CLIENT_ID=") mean "not set yet". */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== '' ? value.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'is required (see .env.example)'),

  // Needed from later tasks; optional so the skeleton runs without them.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  TOKEN_ENCRYPTION_KEY: optionalString,
  HMAC_PEPPER: optionalString,

  // AI classification (Groq). Off unless a key is set; AI_ENABLED=false turns it off with a key.
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Finds the nearest .env walking up from the working directory (apps/server → repo root). */
function loadDotEnvFile(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      // Does not override variables already set in the real environment.
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

let cached: Env | undefined;

/**
 * Validates configuration once at startup. Error messages name the variable and the problem
 * but never echo values, because values may be secrets.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  loadDotEnvFile();
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  cached = result.data;
  return cached;
}
