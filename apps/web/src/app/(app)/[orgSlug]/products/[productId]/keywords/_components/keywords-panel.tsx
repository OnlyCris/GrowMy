'use client';

import { assessCommercialValue } from '@growmy/core';
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
  searchVolume: number | null;
  rationale: string | null;
  /** 0-100. STIMA da intento e formulazione, non conversioni misurate. */
  commercialScore: number;
  stage: 'decision' | 'consideration' | 'awareness';
}

/**
 * Etichette dello stadio del funnel.
 *
 * Il colore segue la vicinanza all'acquisto, non un giudizio di qualità: una
 * keyword "informativa" non è una keyword scadente — serve a farsi trovare
 * prima che il bisogno diventi acquisto. Per questo `awareness` è neutro e non
 * rosso: rosso significherebbe "errore", e non lo è.
 */
const STAGE_META: Record<
  KeywordRow['stage'],
  { label: string; title: string; className: string }
> = {
  decision: {
    label: 'Decisione',
    title: 'Chi cerca sta valutando un acquisto concreto',
    className: 'bg-success-100 text-success-700',
  },
  consideration: {
    label: 'Valutazione',
    title: 'Chi cerca sta confrontando opzioni',
    className: 'bg-accent-100 text-accent-900',
  },
  awareness: {
    label: 'Informativa',
    title: 'Chi cerca si sta informando: la conversione è lontana',
    className: 'bg-surface-muted text-foreground-muted',
  },
};

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
        // `assessCommercialValue` è una funzione pura senza I/O: gira anche qui
        // nel browser, così una keyword aggiunta a mano mostra subito il suo
        // stadio del funnel invece di restare neutra fino al primo ricaricamento.
        const commercial = assessCommercialValue({ term: result.data.term });

        setKeywords((current) => [
          {
            id: result.data.id,
            term: result.data.term,
            status: 'approved',
            priorityScore: '50',
            clusterId: null,
            clusterName: null,
            isPillar: false,
            searchVolume: null,
            rationale: null,
            commercialScore: commercial.score,
            stage: commercial.stage,
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
                <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-foreground">{keyword.term}</span>
                      {keyword.isPillar ? (
                        <span className="rounded-[var(--radius-sm)] border border-border-strong bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
                          Pillar
                        </span>
                      ) : null}
                      <KeywordStatusBadge status={keyword.status} />
                      <span
                        title={STAGE_META[keyword.stage].title}
                        className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] font-medium ${STAGE_META[keyword.stage].className}`}
                      >
                        {STAGE_META[keyword.stage].label}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-foreground-muted">
                      <span title="Stima da intento e formulazione, non da conversioni misurate">
                        Potenziale {Math.round(keyword.commercialScore)}/100
                      </span>
                      {keyword.searchVolume != null ? (
                        <span>{keyword.searchVolume.toLocaleString('it-IT')} ricerche/mese stimate</span>
                      ) : null}
                    </div>

                    {keyword.rationale ? (
                      <p className="text-xs leading-relaxed text-foreground-muted">
                        {keyword.rationale}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
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
