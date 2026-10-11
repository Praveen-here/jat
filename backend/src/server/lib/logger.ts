import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Logging policy: logs must never contain email content, email addresses, OAuth tokens or
 * secrets. Two layers enforce it:
 *
 * 1. An allowlist of field names. String/object values under any other key are replaced with
 *    "[redacted]". Numbers and booleans are kept (counters, durations, flags are safe).
 * 2. Every string that is kept (including the message) is scrubbed for email addresses,
 *    Google/JWT/Bearer tokens, connection strings and OAuth query parameters.
 *
 * To log a new field, add its name here and make sure its values can never carry user data.
 */
const SAFE_KEYS = new Set([
  // pino internals
  'level', 'time', 'pid', 'hostname', 'msg',
  // identifiers (internal UUIDs only, never email addresses)
  'service', 'reqId', 'userId', 'accountId', 'applicationId', 'jobId', 'runId', 'queue',
  // HTTP
  'method', 'route', 'statusCode', 'durationMs', 'port',
  // operational
  'status', 'code', 'errorCode', 'attempt', 'count', 'version', 'migration', 'phase', 'err',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

const SCRUBBERS: Array<[RegExp, string]> = [
  [/postgres(?:ql)?:\/\/\S+/gi, '[connection-string]'],
  [/([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, `$1${REDACTED}`],
  [/\b(?:Bearer|Basic)\s+[\w.~+/=-]+/gi, '[auth-header]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]+/g, '[jwt]'],
  [/\bya29\.[\w.-]+/g, '[google-access-token]'],
  [/\bgsk_[A-Za-z0-9]{10,}/g, '[groq-api-key]'],
  [/\b1\/\/[\w.-]{10,}/g, '[google-refresh-token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

export function scrubString(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SCRUBBERS) output = output.replace(pattern, replacement);
  return output;
}

function sanitizeError(value: unknown, includeStack: boolean): Record<string, unknown> {
  const source = (value ?? {}) as { name?: unknown; type?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const out: Record<string, unknown> = {
    type: typeof source.name === 'string' ? source.name : typeof source.type === 'string' ? source.type : 'Error',
  };
  if (typeof source.code === 'string' || typeof source.code === 'number') out.code = source.code;
  if (typeof source.message === 'string') out.message = scrubString(source.message);
  if (includeStack && typeof source.stack === 'string') out.stack = scrubString(source.stack);
  return out;
}

function sanitizeValue(value: unknown, keyIsSafe: boolean, depth: number, includeStack: boolean): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return keyIsSafe ? scrubString(value) : REDACTED;
  if (!keyIsSafe || depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, keyIsSafe, depth + 1, includeStack));
  }
  if (value instanceof Error) return sanitizeError(value, includeStack);
  if (typeof value === 'object') return sanitizeObject(value as Record<string, unknown>, depth + 1, includeStack);
  return REDACTED;
}

export function sanitizeObject(
  input: Record<string, unknown>,
  depth = 0,
  includeStack = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'err' || key === 'error') {
      out.err = sanitizeError(value, includeStack);
      continue;
    }
    out[key] = sanitizeValue(value, SAFE_KEYS.has(key), depth, includeStack);
  }
  return out;
}

export interface LoggerOptions {
  level: string;
  service: string;
  pretty?: boolean;
  includeStack?: boolean;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const includeStack = options.includeStack ?? false;
  const logger = pino(
    {
      level: options.level,
      base: { service: options.service },
      // `err` is already sanitised by formatters.log; pino's default serializer would re-wrap it.
      serializers: { err: (value: unknown) => value },
      formatters: {
        bindings: (bindings) => sanitizeObject(bindings, 0, includeStack),
        log: (object) => sanitizeObject(object, 0, includeStack),
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg));
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
      ...(options.pretty && !options.destination
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    options.destination,
  );

  // pino skips formatters.bindings for child loggers, so sanitise child bindings here. Children
  // inherit this method through the prototype chain, so grandchildren are covered too.
  const pinoChild = logger.child;
  logger.child = function sanitizedChild(this: Logger, bindings, childOptions) {
    return pinoChild.call(this, sanitizeObject(bindings, 0, includeStack), childOptions);
  } as Logger['child'];

  return logger;
}

export type { Logger };
