import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * `<select>` nativo, stessa forma visiva di `Input`. Niente combobox custom:
 * fuori scope per un elenco di poche decine di opzioni al massimo (lingua,
 * fuso orario) — un `<select>` nativo è già accessibile e già supporta la
 * tastiera senza lavoro aggiuntivo.
 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            'flex h-9 w-full appearance-none rounded-[var(--radius-md)] border border-border-strong',
            'bg-surface px-3 pr-8 text-sm text-foreground shadow-xs',
            'transition-colors duration-150 ease-[var(--ease-out-quart)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'aria-[invalid=true]:border-danger-500',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle"
          aria-hidden="true"
        />
      </div>
    );
  },
);
Select.displayName = 'Select';

export { Select };
