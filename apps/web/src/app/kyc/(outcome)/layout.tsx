import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/logout-button';
import { requireCustomer } from '@/lib/kyc-server';

export const dynamic = 'force-dynamic';

/** The outcome pages (status, approved, rejected). No stepper: the journey is over or waiting. */
export default async function OutcomeLayout({ children }: { children: ReactNode }) {
  const user = await requireCustomer();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-widest text-primary uppercase">KYC Setu</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
        <LogoutButton realm="customer" />
      </header>
      {children}
    </main>
  );
}
