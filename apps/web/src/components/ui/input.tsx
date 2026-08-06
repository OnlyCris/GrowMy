import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Campo di testo. Niente `'use client'`: è un elemento nativo senza stato
 * proprio, componibile anche da Server Component (lo stato vive nel form che
 * lo contiene). Il ring di focus è globale (`globals.css`, `:focus-visible`):
 * non va ridefinito qui.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-[var(--radius-md)] border border-border-strong',
          'bg-surface px-3 text-sm text-foreground shadow-xs',
          'transition-colors duration-150 ease-[var(--ease-out-quart)]',
          'placeholder:text-foreground-subtle',
          'disabled:cursor-not-allowed disabled:opacity-50',
          // `aria-invalid` è impostato dal form che possiede la validazione
          // (vedi `FormError`) — il bordo rosso segue quel contratto, non uno
          // stato interno.
          'aria-[invalid=true]:border-danger-500',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
