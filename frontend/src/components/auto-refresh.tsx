'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-renders the page from the server every few seconds while something is in progress. */
export function AutoRefresh({ active, intervalMs = 5_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
