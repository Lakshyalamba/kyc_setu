import * as React from 'react';
import { cn } from '@/lib/utils';

/** Native <select>: best mobile UX (OS picker), styled to match Input. */
export function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-12 w-full rounded-md border border-input bg-card px-3 text-base shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
