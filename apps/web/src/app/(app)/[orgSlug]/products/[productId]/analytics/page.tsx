import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireOrgMembership } from '@/lib/auth/guards';
import { readPendingGscConnection } from '@/lib/gsc-oauth';
import {
  ANALYTICS_WINDOW_DAYS,
  getAnalyticsSummary,
  getGscConnection,
  getOpenCannibalizationIssues,
  getPlannerDecisions,
  getStrikingDistanceOpportunities,
  getTopPages,
  getTopQueries,
} from '@/lib/queries/analytics';

import { CannibalizationPanel } from './_components/cannibalization-panel';
import { DecisionLog } from './_components/decision-log';
import { GscConnectionPanel } from './_components/gsc-connection-panel';
import { MetricsOverview } from './_components/metrics-overview';
import { StrikingDistancePanel } from './_components/striking-distance-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Analitiche',
  robots: { index: false, follow: false },
};

/**
 * PAGINA ANALITICHE — il lato visibile del closed-loop planner (UPGRADE #2).
 *
 * Non è un cruscotto. Un cruscotto mostra numeri e lascia all'utente il compito
 * di dedurne qualcosa; qui ogni sezione termina in un'azione: promuovere
 * un'opportunità a keyword, chiudere un conflitto, far ripartire il planner. I
 * numeri servono a motivare quelle azioni, non a riempire la pagina.
 *
 * Le query girano tutte dentro un solo `withUserContext`: le policy RLS leggono
 * `app.current_user_id`, e fuori da quel contesto ogni SELECT tornerebbe vuota.
 * In parallelo perché sono indipendenti fra loro — la più lenta domina, invece
 * di sommarsi alle altre.
 */
export default async function ProductAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; productId: string }>;
  searchParams: Promise<{ gsc_connect?: string; gsc_error?: string }>;
}) {
  const { orgSlug, productId } = await params;
  const { gsc_connect: connectToken, gsc_error: errorCode } = await searchParams;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const connection = await withUserContext(membership.userId, () =>
    getGscConnection(membership.organizationId, productId),
  );

  /**
   * Connessione a metà strada: il consenso Google è arrivato ma la property non
   * è ancora scelta. La custodia sta su Redis (vedi `lib/gsc-oauth.ts`) ed è
   * legata all'utente autenticato, quindi un token trapelato non basta a
   * nessun altro per completare il collegamento.
   */
  const pending = connectToken
    ? await readPendingGscConnection(connectToken, membership.userId)
    : null;

  /**
   * Senza connessione non c'è nulla da mostrare, e mostrare quattro riquadri a
   * zero sarebbe peggio di non mostrarli: sembrerebbe un sito senza traffico
   * invece di una fonte dati non ancora collegata.
   */
  if (!connection) {
    return (
      <GscConnectionPanel
        productId={productId}
        orgSlug={orgSlug}
        connection={null}
        pendingToken={connectToken ?? null}
        pendingSites={pending?.sites}
        pendingEmail={pending?.connectedEmail}
        errorCode={errorCode ?? null}
      />
    );
  }

  const [summary, opportunities, cannibalization, decisions, topQueries, topPages] =
    await withUserContext(membership.userId, () =>
      Promise.all([
        getAnalyticsSummary(productId),
        getStrikingDistanceOpportunities(productId),
        getOpenCannibalizationIssues(productId),
        getPlannerDecisions(productId),
        getTopQueries(productId),
        getTopPages(productId),
      ]),
    );

  const hasData = summary.daysWithData > 0;

  return (
    <div className="flex flex-col gap-8">
      <GscConnectionPanel
        productId={productId}
        orgSlug={orgSlug}
        connection={connection}
        errorCode={errorCode ?? null}
      />

      {!hasData ? (
        <p className="text-sm text-foreground-muted">
          Nessun dato ancora disponibile per gli ultimi {ANALYTICS_WINDOW_DAYS} giorni.
          Search Console pubblica le metriche con due o tre giorni di ritardo, e il
          primo import può richiedere qualche minuto.
        </p>
      ) : (
        <>
          <MetricsOverview
            current={summary.current}
            previous={summary.previous}
            windowDays={ANALYTICS_WINDOW_DAYS}
          />

          <StrikingDistancePanel
            productId={productId}
            opportunities={opportunities.map((o) => ({
              query: o.query,
              page: o.page,
              clicks: o.clicks,
              impressions: o.impressions,
              position: o.position,
              estimatedClickGain: o.estimatedClickGain,
              rationale: o.rationale,
            }))}
          />

          <CannibalizationPanel
            issues={cannibalization.map((issue) => ({
              id: issue.id,
              query: issue.query,
              competingPages: issue.competingPages.map((page) => ({
                page: page.page,
                clicks: page.clicks,
                impressions: page.impressions,
                position: page.position,
              })),
              severity: issue.severity,
              recommendedAction: issue.recommendedAction,
            }))}
          />

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">Ricerche principali</h2>
              <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
                {topQueries.map((row) => (
                  <li
                    key={row.query}
                    className="flex items-baseline justify-between gap-3 px-4 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {row.query}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-foreground-muted">
                      {row.clicks.toLocaleString('it-IT')} clic · pos.{' '}
                      {row.position.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">Pagine principali</h2>
              <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
                {topPages.map((row) => (
                  <li
                    key={row.page}
                    className="flex items-baseline justify-between gap-3 px-4 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {row.articleTitle ?? row.page}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-foreground-muted">
                      {row.clicks.toLocaleString('it-IT')} clic · pos.{' '}
                      {row.position.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <DecisionLog decisions={decisions} />
        </>
      )}
    </div>
  );
}
