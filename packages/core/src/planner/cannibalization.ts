import type { AggregatedQueryMetrics } from './striking-distance';

/**
 * CANNIBALIZZAZIONE — due pagine dello stesso sito che competono sulla stessa query.
 *
 * Non è un problema estetico. Google sceglie una sola pagina per query e per
 * sito: quando due candidate si somigliano, l'una alterna con l'altra, i
 * segnali (link, engagement, freschezza) si dividono fra due URL invece di
 * concentrarsi su uno, e il risultato è che nessuna delle due arriva dove
 * sarebbe arrivata da sola. È il motivo per cui un sito che pubblica molto può
 * peggiorare il proprio posizionamento pubblicando ancora di più — e per cui
 * questa analisi è indispensabile in una piattaforma che genera contenuti in
 * autopilota, dove il rischio è strutturale e non occasionale.
 *
 * Funzioni pure: nessun accesso al database.
 */

export interface CompetingPage {
  page: string;
  articleId: string | null;
  clicks: number;
  impressions: number;
  position: number;
}

export type CannibalizationSeverity = 'low' | 'medium' | 'high';

/**
 * - `merge`: nessuna delle due vince, i contenuti si sovrappongono → un solo
 *   articolo più completo, l'altro reindirizzato.
 * - `differentiate`: entrambe hanno un pubblico, ma l'intento non è distinto →
 *   riscrivere l'angolo di una delle due.
 * - `canonicalize`: una domina nettamente → dichiarare la vincitrice canonica e
 *   far puntare l'altra a lei.
 */
export type RecommendedAction = 'merge' | 'differentiate' | 'canonicalize';

export interface CannibalizationIssue {
  query: string;
  competingPages: CompetingPage[];
  severity: CannibalizationSeverity;
  recommendedAction: RecommendedAction;
  /** Impression che finiscono alla pagina sbagliata: la misura del danno. */
  wastedImpressions: number;
  /** Spiegazione in italiano, mostrata all'utente così com'è. */
  rationale: string;
}

export interface CannibalizationOptions {
  /** Impression minime della query nel periodo perché valga la pena guardarla. */
  minTotalImpressions?: number;
  /**
   * Quota minima di impression della seconda pagina perché sia una competitrice
   * vera. Sotto questa soglia è una comparsa occasionale, non un conflitto:
   * quasi ogni query di un sito grande ha una seconda pagina con lo 0,5% delle
   * impression, e segnalarle tutte renderebbe la lista inutilizzabile.
   */
  minCompetitorShare?: number;
  limit?: number;
}

const DEFAULTS = {
  minTotalImpressions: 50,
  minCompetitorShare: 0.15,
  limit: 30,
} as const;

/**
 * Gravità, in base a quante impression finiscono alle pagine non vincenti e a
 * quanto il conflitto sta costando in posizione.
 *
 * La posizione media entra nel calcolo perché lo stesso 40% di impression
 * disperse pesa in modo diverso se la vincitrice è seconda (sta vincendo lo
 * stesso) o dodicesima (probabilmente sta perdendo proprio a causa del conflitto).
 */
function assessSeverity(
  wastedShare: number,
  winnerPosition: number,
): CannibalizationSeverity {
  if (wastedShare >= 0.35 && winnerPosition > 5) return 'high';
  if (wastedShare >= 0.35 || (wastedShare >= 0.2 && winnerPosition > 8)) return 'medium';
  return 'low';
}

function recommendAction(
  winner: CompetingPage,
  challengers: CompetingPage[],
  totalClicks: number,
): RecommendedAction {
  // Una domina nettamente i clic: il problema non è quale sia la pagina giusta
  // — è già chiaro — ma che le altre continuino a competere. Canonizzare.
  if (totalClicks > 0 && winner.clicks / totalClicks >= 0.8) return 'canonicalize';

  // Nessuna è in una posizione utile: non c'è una vincitrice da proteggere,
  // c'è un argomento coperto male due volte. Un articolo solo, fatto bene.
  const allWeak =
    winner.position > 10 && challengers.every((page) => page.position > 10);
  if (allWeak) return 'merge';

  // Entrambe raccolgono qualcosa: hanno un pubblico ma l'intento si sovrappone.
  return 'differentiate';
}

function buildRationale(params: {
  query: string;
  winner: CompetingPage;
  challengers: CompetingPage[];
  wastedImpressions: number;
  wastedShare: number;
  action: RecommendedAction;
}): string {
  const count = params.challengers.length + 1;
  const share = Math.round(params.wastedShare * 100);

  const head =
    `${count} pagine del sito competono sulla query «${params.query}». ` +
    `La più forte è ${params.winner.page} (posizione media ${params.winner.position.toFixed(1)}, ` +
    `${params.winner.clicks.toLocaleString('it-IT')} clic), ma il ${share}% delle impression ` +
    `(${params.wastedImpressions.toLocaleString('it-IT')}) va alle altre.`;

  const advice: Record<RecommendedAction, string> = {
    canonicalize:
      ' Una pagina raccoglie quasi tutti i clic: dichiarala canonica e fai puntare le altre a lei, ' +
      'così i segnali si concentrano invece di dividersi.',
    merge:
      ' Nessuna delle due è in una posizione utile: unirle in un solo articolo più completo, ' +
      'con redirect dall’altra, concentra autorità che oggi è dispersa.',
    differentiate:
      ' Entrambe hanno un pubblico ma rispondono alla stessa intenzione di ricerca: ' +
      'riscrivi l’angolo di una delle due perché copra una domanda diversa.',
  };

  return head + advice[params.action];
}

/**
 * Rileva le query su cui più URL dello stesso prodotto competono.
 *
 * L'input è lo stesso di `findStrikingDistanceOpportunities`: righe (query,
 * pagina) già aggregate sulla finestra di analisi.
 */
export function detectCannibalization(
  rows: AggregatedQueryMetrics[],
  options: CannibalizationOptions = {},
): CannibalizationIssue[] {
  const minTotalImpressions =
    options.minTotalImpressions ?? DEFAULTS.minTotalImpressions;
  const minCompetitorShare = options.minCompetitorShare ?? DEFAULTS.minCompetitorShare;
  const limit = options.limit ?? DEFAULTS.limit;

  /** Righe raggruppate per query normalizzata. */
  const byQuery = new Map<string, { label: string; pages: Map<string, CompetingPage> }>();

  for (const row of rows) {
    const key = row.query.toLowerCase();
    let group = byQuery.get(key);
    if (!group) {
      group = { label: row.query, pages: new Map() };
      byQuery.set(key, group);
    }

    /**
     * Somma le righe che condividono query E pagina. L'aggregazione a monte
     * potrebbe già averlo fatto, ma non possiamo darlo per scontato: se
     * arrivassero righe per giorno o per device, contare la stessa pagina due
     * volte la farebbe sembrare due competitrici distinte — cioè inventerebbe
     * una cannibalizzazione che non esiste.
     */
    const existing = group.pages.get(row.page);
    if (existing) {
      const totalImpressions = existing.impressions + row.impressions;
      // Posizione media pesata sulle impression: la media aritmetica darebbe lo
      // stesso peso a un giorno da 1000 impression e a uno da 2.
      existing.position =
        totalImpressions > 0
          ? (existing.position * existing.impressions +
              row.position * row.impressions) /
            totalImpressions
          : existing.position;
      existing.clicks += row.clicks;
      existing.impressions = totalImpressions;
      existing.articleId ??= row.articleId;
    } else {
      group.pages.set(row.page, {
        page: row.page,
        articleId: row.articleId,
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
      });
    }
  }

  const issues: CannibalizationIssue[] = [];

  for (const { label, pages } of byQuery.values()) {
    if (pages.size < 2) continue;

    const allPages = [...pages.values()];
    const totalImpressions = allPages.reduce((sum, p) => sum + p.impressions, 0);
    if (totalImpressions < minTotalImpressions) continue;

    // La vincitrice è quella che porta più clic; a parità, la meglio posizionata.
    const sorted = [...allPages].sort(
      (a, b) => b.clicks - a.clicks || a.position - b.position,
    );
    const winner = sorted[0];

    // Solo le concorrenti con una quota non trascurabile.
    const challengers = sorted
      .slice(1)
      .filter((page) => page.impressions / totalImpressions >= minCompetitorShare);

    if (challengers.length === 0) continue;

    const wastedImpressions = challengers.reduce((sum, p) => sum + p.impressions, 0);
    const wastedShare = wastedImpressions / totalImpressions;
    const totalClicks = allPages.reduce((sum, p) => sum + p.clicks, 0);
    const action = recommendAction(winner, challengers, totalClicks);

    issues.push({
      query: label,
      competingPages: [winner, ...challengers],
      severity: assessSeverity(wastedShare, winner.position),
      recommendedAction: action,
      wastedImpressions,
      rationale: buildRationale({
        query: label,
        winner,
        challengers,
        wastedImpressions,
        wastedShare,
        action,
      }),
    });
  }

  const severityRank: Record<CannibalizationSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return issues
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        b.wastedImpressions - a.wastedImpressions,
    )
    .slice(0, limit);
}
