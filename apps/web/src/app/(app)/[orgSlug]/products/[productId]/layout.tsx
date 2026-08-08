import { ProductContainer } from './_components/product-container';
import { ProductTabs } from './_components/product-tabs';

/**
 * Chrome condiviso dalle pagine sotto `[productId]`
 * (impostazioni/keyword/articoli/analitiche/integrazione). Nessuna query qui: solo
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
    <ProductContainer>
      <ProductTabs orgSlug={orgSlug} productId={productId} />
      <div className="pt-6">{children}</div>
    </ProductContainer>
  );
}
