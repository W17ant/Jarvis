# 90-second demo video — script + shot list

> Operator-recorded. Target: someone scrolling Twitter / HN / a tech newsletter
> who's never heard of Jarvis. They've got 5 seconds to decide whether to
> watch the rest, 30 seconds to decide whether to install, 90 seconds total.
>
> Resolution: 2560×1440 minimum (recorded at 27"+ kiosk size). Aspect 16:9.
> Audio: 48 kHz, voice-only — no music. The HUD's own audio (TTS replies)
> carries the moments that matter. Music drowns the value prop.

## Tooling

- **Screen recording**: macOS built-in (Cmd+Shift+5 → entire screen) at the kiosk display's full resolution. ScreenStudio or CleanShot X if you want zoom-in transitions, but stock macOS works.
- **Voice-over**: lavalier mic into QuickTime's "New Audio Recording" or Audacity. Record dry, layer into the cut later.
- **Cut**: DaVinci Resolve (free) or iMovie. No fancy effects needed — straight cuts only. The pacing is in the script.

## Pre-flight

Before recording:

- [ ] `./launch.sh restart` — clean perf buffer, no stale state
- [ ] Clear `data/audit/sessions/$(date +%Y-%m-%d).jsonl` so the diagnostic ZIP shot is empty
- [ ] Set Mac to Do Not Disturb
- [ ] Disconnect Bluetooth devices that might pop notifications mid-shot
- [ ] Hide the Dock (System Settings → Desktop & Dock → Automatically hide)
- [ ] Hide the menu bar in System Settings → Control Center → Auto-hide
- [ ] Mute all browser tabs in the Chrome that's NOT running Jarvis
- [ ] Test the wake word once before rolling
- [ ] Have a glass of water — the VO is one continuous take

---

## The cut (90 seconds total)

### 0:00 – 0:05 · OPEN — wake-word moment
- **VISUAL**: Static shot of the HUD on a dark display. Reactor pulses idle.
- **AUDIO**: Operator voice (live) — *"Hey Jarvis."*
- **VISUAL**: Reactor flares cyan. State chip flips STANDBY → LISTENING.
- **VO** (post): _none — let the wake-fire visual sell it_

### 0:05 – 0:15 · HOOK — first command + answer
- **VISUAL**: Continuation. Operator: *"What's the weather and what's on my calendar today?"*
- **VISUAL**: Whisper transcript appears on the right rail. State → THINKING. Reactor pulses.
- **AUDIO**: Jarvis (Kokoro TTS) replies: *"Partly clouded, fourteen degrees in Leicester. You've got the team standup at ten and a coffee with Marcus at three."* (real reply from your /weather + /diary tools)
- **VISUAL**: Calendar rail highlights the two events. Weather pod updates.

### 0:15 – 0:22 · LATENCY HOOK — the headline number
- **VISUAL**: Cut to the latency debug panel (Shift+Cmd+P). Show the rolling spans with `voice_to_audio` p50 in cyan.
- **VO**: *"Sub-second from wake to first audio. All on this Mac. No cloud."*

### 0:22 – 0:35 · TOOLS — show the breadth
- **VISUAL**: Click the `?` button — COMMANDS panel opens with the five categorised columns.
- **VO**: *"Sixty-plus voice-callable tools. Mail. Calendar. Code agent. Browser automation. Knowledge base over your own documents. All exposed via MCP, so Claude Desktop and Cursor can drive the same kiosk."*
- **VISUAL** (cut, beat): Run a tool live. Operator: *"Hey Jarvis, summarise my unread mail."* Show the LLM streaming a 4-bullet summary into the transcript drawer.

### 0:35 – 0:55 · CPU/GPU TELEMETRY — the differentiator
- **VISUAL**: Push in on the core-telemetry pod. Show CPU usage / CPU temp / GPU usage / GPU temp / RAM / VRAM / down / up dials.
- **VO**: *"Every dial is real. Sudoless Apple Silicon temps via macmon — the kind of detail every other AI desktop app fakes. The reactor isn't just a logo, it's an instrument cluster."*
- **VISUAL** (beat): Trigger a heavy workload to make the CPU dial swing — `code_agent_run` on a non-trivial prompt, or just a vision tool on a screenshot.

### 0:55 – 1:10 · WHITE-LABEL — the wedge
- **VISUAL**: Open Settings → Brand identity. Show the current name "Jarvis" / wake "hey jarvis" / cyan accent. Change agent name to something else — *"Aria"* — accent to a different colour, hit Save.
- **VISUAL**: HUD live-reloads. Wordmark, transcript role badge, reactor accent all flip in real-time.
- **VO**: *"White-label by design. Edit one config file. Ship the same kiosk to a client under their brand."*

### 1:10 – 1:25 · PRIVACY — the moat
- **VISUAL**: Cut to the docs site `/privacy` page. Highlight the "TL;DR — nothing leaves your machine without your explicit, per-action consent" line.
- **VO**: *"Default config: zero outbound network calls. No analytics. No telemetry server. Your conversation history stays in a SQLite file you can delete. The MIT codebase means you can audit every line."*

### 1:25 – 1:30 · CLOSE
- **VISUAL**: Cut back to the HUD with the wordmark + the Stark vibe.
- **VO**: *"Jarvis. Voice-first AI for Apple Silicon. Free, MIT-licensed, on GitHub now."*
- **VISUAL**: End card — repo URL + the cyan reactor + `github.com/W17ANT/Jarvis` for 2 seconds, then black.

---

## VO copy (one continuous block — read in 30-40 seconds, layered over the visual)

> Sub-second from wake to first audio. All on this Mac. No cloud.
>
> Sixty-plus voice-callable tools — mail, calendar, code agent, browser automation, knowledge base over your own documents. All exposed via MCP, so Claude Desktop and Cursor can drive the same kiosk.
>
> Every dial is real. Sudoless Apple Silicon temps via macmon — the kind of detail every other AI desktop app fakes. The reactor isn't just a logo, it's an instrument cluster.
>
> White-label by design. Edit one config file. Ship the same kiosk to a client under their brand.
>
> Default config: zero outbound network calls. No analytics. No telemetry server. Your conversation history stays in a SQLite file you can delete. The MIT codebase means you can audit every line.
>
> Jarvis. Voice-first AI for Apple Silicon. Free, MIT-licensed, on GitHub now.

## Backup B-roll

If the live demo flubs (wake word misses, network glitch, LLM stalls), have these pre-recorded so you can splice them in:

- 5 seconds of the reactor wake-fire pulse, looping
- 5 seconds of the latency debug panel scrolling through 30 turns
- 5 seconds of the COMMANDS panel categories
- 5 seconds of the white-label brand swap (record both directions: cyan → other colour, then back)
- The diagnostic ZIP export click → tarball appearing on Desktop (10 seconds)

## Where to publish

| Channel | Format | Duration |
|---|---|---|
| GitHub README hero | Embedded MP4 or animated GIF | 90s full |
| Twitter / X | MP4 ≤2:20, ≤512MB | Full 90s |
| LinkedIn | MP4 ≤10 min | Full 90s |
| HN Show | Link to the GitHub README, no video upload | n/a |
| Bluesky | MP4 ≤60s | Cut to 0:00–1:10 (drop the privacy section, keep brand swap as the close) |
| TikTok / Shorts | MP4 ≤60s vertical | Different shot list — re-record vertically; not a re-cut of this |

## Checklist before publishing

- [ ] Subtitles burned in (auto-generate from QuickTime, manually verify)
- [ ] Loud-norm pass at -16 LUFS for streaming-platform compatibility
- [ ] First frame is the reactor + wordmark, not a startup splash
- [ ] No personal info leaked (calendar event names, email senders, file paths showing real client names)
- [ ] CHANGELOG updated with `[demo-video]` entry pointing at the asset path
