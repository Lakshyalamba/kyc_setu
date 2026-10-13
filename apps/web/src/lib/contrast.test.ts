/**
 * WCAG AA for the colour tokens, in both themes, checked from the CSS itself (src/app/globals.css) rather than from a
 * screenshot: every pair of text and surface the app puts together must reach 4.5:1 (3:1 for large or bold UI text, which
 * only the risk dots use). If you change a token, this tells you what you broke.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

/** The `--name: value;` declarations inside the first block that follows `marker`. */
function tokens(marker: RegExp): Record<string, string> {
  const m = marker.exec(css);
  if (!m) throw new Error(`no block ${marker}`);
  let depth = 0;
  let i = css.indexOf('{', m.index);
  const start = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) break;
  }
  const body = css.slice(start, i);
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]),
  );
}

type RGB = [number, number, number]; // linear-light sRGB, 0..1

function oklch(value: string): RGB {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}

const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `top` at `alpha` over `bottom`, mixed in linear light (close enough to what the browser does for these tints). */
const over = (top: RGB, alpha: number, bottom: RGB): RGB =>
  top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as RGB;

const WHITE: RGB = [1, 1, 1];

const themes = {
  light: tokens(/:root\s*\{/),
  dark: {
    ...tokens(/:root\s*\{/),
    ...tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/),
  },
} as const;

for (const [name, t] of Object.entries(themes)) {
  const c = (token: string) =>
    oklch(
      t[`--${token}`] ??
        (() => {
          throw new Error(`--${token} is not defined`);
        })(),
    );

  describe(`${name} theme`, () => {
    const pairs: [string, RGB, RGB, number][] = [];
    const add = (label: string, fg: RGB, bg: RGB, min = 4.5) => pairs.push([label, fg, bg, min]);

    for (const surface of ['background', 'card', 'secondary'])
      add(
        `text on ${surface}`,
        c(surface === 'secondary' ? 'secondary-foreground' : 'foreground'),
        c(surface),
      );
    for (const surface of ['background', 'card', 'secondary'])
      add(`muted text on ${surface}`, c('muted-foreground'), c(surface));
    add('primary button label', c('primary-foreground'), c('primary'));
    for (const surface of ['background', 'card'])
      add(`primary as text on ${surface}`, c('primary'), c(surface));
    add(
      'primary info badge (primary on 10% primary)',
      c('primary'),
      over(c('primary'), 0.1, c('card')),
    );
    for (const surface of ['background', 'card'])
      add(`destructive text on ${surface}`, c('destructive'), c(surface));

    for (const band of ['high', 'medium', 'low']) {
      for (const surface of ['background', 'card'])
        add(`risk-${band} text on ${surface}`, c(`risk-${band}`), c(surface));
      add(
        `risk-${band} badge (text on its own 10% tint)`,
        c(`risk-${band}`),
        over(c(`risk-${band}`), 0.1, c('card')),
      );
      add(`white label on the filled ${band} button`, WHITE, c(`risk-${band}-solid`));
    }
    for (const tone of ['success', 'info', 'warning', 'danger'])
      add(`${tone} status chip`, c(`${tone}-foreground`), c(`${tone}-soft`));

    it.each(pairs)('%s', (label, fg, bg, min) => {
      expect(contrast(fg, bg), `${label}: ${contrast(fg, bg).toFixed(2)}:1`).toBeGreaterThanOrEqual(
        min,
      );
    });
  });
}
