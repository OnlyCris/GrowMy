import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Campo di testo multi-riga. Stessa disciplina di `Input`: nessun
 * `'use client'`, nessuno stato proprio.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[8rem] w-full rounded-[var(--radius-md)] border border-border-strong',
        'bg-surface px-3 py-2 text-sm text-foreground shadow-xs',
        'transition-colors duration-150 ease-[var(--ease-out-quart)]',
        'placeholder:text-foreground-subtle',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-danger-500',
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
