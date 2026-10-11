import type { Logger } from '../lib/logger';
import { getRuntime } from '../runtime';

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiErrorBody, { status });
}

type Handler<Ctx> = (request: Request, context: Ctx) => Promise<Response>;

interface ApiRouteDeps {
  getLogger: () => Logger;
}

const defaultDeps: ApiRouteDeps = { getLogger: () => getRuntime().logger };

/**
 * Wraps every API route handler: request ID, one access-log line, and a safe 500 for
 * unexpected errors. The log uses the route *name*, never the URL: OAuth callbacks carry
 * codes in the query string.
 */
export function apiRoute<Ctx = unknown>(routeName: string, handler: Handler<Ctx>, deps: ApiRouteDeps = defaultDeps) {
  return async (request: Request, context: Ctx): Promise<Response> => {
    const startedAt = performance.now();
    const reqId = crypto.randomUUID();
    const logger = deps.getLogger();

    let response: Response;
    try {
      response = await handler(request, context);
    } catch (err) {
      logger.error({ err, reqId, route: routeName }, 'unhandled error in API route');
      response = jsonError(500, 'INTERNAL', 'Something went wrong. Please try again.');
    }

    try {
      response.headers.set('X-Request-Id', reqId);
    } catch {
      // Some responses (e.g. Response.redirect) have immutable headers: copy, then set.
      response = new Response(response.body, response);
      response.headers.set('X-Request-Id', reqId);
    }
    logger.info(
      {
        reqId,
        method: request.method,
        route: routeName,
        statusCode: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'request',
    );
    return response;
  };
}
