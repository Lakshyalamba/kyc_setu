'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Markdown from 'react-markdown';
import type { ConsentVersionDto, KycSessionDto } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { kycClient } from '@/lib/kyc-api';
import { stepPath } from '@/lib/kyc-steps';
import { describeError } from '@/lib/errors';

// react-markdown does not render raw HTML by default, so the DB-provided text can't inject markup.
const components = {
  h1: (p: object) => <h2 className="mb-3 text-lg font-semibold" {...p} />,
  h2: (p: object) => <h3 className="mt-5 mb-1.5 text-base font-semibold" {...p} />,
  p: (p: object) => <p className="mb-3 text-sm leading-relaxed" {...p} />,
  ul: (p: object) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-sm leading-relaxed" {...p} />
  ),
  strong: (p: object) => <strong className="font-semibold" {...p} />,
  hr: () => <hr className="my-4 border-border" />,
};

export function ConsentStep({
  session,
  consent,
}: {
  session: KycSessionDto;
  consent: ConsentVersionDto;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const { session: next } = await kycClient.acceptConsent(session.id, consent.id);
      router.push(stepPath(next.currentStep));
      router.refresh();
    } catch (err) {
      setError(describeError(err, 'Something went wrong. Please try again.'));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your consent</CardTitle>
        <CardDescription>Version {consent.version}. Please read before continuing.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          data-testid="consent-body"
          className="max-h-[50dvh] overflow-y-auto rounded-md border border-border bg-background p-4"
        >
          <Markdown components={components}>{consent.bodyMarkdown}</Markdown>
        </div>
        <label className="flex min-h-12 items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 size-6 shrink-0 accent-[var(--primary)]"
          />
          <span>
            I have read and understood this notice and I consent to the use of my information.
          </span>
        </label>
        <Button onClick={accept} disabled={!checked || pending}>
          {pending ? 'Saving…' : 'I accept'}
        </Button>
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
          {error}
        </p>
      </CardContent>
    </Card>
  );
}
