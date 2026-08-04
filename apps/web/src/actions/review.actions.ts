'use server';

import type {
  ApproveBriefInput,
  ApproveDraftInput,
  RejectBriefInput,
  RejectDraftInput,
  RewriteSectionInput,
  SaveBriefInput,
} from '@growmy/validation/review';

import * as review from './review.impl';

/**
 * CONFINE SERVER DELLA CODA DI REVISIONE
 *
 * Questo file è deliberatamente sottile: contiene solo le firme esportate verso
 * il client, e nessuna logica.
 *
 * MOTIVO — non è una preferenza stilistica. Un modulo marcato `'use server'` è
 * un confine di sicurezza: il compilatore di Next genera un endpoint HTTP per
 * ogni funzione esportata, e quegli endpoint sono invocabili da chiunque
 * conosca l'identificatore dell'azione. Per questo Next impone che **ogni
 * funzione nel modulo sia async**, incluse le arrow inline dentro un oggetto di
 * configurazione: non può distinguere una callback interna da un'azione
 * esposta, quindi le tratta tutte come esposte.
 *
 * Tenere la logica in `review.impl.ts` (che è `server-only`, quindi non
 * raggiungibile dal client) ha due effetti:
 *  - la superficie invocabile dall'esterno è esattamente questa lista, leggibile
 *    in venti righe invece che in cinquecento;
 *  - helper, resolver di tenant e configurazioni non diventano per sbaglio
 *    endpoint pubblici.
 *
 * Ogni funzione qui delega a `review.impl`, dove `createSafeAction` applica già
 * verifica di sessione, rate limit, validazione Zod `.strict()` e RBAC.
 */

export async function saveBriefAction(input: SaveBriefInput) {
  return review.saveBrief(input);
}

export async function approveBriefAction(input: ApproveBriefInput) {
  return review.approveBrief(input);
}

export async function rejectBriefAction(input: RejectBriefInput) {
  return review.rejectBrief(input);
}

export async function approveDraftAction(input: ApproveDraftInput) {
  return review.approveDraft(input);
}

export async function rejectDraftAction(input: RejectDraftInput) {
  return review.rejectDraft(input);
}

export async function rewriteSectionAction(input: RewriteSectionInput) {
  return review.rewriteSection(input);
}
