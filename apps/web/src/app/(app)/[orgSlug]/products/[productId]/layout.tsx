import { ProductTabs } from './_components/product-tabs';

/**
 * Chrome condiviso dalle quattro pagine sotto `[productId]`
 * (impostazioni/keyword/articoli/integrazione). Nessuna query qui: solo
 * `params` per costruire gli `href` delle schede — ogni pagina resta
 * responsabile della propria guardia (`requireOrgMembership`) e dei propri
 * dati, stesso principio già seguito in `(app)/[orgSlug]/layout.tsx`.
 */
export default async function ProductLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; productId: string }>;
}) {
  const { orgSlug, productId } = await params;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <ProductTabs orgSlug={orgSlug} productId={productId} />
      <div className="pt-6">{children}</div>
    </div>
  );
}
