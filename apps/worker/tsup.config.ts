import { defineConfig } from 'tsup';

/**
 * BUILD DEL WORKER
 *
 * `tsc` da solo non basta in questo monorepo: i pacchetti `@growmy/*` sono
 * TypeScript sorgente, non compilati. `tsc` emetterebbe import verso file .ts
 * che a runtime non esistono.
 *
 * tsup (esbuild) li IMPACCHETTA nel bundle finale, risolvendo il problema alla
 * radice: l'immagine Docker riceve un solo file JavaScript autosufficiente,
 * senza dover compilare e pubblicare ogni package separatamente.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',

  // Gli stack trace devono puntare al TypeScript originale: senza, il debug di
  // un job fallito in produzione è illeggibile.
  sourcemap: true,

  clean: true,
  splitting: false,
  // Nessuna minificazione: il worker non viaggia in rete, e un bundle leggibile
  // vale più di qualche kilobyte risparmiato quando si legge uno stack trace.
  minify: false,

  /**
   * `noExternal` FORZA l'inclusione dei pacchetti workspace nel bundle.
   *
   * Serve perché tsup, di default, tratta come ESTERNO tutto ciò che compare
   * in `dependencies`. I `@growmy/*` sono lì dentro, quindi verrebbero lasciati
   * come `import '@growmy/ai'` — che a runtime non esiste, essendo TypeScript
   * sorgente mai compilato: `ERR_MODULE_NOT_FOUND` all'avvio del container.
   */
  noExternal: [/^@growmy\//],

  /**
   * Le dipendenze con binari nativi restano invece ESTERNE: esbuild non può
   * impacchettare un `.node` compilato, e provarci produce un bundle che
   * esplode al primo `require`.
   */
  external: ['pg', 'pg-native', 'ioredis', 'bullmq', 'pino', 'pino-pretty'],

  // `import.meta.url` e affini richiedono il banner in ESM su Node.
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
