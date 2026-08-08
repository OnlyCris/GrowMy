import 'server-only';

import { db, keywordClusters, keywords } from '@growmy/db';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

/**
 * QUERY DELLE KEYWORD. Stessa disciplina di `lib/queries/products.ts`:
 * `server-only`, select esplicite, `organizationId`/`productId` nel WHERE
 * anche con RLS attivo.
 */

/**
 * Ordina per cluster (pillar prima dei suoi compagni) invece che solo per
 * priorità: è quello che rende visibile in UI la struttura hub-and-spoke,
 * non solo la lista piatta.
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
      clusterId: keywords.clusterId,
      clusterName: keywordClusters.name,
      isPillar: keywords.isPillar,
      // Servono a `assessCommercialValue`, che ricava stadio del funnel e
      // potenziale in lettura invece di leggerli da una colonna: il punteggio
      // resta allineato all'algoritmo corrente anche per le keyword vecchie.
      searchIntent: keywords.searchIntent,
      cpc: keywords.cpc,
      searchVolume: keywords.searchVolume,
      difficulty: keywords.difficulty,
      priorityRationale: keywords.priorityRationale,
    })
    .from(keywords)
    .leftJoin(keywordClusters, eq(keywordClusters.id, keywords.clusterId))
    .where(and(eq(keywords.productId, productId), isNull(keywords.deletedAt)))
    .orderBy(
      asc(keywords.clusterId),
      desc(keywords.isPillar),
      desc(keywords.priorityScore),
      desc(keywords.createdAt),
    );
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
      clusterId: keywords.clusterId,
      isPillar: keywords.isPillar,
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
