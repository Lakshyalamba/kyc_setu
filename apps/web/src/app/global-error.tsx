'use client';

import './globals.css';

/** The last resort: the root layout itself failed, so this page brings its own <html>. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5 py-6">
          <div
            role="alert"
            data-testid="global-error"
            className="rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm"
          >
            <p className="text-sm font-semibold text-muted-foreground">Something went wrong</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              KYC Setu can’t load right now
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing you entered was lost. Try again in a moment.
              {error.digest ? ` Reference ${error.digest}.` : ''}
            </p>
            <button
              onClick={reset}
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
