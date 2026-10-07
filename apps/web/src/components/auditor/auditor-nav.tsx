'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/auditor', label: 'Overview', match: (p: string) => p === '/auditor' },
  {
    href: '/auditor/chain',
    label: 'Chain integrity',
    match: (p: string) => p.startsWith('/auditor/chain'),
  },
  {
    href: '/auditor/sessions',
    label: 'Sessions',
    match: (p: string) => p.startsWith('/auditor/sessions'),
  },
];

export function AuditorNav({ canOfficer }: { canOfficer: boolean }) {
  const pathname = usePathname();
  const links = canOfficer
    ? [...LINKS, { href: '/officer', label: 'Review queue', match: () => false }]
    : LINKS;
  return (
    <nav aria-label="Auditor" className="flex items-center gap-1">
      {links.map((l) => (
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
      ))}
    </nav>
  );
}
