'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { authResponseSchema } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { Logo } from '@/components/logo';

type Mode = 'signup' | 'customer-login' | 'officer-login';

const CONFIG: Record<
  Mode,
  {
    title: string;
    description: string;
    endpoint: string;
    redirect: string;
    submit: string;
    newPassword: boolean;
    alt?: { text: string; label: string; href: string };
  }
> = {
  signup: {
    title: 'Create your account',
    description: 'Start your KYC verification.',
    endpoint: '/auth/customer/signup',
    redirect: '/kyc',
    submit: 'Sign up',
    newPassword: true,
    alt: { text: 'Already registered?', label: 'Log in', href: '/login' },
  },
  'customer-login': {
    title: 'Welcome back',
    description: 'Log in to continue your KYC.',
    endpoint: '/auth/customer/login',
    redirect: '/kyc',
    submit: 'Log in',
    newPassword: false,
    alt: { text: 'New here?', label: 'Sign up', href: '/signup' },
  },
  'officer-login': {
    title: 'Officer login',
    description: 'Bank staff only.',
    endpoint: '/auth/officer/login',
    redirect: '/officer',
    submit: 'Log in',
    newPassword: false,
  },
};

export function AuthForm({ mode }: { mode: Mode }) {
  const cfg = CONFIG[mode];
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await apiFetch(cfg.endpoint, {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
        schema: authResponseSchema,
      });
      router.push(cfg.redirect);
      router.refresh();
    } catch (err) {
      setError(describeError(err, 'Something went wrong. Please try again.'));
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5 py-10">
      <Logo className="text-primary" />
      <Card>
        <CardHeader>
          <CardTitle>{cfg.title}</CardTitle>
          <CardDescription>{cfg.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={cfg.newPassword ? 'new-password' : 'current-password'}
                minLength={cfg.newPassword ? 8 : undefined}
                required
              />
              {cfg.newPassword && (
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              )}
            </div>
            <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
              {error}
            </p>
            <Button type="submit" disabled={pending}>
              {pending ? 'Please wait…' : cfg.submit}
            </Button>
          </form>
          {cfg.alt && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {cfg.alt.text}{' '}
              <Link href={cfg.alt.href} className="font-medium text-primary hover:underline">
                {cfg.alt.label}
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
