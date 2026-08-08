/**
 * REFRESH — gli articoli che stanno perdendo terreno.
 *
 * Un articolo pubblicato non ha una performance costante: cresce per qualche
 * settimana, si stabilizza, poi cala man mano che i concorrenti pubblicano
 * qualcosa di più aggiornato. Il calo è normale e invisibile finché non si
 * confrontano due periodi affiancati.
 *
 * Perché conta più di quanto sembri: aggiornare un articolo che era in
 * posizione 6 ed è scivolato in posizione 11 costa una frazione di un articolo
 * nuovo e agisce su una pagina che Google conosce già. In una piattaforma che
 * genera contenuti di continuo, la tentazione strutturale è pubblicare sempre
 * cose nuove e lasciare marcire l'archivio — questa analisi esiste per
 * contrastarla con dei numeri.
 *
 * Funzioni pure: nessun accesso al database.
 */

/** Metriche di un articolo su una finestra temporale. */
export interface ArticlePeriodMetrics {
  articleId: string;
  page: string;
  clicks: number;
  impressions: number;
  /** Posizione media pesata sulle impression. */
  position: number;
}

export interface RefreshCandidate {
  articleId: string;
  page: string;
  /** Clic nel periodo recente. */
  currentClicks: number;
  /** Clic nel periodo precedente, di pari durata. */
  previousClicks: number;
  /** Negativo quando cala. Es. -0.42 = -42%. */
  clicksChange: number;
  /** Positivo quando peggiora (la posizione cresce = si scende). */
  positionChange: number;
  currentPosition: number;
  /** 0-100. Ordina i candidati fra loro. */
  score: number;
  /** Spiegazione in italiano, mostrata all'utente così com'è. */
  rationale: string;
}

export interface RefreshOptions {
  /**
   * Calo minimo dei clic perché valga un intervento. 0.3 = -30%.
   * Sotto questa soglia si tratta di normale oscillazione settimanale, non di
   * un declino: segnalarla produrrebbe una coda di lavoro che non finisce mai.
   */
  minClicksDrop?: number;
  /**
   * Clic minimi nel periodo precedente. Un articolo passato da 2 clic a 1 ha
   * perso il 50% e non significa niente: le percentuali su numeri piccoli sono
   * rumore travestito da segnale.
   */
  minPreviousClicks?: number;
  limit?: number;
}

const DEFAULTS = {
  minClicksDrop: 0.3,
  minPreviousClicks: 10,
  limit: 20,
} as const;

function buildRationale(params: {
  dropPercent: number;
  previousClicks: number;
  currentClicks: number;
  positionChange: number;
  currentPosition: number;
}): string {
  const head =
    `I clic sono scesi del ${params.dropPercent}% rispetto al periodo precedente ` +
    `(${params.previousClicks.toLocaleString('it-IT')} → ${params.currentClicks.toLocaleString('it-IT')}).`;

  const positional =
    params.positionChange >= 1
      ? ` La posizione media è peggiorata di ${params.positionChange.toFixed(1)} posizioni, ` +
        `ora è ${params.currentPosition.toFixed(1)}: qualcuno ha pubblicato qualcosa di più aggiornato.`
      : ` La posizione media è stabile (${params.currentPosition.toFixed(1)}): ` +
        `il calo viene dalla domanda o dalla SERP, non da un sorpasso.`;

  const advice =
    params.positionChange >= 1
      ? ' Aggiornare dati, esempi e sezioni obsolete costa molto meno di un articolo nuovo e agisce su una pagina già indicizzata.'
      : ' Verifica se l’intento di ricerca è cambiato prima di riscrivere: potrebbe servire un angolo diverso, non solo un aggiornamento.';

  return head + positional + advice;
}

/**
 * Individua gli articoli in calo confrontando due finestre di pari durata.
 *
 * `current` e `previous` devono coprire lo stesso numero di giorni, altrimenti
 * il confronto misura la durata delle finestre invece dell'andamento — è
 * responsabilità del chiamante, qui non è verificabile.
 */
export function findRefreshCandidates(
  current: ArticlePeriodMetrics[],
  previous: ArticlePeriodMetrics[],
  options: RefreshOptions = {},
): RefreshCandidate[] {
  const minClicksDrop = options.minClicksDrop ?? DEFAULTS.minClicksDrop;
  const minPreviousClicks = options.minPreviousClicks ?? DEFAULTS.minPreviousClicks;
  const limit = options.limit ?? DEFAULTS.limit;

  const previousByArticle = new Map(previous.map((row) => [row.articleId, row]));
  const candidates: RefreshCandidate[] = [];

  for (const now of current) {
    const before = previousByArticle.get(now.articleId);
    if (!before || before.clicks < minPreviousClicks) continue;

    const clicksChange = (now.clicks - before.clicks) / before.clicks;
    if (clicksChange > -minClicksDrop) continue;

    const positionChange = now.position - before.position;
    const dropPercent = Math.round(Math.abs(clicksChange) * 100);

    /**
     * Punteggio: pesa QUANTO si è perso in valore assoluto, non solo in
     * percentuale. Un articolo sceso da 400 a 200 clic merita attenzione prima
     * di uno sceso da 12 a 4, anche se il secondo ha la percentuale peggiore.
     */
    const lostClicks = before.clicks - now.clicks;
    const volumeScore = Math.min(1, Math.log10(1 + lostClicks) / Math.log10(1 + 300));
    const dropScore = Math.min(1, Math.abs(clicksChange));

    candidates.push({
      articleId: now.articleId,
      page: now.page,
      currentClicks: now.clicks,
      previousClicks: before.clicks,
      clicksChange,
      positionChange,
      currentPosition: now.position,
      score: Math.round((volumeScore * 60 + dropScore * 40) * 10) / 10,
      rationale: buildRationale({
        dropPercent,
        previousClicks: before.clicks,
        currentClicks: now.clicks,
        positionChange,
        currentPosition: now.position,
      }),
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
