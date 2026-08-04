/**
 * Skeleton della coda di revisione.
 *
 * Riproduce la geometria reale del layout master/detail: stessa larghezza di
 * colonna, stessa altezza di riga, stessi margini. Uno skeleton che non
 * corrisponde alla struttura finale produce un layout shift al momento
 * dell'idratazione, che è esattamente il problema che dovrebbe evitare.
 *
 * `aria-busy` + label descrittiva: uno screen reader annuncia il caricamento
 * una volta sola, invece di leggere venti div vuoti.
 */
export default function ReviewLoading() {
  return (
    <div
      className="flex h-[calc(100vh-8rem)] gap-4"
      aria-busy="true"
      aria-label="Caricamento della coda di revisione"
    >
      {/* Colonna coda */}
      <div className="flex w-full max-w-sm shrink-0 flex-col rounded-[var(--radius-lg)] border border-border bg-surface md:w-80 lg:w-96">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="h-4 w-32 animate-pulse rounded bg-base-200" />
          <div className="size-4 animate-pulse rounded bg-base-200" />
        </div>

        <div className="flex-1 space-y-1 p-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="rounded-[var(--radius-md)] p-3"
              // Le righe più in basso sono progressivamente più tenui: suggerisce
              // profondità e riduce la sensazione di attesa.
              style={{ opacity: 1 - index * 0.13 }}
            >
              <div className="h-5 w-28 animate-pulse rounded-full bg-base-200" />
              <div className="mt-2 h-4 w-full animate-pulse rounded bg-base-200" />
              <div className="mt-1 h-4 w-3/5 animate-pulse rounded bg-base-200" />
              <div className="mt-2 h-3 w-40 animate-pulse rounded bg-base-100" />
            </div>
          ))}
        </div>

        <div className="border-t border-border px-4 py-2.5">
          <div className="h-3 w-full animate-pulse rounded bg-base-100" />
        </div>
      </div>

      {/* Colonna dettaglio */}
      <div className="flex min-w-0 flex-1 flex-col rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        <div className="border-b border-border pb-3">
          <div className="flex gap-4">
            <div className="h-3 w-20 animate-pulse rounded bg-base-100" />
            <div className="h-3 w-24 animate-pulse rounded bg-base-100" />
          </div>
          <div className="mt-2 h-6 w-3/4 animate-pulse rounded bg-base-200" />
          <div className="mt-2 h-3 w-full animate-pulse rounded bg-base-100" />
        </div>

        <div className="flex gap-2 border-b border-border py-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-7 w-24 animate-pulse rounded-[var(--radius-sm)] bg-base-100"
            />
          ))}
        </div>

        <div className="flex flex-1 gap-6 pt-4">
          {/* Corpo: righe di lunghezza variabile, come prosa reale. */}
          <div className="min-w-0 flex-1 space-y-3">
            {[100, 96, 88, 100, 72, 100, 94, 60].map((width, index) => (
              <div
                key={index}
                className="h-4 animate-pulse rounded bg-base-100"
                style={{ width: `${width}%`, maxWidth: '68ch' }}
              />
            ))}
          </div>

          {/* Pannello qualità */}
          <div className="hidden w-64 shrink-0 lg:block">
            <div className="rounded-[var(--radius-lg)] border border-border p-4">
              <div className="flex items-baseline justify-between">
                <div className="h-4 w-28 animate-pulse rounded bg-base-200" />
                <div className="h-7 w-12 animate-pulse rounded bg-base-200" />
              </div>
              <div className="mt-4 space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index}>
                    <div className="flex justify-between">
                      <div className="h-3 w-24 animate-pulse rounded bg-base-200" />
                      <div className="h-3 w-7 animate-pulse rounded bg-base-200" />
                    </div>
                    <div className="mt-1.5 h-1.5 w-full animate-pulse rounded-full bg-base-100" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <div className="h-8 w-24 animate-pulse rounded-[var(--radius-md)] bg-base-100" />
          <div className="h-8 w-40 animate-pulse rounded-[var(--radius-md)] bg-base-200" />
        </div>
      </div>
    </div>
  );
}
