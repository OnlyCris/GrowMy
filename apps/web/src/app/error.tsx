'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

/**
 * ERROR BOUNDARY GLOBALE
 *
 * Regola di progetto: mai esporre uno stack trace.
 *
 * Next.js in produzione sostituisce automaticamente `error.message` con un
 * testo generico e lascia solo `error.digest`, che è un hash correlabile alla
 * riga di log lato server. Noi mostriamo esclusivamente quel digest: è
 * sufficiente al supporto per trovare l'errore completo, e non rivela nulla
 * sulla struttura interna a chi guarda la pagina.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /**
     * In sviluppo mostriamo l'errore reale in console, dove serve.
     * In produzione l'errore è già stato loggato lato server con il digest:
     * rilogarlo dal browser aggiungerebbe rumore senza informazione.
     */
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- utile solo in sviluppo.
      console.error('[error boundary]', error);
    }
  }, [error]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-danger-100">
          <AlertTriangle className="size-6 text-danger-700" aria-hidden="true" />
        </span>

        <h1 className="text-lg font-semibold text-foreground">
          Qualcosa è andato storto
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
          L’errore è stato registrato e lo stiamo già guardando. Nel frattempo
          puoi riprovare: nessun dato è andato perso.
        </p>

        {error.digest ? (
          <p className="mt-4 text-2xs text-foreground-subtle">
            Codice di riferimento{' '}
            <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono">
              {error.digest}
            </code>
          </p>
        ) : null}

        <div className="mt-6 flex justify-center gap-2">
          <Button variant="primary" size="md" onClick={reset}>
            <RotateCcw aria-hidden="true" />
            Riprova
          </Button>
          <Button variant="outline" size="md" asChild>
            <a href="/">Torna alla dashboard</a>
          </Button>
        </div>
      </div>
    </main>
  );
}
