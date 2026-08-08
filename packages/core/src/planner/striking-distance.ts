import { estimatedClickGain, REALISTIC_TARGET_POSITION } from './ctr-curve';

/**
 * STRIKING DISTANCE — le query che stanno appena fuori dai risultati utili.
 *
 * È l'analisi con il miglior rapporto fra sforzo e risultato di tutta la SEO, e
 * il motivo è aritmetico: una query in posizione 12 ha già superato la parte
 * difficile — Google la considera pertinente e la mostra. Mancano tre o quattro
 * posizioni, non un articolo nuovo. Scrivere da zero su una keyword su cui il
 * sito non compare affatto costa lo stesso lavoro con una probabilità di
 * successo molto più bassa.
 *
 * LA FASCIA 8-20 non è arbitraria. Sotto l'ottava la pagina è già in una
 * posizione buona e il margine si assottiglia; oltre la ventesima il distacco
 * di solito riflette un problema strutturale (intento sbagliato, autorità
 * insufficiente) che un ritocco al contenuto non risolve. Corrisponde
 * all'indice parziale su `gsc_daily_metrics`, che esiste per rendere questa
 * query veloce.
 *
 * Funzioni pure: nessun accesso al database. Il processore del worker aggrega e
 * passa le righe già pronte, così questa logica è testabile senza infrastruttura.
 */

/** Metriche di una coppia (query, pagina) aggregate su una finestra temporale. */
export interface AggregatedQueryMetrics {
  query: string;
  page: string;
  /** Valorizzato quando l'URL corrisponde a un articolo generato dalla piattaforma. */
  articleId: string | null;
  clicks: number;
  impressions: number;
  /** Posizione media pesata sulle impression della finestra. */
  position: number;
}

export interface StrikingDistanceOpportunity {
  query: string;
  page: string;
  articleId: string | null;
  clicks: number;
  impressions: number;
  position: number;
  /** Clic aggiuntivi stimati salendo alla posizione obiettivo. */
  estimatedClickGain: number;
  /** 0-100. Serve solo a ordinare fra loro le opportunità di questo prodotto. */
  score: number;
  /** Spiegazione in italiano, mostrata all'utente così com'è. */
  rationale: string;
}

export interface StrikingDistanceOptions {
  /** Estremo inferiore della fascia (incluso). */
  minPosition?: number;
  /** Estremo superiore della fascia (incluso). */
  maxPosition?: number;
  /**
   * Impression minime nella finestra. Una query con 4 impression in tre mesi
   * non è un'opportunità, è rumore: senza questa soglia la lista si riempie di
   * long-tail casuale e nasconde le poche righe che contano.
   */
  minImpressions?: number;
  /** Quante opportunità restituire al massimo. */
  limit?: number;
}

const DEFAULTS = {
  minPosition: 8,
  maxPosition: 20,
  minImpressions: 30,
  limit: 50,
} as const;

/**
 * Punteggio 0-100 di un'opportunità.
 *
 * Combina due fattori con pesi diversi perché rispondono a domande diverse:
 *
 *  - **Guadagno stimato (peso 70)**: quanto vale. È il fattore dominante —
 *    ordinare per sola vicinanza alla prima pagina mette in cima query da tre
 *    impression al mese.
 *  - **Vicinanza (peso 30)**: quanto è probabile riuscirci. A parità di
 *    guadagno, la posizione 9 si conquista prima della 19.
 *
 * La normalizzazione del guadagno è logaritmica: senza, una singola query da
 * 50.000 impression schiaccerebbe a zero il punteggio di tutte le altre e la
 * classifica diventerebbe una lista con un elemento.
 */
function scoreOpportunity(gain: number, position: number, maxPosition: number): number {
  const gainScore = Math.min(1, Math.log10(1 + gain) / Math.log10(1 + 500));

  const range = Math.max(1, maxPosition - REALISTIC_TARGET_POSITION);
  const proximityScore = Math.max(
    0,
    Math.min(1, (maxPosition - position) / range),
  );

  return Math.round((gainScore * 70 + proximityScore * 30) * 10) / 10;
}

function buildRationale(row: AggregatedQueryMetrics, gain: number): string {
  const position = row.position.toFixed(1);
  const impressions = row.impressions.toLocaleString('it-IT');

  const proximity =
    row.position <= 10
      ? `È già in prima pagina (posizione media ${position}): bastano poche posizioni per entrare fra i primi risultati.`
      : `È appena fuori dalla prima pagina (posizione media ${position}), dove il CTR crolla.`;

  const opportunity =
    gain > 0
      ? ` Con ${impressions} impression nel periodo, salire alla terza posizione vale una stima di ${gain.toLocaleString('it-IT')} clic in più.`
      : ` Ha ${impressions} impression nel periodo ma un margine di guadagno ridotto.`;

  const state =
    row.clicks === 0
      ? ' Oggi non porta nessun clic: la domanda esiste, la risposta non viene scelta.'
      : ` Oggi porta ${row.clicks.toLocaleString('it-IT')} clic.`;

  return `${proximity}${opportunity}${state}`;
}

/**
 * Individua le opportunità in striking distance.
 *
 * L'input può contenere più righe per la stessa query (URL diversi che si
 * posizionano sulla stessa ricerca). Qui si tiene solo la migliore per query:
 * il caso "più pagine sulla stessa query" è un problema di cannibalizzazione,
 * analizzato da `detectCannibalization`, e mescolare i due significherebbe
 * proporre di ottimizzare due URL in competizione fra loro — peggiorando
 * esattamente la situazione che l'altra analisi segnala.
 */
export function findStrikingDistanceOpportunities(
  rows: AggregatedQueryMetrics[],
  options: StrikingDistanceOptions = {},
): StrikingDistanceOpportunity[] {
  const minPosition = options.minPosition ?? DEFAULTS.minPosition;
  const maxPosition = options.maxPosition ?? DEFAULTS.maxPosition;
  const minImpressions = options.minImpressions ?? DEFAULTS.minImpressions;
  const limit = options.limit ?? DEFAULTS.limit;

  /** Migliore riga per query: più impression, a parità posizione migliore. */
  const bestByQuery = new Map<string, AggregatedQueryMetrics>();

  for (const row of rows) {
    if (row.position < minPosition || row.position > maxPosition) continue;
    if (row.impressions < minImpressions) continue;

    const key = row.query.toLowerCase();
    const current = bestByQuery.get(key);

    if (
      !current ||
      row.impressions > current.impressions ||
      (row.impressions === current.impressions && row.position < current.position)
    ) {
      bestByQuery.set(key, row);
    }
  }

  return [...bestByQuery.values()]
    .map((row) => {
      const gain = estimatedClickGain({
        impressions: row.impressions,
        currentPosition: row.position,
      });

      return {
        query: row.query,
        page: row.page,
        articleId: row.articleId,
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
        estimatedClickGain: gain,
        score: scoreOpportunity(gain, row.position, maxPosition),
        rationale: buildRationale(row, gain),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
