import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/logout-button';
import { Badge } from '@/components/ui/badge';
import { OfficerNav } from '@/components/officer/officer-nav';
import { requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

/** Every officer page except the login screen lives under this layout, so the role check happens once, here. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireOfficer();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-border bg-card">
        <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center gap-4 px-4">
          <p className="text-sm font-semibold tracking-widest text-primary uppercase">KYC Setu</p>
          <OfficerNav />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline" data-testid="officer-email">
              {user.email}
            </span>
            <Badge tone={user.role === 'AUDITOR' ? 'info' : 'neutral'}>
              {user.role === 'AUDITOR' ? 'Auditor · read only' : user.role.replace('_', ' ')}
            </Badge>
            <LogoutButton realm="officer" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] px-4 py-4">{children}</main>
    </div>
  );
}
