'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { kycClient } from '@/lib/kyc-api';
import { stepPath } from '@/lib/kyc-steps';

export function StartKyc() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const { session } = await kycClient.startSession();
      router.push(stepPath(session.currentStep));
      router.refresh();
    } catch {
      setError('Could not start your KYC. Please try again.');
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button size="lg" onClick={start} disabled={pending}>
        {pending ? 'Starting…' : 'Start KYC'}
      </Button>
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}
