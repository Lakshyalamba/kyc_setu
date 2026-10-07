'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

const MIN = 1;
const MAX = 6;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A plain CSS zoom/pan viewer: Ctrl/⌘ + wheel or the buttons zoom, drag pans once zoomed in. The children (the image and
 * its overlay) are laid out at the viewer's width and scaled together, so overlays stay glued to the picture.
 */
export function ZoomPanViewer({ children, label }: { children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  /** Zoom around a point (in viewer pixels) so that point stays under the pointer. */
  function zoomAt(factor: number, cx: number, cy: number) {
    setView((v) => {
      const scale = clamp(v.scale * factor, MIN, MAX);
      if (scale === MIN) return { scale, x: 0, y: 0 };
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls the page
      e.preventDefault();
      const r = el!.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const centre = () => {
    const r = box.current?.getBoundingClientRect();
    return { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={box}
        role="group"
        aria-label={`${label} viewer`}
        data-testid="zoom-viewer"
        data-scale={view.scale.toFixed(2)}
        style={{ touchAction: 'none' }}
        className="relative overflow-hidden rounded border border-border bg-secondary/60"
        onPointerDown={(e) => {
          if (view.scale === 1) return;
          if ((e.target as HTMLElement).closest('button')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const r = e.currentTarget.getBoundingClientRect();
          // Keep the picture covering the viewer: it may not be dragged off to reveal empty space.
          setView((v) => ({
            ...v,
            x: clamp(d.x + e.clientX - d.px, r.width - r.width * v.scale, 0),
            y: clamp(d.y + e.clientY - d.py, r.height - r.height * v.scale, 0),
          }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (view.scale > 1) setView({ scale: 1, x: 0, y: 0 });
          else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
        }}
      >
        <div
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            cursor: view.scale > 1 ? 'grab' : 'zoom-in',
          }}
          className="w-full"
        >
          {children}
        </div>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 w-7 px-0"
          aria-label="Zoom out"
          onClick={() => zoomAt(1 / 1.4, centre().x, centre().y)}
        >
          −
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 w-7 px-0"
          aria-label="Zoom in"
          onClick={() => zoomAt(1.4, centre().x, centre().y)}
        >
          +
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => setView({ scale: 1, x: 0, y: 0 })}
        >
          Reset
        </Button>
        <span className="ml-1 tabular-nums">{Math.round(view.scale * 100)}%</span>
        <span className="ml-auto hidden lg:inline">Ctrl/⌘ + scroll to zoom · drag to pan</span>
      </div>
    </div>
  );
}
