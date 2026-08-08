/**
 * SEGMENTAZIONE PER PAESE E DISPOSITIVO.
 *
 * I dati arrivavano da Search Console fin dal primo import e finivano in
 * `gsc_daily_metrics.country` / `.device` senza che nessuna vista li leggesse.
 * Questo pannello non costa una chiamata in più all'API: legge quello che
 * c'era già.
 *
 * A cosa serve davvero: la posizione media aggregata nasconde le differenze
 * fra mobile e desktop, che su molti settori sono ampie. Un sito che risulta
 * in quinta posizione può essere terzo su desktop e nono su mobile — e in quel
 * caso il problema non è il contenuto.
 *
 * Componente server: nessuna interazione.
 */

export interface SegmentRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Etichette leggibili per i valori che Search Console restituisce in maiuscolo. */
const DEVICE_LABEL: Record<string, string> = {
  MOBILE: 'Mobile',
  DESKTOP: 'Desktop',
  TABLET: 'Tablet',
};

/**
 * Search Console usa codici ISO-3166-1 alpha-3, che non sono quelli attesi da
 * `Intl.DisplayNames` (alpha-2). La mappa copre i mercati più probabili per
 * questa piattaforma; per tutto il resto mostriamo il codice, che resta
 * comprensibile — meglio di un nome sbagliato.
 */
const COUNTRY_LABEL: Record<string, string> = {
  ita: 'Italia',
  usa: 'Stati Uniti',
  gbr: 'Regno Unito',
  deu: 'Germania',
  fra: 'Francia',
  esp: 'Spagna',
  che: 'Svizzera',
  aut: 'Austria',
  bel: 'Belgio',
  nld: 'Paesi Bassi',
  prt: 'Portogallo',
  grc: 'Grecia',
  hrv: 'Croazia',
  svn: 'Slovenia',
  rou: 'Romania',
  pol: 'Polonia',
  can: 'Canada',
  aus: 'Australia',
  bra: 'Brasile',
  arg: 'Argentina',
  mex: 'Messico',
  ind: 'India',
};

function label(key: string, kind: 'country' | 'device'): string {
  if (kind === 'device') return DEVICE_LABEL[key.toUpperCase()] ?? key;
  return COUNTRY_LABEL[key.toLowerCase()] ?? key.toUpperCase();
}

function SegmentList({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: SegmentRow[];
  kind: 'country' | 'device';
}) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-sm text-foreground-muted">Nessun dato nel periodo.</p>
      </div>
    );
  }

  // La barra è proporzionale al massimo della lista, non al totale: con una
  // voce dominante tutte le altre risulterebbero invisibili.
  const maxClicks = Math.max(...rows.map((r) => r.clicks), 1);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-1.5 px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-foreground">{label(row.key, kind)}</span>
              <span className="shrink-0 text-xs tabular-nums text-foreground-muted">
                {row.clicks.toLocaleString('it-IT')} clic · CTR{' '}
                {(row.ctr * 100).toFixed(1)}% · pos. {row.position.toFixed(1)}
              </span>
            </div>
            {/* Barra decorativa: il dato è già nel testo accanto, quindi
                `aria-hidden` — uno screen reader lo leggerebbe due volte. */}
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-surface-muted"
              aria-hidden="true"
            >
              <div
                className="h-full rounded-full bg-base-900"
                style={{ width: `${Math.max(2, (row.clicks / maxClicks) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SegmentBreakdown({
  countries,
  devices,
}: {
  countries: SegmentRow[];
  devices: SegmentRow[];
}) {
  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <SegmentList title="Per paese" rows={countries} kind="country" />
      <SegmentList title="Per dispositivo" rows={devices} kind="device" />
    </section>
  );
}
