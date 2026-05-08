/** brand.ts — Jarvis brand tokens shared across the composition.
 *
 *  Why centralised: the kiosk's palette + type stack lives in config/brand.json
 *  on the actual install. The video composition mirrors those values so the
 *  marketing piece looks like the product, not generic motion graphics.
 *  Re-skin: swap these tokens + every scene re-skins.
 */
export const COLOR = {
  cyan:       '#00d4ff',
  cyanDeep:   '#0077a8',
  cyanGlow:   'rgba(0,212,255,0.55)',
  cyanTint:   'rgba(0,212,255,0.06)',
  ink0:       '#02060c',
  ink1:       '#060c16',
  ink2:       '#0a131f',
  ink3:       '#0f1a28',
  text:       '#e8f4ff',
  textDim:    'rgba(232, 244, 255, 0.55)',
  textMuted:  'rgba(232, 244, 255, 0.35)',
  line:       'rgba(0, 212, 255, 0.18)',
  lineBright: 'rgba(0, 212, 255, 0.32)',
  green:      '#00ff88',
  yellow:     '#F8E71C',
} as const;

/* Type stacks: Oswald = display, Rubik = body, JetBrains Mono = numerals.
 * @remotion/google-fonts/Oswald (etc) is loaded in JarvisOverview.tsx. */
export const FONT = {
  display: "'Oswald', system-ui, sans-serif",
  body:    "'Rubik', system-ui, sans-serif",
  mono:    "'JetBrains Mono', 'SF Mono', Menlo, monospace",
} as const;

/* Common SVG-clip shape used on most branded panels — the Jarvis "blade" cut.
 * Top-left + bottom-right corners are clipped to a 14px diagonal so panels
 * feel framed without looking like rectangles. */
export const BLADE_CLIP = 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)';
