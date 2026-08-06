import { AsyncLocalStorage } from 'node:async_hooks';

import type { Transaction } from './client';

/**
 * CONTESTO DI RICHIESTA — id utente + transazione attiva.
 *
 * Separato da `client.ts` e da `context.ts` di proposito: `client.ts` legge
 * questo store per decidere a cosa inoltrare `db`, `context.ts` lo scrive
 * aprendo la transazione. L'unico legame con `client.ts` è un `import type`
 * (cancellato a compile time): non crea un require circolare a runtime.
 */
export interface RequestDbContext {
  tx: Transaction;
  userId: string;
}

export const requestDbContext = new AsyncLocalStorage<RequestDbContext>();
