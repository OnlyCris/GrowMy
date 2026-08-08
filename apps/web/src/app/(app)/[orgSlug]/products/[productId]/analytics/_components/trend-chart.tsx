'use client';

import * as React from 'react';

/**
 * ANDAMENTO GIORNALIERO.
 *
 * TRE GRAFICI SEPARATI, NON UNO CON PIÙ ASSI. Clic e impression differiscono
 * di uno o due ordini di grandezza: sovrapporli costringerebbe a un secondo
 * asse y, e un doppio asse permette di far raccontare alla stessa coppia di
 * curve qualunque storia si voglia semplicemente scegliendo le scale. Le due
 * serie qui non si incrociano mai perché non condividono un piano — ognuna ha
 * il proprio, con la propria scala onesta.
 *
 * LA POSIZIONE HA L'ASSE ROVESCIATO: il valore 1 sta in alto. È l'unica
 * metrica in cui "meglio" significa "più piccolo", e disegnarla come le altre
 * mostrerebbe un miglioramento come una discesa. Stessa convenzione di Search
 * Console, quindi il confronto con l'originale non richiede una traduzione
 * mentale.
 *
 * I GIORNI SENZA DATI INTERROMPONO LA LINEA invece di valere zero. Un buco dice
 * "non abbiamo dati", uno zero dice "nessun traffico": confonderli fa sembrare
 * un ritardo di sincronizzazione un crollo di posizionamento.
 *
 * COLORE: `currentColor`, cioè il token di testo dell'applicazione. È già
 * validato per contrasto in chiaro e in scuro, quindi il grafico segue il tema
 * senza introdurre una tinta nuova da verificare. Serie singola per grafico:
 * l'identità la porta il titolo, non il colore — nessuna legenda necessaria.
 */

export interface DailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number;
}

const HEIGHT = 116;
const PADDING = { top: 10, right: 8, bottom: 18, left: 8 };

type Measure = 'clicks' | 'impressions' | 'position';

const MEASURE_LABEL: Record<Measure, string> = {
  clicks: 'Clic',
  impressions: 'Impression',
  position: 'Posizione media',
};

function formatValue(measure: Measure, value: number): string {
  if (measure === 'position') return value.toFixed(1);
  return Math.round(value).toLocaleString('it-IT');
}

function formatDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

/** Serie continua sull'intero intervallo: i giorni mancanti restano `null`. */
function buildSeries(
  points: DailyPoint[],
  measure: Measure,
): Array<{ date: string; value: number | null }> {
  if (points.length === 0) return [];

  const byDate = new Map(points.map((p) => [p.date, p]));
  const first = new Date(`${points[0].date}T00:00:00Z`);
  const last = new Date(`${points[points.length - 1].date}T00:00:00Z`);

  const series: Array<{ date: string; value: number | null }> = [];
  for (
    let cursor = new Date(first);
    cursor <= last;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const iso = cursor.toISOString().slice(0, 10);
    const point = byDate.get(iso);
    series.push({ date: iso, value: point ? point[measure] : null });
  }
  return series;
}

/**
 * Ogni grafico misura il PROPRIO contenitore invece di ricevere una frazione
 * della larghezza totale. La griglia passa da una a tre colonne al breakpoint
 * `lg`: dividere per tre a prescindere produceva su mobile tre grafici larghi
 * un terzo dentro una colonna piena.
 */
function useMeasuredWidth() {
  const ref = React.useRef<HTMLElement>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function Sparkline({
  measure,
  points,
}: {
  measure: Measure;
  points: DailyPoint[];
}) {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const { ref, width } = useMeasuredWidth();

  const series = React.useMemo(() => buildSeries(points, measure), [points, measure]);

  const innerWidth = Math.max(1, width - PADDING.left - PADDING.right);
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const values = series
    .map((s) => s.value)
    .filter((v): v is number => v !== null);

  if (values.length === 0) return null;

  const inverted = measure === 'position';
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);

  // Clic e impression partono da zero: una baseline mobile esagera le
  // oscillazioni e fa sembrare drammatica una variazione del 3%. La posizione
  // no — parte dal suo intervallo reale, perché lo zero non esiste.
  const domainMin = inverted ? Math.max(0, rawMin - 1) : 0;
  const domainMax = inverted ? rawMax + 1 : Math.max(rawMax, 1);
  const span = Math.max(domainMax - domainMin, 0.001);

  const x = (index: number) =>
    PADDING.left +
    (series.length === 1 ? innerWidth / 2 : (index / (series.length - 1)) * innerWidth);

  const y = (value: number) => {
    const ratio = (value - domainMin) / span;
    // Rovesciato: per la posizione il valore più basso (migliore) sta in alto.
    return PADDING.top + (inverted ? ratio : 1 - ratio) * innerHeight;
  };

  // Sottopercorsi separati: la linea si interrompe sui giorni senza dati.
  const segments: string[] = [];
  let current: string[] = [];
  series.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'} ${x(index)} ${y(point.value)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  function handleMove(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left - PADDING.left;
    const ratio = Math.max(0, Math.min(1, offset / innerWidth));
    setHoverIndex(Math.round(ratio * (series.length - 1)));
  }

  return (
    <figure ref={ref} className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {MEASURE_LABEL[measure]}
        </span>
        <span className="text-xs tabular-nums text-foreground-muted">
          {hovered?.value != null
            ? `${formatDate(hovered.date)} · ${formatValue(measure, hovered.value)}`
            : inverted
              ? `min ${formatValue(measure, rawMin)} · max ${formatValue(measure, rawMax)}`
              : `max ${formatValue(measure, rawMax)}`}
        </span>
      </figcaption>

      {/* Al primo render la larghezza non è ancora nota: riserviamo lo spazio
          con un blocco vuoto invece di disegnare a zero, che produrrebbe uno
          scatto di layout appena il ResizeObserver risponde. */}
      {width <= 0 ? (
        <div style={{ height: HEIGHT }} />
      ) : (
      <svg
        width={width}
        height={HEIGHT}
        // Il grafico è decorativo rispetto alla tabella in fondo alla sezione,
        // che porta gli stessi numeri in forma leggibile da uno screen reader.
        role="presentation"
        className="touch-none text-foreground"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {/* Griglia minima: due sole linee, in colore di bordo. Un reticolo
            completo compete con il dato invece di sostenerlo. */}
        <line
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={PADDING.top}
          y2={PADDING.top}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={HEIGHT - PADDING.bottom}
          y2={HEIGHT - PADDING.bottom}
          className="stroke-border"
          strokeWidth={1}
        />

        {segments.map((d, index) => (
          <path
            key={index}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {hovered?.value != null && hoverIndex !== null ? (
          <>
            <line
              x1={x(hoverIndex)}
              x2={x(hoverIndex)}
              y1={PADDING.top}
              y2={HEIGHT - PADDING.bottom}
              className="stroke-border-strong"
              strokeWidth={1}
            />
            {/* Anello di superficie attorno al marcatore: lo stacca dalla
                linea invece di lasciarlo affogare dentro. */}
            <circle
              cx={x(hoverIndex)}
              cy={y(hovered.value)}
              r={5}
              fill="currentColor"
              className="stroke-surface"
              strokeWidth={2}
            />
          </>
        ) : null}

        <text
          x={PADDING.left}
          y={HEIGHT - 4}
          className="fill-foreground-subtle text-[10px]"
        >
          {formatDate(series[0].date)}
        </text>
        <text
          x={width - PADDING.right}
          y={HEIGHT - 4}
          textAnchor="end"
          className="fill-foreground-subtle text-[10px]"
        >
          {formatDate(series[series.length - 1].date)}
        </text>
      </svg>
      )}
    </figure>
  );
}

export function TrendChart({ points }: { points: DailyPoint[] }) {
  if (points.length < 2) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Andamento</h2>
        <p className="text-sm text-foreground-muted">
          Servono almeno due giorni di dati per disegnare un andamento.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Andamento</h2>

      <div className="grid gap-4 rounded-[var(--radius-lg)] border border-border bg-surface p-4 lg:grid-cols-3">
        <Sparkline measure="clicks" points={points} />
        <Sparkline measure="impressions" points={points} />
        <Sparkline measure="position" points={points} />
      </div>

      {/* Gli stessi numeri in forma tabellare: il grafico è marcato
          `role="presentation"` proprio perché l'informazione resta accessibile
          qui, invece di essere disponibile solo a chi può vedere una linea. */}
      <details className="rounded-[var(--radius-lg)] border border-border">
        <summary className="cursor-pointer px-4 py-2 text-xs text-foreground-muted">
          Mostra i dati in tabella
        </summary>
        <div className="max-h-72 overflow-auto border-t border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">
              Clic, impression e posizione media per giorno
            </caption>
            <thead className="sticky top-0 bg-surface-muted">
              <tr>
                <th scope="col" className="px-4 py-1.5 text-left font-medium">
                  Giorno
                </th>
                <th scope="col" className="px-4 py-1.5 text-right font-medium">
                  Clic
                </th>
                <th scope="col" className="px-4 py-1.5 text-right font-medium">
                  Impression
                </th>
                <th scope="col" className="px-4 py-1.5 text-right font-medium">
                  Posizione
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {points.map((point) => (
                <tr key={point.date}>
                  <th scope="row" className="px-4 py-1.5 text-left font-normal">
                    {point.date}
                  </th>
                  <td className="px-4 py-1.5 text-right tabular-nums">
                    {point.clicks.toLocaleString('it-IT')}
                  </td>
                  <td className="px-4 py-1.5 text-right tabular-nums">
                    {point.impressions.toLocaleString('it-IT')}
                  </td>
                  <td className="px-4 py-1.5 text-right tabular-nums">
                    {point.position.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
