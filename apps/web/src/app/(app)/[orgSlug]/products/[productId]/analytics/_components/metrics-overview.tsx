import { cn } from '@/lib/utils';

/**
 * RIEPILOGO DELLE METRICHE — quattro numeri e il loro andamento.
 *
 * Componente server: non c'è interazione, non c'è ragione di spedirlo al
 * browser.
 *
 * UNA SCELTA DI PRESENTAZIONE CHE VALE LA PENA SPIEGARE: la posizione media
 * migliora quando SCENDE (dalla 12 alla 7 è un miglioramento), al contrario di
 * clic e impression. Una variazione colorata con la stessa regola per tutte e
 * quattro le metriche direbbe il falso su una di esse — è un errore comune nei
 * cruscotti SEO, e produce il tipo di grafico verde che accompagna un
 * peggioramento.
 */

export interface PeriodTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('it-IT');
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatPosition(value: number): string {
  return value > 0 ? value.toFixed(1) : '—';
}

/**
 * Variazione relativa fra due periodi.
 * `null` quando il periodo precedente è a zero: la variazione da zero non è
 * "+100%", è indefinita, e mostrarla come una percentuale enorme al primo mese
 * di dati sarebbe solo rumore.
 */
function change(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

function Delta({
  current,
  previous,
  /** Vero per la posizione media, dove un valore più basso è migliore. */
  lowerIsBetter = false,
}: {
  current: number;
  previous: number;
  lowerIsBetter?: boolean;
}) {
  const delta = change(current, previous);

  if (delta === null || Math.abs(delta) < 0.005) {
    return (
      <span className="text-xs text-foreground-muted">
        {delta === null ? 'nessun confronto' : 'stabile'}
      </span>
    );
  }

  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  const sign = delta > 0 ? '+' : '';

  return (
    <span
      className={cn(
        'text-xs font-medium',
        improved ? 'text-success-700' : 'text-danger-700',
      )}
    >
      {sign}
      {(delta * 100).toFixed(1)}%{' '}
      <span className="font-normal text-foreground-muted">vs periodo prec.</span>
    </span>
  );
}

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="text-xl font-semibold tabular-nums text-foreground">{value}</span>
      {children}
    </div>
  );
}

export function MetricsOverview({
  current,
  previous,
  windowDays,
}: {
  current: PeriodTotals;
  previous: PeriodTotals;
  windowDays: number;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        Ultimi {windowDays} giorni
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Clic" value={formatNumber(current.clicks)}>
          <Delta current={current.clicks} previous={previous.clicks} />
        </Tile>
        <Tile label="Impression" value={formatNumber(current.impressions)}>
          <Delta current={current.impressions} previous={previous.impressions} />
        </Tile>
        <Tile label="CTR medio" value={formatPercent(current.ctr)}>
          <Delta current={current.ctr} previous={previous.ctr} />
        </Tile>
        <Tile label="Posizione media" value={formatPosition(current.position)}>
          <Delta
            current={current.position}
            previous={previous.position}
            lowerIsBetter
          />
        </Tile>
      </div>
    </section>
  );
}
