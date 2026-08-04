import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

import type { Logger } from '@growmy/logger';

/**
 * HEALTH CHECK DEL WORKER
 *
 * Il worker non espone porte verso l'esterno, quindi l'healthcheck Docker non
 * può interrogarlo via HTTP dall'esterno del container. Usa invece un file
 * sentinella: il processo lo tocca a intervalli regolari, e il comando di
 * healthcheck verifica che sia stato aggiornato di recente.
 *
 * PERCHÉ UN FILE E NON UN PING HTTP: il file dimostra che l'EVENT LOOP è vivo.
 * Un processo bloccato da un'operazione sincrona pesante risponderebbe comunque
 * a un ping gestito da un thread separato, ma non riuscirebbe ad aggiornare il
 * file — che è esattamente la condizione che vogliamo rilevare.
 *
 * Il server HTTP su localhost esiste in aggiunta, per il debug manuale.
 */

const HEALTH_FILE = '/tmp/worker-healthy';
const TOUCH_INTERVAL_MS = 15_000;
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3001);

export interface HealthServer {
  close(): void;
}

export function startHealthServer(logger: Logger): HealthServer {
  const startedAt = Date.now();

  /** Aggiorna il file sentinella. Se fallisce, il container verrà riavviato. */
  const touch = () => {
    try {
      writeFileSync(HEALTH_FILE, new Date().toISOString(), 'utf8');
    } catch (error) {
      logger.error(
        { err: String(error) },
        'impossibile aggiornare il file di health: il container potrebbe essere riavviato',
      );
    }
  };

  touch();

  // `unref()`: questo timer non deve tenere vivo il processo durante lo
  // spegnimento, altrimenti Node non uscirebbe mai.
  const timer = setInterval(touch, TOUCH_INTERVAL_MS);
  timer.unref();

  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Ascolta SOLO su loopback: il worker non deve essere raggiungibile
  // dall'esterno del container in nessuna circostanza.
  server.listen(HEALTH_PORT, '127.0.0.1', () => {
    logger.debug({ port: HEALTH_PORT }, 'health server del worker avviato');
  });

  server.unref();

  return {
    close() {
      clearInterval(timer);
      server.close();
    },
  };
}
