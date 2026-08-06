import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — connessione di un'integrazione webhook.
 * Stessa disciplina di `products.ts`: `.strict()`, limiti su ogni stringa.
 */

const uuid = z.string().uuid('Identificatore non valido.');

export const connectWebhookIntegrationSchema = z
  .object({
    productId: uuid,
    targetUrl: z
      .string()
      .trim()
      .url('Inserisci un URL valido.')
      .max(2_048)
      .refine(
        (value) => value.startsWith('https://'),
        'L’endpoint deve usare HTTPS: un payload firmato su un canale non cifrato vanifica la firma.',
      ),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

export type ConnectWebhookIntegrationInput = z.infer<typeof connectWebhookIntegrationSchema>;
