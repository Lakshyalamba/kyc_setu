import type { KycSessionDto } from '@kyc-setu/shared';
import { cn } from '@/lib/utils';
import { STEP_LABEL, STEP_ORDER } from '@/lib/kyc-steps';

export function Stepper({ session }: { session: KycSessionDto | null }) {
  const current = session?.currentStep ?? 'CONTACT';
  const index = STEP_ORDER.indexOf(current);
  return (
    <nav aria-label="KYC progress" className="space-y-2">
      <p className="text-sm font-medium">
        Step {index + 1} of {STEP_ORDER.length}
        <span className="text-muted-foreground"> · {STEP_LABEL[current]}</span>
      </p>
      <ol className="flex gap-1.5">
        {STEP_ORDER.map((step, i) => {
          const done = session?.completedSteps.includes(step) ?? false;
          return (
            <li
              key={step}
              aria-current={step === current ? 'step' : undefined}
              title={STEP_LABEL[step]}
              className={cn(
                'h-1.5 flex-1 rounded-full',
                done ? 'bg-primary' : i === index ? 'bg-primary/50' : 'bg-border',
              )}
            />
          );
        })}
      </ol>
    </nav>
  );
}
