import 'server-only';

import { db, keywords } from '@growmy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

/**
 * QUERY DELLE KEYWORD. Stessa disciplina di `lib/queries/products.ts`:
 * `server-only`, select esplicite, `organizationId`/`productId` nel WHERE
 * anche con RLS attivo.
 */

export async function getKeywordsForProduct(productId: string) {
  return db
    .select({
      id: keywords.id,
      term: keywords.term,
      status: keywords.status,
      source: keywords.source,
      priorityScore: keywords.priorityScore,
      createdAt: keywords.createdAt,
    })
    .from(keywords)
    .where(and(eq(keywords.productId, productId), isNull(keywords.deletedAt)))
    .orderBy(desc(keywords.priorityScore), desc(keywords.createdAt));
}

/**
 * Risale dalla keyword alla sua organizzazione. `organization_id` è
 * denormalizzato sulla tabella (stessa scelta di `products`/`articles`):
 * nessun join necessario, stesso pattern di `getProductOrganizationId`.
 */
export async function getKeywordOrganizationId(keywordId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: keywords.organizationId })
    .from(keywords)
    .where(and(eq(keywords.id, keywordId), isNull(keywords.deletedAt)))
    .limit(1);

  return row?.organizationId ?? null;
}

/** Riga completa, usata da `generateArticleFromKeyword` per leggere prima di scrivere. */
export async function getKeywordById(keywordId: string, organizationId: string) {
  const [row] = await db
    .select({
      id: keywords.id,
      productId: keywords.productId,
      term: keywords.term,
      status: keywords.status,
    })
    .from(keywords)
    .where(
      and(
        eq(keywords.id, keywordId),
        eq(keywords.organizationId, organizationId),
        isNull(keywords.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}
