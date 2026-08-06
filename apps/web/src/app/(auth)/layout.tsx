import Link from 'next/link';

/**
 * Chrome dell'area di autenticazione: nessuna nav applicativa (il layout
 * radice non ne renderizza già una — vedi `app/layout.tsx`), solo una card
 * centrata e un link al wordmark per tornare alla landing.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Link
        href="/"
        className="text-base font-semibold tracking-tight text-foreground"
      >
        GrowMy
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
