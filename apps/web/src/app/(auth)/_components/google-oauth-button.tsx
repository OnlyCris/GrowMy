'use client';

import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

import { GoogleIcon } from './google-icon';

/**
 * `signInWithOAuth` fa una navigazione `window.location` verso Google: deve
 * partire dal browser, non da una Server Action — è l'unico motivo per cui
 * questo componente (e il client Supabase che usa) esistono lato client.
 *
 * Il controllo "percorso relativo sicuro" è duplicato qui invece di importare
 * `isSafeRelativePath` da `@/lib/auth/guards`: quel modulo trascina `@growmy/db`
 * (Drizzle, `pg`, moduli Node) nel bundle del browser — esattamente il tipo di
 * import che `middleware.ts` evita per lo stesso motivo in edge runtime. Due
 * righe duplicate qui costano meno di quell'import.
 */
function isSafeRelativePath(path: string | null): path is string {
  return path !== null && path.startsWith('/') && !path.startsWith('//');
}

export function GoogleOAuthButton() {
  const searchParams = useSearchParams();
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleClick() {
    setIsPending(true);
    setError(null);

    const requested = searchParams.get('redirectTo');
    const safeRedirect = isSafeRelativePath(requested) ? requested : '/';

    const supabase = createSupabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(safeRedirect)}`,
      },
    });

    if (oauthError) {
      setError("Non siamo riusciti ad avviare l'accesso con Google. Riprova.");
      setIsPending(false);
    }
    // Su successo il browser naviga via da qui verso Google: nessun altro
    // stato locale da gestire, la pagina sta per essere sostituita.
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        fullWidth
        onClick={handleClick}
        isLoading={isPending}
        loadingLabel="Reindirizzamento a Google in corso"
      >
        <GoogleIcon className="size-4" />
        Continua con Google
      </Button>
      <FormError messages={error} />
    </div>
  );
}
