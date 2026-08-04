/**
 * Logica di dominio condivisa fra app web e worker.
 * Nessun I/O HTTP, nessuna dipendenza dal database: solo funzioni pure e
 * regole di business, così sono testabili senza infrastruttura.
 */
export * from './articles/state-machine';
