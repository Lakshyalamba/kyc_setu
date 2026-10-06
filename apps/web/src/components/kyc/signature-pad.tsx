'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Points are stored normalised (0..1) so the same strokes render at any size, including the export. */
type Point = { x: number; y: number };

export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 200;

function paint(
  ctx: CanvasRenderingContext2D,
  strokes: Point[][],
  width: number,
  height: number,
  lineWidth: number,
) {
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#111827';
  ctx.fillStyle = '#111827';
  for (const stroke of strokes) {
    const first = stroke[0];
    if (!first) continue;
    if (stroke.length === 1) {
      ctx.beginPath();
      ctx.arc(first.x * width, first.y * height, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x * width, first.y * height);
    for (const p of stroke.slice(1)) ctx.lineTo(p.x * width, p.y * height);
    ctx.stroke();
  }
}

export function SignaturePad({ onUse, busy }: { onUse: (png: Blob) => void; busy?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [strokeCount, setStrokeCount] = useState(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    paint(
      ctx,
      strokes.current,
      canvas.width,
      canvas.height,
      2.5 * (canvas.width / SIGNATURE_WIDTH) * 1.2,
    );
  }, []);

  // Match the backing store to the displayed size (and device pixel ratio) so lines stay crisp.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  const pointOf = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
    };
  };

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([pointOf(e)]);
    setStrokeCount(strokes.current.length);
    redraw();
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    strokes.current.at(-1)?.push(pointOf(e));
    redraw();
  }
  function onUp() {
    drawing.current = false;
  }

  function undo() {
    strokes.current.pop();
    setStrokeCount(strokes.current.length);
    redraw();
  }
  function clear() {
    strokes.current = [];
    setStrokeCount(0);
    redraw();
  }

  function use() {
    // Always export a fixed 600x200 transparent PNG, regardless of how big the pad was on screen.
    const out = document.createElement('canvas');
    out.width = SIGNATURE_WIDTH;
    out.height = SIGNATURE_HEIGHT;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    paint(ctx, strokes.current, SIGNATURE_WIDTH, SIGNATURE_HEIGHT, 3);
    out.toBlob((blob) => blob && onUse(blob), 'image/png');
  }

  return (
    <div className="flex flex-col gap-3">
      <canvas
        ref={canvasRef}
        data-testid="signature-canvas"
        aria-label="Signature drawing area"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        // touch-action: none stops the page scrolling while the finger draws
        style={{ touchAction: 'none', aspectRatio: `${SIGNATURE_WIDTH} / ${SIGNATURE_HEIGHT}` }}
        className="w-full cursor-crosshair rounded-md border border-dashed border-input bg-white"
      />
      <p className="text-xs text-muted-foreground">
        Sign inside the box with your finger, mouse or pen.
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={undo}
          disabled={strokeCount === 0}
        >
          Undo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clear}
          disabled={strokeCount === 0}
        >
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={use}
          disabled={strokeCount === 0 || busy}
        >
          Use this signature
        </Button>
      </div>
    </div>
  );
}
