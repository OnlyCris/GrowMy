/**
 * Normalizza uno slug.
 * `NFD` + rimozione dei diacritici trasforma "però" in "pero" invece di
 * scartare la lettera: essenziale per l'italiano.
 *
 * In `packages/core` perché serve sia al worker (slug derivato dalla keyword
 * per gli articoli generati) sia al web (slug derivato dal titolo per gli
 * articoli scritti a mano) — stessa regola, un solo posto.
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
