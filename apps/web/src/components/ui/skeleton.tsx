import { cn } from '@/lib/utils';

/** A grey block standing in for content that is loading. Invisible for the first 300 ms (see globals.css). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-md bg-secondary', className)} />;
}
