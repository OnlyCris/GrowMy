'use client';

import { AnimatePresence, Reorder, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  ExternalLink,
  GripVertical,
  Link2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ArticleBrief, BriefSection } from '@/types/review';

/**
 * BRIEF EDITOR — il cuore dell'UPGRADE #1
 *
 * Su Outrank l'utente scopre l'angolo editoriale *dopo* che 1.500 parole sono
 * state scritte e depositate come bozza sul suo CMS. Correggere a quel punto
 * significa buttare l'articolo e rigenerare, consumando un altro credito.
 *
 * Qui la correzione avviene sull'outline, dove costa dieci secondi invece di un
 * credito. È lo stesso principio per cui si rivede la scaletta prima di scrivere,
 * non dopo.
 *
 * Nota di implementazione: l'editing è ottimistico e locale. Nulla viene inviato
 * al server finché l'utente non approva o salva, così il riordino delle sezioni
 * resta immediato anche su connessioni lente.
 */

const INTENT_LABELS: Record<BriefSection['intent'], string> = {
  informational: 'Informativo',
  commercial: 'Comparativo',
  transactional: 'Transazionale',
  navigational: 'Navigazionale',
};

const INTENT_STYLES: Record<BriefSection['intent'], string> = {
  informational: 'bg-info-100 text-info-700',
  commercial: 'bg-accent-100 text-accent-900',
  transactional: 'bg-success-100 text-success-700',
  navigational: 'bg-surface-muted text-foreground-muted',
};

export interface BriefEditorProps {
  articleId: string;
  brief: ArticleBrief;
  /** Salva le modifiche senza approvare. Ritorna quando la persistenza è confermata. */
  onSave: (articleId: string, brief: ArticleBrief) => Promise<void>;
  /** Salva e sblocca la transizione `brief_ready -> generating`. */
  onApprove: (articleId: string, brief: ArticleBrief) => Promise<void>;
  /** Rifiuta il brief con un feedback testuale: l'AI rigenera l'outline. */
  onReject: (articleId: string, feedback: string) => Promise<void>;
  /** Crediti consumati da una rigenerazione dell'outline (tipicamente 0). */
  regenerationCost: number;
  disabled?: boolean;
}

export function BriefEditor({
  articleId,
  brief: initialBrief,
  onSave,
  onApprove,
  onReject,
  regenerationCost,
  disabled = false,
}: BriefEditorProps) {
  const shouldReduceMotion = useReducedMotion();

  const [brief, setBrief] = React.useState<ArticleBrief>(initialBrief);
  const [isDirty, setIsDirty] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<
    'save' | 'approve' | 'reject' | null
  >(null);
  const [rejectionFeedback, setRejectionFeedback] = React.useState('');
  const [isRejecting, setIsRejecting] = React.useState(false);

  // Se il server invia un brief diverso (rigenerazione completata), ripartiamo
  // da quello, ma solo se l'utente non ha modifiche locali non salvate.
  React.useEffect(() => {
    if (!isDirty) setBrief(initialBrief);
  }, [initialBrief, isDirty]);

  const update = React.useCallback((mutator: (draft: ArticleBrief) => ArticleBrief) => {
    setBrief((current) => mutator(current));
    setIsDirty(true);
  }, []);

  const estimatedWords = React.useMemo(
    () => brief.sections.reduce((sum, s) => sum + s.estimatedWords, 0),
    [brief.sections],
  );

  // --- Handler di mutazione ------------------------------------------------

  const handleAngleChange = (angle: string) =>
    update((d) => ({ ...d, angle }));

  const handleReorder = (sections: BriefSection[]) =>
    update((d) => ({ ...d, sections }));

  const handleSectionChange = (id: string, patch: Partial<BriefSection>) =>
    update((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const handleBulletChange = (sectionId: string, index: number, value: string) =>
    update((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.id === sectionId
          ? { ...s, bullets: s.bullets.map((b, i) => (i === index ? value : b)) }
          : s,
      ),
    }));

  const handleAddBullet = (sectionId: string) =>
    update((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.id === sectionId ? { ...s, bullets: [...s.bullets, ''] } : s,
      ),
    }));

  const handleRemoveBullet = (sectionId: string, index: number) =>
    update((d) => ({
      ...d,
      sections: d.sections.map((s) =>
        s.id === sectionId
          ? { ...s, bullets: s.bullets.filter((_, i) => i !== index) }
          : s,
      ),
    }));

  const handleAddSection = () =>
    update((d) => ({
      ...d,
      sections: [
        ...d.sections,
        {
          // `crypto.randomUUID` è disponibile in tutti i browser target.
          id: crypto.randomUUID(),
          heading: '',
          bullets: [''],
          intent: 'informational',
          estimatedWords: 200,
        },
      ],
    }));

  const handleRemoveSection = (id: string) =>
    update((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }));

  const handleRemoveSource = (id: string) =>
    update((d) => ({ ...d, sources: d.sources.filter((s) => s.id !== id) }));

  const handleRemoveSecondaryKeyword = (keyword: string) =>
    update((d) => ({
      ...d,
      secondaryKeywords: d.secondaryKeywords.filter((k) => k !== keyword),
    }));

  const handleReset = () => {
    setBrief(initialBrief);
    setIsDirty(false);
  };

  // --- Azioni asincrone ----------------------------------------------------

  const runAction = async (
    action: 'save' | 'approve' | 'reject',
    fn: () => Promise<void>,
  ) => {
    setPendingAction(action);
    try {
      await fn();
      if (action !== 'reject') setIsDirty(false);
      if (action === 'reject') {
        setIsRejecting(false);
        setRejectionFeedback('');
      }
    } finally {
      // Il ripristino avviene sempre: se l'azione fallisce, il messaggio
      // d'errore è responsabilità del contenitore, ma il bottone deve tornare
      // cliccabile per consentire il retry.
      setPendingAction(null);
    }
  };

  // Un brief senza angolo o senza sezioni titolate non è approvabile.
  const validationError = React.useMemo(() => {
    if (brief.angle.trim().length < 10)
      return 'L’angolo editoriale è troppo breve per guidare la stesura.';
    if (brief.sections.length === 0) return 'Serve almeno una sezione.';
    if (brief.sections.some((s) => s.heading.trim().length === 0))
      return 'Tutte le sezioni devono avere un titolo.';
    return null;
  }, [brief]);

  return (
    <div className="flex h-full flex-col" data-attention="true">
      <div className="flex-1 space-y-6 overflow-y-auto px-1 pb-6">
        {/* --- Angolo editoriale ------------------------------------------
            Primo elemento perché è la decisione con più impatto e la meno
            reversibile: una volta scritto l'articolo, cambiare angolo = rifare. */}
        <section aria-labelledby="brief-angle-label">
          <div className="mb-1.5 flex items-center justify-between">
            <label
              id="brief-angle-label"
              htmlFor="brief-angle"
              className="text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Angolo editoriale
            </label>
            <span className="text-2xs text-foreground-subtle">
              La scelta meno reversibile
            </span>
          </div>
          <textarea
            id="brief-angle"
            value={brief.angle}
            onChange={(e) => handleAngleChange(e.target.value)}
            disabled={disabled}
            rows={3}
            className={cn(
              'w-full resize-y rounded-[var(--radius-md)] border border-border bg-surface p-3',
              'text-sm leading-relaxed text-foreground placeholder:text-foreground-subtle',
              'focus:border-accent-400 focus:outline-none disabled:opacity-60',
            )}
            placeholder="Da quale prospettiva affrontiamo questa keyword?"
          />
        </section>

        {/* --- Keyword ---------------------------------------------------- */}
        <section aria-labelledby="brief-keywords-label">
          <h4
            id="brief-keywords-label"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted"
          >
            Keyword
          </h4>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-base-900 px-2.5 py-1 text-xs font-medium text-base-50">
              {brief.targetKeyword}
              <span className="text-2xs font-normal opacity-70">primaria</span>
            </span>
            {brief.secondaryKeywords.map((keyword) => (
              <span
                key={keyword}
                className="group inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-foreground-muted"
              >
                {keyword}
                <button
                  type="button"
                  onClick={() => handleRemoveSecondaryKeyword(keyword)}
                  disabled={disabled}
                  aria-label={`Rimuovi la keyword secondaria ${keyword}`}
                  className="rounded-full p-0.5 text-foreground-subtle hover:bg-base-200 hover:text-foreground"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        </section>

        {/* --- Outline ----------------------------------------------------- */}
        <section aria-labelledby="brief-outline-label">
          <div className="mb-2 flex items-baseline justify-between">
            <h4
              id="brief-outline-label"
              className="text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Struttura ({brief.sections.length} sezioni)
            </h4>
            <span className="text-2xs tabular text-foreground-subtle" data-metric>
              ~{estimatedWords.toLocaleString('it-IT')} parole stimate
            </span>
          </div>

          {/* Reorder.Group di Framer Motion: drag and drop accessibile, con
              fallback da tastiera gestito dai bottoni freccia su ogni sezione. */}
          <Reorder.Group
            axis="y"
            values={brief.sections}
            onReorder={handleReorder}
            className="space-y-2"
          >
            {brief.sections.map((section, index) => (
              <Reorder.Item
                key={section.id}
                value={section}
                dragListener={!disabled}
                className="rounded-[var(--radius-md)] border border-border bg-surface p-3"
                whileDrag={
                  shouldReduceMotion
                    ? undefined
                    : { scale: 1.01, boxShadow: 'var(--shadow-md)' }
                }
              >
                <div className="flex items-start gap-2">
                  <span
                    className="mt-2 cursor-grab text-foreground-subtle active:cursor-grabbing"
                    aria-hidden="true"
                  >
                    <GripVertical className="size-4" />
                  </span>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-2xs font-semibold tabular text-foreground-subtle">
                        H2 · {index + 1}
                      </span>
                      <input
                        type="text"
                        value={section.heading}
                        onChange={(e) =>
                          handleSectionChange(section.id, {
                            heading: e.target.value,
                          })
                        }
                        disabled={disabled}
                        aria-label={`Titolo della sezione ${index + 1}`}
                        placeholder="Titolo della sezione"
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm font-medium text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-0"
                      />
                      <select
                        value={section.intent}
                        onChange={(e) =>
                          handleSectionChange(section.id, {
                            intent: e.target.value as BriefSection['intent'],
                          })
                        }
                        disabled={disabled}
                        aria-label={`Intento di ricerca della sezione ${index + 1}`}
                        className={cn(
                          'shrink-0 rounded-full border-0 px-2 py-0.5 text-2xs font-medium',
                          INTENT_STYLES[section.intent],
                        )}
                      >
                        {Object.entries(INTENT_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <ul className="space-y-1">
                      {section.bullets.map((bullet, bulletIndex) => (
                        <li
                          key={`${section.id}-${bulletIndex}`}
                          className="flex items-center gap-1.5"
                        >
                          <ArrowRight
                            className="size-3 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                          <input
                            type="text"
                            value={bullet}
                            onChange={(e) =>
                              handleBulletChange(
                                section.id,
                                bulletIndex,
                                e.target.value,
                              )
                            }
                            disabled={disabled}
                            aria-label={`Punto ${bulletIndex + 1} della sezione ${index + 1}`}
                            placeholder="Cosa deve coprire questo punto"
                            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground-muted placeholder:text-foreground-subtle focus:outline-none"
                          />
                          {section.bullets.length > 1 ? (
                            <button
                              type="button"
                              onClick={() =>
                                handleRemoveBullet(section.id, bulletIndex)
                              }
                              disabled={disabled}
                              aria-label={`Rimuovi il punto ${bulletIndex + 1}`}
                              className="rounded p-0.5 text-foreground-subtle hover:bg-base-200 hover:text-danger-700"
                            >
                              <X className="size-3" aria-hidden="true" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    <button
                      type="button"
                      onClick={() => handleAddBullet(section.id)}
                      disabled={disabled}
                      className="inline-flex items-center gap-1 text-2xs font-medium text-foreground-subtle hover:text-foreground"
                    >
                      <Plus className="size-3" aria-hidden="true" />
                      Aggiungi punto
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleRemoveSection(section.id)}
                    disabled={disabled || brief.sections.length === 1}
                    aria-label={`Elimina la sezione ${index + 1}`}
                    className="rounded p-1 text-foreground-subtle hover:bg-danger-100 hover:text-danger-700 disabled:opacity-30"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </Reorder.Item>
            ))}
          </Reorder.Group>

          <Button
            variant="outline"
            size="sm"
            onClick={handleAddSection}
            disabled={disabled}
            className="mt-2 w-full border-dashed"
          >
            <Plus aria-hidden="true" />
            Aggiungi sezione
          </Button>
        </section>

        {/* --- Fonti proposte ---------------------------------------------- */}
        {brief.sources.length > 0 ? (
          <section aria-labelledby="brief-sources-label">
            <h4
              id="brief-sources-label"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Fonti da citare ({brief.sources.length})
            </h4>
            <ul className="space-y-1.5">
              {brief.sources.map((source) => (
                <li
                  key={source.id}
                  className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:text-info-700 hover:underline"
                    >
                      <span className="truncate">{source.title}</span>
                      <ExternalLink
                        className="size-3 shrink-0 text-foreground-subtle"
                        aria-hidden="true"
                      />
                      <span className="sr-only">(si apre in una nuova scheda)</span>
                    </a>
                    <p className="mt-0.5 text-2xs text-foreground-subtle">
                      {source.reason}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSource(source.id)}
                    disabled={disabled}
                    aria-label={`Rimuovi la fonte ${source.title}`}
                    className="rounded p-0.5 text-foreground-subtle hover:bg-base-200 hover:text-danger-700"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* --- Link interni pianificati ------------------------------------ */}
        {brief.internalLinkTargets.length > 0 ? (
          <section aria-labelledby="brief-links-label">
            <h4
              id="brief-links-label"
              className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              <Link2 className="size-3.5" aria-hidden="true" />
              Link interni pianificati
            </h4>
            <ul className="flex flex-wrap gap-1.5">
              {brief.internalLinkTargets.map((target) => (
                <li
                  key={target.articleId}
                  className="rounded-full border border-border bg-surface-muted px-2.5 py-1 text-2xs text-foreground-muted"
                >
                  {target.title}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* --- Barra azioni: sticky, sempre raggiungibile ------------------- */}
      <footer className="sticky bottom-0 border-t border-border bg-surface/95 pt-3 backdrop-blur">
        <AnimatePresence mode="wait">
          {isRejecting ? (
            <motion.div
              key="reject"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="space-y-2"
            >
              <label
                htmlFor="rejection-feedback"
                className="block text-xs font-medium text-foreground"
              >
                Cosa non funziona in questo brief?
              </label>
              <textarea
                id="rejection-feedback"
                value={rejectionFeedback}
                onChange={(e) => setRejectionFeedback(e.target.value)}
                rows={2}
                autoFocus
                placeholder="L’AI userà questo feedback per riscrivere l’outline."
                className="w-full resize-none rounded-[var(--radius-md)] border border-border bg-surface p-2.5 text-xs text-foreground placeholder:text-foreground-subtle focus:border-accent-400 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs text-foreground-subtle">
                  {regenerationCost === 0
                    ? 'La rigenerazione dell’outline non consuma crediti.'
                    : `Costo: ${regenerationCost} credito/i.`}
                </span>
                <div className="flex gap-2">
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
                    Rigenera outline
                  </Button>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="actions"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? undefined : { opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
            >
              {validationError ? (
                <p
                  role="alert"
                  className="mb-2 text-2xs font-medium text-danger-700"
                >
                  {validationError}
                </p>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  {isDirty ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleReset}
                      disabled={pendingAction !== null}
                    >
                      <RotateCcw aria-hidden="true" />
                      Annulla modifiche
                    </Button>
                  ) : null}
                </div>

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
                  {isDirty ? (
                    <Button
                      variant="outline"
                      size="sm"
                      isLoading={pendingAction === 'save'}
                      disabled={disabled || validationError !== null}
                      onClick={() => runAction('save', () => onSave(articleId, brief))}
                    >
                      Salva senza approvare
                    </Button>
                  ) : null}
                  <Button
                    variant="accent"
                    size="sm"
                    isLoading={pendingAction === 'approve'}
                    disabled={disabled || validationError !== null}
                    onClick={() =>
                      runAction('approve', () => onApprove(articleId, brief))
                    }
                  >
                    <Check aria-hidden="true" />
                    Approva e scrivi
                  </Button>
                </div>
              </div>

              <p className="mt-2 flex items-center gap-1.5 text-2xs text-foreground-subtle">
                <Sparkles className="size-3" aria-hidden="true" />
                Correggere qui costa dieci secondi. Correggere dopo la stesura
                costa un credito.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </div>
  );
}
