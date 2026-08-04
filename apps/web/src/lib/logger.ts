import { env } from '@growmy/env';
import { createLogger, withContext } from '@growmy/logger';

/**
 * Logger dell'applicazione web.
 *
 * La configurazione — e soprattutto la REDACTION dei segreti — vive in
 * `@growmy/logger`, condivisa con il worker. Duplicarla qui significherebbe
 * tenere allineate due liste di campi da oscurare, cioè dimenticarne una: il
 * giorno in cui il worker impara a nascondere un nuovo campo sensibile, l'app
 * web continuerebbe a stamparlo in chiaro.
 */
export const logger = createLogger({
  service: 'growmy-web',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV !== 'production',
  environment: env.NODE_ENV,
});

/**
 * Logger con contesto di richiesta preapplicato.
 * Ogni riga porta traceId, utente e organizzazione: ricostruire un'operazione
 * completa diventa una sola query sui log.
 */
export function requestLogger(context: {
  traceId: string;
  userId?: string;
  organizationId?: string;
}) {
  return withContext(logger, context);
}
