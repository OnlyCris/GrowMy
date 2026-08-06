'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createOrganizationAction } from '@/actions/onboarding.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createOrganizationAction({ name });
      if (result.ok) {
        router.push(`/${result.data.slug}/review`);
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-name">Nome dell&rsquo;organizzazione</Label>
        <Input
          id="org-name"
          name="name"
          autoComplete="organization"
          required
          placeholder="Es. Acme Inc."
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'org-name-error' : undefined}
        />
        <FormError id="org-name-error" messages={error} />
      </div>
      <Button type="submit" isLoading={isPending} loadingLabel="Creazione in corso" fullWidth>
        Crea organizzazione
      </Button>
    </form>
  );
}
