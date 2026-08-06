import { headers } from 'next/headers';
import type { z } from 'zod';

import { logger } from '@/lib/logger';
import {
  anonymousSubjectFromHeaders,
  checkRateLimit,
  type RateLimitScope,
} from '@/lib/rate-limit';
import {
  getAuthenticatedUser,
  type AuthenticatedUser,
} from '@/lib/supabase/server';
import type { ActionResult } from '@/types/review';

import { fail, handleError } from './_action-result';

/**
 * WRAPPER PER AZIONI SENZA TENANT — signin, signup, creazione della prima
 * organizzazione.
 *
 * `createSafeAction` (`_safe-action.ts`) presuppone un'organizzazione GIÀ
 * esistente: i suoi passi 3–4 risolvono un `organizationId` dall'input e
 * controllano l'RBAC su quello. Per queste tre azioni non c'è ancora nessun
 * tenant — è letteralmente ciò che l'azione sta per creare, o un passo che
 * precede qualunque tenant. Da qui un wrapper sorella, non un ramo `if` dentro
 * l'altro: stesso contratto (autenticazione opzionale-o-richiesta, rate limit,
 * validazione Zod, `ActionResult` tipizzato, nessuna eccezione grezza verso il
 * client — tramite gli stessi `fail`/`handleError` di `_action-result.ts`),
 * ma senza i passi 3–4 che qui non hanno senso.
 *
 * Nessun insert automatico su `audit_logs`: un'azione che vuole loggarsi lo fa
 * da sé, dentro la propria transazione — l'organizationId a cui l'audit deve
 * agganciarsi spesso non esiste finché l'handler non lo crea.
 */

interface BootstrapActionConfig<TInput extends z.ZodTypeAny> {
  /** Nome dell'azione, usato in log. Convenzione: `dominio.verbo`. */
  name: string;
  /** Schema di validazione dell'input. Deve essere `.strict()`. */
  schema: TInput;
  /** Scope di rate limiting. */
  rateLimit: RateLimitScope;
  /**
   * `true`: l'azione richiede una sessione valida (es. creare la prima
   * organizzazione). `false`: l'azione DEVE poter girare da anonimo (signin,
   * signup) — `user` è comunque popolato se una sessione esiste già, ma non è
   * un requisito.
   */
  requireAuth: boolean;
}

type BootstrapHandler<TInput, TOutput> = (args: {
  input: TInput;
  user: AuthenticatedUser | null;
  traceId: string;
}) => Promise<TOutput>;

export function createBootstrapAction<TInput extends z.ZodTypeAny, TOutput>(
  config: BootstrapActionConfig<TInput>,
  handler: BootstrapHandler<z.infer<TInput>, TOutput>,
) {
  return async (rawInput: unknown): Promise<ActionResult<TOutput>> => {
    const traceId = crypto.randomUUID();
    const startedAt = performance.now();

    try {
      // --- 1. Sessione (facoltativa o richiesta secondo `requireAuth`) -----
      const user = await getAuthenticatedUser();
      if (config.requireAuth && !user) {
        return fail('UNAUTHENTICATED', 'Sessione scaduta. Accedi di nuovo.');
      }

      // --- 2. Rate limit -----------------------------------------------------
      // Un utente autenticato è limitato per id (coerente coi colleghi dietro
      // lo stesso NAT); un anonimo per IP troncato — vedi `rate-limit.ts`.
      const subject = user
        ? `user:${user.id}`
        : anonymousSubjectFromHeaders(await headers());
      const limit = await checkRateLimit(config.rateLimit, subject);
      if (!limit.allowed) {
        const seconds = Math.ceil(limit.retryAfterMs / 1000);
        logger.warn(
          { traceId, action: config.name, subject },
          'rate limit superato',
        );
        return fail(
          'RATE_LIMITED',
          `Troppe richieste. Riprova fra ${seconds} second${seconds === 1 ? 'o' : 'i'}.`,
        );
      }

      // --- 3. Validazione ------------------------------------------------
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

      // --- 4. Esecuzione ---------------------------------------------------
      const output = await handler({ input: parsed.data, user, traceId });

      logger.info(
        {
          traceId,
          action: config.name,
          userId: user?.id,
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
