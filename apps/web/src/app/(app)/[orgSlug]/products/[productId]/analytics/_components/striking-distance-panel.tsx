'use client';

import * as React from 'react';

import { promoteOpportunityAction } from '@/actions/analytics.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';

/**
 * OPPORTUNITÀ IN STRIKING DISTANCE.
 *
 * La tabella non è il punto: il punto è il bottone. Un elenco di query in
 * posizione 8-20 è un'osservazione; trasformarne una in keyword lavorabile con
 * un clic è ciò che chiude il ciclo fra i dati e la produzione di contenuti.
 *
 * La keyword promossa entra come *proposta*, non come lavoro schedulato — la
 * stessa porta di revisione umana già applicata alle keyword generate dall'AI.
 */

export interface OpportunityRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
  estimatedClickGain: number;
  rationale: string;
}

export function StrikingDistancePanel({
  productId,
  opportunities,
}: {
  productId: string;
  opportunities: OpportunityRow[];
}) {
  const [promotedQueries, setPromotedQueries] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [promotingQuery, setPromotingQuery] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  function handlePromote(row: OpportunityRow) {
    setError(null);
    setPromotingQuery(row.query);

    React.startTransition(async () => {
      const result = await promoteOpportunityAction({
        productId,
        term: row.query,
        impressions: row.impressions,
        position: row.position,
      });

      setPromotingQuery(null);

      if (result.ok) {
        setPromotedQueries((current) => new Set(current).add(row.query));
      } else {
        setError(result.message);
      }
    });
  }

  if (opportunities.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Opportunità vicine</h2>
        <p className="text-sm text-foreground-muted">
          Nessuna query fra l’ottava e la ventesima posizione con abbastanza
          impression da valere un intervento. Succede quando i dati sono ancora
          pochi: torna qui dopo qualche settimana di raccolta.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          Opportunità vicine ({opportunities.length})
        </h2>
        <p className="text-xs text-foreground-muted">
          Ricerche su cui il sito compare già fra l’ottava e la ventesima posizione.
          Google le considera pertinenti: mancano posizioni, non un argomento nuovo.
        </p>
      </div>

      <FormError messages={error} />

      <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
        {opportunities.map((row) => {
          const isPromoted = promotedQueries.has(row.query);
          const isOpen = expanded === row.query;

          return (
            <li key={`${row.query}-${row.page}`} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm text-foreground">{row.query}</span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-foreground-muted">
                    <span>Posizione {row.position.toFixed(1)}</span>
                    <span>{row.impressions.toLocaleString('it-IT')} impression</span>
                    <span>{row.clicks.toLocaleString('it-IT')} clic</span>
                    {row.estimatedClickGain > 0 ? (
                      <span className="font-medium text-success-700">
                        +{row.estimatedClickGain.toLocaleString('it-IT')} clic stimati
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : row.query)}
                  >
                    {isOpen ? 'Nascondi' : 'Perché'}
                  </Button>
                  {isPromoted ? (
                    <span className="text-xs font-medium text-success-700">
                      Aggiunta alle proposte
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      isLoading={promotingQuery === row.query}
                      loadingLabel="Aggiunta in corso"
                      onClick={() => handlePromote(row)}
                    >
                      Aggiungi alle keyword
                    </Button>
                  )}
                </div>
              </div>

              {isOpen ? (
                <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-surface-muted px-3 py-2">
                  <p className="text-xs text-foreground">{row.rationale}</p>
                  <p className="break-all text-xs text-foreground-muted">{row.page}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
