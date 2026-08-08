'use client';

import * as React from 'react';

import { resolveCannibalizationAction } from '@/actions/analytics.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { cn } from '@/lib/utils';

/**
 * CANNIBALIZZAZIONI APERTE.
 *
 * L'azione qui NON esegue la correzione: registra come l'utente ha deciso di
 * gestirla e chiude la segnalazione. Unire due articoli pubblicati o riscrivere
 * un canonical è irreversibile e dipende da conoscenze che il sistema non ha —
 * stessa ragione per cui brief e bozze passano da un cancello umano.
 *
 * `Ignora` è un esito legittimo e non una scorciatoia: a volte due pagine
 * competono per una scelta voluta (una pagina prodotto e una guida). Senza
 * quell'opzione l'unico modo di togliere la riga sarebbe fingere di aver fatto
 * qualcosa.
 */

export interface CannibalizationRow {
  id: string;
  query: string;
  competingPages: Array<{
    page: string;
    clicks: number;
    impressions: number;
    position: number;
  }>;
  severity: string;
  recommendedAction: string;
}

const SEVERITY_LABEL: Record<string, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Bassa',
};

const SEVERITY_STYLE: Record<string, string> = {
  high: 'bg-danger-100 text-danger-700',
  medium: 'bg-accent-100 text-accent-900',
  low: 'bg-surface-muted text-foreground-muted',
};

const ACTION_LABEL: Record<string, string> = {
  merge: 'Unire in un solo articolo',
  differentiate: 'Differenziare l’intento',
  canonicalize: 'Dichiarare una pagina canonica',
  ignore: 'Ignorare',
};

export function CannibalizationPanel({
  issues,
}: {
  issues: CannibalizationRow[];
}) {
  const [resolvedIds, setResolvedIds] = React.useState<Set<string>>(() => new Set());
  const [resolvingId, setResolvingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const visible = issues.filter((issue) => !resolvedIds.has(issue.id));

  function handleResolve(
    issueId: string,
    resolvedAction: 'merge' | 'differentiate' | 'canonicalize' | 'ignore',
  ) {
    setError(null);
    setResolvingId(issueId);

    React.startTransition(async () => {
      const result = await resolveCannibalizationAction({ issueId, resolvedAction });
      setResolvingId(null);

      if (result.ok) {
        setResolvedIds((current) => new Set(current).add(issueId));
      } else {
        setError(result.message);
      }
    });
  }

  if (visible.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Conflitti fra pagine</h2>
        <p className="text-sm text-foreground-muted">
          Nessun conflitto aperto: per ogni ricerca c’è una sola pagina del sito
          che compete davvero.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          Conflitti fra pagine ({visible.length})
        </h2>
        <p className="text-xs text-foreground-muted">
          Più pagine del sito competono sulla stessa ricerca. Google ne sceglie una
          sola: le altre dividono i segnali invece di sommarli.
        </p>
      </div>

      <FormError messages={error} />

      <ul className="flex flex-col gap-3">
        {visible.map((issue) => (
          <li
            key={issue.id}
            className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                «{issue.query}»
              </span>
              <span
                className={cn(
                  'rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium',
                  SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.low,
                )}
              >
                Gravità {SEVERITY_LABEL[issue.severity] ?? issue.severity}
              </span>
            </div>

            <ul className="flex flex-col gap-1">
              {issue.competingPages.map((page, index) => (
                <li
                  key={page.page}
                  className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                >
                  <span className="break-all text-foreground-muted">
                    {index === 0 ? '★ ' : '· '}
                    {page.page}
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground-muted">
                    pos. {page.position.toFixed(1)} · {page.clicks} clic ·{' '}
                    {page.impressions.toLocaleString('it-IT')} impr.
                  </span>
                </li>
              ))}
            </ul>

            <p className="text-xs text-foreground-muted">
              Consigliato:{' '}
              <span className="font-medium text-foreground">
                {ACTION_LABEL[issue.recommendedAction] ?? issue.recommendedAction}
              </span>
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-foreground-muted">Come l’hai gestita?</span>
              {(['merge', 'differentiate', 'canonicalize', 'ignore'] as const).map(
                (action) => (
                  <Button
                    key={action}
                    type="button"
                    size="sm"
                    variant={
                      action === issue.recommendedAction ? 'outline' : 'ghost'
                    }
                    isLoading={resolvingId === issue.id}
                    loadingLabel="…"
                    onClick={() => handleResolve(issue.id, action)}
                  >
                    {ACTION_LABEL[action]}
                  </Button>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
