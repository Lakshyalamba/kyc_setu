'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { okResponseSchema } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

export function LogoutButton({ realm }: { realm: 'customer' | 'officer' }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await apiFetch(`/auth/logout?realm=${realm}`, { method: 'POST', schema: okResponseSchema });
    } finally {
      router.push(realm === 'officer' ? '/officer/login' : '/');
      router.refresh();
    }
  }

  return (
    <Button variant="outline" onClick={logout} disabled={pending}>
      Log out
    </Button>
  );
}
