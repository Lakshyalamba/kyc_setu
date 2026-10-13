import { Skeleton } from '@/components/ui/skeleton';

/**
 * What the review page looks like before its payload arrives: the same two columns, with the slow parts (the evidence,
 * the face match, the risk breakdown) as placeholders. Used by the officer and the auditor routes' loading.tsx.
 */
export function ReviewSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the application"
      data-testid="review-skeleton"
      className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-72" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="aspect-[3/2] w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full" />
          <div className="flex gap-4">
            <Skeleton className="aspect-[4/5] w-44" />
            <Skeleton className="aspect-[4/5] w-44" />
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
      <span className="sr-only">Loading the application…</span>
    </div>
  );
}
