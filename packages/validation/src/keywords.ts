import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — keyword e generazione articoli.
 * Stessa disciplina di `products.ts`/`review.ts`: `.strict()`, limiti su
 * ogni stringa.
 */

const uuid = z.string().uuid('Identificatore non valido.');

/** Stesso limite già usato per le keyword in `review.ts` (LIMITS.keyword). */
const KEYWORD_MAX_LENGTH = 120;

export const createKeywordSchema = z
  .object({
    productId: uuid,
    term: z
      .string()
      .trim()
      .min(1, 'Inserisci una keyword.')
      .max(KEYWORD_MAX_LENGTH),
  })
  .strict();

export const generateArticleSchema = z
  .object({
    keywordId: uuid,
  })
  .strict();

export type CreateKeywordInput = z.infer<typeof createKeywordSchema>;
export type GenerateArticleInput = z.infer<typeof generateArticleSchema>;
