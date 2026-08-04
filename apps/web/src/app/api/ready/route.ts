import { checkDatabaseHealth } from '@growmy/db';
import { NextResponse } from 'next/server';

import { checkRedisHealth } from '@/lib/rate-limit';

/**
 * READINESS PROBE — `GET /api/ready`
 *
 * È l'endpoint che `scripts/update.sh` interroga in polling prima di spostare
 * il traffico sul nuovo container. Un 200 qui significa: "questo processo può
 * servire richieste reali", non solo "il processo è vivo".
 *
 * Distinzione con `/api/health` (liveness): quello risponde 200 finché il
 * processo esiste. Se `/api/health` fallisce, l'orchestratore riavvia il
 * container. Se fallisce `/api/ready`, lo toglie dal load balancer ma non lo
 * riavvia — perché il problema è a valle (database, Redis) e riavviare non
 * risolverebbe nulla.
 *
 * SICUREZZA: la risposta espone latenza e stato delle dipendenze, ma mai
 * hostname, versioni, stringhe di connessione o messaggi d'errore del driver.
 * Sono informazioni utili a chi fa ricognizione su un'infrastruttura.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const startedAt = performance.now();

  // Le due verifiche sono indipendenti: eseguirle in parallelo dimezza il
  // tempo di risposta del probe, che viene interrogato ogni pochi secondi.
  const [database, redis] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
  ]);

  const ready = database.healthy && redis.healthy;

  return NextResponse.json(
    {
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: {
          healthy: database.healthy,
          latencyMs: database.latencyMs,
        },
        redis: {
          healthy: redis.healthy,
          latencyMs: redis.latencyMs,
        },
      },
      totalMs: Math.round(performance.now() - startedAt),
    },
    {
      status: ready ? 200 : 503,
      headers: {
        // Un readiness probe cacheato è un readiness probe inutile.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
