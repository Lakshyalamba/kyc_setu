import { cn } from '@/lib/utils';

/** Two letters on the brand colour. The same mark is the favicon (src/app/icon.svg). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold tracking-tight text-primary-foreground',
        className,
      )}
    >
      KS
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold', className)}>
      <LogoMark />
      KYC Setu
    </span>
  );
}
