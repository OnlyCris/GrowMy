import Link from 'next/link';

/**
 * PAGINE VISIBILI MA NON CLICCATE.
 *
 * Sta accanto allo striking distance ma dice l'opposto, e la distinzione è il
 * motivo per cui questo pannello esiste separato invece che come colonna in più
 * in quella tabella: lì il posizionamento è da conquistare, qui è già stato
 * conquistato e viene sprecato. L'azione è riscrivere titolo e descrizione, non
 * l'articolo — confondere i due casi manda a rifare contenuti che funzionano.
 *
 * Componente server: l'unica interazione è il link all'articolo.
 */

export interface CtrGapRow {
  query: string;
  page: string;
  articleId: string | null;
  clicks: number;
  impressions: number;
  position: number;
  expectedCtr: number;
  actualCtr: number;
  missedClicks: number;
  rationale: string;
}

export function CtrGapPanel({
  issues,
  orgSlug,
  productId,
}: {
  issues: CtrGapRow[];
  orgSlug: string;
  productId: string;
}) {
  if (issues.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          Visibili ma non cliccate
        </h2>
        <p className="text-sm text-foreground-muted">
          Nessuna pagina rende molto meno di quanto la sua posizione prometta.
          Gli snippet stanno facendo il loro lavoro.
        </p>
      </section>
    );
  }

  const totalMissed = issues.reduce((sum, row) => sum + row.missedClicks, 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          Visibili ma non cliccate ({issues.length})
        </h2>
        <p className="text-xs text-foreground-muted">
          Pagine già in prima pagina che ricevono molti meno clic di quanti quella
          posizione porti di solito. Il posizionamento non è il problema: lo sono
          titolo e descrizione mostrati nei risultati. Circa{' '}
          <span className="font-medium text-foreground">
            {totalMissed.toLocaleString('it-IT')} clic
          </span>{' '}
          mancati nel periodo.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
        {issues.map((row) => (
          <li key={`${row.query}-${row.page}`} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <span className="text-sm text-foreground">{row.query}</span>
              <span className="shrink-0 text-xs font-medium text-danger-700">
                −{row.missedClicks.toLocaleString('it-IT')} clic stimati
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-foreground-muted">
              <span>Posizione {row.position.toFixed(1)}</span>
              <span>
                CTR {(row.actualCtr * 100).toFixed(1)}% contro{' '}
                {(row.expectedCtr * 100).toFixed(1)}% atteso
              </span>
              <span>{row.impressions.toLocaleString('it-IT')} impression</span>
            </div>

            <p className="text-xs text-foreground-muted">{row.rationale}</p>

            {row.articleId ? (
              <Link
                href={`/${orgSlug}/products/${productId}/articles/${row.articleId}`}
                className="text-xs text-info-700 underline-offset-4 hover:underline"
              >
                Apri l’articolo per correggere titolo e descrizione
              </Link>
            ) : (
              <span className="break-all text-xs text-foreground-muted">{row.page}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
