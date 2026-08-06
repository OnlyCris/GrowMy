import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

/**
 * Toggle booleano. `<button role="switch">` nativo, non un componente Radix:
 * l'unica dipendenza Radix nel repo è `react-slot` (per `asChild` su
 * `Button`) — un `@radix-ui/react-switch` in più non aggiunge nulla che
 * `aria-checked` + gestione tastiera nativa del bottone non forniscano già.
 *
 * Componente controllato, niente stato interno: chi lo usa (un form) decide
 * il valore, esattamente come `Input`.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full',
          'transition-colors duration-150 ease-[var(--ease-out-quart)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-base-900' : 'bg-base-300',
          className,
        )}
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-4 transform rounded-full bg-base-50 shadow-xs',
            'transition-transform duration-150 ease-[var(--ease-out-quart)]',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    );
  },
);
Switch.displayName = 'Switch';

export { Switch };
