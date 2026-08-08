import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — Search Console e closed-loop planner.
 * Stessa disciplina del resto del pacchetto: `.strict()`, limiti su ogni stringa.
 */

const uuid = z.string().uuid('Identificatore non valido.');

/**
 * Identificatore di una property Search Console.
 *
 * Due formati, entrambi legittimi e non intercambiabili:
 *  - `sc-domain:esempio.it` — property di dominio, copre tutti i sottodomini
 *    e i protocolli. È quella da preferire.
 *  - `https://esempio.it/` — property con prefisso URL, copre solo quell'origine.
 *
 * Il valore arriva sempre da `listGscSites`, quindi non è testo libero
 * dell'utente; la validazione serve comunque, perché il campo transita in un
 * form e finisce in una chiamata HTTP verso Google.
 */
const gscSiteUrl = z
  .string()
  .trim()
  .min(1, 'Seleziona una property.')
  .max(512)
  .refine(
    (value) => value.startsWith('sc-domain:') || value.startsWith('https://'),
    'Property non riconosciuta: deve iniziare con "sc-domain:" oppure "https://".',
  );

/**
 * Conferma della property scelta dopo il consenso Google.
 *
 * Il refresh token NON passa da qui: resta nella cache server-side scritta dal
 * callback OAuth, indicizzata da `connectionToken`. Farlo transitare per il
 * browser lo esporrebbe alla cronologia, ai log del proxy e a qualunque
 * estensione installata — per un segreto permanente di accesso ai dati Search
 * Console di un cliente è un rischio che non ha contropartita.
 */
export const confirmGscPropertySchema = z
  .object({
    productId: uuid,
    /** Opaco, monouso, a scadenza. Emesso dal callback OAuth. */
    connectionToken: z.string().trim().min(16).max(256),
    siteUrl: gscSiteUrl,
  })
  .strict();

export type ConfirmGscPropertyInput = z.infer<typeof confirmGscPropertySchema>;

export const disconnectGscSchema = z.object({ productId: uuid }).strict();
export type DisconnectGscInput = z.infer<typeof disconnectGscSchema>;

export const syncGscNowSchema = z.object({ productId: uuid }).strict();
export type SyncGscNowInput = z.infer<typeof syncGscNowSchema>;

export const runPlannerNowSchema = z.object({ productId: uuid }).strict();
export type RunPlannerNowInput = z.infer<typeof runPlannerNowSchema>;

/**
 * Esito scelto dall'utente su una cannibalizzazione.
 *
 * `ignore` è un esito di prima classe, non una scorciatoia: a volte due pagine
 * competono sulla stessa query per una ragione voluta (una pagina prodotto e
 * una guida). Senza questa opzione l'unico modo di togliere la riga dalla
 * lista sarebbe fingere di averla risolta.
 */
export const resolveCannibalizationSchema = z
  .object({
    issueId: uuid,
    resolvedAction: z.enum(['merge', 'differentiate', 'canonicalize', 'ignore'], {
      errorMap: () => ({ message: 'Azione non riconosciuta.' }),
    }),
  })
  .strict();

export type ResolveCannibalizationInput = z.infer<typeof resolveCannibalizationSchema>;

/**
 * Promozione di un'opportunità in striking distance a keyword lavorabile.
 *
 * Entra come `suggested`, non come `approved`: è la stessa porta di revisione
 * umana già applicata alle keyword proposte dall'AI. Un dato reale di Search
 * Console è un'indicazione più solida di una proposta generata, ma resta una
 * proposta — e la decisione di spendere un credito su di essa è dell'utente.
 */
export const promoteOpportunitySchema = z
  .object({
    productId: uuid,
    term: z.string().trim().min(2, 'Keyword troppo corta.').max(255),
    /** Numeri che motivano la promozione, conservati in `planner_decisions`. */
    impressions: z.number().int().min(0).max(100_000_000),
    position: z.number().min(0).max(1000),
  })
  .strict();

export type PromoteOpportunityInput = z.infer<typeof promoteOpportunitySchema>;
