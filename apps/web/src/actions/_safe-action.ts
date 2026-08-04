import { auditLogs, db } from '@growmy/db';
import { headers } from 'next/headers';
import type { z } from 'zod';

import {
  AuthorizationError,
  assertOrgRoleById,
  type OrgMembership,
  type OrgRole,
} from '@/lib/auth/guards';
import { logger } from '@/lib/logger';
import {
  anonymousSubjectFromHeaders,
  checkRateLimit,
  type RateLimitScope,
} from '@/lib/rate-limit';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import type { ActionErrorCode, ActionResult } from '@/types/review';

/**
 * WRAPPER UNICO PER LE SERVER ACTIONS
 *
 * Nessuna Server Action dell'applicazione è esportata senza passare da qui.
 * Il wrapper applica, sempre nello stesso ordine:
 *
 *   1. Verifica sessione lato server (`getUser()`, non `getSession()`).
 *   2. Rate limiting sullo scope dell'azione.
 *   3. Risoluzione tenant + controllo RBAC del ruolo minimo.
 *   4. Validazione Zod `.strict()` dell'input.
 *   5. Esecuzione dell'handler.
 *   6. Scrittura su `audit_logs` se l'azione è marcata come sensibile.
 *   7. Conversione di qualunque eccezione in un `ActionResult` discriminato.
 *
 * L'ordine non è arbitrario. Il rate limit precede la risoluzione del tenant
 * perché una query al database è precisamente il costo che vogliamo evitare a
 * un attaccante. Il controllo RBAC precede la validazione perché non ha senso
 * spendere cicli a validare il payload di chi non è autorizzato comunque.
 *
 * REGOLA INVIOLABILE: nessuna eccezione grezza raggiunge il client. Lo stack
 * trace va al logger con un `traceId`; l'utente riceve un messaggio leggibile e
 * quel traceId, che può citare al supporto.
 */

interface ActionConfig<TInput extends z.ZodTypeAny> {
  /** Nome dell'azione, usato in log e audit. Convenzione: `dominio.verbo`. */
  name: string;
  /** Schema di validazione dell'input. Deve essere `.strict()`. */
  schema: TInput;
  /** Scope di rate limiting. */
  rateLimit: RateLimitScope;
  /**
   * Ruolo minimo richiesto. L'organizzazione è risolta da `resolveTenant`,
   * non dall'input del client: un payload non può dichiarare a quale tenant
   * appartiene.
   */
  minimumRole: OrgRole;
  /**
   * Ricava l'`organizationId` dall'input validato, tipicamente risalendo
   * dall'entità toccata. È il punto in cui si impedisce a un utente di operare
   * su risorse di un'altra organizzazione.
   */
  resolveTenant: (input: z.infer<TInput>) => Promise<string | null>;
  /** Se true scrive una riga su `audit_logs` a esito positivo. */
  audit?: { targetType: string; getTargetId: (input: z.infer<TInput>) => string };
}

type Handler<TInput extends z.ZodTypeAny, TOutput> = (args: {
  input: z.infer<TInput>;
  membership: OrgMembership;
  traceId: string;
}) => Promise<TOutput>;

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

export function createSafeAction<TInput extends z.ZodTypeAny, TOutput>(
  config: ActionConfig<TInput>,
  handler: Handler<TInput, TOutput>,
) {
  return async (rawInput: unknown): Promise<ActionResult<TOutput>> => {
    // Correla la risposta all'utente con la riga di log lato server.
    const traceId = crypto.randomUUID();
    const startedAt = performance.now();

    try {
      // --- 1. Sessione -----------------------------------------------------
      const user = await getAuthenticatedUser();
      if (!user) {
        return fail('UNAUTHENTICATED', 'Sessione scaduta. Accedi di nuovo.');
      }

      // --- 2. Rate limit ---------------------------------------------------
      const limit = await checkRateLimit(config.rateLimit, `user:${user.id}`);
      if (!limit.allowed) {
        const seconds = Math.ceil(limit.retryAfterMs / 1000);
        logger.warn(
          { traceId, action: config.name, userId: user.id },
          'rate limit superato',
        );
        return fail(
          'RATE_LIMITED',
          `Troppe richieste. Riprova fra ${seconds} second${seconds === 1 ? 'o' : 'i'}.`,
        );
      }

      // --- 3. Validazione --------------------------------------------------
      // Anticipata rispetto alla risoluzione del tenant perché quest'ultima
      // legge un id DALL'input: dobbiamo sapere che sia un UUID valido prima
      // di interrogare il database con esso.
      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        const flattened = parsed.error.flatten();
        return {
          ok: false,
          code: 'VALIDATION_FAILED',
          message: 'Alcuni campi non sono validi.',
          fieldErrors: flattened.fieldErrors as Record<string, string[]>,
        };
      }
      const input = parsed.data as z.infer<TInput>;

      // --- 4. Tenant + RBAC ------------------------------------------------
      const organizationId = await config.resolveTenant(input);
      if (!organizationId) {
        // 404 e non 403: non confermiamo l'esistenza di risorse altrui.
        return fail('NOT_FOUND', 'Risorsa non trovata.');
      }

      const membership = await assertOrgRoleById(
        organizationId,
        config.minimumRole,
      );

      // --- 5. Esecuzione ---------------------------------------------------
      const output = await handler({ input, membership, traceId });

      // --- 6. Audit --------------------------------------------------------
      if (config.audit) {
        const requestHeaders = await headers();
        await db.insert(auditLogs).values({
          organizationId: membership.organizationId,
          actorUserId: membership.userId,
          action: config.name,
          targetType: config.audit.targetType,
          targetId: config.audit.getTargetId(input),
          // Solo metadati non sensibili: mai il payload completo, che può
          // contenere testo scritto dall'utente.
          metadata: { traceId },
          ipPrefix: anonymousSubjectFromHeaders(requestHeaders).replace('ip:', ''),
        });
      }

      logger.info(
        {
          traceId,
          action: config.name,
          userId: membership.userId,
          organizationId: membership.organizationId,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'azione completata',
      );

      return { ok: true, data: output };
    } catch (error) {
      return handleError(error, config.name, traceId, startedAt);
    }
  };
}

function fail(code: ActionErrorCode, message: string): ActionResult<never> {
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
function handleError(
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
