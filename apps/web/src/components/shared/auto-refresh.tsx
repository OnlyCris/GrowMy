'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

/**
 * Ricarica silenziosamente i dati della pagina (`router.refresh`) a
 * intervalli regolari finché `enabled` resta vero. Serve per gli esiti dei
 * job in background che il server non può notificare al client in questa
 * architettura (ricerca keyword, health check di un'integrazione): senza,
 * l'unico modo per vederli è ricaricare la pagina a mano.
 *
 * Si ferma da sola dopo `maxPolls` cicli per non interrogare all'infinito
 * un job che non risponde più — il chiamante resta comunque responsabile di
 * far diventare `enabled` falso non appena i dati attesi arrivano.
 */
export function AutoRefresh({
  enabled,
  intervalMs = 5000,
  maxPolls = 24,
}: {
  enabled: boolean;
  intervalMs?: number;
  maxPolls?: number;
}) {
  const router = useRouter();

  React.useEffect(() => {
    if (!enabled) return;

    let polls = 0;
    const id = setInterval(() => {
      polls += 1;
      if (polls > maxPolls) {
        clearInterval(id);
        return;
      }
      router.refresh();
    }, intervalMs);

    return () => clearInterval(id);
  }, [enabled, intervalMs, maxPolls, router]);

  return null;
}
