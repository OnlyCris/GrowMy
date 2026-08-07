import 'server-only';

import { db, products } from '@growmy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

/**
 * QUERY DEI PRODOTTI.
 *
 * Stessa disciplina di `lib/queries/review.ts`: `server-only`, select
 * esplicite (mai `select()` nudo), `organizationId` in ogni WHERE anche con
 * RLS attivo — difesa in profondità, non ridondanza.
 */

/** Colonne per la lista: nulla di pesante (niente brand profile). */
export async function getProductsForOrg(organizationId: string) {
  return db
    .select({
      id: products.id,
      name: products.name,
      domain: products.domain,
      status: products.status,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), isNull(products.deletedAt)))
    .orderBy(desc(products.updatedAt));
}

/** Tutti i campi editoriali, per la pagina impostazioni. */
export async function getProductById(organizationId: string, productId: string) {
  const [row] = await db
    .select({
      id: products.id,
      name: products.name,
      domain: products.domain,
      websiteUrl: products.websiteUrl,
      blogDomain: products.blogDomain,
      status: products.status,
      contentLanguage: products.contentLanguage,
      timezone: products.timezone,
      publishHour: products.publishHour,
      activeWeekdays: products.activeWeekdays,
      targetWordCountMin: products.targetWordCountMin,
      targetWordCountMax: products.targetWordCountMax,
      autoApproveBrief: products.autoApproveBrief,
      autoApproveDraft: products.autoApproveDraft,
      approvalTimeoutHours: products.approvalTimeoutHours,
    })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.organizationId, organizationId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Risale dall'id prodotto alla sua organizzazione — stesso pattern di `getArticleOrganizationId`. */
export async function getProductOrganizationId(productId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: products.organizationId })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);

  return row?.organizationId ?? null;
}
