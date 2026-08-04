import pino, { type Logger } from 'pino';

/**
 * LOGGER STRUTTURATO CONDIVISO
 *
 * Usato sia dall'app web sia dal worker. La redaction NON è affidata alla
 * disciplina di chi scrive la chiamata: è configurata qui e applicata da Pino a
 * ogni log, anche a quelli scritti male.
 *
 * I percorsi coprono i modi in cui un segreto finisce accidentalmente in un
 * log: oggetti di configurazione, header di richiesta, payload di errore di una
 * libreria HTTP che allega l'intera request.
 */

const REDACTED_PATHS = [
  // Credenziali e token, a più livelli di profondità.
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',

  // Colonne del database che non devono mai comparire in un log.
  '*.encryptedCredentials',
  '*.credentialsIv',
  '*.keyHash',
  '*.lookupHash',
  '*.tokenHash',
  '*.encryptedRefreshToken',

  // Header di richiesta e risposta.
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'config.headers.Authorization',
  'config.headers["x-api-key"]',

  // PII diretta: l'id utente basta per correlare, l'email no.
  'email',
  '*.email',
  'user.email',
] as const;

export interface LoggerOptions {
  /** Nome del servizio: distingue web da worker nell'aggregatore di log. */
  service: string;
  level?: string;
  /** Formato leggibile invece di NDJSON. Solo in sviluppo. */
  pretty?: boolean;
  environment?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  const {
    service,
    level = process.env.LOG_LEVEL ?? 'info',
    pretty = process.env.NODE_ENV !== 'production',
    environment = process.env.NODE_ENV ?? 'development',
  } = options;

  return pino({
    level,

    redact: {
      paths: [...REDACTED_PATHS],
      censor: '[redatto]',
    },

    base: { service, env: environment },

    /**
     * In produzione: NDJSON su stdout, che è ciò che si aspetta qualunque
     * aggregatore. In sviluppo: output leggibile da un umano.
     */
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,service,env',
          },
        }
      : undefined,

    formatters: {
      // Il livello come stringa e non come numero: leggibile senza dover
      // mappare 30 -> info.
      level: (label) => ({ level: label }),
    },
  });
}

/**
 * Logger figlio con contesto preapplicato.
 * Ogni riga emessa porta traceId, utente e organizzazione: rende possibile
 * ricostruire un'intera operazione con una sola query sui log.
 */
export function withContext(
  logger: Logger,
  context: {
    traceId?: string;
    jobId?: string;
    userId?: string;
    organizationId?: string;
    productId?: string;
    articleId?: string;
  },
): Logger {
  return logger.child(context);
}

export type { Logger };
