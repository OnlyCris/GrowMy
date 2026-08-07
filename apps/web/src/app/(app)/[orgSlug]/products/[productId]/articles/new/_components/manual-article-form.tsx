'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { createManualArticleAction } from '@/actions/articles.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function ManualArticleForm({
  orgSlug,
  productId,
}: {
  orgSlug: string;
  productId: string;
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState('');
  const [targetKeyword, setTargetKeyword] = React.useState('');
  const [metaDescription, setMetaDescription] = React.useState('');
  const [excerpt, setExcerpt] = React.useState('');
  const [contentMarkdown, setContentMarkdown] = React.useState('');

  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await createManualArticleAction({
        productId,
        title,
        targetKeyword,
        metaDescription,
        excerpt: excerpt || undefined,
        contentMarkdown,
      });

      if (result.ok) {
        router.push(`/${orgSlug}/review`);
      } else {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-title">Titolo</Label>
        <Input
          id="manual-title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={fieldErrors.title ? true : undefined}
        />
        <FormError messages={fieldErrors.title} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-keyword">Parola chiave di riferimento</Label>
          <Input
            id="manual-keyword"
            placeholder="es. menu digitale ristorante"
            value={targetKeyword}
            onChange={(event) => setTargetKeyword(event.target.value)}
          />
          <p className="text-xs text-foreground-muted">
            Usata solo per calcolare il quality score — non crea una keyword pianificata.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-excerpt">Sommario (opzionale)</Label>
          <Input
            id="manual-excerpt"
            value={excerpt}
            onChange={(event) => setExcerpt(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-meta">Meta description</Label>
        <Input
          id="manual-meta"
          required
          maxLength={160}
          value={metaDescription}
          onChange={(event) => setMetaDescription(event.target.value)}
          aria-invalid={fieldErrors.metaDescription ? true : undefined}
        />
        <p className="text-xs text-foreground-muted">{metaDescription.length}/160 caratteri</p>
        <FormError messages={fieldErrors.metaDescription} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="manual-content">Contenuto (Markdown)</Label>
        <Textarea
          id="manual-content"
          required
          rows={20}
          className="font-mono text-xs"
          placeholder={'## Un H2 per sezione\n\nTesto del paragrafo...\n\n[link interno](/altro-slug-esistente)'}
          value={contentMarkdown}
          onChange={(event) => setContentMarkdown(event.target.value)}
          aria-invalid={fieldErrors.contentMarkdown ? true : undefined}
        />
        <FormError messages={fieldErrors.contentMarkdown} />
      </div>

      <FormError messages={error} />

      <div>
        <Button type="submit" isLoading={isPending} loadingLabel="Salvataggio in corso">
          Crea bozza
        </Button>
      </div>
    </form>
  );
}
