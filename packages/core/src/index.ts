/**
 * Logica di dominio condivisa fra app web e worker.
 * Nessun I/O HTTP, nessuna dipendenza dal database: solo funzioni pure e
 * regole di business, così sono testabili senza infrastruttura.
 */
export * from './articles/state-machine';
export * from './articles/quality-score';
export * from './articles/internal-links';
export * from './articles/slug';

/**
 * Closed-loop planner (UPGRADE #2): trasforma le metriche di Search Console in
 * decisioni editoriali motivate. Funzioni pure, senza I/O — il worker aggrega
 * le righe dal database e passa qui i dati già pronti.
 */
export * from './planner/commercial-value';
export * from './planner/ctr-curve';
export * from './planner/ctr-gap';
export * from './planner/striking-distance';
export * from './planner/cannibalization';
export * from './planner/refresh';
