import { redirect } from 'next/navigation';
import { LogoutButton } from '@/components/logout-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionUser } from '@/lib/api-server';

export const dynamic = 'force-dynamic';

export default async function KycPage() {
  const user = await getSessionUser('customer');
  if (!user) redirect('/login');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5 py-10">
      <Card>
        <CardHeader>
          <CardTitle>KYC flow coming soon</CardTitle>
          <CardDescription>Signed in as {user.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <LogoutButton realm="customer" />
        </CardContent>
      </Card>
    </main>
  );
}
