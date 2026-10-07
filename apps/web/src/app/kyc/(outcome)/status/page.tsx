import { redirect } from 'next/navigation';
import { StatusView } from '@/components/kyc/status-view';
import { getCustomerStatus } from '@/lib/kyc-server';

export const dynamic = 'force-dynamic';

export default async function KycStatusPage() {
  const status = await getCustomerStatus();
  if (!status) redirect('/kyc');
  // The final outcomes have their own pages.
  if (status.status === 'APPROVED') redirect('/kyc/done');
  if (status.status === 'REJECTED') redirect('/kyc/rejected');
  return <StatusView initial={status} />;
}
