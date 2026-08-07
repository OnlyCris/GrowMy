import Link from 'next/link';

/**
 * 404 scoped alla vetrina blog: niente riferimenti alla dashboard o a
 * GrowMy, un visitatore qui non sa (né deve sapere) cosa sia — vede solo il
 * blog del prodotto.
 */
export default function BlogNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-start px-4 py-24 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Pagina non trovata
      </h1>
      <p className="mt-3 text-sm text-foreground-muted">
        L’articolo che cerchi non esiste o non è più pubblicato.
      </p>
      <Link
        href="/"
        className="mt-6 text-sm text-info-700 underline underline-offset-4 hover:no-underline"
      >
        ← Torna al blog
      </Link>
    </div>
  );
}
