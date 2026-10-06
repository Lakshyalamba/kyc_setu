import * as React from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    className={cn(
      'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
      className,
    )}
    {...props}
  />
);
export const CardHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('flex flex-col gap-1.5 p-6', className)} {...props} />
);
export const CardTitle = ({ className, ...props }: React.ComponentProps<'h1'>) => (
  <h1 className={cn('text-2xl font-semibold tracking-tight', className)} {...props} />
);
export const CardDescription = ({ className, ...props }: React.ComponentProps<'p'>) => (
  <p className={cn('text-sm text-muted-foreground', className)} {...props} />
);
export const CardContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div className={cn('p-6 pt-0', className)} {...props} />
);
