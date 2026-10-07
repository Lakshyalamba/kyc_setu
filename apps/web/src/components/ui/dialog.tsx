'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A modal on the platform's own <dialog>: focus is trapped, Escape closes, and the page behind is inert, without
 * any dependency. `onClose` runs for Escape and for the backdrop.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={`${testId ?? 'dialog'}-title`}
      onCancel={(e) => {
        e.preventDefault(); // we close through state, so the two can't disagree
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the backdrop, not on the content
      }}
      className={cn(
        'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/40',
        className,
      )}
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="space-y-1">
            <h2 id={`${testId ?? 'dialog'}-title`} className="text-lg font-semibold">
              {title}
            </h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
