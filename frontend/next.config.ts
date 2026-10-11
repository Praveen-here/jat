import type { NextConfig } from 'next';

/** Where the backend (API) runs. The browser only ever talks to the frontend's own origin. */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    // Same-origin /api keeps session cookies first-party (see docs/plan/05-frontend.md).
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
