import { randomBytes } from 'node:crypto';

/**
 * Slug URL-safe da un nome libero: minuscolo, solo `[a-z0-9-]`, niente trattini
 * doppi o ai bordi. Troncato a 80 caratteri — resta ampio margine per il
 * suffisso aggiunto da `randomSlugSuffix()`.
 */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    // Blocco Unicode "Combining Diacritical Marks" (U+0300–U+036F): dopo NFKD,
    // "é" diventa "e" + questo carattere combinante. Rimuoverlo lascia "e".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return base.length > 0 ? base : 'organizzazione';
}

/**
 * Suffisso esadecimale breve, sempre appeso allo slug di una nuova
 * organizzazione. Non è un fallback per collisioni rilevate: è la strategia
 * stessa. Sotto RLS un utente nuovo non può MAI vedere le organizzazioni
 * altrui (`organizations_select` le nasconde), quindi un controllo di
 * unicità con una SELECT prima dell'insert sarebbe strutturalmente inutile —
 * risulterebbe sempre "libero" anche quando non lo è. Un suffisso casuale
 * rende la collisione statisticamente trascurabile senza dipendere da una
 * lettura che RLS non permetterebbe comunque.
 */
export function randomSlugSuffix(): string {
  return randomBytes(3).toString('hex'); // 6 caratteri esadecimali
}
