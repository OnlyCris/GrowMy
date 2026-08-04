import {
  checkGuardrails,
  countWords,
  draftPrompt,
  hasBlockingViolation,
  parseJsonResponse,
  sectionRewritePrompt,
  type BrandContext,
  type DraftResult,
} from '@growmy/ai';
import { stateAfterGeneration } from '@growmy/core';
import {
  articleVersions,
  articles,
  getWorkerDb,
  keywords,
  productBrandProfiles,
  products,
} from '@growmy/db';
import { desc, eq } from 'drizzle-orm';

import { recordUsage } from '../lib/credits';
import { computeQualityScore } from '../lib/quality-score';
import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI STESURA
 *
 * Due modalità nello stesso processore:
 *
 *   'full'            — scrive l'articolo da zero seguendo il brief approvato.
 *   'section_rewrite' — riscrive UNA sezione preservando tutto il resto.
 *
 * La seconda è ciò che evita il ciclo distruttivo "non mi piace un paragrafo →
 * rigenero tutto → perdo il resto che andava bene".
 *
 * Ogni esito crea una NUOVA riga in `article_versions`: append-only, quindi il
 * diff e il rollback sono gratuiti e nessuna versione viene mai sovrascritta.
 */

interface GeneratePayload {
  mode?: 'full' | 'section_rewrite';
  humanFeedback?: string | null;
  sectionHeading?: string;
  instruction?: string;
  baseVersionId?: string | null;
  fullRegeneration?: boolean;
}

export async function processArticleGenerate(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, llm, logger, job } = ctx;
  const articleId = job.targetId;

  if (!articleId) {
    throw new Error('Job di generazione senza targetId.');
  }

  const payload = (job.payload ?? {}) as GeneratePayload;
  const mode = payload.mode ?? 'full';

  const [row] = await db
    .select({
      articleStatus: articles.status,
      brief: articles.brief,
      currentVersionId: articles.currentVersionId,
      keywordTerm: keywords.term,
      productId: products.id,
      productName: products.name,
      domain: products.domain,
      contentLanguage: products.contentLanguage,
      wordMin: products.targetWordCountMin,
      wordMax: products.targetWordCountMax,
      autoApproveDraft: products.autoApproveDraft,
      businessSummary: productBrandProfiles.businessSummary,
      targetAudience: productBrandProfiles.targetAudience,
      valueProposition: productBrandProfiles.valueProposition,
      toneOfVoice: productBrandProfiles.toneOfVoice,
      forbiddenTopics: productBrandProfiles.forbiddenTopics,
    })
    .from(articles)
    .innerJoin(products, eq(products.id, articles.productId))
    .leftJoin(keywords, eq(keywords.id, articles.keywordId))
    .leftJoin(
      productBrandProfiles,
      eq(productBrandProfiles.productId, products.id),
    )
    .where(eq(articles.id, articleId))
    .limit(1);

  if (!row) throw new Error(`Articolo ${articleId} non trovato.`);

  const brand: BrandContext = {
    productName: row.productName,
    domain: row.domain,
    language: row.contentLanguage,
    businessSummary: row.businessSummary,
    targetAudience: row.targetAudience,
    valueProposition: row.valueProposition,
    toneOfVoice: row.toneOfVoice,
    forbiddenTopics: (row.forbiddenTopics as string[] | null) ?? [],
  };

  const forbiddenTopics = brand.forbiddenTopics ?? [];
  const keyword = row.keywordTerm ?? '';

  // Numero della prossima versione: sempre l'ultimo + 1.
  const [lastVersion] = await db
    .select({ versionNumber: articleVersions.versionNumber })
    .from(articleVersions)
    .where(eq(articleVersions.articleId, articleId))
    .orderBy(desc(articleVersions.versionNumber))
    .limit(1);

  const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;

  // -------------------------------------------------------------------------
  // Modalità: riscrittura di una sezione
  // -------------------------------------------------------------------------
  if (mode === 'section_rewrite') {
    if (!payload.sectionHeading || !payload.instruction) {
      throw new Error('Riscrittura richiesta senza sezione o istruzione.');
    }

    const baseVersionId = payload.baseVersionId ?? row.currentVersionId;
    if (!baseVersionId) {
      throw new Error('Nessuna versione di partenza per la riscrittura.');
    }

    const [base] = await db
      .select({
        contentMarkdown: articleVersions.contentMarkdown,
        title: articleVersions.title,
        metaDescription: articleVersions.metaDescription,
      })
      .from(articleVersions)
      .where(eq(articleVersions.id, baseVersionId))
      .limit(1);

    if (!base) throw new Error('Versione di partenza non trovata.');

    const result = await recorder.step(
      'generate.rewrite',
      `Riscrittura della sezione «${payload.sectionHeading}»`,
      async () =>
        llm.complete({
          messages: sectionRewritePrompt({
            brand,
            fullMarkdown: base.contentMarkdown,
            sectionHeading: payload.sectionHeading!,
            instruction: payload.instruction!,
          }),
          jsonMode: true,
          temperature: 0.7,
        }),
    );

    const rewritten = parseJsonResponse<{ contentMarkdown: string }>(
      result.text,
    );

    if (!rewritten.contentMarkdown?.trim()) {
      throw new Error('La riscrittura ha prodotto un contenuto vuoto.');
    }

    const [version] = await db
      .insert(articleVersions)
      .values({
        articleId,
        versionNumber: nextVersionNumber,
        contentMarkdown: rewritten.contentMarkdown,
        title: base.title,
        metaDescription: base.metaDescription,
        createdVia: 'ai_rewrite',
        llmProvider: result.provider,
        llmModel: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicroUsd: result.costMicroUsd,
      })
      .returning({ id: articleVersions.id });

    const quality = computeQualityScore({
      markdown: rewritten.contentMarkdown,
      targetKeyword: keyword,
      briefSectionCount: countBriefSections(row.brief),
    });

    // Lo stato NON cambia: l'articolo resta in `draft_ready` e l'utente
    // continua a vederlo in coda mentre la sezione viene aggiornata.
    await db
      .update(articles)
      .set({
        currentVersionId: version.id,
        wordCount: countWords(rewritten.contentMarkdown),
        qualityScore: quality,
        updatedAt: new Date(),
      })
      .where(eq(articles.id, articleId));

    await recordUsage({
      organizationId: job.organizationId,
      productId: row.productId,
      field: 'articlesGenerated',
      llmCostMicroUsd: result.costMicroUsd,
    });

    await recorder.event({
      step: 'generate.done',
      message: `Sezione «${payload.sectionHeading}» riscritta. Versione ${nextVersionNumber} pronta.`,
      details: { provider: result.provider, costMicroUsd: result.costMicroUsd },
    });

    return;
  }

  // -------------------------------------------------------------------------
  // Modalità: stesura completa
  // -------------------------------------------------------------------------
  if (!row.brief) {
    throw new Error('Impossibile scrivere: il brief non è stato generato.');
  }

  /**
   * Un solo ritentativo automatico se i guardrail bloccano il primo esito.
   * Non consuma un credito aggiuntivo: il credito è già riservato, e far pagare
   * all'utente un output che abbiamo scartato noi sarebbe scorretto.
   */
  let draft: DraftResult | null = null;
  let usedResult: Awaited<ReturnType<typeof llm.complete>> | null = null;
  let lastViolations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await recorder.step(
      'generate.draft',
      attempt === 0
        ? 'Stesura dell’articolo'
        : 'Nuova stesura dopo i controlli di qualità',
      async () =>
        llm.complete({
          messages: draftPrompt({
            brand,
            brief: row.brief,
            targetWordCountMin: row.wordMin,
            targetWordCountMax: row.wordMax,
            humanFeedback:
              attempt === 0
                ? payload.humanFeedback
                : `${payload.humanFeedback ?? ''}\n\nProblemi nella versione precedente: ${lastViolations.join('; ')}`.trim(),
          }),
          jsonMode: true,
          temperature: 0.8,
          maxOutputTokens: 16_000,
        }),
    );

    const candidate = parseJsonResponse<DraftResult>(result.text);

    if (!candidate.contentMarkdown?.trim() || !candidate.title?.trim()) {
      lastViolations = ['contenuto o titolo mancante'];
      continue;
    }

    const violations = checkGuardrails({
      contentMarkdown: candidate.contentMarkdown,
      title: candidate.title,
      targetKeyword: keyword,
      forbiddenTopics,
      minWords: row.wordMin,
      maxWords: row.wordMax,
    });

    if (violations.length > 0) {
      await recorder.event({
        step: 'generate.guardrails',
        level: hasBlockingViolation(violations) ? 'warn' : 'info',
        message: `Controlli di qualità: ${violations.map((v) => v.message).join(' ')}`,
      });
    }

    if (!hasBlockingViolation(violations)) {
      draft = candidate;
      usedResult = result;
      break;
    }

    lastViolations = violations
      .filter((v) => v.severity === 'error')
      .map((v) => v.message);

    // Ultimo tentativo fallito: meglio un articolo imperfetto in revisione
    // umana che un job in dead-letter e un credito da restituire.
    if (attempt === 1) {
      draft = candidate;
      usedResult = result;
      await recorder.event({
        step: 'generate.guardrails',
        level: 'warn',
        message:
          'I controlli di qualità non sono stati superati: l’articolo va in revisione umana.',
      });
    }
  }

  if (!draft || !usedResult) {
    throw new Error('La stesura non ha prodotto un articolo utilizzabile.');
  }

  const slug = normalizeSlug(draft.slug || draft.title);

  const [version] = await db
    .insert(articleVersions)
    .values({
      articleId,
      versionNumber: nextVersionNumber,
      contentMarkdown: draft.contentMarkdown,
      title: draft.title,
      metaDescription: draft.metaDescription,
      createdVia: payload.fullRegeneration ? 'ai_rewrite' : 'ai_generation',
      llmProvider: usedResult.provider,
      llmModel: usedResult.model,
      inputTokens: usedResult.inputTokens,
      outputTokens: usedResult.outputTokens,
      costMicroUsd: usedResult.costMicroUsd,
    })
    .returning({ id: articleVersions.id });

  const quality = computeQualityScore({
    markdown: draft.contentMarkdown,
    targetKeyword: keyword,
    briefSectionCount: countBriefSections(row.brief),
  });

  // Seconda porta umana dell'UPGRADE #1: si ferma o prosegue in base alla
  // configurazione del prodotto.
  const nextStatus = stateAfterGeneration(row.autoApproveDraft);

  await db
    .update(articles)
    .set({
      status: nextStatus,
      title: draft.title,
      slug,
      metaDescription: draft.metaDescription.slice(0, 160),
      excerpt: draft.excerpt,
      currentVersionId: version.id,
      wordCount: countWords(draft.contentMarkdown),
      qualityScore: quality,
      ...(row.autoApproveDraft
        ? { draftApprovedAt: new Date(), approvedByTimeout: false }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(articles.id, articleId));

  await recordUsage({
    organizationId: job.organizationId,
    productId: row.productId,
    field: 'articlesGenerated',
    llmCostMicroUsd: usedResult.costMicroUsd,
  });

  await recorder.event({
    step: 'generate.done',
    message:
      nextStatus === 'draft_ready'
        ? 'Bozza pronta: in attesa di approvazione.'
        : 'Bozza approvata automaticamente: pubblicazione in coda.',
    details: {
      versionNumber: nextVersionNumber,
      wordCount: countWords(draft.contentMarkdown),
      provider: usedResult.provider,
      costMicroUsd: usedResult.costMicroUsd,
    },
  });

  logger.info(
    { articleId, nextStatus, versionNumber: nextVersionNumber },
    'stesura completata',
  );

  if (nextStatus === 'approved') {
    await ctx.enqueue({
      type: 'article_publish',
      organizationId: job.organizationId,
      productId: row.productId,
      targetId: articleId,
      payload: { versionId: version.id, autoApproved: true },
      discriminator: version.id,
    });
  }
}

/** Numero di sezioni previste dal brief: serve al punteggio sui link interni. */
function countBriefSections(brief: unknown): number {
  if (brief && typeof brief === 'object') {
    const sections = (brief as Record<string, unknown>).sections;
    if (Array.isArray(sections)) return sections.length;
  }
  return 0;
}

/**
 * Normalizza uno slug.
 * `NFD` + rimozione dei diacritici trasforma "però" in "pero" invece di
 * scartare la lettera: essenziale per l'italiano.
 */
function normalizeSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
