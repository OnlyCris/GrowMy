import { expectedCtrAtPosition } from './ctr-curve';
import type { AggregatedQueryMetrics } from './striking-distance';

/**
 * SCARTO CTR — visibile ma non scelto.
 *
 * Diagnostica una situazione che le altre analisi non vedono e che porta a
 * un'azione completamente diversa: una pagina che è in una posizione BUONA e
 * riceve molte meno visite di quante quella posizione dovrebbe portarle.
 *
 * PERCHÉ NON È STRIKING DISTANCE. Lì il problema è il posizionamento e la
 * risposta è editoriale: manca profondità, mancano sezioni, serve riscrivere
 * l'articolo. Qui il posizionamento è già stato conquistato — Google mostra la
 * pagina fra i primi risultati e le persone la ignorano. Il problema è quasi
 * sempre nello snippet: titolo che non risponde alla domanda, meta description
 * assente o troncata, intento disallineato. Riscrivere l'articolo non lo
 * risolverebbe, e sarebbe lavoro sprecato sulla pagina che sta già andando bene.
 *
 * È la diagnosi con il ritorno più immediato di tutte: cambiare un titolo costa
 * minuti e ha effetto alla prossima scansione, mentre risalire di posizione
 * richiede settimane.
 *
 * NON RICHIEDE NUOVI DATI: usa `expectedCtrAtPosition`, già scritta per lo
 * striking distance, applicata al confronto opposto.
 */

export interface CtrGapIssue {
  query: string;
  page: string;
  articleId: string | null;
  clicks: number;
  impressions: number;
  position: number;
  /** CTR che quella posizione dovrebbe rendere, da curva. */
  expectedCtr: number;
  actualCtr: number;
  /** Clic mancati rispetto all'atteso, nel periodo. */
  missedClicks: number;
  /** 0-100. Ordina i casi fra loro. */
  score: number;
  /** Spiegazione in italiano, mostrata all'utente così com'è. */
  rationale: string;
}

export interface CtrGapOptions {
  /**
   * Posizione massima considerata. Oltre la prima pagina il CTR atteso è
   * talmente basso che lo scarto diventa rumore, e comunque la leva giusta
   * tornerebbe a essere il posizionamento, non lo snippet.
   */
  maxPosition?: number;
  /**
   * Impression minime. Sotto questa soglia il CTR è una frazione con
   * denominatore troppo piccolo: due clic in meno su trenta impression
   * sembrano un crollo del 40% e non significano niente.
   */
  minImpressions?: number;
  /**
   * Quanto il CTR deve stare sotto l'atteso perché valga una segnalazione.
   * 0.4 = almeno il 40% in meno. La curva CTR è una stima con varianza alta
   * fra settori: una soglia stretta produrrebbe soprattutto falsi positivi.
   */
  minShortfall?: number;
  limit?: number;
}

const DEFAULTS = {
  maxPosition: 10,
  minImpressions: 100,
  minShortfall: 0.4,
  limit: 20,
} as const;

function buildRationale(params: {
  position: number;
  impressions: number;
  actualCtr: number;
  expectedCtr: number;
  missedClicks: number;
  clicks: number;
}): string {
  const shortfallPercent = Math.round(
    (1 - params.actualCtr / params.expectedCtr) * 100,
  );

  const head =
    `In posizione media ${params.position.toFixed(1)} con ` +
    `${params.impressions.toLocaleString('it-IT')} impression, ma solo ` +
    `${params.clicks.toLocaleString('it-IT')} clic: un CTR del ` +
    `${(params.actualCtr * 100).toFixed(1)}% contro il ` +
    `${(params.expectedCtr * 100).toFixed(1)}% che quella posizione rende di solito, ` +
    `il ${shortfallPercent}% in meno.`;

  const diagnosis =
    params.position <= 5
      ? ' La pagina è fra i primi risultati e viene ignorata: il posizionamento non è il problema.'
      : ' La pagina è in prima pagina ma non convince chi la vede.';

  const advice =
    ` Sono circa ${params.missedClicks.toLocaleString('it-IT')} clic mancati nel periodo. ` +
    'Interviene sul titolo e sulla meta description, non sul contenuto: verifica che il ' +
    'titolo risponda alla domanda posta dalla ricerca invece di descrivere l’argomento, ' +
    'e che la descrizione non sia assente o tagliata.';

  return head + diagnosis + advice;
}

/**
 * Individua le pagine che rendono meno di quanto la loro posizione prometta.
 *
 * L'input è lo stesso di `findStrikingDistanceOpportunities`: righe (query,
 * pagina) già aggregate sulla finestra di analisi.
 */
export function findCtrGaps(
  rows: AggregatedQueryMetrics[],
  options: CtrGapOptions = {},
): CtrGapIssue[] {
  const maxPosition = options.maxPosition ?? DEFAULTS.maxPosition;
  const minImpressions = options.minImpressions ?? DEFAULTS.minImpressions;
  const minShortfall = options.minShortfall ?? DEFAULTS.minShortfall;
  const limit = options.limit ?? DEFAULTS.limit;

  const issues: CtrGapIssue[] = [];

  for (const row of rows) {
    if (row.position > maxPosition || row.position < 1) continue;
    if (row.impressions < minImpressions) continue;

    const expectedCtr = expectedCtrAtPosition(row.position);
    if (expectedCtr <= 0) continue;

    const actualCtr = row.clicks / row.impressions;
    const shortfall = 1 - actualCtr / expectedCtr;
    if (shortfall < minShortfall) continue;

    const missedClicks = Math.round(row.impressions * (expectedCtr - actualCtr));
    // Uno scarto che vale meno di un pugno di clic non merita il lavoro di
    // riscrivere uno snippet, per quanto la percentuale sia brutta.
    if (missedClicks < 5) continue;

    /**
     * Punteggio: pesa i clic mancati in valore assoluto più della percentuale.
     * Una pagina che perde 200 clic con uno scarto del 45% va sistemata prima
     * di una che ne perde 8 con uno scarto del 90%.
     */
    const volumeScore = Math.min(
      1,
      Math.log10(1 + missedClicks) / Math.log10(1 + 300),
    );
    const shortfallScore = Math.min(1, shortfall);

    issues.push({
      query: row.query,
      page: row.page,
      articleId: row.articleId,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
      expectedCtr,
      actualCtr,
      missedClicks,
      score: Math.round((volumeScore * 70 + shortfallScore * 30) * 10) / 10,
      rationale: buildRationale({
        position: row.position,
        impressions: row.impressions,
        actualCtr,
        expectedCtr,
        missedClicks,
        clicks: row.clicks,
      }),
    });
  }

  return issues.sort((a, b) => b.score - a.score).slice(0, limit);
}
