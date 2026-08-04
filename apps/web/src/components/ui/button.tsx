'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Bottone.
 *
 * REGOLA DI DESIGN: la variante `accent` (ambra) è riservata alle azioni che
 * risolvono una decisione umana in attesa — approva brief, approva bozza,
 * ripara integrazione. Non usarla per "Salva" o "Crea": quelle sono `primary`.
 * Vedi docs/DESIGN.md.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium transition-all duration-150 ease-[var(--ease-out-quart)]',
    'disabled:pointer-events-none disabled:opacity-50',
    // L'icona non deve mai catturare il click né essere ridimensionata dal flex.
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    'select-none',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-base-900 text-base-50 shadow-xs hover:bg-base-800 active:bg-base-950',
        accent:
          'bg-accent-500 text-base-950 shadow-xs hover:bg-accent-400 active:bg-accent-600 font-semibold',
        outline:
          'border border-border-strong bg-surface text-foreground shadow-xs hover:bg-surface-muted active:bg-base-200',
        ghost: 'text-foreground-muted hover:bg-surface-muted hover:text-foreground',
        danger:
          'bg-danger-500 text-white shadow-xs hover:bg-danger-700 active:bg-danger-700',
        link: 'text-info-700 underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        sm: 'h-8 rounded-[var(--radius-sm)] px-3 text-xs',
        md: 'h-9 rounded-[var(--radius-md)] px-4 text-sm',
        lg: 'h-11 rounded-[var(--radius-md)] px-6 text-base',
        // Quadrato per bottoni con la sola icona. Richiede sempre `aria-label`.
        icon: 'size-9 rounded-[var(--radius-md)]',
      },
      fullWidth: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', fullWidth: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Renderizza il figlio al posto di `<button>` (es. per un `<Link>`). */
  asChild?: boolean;
  /**
   * Mostra lo spinner e disabilita il bottone.
   * Il testo resta visibile: sostituirlo con "Caricamento…" fa perdere il
   * contesto di cosa si stava facendo e provoca un layout shift.
   */
  isLoading?: boolean;
  /** Testo annunciato dagli screen reader durante il caricamento. */
  loadingLabel?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      fullWidth,
      asChild = false,
      isLoading = false,
      loadingLabel = 'Operazione in corso',
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';

    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        disabled={disabled || isLoading}
        aria-busy={isLoading || undefined}
        {...props}
      >
        {isLoading ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">{loadingLabel}</span>
          </>
        ) : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
