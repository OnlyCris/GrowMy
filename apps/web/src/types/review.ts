import type { ArticleStatus } from '@/components/shared/status-badge';

/**
 * View model della coda di revisione (UPGRADE #1).
 *
 * Sono tipi *di presentazione*, deliberatamente distinti dalle righe Drizzle:
 * il layer di query (`packages/db/src/queries/review.ts`) proietta le entità del
 * database in queste forme. Il vantaggio è che un componente non può ricevere
 * per sbaglio una colonna che non deve mai raggiungere il browser — per esempio
 * `integrations.encryptedCredentials` — perché il tipo semplicemente non la prevede.
 */

/** Un blocco dell'outline proposto dall'AI ed editabile prima della stesura. */
export interface BriefSection {
  /** Identificatore stabile lato client: consente il riordino senza perdere lo stato. */
  id: string;
  heading: string;
  /** Punti che la sezione deve coprire. */
  bullets: string[];
  /** Intento di ricerca servito da questa sezione. */
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  /** Parole indicative. La somma guida la stima di lunghezza totale. */
  estimatedWords: number;
}

/** Fonte che l'AI propone di citare. L'utente può rimuoverla o aggiungerne. */
export interface BriefSource {
  id: string;
  url: string;
  title: string;
  /** Perché questa fonte è rilevante: mostrato in tooltip. */
  reason: string;
}

export interface ArticleBrief {
  /** L'angolo editoriale: la scelta con più impatto e la meno reversibile. */
  angle: string;
  targetKeyword: string;
  secondaryKeywords: string[];
  sections: BriefSection[];
  sources: BriefSource[];
  /** Call to action proposta in chiusura. */
  cta: string | null;
  /** Articoli interni verso cui la stesura inserirà link. */
  internalLinkTargets: Array<{ articleId: string; title: string; slug: string }>;
}

/**
 * Punteggio qualità calcolato prima di mostrare la bozza all'utente.
 * Ogni metrica è 0-100 e ha una soglia sotto la quale scatta una rigenerazione
 * automatica gratuita (non consuma un secondo credito).
 */
export interface QualityScore {
  /** Leggibilità normalizzata (Flesch adattato alla lingua target). */
  readability: number;
  /** Densità della keyword: penalizza sia il keyword stuffing sia l'assenza. */
  keywordDensity: number;
  /** Distanza dai contenuti già pubblicati sullo stesso sito. */
  originality: number;
  /** Densità di affermazioni verificabili: l'antidoto alla prosa vuota. */
  factDensity: number;
  /** Copertura dei link interni rispetto al piano del brief. */
  internalLinks: number;
}

export type QualityMetricKey = keyof QualityScore;

/** Una voce della coda di revisione. */
export interface ReviewQueueItem {
  articleId: string;
  productId: string;
  productName: string;
  productDomain: string;

  /** Solo `brief_ready` o `draft_ready`: gli unici stati che fermano la pipeline. */
  status: Extract<ArticleStatus, 'brief_ready' | 'draft_ready'>;

  title: string | null;
  targetKeyword: string;

  /** Da quando l'articolo attende una decisione. */
  waitingSince: string;
  /**
   * Ore residue prima dell'auto-approvazione per timeout.
   * `null` se il prodotto attende indefinitamente.
   */
  hoursUntilAutoApproval: number | null;

  /** Presente solo se `status === 'brief_ready'`. */
  brief: ArticleBrief | null;
  /** Presente solo se `status === 'draft_ready'`. */
  draft: ArticleDraft | null;

  /** Presente solo su `draft_ready`. */
  qualityScore: QualityScore | null;

  /** Stima di quanto costa in crediti far ripartire la generazione. */
  regenerationCost: number;
}

export interface ArticleDraft {
  versionId: string;
  versionNumber: number;
  title: string;
  metaDescription: string;
  contentMarkdown: string;
  wordCount: number;
  featuredImageUrl: string | null;
  /** Versione precedente, se esiste: abilita la vista diff. */
  previousVersionId: string | null;
  /** Modello che ha prodotto la bozza: utile per il debug qualità. */
  llmModel: string | null;
}

/**
 * Risultato discriminato ritornato da ogni Server Action.
 * Non esponiamo mai eccezioni al client: l'errore è un valore, con un codice
 * macchina per la UI e un messaggio già leggibile per l'utente.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string; fieldErrors?: Record<string, string[]> };

export type ActionErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'INSUFFICIENT_CREDITS'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';
