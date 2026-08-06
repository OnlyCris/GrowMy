'use client';

import { Mail } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ActionResult } from '@/types/review';

interface MagicLinkFormProps {
  action: (input: {
    email: string;
    redirectTo?: string;
  }) => Promise<ActionResult<{ email: string }>>;
  submitLabel: string;
}

/**
 * Form condiviso da `/signin` e `/signup`: entrambi chiedono solo un'email e
 * inviano un magic link — cambiano solo l'azione passata (`shouldCreateUser`
 * diverso, vedi `auth.impl.ts`) e il testo del bottone.
 *
 * `redirectTo` arriva dalla query string (`requireSession` in `guards.ts` ce
 * la mette quando rimanda qui un utente non autenticato) e viaggia col form:
 * la validazione di sicurezza vera (deve restare un percorso relativo) accade
 * comunque server-side in `sendMagicLink`, questo è solo il trasporto.
 */
export function MagicLinkForm({ action, submitLabel }: MagicLinkFormProps) {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirectTo') ?? undefined;

  const [email, setEmail] = React.useState('');
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await action({ email, redirectTo });
      if (result.ok) {
        setSentTo(result.data.email);
      } else {
        setError(result.message);
      }
    });
  }

  if (sentTo) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 py-2 text-center">
        <Mail className="size-8 text-foreground-muted" aria-hidden="true" />
        <p className="text-sm text-foreground">
          Ti abbiamo inviato un link di accesso a <strong>{sentTo}</strong>.
        </p>
        <p className="text-xs text-foreground-muted">
          Controlla anche lo spam. Se non arriva in qualche minuto, riprova.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'email-error' : undefined}
        />
        <FormError id="email-error" messages={error} />
      </div>
      <Button type="submit" isLoading={isPending} loadingLabel="Invio in corso" fullWidth>
        {submitLabel}
      </Button>
    </form>
  );
}
