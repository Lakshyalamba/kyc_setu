import { notFound, redirect } from 'next/navigation';
import { ExportPanel } from '@/components/auditor/export-panel';
import { canExport, requireAuditor } from '@/lib/auditor-server';

export const dynamic = 'force-dynamic';

export default async function ExportRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuditor();
  if (!canExport(user.role)) redirect('/auditor');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <ExportPanel sessionId={id} />;
}
