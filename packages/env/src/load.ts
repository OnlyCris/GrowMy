import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from 'dotenv';

/**
 * CARICAMENTO DEI FILE .env DALLA ROOT DEL MONOREPO
 *
 * Il problema che risolve: Next.js carica `.env.local` dalla directory
 * dell'applicazione (`apps/web/`), non dalla root del workspace. Ma i file di
 * ambiente stanno nella root, perché sono condivisi con il worker, con
 * drizzle-kit e con gli script di deploy — duplicarli significherebbe tenerli
 * allineati a mano, cioè non tenerli allineati.
 *
 * Va importato PRIMA di qualunque modulo che legga `process.env`. In
 * `next.config.ts` è la prima riga: gli import sono valutati nell'ordine in cui
 * compaiono, quindi le variabili sono già in memoria quando `@growmy/env`
 * esegue la propria validazione.
 *
 * Precedenza, dalla più alta alla più bassa:
 *   1. Variabili già nell'ambiente (CI, docker compose, export manuale)
 *   2. .env.local   — sviluppo locale, non versionato
 *   3. .env         — produzione
 *
 * `override: false` fa sì che nulla sovrascriva ciò che è già definito, quindi
 * l'ordine di caricamento produce esattamente questa precedenza.
 *
 * NOTA IMPLEMENTATIVA: la ricerca parte da `process.cwd()` e non da
 * `import.meta.url`. Next.js compila `next.config.ts` in CommonJS tramite un
 * require-hook, e `import.meta` non esiste in quel contesto. Partire dalla
 * directory di lavoro funziona in entrambi i formati e da qualunque pacchetto
 * il modulo venga importato.
 */

function findRepoRoot(startDir: string): string {
  let current = startDir;

  // Risale finché non incontra pnpm-workspace.yaml. Un numero fisso di `..`
  // non funzionerebbe: questo modulo è importato da profondità diverse
  // (apps/web, packages/db, apps/worker).
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break; // raggiunta la radice del filesystem
    current = parent;
  }

  return startDir;
}

export const repoRoot = findRepoRoot(process.cwd());
export const loadedEnvFiles: string[] = [];

for (const filename of ['.env.local', '.env']) {
  const path = resolve(repoRoot, filename);
  if (existsSync(path)) {
    config({ path, override: false, quiet: true });
    loadedEnvFiles.push(path);
  }
}

/**
 * Diagnostica esplicita quando non si trova nulla. Senza, l'errore visibile
 * sarebbe quello della validazione con tutte le variabili "Required", che
 * suggerisce un problema di configurazione invece del vero problema: il file
 * non esiste.
 */
if (loadedEnvFiles.length === 0) {
  console.warn(
    `\n  Nessun file di ambiente trovato in ${repoRoot}\n` +
      '  Per lo sviluppo locale:  cp .env.local.example .env.local\n',
  );
}
