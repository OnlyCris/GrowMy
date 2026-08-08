'use client';

import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Contenitore delle pagine prodotto, con larghezza in base alla scheda.
 *
 * Le schede storiche (impostazioni, keyword, articoli, integrazione) sono
 * form e liste a colonna singola: `max-w-2xl` è la misura giusta, oltre la
 * quale una riga di testo diventa faticosa da seguire.
 *
 * Le analitiche no. Sono tabelle affiancate e una griglia di quattro riquadri:
 * dentro 672px si accavallano e la griglia collassa a due colonne anche su
 * schermi larghi. Usa la stessa larghezza della coda di revisione e della
 * lista prodotti (`max-w-[1600px]`), che sono le altre due viste dense
 * dell'applicazione.
 *
 * Client component perché la scelta dipende dal percorso, e il layout server
 * riceve solo `params` — stesso motivo per cui `ProductTabs` lo è già.
 */
export function ProductContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWide = pathname?.includes('/analytics') ?? false;

  return (
    <div
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6',
        isWide ? 'max-w-[1600px]' : 'max-w-2xl',
      )}
    >
      {children}
    </div>
  );
}
