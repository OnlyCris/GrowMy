import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import {
  approveBriefAction,
  approveDraftAction,
  rejectBriefAction,
  rejectDraftAction,
  rewriteSectionAction,
  saveBriefAction,
} from '@/actions/review.actions';
import { requireOrgMembership } from '@/lib/auth/guards';
import {
  getPreviousVersionsMarkdown,
  getReviewQueue,
} from '@/lib/queries/review';

import { ReviewQueue } from './_components/review-queue';
import ReviewLoading from './loading';

/**
 * PAGINA CODA DI REVISIONE — UPGRADE #1
 *
 * Server Component. Il fetching avviene interamente sul server: nessuna chiave,
 * nessuna query e nessun campo non proiettato raggiunge il browser.
 *
 * Le Server Actions sono importate e passate come prop al client component.
 * Ognuna incapsula già verifica sessione, RBAC, validazione Zod e rate limit
 * tramite il wrapper `_safe-action.ts` — la loro implementazione è il primo
 * blocco della Fase 4.
 *
 * NOTA SU `noStore`: la coda cambia mentre i worker avanzano. Renderla statica
 * mostrerebbe articoli già approvati da un collega. Il costo di un render
 * dinamico qui è largamente ripagato dalla correttezza.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // Solo il nome della sezione: il layout radice applica il template
  // `%s · GrowMy`. Ripetere il suffisso qui produce "Revisione · GrowMy · GrowMy".
  title: 'Revisione',
  description:
    'Approva brief e bozze prima che vengano scritti e pubblicati sul tuo sito.',
  // La pagina è dietro autenticazione: nessun motore di ricerca deve indicizzarla.
  robots: { index: false, follow: false },
};

interface ReviewPageProps {
  params: Promise<{ orgSlug: string }>;
}

async function ReviewQueueLoader({ orgSlug }: { orgSlug: string }) {
  /**
   * `requireOrgMembership` verifica la sessione lato server con
   * `supabase.auth.getUser()` (mai `getSession()`, che si fida di un cookie non
   * verificato) e risolve il ruolo dal database.
   *
   * Se l'utente non appartiene all'organizzazione ritorniamo 404 e non 403:
   * un 403 confermerebbe l'esistenza di quello slug a un estraneo.
   */
  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  // I `viewer` non possono approvare nulla: la coda non ha senso per loro.
  if (membership.role === 'viewer') notFound();

  /**
   * `requireOrgMembership` (sopra) ha già aperto e chiuso il proprio
   * `withUserContext` per risolvere la membership. Queste due query sono un
   * secondo, distinto accesso ai dati per conto dello stesso utente: senza un
   * proprio contesto, girerebbero sulla connessione `rawDb` di base, dove
   * `app.current_user_id` non è mai impostata — RLS le farebbe fallire chiuse
   * (coda sempre vuota), non con un errore che lo spieghi.
   */
  const { items, previousVersions } = await withUserContext(
    membership.userId,
    async () => {
      const items = await getReviewQueue(membership.organizationId);

      // Il diff richiede il markdown precedente. Lo carichiamo solo per le
      // bozze effettivamente in coda, non per l'intero storico.
      const previousVersions = await getPreviousVersionsMarkdown(
        items
          .filter((item) => item.draft?.previousVersionId)
          .map((item) => ({
            articleId: item.articleId,
            versionId: item.draft!.previousVersionId!,
          })),
      );

      return { items, previousVersions };
    },
  );

  return (
    <ReviewQueue
      items={items}
      previousVersions={previousVersions}
      saveBriefAction={saveBriefAction}
      approveBriefAction={approveBriefAction}
      rejectBriefAction={rejectBriefAction}
      approveDraftAction={approveDraftAction}
      rejectDraftAction={rejectDraftAction}
      rewriteSectionAction={rewriteSectionAction}
    />
  );
}

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { orgSlug } = await params;

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Revisione
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground-muted">
          Correggi l’angolo editoriale prima della stesura e la bozza prima della
          pubblicazione. Quello che non revisioni prosegue da solo.
        </p>
      </header>

      {/* Suspense a livello di sezione: l'intestazione appare immediatamente,
          solo la coda attende i dati. */}
      <Suspense fallback={<ReviewLoading />}>
        <ReviewQueueLoader orgSlug={orgSlug} />
      </Suspense>
    </main>
  );
}
