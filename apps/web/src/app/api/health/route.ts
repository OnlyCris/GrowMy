import { NextResponse } from 'next/server';

/**
 * LIVENESS PROBE — `GET /api/health`
 *
 * Deliberatamente stupido: nessuna dipendenza, nessuna query, nessun I/O.
 * Risponde 200 se e solo se il processo Node è vivo e l'event loop non è bloccato.
 *
 * Perché non verifica il database: se lo facesse, un'indisponibilità temporanea
 * di Postgres farebbe fallire il liveness probe, l'orchestratore riavvierebbe
 * tutti i container, e al ritorno del database si troverebbe una tempesta di
 * riavvii invece di applicazioni pronte. Il controllo delle dipendenze
 * appartiene a `/api/ready`, che toglie dal load balancer senza riavviare.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(
    { status: 'ok', uptimeSeconds: Math.round(process.uptime()) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
