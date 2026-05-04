/** brand.ts — FOM brand tokens shared across the composition.
 *
 *  Why centralised: the kiosk's palette + type stack lives in config/brand.json
 *  on the actual install. The video composition mirrors those values so the
 *  marketing piece looks like the product, not generic motion graphics.
 *  If FOM ever rebrands, swap these tokens + every scene re-skins.
 */
export const COLOR = {
  red:        '#E10600',
  redDeep:    '#8F0003',
  redGlow:    'rgba(225,6,0,0.55)',
  redTint:    'rgba(225,6,0,0.06)',
  ink0:       '#000000',
  ink1:       '#0a0a0a',
  ink2:       '#141414',
  ink3:       '#1c1c1c',
  text:       '#f4f4f4',
  textDim:    'rgba(244, 244, 244, 0.55)',
  textMuted:  'rgba(244, 244, 244, 0.35)',
  line:       'rgba(255, 255, 255, 0.12)',
  lineBright: 'rgba(255, 255, 255, 0.24)',
  green:      '#00ff88',
  yellow:     '#F8E71C',
} as const;

/* Type stacks: Oswald = display, Rubik = body, JetBrains Mono = numerals.
 * @remotion/google-fonts/Oswald (etc) is loaded in FlatOutOverview.tsx. */
export const FONT = {
  display: "'Oswald', system-ui, sans-serif",
  body:    "'Rubik', system-ui, sans-serif",
  mono:    "'JetBrains Mono', 'SF Mono', Menlo, monospace",
} as const;

/* Common SVG-clip shape used on most branded panels — the FOM "blade" cut.
 * Top-left + bottom-right corners are clipped to a 14px diagonal so panels
 * feel framed without looking like rectangles. */
export const BLADE_CLIP = 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)';
