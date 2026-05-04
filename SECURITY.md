# Security & Privacy

Operating notes for the Flat-Out HUD on a client machine. Read before shipping; these are
the assumptions the system makes about how the kiosk is configured.

## Data flow — what stays local, what leaves

Everything that processes voice or content stays on the machine:

| Data | Where it runs | Network egress |
|---|---|---|
| Voice (mic → Whisper STT) | Local Python venv (`bridge/whisper_server.py`) | None |
| LLM reasoning (Qwen 2.5 32b) | Local Ollama on `:11434` | None |
| Vision (Qwen 2.5-VL 32b) | Local Ollama on `:11434` | None |
| Embeddings (nomic-embed-text) | Local Ollama on `:11434` | None |
| TTS (Kokoro) | Local Python venv (`bridge/kokoro_server.py`) | None |
| Memory DB | Local SQLite (`data/memory.db`) | None |
| Frame captions cache | Local SQLite (same DB) | None |

The kiosk only reaches outbound for these specific, opt-in features:

| Feature | Endpoint | Trigger |
|---|---|---|
| Image-to-video (Fal.ai Kling) | `https://queue.fal.run/...` | Voice command + `FAL_KEY` set |
| Frame.io review tools | `https://api.frame.io/v4/...` | Voice command + `FRAMEIO_TOKEN` set |
| Weather | `https://api.open-meteo.com/...` | HUD widget refresh |
| IP geolocation (first-run only) | `ipwho.is`, `ipinfo.io`, `ipapi.co` | Auto-detect operator location once |
| Web search | DuckDuckGo HTML scrape | LLM tool call when operator asks current-events questions |
| Google Fonts | `fonts.googleapis.com` | First page load |

If the machine is fully air-gapped, the system still works — it loses image-to-video,
Frame.io tools, weather, web search, and geolocation. Voice loop, memory, vision,
teaser pipeline, Premiere, PDFs, mail drafts all keep working.

## Files holding sensitive data

| File | Contents | Encrypted? |
|---|---|---|
| `data/memory.db` | Contacts (names, emails, phones, notes), projects, free-form facts, conversation summaries. SQLite WAL. | **No** — relies on disk-level FileVault. |
| `data/backups/memory-*.db` | Daily snapshots of the above, 30-day retention. | No |
| `.env` | `FAL_KEY`, `FRAMEIO_TOKEN` and any other API keys. | No |
| `data/frame-cache/` | Extracted video keyframes for VL captioning. | No |

**Required:** the disk hosting `~/Desktop/Jarvis` must be FileVault-encrypted. macOS
Settings → Privacy & Security → FileVault → Turn On. Without this, anyone with physical
access to a powered-off Mac can read every contact, every conversation, and every API key.

## Cloud sync is a hazard

The default macOS desktop folder is often inside iCloud Drive (Settings → Apple ID →
iCloud → Desktop & Documents Folders). If `~/Desktop/Jarvis` is iCloud-synced:

- Memory DB syncs to Apple's servers (operator-readable on any signed-in device, plaintext)
- `.env` with API keys syncs the same way
- Frame captions of confidential client material go to iCloud

**Action items per install:**

1. **Disable iCloud Desktop sync** OR move the project off `~/Desktop` (recommended location: `~/Apps/Jarvis` or `~/Library/Application Support/flat-out-hud`).
2. Confirm `~/Desktop/Jarvis` is **not** inside any Dropbox / Google Drive / OneDrive / Box mirror.
3. Confirm Time Machine backups go to an encrypted destination disk if backing up at all.

## API token hygiene

Tokens live in `.env`. Practical rules:

- **Never log them.** `bridge/server.mjs` logs `FAL_KEY: loaded ✓` not the value — keep this pattern in any new integration.
- **Never include them in screenshots.** The setup wizard prints first 6 characters then `…` — copy that pattern in any UI surfacing keys.
- **Rotate after staff changes.** When someone leaves the agency:
  - Revoke + re-issue Fal.ai key at https://fal.ai (account settings)
  - Revoke + re-issue Frame.io developer token at https://developer.frame.io/app
  - Re-run `node tools/setup-wizard.mjs` to update `.env`
- **Don't commit `.env`.** It's gitignored — verify with `git status` before any push.

## Memory & personal data (GDPR-adjacent)

The kiosk stores names, emails, phone numbers and free-form notes about real people. For
UK / EU contacts this is personal data under GDPR. The operator is the data controller;
the kiosk itself is just a local store with no third-party transmission.

To handle a "delete my data" request:

```bash
sqlite3 data/memory.db "DELETE FROM contacts WHERE LOWER(email) = LOWER('person@example.com')"
sqlite3 data/memory.db "DELETE FROM facts WHERE content LIKE '%person@example.com%'"
sqlite3 data/memory.db "DELETE FROM conversation_summaries WHERE summary LIKE '%Person Name%'"
```

For full erasure including backups:

```bash
sqlite3 data/memory.db "DELETE FROM <as above>"
rm data/backups/memory-*.db
```

A future feature: voice command "forget about Ben Collins" → tool call → above SQL. Not
implemented yet — for now it's a manual step.

## Confirmation gate

Tools that produce client-visible side effects (`draft_email`, `frameio_set_status`,
`frameio_add_comment`, `add_calendar_event`, `video_edit_from_shoot`,
`apply_lightroom_preset`, `premiere_render_active_sequence`, `crop_to_portrait`,
`run_shell`, `write_file`) **require explicit operator confirmation** before they run.

Implementation: `executeTool` returns `{ requires_confirmation: ... }` on the first call;
Qwen reads it aloud, waits for "yes", then re-calls with `confirmed: true`. Defined in
`bridge/server.mjs` → `NEEDS_CONFIRMATION`.

If you need to add a new tool with side effects, register it in `NEEDS_CONFIRMATION` with
a one-sentence summary builder. Bridge enforces the gate; system prompt teaches Qwen the
contract.

## Sandbox scope (run_shell)

The `run_shell` tool lets Qwen compose ad-hoc shell commands. Defenses:

- **Allowlist** of safe binaries in `bridge/shell.mjs` → `ALLOWED_BINARIES`. Qwen
  cannot reach `sudo`, `rm -rf`, `mkfs`, `chmod 777`, eval, network shells, `/dev/tcp`,
  fork bombs, etc.
- **Working directory pinned** to the project — no path traversal out.
- **30 s timeout** with an 8 MB stdout cap.
- **Confirmation gated** — every `run_shell` call hits the confirmation gate above.

This is defence-in-depth, not a guarantee. A determined adversary with both voice access
and reasoning over Qwen could likely chain allowlisted tools into something harmful.
**Do not deploy this kiosk in unsupervised public spaces.** It's intended for a private
office where the operator(s) are trusted.

## Network ports

The bridge binds the following loopback ports — none of them are intended to face the
public network. If the machine is on a shared office Wi-Fi, the firewall in macOS
Settings → Privacy & Security → Firewall should be ON to prevent other LAN devices from
hitting these endpoints.

| Port | Service | Bound to |
|---|---|---|
| 8765 | HUD static files | `0.0.0.0` (default) |
| 8766 | Bridge HTTP + WebSocket | `0.0.0.0` (default) |
| 8767 | Kokoro TTS | `0.0.0.0` (default) |
| 8768 | Whisper STT | `0.0.0.0` (default) |
| 11434 | Ollama | `127.0.0.1` (Ollama default) |

To restrict the bridge to loopback only, set `HOST=127.0.0.1` before launching — but the
HUD itself runs in Chrome on the same machine so you'll never have a legitimate
cross-machine use case for these ports anyway.

## Incident response

If an `.env` is leaked (committed to a public repo, screenshotted, etc):

1. Immediately rotate every key in it (Fal.ai dashboard, Frame.io developer console).
2. Re-run `node tools/setup-wizard.mjs` to write the fresh keys.
3. `git rm --cached .env`, `git commit`, force-push if the leak was in git — and assume
   the old keys are compromised regardless. The keys are the recovery point, not the
   removed file.

If the kiosk machine is lost or stolen:

1. With FileVault on (per above), the disk is encrypted. Without the login password the
   data is not readable.
2. Rotate every key in `.env` regardless — assume the worst.
3. If you have remote-wipe via Find My / MDM, trigger it.

## Minimum-viable security checklist for ship-day

- [ ] FileVault is on and the recovery key is stored somewhere safe (not on the kiosk itself)
- [ ] Project is NOT in iCloud Desktop / Documents / any cloud-sync folder
- [ ] `.env` is gitignored and contains only the keys this install actually uses
- [ ] `data/` is gitignored
- [ ] The operator's macOS account password is set and screen-lock activates after inactivity
- [ ] macOS firewall is ON
- [ ] FOM has a documented process for what happens to the kiosk + keys when an employee leaves
