import { sql } from 'drizzle-orm';

import { rawDb } from './client';
import { requestDbContext } from './request-context';

/**
 * CONTESTO RLS PER-RICHIESTA
 *
 * Le policy RLS non possono ricevere parametri dalla query che le innesca:
 * l'unico modo per far sapere al database "chi sta chiedendo" è una variabile
 * di sessione, valida per la durata di UNA transazione (`SET LOCAL` /
 * `set_config(..., true)`).
 *
 * `pg.Pool` assegna una connessione qualsiasi a ogni query: senza aprire
 * esplicitamente una transazione, due `db.select()` consecutivi potrebbero
 * finire su connessioni diverse e la variabile di sessione impostata dalla
 * prima non esisterebbe per la seconda. Per questo ogni unità di lavoro che
 * legge o scrive per conto di un utente autenticato deve passare da qui.
 *
 * REGOLA: un `withUserContext` per unità di lavoro (un render di Server
 * Component, il corpo di una Server Action) — non uno per singola query.
 * Annidare chiamate con lo stesso `userId` è sicuro (vedi sotto) ma inutile:
 * apre una transazione in più senza guadagnare nulla.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withUserContext<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error(`withUserContext: id utente non valido: ${userId}`);
  }

  const existing = requestDbContext.getStore();

  /**
   * Rientranza: se siamo già dentro un contesto per LO STESSO utente (es.
   * `assertOrgRoleById` chiamato da dentro un handler che `_safe-action.ts`
   * ha già avvolto), eseguiamo semplicemente la callback. Aprire una
   * transazione annidata prenderebbe una connessione DIVERSA dal pool,
   * perdendo sia la variabile di sessione sia l'atomicità del blocco esterno.
   */
  if (existing && existing.userId === userId) {
    return callback();
  }

  return rawDb.transaction(async (tx) => {
    /**
     * `set_config()`, non `SET LOCAL app.current_user_id = '${userId}'`:
     * `SET` non accetta parametri bind nel protocollo esteso di Postgres, quindi
     * costruire quella istruzione a mano sarebbe l'unico punto in questo
     * codebase in cui un valore derivato da input utente tocca testo SQL
     * concatenato. `set_config()` è una funzione ordinaria e accetta un
     * parametro ordinario: nessuna interpolazione, nessuna superficie di
     * injection.
     */
    await tx.execute(
      sql`select set_config('app.current_user_id', ${userId}, true)`,
    );

    return requestDbContext.run({ tx, userId }, callback);
  });
}
