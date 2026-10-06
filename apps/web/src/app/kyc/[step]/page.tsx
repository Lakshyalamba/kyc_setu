import { notFound } from 'next/navigation';
import { ComingNext } from '@/components/kyc/coming-next';
import { ConsentStep } from '@/components/kyc/consent-step';
import { ContactStep } from '@/components/kyc/contact-step';
import { PersonalStep } from '@/components/kyc/personal-step';
import { getCurrentConsent, requireStep } from '@/lib/kyc-server';
import { stepFromSlug } from '@/lib/kyc-steps';

export const dynamic = 'force-dynamic';

export default async function KycStepPage({ params }: { params: Promise<{ step: string }> }) {
  const { step: slug } = await params;
  const step = stepFromSlug(slug);
  if (!step) notFound();

  // Redirects to the session's real current step if this isn't it.
  const session = await requireStep(step);

  switch (step) {
    case 'CONTACT':
      return <ContactStep session={session} />;
    case 'CONSENT':
      return <ConsentStep session={session} consent={await getCurrentConsent()} />;
    case 'PERSONAL':
      return <PersonalStep key={session.id} session={session} />;
    default:
      return <ComingNext step={step} />;
  }
}
