/** components.tsx — re-usable HUD chrome elements for the FOM video.
 *
 *  Each export here mirrors a piece of the actual kiosk's chrome (calendar strip,
 *  blade mark, speedometer ring, panel frame, terminal frame). The video reuses
 *  them across scenes so the visual language reads as a single product, not nine
 *  unrelated graphics.
 */
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { COLOR, FONT, BLADE_CLIP } from './brand';

/** Eased clamped interpolation — every animation in the comp uses this. */
export const e = (
  frame: number,
  range: [number, number],
  output: [number, number],
  easing = Easing.out(Easing.cubic),
) => interpolate(frame, range, output, {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
  easing,
});

/* ────────── BACKDROP ──────────
 *  Black ink with a faint perspective-grid overlay + scanlines to mirror the
 *  HUD's idle backdrop. Pure CSS gradients — no images, sharp at any scale. */
export const Backdrop: React.FC = () => (
  <div style={{
    position: 'absolute', inset: 0,
    background: `radial-gradient(ellipse at center, ${COLOR.ink2} 0%, ${COLOR.ink0} 70%)`,
  }}>
    {/* Perspective grid */}
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: `
        linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)
      `,
      backgroundSize: '60px 60px',
      maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
      WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
    }} />
    {/* Subtle scanline */}
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 50%, transparent 50%)',
      backgroundSize: '100% 3px',
      pointerEvents: 'none',
    }} />
  </div>
);

/* ────────── BLADE MARK ──────────
 *  The FOM red blade — a vertical bar with a 25° clip-path on top-right + bottom-
 *  left, evoking a chequered flag. Sits at the centre of the title + outro. */
export const BladeMark: React.FC<{ size?: number; opacity?: number }> = ({ size = 140, opacity = 1 }) => (
  <div style={{
    width: size, height: size * 1.4, position: 'relative', opacity,
  }}>
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${COLOR.red} 0%, ${COLOR.redDeep} 100%)`,
      clipPath: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)',
      boxShadow: `0 0 ${size * 0.5}px ${COLOR.redGlow}`,
    }} />
    {/* Inner highlight stripe */}
    <div style={{
      position: 'absolute', top: '8%', left: '32%', right: '24%', bottom: '8%',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, transparent 60%)',
      clipPath: 'polygon(0 0, 100% 0, 70% 100%, 0 100%)',
    }} />
  </div>
);

/* ────────── BRAND WORDMARK ──────────
 *  "FLAT-OUT" + "MEDIA" — Oswald 700 + Rubik tracking treatment matching the
 *  HUD's calendar strip wordmark. */
export const Wordmark: React.FC<{ scale?: number; tagline?: boolean }> = ({ scale = 1, tagline = false }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 * scale }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 * scale }}>
      <span style={{
        fontFamily: FONT.display,
        fontWeight: 700,
        fontSize: 84 * scale,
        letterSpacing: '-0.01em',
        color: COLOR.text,
        lineHeight: 0.9,
      }}>FLAT-OUT</span>
      <span style={{
        fontFamily: FONT.display,
        fontWeight: 500,
        fontSize: 28 * scale,
        letterSpacing: '0.5em',
        color: COLOR.red,
        textTransform: 'uppercase',
      }}>MEDIA</span>
    </div>
    {tagline && (
      <div style={{
        fontFamily: FONT.body,
        fontStyle: 'italic',
        fontSize: 18 * scale,
        color: COLOR.textDim,
        letterSpacing: '0.05em',
      }}>we live and breathe automotive</div>
    )}
  </div>
);

/* ────────── PANEL FRAME ──────────
 *  Branded ink-1 panel with the blade clip-path + an Oswald uppercase title bar.
 *  Used for capability tour cards. */
export const PanelFrame: React.FC<{
  title?: string;
  width?: number | string;
  height?: number | string;
  children?: React.ReactNode;
  glow?: boolean;
  style?: React.CSSProperties;
}> = ({ title, width = 'auto', height = 'auto', children, glow, style }) => (
  <div style={{
    width, height,
    background: COLOR.ink1,
    border: `1px solid ${COLOR.red}`,
    clipPath: BLADE_CLIP,
    padding: 22,
    boxShadow: glow ? `0 0 36px ${COLOR.redGlow}` : 'none',
    display: 'flex',
    flexDirection: 'column',
    ...style,
  }}>
    {title && (
      <div style={{
        fontFamily: FONT.display,
        fontWeight: 700,
        fontSize: 14,
        letterSpacing: '0.4em',
        color: COLOR.red,
        textTransform: 'uppercase',
        paddingBottom: 12,
        marginBottom: 16,
        borderBottom: `1px solid ${COLOR.red}`,
      }}>{title}</div>
    )}
    {children}
  </div>
);

/* ────────── TERMINAL FRAME ──────────
 *  Mac-traffic-light terminal window. Used in the install scene for fake terminal
 *  frames showing the actual install commands. The traffic-light dots are pure
 *  CSS so the chrome is sharp at any resolution. */
export const TerminalFrame: React.FC<{
  title?: string;
  children: React.ReactNode;
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
}> = ({ title = "antony@m5max — bash", children, width = 1100, height = 600, style }) => (
  <div style={{
    width, height,
    background: '#1d1d1f',
    borderRadius: 10,
    boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    ...style,
  }}>
    {/* Title bar */}
    <div style={{
      height: 36,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 14,
      gap: 8,
      background: 'linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 100%)',
      borderBottom: '1px solid rgba(0,0,0,0.5)',
      position: 'relative',
    }}>
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840' }} />
      <div style={{
        position: 'absolute',
        left: 0, right: 0,
        textAlign: 'center',
        fontFamily: FONT.body,
        fontSize: 13,
        color: '#a0a0a4',
        pointerEvents: 'none',
      }}>{title}</div>
    </div>
    {/* Body */}
    <div style={{
      flex: 1,
      padding: '20px 24px',
      fontFamily: FONT.mono,
      fontSize: 18,
      lineHeight: 1.5,
      color: '#e6e6e6',
      background: '#1d1d1f',
      overflow: 'hidden',
    }}>{children}</div>
  </div>
);

/* ────────── SPEEDOMETER ──────────
 *  Stylised version of the kiosk's centerpiece speedo. Static angle + needle —
 *  motion is added per-scene by the caller via the `needle` prop (degrees). */
export const Speedo: React.FC<{ size?: number; needle?: number; state?: string }> = ({
  size = 360, needle = 0, state = 'STANDBY',
}) => {
  const r = size / 2;
  const tickCount = 21;            /* 0, 10, 20… 200 */
  const arcStart = -210;           /* degrees from 12 o'clock */
  const arcEnd   =   30;
  const arcRange = arcEnd - arcStart;
  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* Outer rim */}
        <circle cx={r} cy={r} r={r - 6} fill="none" stroke={COLOR.red} strokeWidth={2} opacity={0.4} />
        {/* Inner rim */}
        <circle cx={r} cy={r} r={r - 22} fill="none" stroke={COLOR.line} strokeWidth={1} />
        {/* Tick marks */}
        {Array.from({ length: tickCount }).map((_, i) => {
          const a = (arcStart + (i / (tickCount - 1)) * arcRange) * Math.PI / 180;
          const x1 = r + Math.cos(a) * (r - 30);
          const y1 = r + Math.sin(a) * (r - 30);
          const x2 = r + Math.cos(a) * (r - 50);
          const y2 = r + Math.sin(a) * (r - 50);
          const isMajor = i % 2 === 0;
          const inRedZone = i >= 16;            /* 160+ mph */
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={inRedZone ? COLOR.red : COLOR.text}
              strokeWidth={isMajor ? 2 : 1}
              opacity={isMajor ? 0.9 : 0.5} />
          );
        })}
        {/* Numerals at major ticks */}
        {Array.from({ length: 11 }).map((_, i) => {
          const a = (arcStart + (i / 10) * arcRange) * Math.PI / 180;
          const x = r + Math.cos(a) * (r - 76);
          const y = r + Math.sin(a) * (r - 76);
          const v = i * 20;
          return (
            <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
              fontFamily={FONT.mono} fontSize={14} fill={v >= 160 ? COLOR.red : COLOR.text} opacity={0.85}>
              {v}
            </text>
          );
        })}
        {/* Needle */}
        <g transform={`rotate(${arcStart + (needle / 200) * arcRange} ${r} ${r})`}>
          <polygon
            points={`${r - 4},${r + 4} ${r + 4},${r + 4} ${r + 1},${30}`}
            fill={COLOR.red}
            style={{ filter: `drop-shadow(0 0 8px ${COLOR.redGlow})` }}
          />
          <circle cx={r} cy={r} r={10} fill={COLOR.ink0} stroke={COLOR.red} strokeWidth={2} />
        </g>
      </svg>
      {/* Centre brand mark */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: COLOR.ink0, borderRadius: '50%',
        width: size * 0.28, height: size * 0.28,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        border: `1.5px solid ${COLOR.red}`,
      }}>
        <div style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: size * 0.07, color: COLOR.text, lineHeight: 1 }}>FLAT</div>
        <div style={{ fontFamily: FONT.display, fontWeight: 500, fontSize: size * 0.04, color: COLOR.red, letterSpacing: '0.2em' }}>OUT</div>
      </div>
      {/* State label */}
      <div style={{
        position: 'absolute', bottom: -28, left: 0, right: 0, textAlign: 'center',
        fontFamily: FONT.display, fontWeight: 500, fontSize: 12, letterSpacing: '0.4em',
        color: COLOR.textDim, textTransform: 'uppercase',
      }}>● {state}</div>
    </div>
  );
};

/* ────────── SUBTITLE OVERLAY ──────────
 *  Bottom-centre burned-in subtitles. Sized for legibility on a 27" monitor at
 *  arm's length (~ 24px body) but readable on a phone viewport too. The black
 *  bar behind the text gives it readability against any background. */
export const Subtitle: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)',
    maxWidth: 1400,
    padding: '14px 28px',
    background: 'rgba(0, 0, 0, 0.75)',
    borderLeft: `3px solid ${COLOR.red}`,
    borderRight: `3px solid ${COLOR.red}`,
    fontFamily: FONT.body,
    fontSize: 26,
    fontWeight: 500,
    color: COLOR.text,
    textAlign: 'center',
    lineHeight: 1.4,
    letterSpacing: '0.01em',
    backdropFilter: 'blur(4px)',
  }}>{text}</div>
);

/* ────────── SCENE-LEVEL HEADING ──────────
 *  Big Oswald uppercase label that fades in at the top of capability scenes.
 *  Acts as a chapter marker so the viewer always knows what they're watching. */
export const SceneLabel: React.FC<{ chapter: string; title: string; opacity?: number }> = ({
  chapter, title, opacity = 1,
}) => (
  <div style={{
    position: 'absolute', top: 50, left: 80, opacity,
  }}>
    <div style={{
      fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.5em', color: COLOR.red, marginBottom: 8,
    }}>{chapter}</div>
    <div style={{
      fontFamily: FONT.display, fontWeight: 700, fontSize: 56, letterSpacing: '-0.01em', color: COLOR.text, textTransform: 'uppercase',
    }}>{title}</div>
    <div style={{
      width: 80, height: 3, background: COLOR.red, marginTop: 12, boxShadow: `0 0 12px ${COLOR.redGlow}`,
    }} />
  </div>
);
