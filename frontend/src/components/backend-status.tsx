'use client';

import { useEffect, useState } from 'react';

type State = 'checking' | 'ok' | 'degraded' | 'offline';

const LABELS: Record<State, string> = {
  checking: 'Checking backend…',
  ok: 'Backend and database connected',
  degraded: 'Backend up, database unreachable',
  offline: 'Backend not reachable',
};

const DOT: Record<State, string> = {
  checking: 'bg-ink-tertiary',
  ok: 'bg-status-offer-ink',
  degraded: 'bg-status-assessment-ink',
  offline: 'bg-status-rejected-ink',
};

/** Small development indicator: calls the backend through the /api proxy. */
export function BackendStatus() {
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health/ready', { cache: 'no-store' })
      .then((response) => {
        if (!cancelled) setState(response.ok ? 'ok' : response.status === 503 ? 'degraded' : 'offline');
      })
      .catch(() => {
        if (!cancelled) setState('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p role="status" className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[state]}`} />
      {LABELS[state]}
    </p>
  );
}
