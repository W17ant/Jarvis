---
layout: ../layouts/Layout.astro
title: Tool reference
active: /tool-reference
---

# Jarvis tool reference

> Auto-generated from `bridge/server.mjs` + `config/actions.meta.json`. Last updated: 2026-05-08.
> Run `node tools/build-tool-reference.mjs` to regenerate after adding tools or plugins.

**61 tools** across 5 categories. Plugin-registered tools appear under their declared category, falling back to "Plugins" if uncategorised.

## Categories at a glance

| Category | Count | What it covers |
| --- | --- | --- |
| **Communication** | 11 | Mail, calendar, messages, contacts, reminders. |
| **Productivity** | 15 | Timers, tasks, knowledge base, code agent, web search. |
| **Creative** | 14 | Document generation, YouTube assets, social captions, brand pack export. |
| **System** | 18 | Music, browser, screenshots, app launchers, sleep mode, purchases. |
| **Memory** | 3 | Persistent recall, conversation summaries, fact storage. |

## Communication

> Mail, calendar, messages, contacts, reminders.

### **Add calendar event** \`add_calendar_event\` (⚠️ confirms)

Create a new event in the operator's macOS Calendar (which syncs back to Google if connected). Always confirm details before calling. Times should be ISO 8601 strings.

Voice examples:
- "schedule…"
- "book…"
- "add to calendar…"
- "put in the diary…"

### **Add contact** \`add_contact\`

Save a contact to persistent memory. Use whenever the operator introduces a new person ('add Sarah Mitchell, sarah at example dot press, press liaison'). Upserts on name. The contact then becomes available in future sessions — get_contact / draft_email can find them by name alone.

Voice examples:
- "save contact…"
- "remember this number…"

### **Add reminder** \`add_reminder\`

Add an item to Apple Reminders. Use for: 'remind me to call mum at 6', 'remember to buy milk', 'add cleaning the studio to my list'. The bridge parses the due date — pass natural language like 'tomorrow at 18:00' or an ISO string.

Voice examples:
- "remind me to…"
- "set a reminder…"

### **Note** \`compose_note\`

Create a note in Apple Notes (default), Bear, or Obsidian. Use for: 'note this idea down', 'jot that in my brief notes', 'save this to Bear'. Title becomes the note's headline; body is freeform. No confirmation required — notes are private and easy to delete.

Voice examples:
- "take a note…"
- "jot down…"

### **Draft email** \`draft_email\` (⚠️ confirms)

Open a new outgoing email in Apple Mail with the to/subject/body pre-filled. NEVER auto-sends — always opens for the operator's approval. Use when they say 'draft an email to X about Y'.

Voice examples:
- "draft an email to…"
- "write to…"
- "send a note to…"

### **Look up contact** \`get_contact\`

Look up a stored contact by name (or email). Falls back to fuzzy + semantic match if no exact name. Use BEFORE calling draft_email when the operator says a name like 'send Ben an email' — get the email address from memory rather than asking.

Voice examples:
- "who is…"
- "find contact…"

### **Inbox summary** \`get_mail_summary\`

Summarise the operator's Apple Mail inbox. Returns from / subject / date for recent unread (or all) messages.

Voice examples:
- "check mail…"
- "what's in my inbox…"
- "any new emails…"

### **Today's calendar** \`get_upcoming_events\`

List the operator's upcoming Calendar events. Returns title, start, location, calendar name.

Voice examples:
- "what's in the diary…"
- "today's meetings…"
- "what's on…"
- "schedule for…"

### **List contacts** \`list_contacts\`

List stored contacts, optionally filtered by company.

Voice examples:
- "show me my contacts…"

### **End-of-day digest** \`request_eod_digest\`

Generate the operator's end-of-day activity digest — replies count, purchases made (settled + blocked), renders shipped, files dropped into the inbox, top tools used, LLM spend. Use when operator says 'what did I do today', 'summarise my day', 'daily wrap'. Returns a structured JSON plus a plain-text version the LLM can read aloud verbatim.

Voice examples:
- "wrap up the day…"
- "eod summary…"

### **Send iMessage** \`send_imessage\` (⚠️ confirms)

Send an iMessage / SMS via the macOS Messages app. Recipient can be a phone number, email, or contact name (resolves to first match in Contacts). Use for: 'text Adam I'm running late', 'message mum I'll call her tonight'. ALWAYS goes through the confirmation gate — operator must say 'yes' before send.

Voice examples:
- "text…"
- "message…"
- "iMessage…"

## Productivity

> Timers, tasks, knowledge base, code agent, web search.

### **Internal lookup** \`ask_internal\`

Answer 'how do we usually do X' questions for the team — pulls past conversation summaries, stored facts, and project notes for grounded answers. Use when a junior asks 'how do we grade a shoot', 'what's our usual rate for a track day', 'who should I CC on the client deliveries'.

Voice examples:
- "what does…"
- "explain…"

### **Cancel jobs** \`cancel_active_jobs\`

Cancel any in-flight long-running operation (active browse_web loop, caption_shoot_folder batch). Use when the operator says 'stop', 'cancel', 'abort', or hits Esc. Idempotent — calling when nothing is running is harmless.

Voice examples:
- "stop everything…"
- "cancel jobs…"
- "abort…"

### **Cancel timer** \`cancel_timer\`

Cancel an active timer by id. Use only after list_timers — operator usually identifies a timer by its label, not id.

Voice examples:
- "stop the timer…"
- "cancel timer…"

### **Code agent** \`code_agent_run\` (⚠️ confirms)

Run LLM-authored async JavaScript in a sandboxed worker. Use when no pre-built tool combination expresses the workflow you need — e.g. 'for each shoot folder modified today, generate a contact sheet then watermark the cheapest result'. Inside the sandbox: `await tools.<name>(args)` calls any allowedTools. Standard JS builtins (Math, JSON, Date, Promise, Array, etc) plus console.log are available. NO fs, network, process, or require — those are reachable only via tools the operator explicitly allowed. ALWAYS confirmation-gated: the operator hears a one-line summary and says 'yes' before any code runs. Returns the script's return value plus captured stdout/stderr.

Voice examples:
- "write me a…"
- "code up a…"
- "build me a script…"

### **Overnight cleanup** \`dream_cycle\`

Compact memory.db: merge near-duplicate contacts (Levenshtein ≤ 2) and archive conversation summaries older than 90 days. Runs automatically nightly at 03:30; this tool exposes a manual on-demand trigger when the operator says 'tidy up the memory', 'merge duplicates', 'compact memory', or after a known dirty import.

Voice examples:
- "dream cycle…"
- "overnight pass…"
- "consolidate memory…"

### **Add to knowledge** \`ingest_knowledge\`

Re-scan the docs/knowledge/ folder and ingest any new or changed files. Normally automatic via the file watcher, but call this when the operator explicitly says 'reindex my docs' or after dropping a batch in. Returns counts: ingested, skipped (unchanged), failed, removed.

Voice examples:
- "add this to docs…"
- "remember this document…"

### **Active timers** \`list_timers\`

List currently-active timers. Use when operator asks 'what timers do I have' or 'how long left on the chicken'.

Voice examples:
- "what timers…"
- "any active timers…"

### **Shell command** \`run_shell\` (⚠️ confirms)

Run an ad-hoc shell command in the project directory. Use ONLY when no curated tool fits the request — e.g. 'convert all .mov in this folder to mp4', 'rename these RAWs', 'count how many 4K clips are in the shoot'. The command runs sandboxed: limited to a binary allowlist (ffmpeg, ffprobe, magick, sips, exiftool, find, awk, sed, grep, python3, node, osascript, curl, jq, etc), with dangerous patterns blocked (no sudo, rm -rf, eval, dd, mkfs). Output is captured + returned. Compose carefully — always include a short 'justification' string explaining what the command does.

Voice examples:
- "run…"
- "execute…"

### **Search docs** \`search_knowledge\`

Search the operator's curated knowledge base — brand briefs, client onboarding docs, past press releases, anything they dropped into docs/knowledge/. Hybrid retrieval: vector cosine similarity + BM25 keyword fusion via Reciprocal Rank Fusion. Returns top-K chunks with source citations (rel path, title, format) so replies can quote the source. Use whenever the operator asks something that might be in their docs — 'what did the client brief say about deliverables', 'what's the brand voice on hashtags', 'how did we phrase the Bentley press release'.

Voice examples:
- "search my docs…"
- "find in knowledge…"
- "look up…"

### **Focus mode** \`set_focus\`

Toggle a macOS Focus mode (Do Not Disturb, Work, Personal, etc) by invoking a pre-existing Shortcut named exactly 'Focus On <mode>'. The operator builds the Shortcut once in Shortcuts.app. Use for: 'turn on Do Not Disturb', 'switch to Work focus until 6pm'.

Voice examples:
- "focus…"
- "do not disturb…"
- "dnd…"

### **Set timer** \`set_timer\`

Start an in-HUD kitchen timer. Use for cooking, breaks, or any 'remind me in N minutes' that is shorter than ~12 hours. For longer waits, use add_reminder. The HUD shows a countdown badge and Kokoro speaks the label when it fires.

Voice examples:
- "set a timer…"
- "timer for…"
- "start a timer…"

### **Team standup** \`team_standup\`

Summarise the last 24 hours of agency activity: teasers rendered, PDFs generated, recent conversation topics. Use when operator says 'give me the standup', 'what was done yesterday', 'morning summary'.

Voice examples:
- "standup…"
- "team status…"

### **Transcribe video** \`transcribe_video\`

Transcribe a video file end-to-end. Strips audio with ffmpeg → local Whisper for timestamped speech segments → samples N keyframes → vision LLM captions each one. Returns timestamped speech + frame captions + a single interleaved narrative. Use for: 'transcribe yesterday's interview', 'what's said in the press-launch clip', 'summarise this raw rushes file'. Slower than text tools (30-90s for a 5-minute clip) so use sparingly.

Voice examples:
- "transcribe…"
- "what's said in…"

### **Web search** \`web_search\`

Search the live web for current information. Use when the user asks about news, recent reviews, prices, releases, or anything time-sensitive. Returns top 5 results with URL + snippet — synthesise an answer from them.

Voice examples:
- "search the web…"
- "google…"
- "look up online…"

### **Write file** \`write_file\` (⚠️ confirms)

Write a small ad-hoc script or output file. Restricted to tools/adhoc/ or output/ subdirectories. Useful for composing a bash/python script in one step then running it with run_shell.

Voice examples:
- "save to…"
- "write to…"

## Creative

> Document generation, YouTube assets, social captions, brand pack export.

### **Brand pack export** \`brand_pack_export\`

Build a delivery brand-pack from a hero shot — generates 16:9 / 9:16 / 1:1 / 4:5 crops with subject auto-centred, both clean AND watermarked variants, plus a credit.txt for the email and a zip for the client. Use when the operator says 'build a brand pack of the press car hero', 'export deliverables for IMG_001', 'pack this up for the client'. Output goes to output/brand-packs/<basename>_<ts>/.

Voice examples:
- "brand pack…"
- "deliverables for…"

### **Brand tone check** \`check_brand_tone\`

Critique a draft caption / press line against a manufacturer's brand tone of voice (the manufacturer, McLaren, Ferrari, etc). Pulls stored tone notes from memory then web-searches if memory is thin. Returns verdict + issues + a rewrite. Use when operator asks 'is this on-brand for X', 'check my the manufacturer caption', 'how should McLaren say this'.

Voice examples:
- "does this match the brand…"
- "tone check…"

### **Generate PDF** \`create_pdf\`

Generate a branded Jarvis AI PDF document. Available templates: quote, brief, shoot-report, press-release, outreach-pack, contact-sheet.

For 'quote': data = { client, project, lineItems: [{description, amount}], shootDates, validUntil, notes, vatRate }.
For 'brief': data = { client, subject, dates, location, deliverables, crew, objectives, shotList: [...], notes }.
For 'shoot-report': data = { client, subject, date, location, weather, crew, fileCount, summary, highlights: [...], issues, nextSteps }.
For 'press-release': data = { headline, subhead, dateline, lead, body, quote, quoteAttribution, boilerplate, contact, releaseDate }.

Voice examples:
- "pdf for…"
- "draft a…"
- "create a pdf…"

### **Describe image** \`describe_image\`

Caption a single image or video keyframe using the local Qwen 2.5-VL vision model. Use when the operator asks 'what's in this shot', 'what is shoots/2026-05-01-press-car/IMG_001.jpg of', or wants a press-release-style description of a frame. Accepts jpg/png/webp/heic OR mp4/mov (auto-extracts a keyframe at 30% of duration). Returns a 1-2 sentence caption identifying make/model/angle/lighting where applicable. Caches results so repeat calls are free.

Voice examples:
- "what's in this image…"
- "describe this picture…"

### **Multi-aspect export** \`export_all_aspects\`

Crop a master image or video to ALL common social aspect ratios (16:9, 9:16, 1:1, 4:5) in one call, with the subject auto-centered. Outputs to output/aspects/. Use when operator says 'export every aspect for socials', 'make all the variants', 'one-shot crop everything'.

Voice examples:
- "all aspects…"
- "every ratio…"

### **Word document** \`generate_docx\`

Generate a Word document with the agency's brand styling. Use for: shoot briefs, client reports, scripts, meeting summaries. Each section becomes an H1 + body paragraphs. Title appears as a centred heading at the top, agency footer line at the bottom. Output lands in output/docx/.

Voice examples:
- "word doc…"
- "docx…"

### **PowerPoint deck** \`generate_pptx\`

Build a PowerPoint deck with the agency's brand styling. Use for: client pitch decks, shoot recap presentations, project updates. Slide types: cover (auto-generated as slide 1), section (divider), content (title + body or bullets), image (full-bleed photo), two-column (split text). Output lands in output/pptx/.

Voice examples:
- "powerpoint…"
- "deck…"
- "pptx…"

### **Social captions** \`generate_social_captions\`

Write Instagram + LinkedIn + TikTok caption variants for a subject in each platform's native voice. Use when the operator says 'write captions for the press car teaser', 'draft socials for today's the manufacturer shoot', etc. Returns a JSON object with one caption per requested platform.

Voice examples:
- "caption for…"
- "social copy…"
- "instagram caption…"

### **Excel sheet** \`generate_xlsx\`

Generate an Excel workbook with brand-styled headers. Use for: shoot logs, contact lists, project trackers, schedules. Each sheet gets a frozen header row (brand-coloured fill) plus banded body rows for readability. Rows can be arrays of values in header order OR objects keyed by header. Output lands in output/xlsx/.

Voice examples:
- "spreadsheet…"
- "excel…"
- "xlsx…"

### **YT thumb + short** \`generate_youtube_promo\`

Generate BOTH the YouTube thumbnail AND a 30-second YouTube short for a shoot in ONE tool call. STRONGLY PREFERRED when the operator asks for a thumbnail and a short together (e.g. 'a thumbnail and a short for the press car shoot, V10 beast, the car that broke me'). The thumbnail returns fast (~10s, pops in HUD modal); the short renders in the background (~2-3 min, auto-plays when ready). The thumbnail auto-derives make/model + headline specs (BHP / top speed / 0-60 / drivetrain) from the folder + the model's training knowledge, so the operator doesn't need to dictate them.

Voice examples:
- "youtube promo…"
- "promo pack…"

### **YouTube short** \`generate_youtube_short\`

Render a 30-second 16:9 YouTube short from a shoot folder using the cinematic teaser pipeline (flash cuts, speed ramps, beat-synced music, single-word stacked tail card). Combines headline + subhead into the closing kicker card. Use when operator says 'make a YouTube short', 'cut a short for [subject] with [headline]', or 'a thumb and a short for the [subject] shoot'. Returns immediately with status:'started' — render takes 2-3 min and auto-plays in HUD when ready (same as the production teaser).

Voice examples:
- "youtube short…"
- "short for…"

### **YouTube thumbnail** \`generate_youtube_thumbnail\`

Generate a YouTube video thumbnail (1280x720) for a shoot. Picks the strongest hero shot AND an engine bay close-up via vision (the engine inlay is an established client requirement — old thumbnails missed this). Layout: full-bleed hero with vignette, big yellow Anton-style headline rotated -2°, red subhead box, engine inlay bottom-right with red border, optional spec strip across bottom showing things like 'V10 · 5.0L · 510 BHP · 0-60 IN 3.2s'. Use when operator says 'make a thumbnail', 'YouTube thumb for [subject]', 'design a thumb with [headline] and [subhead]', or as part of 'a thumb and short for the [subject] shoot'.

Voice examples:
- "thumbnail for…"
- "youtube thumb…"

### **Hashtag research** \`hashtag_research\`

Suggest a ranked hashtag set per platform for a topic. Mixes high/mid/niche volume tags. Use when operator says 'give me hashtags for the press car post', 'what should I tag this with on TikTok'.

Voice examples:
- "hashtags for…"
- "tags for…"

### **Vehicle spec** \`vehicle_spec_lookup\`

Look up a specific vehicle spec (torque, 0-60, kerb weight, top speed, BHP, etc) with a web citation. Use mid-press-release when operator needs a number quickly: 'what's the press car's torque', 'how much does a 720S weigh'. Returns the figure + a one-line context + the source URL.

Voice examples:
- "specs for…"
- "vehicle data…"

## System

> Music, browser, screenshots, app launchers, sleep mode, purchases.

### **Add project** \`add_project\`

Save a project to persistent memory: name, client, status, notes. Use when starting work for a new client / shoot.

Voice examples:
- "add project…"
- "new project…"

### **Compare products** \`compare_products\`

Compare a product across multiple online retailers IN PARALLEL. Builds a multi-agent crew under the hood — one research agent per merchant runs simultaneously via request_browse, then a synthesis agent merges findings into a comparison table. Use for: 'compare 50mm primes across WEX, MPB and Park Cameras', 'find me the best deal on a vacuum across Currys and AO and John Lewis'. Requires a cloud vision provider (anthropic / openai) because each research agent uses request_browse. ~3x faster than sequentially asking the LLM to research each merchant.

Voice examples:
- "compare…"
- "which is better…"

### **Sleep / quiet** \`enter_sleep_mode\`

Put Jarvis to sleep — stops the mic, dims the HUD, and waits for the operator to tap the speedometer or say the wake word to come back. Use when the operator says 'shut down', 'go to sleep', 'stop listening', 'that's enough', 'goodnight', 'turn off'. NOT for ending a single response — only for full standby.

Voice examples:
- "sleep…"
- "shut down…"
- "quiet mode…"

### **Find flights** \`find_flights\`

Search Skyscanner for flights — read-only. Use for: 'find me a return to Madrid next weekend', 'cheapest flight to JFK in March'. Returns top results the operator can review. Does NOT book — booking requires going to the airline directly via open_url after the operator picks one.

Voice examples:
- "flights to…"
- "find a flight…"

### **What can you do** \`get_capabilities\`

Returns the runtime constraints + options the operator's machine actually supports right now: hardware tier, available shoot folders, voice options, PDF templates, Lightroom presets, location, etc. Call this whenever the operator asks what you can do, or before a complex tool call where you need to know what's available.

Voice examples:
- "what can you do…"
- "show me commands…"
- "list tools…"

### **List projects** \`list_projects\`

List stored projects, optionally filtered by client.

Voice examples:
- "what projects…"
- "show projects…"

### **Look up password** \`lookup_password\` (⚠️ confirms)

Read a credential from 1Password via the `op` CLI. Returns the field value (typically the password) so the operator can use it. ALWAYS goes through the confirmation gate — operator must say 'yes' before the credential leaves 1Password. Requires `op` installed and the operator signed in (`eval $(op signin)`).

Voice examples:
- "password for…"
- "credentials for…"

### **Open URL** \`open_url\`

Open a URL in the operator's default browser via macOS `open`. Use for 'pull up a map of X', 'open the BBC News homepage', 'show me Tesco's milk page'. This is the FAST tool — picks the right URL and hands off to Chrome. No API cost, no vision loop, no waiting. Prefer this over request_browse whenever the operator just wants to SEE a page (they can read it themselves). Only use request_browse when the goal needs the LLM to extract a specific fact from a page or perform a multi-step interaction. For maps: build a https://www.google.com/maps/search/<query> URL with the location URL-encoded. For shops: go straight to the product or category page if you know it.

Voice examples:
- "open…"
- "go to…"
- "launch website…"

### **Pause music** \`pause_music\`

Pause Apple Music or Spotify playback.

Voice examples:
- "pause…"
- "stop the music…"

### **Play music** \`play_music\`

Play music via Apple Music (default) or Spotify. Pass a search query — artist, song, mood, or playlist name. Empty query just resumes whatever is loaded. Use for: 'play some driving music', 'put on Daft Punk', 'play that podcast I was listening to'.

Voice examples:
- "play music…"
- "put on…"
- "play some…"

### **Random quote** \`random_quote\`

Return a random programming or engineering quote, attributed. Use when the operator asks for inspiration, a quote, a fortune-cookie line, or 'something witty'.

Voice examples:
- "a quote…"
- "say something witty…"

### **Read active window** \`read_active_window\`

Inspect the operator's foreground macOS application via the Accessibility API — returns the app name, window title, and the top-level visible UI elements (buttons, panels, lists). Use when the operator asks 'what's open?', 'what app am I in?', 'what's on screen right now?', 'what's the active sequence in Premiere?', or any question that depends on knowing the foreground state. Cheaper + more accurate than vision-based screen analysis. Requires macOS Accessibility permission granted to the kiosk app once.

Voice examples:
- "what's on screen…"
- "read this window…"

### **Read article** \`read_article\`

Fetch a web article and return cleaned text the LLM can summarise. Use for: 'summarise this Verge piece', 'read me the BBC headline at <url>', 'what does this article say'. Returns title + text (capped ~12k chars). Pure HTTP fetch — no Playwright, no API cost.

Voice examples:
- "read this article…"
- "summarise this page…"

### **Agentic browse** \`request_browse\`

Drive a real Chromium browser to accomplish a web-based goal. The bridge runs a vision-driven inner loop using Claude or GPT to click around, read pages, and report back. Use for: 'find me the cheapest X', 'check if Y is in stock', 'summarise this article at <url>', 'fill in this form for me'. NEVER use for purchases (use request_purchase) or for sensitive sites (banks, broker accounts, gov.uk login). Returns a final answer the LLM can speak to the operator. Costs API tokens — keep maxSteps modest (default 12).

Voice examples:
- "browse…"
- "go online and…"

### **Make a purchase** \`request_purchase\` (⚠️ confirms)

Request a small online purchase on behalf of the operator using the pre-funded virtual debit card. Hard limits enforced by the bridge: per-transaction cap, daily/weekly budget, merchant allowlist. Currently runs in SIMULATOR MODE — no real money moves until the operator flips data/spending-limits.json.simulatorMode to false. Use ONLY when the operator explicitly asks to buy something (e.g. 'order me a pint of milk from Tesco', 'get an Uber Eats curry'). Never auto-trigger a purchase from passive context. The merchant must be in the allowlist; if it isn't, do not retry — instead tell the operator and ask if they want to add it.

Voice examples:
- "buy…"
- "order…"
- "purchase…"

### **Search products** \`search_products\`

Search a merchant for products WITHOUT buying — uses request_browse internally to compare options. Use BEFORE request_purchase when the operator hasn't picked a specific item yet. Returns a shortlist with prices the operator can choose from. Example: 'find me a 50mm prime under £400 on WEX' → returns 3-5 candidates. Ask the operator which one to buy.

Voice examples:
- "find a…"
- "search for…"

### **Screenshot** \`take_screenshot\`

Take a macOS screenshot via screencapture. region='screen' (default, full primary display), 'window' (operator clicks a window), 'selection' (operator drags a region). Saves to data/screenshots/. Returns the filesystem path so the LLM (or the operator) can refer to it. Use for: 'screenshot the current Premiere session', 'capture this region for the brief'.

Voice examples:
- "screenshot…"
- "capture screen…"
- "screen grab…"

### **Undo** \`undo_last\`

Reverse the most recent undoable action. Use when the operator says 'undo', 'scratch that', 'never mind that', 'reverse that', or similar. Limited to genuinely-reversible operations: flag_shot (restores prior flag or clears it), expire_usage_rights (restores prior expiry), add_usage_rights (deletes the row), add_contact / add_project (deletes the row). Doesn't reverse renders, sent emails, or file writes — speak that limitation if asked to undo something outside the supported set.

Voice examples:
- "undo…"
- "scratch that…"
- "go back…"

## Memory

> Persistent recall, conversation summaries, fact storage.

### **Recall facts** \`recall\`

Semantic search across all stored memory: facts, contacts, projects, past conversation summaries. Use when the operator asks about something from a previous session ('what did we agree with the client', 'what was the brief for the press car').

Voice examples:
- "what do you remember about…"
- "recall…"
- "what did I say about…"

### **Remember a fact** \`remember\`

Store a free-form fact in persistent memory for future recall ('the manufacturer always wants vertical cuts first', 'Ben prefers email over Slack'). Use when the operator says 'remember that...' or you observe a stable preference / pattern.

Voice examples:
- "remember that…"
- "make a note of…"
- "keep this in mind…"

### **Save conversation** \`save_conversation\`

Persist a short summary of the current conversation so future sessions can recall it via the recall tool. Call this when the operator says 'that's all' or wraps up — capture the gist (2-3 sentences) and key topics.

Voice examples:
- "save this chat…"
- "wrap up the conversation…"
