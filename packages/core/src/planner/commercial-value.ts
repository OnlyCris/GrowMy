/**
 * VALORE COMMERCIALE DI UNA KEYWORD — quanto è plausibile che chi cerca compri.
 *
 * ATTENZIONE A COSA È E A COSA NON È. Questa è una STIMA, non una misura.
 * La piattaforma non ha nessuna fonte di dati sulle conversioni: Search Console
 * espone clic, impression, posizione e nient'altro, e non esiste
 * un'integrazione con un sistema di analytics. Nessun numero qui dentro è mai
 * stato confrontato con una vendita reale.
 *
 * Questo NON la rende inutile: le keyword nuove non hanno storico per
 * definizione, quindi anche con dati di conversione collegati domani servirebbe
 * comunque un modo per ordinare ciò che non è ancora stato provato. Ma il
 * risultato va etichettato come stima ovunque compaia, e la UI lo fa.
 *
 * TRE SEGNALI, IN ORDINE DI AFFIDABILITÀ:
 *
 *  1. **Intento di ricerca** — il più solido. Chi cerca "quanto costa X" e chi
 *     cerca "cos'è X" sono a due distanze diverse dall'acquisto, e la
 *     differenza non è marginale: è la differenza fra un lettore e un cliente.
 *  2. **Modificatori nel termine** — raffinano l'intento. "migliore X" e
 *     "X gratis" sono entrambi commerciali ma su gradini opposti.
 *  3. **CPC stimato** — il segnale più interessante in teoria e il più fragile
 *     in pratica. Quanto gli inserzionisti pagano per una parola è la stima di
 *     valore fatta da un mercato reale, ma la nostra viene da un modello
 *     linguistico, non da un provider di dati. Pesa poco, deliberatamente.
 *
 * Il punteggio si calcola IN LETTURA da colonne già esistenti (`search_intent`,
 * `term`, `cpc`): non c'è una colonna da mantenere sincronizzata, e migliorare
 * questa funzione aggiorna anche le keyword vecchie senza una migrazione dati.
 */

/** Distanza dall'acquisto. */
export type FunnelStage = 'decision' | 'consideration' | 'awareness';

export interface CommercialValue {
  /** 0-100. Ordina le keyword fra loro, non è una probabilità. */
  score: number;
  stage: FunnelStage;
  /** Spiegazione in italiano, mostrata all'utente così com'è. */
  rationale: string;
  /** I modificatori riconosciuti nel termine, per rendere ispezionabile la stima. */
  signals: string[];
}

export interface CommercialValueInput {
  term: string;
  /** 'informational' | 'commercial' | 'transactional' | 'navigational' */
  searchIntent?: string | null;
  /** CPC stimato in valuta. Stringa perché arriva da una colonna `numeric`. */
  cpc?: string | number | null;
}

/**
 * Punto di partenza per intento.
 *
 * `navigational` sta in basso e non a metà: chi cerca il nome di un altro
 * marchio sta cercando quel marchio, non noi. Intercettarlo produce traffico
 * che rimbalza.
 */
/**
 * I valori lasciano deliberatamente spazio ai bonus: `transactional` (76) più
 * un modificatore di decisione (+10) più il massimo del segnale CPC (+12)
 * arriva a 98, non oltre. Una prima taratura partiva da 82 e faceva saturare a
 * 100 sia "prezzi" sia "preventivo" — due keyword ottime ma non identiche, che
 * il troncamento rendeva indistinguibili proprio in cima alla classifica, dove
 * l'ordine conta di più.
 */
const INTENT_BASE: Record<string, number> = {
  transactional: 76,
  commercial: 64,
  informational: 32,
  navigational: 20,
};

const DEFAULT_BASE = 45;

/** Punteggio corrispondente allo stadio ricavato dalla formulazione del termine. */
const STAGE_BASE: Record<FunnelStage, number> = {
  decision: 74,
  consideration: 60,
  awareness: 28,
};

/**
 * Modificatori italiani, raggruppati per stadio del funnel.
 *
 * Le voci sono confrontate come parole intere: senza il confine di parola,
 * "come" corrisponderebbe dentro "comodo" e "prezzo" dentro "prezzoso",
 * classificando male termini che non c'entrano.
 */
const DECISION_MODIFIERS = [
  'prezzo', 'prezzi', 'costo', 'costi', 'quanto costa', 'tariffe', 'tariffa',
  'preventivo', 'acquista', 'acquistare', 'comprare', 'compra', 'ordina',
  'abbonamento', 'offerta', 'offerte', 'sconto', 'sconti', 'promozione',
  'demo', 'prova gratuita', 'attivare', 'attivazione', 'installare',
];

const CONSIDERATION_MODIFIERS = [
  'migliore', 'migliori', 'top', 'classifica', 'confronto', 'confrontare',
  'alternativa', 'alternative', 'recensione', 'recensioni', 'opinioni',
  'quale scegliere', 'differenza', 'differenze', 'vs', 'oppure',
  'conviene', 'vale la pena', 'per ristoranti', 'per aziende', 'professionale',
];

const AWARENESS_MODIFIERS = [
  'come', 'cosa', 'cos', 'perché', 'perche', 'quando', 'guida', 'guide',
  'tutorial', 'significato', 'esempi', 'esempio', 'idee', 'consigli',
  'definizione', 'storia', 'gratis', 'gratuito', 'gratuita', 'fai da te',
];

function matchedModifiers(term: string, modifiers: string[]): string[] {
  const normalized = ` ${term.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  return modifiers.filter((modifier) => normalized.includes(` ${modifier} `));
}

/**
 * "gratis" è deliberatamente fra i segnali di AWARENESS e non di decisione.
 *
 * Sembra transazionale — l'utente vuole ottenere qualcosa — ma chi cerca la
 * versione gratuita di un prodotto a pagamento è la persona che meno
 * probabilmente pagherà. È l'errore di classificazione più comune, e produce
 * articoli che portano traffico e nessun cliente.
 */
/**
 * PRECEDENZA: la formulazione del termine batte l'intento dichiarato dal
 * modello.
 *
 * Non è una preferenza stilistica. Una prima versione controllava
 * `intent === 'transactional'` prima dei modificatori, e classificava "menu
 * digitale gratis" come vicina alla decisione — il modello la etichetta
 * transazionale perché l'utente vuole ottenere qualcosa, ma è la ricerca fatta
 * dalla persona che meno probabilmente pagherà. Il livello deterministico
 * esiste proprio per correggere quel tipo di errore: se non scavalca
 * l'etichetta del modello non serve a niente.
 *
 * Awareness e consideration insieme vincono come consideration: "come scegliere
 * il migliore X" contiene "come" ma è un confronto, non una ricerca di base.
 */
function stageFromSignals(
  intent: string | null | undefined,
  decision: string[],
  consideration: string[],
  awareness: string[],
): FunnelStage {
  if (decision.length > 0) return 'decision';
  if (awareness.length > 0) {
    return consideration.length > 0 ? 'consideration' : 'awareness';
  }
  if (intent === 'transactional') return 'decision';
  if (consideration.length > 0 || intent === 'commercial') return 'consideration';
  return intent === 'informational' ? 'awareness' : 'consideration';
}

/** Normalizza il CPC su una scala 0-1. Oltre i 5 €/clic la curva è piatta:
 *  distinguere 6 da 9 non cambia nessuna decisione editoriale. */
function cpcSignal(cpc: string | number | null | undefined): number | null {
  if (cpc === null || cpc === undefined) return null;
  const value = typeof cpc === 'string' ? Number.parseFloat(cpc) : cpc;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(1, Math.log10(1 + value) / Math.log10(1 + 5));
}

const STAGE_LABEL: Record<FunnelStage, string> = {
  decision: 'vicina alla decisione',
  consideration: 'in fase di valutazione',
  awareness: 'lontana dall’acquisto',
};

export function assessCommercialValue(
  input: CommercialValueInput,
): CommercialValue {
  const intent = input.searchIntent?.toLowerCase() ?? null;

  const decision = matchedModifiers(input.term, DECISION_MODIFIERS);
  const consideration = matchedModifiers(input.term, CONSIDERATION_MODIFIERS);
  const awareness = matchedModifiers(input.term, AWARENESS_MODIFIERS);

  const stage = stageFromSignals(intent, decision, consideration, awareness);

  /**
   * Il punteggio è la media fra l'intento dichiarato dal modello e lo stadio
   * risolto dalla formulazione, più il segnale CPC.
   *
   * DERIVARE ENTRAMBI DALLO STADIO NON È UN DETTAGLIO. Una versione precedente
   * calcolava il punteggio dai modificatori grezzi mentre lo stadio usava la
   * precedenza risolta, e le due cose si contraddicevano: "come scegliere il
   * migliore X" usciva come «Valutazione» con 19/100 — un'etichetta che dice
   * "interessante" accanto a un numero che dice "lascia perdere". Passando da
   * un'unica fonte, etichetta e punteggio non possono più divergere.
   *
   * La media, invece della sola sostituzione, conserva l'informazione del
   * modello: è meno affidabile della formulazione ma non è rumore, e su termini
   * senza modificatori riconosciuti è l'unico segnale disponibile.
   */
  const intentBase = intent ? (INTENT_BASE[intent] ?? DEFAULT_BASE) : DEFAULT_BASE;
  let score = (intentBase + STAGE_BASE[stage]) / 2;

  const cpc = cpcSignal(input.cpc);
  if (cpc !== null) score += cpc * 12;

  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  const signals = [...decision, ...consideration, ...awareness];

  const parts: string[] = [
    `Ricerca ${STAGE_LABEL[stage]}${intent ? ` (intento ${intent})` : ''}.`,
  ];

  if (decision.length > 0) {
    parts.push(
      `Contiene «${decision.join('», «')}»: chi la digita sta valutando un acquisto concreto.`,
    );
  } else if (consideration.length > 0) {
    parts.push(
      `Contiene «${consideration.join('», «')}»: sta confrontando opzioni, non ancora scegliendo.`,
    );
  } else if (awareness.length > 0) {
    parts.push(
      `Contiene «${awareness.join('», «')}»: cerca informazioni, la conversione è lontana.`,
    );
  }

  if (cpc !== null) {
    parts.push(
      `Gli inserzionisti pagano per questa ricerca (CPC stimato ${Number(input.cpc).toFixed(2)}), segno che porta clienti.`,
    );
  }

  parts.push('Stima basata su intento e formulazione, non su conversioni misurate.');

  return { score, stage, rationale: parts.join(' '), signals };
}

/**
 * Priorità di produzione: unisce quanto vale una keyword a quanto è
 * raggiungibile.
 *
 * Sono due domande diverse e vanno tenute separate fino a qui. Il valore
 * commerciale dice *se vale la pena*; volume e difficoltà dicono *se ci
 * riusciamo*. Una keyword transazionale perfetta con difficoltà 95 resta un
 * investimento a perdere, e una facilissima su cui nessuno cerca nulla anche.
 *
 * Il valore commerciale pesa più della raggiungibilità (60/40) perché l'errore
 * costoso è il secondo tipo: riempire il calendario di articoli facili che non
 * portano clienti è il modo tipico in cui un blog aziendale diventa inutile pur
 * crescendo di traffico.
 */
export function computePriorityScore(params: {
  commercialScore: number;
  searchVolume?: number | null;
  difficulty?: string | number | null;
}): number {
  const volume = params.searchVolume ?? 0;
  // Log: fra 50 e 500 ricerche mensili la differenza conta, fra 5000 e 50000
  // molto meno — a quei volumi il vincolo è la difficoltà, non la domanda.
  const volumeScore = Math.min(1, Math.log10(1 + volume) / Math.log10(1 + 2000));

  const rawDifficulty =
    typeof params.difficulty === 'string'
      ? Number.parseFloat(params.difficulty)
      : params.difficulty;
  const difficulty = Number.isFinite(rawDifficulty)
    ? Math.min(100, Math.max(0, rawDifficulty as number))
    : 50;

  const reachability = (volumeScore * 0.5 + (1 - difficulty / 100) * 0.5) * 100;

  return (
    Math.round((params.commercialScore * 0.6 + reachability * 0.4) * 10) / 10
  );
}
