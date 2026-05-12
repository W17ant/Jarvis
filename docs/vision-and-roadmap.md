# Jarvis — vision and roadmap

> "The 21st century professional needs a workstation that is to AI what the
> workshop was to the craftsman. Not a general-purpose chatbot. Not a
> productivity SaaS. A workstation with depth, privacy, and the operator
> at the centre."

## The thesis

**Jarvis is The Operator's Workstation.**

A voice-first private workstation that solo professionals and small teams *operate FROM*, not just *talk to*. The kiosk is the canvas. The 60+ tools are the workshop. The plugin scaffold lets every operator's workflow extend the workstation. Privacy + ownership + depth = a market position Big Tech can't credibly attack.

This isn't a chatbot with a face. It's a workspace where:

- **Every project** is a first-class entity with its own memory, files, and tools
- **Every operator** has a working style the workstation learns and adapts to
- **Every workflow** becomes voice-callable, hot-loadable, white-labellable
- **Every byte** stays on the operator's hardware unless they explicitly choose otherwise

## Why this wins

| Competitor | Why they can't go where we're going |
|---|---|
| ChatGPT / Claude Desktop | Cloud-only by architecture. Can't credibly claim privacy, can't go deep on per-operator workflow. General-purpose forever. |
| Microsoft Copilot | Windows-only, locks you into the MS ecosystem, optimised for enterprise IT not the solo professional. |
| Apple Intelligence | Sandboxed by design. Limited capability, limited extensibility, won't ever support arbitrary plugins. Tied to Apple's roadmap. |
| Vertical SaaS (Clio, Practice Better, etc) | Cloud-first, no AI/voice, single-vertical, no white-label. Each one re-builds the same plumbing badly. |
| OpenClaw + smaller privacy-first AI assistants | Less mature, less polished UX, narrower tool surface, no white-label. |

**The wedge**: the only product that is simultaneously local-first by default, white-label, voice-first, deeply tool-orchestrated, and open source. Big Tech can't copy "we don't see your data."

## Target users (priority order)

1. **Solo professionals with information-heavy work**: lawyers, accountants, consultants, designers, photographers, journalists, researchers. Privacy isn't optional for them — it's a regulatory or competitive requirement.
2. **Small agencies (1-10 people)**: photo, video, marketing, PR, copywriting. They want a workstation per operator, not a SaaS subscription per seat.
3. **Privacy-focused power users**: developers, security professionals, anyone who's read the LLM provider TOS and decided not to send their work there.
4. **Regulated small businesses**: medical practices, financial advisors, legal practices. Compliance forces local-first.

## Horizons

### Horizon 1 — v1.0: First-strangers polish (next 3 months)

**Goal**: any non-developer can install Jarvis and get value in 30 minutes. The repo passes the "does this look real?" test for a stranger landing on GitHub from a tweet.

- **Signed DMG installer** (Apple Developer Program $99/yr) with onboarding wizard
- **Sparkle auto-update** so installs don't drift behind upstream
- **LaunchAgent** so the bridge starts on login (already drafted, blocked on macOS TCC)
- **Homebrew tap** for developer-mode installs (formula already drafted)
- **Crash reporting** (opt-in, self-hosted endpoint — no Sentry account needed)
- **Demo video** + public launch (HN, Twitter, Bluesky, LinkedIn)
- **First 10 non-FOM operators** — gather their pain points, fix the boring stuff
- **Documentation site live** at a real URL (`jarvis.aoneill.co.uk` or `w17ant.github.io/Jarvis`)
- **Performance benchmarks** with real numbers in `docs/benchmarks.md`

**Definition of done**: someone installs Jarvis from `brew install` or a DMG, runs through the wizard, makes their first voice command, and tells someone else about it.

### Horizon 2 — v2.0: Workstation depth (3-9 months) — **COMPLETE 2026-05-09**

**Shipped as v0.3.0.** Goal: stop being a "voice assistant" and start being a "workstation." This is the differentiating layer that nothing else has.

> Sprints 2-9 closed every Horizon 2 line item that was achievable with engineering alone. The remaining v2-flavoured items — knowledge-graph viewer, per-operator local LoRA, multi-operator selective sharing — were explicitly deferred to Horizon 3 because they need infrastructure (graph rendering libraries, training pipelines, LAN sync) that's bigger than a sprint.

- **Workspaces** — first-class projects with per-project memory, files, tools, conversation history. Switch between them like Spaces / virtual desktops. **v0 + v1 + v2 + v3 + v4 SHIPPED in Sprints 3, 4, 5, 6, 7.** v0 = SQLite scope + system-prompt injection; v1 = working_root + tool_allowlist + creative_style + switcher chip; v2 = scoped memory + portable export/import; v3 = auto-import knowledge + voice persona + audit scoping + insights; v4 = parallel personas across windows (accent_color + agent_label fields, ?workspace=slug URL pin, ?mode=reactor/ambient view modes, AsyncLocalStorage per-call dispatch, in-HUD handbook editor). **Remaining for v5**: workspace-scoped tool usage analytics, workspace activity timeline, workspace search across-scopes, plugin allowlist visualisation.
- **Multi-window kiosk** — not one kiosk on one display, but a kiosk *layout* the operator arranges across windows.
- **Operator handbook** — a `CLAUDE.md`-equivalent per operator that captures their working style, vocabulary, vetoed words, signature phrases. Every LLM call gets it injected.
- **Project memory + RAG** — every file the operator drops into a project is auto-indexed, queryable by voice.
- **Smart inbox** — voice triage of mail / calendar / messages / tasks. "Hey Jarvis, what's important today?" → operator-tuned ranking, not generic LLM summarisation. **v0 SHIPPED in Sprint 8.** Aggregator + `smart_inbox_briefing` voice tool + workspace-aware ranking via handbook injection + HUD right-rail panel. Reminders source not yet wired (Personal.listReminders pending). v1 = reminders source + voice action verbs ("draft a reply to the first one") + per-workspace inbox source overrides.
- **Skill packs** — vertical bundles (Legal Pack, Photo Agency Pack, Medical Pack, Indie Hacker Pack) that include tools, creative-style templates, plugin sets, and prompts. White-labellable.
- **Better plugin authoring** — the `build_plugin` tool from Sprint 2 finished and polished. Voice command → plugin scaffolded → optional code-agent fills the handler → hot-load → callable in same session.
- **Knowledge graph** — every project's docs, conversations, and tool runs feed a per-project graph (graphify-style) the operator can navigate visually.
- **Per-operator fine-tuning** — local LoRA on the operator's writing style, no cloud round-trip.

**Definition of done**: an operator's Jarvis kiosk knows their projects, their voice, their vocabulary, their patterns. Switching to a fresh kiosk feels like a downgrade.

### Horizon 3 — v3.0: Workstation network (9-18 months)

**Goal**: small teams share workstations. Privacy + collaboration aren't mutually exclusive.

- **Multi-operator support** — per-operator profiles already exist; extend to selective project sharing within a household / studio / firm.
- **Local network sync** — workstations on the same LAN sync project state via Bonjour + signed peer-to-peer. No cloud, no SaaS.
- **Mobile companion app** — iOS + Android. Phone-as-mic from anywhere on your tailnet, voice replies through phone speaker, conversation continues at the kiosk when you're back at your desk.
- **Linux + Windows ports** — abstract macmon behind a platform interface (Linux: lm-sensors / nvidia-smi; Windows: PowerShell + LibreHardwareMonitor). Broaden TAM beyond Apple Silicon.
- **Operator profiles travel** — your workstation profile (handbook, projects, skill packs) lives in a portable bundle you can move between machines.
- **External agent integrations** — when the operator's Jarvis needs a capability it doesn't have, it can delegate to a contract agent (still consent-gated, still audited).

**Definition of done**: a 4-person agency runs 4 Jarvis kiosks on the same LAN, sharing projects but never via the cloud. The "next big thing in AI assistants" pitch is real.

### Horizon 4 — v4.0: Workstation ecosystem (18mo+)

**Goal**: the canonical local-first AI workstation, with a healthy independent ecosystem.

- **Plugin marketplace** — curated, signed by author, GitHub-hosted (no central server). Browse, install via voice, sandboxed by default.
- **Skill pack marketplace** — verticals beyond what we ship: Therapist Pack, Indie Filmmaker Pack, Substack Author Pack, etc.
- **Pro support tier** — businesses pay for SLA-backed support; revenue model that doesn't require giving up MIT or going SaaS. Funds 1-2 full-time maintainers.
- **JarvisConf + community** — annual event, Discord, monthly newsletter, public roadmap voting.
- **Self-hosted enterprise** — for regulated industries: a "Jarvis for your firm" deployment kit (audit log streaming, central skill packs, compliance reports).

**Definition of done**: when someone says "we need an AI workstation that doesn't send our data to OpenAI," Jarvis is the obvious answer.

## What we explicitly aren't doing

- ❌ **Cloud SaaS layer** — would dilute the privacy moat
- ❌ **Voice cloning** — operator preference, codified in memory
- ❌ **Always-on ambient mic** — privacy + battery cost
- ❌ **Surveillance ML** — no operator activity logging beyond explicit audit
- ❌ **Subscription-only features** — MIT forever, paid support is the only revenue model
- ❌ **Closed plugin ecosystem** — community plugins are the point
- ❌ **iPhone-app-only** — phone is a companion, not the primary
- ❌ **Mac App Store distribution** — sandboxing breaks too many features
- ❌ **A wake word other than what the operator picks** — we are not Alexa

## Sequencing principles

1. **Polish before reach** — fix what's there before adding more. Horizon 1 closes everything started in Sprint 1 + Sprint 2.
2. **Workspaces before community** — the differentiating depth has to land before we go after a marketplace. A marketplace for an underdeveloped product is just a marketplace of disappointment.
3. **Mobile before Linux** — multi-device > cross-platform for our target user. A photographer with a Mac and an iPhone wins more from the iPhone companion than from Linux support.
4. **Verticals before horizontals** — better to be the obvious answer for "AI for lawyers" than a mediocre answer for everyone.
5. **MIT forever** — paid support / hosted services are fine; rent-seeking on the codebase isn't. The licence is the trust.

## Concrete next sprint (post-this-overnight)

Picking the highest-leverage Horizon-1 items that move us toward "first-strangers polish":

1. **Sprint 2 closeout** — finish `build_plugin` end-to-end (Sprint 2 single-bet; bridge wiring done, smoke + docs pending)
2. **Onboarding wizard polish** — Terminal-free first-run for non-tech users
3. **Self-hosted crash reporting** — local crash log + opt-in upload to a self-hosted endpoint
4. **Workspaces v0** — first-class project entity (the Horizon 2 wedge, prototyped early)
5. **Public launch dry-run** — README final pass, demo video record, social copy drafted

## How we measure progress

| Metric | Today | Horizon 1 target | Horizon 2 target | Horizon 3 target |
|---|---|---|---|---|
| GitHub stars | <50 | 500 | 3,000 | 10,000 |
| Non-developer installs | 1 (Adam) | 50 | 500 | 5,000 |
| Plugins in the wild | 1 (example-quote) + voice scaffolding | 10 | 50 community | 250 community |
| Workspaces | v4 (parallel personas across windows + handbook editor + view modes + per-call dispatch) | + analytics + activity timeline + cross-scope search | + LAN-shared workspaces | + workspace marketplace |
| First-audio p50 | <1.0s target unverified | <1.0s verified | <0.7s | <0.5s |
| Active operators (>1 voice turn/day) | 1 | 30 | 300 | 3,000 |
| Skill packs | 0 | 1 (the rebrand demo) | 4 (Legal, Photo, Indie, Code) | 12+ community |
| Platforms | macOS Apple Silicon | macOS AS | + Mobile companion | + Linux, + Windows |

## What this document isn't

This is the **operator's vision**. It's not a press release, not a fundraising pitch, not a product spec. It's the answer to "if we look back in three years, what did Jarvis become?" — written so we can hold ourselves accountable.

It's a living doc. When reality contradicts it, the doc is wrong, not reality. Update it.

_Last updated: 2026-05-09. Updated when: a horizon completes, a major decision changes, or when the vision genuinely shifts._
