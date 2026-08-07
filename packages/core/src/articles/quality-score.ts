/**
 * CALCOLO DEL QUALITY SCORE — UPGRADE #1
 *
 * Cinque metriche 0-100, calcolate in modo DETERMINISTICO dal testo. Nessuna
 * chiamata a un LLM: chiedere a un modello di valutare il proprio output
 * produce voti gonfiati e costa un'altra chiamata.
 *
 * Il punteggio non decide se pubblicare — decide DOVE far guardare l'umano.
 * Una metrica sotto soglia è l'unica barra ambra del pannello, e quella è
 * l'informazione utile: dove intervenire senza rileggere 1.600 parole.
 *
 * In `packages/core` (non nel worker, dove viveva prima) perché serve anche
 * al web per gli articoli scritti a mano: il punteggio si applica allo STESSO
 * modo a testo umano e generato, la qualità non fa sconti a chi l'ha scritto.
 */

/**
 * NOTA SU `type` INVECE DI `interface`.
 *
 * La colonna `articles.quality_score` è tipizzata `Record<string, number>`.
 * Un'`interface` NON è assegnabile a un `Record<string, ...>` in TypeScript,
 * perché le interfacce non ricevono una index signature implicita — possono
 * essere estese in seguito, quindi il compilatore non può garantire che tutte
 * le proprietà future siano numeri. Un `type` alias è chiuso e la ottiene.
 *
 * È un dettaglio noioso ma reale: cambiarlo in `interface` rompe il build.
 */
export type QualityScore = {
  readability: number;
  keywordDensity: number;
  originality: number;
  factDensity: number;
  internalLinks: number;
};

export interface QualityScoreInput {
  markdown: string;
  targetKeyword: string;
  /** Sezioni previste dal brief: base per il punteggio sui link interni. */
  briefSectionCount: number;
}

export function computeQualityScore(input: QualityScoreInput): QualityScore {
  const plain = stripMarkdown(input.markdown);

  return {
    readability: scoreReadability(plain),
    keywordDensity: scoreKeywordDensity(plain, input.targetKeyword),
    originality: scoreOriginality(plain),
    factDensity: scoreFactDensity(plain),
    internalLinks: scoreInternalLinks(input.markdown, input.briefSectionCount),
  };
}

/** Rimuove la sintassi Markdown lasciando il testo leggibile. */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Leggibilità: lunghezza media delle frasi e delle parole.
 *
 * Non usiamo Flesch puro perché è tarato sull'inglese e penalizza l'italiano,
 * che ha parole strutturalmente più lunghe. Misuriamo invece i due fattori che
 * contano davvero — frasi lunghe e lessico pesante — con soglie adatte alla
 * prosa italiana.
 */
function scoreReadability(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
  if (sentences.length === 0) return 0;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const avgWordsPerSentence = words.length / sentences.length;
  const avgCharsPerWord =
    words.reduce((sum, w) => sum + w.length, 0) / words.length;

  // 15 parole per frase è l'ottimo; oltre 30 diventa faticoso.
  const sentenceScore = clamp(
    100 - Math.max(0, avgWordsPerSentence - 15) * 4,
    0,
    100,
  );

  // 5 caratteri per parola è la media italiana; oltre 7 il lessico è pesante.
  const wordScore = clamp(100 - Math.max(0, avgCharsPerWord - 5) * 15, 0, 100);

  // Le frasi molto lunghe pesano più del lessico: sono la causa principale
  // dell'abbandono di lettura.
  return Math.round(sentenceScore * 0.65 + wordScore * 0.35);
}

/**
 * Densità della keyword.
 *
 * Penalizza SIA l'assenza SIA lo stuffing: la curva ha un massimo intorno
 * all'1% e scende da entrambi i lati. Una densità del 5% non è "molto
 * ottimizzato", è un testo che Google declassa.
 */
function scoreKeywordDensity(text: string, keyword: string): number {
  if (!keyword.trim()) return 50;

  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase().trim();
  const totalWords = text.split(/\s+/).filter(Boolean).length;
  if (totalWords === 0) return 0;

  // Occorrenze esatte.
  const exactMatches = countOccurrences(lowerText, lowerKeyword);

  // Occorrenze parziali: le varianti flesse contano, ma meno.
  const keywordWords = lowerKeyword.split(/\s+/).filter((w) => w.length > 3);
  const partialMatches =
    keywordWords.length > 0
      ? Math.min(
          ...keywordWords.map((w) => countOccurrences(lowerText, w)),
        )
      : 0;

  const effective = exactMatches + partialMatches * 0.3;
  const densityPercent = (effective * keywordWords.length * 100) / totalWords;

  if (effective === 0) return 0;

  // Ottimo a 1%: sotto lo 0.3% è insufficiente, sopra il 3% è stuffing.
  if (densityPercent < 0.3) return Math.round(40 * (densityPercent / 0.3));
  if (densityPercent <= 1.5) return 100;
  if (densityPercent <= 3) return Math.round(100 - (densityPercent - 1.5) * 25);
  return Math.max(10, Math.round(60 - (densityPercent - 3) * 20));
}

/**
 * Originalità: penalizza le frasi fatte e i riempitivi.
 *
 * Non confronta con il web — quello richiederebbe un servizio esterno. Misura
 * invece il segnale più affidabile di prosa generata pigramente: la densità di
 * costruzioni vuote.
 */
const FILLER_PATTERNS = [
  /nel mondo di oggi/gi,
  /è importante (?:notare|sottolineare|ricordare)/gi,
  /in conclusione/gi,
  /in questo articolo/gi,
  /come (?:abbiamo|già) (?:visto|detto)/gi,
  /non c'è dubbio che/gi,
  /vale la pena (?:notare|ricordare)/gi,
  /al giorno d'oggi/gi,
  /in un'era (?:digitale|moderna)/gi,
  /riveste un ruolo (?:fondamentale|cruciale)/gi,
  /gioca un ruolo (?:chiave|importante)/gi,
] as const;

function scoreOriginality(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;

  let fillerCount = 0;
  for (const pattern of FILLER_PATTERNS) {
    fillerCount += (text.match(pattern) ?? []).length;
  }

  // Ogni riempitivo ogni 200 parole costa 12 punti.
  const per200 = (fillerCount * 200) / words;
  const fillerPenalty = per200 * 12;

  // Le frasi ripetute quasi identiche indicano generazione ridondante.
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 25);

  const uniqueOpenings = new Set(
    sentences.map((s) => s.split(/\s+/).slice(0, 4).join(' ')),
  );

  const repetitionRatio =
    sentences.length > 0 ? uniqueOpenings.size / sentences.length : 1;
  const repetitionPenalty = (1 - repetitionRatio) * 40;

  return Math.round(clamp(100 - fillerPenalty - repetitionPenalty, 0, 100));
}

/**
 * Densità fattuale: quantità di affermazioni verificabili.
 *
 * È la metrica più predittiva della qualità reale — distingue un testo utile da
 * uno che gira attorno all'argomento — e per questo pesa doppio nella media del
 * pannello.
 */
function scoreFactDensity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;

  let signals = 0;

  // Numeri con unità o percentuali: "23%", "1.200 euro", "5 minuti".
  signals += (text.match(/\d+(?:[.,]\d+)?\s*(?:%|percento|€|euro|\$|kg|km|ore|minuti|giorni|mesi|anni|volte)/gi) ?? []).length * 2;

  // Anni e date.
  signals += (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).length * 1.5;

  // Numeri grandi formattati: quasi sempre dati reali.
  signals += (text.match(/\b\d{1,3}(?:[.,]\d{3})+\b/g) ?? []).length * 2;

  // Riferimenti a fonti e studi.
  signals += (text.match(/\b(?:studio|ricerca|secondo|indagine|rapporto|analisi)\b/gi) ?? []).length;

  // Normativa e articoli di legge: rilevanti per i contenuti professionali.
  signals += (text.match(/\b(?:articolo|comma|decreto|legge|normativa|regolamento)\s+\d+/gi) ?? []).length * 2;

  // Numeri semplici: deboli da soli, contano poco.
  signals += (text.match(/\b\d+\b/g) ?? []).length * 0.3;

  // 12 segnali ogni 1000 parole = punteggio pieno.
  const per1000 = (signals * 1_000) / words;
  return Math.round(clamp((per1000 / 12) * 100, 0, 100));
}

/**
 * Copertura dei link interni rispetto alla struttura dell'articolo.
 * Regola pratica: un link interno ogni due sezioni, minimo due per articolo.
 */
function scoreInternalLinks(markdown: string, briefSectionCount: number): number {
  // Link relativi: puntano al sito stesso.
  const internal = (markdown.match(/\[[^\]]+\]\(\/[^)]*\)/g) ?? []).length;

  const expected = Math.max(2, Math.ceil(briefSectionCount / 2));
  if (internal === 0) return 0;

  return Math.round(clamp((internal / expected) * 100, 0, 100));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Conta le parole ignorando la sintassi Markdown. */
export function countWords(markdown: string): number {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ') // blocchi di codice
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // immagini
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link -> solo il testo
    .replace(/[#*_>`~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return plain ? plain.split(' ').length : 0;
}
