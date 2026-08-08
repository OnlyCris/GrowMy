'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export function ProductTabs({
  orgSlug,
  productId,
}: {
  orgSlug: string;
  productId: string;
}) {
  const pathname = usePathname();
  const base = `/${orgSlug}/products/${productId}`;

  const tabs = [
    { href: `${base}/settings`, label: 'Impostazioni' },
    { href: `${base}/keywords`, label: 'Keyword' },
    { href: `${base}/articles`, label: 'Articoli' },
    { href: `${base}/analytics`, label: 'Analitiche' },
    { href: `${base}/integration`, label: 'Integrazione' },
  ];

  return (
    <nav
      className="flex gap-1 overflow-x-auto border-b border-border"
      aria-label="Sezioni prodotto"
    >
      {tabs.map((tab) => {
        // `startsWith`: la scheda "Articoli" resta attiva anche sul
        // dettaglio di un singolo articolo (`/articles/[articleId]`).
        const active = pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150',
              active
                ? 'border-base-900 text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
