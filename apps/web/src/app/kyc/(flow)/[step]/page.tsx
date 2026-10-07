import { notFound } from 'next/navigation';
import { ComingNext } from '@/components/kyc/coming-next';
import { ConsentStep } from '@/components/kyc/consent-step';
import { ContactStep } from '@/components/kyc/contact-step';
import { StatusView } from '@/components/kyc/status-view';
import { PersonalStep } from '@/components/kyc/personal-step';
import { DocumentsStep } from '@/components/kyc/documents-step';
import {
  getCurrentConsent,
  getCustomerStatus,
  getSessionDocuments,
  requireStep,
} from '@/lib/kyc-server';
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
    case 'DOCUMENTS': {
      // After an officer asks for specific documents again, only those slots open.
      const resubmit = session.status === 'RESUBMIT_REQUESTED' ? await getCustomerStatus() : null;
      return (
        <DocumentsStep
          key={session.id}
          session={session}
          initialDocuments={await getSessionDocuments(session.id)}
          resubmit={
            resubmit
              ? {
                  types: resubmit.resubmitDocumentTypes,
                  reasonCode: resubmit.reasonCode,
                  note: resubmit.reasonNote,
                }
              : null
          }
        />
      );
    }
    case 'REVIEW': {
      const status = await getCustomerStatus();
      if (!status) notFound();
      return <StatusView initial={status} />;
    }
    default:
      return <ComingNext step={step} />;
  }
}
