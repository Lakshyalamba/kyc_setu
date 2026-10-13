'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown when a page throws while it renders. The message of the error is never shown: on the server it can name
 * things nobody should read. The `digest` is the id the server logged the real error under.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5 py-6">
      <Logo className="text-primary" />
      <Card data-testid="error-page" role="alert">
        <CardHeader>
          <p className="text-sm font-semibold text-muted-foreground">Something went wrong</p>
          <CardTitle>That didn’t work, and it’s on us</CardTitle>
          <CardDescription>
            Nothing you entered was lost or sent twice. Try again, and if it keeps happening, tell
            us the reference below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Reference <code className="font-mono text-foreground">{error.digest}</code>
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={reset}>Try again</Button>
            <Button asChild variant="outline">
              <Link href="/">Go to the start</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
