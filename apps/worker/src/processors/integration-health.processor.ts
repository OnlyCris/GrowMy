import { createAdapter, createCipherFromEnv } from '@growmy/integrations';
import {
  getWorkerDb,
  integrationHealthChecks,
  integrations,
} from '@growmy/db';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * HEALTH CHECK PREVENTIVO DELLE INTEGRAZIONI — UPGRADE #3
 *
 * Gira ogni 24 ore su tutte le integrazioni attive.
 *
 * IL PUNTO: su Outrank l'utente scopre che il token WordPress è scaduto quando
 * un articolo fallisce la pubblicazione — cioè quando è già troppo tardi e la
 * pipeline si è fermata. Qui lo scopre PRIMA, con l'integrazione marcata
 * "Da riparare" nell'interfaccia e nessun articolo perso.
 *
 * Ogni esito finisce in `integration_health_checks`, che alimenta lo storico:
 * l'utente vede QUANDO si è rotto qualcosa, non solo CHE è rotto.
 */

export async function processIntegrationHealth(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger, job } = ctx;

  // Se il job punta a una singola integrazione la controlliamo da sola;
  // altrimenti è il giro completo del cron.
  const targetId = job.targetId;

  const candidates = await db
    .select({
      id: integrations.id,
      organizationId: integrations.organizationId,
      productId: integrations.productId,
      provider: integrations.provider,
      encryptedCredentials: integrations.encryptedCredentials,
      credentialsIv: integrations.credentialsIv,
      credentialsKeyVersion: integrations.credentialsKeyVersion,
      config: integrations.config,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      targetId
        ? eq(integrations.id, targetId)
        : and(
            isNull(integrations.deletedAt),
            ne(integrations.status, 'disabled'),
            // Solo quelle non controllate nelle ultime 20 ore: evita di
            // ripetere il giro se il cron scatta due volte ravvicinate.
            or(
              isNull(integrations.lastHealthCheckAt),
              lt(
                integrations.lastHealthCheckAt,
                new Date(Date.now() - 20 * 3_600_000),
              ),
            ),
          ),
    )
    .limit(targetId ? 1 : 200);

  if (candidates.length === 0) {
    await recorder.event({
      step: 'health.skip',
      message: 'Nessuna integrazione da controllare.',
    });
    return;
  }

  const cipher = createCipherFromEnv();
  let healthy = 0;
  let broken = 0;

  for (const integration of candidates) {
    try {
      const credentials = cipher.decrypt<Record<string, unknown>>({
        ciphertext: integration.encryptedCredentials,
        iv: integration.credentialsIv,
        keyVersion: integration.credentialsKeyVersion,
      });

      const adapter = createAdapter(
        integration.provider,
        credentials,
        (integration.config as Record<string, unknown>) ?? {},
      );

      const result = await adapter.healthCheck();

      await db.insert(integrationHealthChecks).values({
        integrationId: integration.id,
        result: result.result,
        durationMs: result.durationMs,
        httpStatus: result.httpStatus ?? null,
        message: result.message,
      });

      /**
       * Mappa l'esito sullo stato dell'integrazione.
       *
       * `auth_failed` e `permission_denied` diventano `broken`: richiedono
       * un'azione umana, e l'ambra nell'interfaccia serve proprio a questo.
       * `rate_limited` e `unreachable` sono transitori: `degraded`, che avvisa
       * senza allarmare.
       */
      const nextStatus =
        result.result === 'ok'
          ? 'healthy'
          : result.result === 'auth_failed' ||
              result.result === 'permission_denied' ||
              result.result === 'not_found'
            ? 'broken'
            : 'degraded';

      await db
        .update(integrations)
        .set({
          status: nextStatus,
          lastHealthCheckAt: new Date(),
          lastHealthCheckResult: result.result,
          lastErrorMessage: result.result === 'ok' ? null : result.message,
          consecutiveFailures:
            result.result === 'ok'
              ? 0
              : sql`${integrations.consecutiveFailures} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integration.id));

      if (result.result === 'ok') healthy++;
      else broken++;

      logger.debug(
        {
          integrationId: integration.id,
          provider: integration.provider,
          result: result.result,
        },
        'health check eseguito',
      );
    } catch (error) {
      // Un'integrazione che non si riesce nemmeno a decifrare non deve
      // interrompere il controllo delle altre.
      broken++;

      const message =
        error instanceof Error && error.name === 'CryptoError'
          ? 'Impossibile decifrare le credenziali: riconnetti l’integrazione.'
          : 'Controllo non riuscito per un errore interno.';

      await db.insert(integrationHealthChecks).values({
        integrationId: integration.id,
        result: 'unknown_error',
        message,
      });

      await db
        .update(integrations)
        .set({
          status: 'broken',
          lastHealthCheckAt: new Date(),
          lastHealthCheckResult: 'unknown_error',
          lastErrorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integration.id));

      logger.warn(
        { integrationId: integration.id, err: String(error) },
        'health check fallito',
      );
    }
  }

  await recorder.event({
    step: 'health.done',
    message: `Controllate ${candidates.length} integrazioni: ${healthy} operative, ${broken} da verificare.`,
    details: { healthy, broken },
  });
}
