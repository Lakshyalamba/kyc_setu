import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { hasPermission } from '@kyc-setu/shared';
import { LogoutButton } from '@/components/logout-button';
import { Badge } from '@/components/ui/badge';
import { OfficerNav } from '@/components/officer/officer-nav';
import { canManage, requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

/** Every officer page except the login screen lives under this layout, so the role check happens once, here. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireOfficer();
  // The read-only auditor has no review queue to work: their pages live under /auditor.
  if (user.role === 'AUDITOR') redirect('/auditor');
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-border bg-card">
        <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center gap-4 px-4">
          <p className="text-sm font-semibold tracking-widest text-primary uppercase">KYC Setu</p>
          <OfficerNav
            canManage={canManage(user.role)}
            canAudit={hasPermission(user.role, 'audit.read')}
          />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline" data-testid="officer-email">
              {user.email}
            </span>
            <Badge>{user.role.replace('_', ' ')}</Badge>
            <LogoutButton realm="officer" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] px-4 py-4">{children}</main>
    </div>
  );
}
