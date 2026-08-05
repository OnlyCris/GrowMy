import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * VARIABILI D'AMBIENTE — validazione fail-fast.
 *
 * Regola di progetto: se manca una variabile critica il build DEVE fallire,
 * non l'applicazione a runtime davanti a un utente. `createEnv` valida in fase
 * di build e a ogni boot del processo.
 *
 * Separazione client/server: tutto ciò che non è prefissato `NEXT_PUBLIC_` è
 * accessibile solo lato server. t3-env lo garantisce a livello di tipi *e* a
 * runtime, quindi importare per errore un segreto in un componente client
 * produce un errore di compilazione invece di finire nel bundle.
 */

/** Le chiavi ad alta entropia devono esserlo davvero: 32 byte minimi. */
const secretKey = (name: string) =>
  z
    .string()
    .min(32, `${name} deve avere almeno 32 caratteri (256 bit di entropia).`);

export const env = createEnv({
  // -------------------------------------------------------------------------
  // SERVER — mai esposto al browser
  // -------------------------------------------------------------------------
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // --- Database ---
    /** Connessione applicativa. Ruolo `app_user`: RLS ATTIVO. */
    DATABASE_URL: z.string().url().startsWith('postgres'),
    /** Connessione worker. Ruolo `app_worker`: BYPASSRLS. Mai usata dall'app web. */
    DATABASE_WORKER_URL: z.string().url().startsWith('postgres').optional(),
    /** Connessione migrazioni. Ruolo `app_migrator`: solo DDL, solo in deploy. */
    DATABASE_MIGRATION_URL: z.string().url().startsWith('postgres').optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    /**
     * TLS verso il database. Deliberatamente NON derivato da `NODE_ENV`.
     *
     * Con Postgres in un container su rete Docker isolata il traffico non
     * lascia mai l'host e il server non offre TLS: pretenderlo faceva fallire
     * ogni connessione in produzione. Con un provider gestito (Supabase, RDS,
     * Neon) va invece impostata a `true`.
     *
     * `z.coerce.boolean()` sarebbe una trappola: converte la stringa "false"
     * in `true`, perché ogni stringa non vuota è truthy.
     */
    DATABASE_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // --- Redis (BullMQ + rate limiting) ---
    REDIS_URL: z.string().url().startsWith('redis'),

    // --- Supabase ---
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: secretKey('SUPABASE_JWT_SECRET'),

    // --- Cifratura credenziali CMS (AES-256-GCM) ---
    /**
     * Chiave in base64, 32 byte decodificati.
     * Presente SOLO nell'ambiente del worker in produzione: l'app web non deve
     * poter decifrare le credenziali dei CMS dei clienti.
     */
    CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'CREDENTIALS_ENCRYPTION_KEY deve decodificare esattamente 32 byte.',
      )
      .optional(),
    /** Versione corrente della chiave: consente la rotazione senza downtime. */
    CREDENTIALS_KEY_VERSION: z.coerce.number().int().positive().default(1),

    // --- Provider LLM (almeno uno obbligatorio, vedi refine più sotto) ---
    ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
    OPENAI_API_KEY: z.string().startsWith('sk-').optional(),
    /**
     * DeepSeek. L'API è compatibile con quella di OpenAI, quindi lo stesso
     * adapter la serve cambiando solo chiave e base URL. La chiave inizia con
     * `sk-`, come quella OpenAI: è la ragione per cui serve una variabile
     * distinta e non si può riusare OPENAI_API_KEY.
     */
    DEEPSEEK_API_KEY: z.string().startsWith('sk-').optional(),
    /** Endpoint DeepSeek. Sovrascrivibile per proxy o self-host. */
    DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    /**
     * Google AI Studio (modelli Gemini).
     * ATTENZIONE: è una chiave DIVERSA da GOOGLE_CLIENT_ID/SECRET.
     * Quelli servono per l'OAuth di login e Search Console; questa serve a
     * generare testo. Si ottengono da due console differenti e non sono
     * intercambiabili — è la confusione più comune in fase di setup.
     */
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().startsWith('AIza').optional(),

    /**
     * Ordine di fallback fra provider, separato da virgola.
     * Valori ammessi: anthropic | openai | deepseek | google
     *
     * Il router prova i provider in quest'ordine: se il primo è in errore,
     * rate-limited o non configurato, passa al successivo invece di far
     * fallire il job.
     */
    LLM_PROVIDER_ORDER: z
      .string()
      .default('google,deepseek,anthropic')
      .refine(
        (value) =>
          value
            .split(',')
            .map((p) => p.trim())
            .every((p) =>
              ['anthropic', 'openai', 'deepseek', 'google'].includes(p),
            ),
        'LLM_PROVIDER_ORDER accetta solo: anthropic, openai, deepseek, google.',
      ),

    // --- Stripe ---
    /**
     * OPZIONALI di proposito. La fatturazione non è ancora attiva: nessun
     * modulo importa queste variabili. Renderle obbligatorie impediva l'avvio
     * di un'istanza perfettamente funzionante che semplicemente non vende
     * ancora nulla — un fallimento senza alcun beneficio di sicurezza.
     *
     * Il formato resta validato: se le imposti, devono essere chiavi vere.
     * Quando la fatturazione entrerà in funzione, il punto in cui pretendere
     * la loro presenza è il modulo che le usa, non il boot dell'intera app.
     */
    STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),

    // --- Google (OAuth + Search Console) ---
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),

    // --- Sicurezza applicativa ---
    /** Segreto per la firma dei token double-submit anti-CSRF. */
    CSRF_SECRET: secretKey('CSRF_SECRET'),
    /** Segreto HMAC per la firma dei webhook in uscita. */
    WEBHOOK_SIGNING_SECRET: secretKey('WEBHOOK_SIGNING_SECRET'),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  },

  // -------------------------------------------------------------------------
  // CLIENT — inlined nel bundle. Qui NON va mai nulla di segreto.
  // -------------------------------------------------------------------------
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    /**
     * Chiave anonima. È pubblica per costruzione: la sicurezza non dipende dal
     * tenerla segreta ma dalle policy RLS, che è esattamente il motivo per cui
     * RLS è forzato su tutte e 30 le tabelle.
     */
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  },

  /**
   * Next.js non espone `process.env` completo ai componenti client: le variabili
   * vanno destrutturate esplicitamente perché il bundler possa inlinearle.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_WORKER_URL: process.env.DATABASE_WORKER_URL,
    DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    DATABASE_SSL: process.env.DATABASE_SSL,
    REDIS_URL: process.env.REDIS_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    CREDENTIALS_ENCRYPTION_KEY: process.env.CREDENTIALS_ENCRYPTION_KEY,
    CREDENTIALS_KEY_VERSION: process.env.CREDENTIALS_KEY_VERSION,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    LLM_PROVIDER_ORDER: process.env.LLM_PROVIDER_ORDER,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    CSRF_SECRET: process.env.CSRF_SECRET,
    WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },

  /**
   * Salta la validazione solo durante `docker build`, dove i segreti runtime
   * non sono ancora iniettati. In ogni altro contesto la validazione è attiva.
   */
  skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',

  /** Una stringa vuota è quasi sempre un `.env` compilato male: trattala come assente. */
  emptyStringAsUndefined: true,
});

/**
 * Invariante che Zod da solo non può esprimere: almeno un provider LLM deve
 * essere configurato, altrimenti la pipeline di generazione non ha come
 * funzionare. Controllato al boot, non alla prima richiesta di un utente.
 */
const CONFIGURED_LLM_PROVIDERS = [
  env.GOOGLE_GENERATIVE_AI_API_KEY && 'google',
  env.DEEPSEEK_API_KEY && 'deepseek',
  env.ANTHROPIC_API_KEY && 'anthropic',
  env.OPENAI_API_KEY && 'openai',
].filter(Boolean) as Array<'google' | 'deepseek' | 'anthropic' | 'openai'>;

if (CONFIGURED_LLM_PROVIDERS.length === 0) {
  throw new Error(
    'Configurazione non valida: serve almeno una chiave fra ' +
      'GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY e OPENAI_API_KEY.',
  );
}

/**
 * Ordine effettivo: dall'ordine richiesto togliamo i provider senza chiave.
 * Evita che il router tenti un provider non configurato e sprechi un tentativo
 * di fallback su un fallimento certo.
 */
export const llmProviderOrder = env.LLM_PROVIDER_ORDER.split(',')
  .map((provider) => provider.trim())
  .filter(
    (provider): provider is 'google' | 'deepseek' | 'anthropic' | 'openai' =>
      CONFIGURED_LLM_PROVIDERS.includes(provider as never),
  );

if (llmProviderOrder.length === 0) {
  throw new Error(
    `LLM_PROVIDER_ORDER ("${env.LLM_PROVIDER_ORDER}") non contiene nessun provider ` +
      `configurato. Provider con chiave: ${CONFIGURED_LLM_PROVIDERS.join(', ')}.`,
  );
}

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
