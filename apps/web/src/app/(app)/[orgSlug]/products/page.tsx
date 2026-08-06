import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProductStatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getProductsForOrg } from '@/lib/queries/products';
import { formatRelativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prodotti',
  robots: { index: false, follow: false },
};

interface ProductsPageProps {
  params: Promise<{ orgSlug: string }>;
}

export default async function ProductsPage({ params }: ProductsPageProps) {
  const { orgSlug } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const items = await withUserContext(membership.userId, () =>
    getProductsForOrg(membership.organizationId),
  );

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Prodotti
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground-muted">
            I siti gestiti dalla pipeline. Ogni prodotto ha il proprio calendario
            editoriale e le proprie regole di approvazione.
          </p>
        </div>
        <Button asChild>
          <Link href={`/${orgSlug}/products/new`}>Aggiungi sito</Link>
        </Button>
      </header>

      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-sm text-foreground-muted">
            Non hai ancora nessun sito collegato. Aggiungine uno per iniziare —
            la coda di revisione resta vuota finché non lo fai.
          </p>
          <Button asChild>
            <Link href={`/${orgSlug}/products/new`}>Aggiungi il primo sito</Link>
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((product) => (
            <Link key={product.id} href={`/${orgSlug}/products/${product.id}/settings`}>
              <Card className="flex flex-col gap-3 p-5 transition-shadow duration-150 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      {product.name}
                    </h2>
                    <p className="text-xs text-foreground-muted">{product.domain}</p>
                  </div>
                  <ProductStatusBadge status={product.status} />
                </div>
                <p className="text-xs text-foreground-subtle">
                  Aggiornato {formatRelativeTime(product.updatedAt)}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
