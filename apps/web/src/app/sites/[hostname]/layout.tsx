import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getProductByBlogDomain } from '@/lib/queries/blog';

/**
 * LAYOUT DELLA VETRINA BLOG PUBBLICA.
 *
 * Raggiunta SOLO via riscrittura del middleware quando l'header Host non è
 * quello dell'app (vedi `middleware.ts`): un dominio personalizzato del
 * cliente, es. blog.menuisland.it, con `products.blog_domain` a fare da
 * chiave di risoluzione.
 *
 * Nessuna sessione, nessuna sidebar: è la superficie che un visitatore
 * qualunque legge, non la dashboard. `notFound()` se il dominio non
 * corrisponde a nessun prodotto — capita solo per un Host inatteso o un
 * dominio non (più) configurato, mai in condizioni normali.
 */
export default async function BlogLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ hostname: string }>;
}) {
  const { hostname } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) notFound();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
          <Link href="/" className="text-base font-semibold tracking-tight text-foreground">
            {product.name}
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-xs text-foreground-subtle sm:px-6">
          © {new Date().getFullYear()} {product.name}
        </div>
      </footer>
    </div>
  );
}
