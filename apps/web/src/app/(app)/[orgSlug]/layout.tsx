import Link from 'next/link';
import { notFound } from 'next/navigation';

import { signOutAction } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { requireOrgMembership } from '@/lib/auth/guards';

/**
 * Chrome dell'area autenticata: nome organizzazione + uscita. Prima di questo
 * file non esisteva NESSUN modo, nell'interfaccia, di terminare una sessione
 * — `signOutAction` esisteva ma non aveva un bottone da cui partire.
 *
 * Il guard vive qui, non solo in `review/page.tsx`: questo layout avvolge
 * OGNI rotta futura sotto `[orgSlug]`, quindi è il posto giusto perché la
 * protezione valga per tutte, non solo per quella scritta oggi.
 * `requireOrgMembership` è `cache()`-deduplicata per richiesta: il fatto che
 * anche `review/page.tsx` la richiami non produce una seconda query.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  // 404 e non 403: non confermiamo l'esistenza di quello slug a un estraneo.
  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Link
              href={`/${membership.organizationSlug}/review`}
              className="text-sm font-semibold tracking-tight text-foreground"
            >
              {membership.organizationName}
            </Link>

            <nav className="flex items-center gap-4" aria-label="Sezioni">
              <Link
                href={`/${membership.organizationSlug}/review`}
                className="text-sm text-foreground-muted hover:text-foreground"
              >
                Revisione
              </Link>
              <Link
                href={`/${membership.organizationSlug}/products`}
                className="text-sm text-foreground-muted hover:text-foreground"
              >
                Prodotti
              </Link>
            </nav>
          </div>

          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Esci
            </Button>
          </form>
        </div>
      </header>

      <div className="flex-1">{children}</div>
    </div>
  );
}
