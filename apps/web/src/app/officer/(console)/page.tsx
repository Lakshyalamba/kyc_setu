import { QueueView } from '@/components/officer/queue-view';
import { canWrite, requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

export default async function OfficerQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string }>;
}) {
  const user = await requireOfficer();
  const { decided } = await searchParams;
  return <QueueView viewerId={user.id} canWrite={canWrite(user.role)} decided={decided ?? null} />;
}
