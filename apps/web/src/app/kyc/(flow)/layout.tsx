import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/logout-button';
import { Stepper } from '@/components/kyc/stepper';
import { getCurrentKycSession, requireCustomer } from '@/lib/kyc-server';
import { Logo } from '@/components/logo';

export const dynamic = 'force-dynamic';

export default async function KycLayout({ children }: { children: ReactNode }) {
  const user = await requireCustomer();
  const session = await getCurrentKycSession();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Logo className="text-primary" />
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
        <LogoutButton realm="customer" />
      </header>
      <Stepper session={session} />
      {children}
    </main>
  );
}
