'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  addKeywordAction,
  generateArticleFromKeywordAction,
  generateKeywordsAction,
  reviewKeywordAction,
} from '@/actions/keywords.actions';
import { AutoRefresh } from '@/components/shared/auto-refresh';
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
  clusterId: string | null;
  clusterName: string | null;
  isPillar: boolean;
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
  const [isResearching, startResearching] = React.useTransition();
  const [researchError, setResearchError] = React.useState<string | null>(null);
  const [researchStarted, setResearchStarted] = React.useState(false);
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [reviewError, setReviewError] = React.useState<string | null>(null);
  const countBeforeResearchRef = React.useRef(initialKeywords.length);

  // Il server resta la fonte di verità: se `router.refresh()` porta dati
  // nuovi (vedi <AutoRefresh> sotto), li riflettiamo qui invece di restare
  // fermi sull'istantanea del primo render — stesso pattern di ReviewQueue.
  React.useEffect(() => {
    setKeywords(initialKeywords);
    if (researchStarted && initialKeywords.length > countBeforeResearchRef.current) {
      setResearchStarted(false);
    }
  }, [initialKeywords, researchStarted]);

  function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError(null);
    startAdding(async () => {
      const result = await addKeywordAction({ productId, term });
      if (result.ok) {
        setKeywords((current) => [
          {
            id: result.data.id,
            term: result.data.term,
            status: 'approved',
            priorityScore: '50',
            clusterId: null,
            clusterName: null,
            isPillar: false,
          },
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

  function handleResearch() {
    setResearchError(null);
    countBeforeResearchRef.current = initialKeywords.length;
    startResearching(async () => {
      const result = await generateKeywordsAction({ productId });
      if (result.ok) {
        setResearchStarted(true);
      } else {
        setResearchError(result.message);
      }
    });
  }

  function handleReview(keywordId: string, decision: 'approve' | 'reject') {
    setReviewError(null);
    setReviewingId(keywordId);
    React.startTransition(async () => {
      const result = await reviewKeywordAction({ keywordId, decision });
      setReviewingId(null);
      if (result.ok) {
        setKeywords((current) =>
          current.map((keyword) =>
            keyword.id === keywordId ? { ...keyword, status: result.data.status } : keyword,
          ),
        );
      } else {
        setReviewError(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-muted px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Ricerca keyword con AI</span>
          <span className="text-xs text-foreground-muted">
            Propone keyword pertinenti al prodotto, non termini generici ad alto volume — le
            revisioni tu prima che diventino articoli.
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          isLoading={isResearching}
          loadingLabel="Avvio in corso"
          onClick={handleResearch}
        >
          Genera keyword
        </Button>
      </div>
      <AutoRefresh enabled={researchStarted} />
      {researchStarted ? (
        <p className="text-sm text-foreground-muted">
          Ricerca avviata. Le nuove proposte compariranno qui sotto in automatico,
          appena pronte.
        </p>
      ) : null}
      <FormError messages={researchError} />

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
      <FormError messages={reviewError} />

      {keywords.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nessuna keyword ancora. Aggiungine una o genera proposte con l’AI.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
          {keywords.map((keyword, index) => {
            const isSuggested = keyword.status === 'suggested';
            const canGenerate = keyword.status === 'approved' || keyword.status === 'scheduled';
            // Il gruppo cambia quando cambia il cluster: la query ordina già
            // per clusterId, qui basta rilevare il confine per intestare la
            // sezione — è quello che rende visibile la struttura a cluster
            // invece di una lista piatta indistinguibile.
            const previous = keywords[index - 1];
            const isNewGroup = !previous || previous.clusterId !== keyword.clusterId;
            return (
              <React.Fragment key={keyword.id}>
                {isNewGroup && keyword.clusterName ? (
                  <li className="bg-surface-muted px-4 py-1.5 text-xs font-medium text-foreground-muted">
                    {keyword.clusterName}
                  </li>
                ) : null}
                {isNewGroup && !keyword.clusterName && index > 0 ? (
                  <li className="bg-surface-muted px-4 py-1.5 text-xs font-medium text-foreground-muted">
                    Senza cluster
                  </li>
                ) : null}
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-foreground">{keyword.term}</span>
                    {keyword.isPillar ? (
                      <span className="rounded-[var(--radius-sm)] border border-border-strong bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
                        Pillar
                      </span>
                    ) : null}
                    <KeywordStatusBadge status={keyword.status} />
                  </div>
                  <div className="flex items-center gap-2">
                  {isSuggested ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        isLoading={reviewingId === keyword.id}
                        loadingLabel="…"
                        onClick={() => handleReview(keyword.id, 'reject')}
                      >
                        Scarta
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        isLoading={reviewingId === keyword.id}
                        loadingLabel="…"
                        onClick={() => handleReview(keyword.id, 'approve')}
                      >
                        Approva
                      </Button>
                    </>
                  ) : null}
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
                  </div>
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
