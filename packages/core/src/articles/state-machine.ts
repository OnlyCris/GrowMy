/**
 * MACCHINA A STATI DELL'ARTICOLO
 *
 * Le transizioni legali sono dichiarate qui una sola volta e validate a runtime.
 * Nessun punto del codice esegue `update(articles).set({ status: '...' })` con
 * una stringa arbitraria: ogni cambio di stato passa da `assertTransition`.
 *
 * Perché conta: la pipeline è concorrente. Un worker può stare pubblicando
 * mentre un utente clicca "approva", e un cron di auto-approvazione può
 * scattare nello stesso istante. Senza transizioni dichiarate si ottengono
 * articoli pubblicati due volte, o bozze approvate che non erano più in attesa.
 */

export type ArticleStatus =
  | 'queued'
  | 'researching'
  | 'brief_ready'
  | 'generating'
  | 'draft_ready'
  | 'approved'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'archived';

/**
 * Grafo delle transizioni consentite.
 *
 * Note di lettura:
 *  - `brief_ready -> researching` è il rifiuto del brief: si torna a ricercare
 *    con il feedback dell'utente.
 *  - `draft_ready -> generating` è il rifiuto della bozza o un rewrite mirato.
 *  - `published` non torna indietro. Un contenuto già live si aggiorna con un
 *    nuovo articolo di refresh, non mutando quello vecchio: altrimenti si perde
 *    la corrispondenza con l'URL indicizzato.
 *  - Da `failed` si può solo ritentare la pubblicazione o archiviare.
 */
const TRANSITIONS: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  queued: ['researching', 'archived', 'failed'],
  researching: ['brief_ready', 'generating', 'failed', 'archived'],
  brief_ready: ['generating', 'researching', 'archived'],
  generating: ['draft_ready', 'approved', 'failed', 'archived'],
  draft_ready: ['approved', 'generating', 'archived'],
  approved: ['publishing', 'draft_ready', 'archived'],
  publishing: ['published', 'failed'],
  published: ['archived'],
  failed: ['publishing', 'generating', 'archived'],
  archived: [],
} as const;

/** Stati che fermano la pipeline in attesa di una decisione umana. */
export const HUMAN_GATE_STATES: readonly ArticleStatus[] = [
  'brief_ready',
  'draft_ready',
] as const;

export function isHumanGate(status: ArticleStatus): boolean {
  return HUMAN_GATE_STATES.includes(status);
}

export function canTransition(
  from: ArticleStatus,
  to: ArticleStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Errore sollevato quando una transizione non è consentita. */
export class InvalidStateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION' as const;

  constructor(
    public readonly from: ArticleStatus,
    public readonly to: ArticleStatus,
  ) {
    super(
      `Transizione non consentita da «${from}» a «${to}». ` +
        'Probabilmente qualcun altro ha già agito su questo articolo: ricarica la pagina.',
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Valida la transizione o lancia.
 *
 * Il messaggio d'errore è deliberatamente orientato all'utente e non allo
 * sviluppatore: nel 99% dei casi questa eccezione scatta perché un collega ha
 * approvato lo stesso articolo qualche secondo prima, non per un bug.
 */
export function assertTransition(
  from: ArticleStatus,
  to: ArticleStatus,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Stato successivo dopo l'approvazione del brief, in funzione della
 * configurazione del prodotto.
 *
 * Con `autoApproveDraft` attivo si salta la seconda porta umana: l'articolo,
 * finita la stesura, va direttamente in coda di pubblicazione.
 */
export function nextStateAfterBriefApproval(): ArticleStatus {
  return 'generating';
}

/**
 * Stato in cui deve fermarsi la stesura, in funzione della configurazione.
 * È il punto in cui l'UPGRADE #1 diventa opzionale invece che obbligatorio:
 * chi vuole l'autopilota puro non vede mai la coda di revisione.
 */
export function stateAfterGeneration(autoApproveDraft: boolean): ArticleStatus {
  return autoApproveDraft ? 'approved' : 'draft_ready';
}

export function stateAfterResearch(autoApproveBrief: boolean): ArticleStatus {
  return autoApproveBrief ? 'generating' : 'brief_ready';
}
