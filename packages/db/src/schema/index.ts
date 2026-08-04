/**
 * Punto di ingresso unico dello schema.
 *
 * `drizzle-kit` legge da qui per generare le migrazioni, e il client tipizzato
 * (`packages/db/src/client.ts`) riceve questo oggetto come `schema`, che è ciò
 * che abilita l'inferenza dei tipi su ogni query e le query relazionali.
 *
 * REGOLA: non esportare mai da qui helper che eseguono query. Questo file
 * descrive solo la forma dei dati.
 */

export * from './_shared';
export * from './enums';
export * from './identity';
export * from './products';
export * from './content';
export * from './analytics';
export * from './billing';
export * from './ops';
export * from './relations';
