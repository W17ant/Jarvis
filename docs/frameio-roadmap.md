# Frame.io v4 — Untapped Capabilities

Reference list of Frame.io API features Jarvis doesn't currently expose. Tonight we ship 5 voice tools (`frameio_list_pending_review`, `frameio_get_comments`, `frameio_add_comment`, `frameio_set_status`, `frameio_search_files`) — that's the daily review-and-respond loop. The items below are the other 90% of the API, sorted by value-per-effort.

Each entry: **what it does** · **voice trigger** · **API endpoint** · **estimated effort** · **scope tick** (current Frame.io token already covers all reads + comment create/read + asset update; expansions noted).

---

## Tier 1 — Quick wins (under 1 hr each)

### `frameio_resolve_comment`
Mark a comment thread as resolved. Closes the daily loop: read a comment → fix in Premiere → mark resolved without leaving the kiosk.
- **Voice:** "Mark Sarah's note as resolved" / "Resolve comment 4 on the Bentley v3"
- **Endpoint:** `PATCH /v4/comments/{id}` with `{ "completed": true }`
- **Effort:** 30 min — copy `setAssetStatus` shape
- **Scope:** Comments → Update (not currently ticked, regenerate token)

### `frameio_get_asset_metadata`
Read duration, codec, resolution, file size, current version number for any asset.
- **Voice:** "How long is the McLaren v4?" / "What resolution is the press car teaser?"
- **Endpoint:** `GET /v4/files/{id}`
- **Effort:** 30 min — single GET, format the readout
- **Scope:** Assets → Read (already ticked)

### `frameio_get_download_url`
Generate a signed download URL for an asset. Useful for "send the v4 to the client" → emails the URL.
- **Voice:** "Get me a download link for the press car v4"
- **Endpoint:** `GET /v4/files/{id}/download`
- **Effort:** 45 min — token expiry handling, paste-into-clipboard
- **Scope:** Assets → Read (already ticked)

### `frameio_account_storage`
Read current storage quota, used vs available. Catches "Frame.io is full and rejecting uploads" before it ruins a delivery.
- **Voice:** "How much Frame.io storage am I using?"
- **Endpoint:** `GET /v4/accounts/{id}` includes `storage_used` + `storage_limit`
- **Effort:** 15 min — already have account_id cached
- **Scope:** Accounts → Read (already ticked)

### `frameio_review_link_state`
Has the client opened the review link? When did they last view? Good for "chasing" a slow approver without nagging.
- **Voice:** "Has the client opened the McLaren review link?"
- **Endpoint:** `GET /v4/review_links/{id}/views`
- **Effort:** 1 hr — depends on review link being saved somewhere queryable
- **Scope:** Review Links → Read (need to retick, currently unchecked)

---

## Tier 2 — Mid-effort (1-3 hrs each)

### `frameio_list_recent_uploads`
Walk the activity feed for everything new in the last N hours. Morning catch-up: "What landed overnight?"
- **Voice:** "What's new on Frame.io today?" / "Anything land overnight?"
- **Endpoint:** `GET /v4/accounts/{id}/audit_logs` filtered by event type
- **Effort:** 2 hrs — pagination, event-type filtering, group by project
- **Scope:** Accounts → Read (already ticked)

### `frameio_walk_project_tree`
List every folder + asset in a project, recursively. Better than `searchFiles` when you want to browse rather than name-search.
- **Voice:** "What's in the Bentley project?" / "Show me everything for the press car"
- **Endpoint:** `GET /v4/projects/{id}/folders` then recursive `GET /v4/folders/{id}/children`
- **Effort:** 2 hrs — recursive walk, depth limit, summarise tree for voice
- **Scope:** Projects + Assets → Read (both already ticked)

### `frameio_reply_to_comment`
Reply to a specific comment in a thread. Currently `frameio_add_comment` only creates top-level. Replies require `parent_id`.
- **Voice:** "Reply to Sarah's comment with on it" / "Reply: tightening that now"
- **Endpoint:** `POST /v4/comments` with `{ "parent_id": "...", "text": "..." }`
- **Effort:** 1 hr — extend `addComment` shape, look up parent by author/text
- **Scope:** Comments → Create (already ticked)

### `frameio_bulk_set_status`
Approve / reject multiple cuts at once with a single confirmation. Saves round-trips when a manufacturer signs off a whole campaign.
- **Voice:** "Approve all the McLaren cuts" / "Mark every press car v3 as approved"
- **Endpoint:** Loops `PATCH /v4/files/{id}` per asset
- **Effort:** 2 hrs — batch fan-out, per-asset confirmation summary, partial-failure handling
- **Scope:** Assets → Update (already ticked)

### `frameio_spatial_comment`
Pin a comment to a region on the frame, not just a timecode. "Fix the dashboard reflection at 0:23" with a box pointing at the dashboard.
- **Voice:** Hard for pure voice — better via Cmd+K palette with click-to-place
- **Endpoint:** `POST /v4/comments` with `{ "annotation": { "type": "drawing", ... } }`
- **Effort:** 3 hrs — region-picker UX, coordinate normalisation
- **Scope:** Comments → Create (already ticked)

---

## Tier 3 — Bigger lifts (half-day +)

### `frameio_upload_from_shoot_folder`
Push a finished cut from the shoot folder directly to a Frame.io project + folder + version stack. Closes the loop from "render landed in `output/`" to "client has it for review".
- **Voice:** "Upload the Bentley teaser to Frame.io as v3 in the press car project"
- **Endpoint:** `POST /v4/folders/{id}/files/multipart_upload` (multi-part for files >5GB)
- **Effort:** 4-6 hrs — chunked upload, progress lane in task strip, version-stack detection, agency-friendly folder structure
- **Scope:** Assets → Create (NOT currently ticked, deliberate. Re-tick if you want this.)
- **Note:** intentional friction — accidental upload to wrong client project is a real risk. Confirmation gate + dry-run preview before commit.

### `frameio_create_review_link`
Generate a shareable URL for a client without a Frame.io account. Voice trigger after status is set to approved.
- **Voice:** "Create a review link for the McLaren v4 with a 7-day expiry"
- **Endpoint:** `POST /v4/review_links` with `{ "items": [...], "expires_at": "..." }`
- **Effort:** 4 hrs — link config (expiry, password, download permission), write to clipboard, optionally email
- **Scope:** Review Links → Create (NOT currently ticked, regenerate token)

### `frameio_webhook_subscribe`
Register a webhook so Frame.io pings the bridge when X happens. Enables proactive alerts: "Sarah just commented on the press car v3" announced over the kiosk speakers.
- **Voice:** Setup is one-shot — subscribe to events at install, then proactive
- **Endpoint:** `POST /v4/accounts/{id}/webhooks` + bridge-side webhook receiver
- **Effort:** half day — needs a public URL (Tailscale tunnel works), event signature verification, debounce/dedupe, voice announcement queue
- **Scope:** Webhooks → Create + Read (NOT currently ticked, regenerate token)
- **Use case:** the highest-value Tier 3 — turns Frame.io from "check it occasionally" into "tells you when something needs you"

### `frameio_weekly_digest`
Walk the activity feed for the past N days, summarise via LLM, deliver as a Friday email or end-of-week voice readout: "27 comments resolved, 3 cuts approved, 1 rejected, here are the highlights."
- **Voice:** "Read me my Frame.io week" / sent automatically at Fri 17:00
- **Endpoint:** `GET /v4/accounts/{id}/audit_logs` over a 7-day window
- **Effort:** 4 hrs — pagination, LLM summary prompt, email integration via existing `draft_email`
- **Scope:** Accounts → Read (already ticked)

### `frameio_custom_action`
Register a button that appears INSIDE Frame.io's UI which calls Jarvis. Operator clicks "Send to Premiere" on a Frame.io comment, bridge receives the callback, opens Premiere at the right timecode.
- **Voice:** Not voice-driven — UI integration on the Frame.io side
- **Endpoint:** `POST /v4/accounts/{id}/actions` + bridge-side action handler
- **Effort:** half day — requires the same public URL story as webhooks
- **Scope:** Custom Actions → Create + Read (NOT currently ticked)

---

## Won't do — deliberate

These are theoretically possible but aren't wired and probably shouldn't be:

- **Voice-triggered asset DELETION** — too risky. Accidental "delete the press car v3" on a mishearing destroys client work.
- **Voice-triggered project CREATE / DELETE** — operational, not creative. Belongs in the desktop UI.
- **Team / member management** — admin work, low frequency, no voice payoff.
- **Custom Actions for destructive ops** — same logic as voice deletion.

---

## Token regeneration matrix

If you want to enable Tier 2/3 capabilities that need scope expansion, ticked-vs-needed:

| Capability | Currently ticked? | Need to tick |
|---|---|---|
| `resolve_comment` | Comments → Read, Create | + Comments Update |
| `review_link_state` | — | Review Links Read |
| `upload_from_shoot_folder` | — | Assets Create |
| `create_review_link` | — | Review Links Create |
| `webhook_subscribe` | — | Webhooks Create + Read |
| `custom_action` | — | Custom Actions Create + Read |

Regenerating a token doesn't invalidate the old one — generate the expanded token, paste into Settings → FRAME.IO field, save, restart bridge. Old token can stay in Frame.io's dev-tokens list as a backup.

---

## Recommended sequence

If you're picking next-up Frame.io work to ship, this order maximises daily-Adam-value per hour:

1. **`frameio_resolve_comment`** — closes the daily loop, 30 min
2. **`frameio_get_asset_metadata`** — answers "how long / what resolution" without opening the app, 30 min
3. **`frameio_list_recent_uploads`** — morning catch-up, 2 hrs
4. **`frameio_reply_to_comment`** — completes the comment-thread story, 1 hr
5. **`frameio_webhook_subscribe`** — flips Frame.io from pull to push, half day, biggest UX shift

Items 1-4 are ~4 hours of work and add the next 5 most-used capabilities. Item 5 is the architectural unlock that changes the kiosk's relationship to Frame.io entirely.
