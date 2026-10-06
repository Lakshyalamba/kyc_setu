import type { KycStep } from '@kyc-setu/shared';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { STEP_LABEL } from '@/lib/kyc-steps';

export function ComingNext({ step }: { step: KycStep }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coming next</CardTitle>
        <CardDescription>
          The “{STEP_LABEL[step]}” step isn’t available yet. Your progress so far is saved, so you
          can come back and continue any time.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
