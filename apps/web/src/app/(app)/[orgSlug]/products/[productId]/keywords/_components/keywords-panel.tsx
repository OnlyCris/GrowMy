'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { addKeywordAction, generateArticleFromKeywordAction } from '@/actions/keywords.actions';
import { KeywordStatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface KeywordRow {
  id: string;
  term: string;
  status: 'suggested' | 'approved' | 'scheduled' | 'processing' | 'done' | 'rejected';
  priorityScore: string;
}

export function KeywordsPanel({
  productId,
  orgSlug,
  initialKeywords,
}: {
  productId: string;
  orgSlug: string;
  initialKeywords: KeywordRow[];
}) {
  const router = useRouter();
  const [keywords, setKeywords] = React.useState(initialKeywords);
  const [term, setTerm] = React.useState('');
  const [isAdding, startAdding] = React.useTransition();
  const [addError, setAddError] = React.useState<string | null>(null);
  const [generatingId, setGeneratingId] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);

  function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError(null);
    startAdding(async () => {
      const result = await addKeywordAction({ productId, term });
      if (result.ok) {
        setKeywords((current) => [
          { id: result.data.id, term: result.data.term, status: 'approved', priorityScore: '50' },
          ...current,
        ]);
        setTerm('');
      } else {
        setAddError(result.message);
      }
    });
  }

  function handleGenerate(keywordId: string) {
    setGenerateError(null);
    setGeneratingId(keywordId);
    React.startTransition(async () => {
      const result = await generateArticleFromKeywordAction({ keywordId });
      setGeneratingId(null);
      if (result.ok) {
        router.push(`/${orgSlug}/products/${productId}/articles/${result.data.articleId}`);
      } else {
        setGenerateError(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleAdd} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="keyword-term">Nuova keyword</Label>
          <Input
            id="keyword-term"
            required
            placeholder="es. migliori scarpe da trekking"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>
        <Button type="submit" isLoading={isAdding} loadingLabel="Aggiunta in corso">
          Aggiungi
        </Button>
      </form>
      <FormError messages={addError} />
      <FormError messages={generateError} />

      {keywords.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nessuna keyword ancora. Aggiungine una per generare il primo articolo.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
          {keywords.map((keyword) => {
            const canGenerate = keyword.status !== 'processing' && keyword.status !== 'done';
            return (
              <li
                key={keyword.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-foreground">{keyword.term}</span>
                  <KeywordStatusBadge status={keyword.status} />
                </div>
                {canGenerate ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    isLoading={generatingId === keyword.id}
                    loadingLabel="Avvio in corso"
                    onClick={() => handleGenerate(keyword.id)}
                  >
                    Genera articolo
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
