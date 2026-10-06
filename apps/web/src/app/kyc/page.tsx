import { redirect } from 'next/navigation';
import { StartKyc } from '@/components/kyc/start-kyc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentKycSession, requireCustomer } from '@/lib/kyc-server';
import { stepPath } from '@/lib/kyc-steps';

export const dynamic = 'force-dynamic';

export default async function KycIndexPage() {
  await requireCustomer();
  const session = await getCurrentKycSession();
  // Resume: send the customer to wherever they left off.
  if (session) redirect(stepPath(session.currentStep));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Let’s verify your identity</CardTitle>
        <CardDescription>
          It takes a few minutes. Keep your mobile phone, PAN and Aadhaar handy. You can stop at any
          point and pick up where you left off.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StartKyc />
      </CardContent>
    </Card>
  );
}
