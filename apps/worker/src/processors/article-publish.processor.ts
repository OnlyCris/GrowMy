import {
  createAdapter,
  createCipherFromEnv,
  markdownToHtml,
  PublishError,
  type ArticlePayload,
} from '@growmy/integrations';
import {
  articlePublications,
  articleVersions,
  articles,
  getWorkerDb,
  integrations,
} from '@growmy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { consumeReservation, recordUsage, reservationIdFromPayload } from '../lib/credits';
import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI PUBBLICAZIONE — cuore dell'UPGRADE #3
 *
 * Tre cose che l'originale non fa:
 *
 *  1. OGNI TENTATIVO viene registrato in `article_publications` con causa
 *     leggibile, codice macchina e prossimo retry. L'utente vede una timeline,
 *     non un generico "pubblicazione fallita".
 *
 *  2. IL CREDITO SI CONSUMA SOLO A PUBBLICAZIONE CONFERMATA. Fino a quel
 *     momento resta riservato; se il job muore definitivamente, il gestore in
 *     `index.ts` lo restituisce.
 *
 *  3. Gli errori sono classificati: un token revocato non viene ritentato
 *     cinque volte prima di avvisare l'utente.
 */

interface PublishPayload {
  versionId?: string;
  reservationId?: string;
}

export async function processArticlePublish(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger, job } = ctx;
  const articleId = job.targetId;

  if (!articleId) throw new Error('Job di pubblicazione senza targetId.');

  const payload = (job.payload ?? {}) as PublishPayload;

  // --- Articolo e versione da pubblicare ----------------------------------
  const [article] = await db
    .select({
      id: articles.id,
      status: articles.status,
      productId: articles.productId,
      title: articles.title,
      slug: articles.slug,
      metaDescription: articles.metaDescription,
      excerpt: articles.excerpt,
      featuredImageUrl: articles.featuredImageUrl,
      currentVersionId: articles.currentVersionId,
      externalId: articles.externalId,
    })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1);

  if (!article) throw new Error(`Articolo ${articleId} non trovato.`);

  const versionId = payload.versionId ?? article.currentVersionId;
  if (!versionId) throw new Error('Nessuna versione da pubblicare.');

  const [version] = await db
    .select({
      contentMarkdown: articleVersions.contentMarkdown,
      title: articleVersions.title,
      metaDescription: articleVersions.metaDescription,
    })
    .from(articleVersions)
    .where(eq(articleVersions.id, versionId))
    .limit(1);

  if (!version) throw new Error('Versione non trovata.');

  // --- Integrazione di destinazione ---------------------------------------
  const [integration] = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      encryptedCredentials: integrations.encryptedCredentials,
      credentialsIv: integrations.credentialsIv,
      credentialsKeyVersion: integrations.credentialsKeyVersion,
      config: integrations.config,
      publishAsDraft: integrations.publishAsDraft,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.productId, article.productId),
        eq(integrations.isPrimary, true),
        isNull(integrations.deletedAt),
      ),
    )
    .limit(1);

  if (!integration) {
    // Non è un errore transitorio: senza integrazione non si pubblicherà mai.
    throw new PublishError(
      'Nessuna integrazione primaria configurata',
      'NO_PRIMARY_INTEGRATION',
      false,
      'Nessun CMS collegato a questo prodotto. Configura un’integrazione dalle impostazioni.',
    );
  }

  if (integration.status === 'disabled') {
    throw new PublishError(
      'Integrazione disattivata',
      'INTEGRATION_DISABLED',
      false,
      'L’integrazione è disattivata. Riattivala dalle impostazioni per pubblicare.',
    );
  }

  // --- Transizione a `publishing` -----------------------------------------
  // Compare-and-swap: se un altro worker ha già preso in carico l'articolo,
  // nessuna riga viene aggiornata e usciamo senza pubblicare due volte.
  const claimed = await db
    .update(articles)
    .set({ status: 'publishing', updatedAt: new Date() })
    .where(
      and(
        eq(articles.id, articleId),
        // `failed` è incluso: il retry manuale riparte da lì.
        eq(articles.status, article.status === 'failed' ? 'failed' : 'approved'),
      ),
    )
    .returning({ id: articles.id });

  if (claimed.length === 0 && article.status !== 'publishing') {
    await recorder.event({
      step: 'publish.skipped',
      level: 'warn',
      message: `L’articolo non è in stato pubblicabile (stato: ${article.status}).`,
    });
    return;
  }

  // --- Decifratura delle credenziali --------------------------------------
  // Questo processo è l'unico a possedere CREDENTIALS_ENCRYPTION_KEY: l'app
  // web non può decifrare le credenziali dei CMS dei clienti.
  const cipher = createCipherFromEnv();
  const credentials = cipher.decrypt<Record<string, unknown>>({
    ciphertext: integration.encryptedCredentials,
    iv: integration.credentialsIv,
    keyVersion: integration.credentialsKeyVersion,
  });

  const adapter = createAdapter(
    integration.provider,
    credentials,
    (integration.config as Record<string, unknown>) ?? {},
  );

  // --- Numero del tentativo ------------------------------------------------
  const [lastAttempt] = await db
    .select({ attemptNumber: articlePublications.attemptNumber })
    .from(articlePublications)
    .where(
      and(
        eq(articlePublications.articleId, articleId),
        eq(articlePublications.integrationId, integration.id),
      ),
    )
    .orderBy(desc(articlePublications.attemptNumber))
    .limit(1);

  const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

  const payloadForCms: ArticlePayload = {
    title: version.title ?? article.title ?? 'Senza titolo',
    slug: article.slug ?? 'articolo',
    contentMarkdown: version.contentMarkdown,
    contentHtml: markdownToHtml(version.contentMarkdown),
    metaDescription: version.metaDescription ?? article.metaDescription ?? '',
    excerpt: article.excerpt,
    featuredImageUrl: article.featuredImageUrl,
    asDraft: integration.publishAsDraft,
    externalId: article.externalId,
  };

  const startedAt = Date.now();

  try {
    const result = await recorder.step(
      'publish.send',
      `Invio a ${integration.provider} (tentativo ${attemptNumber})`,
      async () =>
        article.externalId
          ? adapter.update(payloadForCms)
          : adapter.publish(payloadForCms),
    );

    const durationMs = Date.now() - startedAt;

    // --- Successo ----------------------------------------------------------
    await db.insert(articlePublications).values({
      articleId,
      integrationId: integration.id,
      attemptNumber,
      status: 'succeeded',
      httpStatus: 200,
      externalId: result.externalId,
      publishedUrl: result.publishedUrl,
      durationMs,
    });

    await db
      .update(articles)
      .set({
        status: 'published',
        publishedUrl: result.publishedUrl,
        externalId: result.externalId,
        publishedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, articleId));

    // Salute dell'integrazione: un successo azzera i fallimenti consecutivi.
    await db
      .update(integrations)
      .set({
        status: 'healthy',
        consecutiveFailures: 0,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integration.id));

    // --- Chiusura del credito ----------------------------------------------
    // SOLO ORA il credito viene consumato: la pubblicazione è confermata.
    const reservationId =
      payload.reservationId ?? reservationIdFromPayload(job.payload);

    if (reservationId) {
      await consumeReservation({
        organizationId: job.organizationId,
        productId: article.productId,
        articleId,
        reservationId,
      });
    }

    await recordUsage({
      organizationId: job.organizationId,
      productId: article.productId,
      field: 'articlesPublished',
    });

    await recorder.event({
      step: 'publish.done',
      message: `Pubblicato: ${result.publishedUrl}`,
      details: { provider: integration.provider, durationMs },
    });

    logger.info(
      { articleId, url: result.publishedUrl, provider: integration.provider },
      'articolo pubblicato',
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const isPublishError = error instanceof PublishError;
    const retryable = isPublishError ? error.retryable : true;
    const willRetry = retryable && job.attempts < job.maxAttempts;

    const userMessage = isPublishError
      ? error.userMessage
      : 'Errore imprevisto durante la pubblicazione.';

    // Backoff esponenziale, allineato a quello di BullMQ.
    const nextRetryAt = willRetry
      ? new Date(Date.now() + Math.min(5_000 * 2 ** job.attempts, 300_000))
      : null;

    // Il log per-tentativo: è ciò che l'utente vede nella timeline.
    await db.insert(articlePublications).values({
      articleId,
      integrationId: integration.id,
      attemptNumber,
      status: willRetry ? 'failed_retryable' : 'failed_permanent',
      httpStatus: isPublishError ? (error.httpStatus ?? null) : null,
      errorMessage: userMessage,
      errorCode: isPublishError ? error.code : 'UNKNOWN',
      durationMs,
      nextRetryAt,
    });

    // Salute dell'integrazione: fallimenti ripetuti la marcano da riparare,
    // così l'utente lo scopre dalla pagina integrazioni e non dal singolo job.
    const failures = await countRecentFailures(integration.id);
    await db
      .update(integrations)
      .set({
        status: !retryable ? 'broken' : failures >= 3 ? 'degraded' : integration.status,
        consecutiveFailures: failures,
        lastErrorMessage: userMessage,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integration.id));

    if (!willRetry) {
      await db
        .update(articles)
        .set({
          status: 'failed',
          failureReason: userMessage,
          updatedAt: new Date(),
        })
        .where(eq(articles.id, articleId));

      await recordUsage({
        organizationId: job.organizationId,
        productId: article.productId,
        field: 'articlesFailed',
      });
    } else {
      // Torna in `approved` così il retry trova lo stato atteso.
      await db
        .update(articles)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(eq(articles.id, articleId));
    }

    // Rilancia: il gestore in index.ts decide retry o dead-letter, e in
    // quest'ultimo caso restituisce il credito.
    throw error;
  }
}

/** Fallimenti consecutivi recenti su un'integrazione. */
async function countRecentFailures(integrationId: string): Promise<number> {
  const db = getWorkerDb();

  const rows = await db
    .select({ status: articlePublications.status })
    .from(articlePublications)
    .where(eq(articlePublications.integrationId, integrationId))
    .orderBy(desc(articlePublications.attemptedAt))
    .limit(10);

  let consecutive = 0;
  for (const row of rows) {
    if (row.status === 'succeeded') break;
    consecutive++;
  }
  return consecutive;
}
