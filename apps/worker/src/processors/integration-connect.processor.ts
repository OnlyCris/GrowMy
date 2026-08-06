import { createCipherFromEnv } from '@growmy/integrations';
import { getWorkerDb, integrations } from '@growmy/db';

import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI CONNESSIONE INTEGRAZIONE.
 *
 * `CREDENTIALS_ENCRYPTION_KEY` vive SOLO in questo processo (mai in `web` —
 * vedi `packages/integrations/src/crypto.ts`), quindi anche la primissima
 * scrittura della riga `integrations` deve passare da qui: la Server Action
 * web non può cifrare nulla, può solo accodare questo job con le credenziali
 * ancora in chiaro (accettato, vedi il piano — finestra di esposizione
 * circoscritta ai colleghi della stessa organizzazione via `jobs_select`,
 * ripulita da `removeOnComplete`/`removeOnFail`).
 *
 * Accoda subito un `integration_health_check` mirato: l'utente vede lo stato
 * passare da "Da verificare" a "Operativa"/"Da riparare" senza aspettare il
 * cron delle 24h.
 */

interface ConnectPayload {
  provider?: string;
  targetUrl?: string;
  signingSecret?: string;
  label?: string | null;
  connectedBy?: string;
}

export async function processIntegrationConnect(ctx: ProcessorContext): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger, job } = ctx;

  if (!job.productId) {
    throw new Error('Job di connessione integrazione senza productId.');
  }

  const payload = (job.payload ?? {}) as ConnectPayload;
  if (payload.provider !== 'webhook' || !payload.targetUrl || !payload.signingSecret) {
    throw new Error('Payload di connessione integrazione incompleto o provider non supportato.');
  }

  const cipher = createCipherFromEnv();
  const encrypted = cipher.encrypt({
    targetUrl: payload.targetUrl,
    signingSecret: payload.signingSecret,
  });

  const [created] = await db
    .insert(integrations)
    .values({
      organizationId: job.organizationId,
      productId: job.productId,
      provider: 'webhook',
      status: 'pending',
      label: payload.label ?? null,
      encryptedCredentials: encrypted.ciphertext,
      credentialsIv: encrypted.iv,
      credentialsKeyVersion: encrypted.keyVersion,
      isPrimary: true,
      connectedBy: payload.connectedBy ?? null,
    })
    .returning({ id: integrations.id });

  await recorder.event({
    step: 'integration.connected',
    message: 'Integrazione salvata: verifica di connettività in corso.',
  });

  logger.info(
    { integrationId: created.id, productId: job.productId },
    'integrazione webhook connessa',
  );

  await ctx.enqueue({
    type: 'integration_health_check',
    organizationId: job.organizationId,
    productId: job.productId,
    targetType: 'integration',
    targetId: created.id,
    payload: {},
    discriminator: `initial-check-${created.id}`,
    reserveCredit: false,
  });
}
