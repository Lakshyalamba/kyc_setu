import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5 py-6">
      <Logo className="text-primary" />
      <Card data-testid="not-found">
        <CardHeader>
          <p className="text-sm font-semibold text-muted-foreground">404</p>
          <CardTitle>We can’t find that page</CardTitle>
          <CardDescription>
            The link may be old or mistyped. Nothing was lost: your application is exactly where you
            left it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/">Go to the start</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
