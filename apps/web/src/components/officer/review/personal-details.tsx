'use client';

import { formatAadhaar, type ComparisonRow } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime, humanize, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ConsentPanel } from './consent-panel';
import { useReview } from './review-context';

function MismatchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-risk-high"
      fill="currentColor"
    >
      <path d="M8 1 .5 14.5h15L8 1Zm-.75 5h1.5v4.5h-1.5V6Zm0 5.75h1.5v1.5h-1.5v-1.5Z" />
    </svg>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export function PersonalDetailsCard() {
  const { payload, selected, select, revealed, reveal, hideReveal, revealError, canReveal } =
    useReview();
  const p = payload.customer.personal;
  const rows = payload.comparison;

  const isSelected = (row: ComparisonRow) =>
    !!selected &&
    row.refs.some((r) => r.documentId === selected.documentId && r.fieldKey === selected.fieldKey);

  const aadhaarShown = revealed?.value ?? null;
  const who = (name: string | null) =>
    name === payload.viewer.displayName ? 'you' : (name ?? 'an officer');
  const lastReveal = revealed
    ? { by: who(revealed.by), at: revealed.at }
    : payload.reveal.lastRevealedAt
      ? { by: who(payload.reveal.lastRevealedBy), at: payload.reveal.lastRevealedAt }
      : null;

  return (
    <Card data-testid="personal-details">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Personal details</h2>
          <span className="text-xs text-muted-foreground">
            typed by the customer vs read from the documents
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="comparison-table">
            <thead className="text-left text-xs text-muted-foreground uppercase">
              <tr>
                <th className="py-1 pr-3 font-medium">Field</th>
                <th className="py-1 pr-3 font-medium">Typed</th>
                <th className="py-1 pr-3 font-medium">PAN card</th>
                <th className="py-1 font-medium">Aadhaar card</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const mismatch = row.status === 'MISMATCH';
                return (
                  <tr
                    key={row.field}
                    data-testid={`row-${row.field}`}
                    data-status={row.status}
                    data-highlighted={isSelected(row)}
                    onClick={() => {
                      const ref = row.refs[0];
                      if (ref) select(isSelected(row) ? null : ref);
                    }}
                    className={cn(
                      'border-l-2 border-t border-transparent align-top',
                      row.refs.length > 0 && 'cursor-pointer',
                      mismatch && 'border-l-risk-high bg-risk-high/5',
                      isSelected(row) &&
                        'bg-primary/10 outline-2 -outline-offset-2 outline-primary',
                    )}
                  >
                    <th scope="row" className="py-1.5 pr-3 pl-2 text-left font-medium">
                      <span className="flex items-center gap-1.5">
                        {mismatch && <MismatchIcon />}
                        {row.label}
                      </span>
                      {mismatch && <span className="sr-only">does not match</span>}
                      {row.similarity !== null && row.status !== 'UNAVAILABLE' && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          similarity {Math.round(row.similarity * 100)}%
                        </span>
                      )}
                    </th>
                    <td className="py-1.5 pr-3" data-testid={`typed-${row.field}`}>
                      {row.field === 'aadhaar' ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className="font-mono"
                            data-testid="aadhaar-typed"
                            data-revealed={!!aadhaarShown}
                          >
                            {aadhaarShown ? formatAadhaar(aadhaarShown) : (row.typed ?? dash)}
                          </span>
                          {canReveal && !aadhaarShown && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs"
                              data-testid="reveal-aadhaar"
                              onClick={(e) => {
                                e.stopPropagation();
                                void reveal();
                              }}
                            >
                              Reveal
                            </Button>
                          )}
                          {aadhaarShown && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideReveal();
                              }}
                            >
                              Hide
                            </Button>
                          )}
                        </span>
                      ) : (
                        (row.typed ?? dash)
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{row.fromPan ?? dash}</td>
                    <td className="py-1.5">{row.fromAadhaar ?? dash}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {revealError && (
          <p role="alert" className="text-sm text-destructive">
            {revealError}
          </p>
        )}
        {lastReveal && (
          <p className="text-xs text-muted-foreground" data-testid="last-revealed">
            Aadhaar number last revealed by {lastReveal.by} at {formatDateTime(lastReveal.at)} (
            {timeAgo(lastReveal.at)})
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-sm md:grid-cols-3">
          {(
            [
              ['Gender', p.gender ? humanize(p.gender) : null],
              ['Mobile', p.mobileMasked ?? null],
              ['Email', p.email ?? null],
              ['Occupation', p.occupation ? humanize(p.occupation) : null],
              ['Annual income', p.annualIncome ? humanize(p.annualIncome) : null],
              [
                'Address',
                p.address
                  ? [
                      p.address.line1,
                      p.address.line2,
                      p.address.city,
                      p.address.state,
                      p.address.pincode,
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : null,
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={label === 'Address' ? 'col-span-2 md:col-span-3' : ''}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd>{value ?? dash}</dd>
            </div>
          ))}
        </dl>
        <ConsentPanel />
      </CardContent>
    </Card>
  );
}
