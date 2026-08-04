import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleDashed,
  Clock,
  FileText,
  Loader2,
  PenLine,
  Search,
  Send,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Badge di stato per l'articolo.
 *
 * ACCESSIBILITÀ: lo stato non è MAI veicolato dal solo colore. Ogni stato ha
 * icona + etichetta testuale, così resta comprensibile in scala di grigi, per
 * chi ha discromatopsia e per uno screen reader.
 *
 * DESIGN: solo `brief_ready` e `draft_ready` usano l'ambra, perché sono gli unici
 * due stati che richiedono una decisione umana. Tutto il resto è neutro o
 * funzionale. È la regola che rende la coda scansionabile in mezzo secondo.
 */

export type ArticleStatus =
  | 'queued'
  | 'researching'
  | 'brief_ready'
  | 'generating'
  | 'draft_ready'
  | 'approved'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'archived';

interface StatusConfig {
  label: string;
  icon: LucideIcon;
  className: string;
  /** True se lo stato blocca la pipeline in attesa di un umano. */
  needsAttention: boolean;
  /** True se un lavoro è attivamente in corso: l'icona ruota. */
  isActive: boolean;
}

const STATUS_CONFIG: Record<ArticleStatus, StatusConfig> = {
  queued: {
    label: 'In coda',
    icon: CircleDashed,
    className: 'bg-surface-muted text-foreground-muted border-border',
    needsAttention: false,
    isActive: false,
  },
  researching: {
    label: 'Ricerca in corso',
    icon: Search,
    className: 'bg-info-100 text-info-700 border-transparent',
    needsAttention: false,
    isActive: true,
  },
  brief_ready: {
    label: 'Brief da approvare',
    icon: FileText,
    className: 'bg-accent-100 text-accent-900 border-accent-300 font-semibold',
    needsAttention: true,
    isActive: false,
  },
  generating: {
    label: 'Stesura in corso',
    icon: PenLine,
    className: 'bg-info-100 text-info-700 border-transparent',
    needsAttention: false,
    isActive: true,
  },
  draft_ready: {
    label: 'Bozza da approvare',
    icon: FileText,
    className: 'bg-accent-100 text-accent-900 border-accent-300 font-semibold',
    needsAttention: true,
    isActive: false,
  },
  approved: {
    label: 'Approvato',
    icon: CheckCircle2,
    className: 'bg-surface-muted text-foreground-muted border-border',
    needsAttention: false,
    isActive: false,
  },
  publishing: {
    label: 'Pubblicazione',
    icon: Send,
    className: 'bg-info-100 text-info-700 border-transparent',
    needsAttention: false,
    isActive: true,
  },
  published: {
    label: 'Pubblicato',
    icon: CheckCircle2,
    className: 'bg-success-100 text-success-700 border-transparent',
    needsAttention: false,
    isActive: false,
  },
  failed: {
    label: 'Fallito',
    icon: XCircle,
    className: 'bg-danger-100 text-danger-700 border-transparent',
    needsAttention: true,
    isActive: false,
  },
  archived: {
    label: 'Archiviato',
    icon: Archive,
    className: 'bg-surface-muted text-foreground-subtle border-border',
    needsAttention: false,
    isActive: false,
  },
};

interface StatusBadgeProps {
  status: ArticleStatus;
  size?: 'sm' | 'md';
  /** Nasconde l'etichetta lasciando la sola icona (solo in spazi molto stretti). */
  iconOnly?: boolean;
  className?: string;
}

export function StatusBadge({
  status,
  size = 'md',
  iconOnly = false,
  className,
}: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.isActive ? Loader2 : config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border',
        size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-xs',
        config.className,
        className,
      )}
      data-status={status}
      data-attention={config.needsAttention}
      // Se mostriamo solo l'icona, l'etichetta deve comunque essere leggibile
      // da uno screen reader e dal tooltip nativo.
      title={iconOnly ? config.label : undefined}
    >
      <Icon
        className={cn(
          size === 'sm' ? 'size-3' : 'size-3.5',
          config.isActive && 'animate-spin',
        )}
        aria-hidden="true"
      />
      {iconOnly ? <span className="sr-only">{config.label}</span> : config.label}
    </span>
  );
}

/** Esportato per i componenti che devono decidere il layout in base allo stato. */
export function statusNeedsAttention(status: ArticleStatus): boolean {
  return STATUS_CONFIG[status].needsAttention;
}

export function statusLabel(status: ArticleStatus): string {
  return STATUS_CONFIG[status].label;
}

/**
 * Badge dedicato all'esito di un'integrazione (UPGRADE #3).
 * Stessa disciplina: icona + testo, ambra solo se serve un intervento umano.
 */
export function IntegrationHealthBadge({
  status,
  className,
}: {
  status: 'pending' | 'healthy' | 'degraded' | 'broken' | 'disabled';
  className?: string;
}) {
  const map = {
    pending: {
      label: 'Da verificare',
      icon: Clock,
      cls: 'bg-surface-muted text-foreground-muted border-border',
    },
    healthy: {
      label: 'Operativa',
      icon: CheckCircle2,
      cls: 'bg-success-100 text-success-700 border-transparent',
    },
    degraded: {
      label: 'Instabile',
      icon: AlertTriangle,
      cls: 'bg-accent-100 text-accent-900 border-accent-300 font-semibold',
    },
    broken: {
      label: 'Da riparare',
      icon: XCircle,
      cls: 'bg-danger-100 text-danger-700 border-transparent font-semibold',
    },
    disabled: {
      label: 'Disattivata',
      icon: Archive,
      cls: 'bg-surface-muted text-foreground-subtle border-border',
    },
  } as const;

  const { label, icon: Icon, cls } = map[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        cls,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}
