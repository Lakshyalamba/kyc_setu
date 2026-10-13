import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/logo';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-10">
      <div className="space-y-3">
        <Logo className="text-primary" />
        <h1 className="text-4xl leading-tight font-bold tracking-tight">
          Verify your identity in minutes, from your phone.
        </h1>
        <p className="text-muted-foreground">
          Secure, paperless KYC for banks and fintechs. Have your PAN and Aadhaar ready.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button asChild size="lg">
          <Link href="/signup">Start KYC</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/officer/login">Officer Login</Link>
        </Button>
        <p className="pt-2 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
