import 'server-only';

import { cannibalizationIssues, db, gscConnections, keywords } from '@growmy/db';
import {
  confirmGscPropertySchema,
  disconnectGscSchema,
  promoteOpportunitySchema,
  resolveCannibalizationSchema,
  runPlannerNowSchema,
  syncGscNowSchema,
} from '@growmy/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import {
  deletePendingGscConnection,
  readPendingGscConnection,
} from '@/lib/gsc-oauth';
import { enqueueJob, mapDatabaseError } from '@/lib/jobs';
import {
  getCannibalizationOrganizationId,
  getGscConnection,
} from '@/lib/queries/analytics';
import { getProductOrganizationId } from '@/lib/queries/products';

import { ActionError, createSafeAction } from './_safe-action';

/**
 * AZIONI SU SEARCH CONSOLE E SUL PLANNER.
 *
 * `server-only`, non `'use server'`: stesso confine di `integrations.impl.ts`.
 * Le funzioni esportate qui sono richiamate dai wrapper in
 * `analytics.actions.ts`, che è il file marcato come Server Action.
 *
 * Come per le integrazioni CMS, nessuna di queste azioni scrive un segreto: la
 * chiave di cifratura vive solo nel worker, quindi la connessione vera viene
 * scritta da un job. Qui si accoda e si restituisce il controllo all'utente.
 */

// ---------------------------------------------------------------------------
// Connessione
// ---------------------------------------------------------------------------

/**
 * Conferma la property scelta e avvia la connessione.
 *
 * Il refresh token NON arriva dall'input: viene riletto dalla custodia Redis
 * scritta dal callback OAuth, legata all'utente autenticato. Un client che
 * inventasse un `connectionToken` non troverebbe nulla, e uno che ne
 * intercettasse uno altrui verrebbe respinto dal controllo su `userId` dentro
 * `readPendingGscConnection`.
 */
export const confirmGscProperty = createSafeAction(
  {
    name: 'analytics.confirm-gsc-property',
    schema: confirmGscPropertySchema,
    rateLimit: 'gsc.connect',
    minimumRole: 'admin',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
    audit: {
      targetType: 'product',
      getTargetId: (input) => input.productId,
    },
  },
  async ({ input, membership, traceId }) => {
    const pending = await readPendingGscConnection(
      input.connectionToken,
      membership.userId,
    );

    if (!pending || pending.productId !== input.productId) {
      throw new ActionError(
        'NOT_FOUND',
        'La sessione di collegamento è scaduta. Riavvia il collegamento a Search Console.',
      );
    }

    // La property deve essere una di quelle che Google ha davvero elencato per
    // questo account: senza il controllo, un client potrebbe far salvare una
    // property arbitraria, che poi fallirebbe a ogni sincronizzazione.
    if (!pending.sites.some((site) => site.siteUrl === input.siteUrl)) {
      throw new ActionError(
        'VALIDATION_FAILED',
        'La property selezionata non è fra quelle disponibili per questo account Google.',
      );
    }

    const existing = await getGscConnection(membership.organizationId, input.productId);
    if (existing) {
      throw new ActionError(
        'CONFLICT',
        'Questo prodotto ha già una property collegata. Scollegala prima di collegarne un’altra.',
      );
    }

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: input.productId,
        /**
         * Non esiste un tipo di job `gsc_connect`, ed è deliberato: aggiungere
         * un valore a un enum Postgres è additivo ma richiede comunque una
         * migrazione, e qui non serve. La connessione È la prima
         * sincronizzazione — il worker riconosce `mode: 'connect'` nel payload,
         * cifra il token, scrive la riga e prosegue subito con l'import.
         */
        type: 'gsc_sync',
        targetType: 'product',
        targetId: input.productId,
        payload: {
          mode: 'connect',
          siteUrl: input.siteUrl,
          refreshToken: pending.refreshToken,
          connectedEmail: pending.connectedEmail,
          connectedBy: membership.userId,
        },
        discriminator: `connect-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    // Consuma il token: il refresh token esce dalla memoria condivisa appena
    // il worker ne ha una copia nel payload del job.
    await deletePendingGscConnection(input.connectionToken);

    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/analytics`);

    return { siteUrl: input.siteUrl };
  },
);

/**
 * Scollega la property.
 *
 * Disattiva la riga invece di cancellarla: `gsc_daily_metrics` ha una FK sul
 * prodotto e non sulla connessione, quindi lo storico sopravvive comunque, ma
 * conservare la riga tiene traccia di chi aveva collegato cosa e quando —
 * informazione che serve quando qualcuno chiede perché i dati si sono fermati.
 *
 * L'indice parziale `gsc_connections_product_uq` è definito su `is_active =
 * true`: portarlo a `false` libera lo slot per una nuova connessione senza che
 * il vincolo si opponga.
 */
export const disconnectGsc = createSafeAction(
  {
    name: 'analytics.disconnect-gsc',
    schema: disconnectGscSchema,
    rateLimit: 'gsc.connect',
    minimumRole: 'admin',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
    audit: {
      targetType: 'product',
      getTargetId: (input) => input.productId,
    },
  },
  async ({ input, membership }) => {
    const updated = await db
      .update(gscConnections)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(gscConnections.productId, input.productId),
          eq(gscConnections.organizationId, membership.organizationId),
          eq(gscConnections.isActive, true),
        ),
      )
      .returning({ id: gscConnections.id });

    if (updated.length === 0) {
      throw new ActionError('NOT_FOUND', 'Nessuna property collegata da scollegare.');
    }

    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/analytics`);

    return { disconnected: true };
  },
);

// ---------------------------------------------------------------------------
// Sincronizzazione e planner
// ---------------------------------------------------------------------------

/** Sincronizzazione immediata, senza attendere il cron notturno. */
export const syncGscNow = createSafeAction(
  {
    name: 'analytics.sync-gsc-now',
    schema: syncGscNowSchema,
    rateLimit: 'gsc.sync',
    minimumRole: 'admin',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership, traceId }) => {
    const connection = await getGscConnection(
      membership.organizationId,
      input.productId,
    );

    if (!connection) {
      throw new ActionError(
        'NOT_FOUND',
        'Nessuna property collegata: collega Search Console prima di sincronizzare.',
      );
    }

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: input.productId,
        type: 'gsc_sync',
        targetType: 'product',
        targetId: input.productId,
        payload: { mode: 'sync' },
        // Timestamp al minuto: due clic ravvicinati collassano sullo stesso
        // job (l'idempotenza di `app_enqueue_job` restituisce l'id esistente)
        // invece di accodare due import identici che si contendono la quota.
        discriminator: `manual-${Math.floor(Date.now() / 60_000)}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    return { queued: true };
  },
);

/** Ricalcolo immediato delle priorità editoriali sui dati già importati. */
export const runPlannerNow = createSafeAction(
  {
    name: 'analytics.run-planner-now',
    schema: runPlannerNowSchema,
    rateLimit: 'planner.run',
    minimumRole: 'admin',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership, traceId }) => {
    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: input.productId,
        type: 'planner_recalculate',
        targetType: 'product',
        targetId: input.productId,
        payload: { mode: 'manual' },
        discriminator: `manual-${Math.floor(Date.now() / 60_000)}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    return { queued: true };
  },
);

// ---------------------------------------------------------------------------
// Esiti sulle raccomandazioni
// ---------------------------------------------------------------------------

/**
 * Registra come l'utente ha gestito una cannibalizzazione.
 *
 * Non esegue l'azione (non uniamo articoli né scriviamo canonical al posto
 * dell'utente): registra la decisione e toglie la riga dalla lista aperta.
 * Un merge automatico di due articoli pubblicati è irreversibile e va deciso
 * da chi conosce il sito — la stessa ragione per cui brief e bozze passano da
 * un cancello umano.
 */
export const resolveCannibalization = createSafeAction(
  {
    name: 'analytics.resolve-cannibalization',
    schema: resolveCannibalizationSchema,
    rateLimit: 'planner.resolve',
    minimumRole: 'editor',
    resolveTenant: (input) => getCannibalizationOrganizationId(input.issueId),
  },
  async ({ input, membership }) => {
    const updated = await db
      .update(cannibalizationIssues)
      .set({
        resolvedAction: input.resolvedAction,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cannibalizationIssues.id, input.issueId),
          isNull(cannibalizationIssues.resolvedAt),
        ),
      )
      .returning({ id: cannibalizationIssues.id, productId: cannibalizationIssues.productId });

    if (updated.length === 0) {
      throw new ActionError(
        'NOT_FOUND',
        'Segnalazione non trovata o già gestita.',
      );
    }

    revalidatePath(
      `/${membership.organizationSlug}/products/${updated[0].productId}/analytics`,
    );

    return { resolved: true };
  },
);

/**
 * Promuove un'opportunità in striking distance a keyword lavorabile.
 *
 * Entra come `suggested`, non `approved`: la stessa porta di revisione umana
 * già applicata alle keyword proposte dall'AI. Un dato reale di Search Console
 * è un'indicazione più solida di una proposta generata, ma la decisione di
 * spendere un credito resta dell'utente.
 *
 * `source: 'gsc_striking_distance'` non è decorativo — è ciò che permette di
 * rispondere, mesi dopo, alla domanda «da dove è uscita questa keyword?».
 */
export const promoteOpportunity = createSafeAction(
  {
    name: 'analytics.promote-opportunity',
    schema: promoteOpportunitySchema,
    rateLimit: 'keywords.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership }) => {
    const term = input.term.trim().toLowerCase();

    const rationale =
      `Da Search Console: la query è in posizione media ${input.position.toFixed(1)} ` +
      `con ${input.impressions.toLocaleString('it-IT')} impression nel periodo. ` +
      `È già considerata pertinente da Google — mancano posizioni, non un argomento nuovo.`;

    const inserted = await db
      .insert(keywords)
      .values({
        organizationId: membership.organizationId,
        productId: input.productId,
        term,
        status: 'suggested',
        source: 'gsc_striking_distance',
        searchVolume: input.impressions,
        priorityRationale: rationale,
      })
      // `keywords_product_term_uq` respingerebbe comunque un duplicato: qui lo
      // trasformiamo in un messaggio chiaro invece che in un errore di vincolo.
      .onConflictDoNothing()
      .returning({ id: keywords.id });

    if (inserted.length === 0) {
      throw new ActionError(
        'CONFLICT',
        'Questa keyword è già presente fra quelle del prodotto.',
      );
    }

    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/keywords`);
    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/analytics`);

    return { keywordId: inserted[0].id, term };
  },
);
