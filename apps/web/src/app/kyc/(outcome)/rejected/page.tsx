import { redirect } from 'next/navigation';
import { REASON_CODE_LABELS } from '@kyc-setu/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCustomerStatus } from '@/lib/kyc-server';

export const dynamic = 'force-dynamic';

/** Rejected: the reason and the officer's note, and nothing to click. */
export default async function KycRejectedPage() {
  const status = await getCustomerStatus();
  if (!status) redirect('/kyc');
  if (status.status !== 'REJECTED') redirect('/kyc/status');
  return (
    <Card data-testid="kyc-rejected">
      <CardHeader>
        <CardTitle>We couldn’t approve your KYC</CardTitle>
        <CardDescription>
          This application can’t go any further. If you think this is a mistake, please contact your
          bank.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.reasonCode && (
          <p>
            <span className="text-muted-foreground">Reason: </span>
            <span className="font-medium" data-testid="rejection-reason">
              {REASON_CODE_LABELS[status.reasonCode]}
            </span>
          </p>
        )}
        {status.reasonNote && (
          <blockquote
            className="rounded-md border-l-4 border-border bg-secondary px-3 py-2"
            data-testid="officer-note"
          >
            {status.reasonNote}
          </blockquote>
        )}
        <p className="text-xs text-muted-foreground" data-testid="reference-id">
          Reference {status.referenceId}
        </p>
      </CardContent>
    </Card>
  );
}
