import { creditLedger, getWorkerDb, usageCounters } from '@growmy/db';
import { eq, sql } from 'drizzle-orm';

/**
 * CHIUSURA DELLE RISERVE DI CREDITO — UPGRADE #3
 *
 * Il ledger è append-only a doppia entrata. Il ciclo di una generazione:
 *
 *   reserve (−1)  →  consume (0)   ← pubblicazione confermata
 *                 →  release (+1)  ← fallimento definitivo
 *
 * `reserve` viene scritto dalla funzione `app_enqueue_job()` all'accodamento.
 * Questo modulo scrive le due chiusure possibili.
 *
 * PERCHÉ CONTA: su Outrank un fallimento di pubblicazione brucia il credito —
 * l'utente paga per un articolo mai andato online. Qui il credito torna
 * indietro automaticamente.
 *
 * Entrambe le operazioni sono idempotenti: la chiave `consume:<reservationId>`
 * è unica, quindi un retry non può consumare due volte la stessa riserva né
 * restituire due crediti.
 */

/**
 * Conferma il consumo. Importo 0: la riserva ha già sottratto il credito,
 * questa riga chiude la partita e segna che l'operazione è riuscita.
 */
export async function consumeReservation(params: {
  organizationId: string;
  productId: string | null;
  articleId: string | null;
  reservationId: string;
}): Promise<void> {
  if (await isReservationClosed(params.reservationId)) return;

  await getWorkerDb().insert(creditLedger).values({
    organizationId: params.organizationId,
    productId: params.productId,
    articleId: params.articleId,
    type: 'consume',
    amount: 0,
    reservationId: params.reservationId,
    idempotencyKey: `consume:${params.reservationId}`,
    description: 'Credito consumato: articolo pubblicato',
  });
}

/**
 * Restituisce il credito dopo un fallimento definitivo.
 * Chiamata SOLO quando il job va in dead-letter: un fallimento con retry ancora
 * disponibili non deve rilasciare nulla, o il tentativo successivo lavorerebbe
 * senza copertura.
 */
export async function releaseReservation(params: {
  organizationId: string;
  productId: string | null;
  articleId: string | null;
  reservationId: string;
  reason: string;
}): Promise<void> {
  if (await isReservationClosed(params.reservationId)) return;

  await getWorkerDb().insert(creditLedger).values({
    organizationId: params.organizationId,
    productId: params.productId,
    articleId: params.articleId,
    type: 'release',
    amount: 1,
    reservationId: params.reservationId,
    idempotencyKey: `release:${params.reservationId}`,
    description: `Credito restituito: ${params.reason}`.slice(0, 500),
  });
}

/**
 * Vero se la riserva ha già una riga di chiusura.
 * Controllo preventivo per evitare l'eccezione; l'unique index sulla chiave di
 * idempotenza resta la garanzia sotto concorrenza.
 */
async function isReservationClosed(reservationId: string): Promise<boolean> {
  const rows = await getWorkerDb()
    .select({ type: creditLedger.type })
    .from(creditLedger)
    .where(eq(creditLedger.reservationId, reservationId));

  return rows.some((row) => row.type === 'consume' || row.type === 'release');
}

/** Estrae il reservationId dal payload del job, se la riserva esiste. */
export function reservationIdFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>).reservationId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Saldo disponibile, escluse le righe scadute. */
export async function availableCredits(
  organizationId: string,
): Promise<number> {
  const rows = await getWorkerDb()
    .select({ amount: creditLedger.amount, expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(eq(creditLedger.organizationId, organizationId));

  const now = Date.now();
  return rows.reduce((total, row) => {
    if (row.expiresAt && row.expiresAt.getTime() <= now) return total;
    return total + row.amount;
  }, 0);
}

type UsageField =
  | 'articlesGenerated'
  | 'articlesPublished'
  | 'articlesFailed'
  | 'imagesGenerated';

/**
 * Aggiorna i contatori di utilizzo del ciclo corrente.
 *
 * `onConflictDoUpdate` con incremento lato database: due worker concorrenti che
 * pubblicano nello stesso istante incrementano entrambi, mentre un
 * leggi-modifica-scrivi in JavaScript perderebbe uno dei due conteggi.
 */
export async function recordUsage(params: {
  organizationId: string;
  productId: string | null;
  field: UsageField;
  llmCostMicroUsd?: number;
}): Promise<void> {
  // Ciclo mensile allineato al primo del mese UTC: coincide con il rinnovo del
  // piano e rende i contatori confrontabili fra organizzazioni.
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  const cost = Math.round(params.llmCostMicroUsd ?? 0);

  /**
   * Colonna da incrementare, presa dalla definizione Drizzle invece che da una
   * stringa scritta a mano: un rename nello schema si propaga qui da solo,
   * mentre una stringa letterale si romperebbe in silenzio.
   */
  const targetColumn = usageCounters[params.field];

  await getWorkerDb()
    .insert(usageCounters)
    .values({
      organizationId: params.organizationId,
      productId: params.productId,
      periodStart,
      periodEnd,
      articlesGenerated: params.field === 'articlesGenerated' ? 1 : 0,
      articlesPublished: params.field === 'articlesPublished' ? 1 : 0,
      articlesFailed: params.field === 'articlesFailed' ? 1 : 0,
      imagesGenerated: params.field === 'imagesGenerated' ? 1 : 0,
      llmCostMicroUsd: cost,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.organizationId,
        usageCounters.productId,
        usageCounters.periodStart,
      ],
      set: {
        [params.field]: sql`${targetColumn} + 1`,
        llmCostMicroUsd: sql`${usageCounters.llmCostMicroUsd} + ${cost}`,
        updatedAt: new Date(),
      },
    });
}
