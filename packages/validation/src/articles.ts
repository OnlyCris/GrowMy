import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — articoli scritti a mano.
 * Stessa disciplina di `products.ts`/`keywords.ts`: `.strict()`, limiti su
 * ogni stringa.
 */

const uuid = z.string().uuid('Identificatore non valido.');

export const createManualArticleSchema = z
  .object({
    productId: uuid,
    /**
     * Parola chiave di riferimento: usata SOLO per il calcolo del quality
     * score (densità keyword), mai creata come riga `keywords` — un articolo
     * scritto a mano non nasce da un ciclo di ricerca keyword, sarebbe un
     * dato inventato per far tornare i conti dello schema.
     */
    targetKeyword: z.string().trim().max(120).optional().default(''),
    title: z.string().trim().min(1, 'Dai un titolo all’articolo.').max(200),
    metaDescription: z
      .string()
      .trim()
      .min(1, 'La meta description non può essere vuota.')
      .max(160),
    excerpt: z.string().trim().max(300).optional(),
    contentMarkdown: z
      .string()
      .trim()
      .min(1, 'Il contenuto non può essere vuoto.')
      .max(50_000),
  })
  .strict();

export const deleteArticleSchema = z
  .object({
    articleId: uuid,
  })
  .strict();

export type CreateManualArticleInput = z.infer<typeof createManualArticleSchema>;
export type DeleteArticleInput = z.infer<typeof deleteArticleSchema>;
