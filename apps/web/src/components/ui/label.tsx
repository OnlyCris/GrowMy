import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * `<label>` nativo. Nessuna dipendenza Radix: l'unico uso di Radix nel repo è
 * `react-slot` (per `asChild` su `Button`) — un `@radix-ui/react-label` in più
 * non aggiunge nulla che `htmlFor` non faccia già.
 */
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none text-foreground',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label };
