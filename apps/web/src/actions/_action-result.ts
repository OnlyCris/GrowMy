import { AuthorizationError } from '@/lib/auth/guards';
import { logger } from '@/lib/logger';
import type { ActionErrorCode, ActionResult } from '@/types/review';

/**
 * NUCLEO DI GESTIONE ERRORI CONDIVISO fra `_safe-action.ts` (azioni su un
 * tenant esistente) e `_bootstrap-action.ts` (azioni senza tenant: signin,
 * signup, creazione della prima organizzazione). Estratto qui perché la
 * regola "nessuna eccezione grezza raggiunge il client" deve valere
 * identicamente per entrambi, in un solo posto — non duplicata due volte con
 * la garanzia implicita che restino sincronizzate.
 */

/** Errore di dominio sollevabile dagli handler con un codice esplicito. */
export class ActionError extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export function fail(code: ActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

/**
 * Converte qualunque eccezione in un risultato tipizzato.
 *
 * Gli errori attesi (autorizzazione, dominio) producono un messaggio utile.
 * Tutto il resto diventa un `INTERNAL_ERROR` generico: un messaggio di errore
 * dettagliato su un fallimento imprevisto è una fuga di informazione, perché
 * può rivelare nomi di tabelle, vincoli e struttura interna.
 */
export function handleError(
  error: unknown,
  actionName: string,
  traceId: string,
  startedAt: number,
): ActionResult<never> {
  const durationMs = Math.round(performance.now() - startedAt);

  if (error instanceof AuthorizationError) {
    logger.warn(
      { traceId, action: actionName, code: error.code, durationMs },
      'autorizzazione negata',
    );
    return { ok: false, code: error.code, message: error.message };
  }

  if (error instanceof ActionError) {
    logger.warn(
      { traceId, action: actionName, code: error.code, durationMs },
      'errore di dominio',
    );
    return {
      ok: false,
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
    };
  }

  // Imprevisto: stack trace SOLO nel log, mai nella risposta.
  logger.error(
    {
      traceId,
      action: actionName,
      durationMs,
      err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    },
    'errore non gestito in una server action',
  );

  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: `Qualcosa è andato storto. Se il problema persiste, cita questo codice al supporto: ${traceId.slice(0, 8)}`,
  };
}
