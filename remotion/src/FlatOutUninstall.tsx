/** FlatOutUninstall.tsx — short companion clip showing the uninstall flow.
 *
 *  ~25s. Same brand chrome as the main overview, same Daniel narration. The
 *  scene logic mirrors what tools/uninstall-wizard.sh actually does so the
 *  visualisation is truthful — every "✓" item maps to a real teardown step
 *  the wizard performs interactively. */

import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, Easing, interpolate } from 'remotion';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadRubik } from '@remotion/google-fonts/Rubik';
import { loadFont as loadJetBrains } from '@remotion/google-fonts/JetBrainsMono';
import manifest from '../public/audio/uninstall-manifest.json';
import { COLOR, FONT, BLADE_CLIP } from './brand';
import { Backdrop, BladeMark, Wordmark, TerminalFrame, Subtitle, SceneLabel, e } from './components';

loadOswald();
loadRubik();
loadJetBrains();

type SceneId = 'u_title' | 'u_wizard' | 'u_done';
const PAD_FRAMES = 18;
const PAD_OUTRO = 45;

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
export function getUninstallTotalFrames() {
  return timeline.reduce((a, t) => a + t.duration, 0) || 700;
}

/* ────────── MAIN COMPOSITION ────────── */
export const FlatOutUninstall: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: COLOR.ink0 }}>
      <Backdrop />
      {timeline.map((scene) => (
        <Sequence key={scene.id} from={scene.start} durationInFrames={scene.duration}>
          <SceneRouter id={scene.id} text={scene.text} file={scene.file} duration={scene.duration} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

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

/* ────────── SCENE 1 · TITLE ──────────
 *  Brand mark + "UNINSTALL" caption. Tighter than the overview's title — just a
 *  beat to set context before we cut to the terminal. */
const TitleScene: React.FC<{ duration: number }> = () => {
  const f = useCurrentFrame();
  const opacity = e(f, [0, 18], [0, 1]);
  const scale = e(f, [0, 24], [0.85, 1.0]);
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 28 }}>
      <div style={{ opacity, transform: `scale(${scale})` }}>
        <BladeMark size={130} />
      </div>
      <div style={{ opacity }}>
        <Wordmark scale={1.0} />
      </div>
      <div style={{
        opacity,
        marginTop: 12,
        padding: '10px 28px',
        border: `1px solid ${COLOR.red}`,
        clipPath: BLADE_CLIP,
        background: COLOR.ink1,
        fontFamily: FONT.display, fontWeight: 700, fontSize: 22, letterSpacing: '0.5em',
        color: COLOR.red, textTransform: 'uppercase',
      }}>UNINSTALL</div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 2 · WIZARD WALKTHROUGH ──────────
 *  Terminal showing the uninstall-wizard.sh prompts + a side-panel that ticks
 *  off teardown items as the wizard works through them. Mirrors the actual
 *  step ordering in tools/uninstall-wizard.sh. */
const WizardScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  /* Side-panel teardown items — each lights green at its `at` frame to mirror
   * the wizard's progress. Order matches the script's actual flow. */
  const items = [
    { label: 'LaunchAgent removed',         at: 60  },
    { label: 'Services stopped (bridge / kokoro / whisper)', at: 100 },
    { label: 'Tailscale serve config cleared', at: 140 },
    { label: 'Project artifacts (output/, frame-cache, node_modules)', at: 200 },
    { label: 'Ollama models (qwen2.5:32b, qwen2.5vl:7b, nomic)', at: 260 },
    { label: 'config/brand.json + .env',    at: 320 },
  ];
  /* Terminal lines — the wizard's actual style with ▶ headers, ✓ confirmations,
   * dim · info lines. Lines reveal in order to match the side-panel ticks. */
  const termLines = [
    { text: '$ ./tools/uninstall-wizard.sh', kind: 'cmd', at: 0 },
    { text: '', kind: 'blank', at: 18 },
    { text: '  ── UNINSTALL WIZARD ──', kind: 'header', at: 18 },
    { text: '', kind: 'blank', at: 30 },
    { text: '▶ LaunchAgent', kind: 'step', at: 36 },
    { text: '  ✓ removed ~/Library/LaunchAgents/com.flatoutmedia.hud.plist', kind: 'ok', at: 56 },
    { text: '▶ Running processes', kind: 'step', at: 80 },
    { text: '  ✓ stopped bridge (pid 41827) · kokoro · whisper', kind: 'ok', at: 96 },
    { text: '▶ Tailscale serve', kind: 'step', at: 120 },
    { text: '  ✓ removed serve config for kiosk.flatout.ts.net', kind: 'ok', at: 136 },
    { text: '▶ Project artifacts (output/, data/frame-cache, node_modules)', kind: 'step', at: 170 },
    { text: '  Remove these now? [Y/n]: y', kind: 'prompt', at: 184 },
    { text: '  ✓ freed 4.2 GB', kind: 'ok', at: 196 },
    { text: '▶ Ollama models pulled by install.sh', kind: 'step', at: 230 },
    { text: '  Remove qwen2.5:32b, qwen2.5vl:7b, nomic-embed-text? [Y/n]: y', kind: 'prompt', at: 244 },
    { text: '  ✓ freed 21.4 GB', kind: 'ok', at: 256 },
    { text: '▶ config/brand.json + .env', kind: 'step', at: 290 },
    { text: '  Backed up to /tmp/flat-out-config-backup-2026-05-04.tgz', kind: 'info', at: 304 },
    { text: '  ✓ removed', kind: 'ok', at: 316 },
  ];
  return (
    <AbsoluteFill style={{ padding: '110px 80px 120px', display: 'flex', gap: 36 }}>
      <SceneLabel chapter="UNINSTALL" title="Conservative defaults" opacity={e(f, [0, 18], [0, 1])} />

      {/* LEFT: terminal */}
      <div style={{ flex: 1, marginTop: 100 }}>
        <TerminalFrame title="antony@m5max — bash — uninstall-wizard" width="100%" height={520}>
          {termLines.map((line, i) => {
            const opacity = e(f, [line.at, line.at + 12], [0, 1]);
            const color =
              line.kind === 'cmd'    ? '#5dd1a3' :
              line.kind === 'ok'     ? COLOR.green :
              line.kind === 'step'   ? '#7ab8ff' :
              line.kind === 'prompt' ? COLOR.yellow :
              line.kind === 'info'   ? COLOR.textDim :
              line.kind === 'header' ? COLOR.red :
              '#e6e6e6';
            return (
              <div key={i} style={{ color, opacity, marginTop: line.kind === 'blank' ? 0 : 2, fontSize: line.kind === 'header' ? 20 : 16, fontFamily: line.kind === 'header' ? FONT.display : FONT.mono, letterSpacing: line.kind === 'header' ? '0.4em' : 0 }}>
                {line.text || ' '}
              </div>
            );
          })}
        </TerminalFrame>
      </div>

      {/* RIGHT: teardown checklist */}
      <div style={{ width: 460, marginTop: 100, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 16, letterSpacing: '0.3em', color: COLOR.red, opacity: e(f, [12, 30], [0, 1]) }}>
          TEARDOWN CHECKLIST
        </div>
        {items.map((it, i) => {
          const isDone = f >= it.at;
          const opacity = e(f, [12 + i * 4, 36 + i * 4], [0, 1]);
          return (
            <div key={it.label} style={{
              opacity,
              padding: '12px 16px',
              background: COLOR.ink1,
              border: `1px solid ${isDone ? COLOR.green : COLOR.line}`,
              clipPath: BLADE_CLIP,
              display: 'flex', alignItems: 'center', gap: 14,
              transition: 'border-color 0.2s',
            }}>
              <div style={{
                width: 22, height: 22,
                border: `1.5px solid ${isDone ? COLOR.green : COLOR.textDim}`,
                background: isDone ? COLOR.green : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: FONT.mono, fontSize: 14, color: COLOR.ink0, fontWeight: 700,
              }}>{isDone ? '✓' : ''}</div>
              <span style={{
                fontFamily: FONT.body, fontSize: 14,
                color: isDone ? COLOR.text : COLOR.textDim,
                lineHeight: 1.3,
              }}>{it.label}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ────────── SCENE 3 · DONE ──────────
 *  Big "CLEAN MACHINE" card + the freed-disk total. Brand red bar at the bottom
 *  with "3 commands to install · 1 to remove" so the viewer's last visual is
 *  the install/uninstall symmetry. */
const DoneScene: React.FC<{ duration: number }> = ({ duration }) => {
  const f = useCurrentFrame();
  const opacity = e(f, [0, 18], [0, 1]);
  const scale = interpolate(f, [0, duration], [1.0, 1.04], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  /* The freed-disk number ticks up from 0 to 25.6 GB over the first ~1.5 seconds
   * — quick visual reward for committing to the wipe. */
  const freedGb = interpolate(f, [0, 45], [0, 25.6], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 32 }}>
      <div style={{ opacity, transform: `scale(${scale})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        <div style={{
          fontFamily: FONT.display, fontWeight: 700, fontSize: 88, letterSpacing: '-0.01em',
          color: COLOR.text, textTransform: 'uppercase',
        }}>Clean machine.</div>
        <div style={{
          padding: '14px 40px',
          background: COLOR.ink1,
          border: `1px solid ${COLOR.green}`,
          clipPath: BLADE_CLIP,
          fontFamily: FONT.mono, fontSize: 28, color: COLOR.green,
        }}>{freedGb.toFixed(1)} GB recovered</div>
        <div style={{
          marginTop: 28,
          fontFamily: FONT.display, fontSize: 18, letterSpacing: '0.5em',
          color: COLOR.red, textTransform: 'uppercase',
        }}>3 COMMANDS TO INSTALL · 1 TO REMOVE</div>
      </div>
    </AbsoluteFill>
  );
};

const SCENE_COMPONENTS: Record<SceneId, React.FC<{ duration: number }>> = {
  u_title:  TitleScene,
  u_wizard: WizardScene,
  u_done:   DoneScene,
};
