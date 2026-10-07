import { ChainVerify } from '@/components/auditor/chain-verify';
import { getCheckpoints } from '@/lib/auditor-server';

export const dynamic = 'force-dynamic';

export default async function ChainPage() {
  const { last } = await getCheckpoints();
  return <ChainVerify initialLast={last} />;
}
