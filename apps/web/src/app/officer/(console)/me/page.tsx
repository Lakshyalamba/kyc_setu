import { MyReviews } from '@/components/officer/my-reviews';
import { requireOfficer } from '@/lib/officer-server';

export const dynamic = 'force-dynamic';

export default async function MyReviewsPage() {
  await requireOfficer();
  return <MyReviews />;
}
