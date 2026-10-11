import type { NextConfig } from 'next';

/**
 * The backend is a Next.js app that serves API routes only (no pages).
 * The browser never calls it directly: the frontend proxies /api/* here.
 */
const config: NextConfig = {
  poweredByHeader: false,
  // Next's dev request log prints full URLs, and OAuth callbacks carry one-time codes in the
  // query string. Our own access log (server/http/api-route.ts) records route names only.
  logging: { incomingRequests: false },
  // Node-only libraries: load them at runtime instead of bundling them.
  serverExternalPackages: ['pino', 'pino-pretty', 'pg', 'pg-boss', 'kysely'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
