import { redirect } from 'next/navigation';
import { AdminPanel } from '@/components/officer/admin-panel';
import { canManage, requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

/** Lead-only. A form and a button: the full admin area is later. */
export default async function AdminPage() {
  const user = await requireOfficer();
  if (!canManage(user.role)) redirect('/officer');
  return <AdminPanel />;
}
