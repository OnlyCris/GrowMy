'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CheckCheck, Clock, Inbox, Keyboard } from 'lucide-react';
import * as React from 'react';

import { StatusBadge } from '@/components/shared/status-badge';
import { cn, formatRelativeTime, truncateWords } from '@/lib/utils';
import type { ActionResult, ArticleBrief, ReviewQueueItem } from '@/types/review';

import { BriefEditor } from './brief-editor';
import { DraftReviewer } from './draft-reviewer';

/**
 * REVIEW QUEUE — contenitore dell'UPGRADE #1
 *
 * Layout master/detail: la coda a sinistra, l'elemento selezionato a destra.
 *
 * La scelta progettuale che conta: chi revisiona 30 articoli al mese non deve
 * toccare il mouse. `J`/`K` navigano, `A` approva, `R` rifiuta, `?` mostra le
 * scorciatoie. Dopo un'approvazione la selezione avanza automaticamente
 * all'elemento successivo, così la coda si svuota in un flusso continuo.
 *
 * Gli aggiornamenti sono ottimistici: l'elemento esce dalla lista subito, e
 * rientra con un messaggio d'errore solo se il server rifiuta.
 */

/**
 * Le Server Actions accettano SEMPRE un singolo oggetto, mai argomenti
 * posizionali. Non è una preferenza stilistica: `createSafeAction` valida
 * l'input con uno schema Zod `.strict()`, e uno schema valida un oggetto.
 * Le firme qui sotto rispecchiano quel contratto esattamente, così un
 * disallineamento diventa un errore di compilazione invece di un errore
 * di validazione scoperto a runtime dall'utente.
 */
type ReviewAction<TInput> = (
  input: TInput,
) => Promise<ActionResult<{ articleId: string }>>;

export interface ReviewQueueProps {
  items: ReviewQueueItem[];
  saveBriefAction: ReviewAction<{ articleId: string; brief: ArticleBrief }>;
  approveBriefAction: ReviewAction<{ articleId: string; brief: ArticleBrief }>;
  rejectBriefAction: ReviewAction<{ articleId: string; feedback: string }>;
  approveDraftAction: ReviewAction<{ articleId: string }>;
  rejectDraftAction: ReviewAction<{ articleId: string; feedback: string }>;
  rewriteSectionAction: ReviewAction<{
    articleId: string;
    sectionHeading: string;
    instruction: string;
  }>;
  /** Markdown della versione precedente, indicizzato per articleId. */
  previousVersions: Record<string, string | null>;
}

export function ReviewQueue({
  items: initialItems,
  approveBriefAction,
  saveBriefAction,
  rejectBriefAction,
  approveDraftAction,
  rejectDraftAction,
  rewriteSectionAction,
  previousVersions,
}: ReviewQueueProps) {
  const shouldReduceMotion = useReducedMotion();

  const [items, setItems] = React.useState(initialItems);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialItems[0]?.articleId ?? null,
  );
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = React.useState(false);
  /** Annuncio per screen reader sui cambi di stato asincroni. */
  const [liveMessage, setLiveMessage] = React.useState('');

  const listRef = React.useRef<HTMLUListElement>(null);

  // Il server è la fonte di verità: se rivalida, riallineiamo.
  React.useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  const selectedIndex = items.findIndex((i) => i.articleId === selectedId);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

  /** Sposta la selezione all'elemento successivo, o al precedente se era l'ultimo. */
  const selectNeighbour = React.useCallback(
    (removedIndex: number, remaining: ReviewQueueItem[]) => {
      if (remaining.length === 0) {
        setSelectedId(null);
        return;
      }
      const nextIndex = Math.min(removedIndex, remaining.length - 1);
      setSelectedId(remaining[nextIndex].articleId);
    },
    [],
  );

  /**
   * Esegue un'azione con aggiornamento ottimistico.
   * L'elemento sparisce subito dalla coda; se il server rifiuta, viene
   * reinserito nella posizione originale con il messaggio d'errore.
   */
  const runOptimistic = React.useCallback(
    async (
      articleId: string,
      successMessage: string,
      action: () => Promise<ActionResult<{ articleId: string }>>,
    ) => {
      setErrorMessage(null);

      const index = items.findIndex((i) => i.articleId === articleId);
      if (index < 0) return;
      const snapshot = items[index];
      const remaining = items.filter((i) => i.articleId !== articleId);

      setItems(remaining);
      selectNeighbour(index, remaining);
      setLiveMessage(successMessage);

      const result = await action();

      if (!result.ok) {
        // Ripristino nella posizione originale.
        setItems((current) => {
          const restored = [...current];
          restored.splice(index, 0, snapshot);
          return restored;
        });
        setSelectedId(articleId);
        setErrorMessage(result.message);
        setLiveMessage(`Operazione non riuscita: ${result.message}`);
      }
    },
    [items, selectNeighbour],
  );

  // --- Scorciatoie da tastiera -------------------------------------------
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Mai intercettare mentre l'utente sta scrivendo.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case 'j': {
          event.preventDefault();
          const next = Math.min(selectedIndex + 1, items.length - 1);
          if (next >= 0 && items[next]) setSelectedId(items[next].articleId);
          break;
        }
        case 'k': {
          event.preventDefault();
          const prev = Math.max(selectedIndex - 1, 0);
          if (items[prev]) setSelectedId(items[prev].articleId);
          break;
        }
        case 'a': {
          if (!selected) return;
          event.preventDefault();
          if (selected.status === 'brief_ready' && selected.brief) {
            const brief = selected.brief;
            void runOptimistic(selected.articleId, 'Brief approvato', () =>
              approveBriefAction({ articleId: selected.articleId, brief }),
            );
          } else if (selected.status === 'draft_ready') {
            void runOptimistic(selected.articleId, 'Bozza approvata', () =>
              approveDraftAction({ articleId: selected.articleId }),
            );
          }
          break;
        }
        case '?': {
          event.preventDefault();
          setShowShortcuts((v) => !v);
          break;
        }
        case 'escape': {
          setShowShortcuts(false);
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    items,
    selected,
    selectedIndex,
    runOptimistic,
    approveBriefAction,
    approveDraftAction,
  ]);

  // Mantiene visibile l'elemento selezionato durante la navigazione da tastiera.
  React.useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const element = listRef.current.querySelector<HTMLElement>(
      `[data-article-id="${selectedId}"]`,
    );
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  // --- Coda vuota ---------------------------------------------------------
  if (items.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <span className="mb-4 rounded-full bg-success-100 p-3">
          <CheckCheck className="size-6 text-success-700" aria-hidden="true" />
        </span>
        <h2 className="text-lg font-semibold text-foreground">
          Niente da revisionare
        </h2>
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-foreground-muted">
          La pipeline sta lavorando. Ti avvisiamo quando un brief o una bozza
          richiedono la tua decisione — o lasci che l’autopilota proceda da solo.
        </p>
        <p
          aria-live="polite"
          className="sr-only"
        >
          {liveMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* --- Colonna coda ------------------------------------------------ */}
      <div className="flex w-full max-w-sm shrink-0 flex-col rounded-[var(--radius-lg)] border border-border bg-surface md:w-80 lg:w-96">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Inbox className="size-4" aria-hidden="true" />
            In attesa di te
            <span
              className="rounded-full bg-accent-100 px-2 py-0.5 text-2xs font-semibold tabular text-accent-900"
              data-metric
            >
              {items.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={() => setShowShortcuts((v) => !v)}
            aria-label="Mostra le scorciatoie da tastiera"
            aria-expanded={showShortcuts}
            className="rounded p-1 text-foreground-subtle hover:bg-surface-muted hover:text-foreground"
          >
            <Keyboard className="size-4" aria-hidden="true" />
          </button>
        </header>

        <AnimatePresence>
          {showShortcuts ? (
            <motion.div
              initial={shouldReduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, height: 0 }}
              className="overflow-hidden border-b border-border bg-surface-muted"
            >
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 text-2xs">
                {[
                  ['J', 'Elemento successivo'],
                  ['K', 'Elemento precedente'],
                  ['A', 'Approva'],
                  ['?', 'Mostra/nascondi'],
                ].map(([key, label]) => (
                  <div key={key} className="flex items-center gap-2">
                    <dt>
                      <kbd className="rounded border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-2xs font-semibold">
                        {key}
                      </kbd>
                    </dt>
                    <dd className="text-foreground-muted">{label}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <ul ref={listRef} className="flex-1 overflow-y-auto p-2" role="list">
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((item, index) => {
              const isSelected = item.articleId === selectedId;
              const isUrgent =
                item.hoursUntilAutoApproval !== null &&
                item.hoursUntilAutoApproval < 6;

              return (
                <motion.li
                  key={item.articleId}
                  layout={!shouldReduceMotion}
                  data-article-id={item.articleId}
                  initial={
                    shouldReduceMotion ? false : { opacity: 0, y: 8 }
                  }
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    shouldReduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, x: -12, transition: { duration: 0.15 } }
                  }
                  transition={{
                    duration: 0.25,
                    delay: shouldReduceMotion ? 0 : Math.min(index * 0.04, 0.3),
                    ease: [0.25, 1, 0.5, 1],
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.articleId)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn(
                      'mb-1 w-full rounded-[var(--radius-md)] border p-3 text-left transition-colors',
                      isSelected
                        ? 'border-accent-300 bg-accent-50 shadow-[var(--shadow-accent)]'
                        : 'border-transparent hover:bg-surface-muted',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <StatusBadge status={item.status} size="sm" />
                      {isUrgent ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-semibold text-accent-900">
                          <Clock className="size-3" aria-hidden="true" />
                          {Math.round(item.hoursUntilAutoApproval!)}h
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-1.5 text-sm font-medium leading-snug text-foreground">
                      {item.title
                        ? truncateWords(item.title, 72)
                        : `Brief per «${item.targetKeyword}»`}
                    </p>

                    <div className="mt-1.5 flex items-center gap-2 text-2xs text-foreground-subtle">
                      <span className="truncate">{item.productName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">
                        {formatRelativeTime(item.waitingSince)}
                      </span>
                    </div>
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>

        {/* Nota sull'auto-approvazione: rende esplicito che la coda ha una
            scadenza, invece di lasciarlo scoprire quando è già scattata. */}
        <footer className="border-t border-border px-4 py-2.5">
          <p className="text-2xs leading-relaxed text-foreground-subtle">
            Gli articoli non revisionati entro la finestra configurata proseguono
            automaticamente: l’autopilota non si ferma se sei via.
          </p>
        </footer>
      </div>

      {/* --- Colonna dettaglio ------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col rounded-[var(--radius-lg)] border border-border bg-surface p-4">
        {errorMessage ? (
          <div
            role="alert"
            className="mb-3 rounded-[var(--radius-md)] border border-danger-500/30 bg-danger-100 px-3 py-2 text-xs text-danger-700"
          >
            {errorMessage}
          </div>
        ) : null}

        {selected === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-foreground-subtle">
            Seleziona un elemento dalla coda.
          </div>
        ) : selected.status === 'brief_ready' && selected.brief ? (
          <BriefEditor
            key={selected.articleId}
            articleId={selected.articleId}
            brief={selected.brief}
            regenerationCost={selected.regenerationCost}
            onSave={async (articleId, brief) => {
              const result = await saveBriefAction({ articleId, brief });
              if (!result.ok) setErrorMessage(result.message);
              else setLiveMessage('Brief salvato');
            }}
            onApprove={async (articleId, brief) => {
              await runOptimistic(articleId, 'Brief approvato', () =>
                approveBriefAction({ articleId, brief }),
              );
            }}
            onReject={async (articleId, feedback) => {
              await runOptimistic(
                articleId,
                'Brief rifiutato, outline in rigenerazione',
                () => rejectBriefAction({ articleId, feedback }),
              );
            }}
          />
        ) : selected.status === 'draft_ready' && selected.draft ? (
          <DraftReviewer
            key={selected.articleId}
            articleId={selected.articleId}
            draft={selected.draft}
            qualityScore={selected.qualityScore}
            previousMarkdown={previousVersions[selected.articleId] ?? null}
            onApprove={async (articleId) => {
              await runOptimistic(articleId, 'Bozza approvata', () =>
                approveDraftAction({ articleId }),
              );
            }}
            onReject={async (articleId, feedback) => {
              await runOptimistic(
                articleId,
                'Bozza rifiutata, articolo in rigenerazione',
                () => rejectDraftAction({ articleId, feedback }),
              );
            }}
            onRewriteSection={async (articleId, heading, instruction) => {
              const result = await rewriteSectionAction({
                articleId,
                sectionHeading: heading,
                instruction,
              });
              if (!result.ok) setErrorMessage(result.message);
              else setLiveMessage(`Sezione «${heading}» in riscrittura`);
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-foreground-subtle">
            Questo elemento non è più in attesa di revisione.
          </div>
        )}
      </div>

      {/* Live region: annuncia i cambi di stato a chi usa uno screen reader
          senza spostare il focus. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </p>
    </div>
  );
}
