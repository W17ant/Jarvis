#!/usr/bin/env python3
"""expand_dataset.py - Mine the bridge log for real operator queries.

Reads /tmp/jarvis-bridge.log, extracts every passive transcript that hit the
LLM with 0 tool calls (the failure mode we're trying to fix), and dumps them
as a candidate JSONL the operator can hand-label with expected tool calls.

Output goes to ../data/expansion-candidates.jsonl with empty tool_calls
placeholders; the operator fills in the expected tool per line, then appends
the curated rows to tool-routing-seed.jsonl.

Why this matters: the seed dataset is 30 examples. LoRA fine-tuning needs
200-500 to move the needle. The fastest path to 200 is mining real failures
from your own bridge log — those are exactly the queries the model is
getting wrong, and exactly the cases you want to teach it."""

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_LOG = "/tmp/jarvis-bridge.log"
DEFAULT_OUT = Path(__file__).parent.parent / "data" / "expansion-candidates.jsonl"

PASSIVE_RE = re.compile(r"\[hud\] passive: (.+?) \{\"wake\":(true|false)\}")
STREAM_ASK_RE = re.compile(r"\[stream\] ask: \"(.+?)\"")
STREAM_DONE_RE = re.compile(r"\[stream\] hop \d+ done in \d+ms, (\d+) tool calls")


def parse_log(path):
    """Walk the log line-by-line, pair each [stream] ask with the matching
    'hop N done' line that follows it, and record the (query, tool_count)
    pair. Lines without a paired completion (truncated log tail) are
    skipped — we'd rather drop a few cases than fabricate them."""
    pending = None
    pairs = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = STREAM_ASK_RE.search(line)
            if m:
                pending = m.group(1)
                continue
            m = STREAM_DONE_RE.search(line)
            if m and pending:
                pairs.append({"query": pending, "tool_count": int(m.group(1))})
                pending = None
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--only-failures", action="store_true",
                    help="Keep only queries where 0 tools were called (the cases worth labelling).")
    args = ap.parse_args()

    if not Path(args.log).exists():
        print(f"Log not found: {args.log}", file=sys.stderr)
        sys.exit(1)

    pairs = parse_log(args.log)
    if args.only_failures:
        pairs = [p for p in pairs if p["tool_count"] == 0]

    # Dedupe by query — operators often repeat the same phrase multiple times.
    seen = set()
    unique = []
    for p in pairs:
        if p["query"] in seen:
            continue
        seen.add(p["query"])
        unique.append(p)

    sys_msg = "You are Jarvis. Call tools for real-world queries; never answer from training data when a tool exists."
    with open(args.out, "w") as f:
        for p in unique:
            row = {
                "_note": f"observed_tool_count={p['tool_count']}; fill tool_calls below with the correct dispatch, or leave empty if the model was right to answer conversationally",
                "messages": [
                    {"role": "system", "content": sys_msg},
                    {"role": "user", "content": p["query"]},
                    {"role": "assistant", "content": "", "tool_calls": []},
                ],
            }
            f.write(json.dumps(row) + "\n")

    print(f"Wrote {len(unique)} candidates to {args.out}")
    print("Next steps:")
    print("  1. Hand-label each row's tool_calls with the correct dispatch (or leave empty if conversational was right).")
    print("  2. Append the curated rows to tool-routing-seed.jsonl.")
    print("  3. Re-run training.")


if __name__ == "__main__":
    main()
