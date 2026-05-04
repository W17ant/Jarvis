/** FlatOutCapabilities.tsx — what Flat-Out can do. Deep-dive companion to the
 *  install overview.
 *
 *  10 scenes, each surfacing a real product surface (not just a chapter card):
 *    1. title           — brand intro
 *    2. voice loop      — wake → STT → LLM → TTS path with a state-flow diagram
 *    3. vision          — caption results + grep-by-description
 *    4. edit            — pipeline lanes finishing → final.mp4 thumbnail
 *    5. brand pack      — 4 aspect crops + watermark + zip artefact
 *    6. comms           — Frame.io comment thread + mail draft + calendar event
 *    7. nle             — Premiere timeline + Lightroom XMP sidecar
 *    8. memory          — memory cards + style signature numerical readout + diff
 *    9. studio          — phone-as-mic + media-day calendar + press radar feed
 *   10. outro           — MCP host grid + closer
 *
 *  Reuses brand.ts + components.tsx (Backdrop, BladeMark, Wordmark, PanelFrame,
 *  Speedo, TerminalFrame, Subtitle, SceneLabel, e). Per-scene visuals are inline
 *  here for the same reason as the overview — short scenes, flat list, no payoff
 *  to splitting. */

import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, Easing, interpolate } from 'remotion';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadRubik } from '@remotion/google-fonts/Rubik';
import { loadFont as loadJetBrains } from '@remotion/google-fonts/JetBrainsMono';
import manifest from '../public/audio/capabilities-manifest.json';
import { COLOR, FONT, BLADE_CLIP } from './brand';
import { Backdrop, BladeMark, Wordmark, Subtitle, SceneLabel, e } from './components';

loadOswald();
loadRubik();
loadJetBrains();

type SceneId = 'c_title' | 'c_voice' | 'c_vision' | 'c_edit' | 'c_brand' | 'c_comms' | 'c_nle' | 'c_memory' | 'c_studio' | 'c_outro';
const PAD_FRAMES = 18;
const PAD_FIRST = 12;
const PAD_OUTRO = 60;

interface SceneInfo { id: SceneId; text: string; file: string | null; seconds: number; frames: number; }
const scenes: SceneInfo[] = manifest as SceneInfo[];

function buildTimeline() {
  const out: { id: SceneId; start: number; duration: number; text: string; file: string | null }[] = [];
  let cursor = 0;
  scenes.forEach((s, i) => {
    const pad = i === 0 ? PAD_FIRST : i === scenes.length - 1 ? PAD_OUTRO : PAD_FRAMES;
    const duration = s.frames + pad;
    out.push({ id: s.id, start: cursor, duration, text: s.text, file: s.file });
    cursor += duration;
  });
  return out;
}
const timeline = buildTimeline();
export function getCapabilitiesTotalFrames() {
  return timeline.reduce((a, t) => a + t.duration, 0) || 4000;
}

export const FlatOutCapabilities: React.FC = () => (
  <AbsoluteFill style={{ background: COLOR.ink0 }}>
    <Backdrop />
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
      <Subtitle text={text} />
    </AbsoluteFill>
  );
};

/* Small helper: tile/card wrapper used across most scenes for consistency. */
const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; accent?: 'red' | 'green' | 'yellow' | 'line' }> = ({ children, style, accent = 'red' }) => {
  const border = accent === 'green' ? COLOR.green : accent === 'yellow' ? COLOR.yellow : accent === 'line' ? COLOR.line : COLOR.red;
  return (
    <div style={{
      background: COLOR.ink1,
      border: `1px solid ${border}`,
      clipPath: BLADE_CLIP,
      padding: '16px 20px',
      ...style,
    }}>{children}</div>
  );
};

/* ────────── SCENE 1 · TITLE ────────── */
const TitleScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  const opacity = e(f, [0, 18], [0, 1]);
  const scale = e(f, [0, 24], [0.85, 1.0]);
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 24 }}>
      <div style={{ opacity, transform: `scale(${scale})` }}><BladeMark size={140} /></div>
      <div style={{ opacity }}><Wordmark scale={1.1} /></div>
      <div style={{
        opacity, marginTop: 18,
        padding: '12px 36px',
        border: `1px solid ${COLOR.red}`,
        clipPath: BLADE_CLIP,
        background: COLOR.ink1,
        fontFamily: FONT.display, fontWeight: 500, fontSize: 22, letterSpacing: '0.5em',
        color: COLOR.red, textTransform: 'uppercase',
      }}>WHAT IT CAN DO</div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 2 · VOICE LOOP ──────────
 *  Horizontal flow diagram: WAKE → WHISPER → QWEN → KOKORO. Each stage lights
 *  red as the narration mentions it. Sentence-level streaming is shown as
 *  three sentence chips popping out of KOKORO at 30/60/90% offsets. */
const VoiceScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const stages = [
    { label: 'WAKE',    sub: '"hey flat-out"',     at: 60  },
    { label: 'WHISPER', sub: 'local STT',          at: 100 },
    { label: 'QWEN 2.5',sub: 'tools + reasoning',  at: 140 },
    { label: 'KOKORO',  sub: 'sentence-by-sentence',at: 180 },
  ];
  const sentences = ["First sentence ready.", "Second sentence streams.", "Stop interrupts mid-flow."];
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px' }}>
      <SceneLabel chapter="01 · VOICE LOOP" title="Wake. Hear. Reply." opacity={e(f, [0, 18], [0, 1])} />
      <div style={{ marginTop: 130, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 }}>
        {stages.map((s, i) => {
          const active = f >= s.at;
          const opacity = e(f, [s.at - 12, s.at + 12], [0.3, 1]);
          return (
            <React.Fragment key={s.label}>
              <div style={{
                opacity,
                width: 220, padding: '20px 16px',
                background: COLOR.ink1,
                border: `1.5px solid ${active ? COLOR.red : COLOR.line}`,
                clipPath: BLADE_CLIP,
                boxShadow: active ? `0 0 24px ${COLOR.redGlow}` : 'none',
                textAlign: 'center',
              }}>
                <div style={{ fontFamily: FONT.display, fontSize: 22, letterSpacing: '0.15em', color: active ? COLOR.text : COLOR.textDim }}>{s.label}</div>
                <div style={{ marginTop: 6, fontFamily: FONT.body, fontSize: 12, color: COLOR.textDim, fontStyle: 'italic' }}>{s.sub}</div>
              </div>
              {i < stages.length - 1 && (
                <div style={{
                  width: 32, height: 2,
                  background: f >= stages[i + 1].at - 8 ? COLOR.red : COLOR.line,
                  boxShadow: f >= stages[i + 1].at - 8 ? `0 0 8px ${COLOR.redGlow}` : 'none',
                }} />
              )}
            </React.Fragment>
          );
        })}
      </div>
      {/* Sentence stream below KOKORO — 3 chips appearing in time */}
      <div style={{ marginTop: 60, display: 'flex', gap: 16, justifyContent: 'flex-end', paddingRight: 60 }}>
        {sentences.map((s, i) => {
          const at = 220 + i * 30;
          const opacity = e(f, [at, at + 18], [0, 1]);
          const x = e(f, [at, at + 18], [20, 0]);
          return (
            <div key={i} style={{
              opacity, transform: `translateX(${x}px)`,
              padding: '8px 14px',
              background: COLOR.ink2,
              borderLeft: `3px solid ${COLOR.red}`,
              fontFamily: FONT.mono, fontSize: 14, color: COLOR.text,
            }}>{s}</div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 3 · VISION ──────────
 *  Left: a query bubble ("find the front-grille hero on the Vulcan").
 *  Right: result list with caption snippets + "match" scores, top result
 *  highlighted red. */
const VisionScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const queryOpacity = e(f, [12, 36], [0, 1]);
  const queryText = "find the front-grille hero on the Vulcan";
  const queryChars = Math.min(queryText.length, Math.floor(e(f, [30, 90], [0, queryText.length])));

  const results = [
    { file: 'IMG_142.jpg', caption: 'Aston Vulcan, front grille, centre framing, deep shadow detail.', score: 0.94, hero: true,  at: 100 },
    { file: 'IMG_088.jpg', caption: 'Aston Vulcan, 3/4 front, golden hour, low angle.',                score: 0.71, hero: false, at: 130 },
    { file: 'IMG_204.jpg', caption: 'Aston Vulcan, profile, mid-stroke, late afternoon backlight.',     score: 0.62, hero: false, at: 160 },
    { file: 'IMG_311.jpg', caption: 'Aston Vulcan, rear 3/4, racing line, wet tarmac.',                 score: 0.58, hero: false, at: 190 },
  ];

  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', gap: 40 }}>
      <SceneLabel chapter="02 · VISION" title="Sees + searches every shot" opacity={e(f, [0, 18], [0, 1])} />

      <div style={{ flex: 1, marginTop: 130 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 12, letterSpacing: '0.4em', color: COLOR.green, marginBottom: 8 }}>QUERY</div>
        <Card accent="green" style={{ opacity: queryOpacity, fontFamily: FONT.body, fontSize: 22, color: COLOR.text }}>
          {queryText.slice(0, queryChars)}<span style={{ color: COLOR.green }}>{queryChars < queryText.length ? '▍' : ''}</span>
        </Card>
        <div style={{ marginTop: 20, fontFamily: FONT.display, fontSize: 12, letterSpacing: '0.4em', color: COLOR.red }}>RESULTS · {results.length}</div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {results.map((r, i) => {
            const opacity = e(f, [r.at, r.at + 18], [0, 1]);
            const x = e(f, [r.at, r.at + 18], [40, 0]);
            return (
              <div key={r.file} style={{
                opacity, transform: `translateX(${x}px)`,
                padding: '12px 18px',
                background: COLOR.ink1,
                border: `1px solid ${r.hero ? COLOR.red : COLOR.line}`,
                clipPath: BLADE_CLIP,
                boxShadow: r.hero ? `0 0 18px ${COLOR.redGlow}` : 'none',
                display: 'grid', gridTemplateColumns: '160px 1fr 80px', gap: 14, alignItems: 'center',
              }}>
                <span style={{ fontFamily: FONT.mono, fontSize: 14, color: r.hero ? COLOR.red : COLOR.text }}>{r.file}</span>
                <span style={{ fontFamily: FONT.body, fontSize: 14, color: COLOR.textDim, lineHeight: 1.3 }}>{r.caption}</span>
                <span style={{ fontFamily: FONT.mono, fontSize: 16, color: r.hero ? COLOR.red : COLOR.textDim, textAlign: 'right' }}>
                  {(r.score * 100).toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 4 · EDIT ──────────
 *  Left: command typed into the kiosk. Centre: pipeline lanes finishing.
 *  Right: final.mp4 thumbnail with play overlay appearing at scene end. */
const EditScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const cmdOpacity = e(f, [12, 36], [0, 1]);
  const cmdText = '"Cut a 30-second teaser of yesterday\'s Aston shoot, vertical, closing card V12 BEAST."';
  const cmdChars = Math.min(cmdText.length, Math.floor(e(f, [30, 110], [0, cmdText.length])));
  const stages = [
    { label: 'SCAN',     start: 110, end: 150, done: 160 },
    { label: 'PLAN',     start: 150, end: 200, done: 210 },
    { label: 'ENCODE',   start: 200, end: 280, done: 290 },
    { label: 'BEAT-SYNC',start: 280, end: 320, done: 330 },
    { label: 'CONCAT',   start: 320, end: 360, done: 370 },
  ];
  const finalAt = 380;
  const finalOpacity = e(f, [finalAt, finalAt + 24], [0, 1]);
  const finalScale = e(f, [finalAt, finalAt + 30], [0.7, 1.0]);

  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SceneLabel chapter="03 · CINEMATIC EDITS" title="Voice → cut → final.mp4" opacity={e(f, [0, 18], [0, 1])} />

      <div style={{ marginTop: 110 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 12, letterSpacing: '0.4em', color: COLOR.red, marginBottom: 8 }}>OPERATOR</div>
        <Card style={{ opacity: cmdOpacity, fontFamily: FONT.body, fontSize: 18, color: COLOR.text, fontStyle: 'italic' }}>
          {cmdText.slice(0, cmdChars)}<span style={{ color: COLOR.red }}>{cmdChars < cmdText.length ? '▍' : ''}</span>
        </Card>
      </div>

      <div style={{ display: 'flex', gap: 30, alignItems: 'center', marginTop: 24 }}>
        {/* Pipeline */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((s) => {
            const pct = f < s.start ? 0 : f >= s.end ? 100 : ((f - s.start) / (s.end - s.start)) * 100;
            const isDone = f >= s.done;
            return (
              <div key={s.label} style={{
                display: 'grid', gridTemplateColumns: '160px 1fr 60px', gap: 12, alignItems: 'center',
                padding: '10px 18px',
                background: COLOR.ink1, border: `1px solid ${isDone ? COLOR.green : COLOR.line}`, clipPath: BLADE_CLIP,
              }}>
                <span style={{ fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.2em', color: isDone ? COLOR.green : COLOR.text }}>{s.label}</span>
                <div style={{ height: 6, background: COLOR.ink2 }}>
                  <div style={{
                    width: `${pct}%`, height: '100%',
                    background: isDone ? COLOR.green : `linear-gradient(90deg, ${COLOR.redDeep}, ${COLOR.red})`,
                    boxShadow: isDone ? 'none' : `0 0 8px ${COLOR.redGlow}`,
                  }} />
                </div>
                <span style={{ fontFamily: FONT.mono, fontSize: 14, color: isDone ? COLOR.green : COLOR.textDim, textAlign: 'right' }}>
                  {isDone ? '✓' : `${pct.toFixed(0)}%`}
                </span>
              </div>
            );
          })}
        </div>

        {/* Final.mp4 thumbnail */}
        <div style={{
          width: 280, height: 500,
          opacity: finalOpacity, transform: `scale(${finalScale})`,
          background: `linear-gradient(135deg, ${COLOR.ink2}, ${COLOR.ink0})`,
          border: `1px solid ${COLOR.red}`,
          clipPath: BLADE_CLIP,
          position: 'relative',
          boxShadow: `0 0 40px ${COLOR.redGlow}`,
          padding: 18,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div style={{ fontFamily: FONT.display, fontSize: 11, letterSpacing: '0.3em', color: COLOR.red }}>FINAL.MP4 · 9:16 · 30s</div>
          {/* Stylised play button + brand mark */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: COLOR.red, boxShadow: `0 0 24px ${COLOR.redGlow}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ width: 0, height: 0, borderLeft: '20px solid white', borderTop: '12px solid transparent', borderBottom: '12px solid transparent', marginLeft: 6 }} />
            </div>
          </div>
          <div style={{
            fontFamily: FONT.display, fontWeight: 700, fontSize: 22,
            letterSpacing: '0.1em', color: COLOR.text, textAlign: 'center',
          }}>V12 BEAST</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 5 · BRAND PACK ──────────
 *  Centre stage: 4 aspect crops fly in then a zip artefact lands on top. */
const BrandScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const aspects = [
    { label: '16:9',  w: 280, h: 158, at: 30 },
    { label: '9:16',  w: 100, h: 178, at: 60 },
    { label: '1:1',   w: 178, h: 178, at: 90 },
    { label: '4:5',   w: 142, h: 178, at: 120 },
  ];
  const zipAt = 200;
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px' }}>
      <SceneLabel chapter="04 · BRAND PACK" title="Every aspect, one command" opacity={e(f, [0, 18], [0, 1])} />
      <div style={{ marginTop: 130, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
        <div style={{ display: 'flex', gap: 36, alignItems: 'flex-end' }}>
          {aspects.map(a => {
            const opacity = e(f, [a.at, a.at + 24], [0, 1]);
            const scale = e(f, [a.at, a.at + 30], [0.6, 1.0]);
            return (
              <div key={a.label} style={{ opacity, transform: `scale(${scale})`, transformOrigin: 'bottom', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: a.w, height: a.h,
                  background: `linear-gradient(135deg, ${COLOR.ink2}, ${COLOR.ink0})`,
                  border: `1px solid ${COLOR.red}`, clipPath: BLADE_CLIP, position: 'relative', overflow: 'hidden',
                }}>
                  <div style={{
                    position: 'absolute', top: '30%', left: '10%', right: '10%', height: '40%',
                    background: `linear-gradient(45deg, transparent, ${COLOR.red} 50%, transparent)`, opacity: 0.4,
                  }} />
                  <div style={{
                    position: 'absolute', bottom: 8, right: 10,
                    fontFamily: FONT.display, fontSize: 9, letterSpacing: '0.2em', color: COLOR.text, opacity: 0.7,
                  }}>FOM</div>
                </div>
                <div style={{ fontFamily: FONT.display, fontSize: 14, letterSpacing: '0.3em', color: COLOR.textDim }}>{a.label}</div>
              </div>
            );
          })}
        </div>

        {/* Zip artefact */}
        <div style={{
          opacity: e(f, [zipAt, zipAt + 24], [0, 1]),
          transform: `translateY(${e(f, [zipAt, zipAt + 24], [40, 0])}px)`,
          padding: '16px 24px',
          background: COLOR.ink1, border: `1px solid ${COLOR.green}`, clipPath: BLADE_CLIP,
          display: 'flex', alignItems: 'center', gap: 16,
          boxShadow: `0 0 24px rgba(0, 255, 136, 0.25)`,
        }}>
          <span style={{ fontFamily: FONT.mono, fontSize: 22, color: COLOR.green }}>📦</span>
          <div>
            <div style={{ fontFamily: FONT.mono, fontSize: 16, color: COLOR.text }}>vulcan_hero_2026-05-04.zip</div>
            <div style={{ fontFamily: FONT.body, fontSize: 12, color: COLOR.textDim, marginTop: 2 }}>4 aspects · clean + watermarked · credit.txt · 14.2 MB</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 6 · COMMS ──────────
 *  Three columns: Frame.io thread, Mail draft, Calendar event. Each is a card
 *  that pops in sequentially. */
const CommsScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ padding: '110px 60px 120px' }}>
      <SceneLabel chapter="05 · COMMS" title="Review · Mail · Calendar" opacity={e(f, [0, 18], [0, 1])} />
      <div style={{ marginTop: 120, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
        {/* Frame.io */}
        <div style={{ opacity: e(f, [40, 70], [0, 1]), transform: `translateY(${e(f, [40, 70], [30, 0])}px)` }}>
          <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginBottom: 10 }}>FRAME.IO · vulcan_v3.mp4</div>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { who: 'Daniel @ Aston', tc: '0:14', text: 'Tail card needs 2 more frames before the cut.' },
                { who: 'Marcus @ FOM',   tc: '0:23', text: 'On it.' },
                { who: 'Marcus @ FOM',   tc: 'STATUS', text: 'Set to NEEDS REVIEW', highlight: true },
              ].map((c, i) => (
                <div key={i} style={{ borderLeft: `2px solid ${c.highlight ? COLOR.green : COLOR.red}`, paddingLeft: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT.mono, fontSize: 11, color: COLOR.textDim }}>
                    <span>{c.who}</span><span>{c.tc}</span>
                  </div>
                  <div style={{ fontFamily: FONT.body, fontSize: 14, color: COLOR.text, marginTop: 2 }}>{c.text}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Mail draft */}
        <div style={{ opacity: e(f, [110, 140], [0, 1]), transform: `translateY(${e(f, [110, 140], [30, 0])}px)` }}>
          <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginBottom: 10 }}>MAIL · DRAFT</div>
          <Card accent="yellow">
            <div style={{ fontFamily: FONT.mono, fontSize: 11, color: COLOR.textDim, marginBottom: 4 }}>To: sarah@example.press</div>
            <div style={{ fontFamily: FONT.body, fontSize: 14, fontWeight: 500, color: COLOR.text, marginBottom: 8 }}>Vantage S — shoot day confirmation</div>
            <div style={{ fontFamily: FONT.body, fontSize: 13, color: COLOR.textDim, lineHeight: 1.4 }}>
              Sarah — confirming Friday at Goodwood, 9 AM call time. Crew of three plus the C8. We'll bring the full motion-control rig…
            </div>
            <div style={{
              marginTop: 12, padding: '6px 10px', background: COLOR.ink2,
              fontFamily: FONT.display, fontSize: 10, letterSpacing: '0.2em', color: COLOR.yellow,
              textAlign: 'center', border: `1px solid ${COLOR.yellow}`,
            }}>OPENS FOR APPROVAL — NEVER AUTO-SENT</div>
          </Card>
        </div>

        {/* Calendar */}
        <div style={{ opacity: e(f, [200, 230], [0, 1]), transform: `translateY(${e(f, [200, 230], [30, 0])}px)` }}>
          <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginBottom: 10 }}>CALENDAR · NEW EVENT</div>
          <Card accent="green">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
              <div style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 32, color: COLOR.text, lineHeight: 1 }}>FRI</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 18, color: COLOR.red }}>09:00</div>
            </div>
            <div style={{ fontFamily: FONT.body, fontSize: 16, color: COLOR.text, fontWeight: 500 }}>Goodwood — Aston Vantage Press Day</div>
            <div style={{ fontFamily: FONT.body, fontSize: 12, color: COLOR.textDim, marginTop: 6, lineHeight: 1.5 }}>
              Goodwood Motor Circuit · Crew: 3 + C8 + motion rig · Embargo: 18:00
            </div>
            <div style={{ marginTop: 10, fontFamily: FONT.display, fontSize: 10, letterSpacing: '0.2em', color: COLOR.green }}>✓ ADDED TO macOS CALENDAR</div>
          </Card>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 7 · NLE ──────────
 *  Left: Premiere timeline with clips on V1. Right: Lightroom XMP sidecar
 *  emerging next to a RAW. */
const NleScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  /* Timeline: 5 clips appearing one-by-one. */
  const clips = Array.from({ length: 6 }).map((_, i) => ({
    at: 40 + i * 16,
    width: [180, 110, 220, 90, 150, 120][i],
  }));
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', gap: 32 }}>
      <SceneLabel chapter="06 · ADOBE INTEGRATIONS" title="Premiere · Lightroom" opacity={e(f, [0, 18], [0, 1])} />

      {/* Premiere timeline */}
      <div style={{ flex: 1, marginTop: 110 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginBottom: 10 }}>PREMIERE PRO 2025 · ROUGH CUT</div>
        <div style={{
          background: '#15171a', border: `1px solid ${COLOR.line}`, padding: 16, clipPath: BLADE_CLIP,
        }}>
          {/* Track header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ width: 50, fontFamily: FONT.mono, fontSize: 10, color: COLOR.textDim }}>V1</span>
            <span style={{ fontFamily: FONT.body, fontSize: 11, color: COLOR.textDim }}>Vulcan_RoughCut</span>
          </div>
          {/* Clips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 48 }}>
            {clips.map((c, i) => {
              const opacity = e(f, [c.at, c.at + 18], [0, 1]);
              const colors = [COLOR.redDeep, COLOR.red, COLOR.redDeep, COLOR.red, COLOR.redDeep, COLOR.red];
              return (
                <div key={i} style={{
                  width: c.width, height: 38, opacity,
                  background: `linear-gradient(180deg, ${colors[i]} 0%, ${COLOR.redDeep} 100%)`,
                  border: `1px solid ${COLOR.red}`, fontFamily: FONT.mono, fontSize: 9,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLOR.text,
                }}>CLIP_{(i + 1).toString().padStart(2, '0')}</div>
              );
            })}
          </div>
          {/* Track header A1 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 8 }}>
            <span style={{ width: 50, fontFamily: FONT.mono, fontSize: 10, color: COLOR.textDim }}>A1</span>
          </div>
          {/* Audio waveform stub */}
          <div style={{
            height: 26,
            background: `repeating-linear-gradient(90deg, ${COLOR.green} 0 2px, transparent 2px 4px)`,
            opacity: e(f, [120, 160], [0, 0.5]),
          }} />
        </div>
        <div style={{ marginTop: 12, fontFamily: FONT.mono, fontSize: 12, color: COLOR.textDim, opacity: e(f, [160, 190], [0, 1]) }}>
          ← premiere_create_sequence_from_folder("shoots/2026-05-01-vulcan")
        </div>
      </div>

      {/* Lightroom XMP */}
      <div style={{ width: 480, marginTop: 110, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red }}>LIGHTROOM · XMP SIDECAR</div>
        <Card accent="line" style={{
          opacity: e(f, [220, 260], [0, 1]),
          transform: `translateY(${e(f, [220, 260], [20, 0])}px)`,
        }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: 90, height: 90, background: COLOR.ink2, border: `1px solid ${COLOR.line}`, position: 'relative', flexShrink: 0 }}>
              <div style={{
                position: 'absolute', inset: 8,
                background: `linear-gradient(135deg, ${COLOR.redDeep}, ${COLOR.red})`,
                opacity: 0.5,
              }} />
              <div style={{
                position: 'absolute', bottom: 4, left: 6,
                fontFamily: FONT.mono, fontSize: 9, color: COLOR.text,
              }}>IMG_142.dng</div>
            </div>
            <div style={{ flex: 1, fontFamily: FONT.mono, fontSize: 11, color: COLOR.textDim, lineHeight: 1.5 }}>
              <span style={{ color: COLOR.green }}>+</span> IMG_142.xmp<br />
              <span style={{ color: COLOR.textDim }}>  preset:</span> <span style={{ color: COLOR.red }}>"FOM Aston Grade"</span><br />
              <span style={{ color: COLOR.textDim }}>  temp: </span><span style={{ color: COLOR.text }}>5400K</span><br />
              <span style={{ color: COLOR.textDim }}>  highlights:</span> <span style={{ color: COLOR.text }}>-32</span><br />
              <span style={{ color: COLOR.textDim }}>  shadows:</span> <span style={{ color: COLOR.text }}>+18</span>
            </div>
          </div>
        </Card>
        <div style={{
          opacity: e(f, [280, 310], [0, 1]),
          fontFamily: FONT.display, fontSize: 11, letterSpacing: '0.2em', color: COLOR.green,
        }}>✓ 14 SIDECARS WRITTEN — LIGHTROOM PICKS UP ON NEXT OPEN</div>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 8 · MEMORY + STYLE ──────────
 *  Left: memory cards (contact / project / fact / conversation).
 *  Right: style signature panel with numerical readout + delta diff. */
const MemoryScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const memCards = [
    { kind: 'CONTACT',  primary: 'Sarah Mitchell · Press office', secondary: 'last seen 3 days ago · sarah@example.press', at: 30 },
    { kind: 'PROJECT',  primary: 'Vulcan AMR Pro',             secondary: 'Active · 14 hero shots · Goodwood reveal', at: 70 },
    { kind: 'FACT',     primary: '"FOM look" =',                secondary: 'warm bias, mid sat, medium contrast',       at: 110 },
    { kind: 'CONV',     primary: 'Vulcan brief 2026-05-01',    secondary: 'agreed 9:16 + 16:9 deliverables',           at: 150 },
  ];
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', gap: 32 }}>
      <SceneLabel chapter="07 · MEMORY + STYLE" title="Knows the studio" opacity={e(f, [0, 18], [0, 1])} />

      <div style={{ flex: 1, marginTop: 110, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red }}>PERSISTENT MEMORY</div>
        {memCards.map((c) => (
          <div key={c.kind} style={{
            opacity: e(f, [c.at, c.at + 24], [0, 1]),
            transform: `translateX(${e(f, [c.at, c.at + 24], [-30, 0])}px)`,
            padding: '12px 18px',
            background: COLOR.ink1, border: `1px solid ${COLOR.red}`, clipPath: BLADE_CLIP,
          }}>
            <div style={{ fontFamily: FONT.display, fontSize: 10, letterSpacing: '0.4em', color: COLOR.red, marginBottom: 4 }}>{c.kind}</div>
            <div style={{ fontFamily: FONT.body, fontSize: 18, color: COLOR.text, fontWeight: 500 }}>{c.primary}</div>
            <div style={{ fontFamily: FONT.body, fontSize: 13, color: COLOR.textDim, marginTop: 2 }}>{c.secondary}</div>
          </div>
        ))}
      </div>

      {/* Right: style signature */}
      <div style={{ width: 540, marginTop: 110, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red,
          opacity: e(f, [200, 230], [0, 1]),
        }}>STYLE: "FOM ASTON"</div>

        <Card style={{ opacity: e(f, [200, 230], [0, 1]) }}>
          <div style={{ fontFamily: FONT.body, fontSize: 13, color: COLOR.textDim, fontStyle: 'italic', marginBottom: 12 }}>
            warm bias · mid saturation · medium contrast · balanced exposure
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: FONT.mono, fontSize: 13 }}>
            {[
              ['warmBias', '+0.04'],
              ['saturation', '0.18'],
              ['contrast', '0.16'],
              ['luminance', '0.42'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', background: COLOR.ink2 }}>
                <span style={{ color: COLOR.textDim }}>{k}</span>
                <span style={{ color: COLOR.text }}>{v}</span>
              </div>
            ))}
          </div>
        </Card>

        <div style={{
          fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red,
          opacity: e(f, [320, 350], [0, 1]),
          marginTop: 14,
        }}>COMPARE NEW GRADE</div>
        <Card accent="yellow" style={{ opacity: e(f, [320, 350], [0, 1]) }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 13, color: COLOR.text, lineHeight: 1.7 }}>
            <span style={{ color: COLOR.yellow }}>Δ warmBias  +0.07</span><br />
            <span style={{ color: COLOR.yellow }}>Δ contrast  -0.03</span><br />
            <span style={{ color: COLOR.yellow }}>Δ saturation +0.02</span>
          </div>
          <div style={{
            marginTop: 12, padding: '8px 12px', background: COLOR.ink2,
            fontFamily: FONT.body, fontSize: 13, color: COLOR.text, fontStyle: 'italic',
          }}>"Cool by 0.04, raise contrast by 0.03 to match."</div>
        </Card>
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 9 · STUDIO ──────────
 *  Phone-as-mic mock + media-day calendar feed + press radar headlines. */
const StudioScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', gap: 28 }}>
      <SceneLabel chapter="08 · ON LOCATION + INTEL" title="Live shoot · Calendar · Press" opacity={e(f, [0, 18], [0, 1])} />

      {/* Phone */}
      <div style={{ width: 280, marginTop: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red }}>LIVE SHOOT MODE</div>
        <div style={{
          width: 220, height: 440,
          background: COLOR.ink0, borderRadius: 32, border: `7px solid #2a2a2c`, padding: 12,
          opacity: e(f, [40, 70], [0, 1]),
          transform: `translateY(${e(f, [40, 80], [40, 0])}px)`,
        }}>
          <div style={{ width: '100%', height: '100%', background: COLOR.ink1, borderRadius: 18, padding: 14, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontFamily: FONT.display, fontSize: 11, letterSpacing: '0.2em', color: COLOR.red }}>FLAT-OUT LIVE</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 9, color: COLOR.green, marginTop: 4 }}>● connected</div>
              <div style={{ marginTop: 14, fontFamily: FONT.body, fontSize: 9, color: COLOR.textDim }}>
                <div style={{ opacity: e(f, [120, 140], [0, 1]) }}>14:23  HERO → IMG_142.jpg</div>
                <div style={{ opacity: e(f, [160, 180], [0, 1]), marginTop: 4 }}>14:24  RESHOOT, low light</div>
                <div style={{ opacity: e(f, [200, 220], [0, 1]), marginTop: 4 }}>14:26  HERO → IMG_148.jpg</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {['HERO', 'KEEP', 'MAYBE', 'RESHOOT'].map((b) => (
                <div key={b} style={{
                  padding: '8px 4px',
                  background: b === 'HERO' && f > 110 && f < 130 ? COLOR.red : COLOR.ink2,
                  border: `1px solid ${b === 'HERO' ? COLOR.red : COLOR.line}`,
                  fontFamily: FONT.display, fontSize: 9, letterSpacing: '0.15em',
                  color: b === 'HERO' && f > 110 && f < 130 ? COLOR.ink0 : (b === 'HERO' ? COLOR.red : COLOR.text),
                  textAlign: 'center',
                }}>{b}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Media-day calendar */}
      <div style={{ flex: 1, marginTop: 100 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginBottom: 10 }}>MEDIA-DAY CALENDAR</div>
        {[
          { make: 'Aston', model: 'Vantage S', date: 'FRI 12 MAY', loc: 'Goodwood', kind: 'press-day', at: 80 },
          { make: 'McLaren', model: '750S launch', date: 'WED 17 MAY', loc: 'Silverstone', kind: 'launch', at: 130 },
          { make: 'Bentley', model: 'Continental GT', date: 'TUE 23 MAY', loc: 'Crewe', kind: 'press-day', at: 180 },
          { make: 'Lotus', model: 'Eletre R track day', date: 'FRI 02 JUN', loc: 'Hethel', kind: 'track-day', at: 230 },
        ].map((evt) => (
          <div key={evt.model} style={{
            opacity: e(f, [evt.at, evt.at + 24], [0, 1]),
            transform: `translateX(${e(f, [evt.at, evt.at + 24], [40, 0])}px)`,
            padding: '10px 16px',
            background: COLOR.ink1, border: `1px solid ${COLOR.line}`, clipPath: BLADE_CLIP,
            display: 'grid', gridTemplateColumns: '120px 1fr 100px 90px', gap: 12, alignItems: 'center',
            marginBottom: 8,
          }}>
            <span style={{ fontFamily: FONT.mono, fontSize: 13, color: COLOR.red }}>{evt.date}</span>
            <span style={{ fontFamily: FONT.body, fontSize: 14, color: COLOR.text }}>{evt.make} {evt.model}</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12, color: COLOR.textDim }}>{evt.loc}</span>
            <span style={{ fontFamily: FONT.display, fontSize: 10, letterSpacing: '0.15em', color: COLOR.red, textTransform: 'uppercase', textAlign: 'right' }}>{evt.kind}</span>
          </div>
        ))}

        <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: '0.3em', color: COLOR.red, marginTop: 18, marginBottom: 10, opacity: e(f, [280, 310], [0, 1]) }}>PRESS RADAR · TODAY</div>
        {[
          { src: 'autocar', headline: 'McLaren teases new 750S Spider — embargo 17 May', at: 310 },
          { src: 'topgear', headline: 'Aston Martin Vantage S walkaround — first impressions', at: 350 },
        ].map((p) => (
          <div key={p.headline} style={{
            opacity: e(f, [p.at, p.at + 24], [0, 1]),
            padding: '8px 14px',
            background: COLOR.ink2, borderLeft: `3px solid ${COLOR.yellow}`,
            fontFamily: FONT.body, fontSize: 13, color: COLOR.text,
            marginBottom: 6, display: 'flex', gap: 14, alignItems: 'center',
          }}>
            <span style={{ fontFamily: FONT.display, fontSize: 10, letterSpacing: '0.3em', color: COLOR.yellow, minWidth: 60 }}>{p.src.toUpperCase()}</span>
            <span style={{ color: COLOR.textDim }}>{p.headline}</span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 10 · MCP + OUTRO ──────────
 *  MCP host grid pops in, then closer text. */
const OutroScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const titleOpacity = e(f, [0, 24], [0, 1]);
  const flashOpacity = e(f, [duration - 30, duration - 10, duration], [0, 0.6, 0]);
  const hosts = ['CLAUDE DESKTOP', 'CLAUDE CODE', 'CURSOR', 'CONTINUE'];
  const closerAt = 200;
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
      <SceneLabel chapter="09 · MCP" title="One kiosk, every host" opacity={titleOpacity} />

      <div style={{ marginTop: 120, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, width: '70%' }}>
        {hosts.map((h, i) => {
          const at = 30 + i * 18;
          const opacity = e(f, [at, at + 18], [0, 1]);
          const scale = e(f, [at, at + 24], [0.7, 1.0]);
          return (
            <div key={h} style={{
              opacity, transform: `scale(${scale})`,
              padding: '28px 14px',
              background: COLOR.ink1,
              border: `1px solid ${COLOR.red}`,
              clipPath: BLADE_CLIP,
              fontFamily: FONT.display, fontSize: 16, letterSpacing: '0.15em',
              color: COLOR.text, textAlign: 'center',
              boxShadow: `0 0 18px ${COLOR.redGlow}`,
            }}>{h}</div>
          );
        })}
      </div>

      <div style={{
        opacity: e(f, [120, 150], [0, 1]),
        marginTop: 12, padding: '10px 22px', background: COLOR.ink2, border: `1px solid ${COLOR.line}`,
        fontFamily: FONT.mono, fontSize: 14, color: COLOR.textDim,
      }}>"url": "http://localhost:8766/mcp"</div>

      {/* Closer */}
      <div style={{ marginTop: 40, opacity: e(f, [closerAt, closerAt + 24], [0, 1]), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <BladeMark size={90} />
        <div style={{ fontFamily: FONT.display, fontWeight: 700, fontSize: 56, letterSpacing: '-0.01em', color: COLOR.text, textTransform: 'uppercase' }}>76 tools. One voice.</div>
        <div style={{ fontFamily: FONT.body, fontSize: 18, color: COLOR.textDim, fontStyle: 'italic' }}>built for the agency that lives and breathes automotive</div>
      </div>

      {/* Brand red flash */}
      <div style={{ position: 'absolute', inset: 0, background: COLOR.red, opacity: flashOpacity, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

const SCENE_COMPONENTS: Record<SceneId, React.FC<{ duration: number }>> = {
  c_title:  TitleScene,
  c_voice:  VoiceScene,
  c_vision: VisionScene,
  c_edit:   EditScene,
  c_brand:  BrandScene,
  c_comms:  CommsScene,
  c_nle:    NleScene,
  c_memory: MemoryScene,
  c_studio: StudioScene,
  c_outro:  OutroScene,
};
