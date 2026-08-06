'use server';

import type { ConnectWebhookIntegrationInput } from '@growmy/validation';

import * as integrations from './integrations.impl';

export async function connectWebhookIntegrationAction(input: ConnectWebhookIntegrationInput) {
  return integrations.connectWebhookIntegration(input);
}
