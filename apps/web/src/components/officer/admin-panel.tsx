'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { lockoutsResponseSchema } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { adminApi } from '@/lib/officer-api';
import { formatDateTime } from '@/lib/format';

type Lockouts = z.infer<typeof lockoutsResponseSchema>['lockouts'];

/** Accounts locked after too many wrong passwords, and a way to lift a lock. */
export function AdminPanel() {
  const [lockouts, setLockouts] = useState<Lockouts | null>(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      setLockouts((await adminApi.lockouts()).lockouts);
    } catch {
      setMessage({ ok: false, text: 'Could not load the locked accounts.' });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function unlock(address: string) {
    setPending(true);
    setMessage(null);
    try {
      const res = await adminApi.unlock(address);
      setMessage({ ok: true, text: `${res.email} can sign in again.` });
      setEmail('');
      await load();
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof ApiError ? err.message : 'Could not reach the server.',
      });
    } finally {
      setPending(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void unlock(email.trim());
  };

  return (
    <section className="flex max-w-2xl flex-col gap-4" data-testid="admin-panel">
      <h1 className="text-lg font-semibold">Accounts</h1>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
      >
        <Label htmlFor="unlock-email">Unlock an account</Label>
        <p className="text-xs text-muted-foreground">
          Five wrong passwords in half an hour lock an account for fifteen minutes. Unlocking lets
          the person try again at once, and is recorded against your name.
        </p>
        <div className="flex gap-2">
          <Input
            id="unlock-email"
            type="email"
            required
            placeholder="customer@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button
            type="submit"
            disabled={pending || email.trim() === ''}
            data-testid="unlock-submit"
          >
            Unlock
          </Button>
        </div>
        {message && (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={message.ok ? 'text-sm' : 'text-sm text-destructive'}
            data-testid="unlock-message"
          >
            {message.text}
          </p>
        )}
      </form>

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm" data-testid="lockouts-table">
          <thead className="border-b border-border bg-secondary/60 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Locked account</th>
              <th className="px-3 py-2 font-medium">Failed attempts</th>
              <th className="px-3 py-2 font-medium">Locked until</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {lockouts?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  No account is locked.
                </td>
              </tr>
            )}
            {lockouts?.map((l) => (
              <tr key={`${l.email}-${l.lockedAt}`} className="border-b border-border last:border-0">
                <td className="px-3 py-2">{l.email}</td>
                <td className="px-3 py-2 tabular-nums">{l.failedAttempts}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(l.lockedUntil)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void unlock(l.email)}
                  >
                    Unlock
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
