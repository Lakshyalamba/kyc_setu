import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/logout-button';
import { AuditorNav } from '@/components/auditor/auditor-nav';
import { Badge } from '@/components/ui/badge';
import { requireAuditor } from '@/lib/auditor-server';
import { canWrite } from '@/lib/officer-server';
import { LogoMark } from '@/components/logo';

export const dynamic = 'force-dynamic';

/** Everything under /auditor is behind one check: the audit.read permission (the auditor and a lead hold it). */
export default async function AuditorLayout({ children }: { children: ReactNode }) {
  const user = await requireAuditor();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-border bg-card">
        <div className="mx-auto flex h-12 w-full max-w-[1600px] items-center gap-4 px-4">
          <p className="flex items-center gap-2 text-sm font-semibold tracking-widest text-primary uppercase">
            <LogoMark />
            KYC Setu · Audit
          </p>
          <AuditorNav canOfficer={canWrite(user.role)} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline" data-testid="officer-email">
              {user.email}
            </span>
            <Badge tone="info">
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
