import 'server-only';

import { articles, db, keywords, products } from '@growmy/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

/**
 * QUERY DEI PRODOTTI.
 *
 * Stessa disciplina di `lib/queries/review.ts`: `server-only`, select
 * esplicite (mai `select()` nudo), `organizationId` in ogni WHERE anche con
 * RLS attivo — difesa in profondità, non ridondanza.
 */

/**
 * Colonne per la lista, coi conteggi che rendono la scheda utile a colpo
 * d'occhio (quanti articoli pubblicati, quante keyword in coda) invece di
 * costringere ad aprire ogni prodotto per saperlo. Sottoquery correlate
 * invece di un JOIN + GROUP BY: con poche decine di prodotti per
 * organizzazione il piano resta banale, ed evita la moltiplicazione delle
 * righe che un doppio JOIN (articoli x keyword) produrrebbe.
 */
export async function getProductsForOrg(organizationId: string) {
  return db
    .select({
      id: products.id,
      name: products.name,
      domain: products.domain,
      status: products.status,
      updatedAt: products.updatedAt,
      // `sql.raw('"products"."id"')` invece di `${products.id}`: dentro una
      // subquery, Drizzle non qualifica il riferimento alla tabella esterna
      // (emette "id" nudo) — e sia `articles` sia `keywords` hanno una loro
      // colonna `id`, che Postgres preferisce silenziosamente a quella
      // esterna. Risultato senza qualificazione esplicita: il conteggio è
      // sempre 0, senza errore che lo segnali. Verificato con una query
      // diretta contro il database prima di questo fix.
      publishedArticleCount: sql<number>`(
        select count(*)::int from ${articles}
        where ${articles.productId} = ${sql.raw('"products"."id"')}
          and ${articles.status} = 'published'
          and ${articles.deletedAt} is null
      )`,
      keywordCount: sql<number>`(
        select count(*)::int from ${keywords}
        where ${keywords.productId} = ${sql.raw('"products"."id"')}
          and ${keywords.deletedAt} is null
      )`,
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
