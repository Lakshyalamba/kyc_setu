'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/officer', label: 'Queue', match: (p: string) => p === '/officer' },
  { href: '/officer/me', label: 'My reviews', match: (p: string) => p.startsWith('/officer/me') },
];
const AUDIT_LINK = { href: '/auditor', label: 'Audit', match: () => false };
const ADMIN_LINK = {
  href: '/officer/admin',
  label: 'Accounts',
  match: (p: string) => p.startsWith('/officer/admin'),
};

export function OfficerNav({
  canManage = false,
  canAudit = false,
}: {
  canManage?: boolean;
  canAudit?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Officer" className="flex items-center gap-1">
      {[...LINKS, ...(canManage ? [ADMIN_LINK] : []), ...(canAudit ? [AUDIT_LINK] : [])].map(
        (l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={l.match(pathname) ? 'page' : undefined}
            className={cn(
              'rounded px-2.5 py-1.5 text-sm font-medium hover:bg-secondary',
              l.match(pathname) ? 'bg-secondary text-foreground' : 'text-muted-foreground',
            )}
          >
            {l.label}
          </Link>
        ),
      )}
    </nav>
  );
}
