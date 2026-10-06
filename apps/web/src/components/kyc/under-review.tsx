import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The last screen of the customer flow. It says nothing about the outcome of any automated checks: a risk
 * assessment is for the bank's officers, and the customer only needs to know a person will look at it.
 */
export function UnderReview() {
  return (
    <Card data-testid="under-review">
      <CardHeader>
        <CardTitle>Your application is under review</CardTitle>
        <CardDescription>We have everything we need.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          A bank officer will review your KYC application. This usually doesn’t need anything more
          from you.
        </p>
        <p>If we need something else, we’ll tell you here and by email.</p>
      </CardContent>
    </Card>
  );
}
