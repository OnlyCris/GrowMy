'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';
import type { QualityMetricKey, QualityScore } from '@/types/review';

/**
 * QUALITY SCORE PANEL — UPGRADE #1
 *
 * Outrank consegna la bozza senza alcun segnale di qualità: l'utente deve
 * leggere 1.500 parole per capire se vale qualcosa. Qui l'utente vede in due
 * secondi *dove* guardare, e legge il testo intero solo se ha senso farlo.
 *
 * Ogni metrica dichiara la propria soglia e spiega cosa misura. Non è
 * decorazione: sotto soglia la pipeline ha già rigenerato una volta
 * gratuitamente, e questo pannello mostra il risultato di quel secondo tentativo.
 */

interface MetricDefinition {
  key: QualityMetricKey;
  label: string;
  /** Soglia sotto la quale la metrica è considerata problematica. */
  threshold: number;
  /** Cosa misura, in una frase. Mostrato nel dettaglio espandibile. */
  description: string;
  /** Cosa fare se il punteggio è basso. Azionabile, non generico. */
  remedy: string;
}

const METRICS: readonly MetricDefinition[] = [
  {
    key: 'readability',
    label: 'Leggibilità',
    threshold: 60,
    description:
      'Lunghezza media delle frasi e complessità lessicale, normalizzate sulla lingua di destinazione.',
    remedy:
      'Chiedi una riscrittura con frasi più corte: sotto 60 il testo affatica anche un lettore esperto.',
  },
  {
    key: 'keywordDensity',
    label: 'Densità keyword',
    threshold: 55,
    description:
      'Presenza della keyword target e delle sue varianti. Penalizza sia lo stuffing sia l’assenza.',
    remedy:
      'Verifica H2 e primo paragrafo: di solito un punteggio basso significa che la keyword non compare dove conta.',
  },
  {
    key: 'originality',
    label: 'Originalità',
    threshold: 70,
    description:
      'Distanza semantica dai contenuti già pubblicati sullo stesso dominio.',
    remedy:
      'Sotto 70 rischi di cannibalizzare un tuo articolo esistente. Valuta di cambiare angolo o di fare un refresh invece di un nuovo pezzo.',
  },
  {
    key: 'factDensity',
    label: 'Densità fattuale',
    threshold: 50,
    description:
      'Quantità di affermazioni verificabili — dati, date, cifre, citazioni — rispetto alla prosa generica.',
    remedy:
      'È la metrica che distingue un testo utile da uno riempitivo. Sotto 50, chiedi una rigenerazione con più fonti.',
  },
  {
    key: 'internalLinks',
    label: 'Link interni',
    threshold: 60,
    description:
      'Copertura dei link interni effettivamente inseriti rispetto a quelli pianificati nel brief.',
    remedy:
      'Puoi aggiungerli a mano nell’editor: sono il segnale SEO più economico che hai a disposizione.',
  },
] as const;

/** Media pesata: la densità fattuale conta doppio perché è la più predittiva. */
const METRIC_WEIGHTS: Record<QualityMetricKey, number> = {
  readability: 1,
  keywordDensity: 1,
  originality: 1.5,
  factDensity: 2,
  internalLinks: 0.5,
};

function computeOverall(score: QualityScore): number {
  const totalWeight = Object.values(METRIC_WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted = METRICS.reduce(
    (sum, m) => sum + score[m.key] * METRIC_WEIGHTS[m.key],
    0,
  );
  return Math.round(weighted / totalWeight);
}

function toneFor(value: number, threshold: number) {
  if (value >= threshold + 15) return 'strong' as const;
  if (value >= threshold) return 'adequate' as const;
  return 'weak' as const;
}

const TONE_STYLES = {
  strong: { bar: 'bg-success-500', text: 'text-success-700', icon: CheckCircle2 },
  adequate: { bar: 'bg-base-400', text: 'text-foreground-muted', icon: Info },
  // Debole = richiede una decisione umana -> ambra, coerente con la regola globale.
  weak: { bar: 'bg-accent-500', text: 'text-accent-900', icon: AlertTriangle },
} as const;

interface QualityScorePanelProps {
  score: QualityScore;
  className?: string;
}

export function QualityScorePanel({ score, className }: QualityScorePanelProps) {
  const shouldReduceMotion = useReducedMotion();
  const [expandedKey, setExpandedKey] = React.useState<QualityMetricKey | null>(
    null,
  );

  const overall = React.useMemo(() => computeOverall(score), [score]);
  const weakMetrics = METRICS.filter(
    (m) => toneFor(score[m.key], m.threshold) === 'weak',
  );

  return (
    <section
      className={cn(
        'rounded-[var(--radius-lg)] border border-border bg-surface p-4',
        className,
      )}
      aria-labelledby="quality-score-heading"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3
          id="quality-score-heading"
          className="text-sm font-semibold text-foreground"
        >
          Qualità della bozza
        </h3>
        <div className="flex items-baseline gap-1.5" data-metric>
          <span
            className={cn(
              'text-2xl font-semibold tabular',
              overall >= 70
                ? 'text-success-700'
                : overall >= 55
                  ? 'text-foreground'
                  : 'text-accent-900',
            )}
          >
            {overall}
          </span>
          <span className="text-xs text-foreground-subtle">/ 100</span>
        </div>
      </header>

      {/* Sintesi azionabile in cima: è la prima cosa che l'occhio incontra. */}
      <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
        {weakMetrics.length === 0 ? (
          <>Tutte le metriche sono sopra soglia. Puoi approvare con fiducia.</>
        ) : (
          <>
            {weakMetrics.length === 1 ? 'Una metrica è' : `${weakMetrics.length} metriche sono`}{' '}
            sotto soglia:{' '}
            <span className="font-medium text-accent-900">
              {weakMetrics.map((m) => m.label.toLowerCase()).join(', ')}
            </span>
            . Espandi per capire cosa fare.
          </>
        )}
      </p>

      <ul className="mt-4 space-y-3">
        {METRICS.map((metric, index) => {
          const value = score[metric.key];
          const tone = toneFor(value, metric.threshold);
          const styles = TONE_STYLES[tone];
          const ToneIcon = styles.icon;
          const isExpanded = expandedKey === metric.key;
          const detailId = `quality-detail-${metric.key}`;

          return (
            <li key={metric.key}>
              <button
                type="button"
                onClick={() => setExpandedKey(isExpanded ? null : metric.key)}
                aria-expanded={isExpanded}
                aria-controls={detailId}
                className="group w-full rounded-[var(--radius-sm)] text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <ToneIcon
                      className={cn('size-3.5', styles.text)}
                      aria-hidden="true"
                    />
                    {metric.label}
                  </span>
                  <span
                    className={cn('text-xs font-semibold tabular', styles.text)}
                    data-metric
                  >
                    {value}
                    <span className="sr-only">
                      {' '}
                      su 100, soglia minima {metric.threshold}
                    </span>
                  </span>
                </div>

                {/* La barra è decorativa: il valore numerico accanto è la fonte
                    accessibile, quindi qui aria-hidden è corretto. */}
                <div
                  className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-base-200"
                  aria-hidden="true"
                >
                  <motion.div
                    className={cn('h-full rounded-full', styles.bar)}
                    initial={{ width: 0 }}
                    animate={{ width: `${value}%` }}
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : {
                            duration: 0.5,
                            delay: index * 0.04,
                            ease: [0.25, 1, 0.5, 1],
                          }
                    }
                  />
                  {/* Tacca della soglia: rende leggibile "quanto manca". */}
                  <span
                    className="absolute top-0 h-full w-px bg-base-500/60"
                    style={{ left: `${metric.threshold}%` }}
                  />
                </div>
              </button>

              {isExpanded ? (
                <motion.div
                  id={detailId}
                  initial={shouldReduceMotion ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1.5 rounded-[var(--radius-sm)] bg-surface-muted p-2.5 text-2xs leading-relaxed">
                    <p className="text-foreground-muted">{metric.description}</p>
                    {tone === 'weak' ? (
                      <p className="font-medium text-accent-900">{metric.remedy}</p>
                    ) : null}
                  </div>
                </motion.div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Skeleton corrispondente, usato mentre il punteggio è in calcolo. */
export function QualityScorePanelSkeleton() {
  return (
    <section
      className="rounded-[var(--radius-lg)] border border-border bg-surface p-4"
      aria-busy="true"
      aria-label="Calcolo della qualità in corso"
    >
      <div className="flex items-baseline justify-between">
        <div className="h-4 w-32 animate-pulse rounded bg-base-200" />
        <div className="h-7 w-14 animate-pulse rounded bg-base-200" />
      </div>
      <div className="mt-2 h-3 w-full animate-pulse rounded bg-base-100" />
      <ul className="mt-4 space-y-3">
        {METRICS.map((m) => (
          <li key={m.key}>
            <div className="flex justify-between">
              <div className="h-3 w-24 animate-pulse rounded bg-base-200" />
              <div className="h-3 w-8 animate-pulse rounded bg-base-200" />
            </div>
            <div className="mt-1.5 h-1.5 w-full animate-pulse rounded-full bg-base-100" />
          </li>
        ))}
      </ul>
    </section>
  );
}
