import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env } from '@/lib/env';
import { getCustomerStatus } from '@/lib/kyc-server';

export const dynamic = 'force-dynamic';

/** Approved. Deliberately plain: this is a bank. */
export default async function KycDonePage() {
  const status = await getCustomerStatus();
  if (!status) redirect('/kyc');
  if (status.status !== 'APPROVED') redirect('/kyc/status');
  const approvedOn = (status.decidedAt ?? status.updatedAt).slice(0, 10);
  return (
    <Card data-testid="kyc-done">
      <CardHeader>
        <CardTitle>Your KYC is approved</CardTitle>
        <CardDescription>You don’t need to do anything else.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Reference</dt>
          <dd className="font-mono font-medium" data-testid="reference-id">
            {status.referenceId}
          </dd>
          <dt className="text-muted-foreground">Approved on</dt>
          <dd data-testid="approved-on">{approvedOn}</dd>
        </dl>
        <Button asChild size="lg" variant="outline" className="w-full">
          <a
            href={`${env.NEXT_PUBLIC_API_URL}/kyc/sessions/${status.sessionId}/approval-slip`}
            data-testid="download-slip"
          >
            Download approval slip
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          The slip is a one-page confirmation with your reference and the approval date.
        </p>
      </CardContent>
    </Card>
  );
}
