'use client';

import { useState } from 'react';

/** Dev-only stand-in for an SMS. Rendered only outside production, and only if the API sent a code. */
export function DevOtpBanner({ code }: { code: string | undefined }) {
  const [dismissed, setDismissed] = useState(false);
  if (process.env.NODE_ENV === 'production' || !code || dismissed) return null;
  return (
    <div
      data-testid="dev-otp-banner"
      className="flex items-start justify-between gap-3 rounded-md border border-warning-foreground/30 bg-warning-soft p-3 text-sm text-warning-foreground"
    >
      <p>
        <span className="font-semibold">Dev only:</span> your OTP is{' '}
        <strong data-testid="dev-otp-code" className="font-mono text-base tracking-widest">
          {code}
        </strong>
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="text-lg leading-none"
      >
        ×
      </button>
    </div>
  );
}
