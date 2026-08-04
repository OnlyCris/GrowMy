'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Check,
  Columns2,
  Eye,
  FileText,
  Hash,
  Sparkles,
  Type,
  X,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ArticleDraft, QualityScore } from '@/types/review';

import { QualityScorePanel } from './quality-score-panel';

/**
 * DRAFT REVIEWER — seconda metà dell'UPGRADE #1
 *
 * Tre modalità di lettura, perché revisionare un articolo di 1.500 parole
 * richiede cose diverse in momenti diversi:
 *
 *   `read`     — solo prosa, in serif, larghezza 68ch. Per giudicare se suona bene.
 *   `outline`  — solo gli H2/H3. Per verificare la struttura in dieci secondi.
 *   `diff`     — confronto con la versione precedente. Per capire cosa è cambiato
 *                dopo un rewrite, senza rileggere tutto da capo.
 *
 * Il rewrite mirato per sezione è ciò che evita il ciclo distruttivo
 * "non mi piace un paragrafo -> rigenero l'articolo intero -> perdo il resto".
 */

type ViewMode = 'read' | 'outline' | 'diff';

/** Blocco di contenuto derivato dal Markdown per la navigazione e il rewrite. */
interface ParsedBlock {
  id: string;
  level: 2 | 3;
  heading: string;
  /** Markdown grezzo della sezione, titolo incluso. */
  raw: string;
  wordCount: number;
}

/**
 * Estrae i blocchi H2/H3 dal Markdown.
 *
 * Volutamente un parser minimale su riga: non ci serve un AST completo, ci
 * servono i confini delle sezioni. Ignora gli heading dentro i blocchi di
 * codice, che altrimenti produrrebbero sezioni fantasma.
 */
function parseBlocks(markdown: string): ParsedBlock[] {
  const lines = markdown.split('\n');
  const blocks: ParsedBlock[] = [];
  let current: { level: 2 | 3; heading: string; lines: string[] } | null = null;
  let insideFence = false;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join('\n').trim();
    blocks.push({
      id: `block-${blocks.length}`,
      level: current.level,
      heading: current.heading,
      raw,
      wordCount: raw.split(/\s+/).filter(Boolean).length,
    });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) insideFence = !insideFence;

    const match = insideFence ? null : /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      current = {
        level: match[1].length === 2 ? 2 : 3,
        heading: match[2].trim(),
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Diff a livello di parola fra due testi.
 *
 * Implementazione LCS su token: sufficiente per bozze di 1.500-2.000 parole e
 * senza dipendenze aggiuntive nel bundle client. Per documenti molto più lunghi
 * il calcolo andrebbe spostato in un web worker.
 */
type DiffToken = { value: string; kind: 'equal' | 'added' | 'removed' };

function diffWords(before: string, after: string): DiffToken[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);

  // Matrice LCS. Dimensioni contenute: ~4.000 x 4.000 nel caso peggiore.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      tokens.push({ value: a[i], kind: 'equal' });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      tokens.push({ value: a[i], kind: 'removed' });
      i++;
    } else {
      tokens.push({ value: b[j], kind: 'added' });
      j++;
    }
  }
  while (i < a.length) tokens.push({ value: a[i++], kind: 'removed' });
  while (j < b.length) tokens.push({ value: b[j++], kind: 'added' });

  return tokens;
}

/**
 * Rendering del Markdown in HTML sicuro.
 *
 * SICUREZZA: non usiamo `dangerouslySetInnerHTML` su Markdown grezzo. Il
 * contenuto è prodotto da un LLM a partire da pagine web crawlate, quindi è
 * input non fidato a tutti gli effetti. Qui rendiamo con elementi React reali,
 * il che rende l'iniezione di HTML strutturalmente impossibile.
 */
function MarkdownPreview({ markdown }: { markdown: string }) {
  const elements = React.useMemo(() => {
    const lines = markdown.split('\n');
    const nodes: React.ReactNode[] = [];
    let paragraph: string[] = [];
    let listItems: string[] = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      nodes.push(<p key={`p-${nodes.length}`}>{renderInline(paragraph.join(' '))}</p>);
      paragraph = [];
    };

    const flushList = () => {
      if (listItems.length === 0) return;
      nodes.push(
        <ul key={`ul-${nodes.length}`}>
          {listItems.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      listItems = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        flushParagraph();
        flushList();
        continue;
      }

      const heading = /^(#{2,3})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flushParagraph();
        flushList();
        const Tag = heading[1].length === 2 ? 'h2' : 'h3';
        nodes.push(<Tag key={`h-${nodes.length}`}>{renderInline(heading[2])}</Tag>);
        continue;
      }

      const listItem = /^[-*]\s+(.*)$/.exec(trimmed);
      if (listItem) {
        flushParagraph();
        listItems.push(listItem[1]);
        continue;
      }

      const quote = /^>\s+(.*)$/.exec(trimmed);
      if (quote) {
        flushParagraph();
        flushList();
        nodes.push(
          <blockquote key={`q-${nodes.length}`}>{renderInline(quote[1])}</blockquote>,
        );
        continue;
      }

      flushList();
      paragraph.push(trimmed);
    }

    flushParagraph();
    flushList();
    return nodes;
  }, [markdown]);

  return <div className="prose-article">{elements}</div>;
}

/** Grassetto, corsivo e link inline, resi come nodi React. Nessun HTML grezzo. */
function renderInline(text: string): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern).filter(Boolean);

  return parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (/^\*[^*]+\*$/.test(part)) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = link[2];
      // Allowlist di schema: blocca `javascript:` e `data:`.
      const isSafe = /^https?:\/\//i.test(href) || href.startsWith('/');
      if (!isSafe) return <span key={index}>{link[1]}</span>;
      return (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export interface DraftReviewerProps {
  articleId: string;
  draft: ArticleDraft;
  qualityScore: QualityScore | null;
  /** Markdown della versione precedente, per la modalità diff. */
  previousMarkdown: string | null;
  onApprove: (articleId: string) => Promise<void>;
  onReject: (articleId: string, feedback: string) => Promise<void>;
  /** Rewrite mirato: rigenera una sola sezione, preservando il resto. */
  onRewriteSection: (
    articleId: string,
    sectionHeading: string,
    instruction: string,
  ) => Promise<void>;
  disabled?: boolean;
}

export function DraftReviewer({
  articleId,
  draft,
  qualityScore,
  previousMarkdown,
  onApprove,
  onReject,
  onRewriteSection,
  disabled = false,
}: DraftReviewerProps) {
  const shouldReduceMotion = useReducedMotion();

  const [viewMode, setViewMode] = React.useState<ViewMode>('read');
  const [pendingAction, setPendingAction] = React.useState<
    'approve' | 'reject' | 'rewrite' | null
  >(null);
  const [isRejecting, setIsRejecting] = React.useState(false);
  const [rejectionFeedback, setRejectionFeedback] = React.useState('');
  const [rewriteTarget, setRewriteTarget] = React.useState<ParsedBlock | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = React.useState('');

  const blocks = React.useMemo(
    () => parseBlocks(draft.contentMarkdown),
    [draft.contentMarkdown],
  );

  const diffTokens = React.useMemo(() => {
    if (viewMode !== 'diff' || !previousMarkdown) return null;
    return diffWords(previousMarkdown, draft.contentMarkdown);
  }, [viewMode, previousMarkdown, draft.contentMarkdown]);

  const diffStats = React.useMemo(() => {
    if (!diffTokens) return null;
    let added = 0;
    let removed = 0;
    for (const token of diffTokens) {
      if (!token.value.trim()) continue;
      if (token.kind === 'added') added++;
      if (token.kind === 'removed') removed++;
    }
    return { added, removed };
  }, [diffTokens]);

  const runAction = async (
    action: 'approve' | 'reject' | 'rewrite',
    fn: () => Promise<void>,
  ) => {
    setPendingAction(action);
    try {
      await fn();
      if (action === 'reject') {
        setIsRejecting(false);
        setRejectionFeedback('');
      }
      if (action === 'rewrite') {
        setRewriteTarget(null);
        setRewriteInstruction('');
      }
    } finally {
      setPendingAction(null);
    }
  };

  const canDiff = previousMarkdown !== null;

  return (
    <div className="flex h-full flex-col" data-attention="true">
      {/* --- Intestazione: metadati SEO, sempre visibili ------------------ */}
      <header className="border-b border-border pb-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-foreground-subtle">
          <span className="inline-flex items-center gap-1" data-metric>
            <Type className="size-3" aria-hidden="true" />
            <span className="tabular">{draft.wordCount.toLocaleString('it-IT')}</span>{' '}
            parole
          </span>
          <span className="inline-flex items-center gap-1">
            <Hash className="size-3" aria-hidden="true" />
            versione {draft.versionNumber}
          </span>
          {draft.llmModel ? (
            <span className="font-mono">{draft.llmModel}</span>
          ) : null}
        </div>

        <h2 className="mt-2 text-lg font-semibold leading-snug text-foreground">
          {draft.title}
        </h2>

        {/* La meta description è ciò che si vede nella SERP: mostrarla con il
            contatore evita la troncatura scoperta solo dopo la pubblicazione. */}
        <div className="mt-1.5 flex items-start gap-2">
          <p className="flex-1 text-xs leading-relaxed text-foreground-muted">
            {draft.metaDescription}
          </p>
          <span
            className={cn(
              'shrink-0 text-2xs tabular',
              draft.metaDescription.length > 160
                ? 'font-semibold text-accent-900'
                : 'text-foreground-subtle',
            )}
            data-metric
          >
            {draft.metaDescription.length}/160
          </span>
        </div>
      </header>

      {/* --- Selettore di modalità -------------------------------------- */}
      <div
        className="flex items-center gap-1 border-b border-border py-2"
        role="tablist"
        aria-label="Modalità di lettura"
      >
        {(
          [
            { mode: 'read', label: 'Lettura', icon: Eye },
            { mode: 'outline', label: 'Struttura', icon: FileText },
            { mode: 'diff', label: 'Differenze', icon: Columns2 },
          ] as const
        ).map(({ mode, label, icon: Icon }) => {
          const isDisabled = mode === 'diff' && !canDiff;
          const isSelected = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={isSelected}
              disabled={isDisabled}
              onClick={() => setViewMode(mode)}
              title={
                isDisabled ? 'Nessuna versione precedente da confrontare' : undefined
              }
              className={cn(
                'relative inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs font-medium transition-colors',
                isSelected
                  ? 'text-foreground'
                  : 'text-foreground-subtle hover:text-foreground',
                isDisabled && 'cursor-not-allowed opacity-40 hover:text-foreground-subtle',
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
              {mode === 'diff' && diffStats ? (
                <span className="tabular text-2xs text-foreground-subtle">
                  +{diffStats.added} −{diffStats.removed}
                </span>
              ) : null}
              {isSelected ? (
                // layoutId: l'indicatore scivola fra i tab invece di saltare.
                <motion.span
                  layoutId="draft-view-indicator"
                  className="absolute inset-x-1 -bottom-2 h-0.5 rounded-full bg-base-900"
                  transition={
                    shouldReduceMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 400, damping: 32 }
                  }
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* --- Corpo ------------------------------------------------------- */}
      <div className="flex flex-1 gap-6 overflow-hidden pt-4">
        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
          {viewMode === 'read' ? (
            <MarkdownPreview markdown={draft.contentMarkdown} />
          ) : null}

          {viewMode === 'outline' ? (
            <ol className="space-y-1">
              {blocks.map((block) => (
                <li
                  key={block.id}
                  className={cn(
                    'group flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-surface-muted',
                    block.level === 3 && 'ml-5',
                  )}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-2xs font-semibold text-foreground-subtle">
                      H{block.level}
                    </span>
                    <span className="truncate text-sm text-foreground">
                      {block.heading}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className="tabular text-2xs text-foreground-subtle"
                      data-metric
                    >
                      {block.wordCount}p
                    </span>
                    <button
                      type="button"
                      onClick={() => setRewriteTarget(block)}
                      disabled={disabled}
                      className="rounded px-1.5 py-0.5 text-2xs font-medium text-foreground-subtle opacity-0 transition-opacity hover:bg-base-200 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      Riscrivi
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}

          {viewMode === 'diff' && diffTokens ? (
            <div className="prose-article">
              <p>
                {diffTokens.map((token, index) => {
                  if (token.kind === 'equal')
                    return <React.Fragment key={index}>{token.value}</React.Fragment>;
                  return (
                    <span
                      key={index}
                      className={
                        token.kind === 'added' ? 'diff-added' : 'diff-removed'
                      }
                    >
                      {/* Il simbolo garantisce che il diff resti leggibile
                          in scala di grigi e per uno screen reader. */}
                      <span className="sr-only">
                        {token.kind === 'added' ? ' aggiunto: ' : ' rimosso: '}
                      </span>
                      {token.value}
                    </span>
                  );
                })}
              </p>
            </div>
          ) : null}
        </div>

        {/* --- Colonna laterale: quality score ---------------------------- */}
        {qualityScore ? (
          <aside className="hidden w-64 shrink-0 overflow-y-auto lg:block">
            <QualityScorePanel score={qualityScore} />
          </aside>
        ) : null}
      </div>

      {/* --- Pannello rewrite mirato ------------------------------------- */}
      <AnimatePresence>
        {rewriteTarget ? (
          <motion.div
            initial={shouldReduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden border-t border-accent-300 bg-accent-50"
          >
            <div className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-accent-900">
                  Riscrivi «{rewriteTarget.heading}»
                </p>
                <button
                  type="button"
                  onClick={() => setRewriteTarget(null)}
                  aria-label="Chiudi il pannello di riscrittura"
                  className="rounded p-0.5 text-accent-900 hover:bg-accent-200"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <textarea
                value={rewriteInstruction}
                onChange={(e) => setRewriteInstruction(e.target.value)}
                rows={2}
                autoFocus
                aria-label="Istruzione per la riscrittura"
                placeholder="Es. «più concreta, aggiungi un esempio numerico, taglia del 30%»"
                className="w-full resize-none rounded-[var(--radius-md)] border border-accent-300 bg-surface p-2.5 text-xs text-foreground placeholder:text-foreground-subtle focus:border-accent-500 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-accent-900">
                  Solo questa sezione viene rigenerata. Il resto dell’articolo resta
                  intatto.
                </span>
                <Button
                  variant="accent"
                  size="sm"
                  isLoading={pendingAction === 'rewrite'}
                  disabled={rewriteInstruction.trim().length < 5}
                  onClick={() =>
                    runAction('rewrite', () =>
                      onRewriteSection(
                        articleId,
                        rewriteTarget.heading,
                        rewriteInstruction.trim(),
                      ),
                    )
                  }
                >
                  <Sparkles aria-hidden="true" />
                  Riscrivi sezione
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* --- Barra azioni ------------------------------------------------ */}
      <footer className="sticky bottom-0 border-t border-border bg-surface/95 pt-3 backdrop-blur">
        {isRejecting ? (
          <div className="space-y-2">
            <label
              htmlFor="draft-rejection-feedback"
              className="block text-xs font-medium text-foreground"
            >
              Cosa non va in questa bozza?
            </label>
            <textarea
              id="draft-rejection-feedback"
              value={rejectionFeedback}
              onChange={(e) => setRejectionFeedback(e.target.value)}
              rows={2}
              autoFocus
              placeholder="Il feedback guida la rigenerazione completa dell’articolo."
              className="w-full resize-none rounded-[var(--radius-md)] border border-border bg-surface p-2.5 text-xs text-foreground placeholder:text-foreground-subtle focus:border-accent-400 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsRejecting(false)}
                disabled={pendingAction !== null}
              >
                Annulla
              </Button>
              <Button
                variant="danger"
                size="sm"
                isLoading={pendingAction === 'reject'}
                disabled={rejectionFeedback.trim().length < 5}
                onClick={() =>
                  runAction('reject', () =>
                    onReject(articleId, rejectionFeedback.trim()),
                  )
                }
              >
                Rigenera articolo
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-foreground-subtle">
              Approvando, l’articolo entra in coda di pubblicazione.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsRejecting(true)}
                disabled={disabled || pendingAction !== null}
              >
                <X aria-hidden="true" />
                Rifiuta
              </Button>
              <Button
                variant="accent"
                size="sm"
                isLoading={pendingAction === 'approve'}
                disabled={disabled}
                onClick={() => runAction('approve', () => onApprove(articleId))}
              >
                <Check aria-hidden="true" />
                Approva e pubblica
              </Button>
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
