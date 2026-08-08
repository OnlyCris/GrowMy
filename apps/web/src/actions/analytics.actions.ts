'use server';

import type {
  ConfirmGscPropertyInput,
  DisconnectGscInput,
  PromoteOpportunityInput,
  ResolveCannibalizationInput,
  RunPlannerNowInput,
  SyncGscNowInput,
} from '@growmy/validation';

import * as analytics from './analytics.impl';

export async function confirmGscPropertyAction(input: ConfirmGscPropertyInput) {
  return analytics.confirmGscProperty(input);
}

export async function disconnectGscAction(input: DisconnectGscInput) {
  return analytics.disconnectGsc(input);
}

export async function syncGscNowAction(input: SyncGscNowInput) {
  return analytics.syncGscNow(input);
}

export async function runPlannerNowAction(input: RunPlannerNowInput) {
  return analytics.runPlannerNow(input);
}

export async function resolveCannibalizationAction(
  input: ResolveCannibalizationInput,
) {
  return analytics.resolveCannibalization(input);
}

export async function promoteOpportunityAction(input: PromoteOpportunityInput) {
  return analytics.promoteOpportunity(input);
}
