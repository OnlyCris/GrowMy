import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — prodotti (i siti gestiti dalla pipeline).
 *
 * Stessa disciplina di `review.ts`: `.strict()`, limite superiore su ogni
 * stringa, messaggi in italiano. I vincoli numerici replicano i CHECK
 * constraint applicati al database in `0002_deferred_constraints.sql`
 * (`publish_hour BETWEEN 0 AND 23`, `target_word_count_max >=
 * target_word_count_min`, ...): Zod valida prima e produce un messaggio
 * leggibile, i CHECK restano la rete di sicurezza per ogni altro percorso
 * di scrittura (worker, script di manutenzione).
 */

const uuid = z.string().uuid('Identificatore non valido.');

const LIMITS = {
  name: 200,
  domain: 253, // limite RFC di un nome a dominio completo
  websiteUrl: 2_048,
  contentLanguage: 10,
  timezone: 64,
  wordCount: 20_000,
  approvalTimeoutHours: 8_760, // un anno: oltre non ha senso, è un timeout
} as const;

/**
 * Dominio normalizzato senza schema né `www.` — stesso vincolo già
 * documentato sulla colonna `products.domain` (`packages/db/src/schema/
 * products.ts`): l'URL completo vive separatamente in `websiteUrl`.
 */
const domainField = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.domain)
  .refine(
    (value) => !/^[a-z]+:\/\//i.test(value),
    'Inserisci solo il dominio, senza "https://" davanti (es. "acme.com").',
  )
  .refine(
    (value) => !value.startsWith('www.'),
    'Inserisci il dominio senza "www." (es. "acme.com", non "www.acme.com").',
  )
  .refine(
    (value) =>
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        value,
      ),
    'Inserisci un dominio valido (es. "acme.com").',
  );

export const createProductSchema = z
  .object({
    organizationId: uuid,
    name: z.string().trim().min(1, 'Dai un nome al prodotto.').max(LIMITS.name),
    domain: domainField,
    websiteUrl: z
      .string()
      .trim()
      .url('Inserisci un URL valido, con "https://" davanti.')
      .max(LIMITS.websiteUrl),
  })
  .strict();

/**
 * Dominio della vetrina blog pubblica (es. "blog.acme.com"), risolto in
 * `middleware.ts` via header Host. Stringa vuota = nessuna vetrina, non un
 * dominio non valido — il DNS/TLS del dominio restano da configurare fuori
 * da GrowMy prima che qualcosa vi risponda davvero.
 */
const blogDomainField = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.domain)
  .refine(
    (value) =>
      value === '' ||
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        value,
      ),
    'Inserisci un dominio valido (es. "blog.acme.com") o lascia vuoto per nessuna vetrina pubblica.',
  )
  .transform((value) => (value === '' ? null : value));

export const updateProductSettingsSchema = z
  .object({
    productId: uuid,
    name: z.string().trim().min(1, 'Dai un nome al prodotto.').max(LIMITS.name),
    blogDomain: blogDomainField,
    contentLanguage: z
      .string()
      .trim()
      .min(2)
      .max(LIMITS.contentLanguage)
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Usa un formato BCP-47 (es. "it-IT", "en-US").'),
    timezone: z.string().trim().min(1).max(LIMITS.timezone),
    publishHour: z
      .number()
      .int('L\'ora deve essere un numero intero.')
      .min(0)
      .max(23, 'L\'ora deve essere fra 0 e 23.'),
    activeWeekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Seleziona almeno un giorno della settimana.')
      .max(7),
    targetWordCountMin: z.number().int().min(100).max(LIMITS.wordCount),
    targetWordCountMax: z.number().int().min(100).max(LIMITS.wordCount),
    autoApproveBrief: z.boolean(),
    autoApproveDraft: z.boolean(),
    /** `null` = attende una decisione umana indefinitamente, nessun timeout. */
    approvalTimeoutHours: z
      .number()
      .int()
      .positive()
      .max(LIMITS.approvalTimeoutHours)
      .nullable(),
  })
  .strict()
  .refine((data) => data.targetWordCountMax >= data.targetWordCountMin, {
    message: 'Il numero massimo di parole non può essere inferiore al minimo.',
    path: ['targetWordCountMax'],
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductSettingsInput = z.infer<typeof updateProductSettingsSchema>;
