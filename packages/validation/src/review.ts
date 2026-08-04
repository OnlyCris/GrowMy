import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — coda di revisione.
 *
 * Zero trust input: questi schemi sono l'unico punto in cui un payload che
 * arriva dal browser diventa un dato tipizzato. Regole applicate ovunque:
 *
 *  - `.strict()` su ogni oggetto: una proprietà non prevista fa fallire la
 *    validazione invece di essere ignorata silenziosamente. Impedisce il mass
 *    assignment, cioè che un client aggiunga `organizationId` a un payload e
 *    speri che finisca in un update.
 *  - Limiti superiori su OGNI stringa e OGNI array. Un campo senza `.max()` è
 *    un vettore di denial of service: basta inviare 50 MB di testo.
 *  - `.uuid()` sugli identificatori: rifiuta input malformati prima che
 *    raggiungano il database.
 *
 * Gli stessi schemi sono importati dal client per la validazione ottimistica,
 * ma la validazione che conta è quella lato server: quella del client è
 * esclusivamente esperienza utente.
 */

const uuid = z.string().uuid('Identificatore non valido.');

/** Limiti volutamente generosi ma finiti. */
const LIMITS = {
  angle: 600,
  heading: 200,
  bullet: 300,
  bulletsPerSection: 12,
  sections: 30,
  sources: 25,
  secondaryKeywords: 20,
  keyword: 120,
  feedback: 2_000,
  instruction: 1_000,
  url: 2_048,
} as const;

export const briefSectionSchema = z
  .object({
    id: z.string().min(1).max(64),
    heading: z
      .string()
      .trim()
      .min(1, 'Ogni sezione deve avere un titolo.')
      .max(LIMITS.heading),
    bullets: z
      .array(z.string().trim().max(LIMITS.bullet))
      .max(LIMITS.bulletsPerSection),
    intent: z.enum([
      'informational',
      'commercial',
      'transactional',
      'navigational',
    ]),
    estimatedWords: z.number().int().min(50).max(3_000),
  })
  .strict();

export const briefSourceSchema = z
  .object({
    id: z.string().min(1).max(64),
    /**
     * Allowlist di schema. Un `javascript:` o `data:` qui finirebbe in un
     * attributo href a valle: bloccarlo alla validazione è più robusto che
     * sanificarlo al rendering.
     */
    url: z
      .string()
      .url()
      .max(LIMITS.url)
      .refine(
        (value) => /^https?:\/\//i.test(value),
        'Sono ammessi solo URL http o https.',
      ),
    title: z.string().trim().min(1).max(LIMITS.heading),
    reason: z.string().trim().max(LIMITS.bullet),
  })
  .strict();

export const articleBriefSchema = z
  .object({
    angle: z
      .string()
      .trim()
      .min(10, 'L’angolo editoriale è troppo breve per guidare la stesura.')
      .max(LIMITS.angle),
    targetKeyword: z.string().trim().min(1).max(LIMITS.keyword),
    secondaryKeywords: z
      .array(z.string().trim().min(1).max(LIMITS.keyword))
      .max(LIMITS.secondaryKeywords),
    sections: z
      .array(briefSectionSchema)
      .min(1, 'Serve almeno una sezione.')
      .max(LIMITS.sections),
    sources: z.array(briefSourceSchema).max(LIMITS.sources),
    cta: z.string().trim().max(LIMITS.bullet).nullable(),
    internalLinkTargets: z
      .array(
        z
          .object({
            articleId: uuid,
            title: z.string().max(LIMITS.heading),
            slug: z.string().max(LIMITS.heading),
          })
          .strict(),
      )
      .max(LIMITS.sections),
  })
  .strict()
  /**
   * Invariante di dominio: gli id delle sezioni devono essere univoci,
   * altrimenti il riordino lato client corromperebbe la struttura.
   */
  .refine(
    (brief) =>
      new Set(brief.sections.map((s) => s.id)).size === brief.sections.length,
    { message: 'Gli identificatori delle sezioni devono essere univoci.', path: ['sections'] },
  );

// ---------------------------------------------------------------------------
// Input delle Server Actions
// ---------------------------------------------------------------------------

export const saveBriefInput = z
  .object({ articleId: uuid, brief: articleBriefSchema })
  .strict();

export const approveBriefInput = z
  .object({ articleId: uuid, brief: articleBriefSchema })
  .strict();

export const rejectBriefInput = z
  .object({
    articleId: uuid,
    feedback: z
      .string()
      .trim()
      .min(5, 'Spiega in una frase cosa non funziona: il feedback guida la rigenerazione.')
      .max(LIMITS.feedback),
  })
  .strict();

export const approveDraftInput = z.object({ articleId: uuid }).strict();

export const rejectDraftInput = z
  .object({
    articleId: uuid,
    feedback: z.string().trim().min(5).max(LIMITS.feedback),
  })
  .strict();

export const rewriteSectionInput = z
  .object({
    articleId: uuid,
    sectionHeading: z.string().trim().min(1).max(LIMITS.heading),
    instruction: z
      .string()
      .trim()
      .min(5, 'Indica cosa cambiare: senza istruzione la riscrittura è casuale.')
      .max(LIMITS.instruction),
  })
  .strict();

export type ArticleBriefInput = z.infer<typeof articleBriefSchema>;
export type SaveBriefInput = z.infer<typeof saveBriefInput>;
export type ApproveBriefInput = z.infer<typeof approveBriefInput>;
export type RejectBriefInput = z.infer<typeof rejectBriefInput>;
export type ApproveDraftInput = z.infer<typeof approveDraftInput>;
export type RejectDraftInput = z.infer<typeof rejectDraftInput>;
export type RewriteSectionInput = z.infer<typeof rewriteSectionInput>;
