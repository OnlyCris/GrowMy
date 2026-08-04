import 'server-only';

/**
 * SESSIONE DI SVILUPPO — scorciatoia per lavorare senza Supabase in locale.
 *
 * Perché esiste: configurare un progetto Supabase e un OAuth client Google
 * solo per vedere una pagina in locale è attrito che scoraggia il contributo.
 * Con `DEV_AUTH_BYPASS` attivo, l'app considera autenticato l'utente creato
 * dal seed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUESTO È UN BYPASS DI AUTENTICAZIONE. In produzione sarebbe una porta
 * spalancata. Per questo non è protetto da una convenzione ma da tre barriere
 * indipendenti, e la prima è fatale:
 *
 *   1. Se NODE_ENV === 'production' il modulo LANCIA all'import. Non c'è
 *      combinazione di variabili che lo renda attivo in produzione: il
 *      processo non parte proprio.
 *   2. Serve DEV_AUTH_BYPASS impostata esplicitamente a 'true'. Nessun
 *      default permissivo.
 *   3. L'id restituito deve corrispondere a un utente realmente esistente nel
 *      database, altrimenti ogni query scoped restituisce zero righe.
 *
 * La barriera 1 è quella che conta. Le altre due sono ridondanza.
 * ═══════════════════════════════════════════════════════════════════════════
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'SICUREZZA: dev-session.ts è stato importato in un build di produzione. ' +
      'Questo modulo aggira l’autenticazione e non deve mai finire in un ' +
      'artefatto di produzione. Interrompo l’avvio.',
  );
}

/**
 * UUID fisso dell'utente di sviluppo, allineato a `packages/db/src/seed.ts`.
 * Deve essere un UUID valido: le colonne del database lo tipizzano come tale.
 */
export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_USER_EMAIL = 'dev@growmy.local';

/** Vero solo se il bypass è attivo e siamo fuori dalla produzione. */
export function isDevAuthBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_AUTH_BYPASS === 'true'
  );
}

/**
 * Utente fittizio con la stessa forma di quello restituito da Supabase, così
 * il resto dell'applicazione non sa nulla di questa scorciatoia e non contiene
 * un solo `if (isDev)` sparso nella logica di autorizzazione.
 */
export function getDevUser() {
  return {
    id: DEV_USER_ID,
    email: DEV_USER_EMAIL,
    emailVerified: true,
  };
}
