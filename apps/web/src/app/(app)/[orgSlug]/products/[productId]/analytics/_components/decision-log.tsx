import { formatRelativeTime } from '@/lib/utils';

/**
 * LOG DELLE DECISIONI DEL PLANNER.
 *
 * È la parte dell'UPGRADE #2 che giustifica l'esistenza della tabella
 * `planner_decisions`, ed è anche la meno appariscente: risponde alla domanda
 * *«perché questa keyword questa settimana?»* — che nella maggior parte degli
 * strumenti di questo tipo non ha risposta.
 *
 * Ogni riga mostra il ragionamento in italiano e, sotto, i numeri che l'hanno
 * prodotto. I numeri contano quanto la frase: senza, la spiegazione sarebbe
 * indistinguibile da una plausibile inventata a posteriori.
 *
 * Componente server: nessuna interazione.
 */

export interface DecisionRow {
  id: string;
  decision: string;
  rationale: string;
  evidence: Record<string, unknown>;
  createdAt: Date;
}

const DECISION_LABEL: Record<string, string> = {
  add_keyword: 'Nuova keyword proposta',
  promote: 'Priorità aumentata',
  demote: 'Priorità ridotta',
  schedule_refresh: 'Aggiornamento consigliato',
  flag_cannibalization: 'Conflitto segnalato',
  archive: 'Archiviata',
};

/** Etichette leggibili per le chiavi tecniche di `evidence`. */
const EVIDENCE_LABEL: Record<string, string> = {
  query: 'Ricerca',
  page: 'Pagina',
  impressions: 'Impression',
  clicks: 'Clic',
  position: 'Posizione media',
  estimatedClickGain: 'Clic stimati in più',
  previousClicks: 'Clic periodo prec.',
  currentClicks: 'Clic periodo corr.',
  clicksChange: 'Variazione clic',
  positionChange: 'Variazione posizione',
  wastedImpressions: 'Impression disperse',
  severity: 'Gravità',
  competingPages: 'Pagine in conflitto',
  windowDays: 'Giorni analizzati',
};

function formatEvidenceValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';

  if (typeof value === 'number') {
    if (key === 'clicksChange') return `${(value * 100).toFixed(0)}%`;
    if (key === 'position' || key === 'positionChange') return value.toFixed(1);
    return value.toLocaleString('it-IT');
  }

  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') return '—';

  return String(value);
}

export function DecisionLog({ decisions }: { decisions: DecisionRow[] }) {
  if (decisions.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Decisioni del planner</h2>
        <p className="text-sm text-foreground-muted">
          Nessuna decisione ancora. Il planner gira una volta a settimana sui dati
          raccolti, oppure subito con «Ricalcola priorità».
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">Decisioni del planner</h2>
        <p className="text-xs text-foreground-muted">
          Ogni scelta con il motivo e i numeri che l’hanno prodotta.
        </p>
      </div>

      <ol className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
        {decisions.map((decision) => {
          const evidenceEntries = Object.entries(decision.evidence ?? {}).filter(
            ([, value]) => value !== null && typeof value !== 'object',
          );

          return (
            <li key={decision.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {DECISION_LABEL[decision.decision] ?? decision.decision}
                </span>
                <span className="text-xs text-foreground-muted">
                  {formatRelativeTime(decision.createdAt)}
                </span>
              </div>

              <p className="text-sm text-foreground-muted">{decision.rationale}</p>

              {evidenceEntries.length > 0 ? (
                <dl className="flex flex-wrap gap-x-4 gap-y-1">
                  {evidenceEntries.map(([key, value]) => (
                    <div key={key} className="flex items-baseline gap-1">
                      <dt className="text-xs text-foreground-muted">
                        {EVIDENCE_LABEL[key] ?? key}:
                      </dt>
                      <dd className="text-xs tabular-nums text-foreground">
                        {formatEvidenceValue(key, value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
