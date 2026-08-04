import { env, isProduction } from '@growmy/env';
import pino from 'pino';

/**
 * LOGGER STRUTTURATO
 *
 * Regola di progetto: gli errori si loggano in modo sicuro, senza esporre PII.
 * La redaction non è affidata alla disciplina di chi scrive la chiamata — è
 * configurata qui e applicata da Pino a ogni log, anche a quelli scritti male.
 *
 * I percorsi elencati coprono i modi in cui un segreto finisce accidentalmente
 * in un log: oggetti di configurazione, header di richiesta, payload di errore
 * di una libreria HTTP che allega l'intera request.
 */

const REDACTED_PATHS = [
  // Credenziali e token, a qualunque profondità ragionevole.
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

  // Header di richiesta.
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',

  // PII diretta. L'id utente basta per correlare; l'email no.
  'email',
  '*.email',
  'user.email',
] as const;

export const logger = pino({
  level: env.LOG_LEVEL,

  redact: {
    paths: [...REDACTED_PATHS],
    censor: '[redatto]',
  },

  base: {
    service: 'growmy-web',
    env: env.NODE_ENV,
  },

  /**
   * In produzione: NDJSON su stdout, che è ciò che si aspetta qualunque
   * aggregatore di log. In sviluppo: output leggibile da un umano.
   */
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,service,env',
        },
      },

  formatters: {
    // Il livello come stringa invece che come numero: leggibile in Loki/Datadog
    // senza dover mappare 30 -> info.
    level: (label) => ({ level: label }),
  },
});

/**
 * Logger figlio con contesto di richiesta preapplicato.
 * Ogni riga emessa da qui porta traceId, utente e organizzazione, il che rende
 * possibile ricostruire un'intera operazione da una sola query sui log.
 */
export function requestLogger(context: {
  traceId: string;
  userId?: string;
  organizationId?: string;
}) {
  return logger.child(context);
}
