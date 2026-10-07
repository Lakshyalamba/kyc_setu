'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/officer', label: 'Queue', match: (p: string) => p === '/officer' },
  { href: '/officer/me', label: 'My reviews', match: (p: string) => p.startsWith('/officer/me') },
];

export function OfficerNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Officer" className="flex items-center gap-1">
      {LINKS.map((l) => (
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
