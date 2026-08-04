/**
 * ORDINE DEGLI IMPORT: NON RIORDINARE.
 *
 * `@growmy/env/load` deve essere valutato per primo. Next.js carica i file
 * `.env` dalla directory dell'applicazione (`apps/web/`), ma i nostri stanno
 * nella root del monorepo perché sono condivisi con worker, drizzle-kit e
 * script di deploy. Senza questa riga, `@growmy/env` valida un ambiente vuoto
 * e il processo si ferma con tutte le variabili "Required".
 */
import '@growmy/env/load';

import type { NextConfig } from 'next';

/**
 * `SKIP_ENV_VALIDATION` non è impostato qui: importando `@growmy/env` in questo
 * file, la validazione delle variabili avviene ALL'AVVIO del processo di build.
 * Se manca una chiave critica il build fallisce subito, invece di produrre
 * un'immagine che esplode alla prima richiesta di un utente.
 */
import '@growmy/env';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * `standalone` produce una cartella con il solo runtime necessario.
   * È ciò che permette all'immagine Docker finale di non contenere né i
   * sorgenti TypeScript né node_modules completo.
   */
  output: 'standalone',

  // La cartella di output standalone deve risalire alla root del monorepo,
  // altrimenti i pacchetti workspace non vengono inclusi.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  /**
   * Questi pacchetti restano esterni al bundle server: contengono dipendenze
   * native (pg, ioredis) che il bundler non può impacchettare correttamente.
   */
  serverExternalPackages: ['pg', 'ioredis', 'pino', 'pino-pretty'],

  experimental: {
    // Compila i pacchetti workspace insieme all'app: niente step di build
    // separato per ogni package durante lo sviluppo.
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  images: {
    // Immagini generate dall'AI e ospitate su storage esterno.
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  // Nessuna informazione sulla versione del framework negli header di risposta.
  poweredByHeader: false,

  // Gli URL con e senza slash finale non devono essere due pagine distinte:
  // è duplicazione di contenuto, che su una piattaforma SEO sarebbe imbarazzante.
  trailingSlash: false,

  eslint: {
    // Il lint gira come task separato in CI: bloccare il build qui rallenta
    // il ciclo di sviluppo senza aggiungere sicurezza.
    ignoreDuringBuilds: true,
  },

  typescript: {
    // I tipi invece SONO bloccanti: un errore di tipo è un bug, non uno stile.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
