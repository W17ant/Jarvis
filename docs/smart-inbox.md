# Smart Inbox

> The "what's important right now" answer — workspace-aware, voice-first, local.

## What it is

Jarvis's Smart Inbox aggregates four operator surfaces into one normalised list, then ranks the list against the active workspace's handbook to produce a triage briefing. It exists because operators don't want four windows showing four queues — they want a single answer to "what should I look at first?"

| Surface | Source | What it pulls |
|---|---|---|
| Mail | Apple Mail (AppleScript) | Unread messages, capped at 15 |
| Calendar | Apple Calendar (AppleScript) | Events in the next 24h |
| Reminders | Apple Reminders (planned, not yet wired) | Due reminders |

## Voice flow

> *"Hey Jarvis, brief me."*

Calls `smart_inbox_briefing`, which:

1. Aggregates from every source (cached for 60s; pass `force: true` for a fresh pull).
2. Reads the active workspace's `handbook` field — the operator-authored prose injected verbatim into the LLM ranking prompt.
3. Asks the LLM to pick the top 3 priorities, each with a one-line rationale.
4. Returns the briefing as a structured response Jarvis speaks back.

Other phrasings the tool handles (per `config/actions.meta.json`):

- "what's important"
- "what should I do first"
- "what's on my plate"
- "what's the day looking like"
- "morning briefing"

## HUD panel

The right-rail Inbox panel polls `/inbox` every five minutes and shows the top 5 normalised items at a glance. It's a *visual reminder*, not the primary interface — the voice triage is where the workspace handbook actually does the heavy lifting.

The panel's items are colour-coded:

- **Imminent** (calendar event in next 60min) — red border, `#ff5a3a`
- **Reminder** — green icon, `#5fd97a`
- **Email / event** — workspace accent

The "↻" button forces a fresh pull (bypasses the 60s cache).

## Handbook directives that work

The active workspace's handbook is injected verbatim into the ranking prompt with the prefix *"Workspace priority directives (operator's scope-specific rules — apply strictly when ranking)"*. The LLM treats it as a strict guide.

Examples that work well, by workspace flavour:

**Consulting workspace handbook:**

```markdown
- Client emails outrank everything else. Sender domains in @clients.list win.
- Calendar events with external attendees outrank internal stand-ups.
- Anything mentioning "audit", "compliance", or "deadline" gets surfaced first.
- Newsletter subscriptions, marketing emails, internal wiki pings — bottom of the stack.
- If two items tie, the one with a tighter deadline wins.
```

**Personal workspace handbook (Friday):**

```markdown
- Family > friends > services > marketing.
- Anything from my partner is top priority regardless of subject.
- Calendar items in the next 30min beat anything else.
- Bills and reminders with explicit due dates outrank social emails.
- Newsletters, promotions, "your weekly update" emails — never surface unless explicitly asked.
```

**Photo agency workspace handbook:**

```markdown
- Press contacts (journalists, editors) outrank everyone else when a release is imminent.
- Calendar items tagged "shoot" or "press day" get surfaced regardless of size.
- Anything from existing clients about active campaigns outranks new pitches.
- Internal Slack pings and admin emails — bottom unless flagged urgent.
```

## What gets cached and where

- **In-process aggregator cache** (`bridge/inbox.mjs`): 60-second TTL on the normalised item list. Shared between the HUD panel and the briefing tool so a "brief me" right after a panel poll doesn't re-fetch.
- **Voice triage**: not cached. Every "brief me" hits the LLM (after the aggregator cache decides whether to re-fetch the sources).

## Troubleshooting

**Inbox is empty even though I have unread mail / events / reminders.**

The aggregator pulls via AppleScript, which requires per-app automation permission. macOS prompts the operator the first time each is used, but the prompts can be missed if the kiosk is full-screen.

```bash
# Check which apps the bridge has been granted access to:
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "SELECT client, service FROM access WHERE service LIKE 'kTCCService%' AND auth_value=2"
```

Re-grant via System Settings → Privacy & Security → Automation → Terminal (or whichever shell is running the bridge) → enable Mail / Calendar / Reminders.

**The aggregate hangs on `force:true`.**

Mail's AppleScript can take 30-60s on a busy mailbox, and concurrent reads from Mail + Calendar + Reminders can serialise in the AppleScript permission stack. The 60s aggregator cache exists specifically to make repeat calls cheap; force-bypass should be reserved for "I just acted, refresh."

If you see consistent timeouts, the underlying source tools (`get_mail_summary`, `get_upcoming_events`, `list_reminders`) probably need their own investigation — call them individually via voice ("check my mail", "list my reminders") to find which one is the slow one.

## What it's not (yet)

- **Slack / Discord / Teams** — out of scope for v1; would need OAuth + per-source bridges.
- **Tasks beyond Reminders** — Linear, Notion, Things, Asana, etc. v1 sticks to native macOS surfaces.
- **Auto-action** — the briefing surfaces priorities but doesn't reply / accept / snooze on its own. Voice action verbs (`draft a reply to the first one`, `accept the second one`, `snooze that`) are downstream tickets.
- **Persistence beyond cache** — every aggregate is regenerated; we don't store inbox snapshots historically.
- **Per-workspace inbox source overrides** — Friday couldn't currently say "only pull from this calendar". v2.

## Adding a source

The aggregator is decoupled via dependency injection. To add a new source:

1. Implement the source-specific tool that returns `{ ok: true, <kind>s: [...] }`.
2. Add a normaliser to `bridge/inbox.mjs` that maps the source row → unified shape (`{ kind, source, when, who, what, preview, urgency_hints, raw }`).
3. Wire the new handler into `Inbox.setSources({ … })` in `bridge/server.mjs`.

The HUD panel and briefing tool pick it up automatically.
