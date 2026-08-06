'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createProductAction } from '@/actions/products.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CreateProductForm({
  organizationId,
  orgSlug,
}: {
  organizationId: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [domain, setDomain] = React.useState('');
  const [websiteUrl, setWebsiteUrl] = React.useState('');
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await createProductAction({ organizationId, name, domain, websiteUrl });
      if (result.ok) {
        router.push(`/${orgSlug}/products/${result.data.id}/settings`);
      } else {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-name">Nome</Label>
        <Input
          id="product-name"
          autoComplete="off"
          required
          placeholder="Es. Blog Acme"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? 'product-name-error' : undefined}
        />
        <FormError id="product-name-error" messages={fieldErrors.name} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-domain">Dominio</Label>
        <Input
          id="product-domain"
          autoComplete="off"
          required
          placeholder="acme.com"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          aria-invalid={fieldErrors.domain ? true : undefined}
          aria-describedby={fieldErrors.domain ? 'product-domain-error' : undefined}
        />
        <FormError id="product-domain-error" messages={fieldErrors.domain} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="product-url">URL del sito</Label>
        <Input
          id="product-url"
          type="url"
          autoComplete="off"
          required
          placeholder="https://acme.com"
          value={websiteUrl}
          onChange={(event) => setWebsiteUrl(event.target.value)}
          aria-invalid={fieldErrors.websiteUrl ? true : undefined}
          aria-describedby={fieldErrors.websiteUrl ? 'product-url-error' : undefined}
        />
        <FormError id="product-url-error" messages={fieldErrors.websiteUrl} />
      </div>

      <FormError messages={error} />

      <Button type="submit" isLoading={isPending} loadingLabel="Creazione in corso" fullWidth>
        Crea prodotto
      </Button>
    </form>
  );
}
