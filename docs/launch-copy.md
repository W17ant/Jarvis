# Launch copy

> Ready-to-paste copy for the public launch. Adapt per channel; don't post any
> of these until Adam's fork is done and PR #2 is merged. Post in this order:
> README polish + repo settings → demo video upload → social posts → HN.

## Repo settings to verify before launch

- [ ] **About**: paste from `.github/repo-topics.md` "Repo About copy" section
- [ ] **Topics**: paste from `.github/repo-topics.md` "Primary + Secondary topics" lists
- [ ] **Social preview**: upload `.github/social-preview.png` (Settings → Social preview → Edit)
- [ ] **Website**: link to the deployed docs site (`jarvis.aoneill.co.uk` if that's the choice; otherwise the GitHub Pages URL once deployed)
- [ ] **Description** + **Topics** flow through to GitHub search ranking — don't skip
- [ ] First commit on `main` post-merge has the demo video link in the message body so the GitHub front-page commit feed surfaces it

## Twitter / X (280 chars)

**Variant 1 — the Stark vibe (lead with aesthetic):**

> Voice-first AI assistant with an instrument-cluster HUD.
>
> Local LLM. Real CPU/GPU temps. Kiosk-mode. White-label.
> Iron Man's interface, your Mac's brain.
>
> Open source. MIT. Apple Silicon.
>
> github.com/W17ANT/Jarvis

**Variant 2 — the privacy hook (lead with the moat):**

> Voice AI that never phones home.
>
> Whisper STT, local Ollama LLM, Kokoro TTS — all on your Mac. 60+ tools (mail, calendar, code-agent, browser). Hot-load plugins. White-label.
>
> Open source under MIT. Built for Apple Silicon.
>
> github.com/W17ANT/Jarvis

**Variant 3 — the wedge (lead with self-extending):**

> Built an AI kiosk that builds its own tools.
>
> Say *"hey jarvis, build me a plugin that fetches NOAA forecasts"* — it writes the manifest + handler, hot-loads, and the new tool is callable in the same session.
>
> Local LLM, MIT, Apple Silicon.
>
> github.com/W17ANT/Jarvis

## Bluesky (300 chars — same shape, slightly longer breathing room)

> Voice-first AI assistant with an instrument-cluster HUD. Local Whisper + Ollama + Kokoro on Apple Silicon. 60+ voice-callable tools. Hot-load plugins. White-label by design.
>
> Iron Man's interface, your Mac's brain.
>
> Open source under MIT.
> github.com/W17ANT/Jarvis

## LinkedIn (longer-form)

> **Jarvis — a voice-first AI workstation for solo professionals.**
>
> I've been building an open-source AI assistant that doesn't phone home. The pitch: instead of a chatbot in a window, it's a full-screen kiosk on your Mac with an instrument-cluster HUD — real CPU/GPU temps, voice waveform centerpiece, transcript drawer that surfaces every tool the agent ran.
>
> Sixty-plus voice-callable tools cover mail, calendar, browser automation, code-agent workflows, knowledge base over your docs. The whole thing runs on your Apple Silicon — Whisper for STT, Ollama for the LLM, Kokoro for TTS. Default config: zero outbound network calls.
>
> White-label by design — every brand string lives in `config/brand.json`. Solo professionals (lawyers, doctors, designers, consultants) can fork it, re-skin it under their practice name, and ship it to clients who can't put their data through ChatGPT.
>
> The Sprint 2 wedge: voice-callable plugin generator. Say *"build me a plugin that fetches the latest crypto prices"* — it scaffolds the manifest, writes a handler, hot-loads it, and the new tool is callable on the next turn.
>
> MIT licensed. No SaaS layer planned, ever.
>
> github.com/W17ANT/Jarvis
>
> #AI #LocalFirst #OpenSource #PrivacyByDesign #AppleSilicon

## Hacker News

**Title** (60 chars max for HN, leading verbs perform best):

> Show HN: Jarvis – local-first voice AI for Apple Silicon, MIT

**First comment (the "show your work" comment HN expects from authors):**

> Author here. Jarvis is a voice-first AI kiosk that runs entirely on Apple Silicon — Whisper STT, Ollama for the LLM (defaults to qwen2.5:7b), Kokoro for TTS, all local by default.
>
> The bits I'm most proud of:
>
> 1. **Sub-second voice-to-first-audio.** The sentence segmenter splits the LLM stream on comma/colon at ≥12 chars for the first chunk so TTS starts before the LLM has finished generating. Latency-debug overlay is a Shift+Cmd+P toggle.
>
> 2. **Hot-load plugins.** Drop a `manifest.json` + `handler.mjs` into `bridge/plugins/<name>/`, the bridge's fs.watch picks it up within 500ms, the new tool is voice-callable. There's also a `build_plugin` tool — say *"hey jarvis, build me a plugin that…"* and it scaffolds the files for you.
>
> 3. **Workspaces** (just landed). First-class operating contexts. Switch from "consulting" to "personal" workspace and the LLM's system prompt scope changes — the workspace's handbook (operator's scope-specific rules) gets injected.
>
> 4. **Real CPU/GPU temps** via `macmon` (sudoless SMC reader). Most AI desktop apps fake this.
>
> 5. **White-label by design.** Every brand string lives in `config/brand.json`. Hot-edit via Settings → Brand identity, the HUD live-reloads.
>
> Privacy story is in `docs/privacy.md` — the TL;DR is "nothing leaves your machine without explicit per-action consent." No analytics SDK, no telemetry server, no opt-in-default toggle. The opt-in upload of crash reports requires you to set `JARVIS_CRASH_REPORT_URL` to a self-hosted endpoint you stand up yourself.
>
> Apple Silicon only for v1. Linux + Windows ports are Horizon 3.
>
> Roadmap is `docs/vision-and-roadmap.md`. Happy to answer questions.

## Show & tell post (Discord / dev forums)

> **Just open-sourced Jarvis — voice-first AI kiosk for Apple Silicon, MIT.**
>
> 90s demo: [link to demo video]
>
> Local LLM, real CPU/GPU temps, hot-load plugins, white-label brand, MCP server, kiosk mode HUD.
>
> Repo: github.com/W17ANT/Jarvis
> Docs: [docs site URL]
> Privacy doc: github.com/W17ANT/Jarvis/blob/main/docs/privacy.md
>
> Built for solo professionals who can't put their data through ChatGPT.

## Day-of-launch checklist

In order, day of:

- [ ] All Manual tasks (#33, #39, #45) complete
- [ ] Demo video uploaded to YouTube as unlisted, link copied
- [ ] README hero updated to embed/link the video
- [ ] `npm run benchmark` populated `docs/benchmarks.md` with real numbers
- [ ] PR #2 merged; v0.2.0 tagged + pushed
- [ ] Homebrew tap published (task #44)
- [ ] Tweet posted (Variant 1 or 3)
- [ ] Bluesky cross-post
- [ ] LinkedIn post (longer-form)
- [ ] HN submission (DON'T post the HN link to Twitter — let it find its own audience first)
- [ ] Discord / Slack communities you're in (don't spam — one post per community)
- [ ] First-day analytics — track GitHub stars, demo video views, repo clones via `gh api` if curious

## Things to brace for

**HN top-level questions** (have answers ready):

- "What about Linux / Windows?" → Phase 5. Apple Silicon only for v1. Macmon is the platform-specific bit; the rest abstracts.
- "Why not just use Claude Desktop / ChatGPT Desktop?" → Privacy. Cloud round-trip per query. We don't.
- "What about the Marvel trademark?" → Operator-accepted risk. Defer rename until/if Marvel litigates.
- "How does the LLM get my email?" → It runs `get_mail_summary` via AppleScript locally; no email content leaves the Mac.
- "Sentry / crash reporting?" → Local-first by default. Operators with a self-hosted endpoint can opt in via env var. No SaaS dependency.
- "Why MIT and not AGPL?" → MIT is the trust signal. Operators in regulated industries need it. AGPL would scare them.

**Bad-faith critiques to ignore:**

- "Jarvis is Marvel's name" → Operator-accepted, see above
- "Apple Silicon only is anti-consumer" → It's a kiosk product, not a platform; we'll port when we ship Linux
- "Why is your HUD so 'extra'?" → Aesthetics are a feature; that's literally the wedge

**Genuine bugs to fix immediately if reported:**

- Anything in privacy doc → top-priority
- Bridge crashes on common voice commands → top-priority
- Plugin loader rejects valid manifests → moderate
- HUD doesn't render on M1 base → moderate

## After-launch

- Monitor GitHub issues; reply within 24h to first 50 issues
- Pin the "Show HN" thread URL in the repo README during the first week
- Daily: check star growth, fork count, plugin contributions
- Weekly: digest the issues into a "what people asked for" list; decide which become Sprint 4 candidates
