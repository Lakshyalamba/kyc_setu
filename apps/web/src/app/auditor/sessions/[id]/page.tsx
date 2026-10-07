import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ReviewPage } from '@/components/officer/review/review-page';
import { canExport, requireAuditor } from '@/lib/auditor-server';

export const dynamic = 'force-dynamic';

/**
 * The review page, as the auditor sees it: the same components over the same masked payload, with no claim, no
 * decision buttons and no reveal. A lead opening it here gets the same read-only view.
 */
export default async function AuditorReviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuditor();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return (
    <ReviewPage
      sessionId={id}
      canWrite={false}
      readOnly
      backHref="/auditor/sessions"
      backLabel="Sessions"
      headerExtra={
        canExport(user.role) ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/auditor/sessions/${id}/export`} data-testid="open-export">
              Export packet
            </Link>
          </Button>
        ) : null
      }
    />
  );
}
