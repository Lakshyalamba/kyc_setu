import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCheckpoints } from '@/lib/auditor-server';
import { formatDateTime, timeAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function AuditorHome() {
  const { last } = await getCheckpoints();
  return (
    <div className="flex flex-col gap-4" data-testid="auditor-home">
      <h1 className="text-lg font-semibold">Audit</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-chain">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Chain integrity</CardTitle>
            <CardDescription>
              The audit log is chained day by day. Verify that no row has been changed, removed or
              slipped in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0 text-sm">
            <p data-testid="last-run">
              {last ? (
                <>
                  Last day chained: <strong>{last.chainDate}</strong> ({last.rowCount} rows), built{' '}
                  <span title={formatDateTime(last.computedAt)}>{timeAgo(last.computedAt)}</span>.
                </>
              ) : (
                'No day has been chained yet. The nightly job runs at 00:05 IST.'
              )}
            </p>
            <Link
              href="/auditor/chain"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Verify the chain →
            </Link>
          </CardContent>
        </Card>
        <Card data-testid="card-sessions">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Session search</CardTitle>
            <CardDescription>
              Every application in any state: under review, approved, rejected, expired. Read-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">
            <Link
              href="/auditor/sessions"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Search sessions →
            </Link>
          </CardContent>
        </Card>
        <Card data-testid="card-export">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Export</CardTitle>
            <CardDescription>
              A signed ZIP with everything about one session, checkable offline with the script
              inside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-sm">
            <Link
              href="/auditor/sessions"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Pick a session to export →
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
