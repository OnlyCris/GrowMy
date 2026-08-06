import 'server-only';

import { articles, db } from '@growmy/db';
import {
  assertTransition,
  type ArticleStatus,
} from '@growmy/core/articles/state-machine';
import {
  approveBriefInput,
  approveDraftInput,
  rejectBriefInput,
  rejectDraftInput,
  rewriteSectionInput,
  saveBriefInput,
} from '@growmy/validation/review';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { ActionError, createSafeAction } from '@/actions/_safe-action';
import { enqueueJob, mapDatabaseError } from '@/lib/jobs';
import {
  getArticleOrganizationId,
  getArticleState,
} from '@/lib/queries/review';
import { logger } from '@/lib/logger';

/**
 * SERVER ACTIONS DELLA CODA DI REVISIONE — UPGRADE #1
 *
 * Ogni azione è avvolta da `createSafeAction`, che applica sessione, rate limit,
 * validazione Zod `.strict()` e RBAC prima ancora di entrare nell'handler.
 * Qui dentro resta solo la logica di dominio.
 *
 * Due invarianti valgono per tutte:
 *
 *  1. TRANSIZIONE VALIDATA NELLA STESSA TRANSAZIONE DELL'UPDATE, con un WHERE
 *     che include lo stato atteso. È un compare-and-swap: se un collega o il
 *     cron di auto-approvazione hanno agito nel frattempo, l'update tocca zero
 *     righe e l'azione fallisce in modo pulito invece di sovrascrivere.
 *
 *  2. L'ACCODAMENTO DEI JOB PASSA DA `app_enqueue_job()`. L'applicazione non ha
 *     policy di INSERT su `jobs` né su `credit_ledger`: la funzione SECURITY
 *     DEFINER verifica il ruolo, blocca la riga organizzazione, controlla il
 *     saldo, riserva il credito e accoda — tutto atomicamente.
 */

/** Tenant resolver condiviso: risale dall'articolo all'organizzazione. */
const resolveArticleTenant = (input: { articleId: string }) =>
  getArticleOrganizationId(input.articleId);

/**
 * Compare-and-swap sullo stato dell'articolo.
 *
 * Il `WHERE status = expectedFrom` è ciò che rende l'operazione sicura sotto
 * concorrenza. Senza di esso due approvazioni simultanee produrrebbero due
 * accodamenti di pubblicazione per lo stesso articolo.
 */
async function transitionArticle(params: {
  articleId: string;
  organizationId: string;
  from: ArticleStatus;
  to: ArticleStatus;
  patch?: Record<string, unknown>;
}): Promise<void> {
  assertTransition(params.from, params.to);

  const updated = await db
    .update(articles)
    .set({ status: params.to, updatedAt: new Date(), ...params.patch })
    .where(
      and(
        eq(articles.id, params.articleId),
        eq(articles.organizationId, params.organizationId),
        // Il compare: se lo stato è cambiato, nessuna riga viene toccata.
        eq(articles.status, params.from),
      ),
    )
    .returning({ id: articles.id });

  if (updated.length === 0) {
    throw new ActionError(
      'CONFLICT',
      'Questo articolo è già stato gestito da qualcun altro. Ricarica la pagina.',
    );
  }
}

// ---------------------------------------------------------------------------
// BRIEF
// ---------------------------------------------------------------------------

/**
 * Salva il brief senza approvarlo. L'articolo resta in `brief_ready`.
 * Serve a chi vuole rivedere l'outline in due sessioni.
 */
export const saveBrief = createSafeAction(
  {
    name: 'review.save_brief',
    schema: saveBriefInput,
    rateLimit: 'review.save',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
  },
  async ({ input, membership }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    if (state.status !== 'brief_ready') {
      throw new ActionError(
        'INVALID_STATE_TRANSITION',
        'Il brief non è più modificabile: la stesura è già iniziata.',
      );
    }

    await db
      .update(articles)
      .set({ brief: input.brief, updatedAt: new Date() })
      .where(
        and(
          eq(articles.id, input.articleId),
          eq(articles.organizationId, membership.organizationId),
          eq(articles.status, 'brief_ready'),
        ),
      );

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);

/**
 * Approva il brief: salva l'outline eventualmente modificato e sblocca la
 * stesura. Il credito è già stato riservato all'accodamento della ricerca,
 * quindi qui `reserveCredit` è false.
 */
export const approveBrief = createSafeAction(
  {
    name: 'review.approve_brief',
    schema: approveBriefInput,
    rateLimit: 'review.approve',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
    audit: { targetType: 'article', getTargetId: (input) => input.articleId },
  },
  async ({ input, membership, traceId }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    await transitionArticle({
      articleId: input.articleId,
      organizationId: membership.organizationId,
      from: 'brief_ready',
      to: 'generating',
      patch: {
        brief: input.brief,
        briefApprovedAt: new Date(),
        briefApprovedBy: membership.userId,
        approvedByTimeout: false,
      },
    });

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: state.productId,
        type: 'article_generate',
        targetType: 'article',
        targetId: input.articleId,
        payload: { approvedBy: membership.userId },
        // Il timestamp di approvazione rende la chiave stabile per questo
        // tentativo: un doppio click accoda una volta sola.
        discriminator: `brief-approved-${state.currentVersionId ?? 'v0'}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);

/**
 * Rifiuta il brief con feedback: si torna a `researching` e l'AI rigenera
 * l'outline tenendo conto di cosa non andava.
 *
 * Nessun credito viene riservato: rigenerare un outline costa una frazione di
 * un articolo, e far pagare la correzione scoraggerebbe proprio il comportamento
 * che questo upgrade vuole incentivare.
 */
export const rejectBrief = createSafeAction(
  {
    name: 'review.reject_brief',
    schema: rejectBriefInput,
    rateLimit: 'review.reject',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
    audit: { targetType: 'article', getTargetId: (input) => input.articleId },
  },
  async ({ input, membership, traceId }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    await transitionArticle({
      articleId: input.articleId,
      organizationId: membership.organizationId,
      from: 'brief_ready',
      to: 'researching',
    });

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: state.productId,
        type: 'article_research',
        targetType: 'article',
        targetId: input.articleId,
        payload: { humanFeedback: input.feedback, rejectedBy: membership.userId },
        discriminator: `brief-rejected-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);

// ---------------------------------------------------------------------------
// BOZZA
// ---------------------------------------------------------------------------

/**
 * Approva la bozza: l'articolo entra in coda di pubblicazione.
 *
 * Qui `reserveCredit` è false perché la riserva è avvenuta a monte, alla
 * generazione. Il `consume` che la chiude sarà scritto dal worker solo a
 * pubblicazione confermata — e se la pubblicazione fallisce definitivamente,
 * il `release` restituisce il credito. È l'UPGRADE #3 sul lato economico.
 */
export const approveDraft = createSafeAction(
  {
    name: 'review.approve_draft',
    schema: approveDraftInput,
    rateLimit: 'review.approve',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
    audit: { targetType: 'article', getTargetId: (input) => input.articleId },
  },
  async ({ input, membership, traceId }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    if (!state.currentVersionId) {
      throw new ActionError(
        'CONFLICT',
        'Questa bozza non ha ancora un contenuto approvabile.',
      );
    }

    await transitionArticle({
      articleId: input.articleId,
      organizationId: membership.organizationId,
      from: 'draft_ready',
      to: 'approved',
      patch: {
        draftApprovedAt: new Date(),
        draftApprovedBy: membership.userId,
        approvedByTimeout: false,
      },
    });

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: state.productId,
        type: 'article_publish',
        targetType: 'article',
        targetId: input.articleId,
        payload: {
          versionId: state.currentVersionId,
          approvedBy: membership.userId,
        },
        // La versione nella chiave garantisce che riapprovare dopo un rewrite
        // accodi una pubblicazione nuova, e non venga scambiata per un duplicato.
        discriminator: state.currentVersionId,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);

/**
 * Rifiuta la bozza: rigenerazione completa dell'articolo con il feedback.
 *
 * A differenza del rifiuto del brief, qui il credito viene riservato: stiamo
 * chiedendo una stesura completa da capo, che è il costo reale del sistema.
 */
export const rejectDraft = createSafeAction(
  {
    name: 'review.reject_draft',
    schema: rejectDraftInput,
    rateLimit: 'review.reject',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
    audit: { targetType: 'article', getTargetId: (input) => input.articleId },
  },
  async ({ input, membership, traceId }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    await transitionArticle({
      articleId: input.articleId,
      organizationId: membership.organizationId,
      from: 'draft_ready',
      to: 'generating',
    });

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: state.productId,
        type: 'article_generate',
        targetType: 'article',
        targetId: input.articleId,
        payload: {
          humanFeedback: input.feedback,
          rejectedBy: membership.userId,
          fullRegeneration: true,
        },
        discriminator: `draft-rejected-${Date.now()}`,
        reserveCredit: true,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);

/**
 * Rewrite mirato di una singola sezione.
 *
 * È la funzione che evita il ciclo distruttivo "non mi piace un paragrafo ->
 * rigenero tutto -> perdo il resto". Non consuma crediti: riscrivere 300 parole
 * costa una frazione di un articolo, e far pagare la rifinitura spingerebbe
 * l'utente ad accettare contenuti mediocri.
 *
 * L'articolo NON cambia stato: resta in `draft_ready`, così l'utente continua a
 * vederlo in coda mentre la sezione viene riscritta.
 */
export const rewriteSection = createSafeAction(
  {
    name: 'review.rewrite_section',
    schema: rewriteSectionInput,
    rateLimit: 'review.rewrite',
    minimumRole: 'editor',
    resolveTenant: resolveArticleTenant,
  },
  async ({ input, membership, traceId }) => {
    const state = await getArticleState(input.articleId, membership.organizationId);
    if (!state) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');

    if (state.status !== 'draft_ready') {
      throw new ActionError(
        'INVALID_STATE_TRANSITION',
        'La riscrittura è possibile solo su una bozza in revisione.',
      );
    }

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: state.productId,
        type: 'article_generate',
        targetType: 'article',
        targetId: input.articleId,
        payload: {
          mode: 'section_rewrite',
          sectionHeading: input.sectionHeading,
          instruction: input.instruction,
          baseVersionId: state.currentVersionId,
          requestedBy: membership.userId,
        },
        // Il titolo della sezione nella chiave impedisce di accodare due
        // riscritture identiche della stessa sezione con un doppio click.
        discriminator: `rewrite-${input.sectionHeading.slice(0, 40)}-${state.currentVersionId ?? 'v0'}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    logger.info(
      { traceId, articleId: input.articleId, section: input.sectionHeading },
      'riscrittura di sezione accodata',
    );

    revalidatePath(`/${membership.organizationSlug}/review`);
    return { articleId: input.articleId };
  },
);
