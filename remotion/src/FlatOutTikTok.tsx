/** FlatOutTikTok.tsx — vertical 1080×1920 social cut, ~25s total.
 *
 *  Built for TikTok / Reels / Shorts viewing patterns:
 *    - Hook in the first 2 seconds (text slams in at frame 0)
 *    - Big stacked typography — readable on a phone held at arm's length
 *    - Scene cuts every 2-3 seconds to hold attention against the algorithm
 *    - Captions in the lower-third (TikTok convention; algorithm rewards it)
 *    - Brand-red flash on hard cuts to anchor the FOM identity
 *
 *  Reuses brand tokens + a few primitives from components.tsx (BladeMark,
 *  Wordmark, e). The Subtitle component from components.tsx is sized for
 *  landscape so we render our own VerticalSubtitle here. */

import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, Easing, interpolate } from 'remotion';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadRubik } from '@remotion/google-fonts/Rubik';
import { loadFont as loadJetBrains } from '@remotion/google-fonts/JetBrainsMono';
import manifest from '../public/audio/tiktok-manifest.json';
import { COLOR, FONT, BLADE_CLIP } from './brand';
import { BladeMark, Wordmark, e } from './components';

loadOswald();
loadRubik();
loadJetBrains();

type SceneId = 't_hook' | 't_voice' | 't_vision' | 't_edit' | 't_brand' | 't_memory' | 't_live' | 't_cta';
const PAD_FRAMES = 6;             /* Tight pads for fast pacing — TikTok rewards constant motion. */
const PAD_OUTRO = 30;

interface SceneInfo { id: SceneId; text: string; file: string | null; seconds: number; frames: number; }
const scenes: SceneInfo[] = manifest as SceneInfo[];

function buildTimeline() {
  const out: { id: SceneId; start: number; duration: number; text: string; file: string | null }[] = [];
  let cursor = 0;
  scenes.forEach((s, i) => {
    const pad = i === scenes.length - 1 ? PAD_OUTRO : PAD_FRAMES;
    const duration = s.frames + pad;
    out.push({ id: s.id, start: cursor, duration, text: s.text, file: s.file });
    cursor += duration;
  });
  return out;
}
const timeline = buildTimeline();
export function getTikTokTotalFrames() {
  return timeline.reduce((a, t) => a + t.duration, 0) || 750;
}

/* Vertical-friendly subtitle: 80% width band in the lower-third, larger type
 * than landscape because phones are held closer than monitors. */
const VerticalSubtitle: React.FC<{ text: string }> = ({ text }) => (
  <div style={{
    position: 'absolute',
    bottom: 200,
    left: 60, right: 60,
    padding: '18px 24px',
    background: 'rgba(0, 0, 0, 0.78)',
    borderLeft: `4px solid ${COLOR.red}`,
    borderRight: `4px solid ${COLOR.red}`,
    fontFamily: FONT.body,
    fontSize: 38,
    fontWeight: 600,
    color: COLOR.text,
    textAlign: 'center',
    lineHeight: 1.3,
    backdropFilter: 'blur(4px)',
  }}>{text}</div>
);

/* Persistent brand bar at the very bottom of every scene — small "FLAT-OUT MEDIA"
 * mark + tagline so the brand is unmissable even if the viewer scrolls past. */
const BrandBar: React.FC = () => (
  <div style={{
    position: 'absolute',
    bottom: 60, left: 0, right: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
  }}>
    <span style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: 22, color: COLOR.text, letterSpacing: '-0.02em' }}>FLAT-OUT</span>
    <span style={{ fontFamily: FONT.display, fontWeight: 500, fontSize: 14, letterSpacing: '0.4em', color: COLOR.red }}>MEDIA</span>
  </div>
);

/* Vertical backdrop — same atmospheric grid + scanlines as the landscape version
 * but tuned for portrait (radial gradient centred). */
const VerticalBackdrop: React.FC = () => (
  <div style={{
    position: 'absolute', inset: 0,
    background: `radial-gradient(circle at 50% 50%, ${COLOR.ink2} 0%, ${COLOR.ink0} 80%)`,
  }}>
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)`,
      backgroundSize: '50px 50px',
      maskImage: 'radial-gradient(circle, black 30%, transparent 80%)',
      WebkitMaskImage: 'radial-gradient(circle, black 30%, transparent 80%)',
    }} />
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 50%, transparent 50%)',
      backgroundSize: '100% 3px',
    }} />
  </div>
);

export const FlatOutTikTok: React.FC = () => (
  <AbsoluteFill style={{ background: COLOR.ink0 }}>
    <VerticalBackdrop />
    {timeline.map((scene) => (
      <Sequence key={scene.id} from={scene.start} durationInFrames={scene.duration}>
        <SceneRouter id={scene.id} text={scene.text} file={scene.file} duration={scene.duration} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

const SceneRouter: React.FC<{ id: SceneId; text: string; file: string | null; duration: number }> = ({ id, text, file, duration }) => {
  const Visual = SCENE_COMPONENTS[id];
  return (
    <AbsoluteFill>
      {file && <Audio src={staticFile(file)} />}
      <Visual duration={duration} />
      <VerticalSubtitle text={text} />
      <BrandBar />
    </AbsoluteFill>
  );
};

/* Cut-flash: brand-red strobe at the start of each scene to give every cut a hit.
 * Lasts ~6 frames. Subtle — just enough to feel like a cut, not a jump-scare. */
const CutFlash: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = e(f, [0, 4, 8], [0, 0.35, 0]);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: COLOR.red,
      opacity,
      pointerEvents: 'none',
    }} />
  );
};

/* Stacked-text helper — used in most hook positions. Each line slams in from
 * scale 1.4 to 1.0 with a tiny vertical bounce so the type feels punchy. */
const SlamText: React.FC<{
  lines: { text: string; color?: string; size?: number; weight?: number; at: number }[];
}> = ({ lines }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, alignItems: 'center' }}>
      {lines.map((ln, i) => {
        const scale = e(f, [ln.at, ln.at + 8], [1.4, 1.0], Easing.out(Easing.back(2)));
        const opacity = e(f, [ln.at, ln.at + 6], [0, 1]);
        return (
          <div key={i} style={{
            opacity, transform: `scale(${scale})`,
            fontFamily: FONT.display,
            fontWeight: ln.weight ?? 700,
            fontSize: ln.size ?? 140,
            color: ln.color ?? COLOR.text,
            lineHeight: 0.95,
            letterSpacing: '-0.02em',
            textTransform: 'uppercase',
            textAlign: 'center',
          }}>{ln.text}</div>
        );
      })}
    </div>
  );
};

/* ────────── SCENE 1 · HOOK (2.26s) ────────── */
const HookScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  const bladeOpacity = e(f, [40, 60], [0, 1]);
  const bladeScale = e(f, [40, 60], [0.5, 1.0]);
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 200, gap: 30 }}>
        <SlamText lines={[
          { text: 'YOUR',         at: 0,  size: 130 },
          { text: 'STUDIO',       at: 6,  size: 170 },
          { text: 'JUST GOT',     at: 14, size: 110 },
          { text: 'AN AI.',       at: 22, size: 220, color: COLOR.red, weight: 700 },
        ]} />
        <div style={{ opacity: bladeOpacity, transform: `scale(${bladeScale})` }}>
          <BladeMark size={120} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 2 · VOICE (3.16s) ────────── */
const VoiceScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 200, gap: 50 }}>
        <SlamText lines={[
          { text: 'HEY',      at: 0, size: 140 },
          { text: 'FLAT-OUT', at: 8, size: 200, color: COLOR.red },
        ]} />
        {/* Transcript bubble */}
        <div style={{
          opacity: e(f, [24, 40], [0, 1]),
          transform: `translateY(${e(f, [24, 40], [40, 0])}px)`,
          marginTop: 30,
          padding: '24px 36px',
          background: COLOR.ink1,
          border: `2px solid ${COLOR.green}`,
          clipPath: BLADE_CLIP,
          maxWidth: 880,
          fontFamily: FONT.body,
          fontSize: 44,
          fontWeight: 500,
          color: COLOR.text,
          lineHeight: 1.3,
          textAlign: 'center',
        }}>"Cut a 30-second teaser of yesterday's Aston shoot."</div>

        {/* Mic pulse */}
        <div style={{ marginTop: 40, display: 'flex', justifyContent: 'center', gap: 12 }}>
          {Array.from({ length: 11 }).map((_, i) => {
            const phase = (f * 0.3 + i * 0.4) % (Math.PI * 2);
            const h = 24 + Math.abs(Math.sin(phase)) * 80;
            const opacity = e(f, [40, 60], [0, 1]);
            return (
              <div key={i} style={{
                width: 8, height: h, opacity,
                background: COLOR.red,
                boxShadow: `0 0 8px ${COLOR.redGlow}`,
              }} />
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 3 · VISION (2.71s) ────────── */
const VisionScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 220, gap: 50 }}>
        <SlamText lines={[
          { text: 'VISION', at: 0, size: 220, color: COLOR.red },
          { text: 'EVERY SHOT', at: 10, size: 90 },
        ]} />
        {/* 4-thumb grid with red borders, captions */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, width: 880 }}>
          {[
            { label: '3/4 FRONT',    cap: 'Vulcan, golden hour' },
            { label: 'FRONT GRILLE', cap: 'centre, deep shadow', hero: true },
            { label: 'PROFILE',      cap: 'late afternoon backlight' },
            { label: 'REAR 3/4',     cap: 'wet tarmac, racing line' },
          ].map((t, i) => {
            const at = 30 + i * 8;
            const opacity = e(f, [at, at + 12], [0, 1]);
            const scale = e(f, [at, at + 18], [0.7, 1.0]);
            return (
              <div key={t.label} style={{ opacity, transform: `scale(${scale})` }}>
                <div style={{
                  aspectRatio: '4 / 3',
                  background: `linear-gradient(135deg, ${COLOR.ink2}, ${COLOR.ink0})`,
                  border: `2px solid ${t.hero ? COLOR.red : COLOR.line}`,
                  clipPath: BLADE_CLIP,
                  position: 'relative',
                  boxShadow: t.hero ? `0 0 24px ${COLOR.redGlow}` : 'none',
                }}>
                  <div style={{
                    position: 'absolute', top: '40%', left: '12%', right: '12%', height: '20%',
                    background: `linear-gradient(90deg, ${COLOR.red}, transparent)`, opacity: 0.4, transform: 'skewX(-15deg)',
                  }} />
                  <div style={{
                    position: 'absolute', top: 12, left: 14,
                    fontFamily: FONT.display, fontSize: 18, letterSpacing: '0.2em',
                    color: t.hero ? COLOR.red : COLOR.textDim,
                  }}>{t.label}{t.hero ? ' · HERO' : ''}</div>
                </div>
                <div style={{ marginTop: 6, fontFamily: FONT.body, fontSize: 16, color: COLOR.textDim }}>{t.cap}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 4 · EDIT (2.82s) ────────── */
const EditScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 220, gap: 30 }}>
        <SlamText lines={[
          { text: 'VOICE IN.',  at: 0,  size: 140 },
          { text: 'MP4 OUT.',   at: 8,  size: 140, color: COLOR.red },
          { text: '3 MINUTES.', at: 18, size: 90 },
        ]} />
        {/* Pipeline → final.mp4 */}
        <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 14 }}>
          {['SCAN', 'PLAN', 'CUT', 'SYNC', 'GO'].map((s, i) => {
            const at = 30 + i * 8;
            const opacity = e(f, [at, at + 12], [0, 1]);
            return (
              <React.Fragment key={s}>
                <div style={{
                  opacity,
                  padding: '12px 18px',
                  background: COLOR.ink1, border: `2px solid ${COLOR.red}`, clipPath: BLADE_CLIP,
                  fontFamily: FONT.display, fontWeight: 700, fontSize: 22, letterSpacing: '0.15em', color: COLOR.text,
                  boxShadow: `0 0 12px ${COLOR.redGlow}`,
                }}>{s}</div>
                {i < 4 && (
                  <div style={{
                    opacity, width: 14, height: 3,
                    background: COLOR.red, boxShadow: `0 0 6px ${COLOR.redGlow}`,
                  }} />
                )}
              </React.Fragment>
            );
          })}
        </div>
        {/* Final.mp4 thumb */}
        <div style={{
          marginTop: 24,
          opacity: e(f, [70, 80], [0, 1]),
          transform: `scale(${e(f, [70, 80], [0.6, 1.0])})`,
          width: 320, height: 568,
          background: `linear-gradient(135deg, ${COLOR.ink2}, ${COLOR.ink0})`,
          border: `2px solid ${COLOR.red}`, clipPath: BLADE_CLIP, position: 'relative',
          boxShadow: `0 0 40px ${COLOR.redGlow}`,
        }}>
          <div style={{ position: 'absolute', top: 14, left: 16, fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.3em', color: COLOR.red }}>FINAL · 9:16 · 30s</div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 88, height: 88, borderRadius: '50%',
              background: COLOR.red, boxShadow: `0 0 32px ${COLOR.redGlow}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ width: 0, height: 0, borderLeft: '28px solid white', borderTop: '18px solid transparent', borderBottom: '18px solid transparent', marginLeft: 8 }} />
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 5 · BRAND (2.99s) ────────── */
const BrandScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  const aspects = [
    { label: '16:9',  w: 320, h: 180, at: 14 },
    { label: '9:16',  w: 100, h: 178, at: 28 },
    { label: '1:1',   w: 178, h: 178, at: 42 },
    { label: '4:5',   w: 142, h: 178, at: 56 },
  ];
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 220, gap: 30 }}>
        <SlamText lines={[
          { text: 'ONE',           at: 0, size: 130 },
          { text: 'COMMAND.',      at: 6, size: 160 },
          { text: 'EVERY ASPECT.', at: 14, size: 90, color: COLOR.red },
        ]} />
        <div style={{ marginTop: 18, display: 'flex', gap: 18, alignItems: 'flex-end' }}>
          {aspects.map(a => {
            const opacity = e(f, [a.at, a.at + 12], [0, 1]);
            const scale = e(f, [a.at, a.at + 18], [0.5, 1.0]);
            return (
              <div key={a.label} style={{ opacity, transform: `scale(${scale})`, transformOrigin: 'bottom', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: a.w, height: a.h,
                  background: `linear-gradient(135deg, ${COLOR.ink2}, ${COLOR.ink0})`,
                  border: `2px solid ${COLOR.red}`, clipPath: BLADE_CLIP, position: 'relative',
                }}>
                  <div style={{
                    position: 'absolute', top: '30%', left: '10%', right: '10%', height: '40%',
                    background: `linear-gradient(45deg, transparent, ${COLOR.red} 50%, transparent)`, opacity: 0.4,
                  }} />
                  <div style={{
                    position: 'absolute', bottom: 6, right: 8,
                    fontFamily: FONT.display, fontSize: 11, letterSpacing: '0.2em', color: COLOR.text, opacity: 0.7,
                  }}>FOM</div>
                </div>
                <div style={{ fontFamily: FONT.display, fontSize: 16, letterSpacing: '0.3em', color: COLOR.textDim }}>{a.label}</div>
              </div>
            );
          })}
        </div>
        {/* Zip */}
        <div style={{
          opacity: e(f, [72, 84], [0, 1]),
          transform: `translateY(${e(f, [72, 84], [40, 0])}px)`,
          padding: '14px 28px',
          background: COLOR.ink1, border: `2px solid ${COLOR.green}`, clipPath: BLADE_CLIP,
          fontFamily: FONT.mono, fontSize: 24, color: COLOR.green,
          boxShadow: `0 0 24px rgba(0, 255, 136, 0.3)`,
        }}>📦 vulcan_hero.zip</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 6 · MEMORY (2.82s) ────────── */
const MemoryScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  const cards = [
    { kind: 'CONTACT',  text: 'Sarah @ Press',     at: 14 },
    { kind: 'PROJECT',  text: 'Vulcan AMR Pro',    at: 28 },
    { kind: 'YOUR LOOK', text: 'Warm, mid-sat, medium', at: 42 },
  ];
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 180, gap: 30 }}>
        <SlamText lines={[
          { text: 'REMEMBERS', at: 0, size: 180, color: COLOR.red },
          { text: 'EVERYTHING.', at: 10, size: 100 },
        ]} />
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 18, width: 880 }}>
          {cards.map((c) => {
            const opacity = e(f, [c.at, c.at + 12], [0, 1]);
            const x = e(f, [c.at, c.at + 12], [-60, 0]);
            return (
              <div key={c.kind} style={{
                opacity, transform: `translateX(${x}px)`,
                padding: '18px 28px',
                background: COLOR.ink1, border: `2px solid ${COLOR.red}`, clipPath: BLADE_CLIP,
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div style={{ fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.4em', color: COLOR.red }}>{c.kind}</div>
                <div style={{ fontFamily: FONT.body, fontSize: 36, fontWeight: 600, color: COLOR.text }}>{c.text}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 7 · LIVE (3.14s) ────────── */
const LiveScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 160, gap: 24 }}>
        <SlamText lines={[
          { text: 'PHONE',     at: 0, size: 160 },
          { text: '= MIC.',    at: 8, size: 200, color: COLOR.red },
        ]} />
        {/* Phone mock */}
        <div style={{
          opacity: e(f, [24, 40], [0, 1]),
          transform: `translateY(${e(f, [24, 40], [40, 0])}px)`,
          marginTop: 16,
          width: 320, height: 600,
          background: COLOR.ink0, borderRadius: 44, border: `10px solid #2a2a2c`, padding: 16,
        }}>
          <div style={{ width: '100%', height: '100%', background: COLOR.ink1, borderRadius: 28, padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontFamily: FONT.display, fontSize: 16, letterSpacing: '0.2em', color: COLOR.red }}>FLAT-OUT LIVE</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 12, color: COLOR.green, marginTop: 6 }}>● connected</div>
              <div style={{ marginTop: 18, fontFamily: FONT.body, fontSize: 16, color: COLOR.textDim, lineHeight: 1.4 }}>
                <div style={{ opacity: e(f, [50, 60], [0, 1]) }}>14:23 HERO → IMG_142</div>
                <div style={{ opacity: e(f, [62, 72], [0, 1]), marginTop: 4 }}>14:24 RESHOOT, low light</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {['HERO', 'KEEP', 'MAYBE', 'RESHOOT'].map((b) => {
                const isHero = b === 'HERO';
                const tap = isHero && f > 50 && f < 65;
                return (
                  <div key={b} style={{
                    padding: '14px 6px',
                    background: tap ? COLOR.red : COLOR.ink2,
                    border: `1px solid ${isHero ? COLOR.red : COLOR.line}`,
                    fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.2em',
                    color: tap ? COLOR.ink0 : (isHero ? COLOR.red : COLOR.text),
                    textAlign: 'center', fontWeight: tap ? 700 : 500,
                  }}>{b}</div>
                );
              })}
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 8 · CTA (2.13s) ────────── */
const CtaScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const opacity = e(f, [0, 18], [0, 1]);
  const scale = interpolate(f, [0, duration], [1.0, 1.06], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const flashOpacity = e(f, [duration - 20, duration - 5, duration], [0, 0.7, 0]);
  return (
    <AbsoluteFill>
      <CutFlash />
      <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 200, gap: 36 }}>
        <div style={{ opacity, transform: `scale(${scale})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
          <BladeMark size={160} />
          <Wordmark scale={1.4} tagline />
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', inset: 0, background: COLOR.red, opacity: flashOpacity, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

const SCENE_COMPONENTS: Record<SceneId, React.FC<{ duration: number }>> = {
  t_hook:   HookScene,
  t_voice:  VoiceScene,
  t_vision: VisionScene,
  t_edit:   EditScene,
  t_brand:  BrandScene,
  t_memory: MemoryScene,
  t_live:   LiveScene,
  t_cta:    CtaScene,
};
