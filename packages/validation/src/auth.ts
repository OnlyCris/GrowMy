import { z } from 'zod';

/**
 * SCHEMI DI VALIDAZIONE — autenticazione e onboarding.
 *
 * Stesse regole di `review.ts`: `.strict()` su ogni oggetto (nessun mass
 * assignment), limite superiore su ogni stringa, messaggi in italiano.
 *
 * Autenticazione via magic link (Supabase `signInWithOtp`) + Google OAuth —
 * niente password: non esiste da validare, e non esiste da dover far
 * reimpostare quando l'utente la dimentica. `signInSchema` e `signUpSchema`
 * hanno la stessa forma (solo email): `supabase.auth.signInWithOtp({ email })`
 * crea l'utente al volo se non esiste già, quindi "accedi" e "registrati" sono
 * la stessa operazione lato Supabase — restano due pagine distinte solo per il
 * copy (intento diverso per chi arriva da un link o dall'altro).
 */

const LIMITS = {
  email: 320, // RFC 5321
  organizationName: 120,
} as const;

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Inserisci un indirizzo email valido.')
  .max(LIMITS.email);

/**
 * `redirectTo`: dove mandare l'utente dopo aver cliccato il link (es. la
 * pagina protetta che stava cercando di aprire). Non è fidato solo perché è
 * passato per la validazione: resta un valore lato client — la sicurezza
 * (deve iniziare per `/`, mai `//`) è applicata di nuovo server-side da
 * `isSafeRelativePath` in `guards.ts`, non qui. Il limite di lunghezza serve
 * solo a scartare input assurdi prima che tocchino qualunque logica.
 */
const redirectToField = z.string().max(500).optional();

export const signInSchema = z
  .object({ email: emailField, redirectTo: redirectToField })
  .strict();

export const signUpSchema = z
  .object({ email: emailField, redirectTo: redirectToField })
  .strict();

export const createOrganizationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Il nome deve avere almeno 2 caratteri.')
      .max(LIMITS.organizationName),
  })
  .strict();

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
