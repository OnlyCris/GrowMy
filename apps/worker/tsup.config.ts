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
   * I pacchetti workspace vengono impacchettati (comportamento di default di
   * tsup per le dipendenze non elencate in `external`).
   *
   * Le dipendenze con binari nativi restano ESTERNE: esbuild non può
   * impacchettare un .node compilato, e provarci produce un bundle che esplode
   * al primo `require`.
   */
  external: ['pg', 'pg-native', 'ioredis', 'bullmq', 'pino', 'pino-pretty'],

  // `import.meta.url` e affini richiedono il banner in ESM su Node.
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
