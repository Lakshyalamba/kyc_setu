import { notFound } from 'next/navigation';
import { ReviewPage } from '@/components/officer/review/review-page';
import { canWrite, requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

/**
 * Server shell only: the review payload is fetched in the browser, so a full Aadhaar number can never end up in
 * server-rendered HTML (the payload doesn't contain one, and the reveal result lives in client state).
 */
export default async function ReviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOfficer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <ReviewPage sessionId={id} canWrite={canWrite(user.role)} />;
}
