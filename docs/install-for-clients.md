# Install Jarvis as a white-label client

This guide is for **client installs** — when you (or someone you're delivering Jarvis to) want a private fork of the codebase that won't be silently rebranded by upstream changes.

The model: **fork the repo, then track upstream**. Pulls bring in fixes; the brand-lock keeps your skin from being overwritten.

## Why fork?

- Your install gets its own GitHub home — your commits, your config, your memory backups never leak upstream.
- You decide when (or if) to pull upstream improvements.
- The `.brand-lock` file in the repo root catches any upstream change that would rebrand your install — it aborts the update with an explicit override message rather than silently flipping your kiosk to a different brand.

## What you need

- A GitHub account (free is fine; private fork is fine if you'd rather)
- macOS 14+ on Apple Silicon (M1/M2/M3/M4/M5)
- 64 GB RAM recommended; 32 GB works on a smaller model tier
- Homebrew installed
- Internet for the initial Ollama model pull (offline after that)

## Step 1 — Fork on GitHub

You can do this with one paste in your Claude Code terminal:

> Fork `W17ANT/Jarvis` to my GitHub account, rewire this clone's `origin` to point at my fork, push my current `main` to it, and add `W17ANT/Jarvis` as `upstream`. Don't pull any new upstream changes yet.

Claude Code will use either `gh` CLI (if you've run `gh auth login`) or the GitHub MCP server. If neither is wired, it'll stop and tell you what auth is needed — non-destructive.

Or do it manually:

```bash
# 1. On GitHub: visit https://github.com/W17ANT/Jarvis and click Fork
# 2. On your Mac, in your install directory:
git remote rename origin upstream
git remote add origin git@github.com:<your-handle>/Jarvis.git
git push -u origin main
git push origin --tags
```

After this, `git remote -v` should show:
- `origin` → your fork
- `upstream` → `W17ANT/Jarvis`

## Step 2 — Lock your brand

Drop a `.brand-lock` file in the repo root with the brand name your kiosk runs under (matching `config/brand.json`'s `agent.name`):

```bash
echo "Jarvis" > .brand-lock
git add .brand-lock
git commit -m "lock brand to Jarvis"
git push
```

If you've already rebranded your install via the settings panel (e.g. to "Aria" or "Beacon"), put that name in `.brand-lock` instead.

From now on, `tools/update.sh` reads `.brand-lock` and refuses to fast-forward to any upstream that would change `config/brand.json`'s agent name. Bypass requires `--force-brand-change`.

## Step 3 — Pull upstream improvements

When you want fixes or features from upstream:

```bash
git fetch upstream
git merge upstream/main
git push
```

The brand-lock guard in `tools/update.sh` will catch any merge that would rebrand. You'll see a message like:

```
✗ upstream branch (origin/main) is brand "OtherBrand" but this install is locked to "Jarvis".
✗ pulling would rebrand this kiosk. ABORTING.
```

If that fires by mistake, the fix is one of:
- `git checkout` a different branch (if you're on the wrong one)
- update `.brand-lock` if the upstream brand is what you want
- `./tools/update.sh --force-brand-change` if you really do want to switch brands

## Step 4 — Customise

Open the kiosk's settings panel (top-right gear icon) and change:
- **Brand identity** — agent name, wake phrase, mishears, agency name, tagline
- **HUD accent colour** — picks a per-profile palette
- **Voice** — Kokoro has 50+ options
- **API keys** — drop in Anthropic / OpenAI / any other key in `NAME=VALUE` form
- **LLM provider routing** — which provider handles chat / vision / high-stakes work

Saves to `config/brand.json` and `.env` respectively. The HUD live-reloads on brand changes — no restart needed.

## Step 5 — Update your fork periodically

Once a month-ish, or whenever you want a specific upstream fix:

```bash
./tools/update.sh
```

This pulls from your fork's main (which only gains commits when YOU push). To bring in upstream:

```bash
git fetch upstream
git merge upstream/main
# resolve any conflicts (rare — most upstream changes don't touch brand config)
git push
./tools/update.sh
```

## Troubleshooting

**My install reads "Flat-Out" or some other brand after an update**

You probably tracked the wrong branch. Check `git status` — your branch should track `origin/main` (your fork), not `upstream/main` directly.

**The brand-lock keeps firing even though I want the upstream brand**

Either delete `.brand-lock` (no protection going forward) or update its content to match the upstream brand:

```bash
cat config/brand.json | grep '"name"' | head -1   # check upstream agent name
echo "<that-name>" > .brand-lock
git commit -am "update brand lock to match upstream"
```

**I want to give my install a completely different brand (e.g. "Aria")**

Run the setup wizard or use the in-app settings panel:

```bash
node tools/setup-wizard.mjs
```

Then update `.brand-lock`:

```bash
echo "Aria" > .brand-lock
git commit -am "rebrand to Aria"
git push
```

Future updates from upstream will be blocked unless they also use the brand "Aria" or you bypass with `--force-brand-change`.

## What lives where

| File | What it does |
|---|---|
| `.brand-lock` | The brand name this install is locked to. Read by `tools/update.sh`. |
| `config/brand.json` | Live brand config — agent name, wake phrase, palette, fonts. The settings panel writes here. |
| `config/launcher.json` | The 9 dock items in the LAUNCH panel. Edit to add/remove apps. |
| `.env` | API keys + LLM provider routing. The settings panel writes here. |
| `data/memory.db` | Your conversation history + facts. Backed up automatically before each update. |
| `data/audit/` | Append-only journal of every tool the agent ran. |
| `docs/knowledge/` | Drop markdown / PDF / docx here for the knowledge base. Auto-indexed. |
| `config/creative-style.md` | Editorial voice guide injected into every LLM prompt. Operator's "house rules" file. |

## Need help?

- File issues at <https://github.com/W17ANT/Jarvis/issues>
- The `tools/diagnose.sh` script bundles logs + system snapshot + brand config into a tarball you can attach to an issue.
