import type { Metadata, Viewport } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';

import './globals.css';

/**
 * Layout radice.
 *
 * I font sono caricati con `next/font`: vengono self-hostati in fase di build,
 * quindi nessuna richiesta a fonts.googleapis.com a runtime. Due vantaggi:
 * niente terza parte nella CSP e nessun layout shift, perché il font è già
 * presente al primo paint.
 */

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/**
 * Serif riservato al CORPO degli articoli nell'editor di revisione.
 * Vedi docs/DESIGN.md: segnala «qui stai leggendo, non stai amministrando».
 */
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  title: {
    default: 'GrowMy — traffico organico in autopilota',
    template: '%s · GrowMy',
  },
  description:
    'Ricerca keyword, stesura e pubblicazione automatiche. Con il controllo umano dove serve davvero.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  ),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // I colori del tema corrispondono a --color-background nei due schemi.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1917' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="it"
      className={`${inter.variable} ${sourceSerif.variable}`}
      // `suppressHydrationWarning` serve solo per l'attributo `class` che uno
      // script di tema potrebbe aggiungere prima dell'idratazione.
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {/* Skip link: primo elemento focusabile della pagina, invisibile finché
            non riceve il focus da tastiera. Consente di saltare la navigazione. */}
        <a
          href="#contenuto"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-md)] focus:bg-base-900 focus:px-4 focus:py-2 focus:text-sm focus:text-base-50"
        >
          Vai al contenuto
        </a>

        <div id="contenuto">{children}</div>
      </body>
    </html>
  );
}
