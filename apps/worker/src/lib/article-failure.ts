import { canTransition, type ArticleStatus } from '@growmy/core';
import { articles, getWorkerDb } from '@growmy/db';
import { eq } from 'drizzle-orm';

/**
 * Sincronizza un articolo con l'esito definitivo (dead-letter) del job che lo
 * stava elaborando.
 *
 * Prima di questa funzione, un job in dead-letter lasciava l'articolo fermo
 * nello stato in cui si trovava (es. `generating`), senza alcuna causa
 * visibile: lo schema aveva già `status: 'failed'` e `failure_reason`, e la
 * UI li mostrava già, ma nessun punto del worker li scriveva mai. Scoperto in
 * produzione su 4 articoli bloccati senza spiegazione dopo che tutti i
 * provider LLM configurati avevano esaurito la quota nello stesso momento.
 *
 * `canTransition` protegge dal caso in cui l'articolo sia già avanzato altrove
 * nel frattempo (es. un umano l'ha nel frattempo scartato): in quel caso non
 * si tocca nulla, il job era comunque diventato irrilevante.
 */
export async function markArticleFailed(
  articleId: string,
  failureReason: string,
): Promise<void> {
  const db = getWorkerDb();

  const [row] = await db
    .select({ status: articles.status })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1);

  if (!row) return;

  if (!canTransition(row.status as ArticleStatus, 'failed')) return;

  await db
    .update(articles)
    .set({ status: 'failed', failureReason, updatedAt: new Date() })
    .where(eq(articles.id, articleId));
}
