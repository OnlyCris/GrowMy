'use client';

import * as React from 'react';

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'a momenti';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Conto alla rovescia live verso un istante reale (`jobs.next_retry_at`),
 * non una stima decorativa: è il timestamp che il worker userà davvero per
 * il prossimo tentativo automatico (vedi `handleJob` in `apps/worker/src/
 * index.ts`). Si aggiorna ogni secondo lato client — nessun bisogno di
 * ricontattare il server solo per far scorrere i numeri.
 */
export function Countdown({ to }: { to: string | Date }) {
  const target = React.useMemo(() => new Date(to).getTime(), [to]);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="tabular">{formatRemaining(target - now)}</span>;
}
