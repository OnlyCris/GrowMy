import 'server-only';

import { randomBytes } from 'node:crypto';

import { connectWebhookIntegrationSchema } from '@growmy/validation';

import { enqueueJob, mapDatabaseError } from '@/lib/jobs';
import { getIntegrationForProduct } from '@/lib/queries/integrations';
import { getProductOrganizationId } from '@/lib/queries/products';

import { ActionError, createSafeAction } from './_safe-action';

/**
 * `server-only`, non `'use server'` — stesso confine sottile di
 * `products.impl.ts`.
 *
 * `CREDENTIALS_ENCRYPTION_KEY` vive solo nel processo worker: questa azione
 * NON scrive `integrations` direttamente, non può — accoda un job
 * (`integration_connect`) che il worker processa, cifrando le credenziali
 * con la chiave che solo lui possiede. Vedi
 * `apps/worker/src/processors/integration-connect.processor.ts` e la nota
 * sul compromesso di sicurezza nel piano di questa fetta.
 */

export const connectWebhookIntegration = createSafeAction(
  {
    name: 'integrations.connect-webhook',
    schema: connectWebhookIntegrationSchema,
    rateLimit: 'integration.connect',
    // Collegare un canale di pubblicazione è più sensibile della gestione
    // ordinaria dei contenuti: owner/admin, non editor.
    minimumRole: 'admin',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership, traceId }) => {
    // L'INSERT vero avviene nel worker (asincrono): un controllo qui non è
    // atomico contro l'indice parziale `integrations_product_primary_uq`,
    // ma evita all'utente l'esperienza confusa di un job che fallisce in
    // silenzio qualche secondo dopo per un vincolo che avremmo potuto
    // controllare subito.
    const existing = await getIntegrationForProduct(input.productId);
    if (existing) {
      throw new ActionError(
        'CONFLICT',
        'Questo prodotto ha già un’integrazione collegata. Rimuovila prima di collegarne un’altra.',
      );
    }

    // Generato lato server: non è l'utente a doversi inventare un segreto
    // (e a farlo male). Va copiato su menuisland.it per verificare la firma.
    const signingSecret = randomBytes(32).toString('hex');

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: input.productId,
        type: 'integration_connect',
        targetType: 'product',
        targetId: input.productId,
        payload: {
          provider: 'webhook',
          targetUrl: input.targetUrl,
          signingSecret,
          label: input.label ?? null,
          connectedBy: membership.userId,
        },
        discriminator: `connect-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    // Restituito UNA sola volta: la riga `integrations`, quando esisterà,
    // non espone più questo valore (colonne cifrate escluse dal SELECT in
    // `lib/queries/integrations.ts`).
    return { signingSecret };
  },
);
