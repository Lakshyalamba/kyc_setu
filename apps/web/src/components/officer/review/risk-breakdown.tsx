'use client';

import { useState } from 'react';
import { Badge, RiskPill } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { CATEGORY_LABELS, formatDateTime, ruleLabel } from '@/lib/format';
import { useReview } from './review-context';

export function RiskBreakdown() {
  const { payload } = useReview();
  const risk = payload.risk;
  const [open, setOpen] = useState<string | null>(null);

  if (!risk) {
    return (
      <Card data-testid="risk-breakdown">
        <CardContent className="space-y-1 p-4">
          <h2 className="text-sm font-semibold">Risk</h2>
          <p className="text-sm text-muted-foreground">
            No risk assessment has been recorded for this application.
          </p>
        </CardContent>
      </Card>
    );
  }

  const triggeredIds = new Set(risk.triggeredRules.map((t) => t.ruleId));
  const passed = risk.appliedRules.filter((r) => !triggeredIds.has(r));
  const floor = risk.rawBand !== risk.band;

  return (
    <Card data-testid="risk-breakdown">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Risk</h2>
          <RiskPill band={risk.band} className="text-sm" />
          <span
            className="text-2xl leading-none font-semibold tabular-nums"
            data-testid="risk-score"
          >
            {risk.score}
            <span className="text-sm font-normal text-muted-foreground">/100</span>
          </span>
          <span
            className="ml-auto text-xs text-muted-foreground"
            title={`Computed ${formatDateTime(risk.createdAt)} (${risk.trigger.toLowerCase()})`}
          >
            engine v{risk.engineVersion}
          </span>
        </div>

        {risk.hardFail && (
          <p
            role="alert"
            className="rounded border border-risk-high/40 bg-risk-high/10 px-2 py-1 text-xs font-medium text-risk-high"
          >
            Hard fail: this application cannot be approved while the rule below applies.
          </p>
        )}
        {floor && (
          <p className="text-xs text-muted-foreground">
            The score alone would be {risk.rawBand}; a rule below raises the band to {risk.band}.
          </p>
        )}

        {risk.triggeredRules.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-triggered-rules">
            No rule was triggered.
          </p>
        ) : (
          <ul
            className="divide-y divide-border rounded border border-border"
            data-testid="triggered-rules"
          >
            {risk.triggeredRules.map((t) => (
              <li key={t.ruleId} className="space-y-1 px-3 py-2" data-testid={`rule-${t.ruleId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{ruleLabel(t.ruleId)}</span>
                  <Badge>{CATEGORY_LABELS[t.category] ?? t.category}</Badge>
                  <span className="ml-auto text-sm font-semibold tabular-nums text-risk-high">
                    +{t.penalty}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{t.reason}</p>
                {t.details && Object.keys(t.details).length > 0 && (
                  <>
                    <button
                      type="button"
                      className="text-xs text-primary underline"
                      aria-expanded={open === t.ruleId}
                      onClick={() => setOpen(open === t.ruleId ? null : t.ruleId)}
                    >
                      {open === t.ruleId ? 'Hide details' : 'Details'}
                    </button>
                    {open === t.ruleId && (
                      <pre className="max-h-48 overflow-auto rounded bg-secondary p-2 text-xs">
                        {JSON.stringify(t.details, null, 2)}
                      </pre>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <details className="text-sm" data-testid="passed-rules">
          <summary className="cursor-pointer text-muted-foreground">
            {passed.length} rule{passed.length === 1 ? '' : 's'} passed
            {risk.skippedRules.length > 0 && `, ${risk.skippedRules.length} skipped`}
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {passed.map((r) => (
              <li key={r}>✓ {ruleLabel(r)}</li>
            ))}
            {risk.skippedRules.map((s) => (
              <li key={s.ruleId}>
                – {ruleLabel(s.ruleId)} <span className="opacity-70">(skipped: {s.reason})</span>
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
