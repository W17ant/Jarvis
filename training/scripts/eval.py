#!/usr/bin/env python3
"""eval.py - Tool-routing accuracy harness for Jarvis LLM backends.

For each query in the eval set, hit the live bridge LLM endpoint, parse the
streamed response, and check whether the expected tool was called. Reports
pass/fail per case plus an overall percentage.

Why this exists: 'is the model picking the right tool' is the single most
important quality metric for Jarvis, and Ollama / cloud models / a fine-tuned
LoRA all need to be compared on the same yardstick. Same script, three
backends, three numbers.

Usage:
    python3 eval.py                              # default: localhost bridge
    python3 eval.py --bridge http://localhost:8766
    python3 eval.py --dataset ../data/tool-routing-seed.jsonl

The eval set is a subset of the training set by design. To get a real
generalisation number you'd hold out 20% — but for "is tool routing
behaving sanely after a config change" the training set works fine as a
smoke test."""

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def load_dataset(path):
    """Load a JSONL dataset and extract (user_query, expected_tool_name) pairs.
    Records where the assistant turn is plain prose (no tool_calls) are
    flagged with expected_tool=None — those test that the model correctly
    DOES NOT call a tool for conversational queries."""
    cases = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            msgs = row.get("messages", [])
            user = next((m["content"] for m in msgs if m["role"] == "user"), None)
            assistant = next((m for m in msgs if m["role"] == "assistant"), None)
            if not user or not assistant:
                continue
            tool_calls = assistant.get("tool_calls") or []
            expected = tool_calls[0]["name"] if tool_calls else None
            cases.append({"query": user, "expected": expected})
    return cases


def ask_bridge(bridge_url, query, timeout=30):
    """POST a chat-style query to the bridge and return (tool_called, text).
    Bridge exposes /chat (non-streaming) and a streaming variant; we use
    /chat here for simpler parsing. The response shape is implementation-
    defined but currently returns { reply, toolCalls: [{ name, args }] }."""
    body = json.dumps({"query": query, "stream": False}).encode("utf-8")
    req = urllib.request.Request(
        f"{bridge_url}/chat",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return None, f"<bridge error: {e}>"
    tool_calls = payload.get("toolCalls") or payload.get("tool_calls") or []
    tool = tool_calls[0]["name"] if tool_calls else None
    text = payload.get("reply") or payload.get("text") or ""
    return tool, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", default="http://localhost:8766")
    ap.add_argument("--dataset", default=str(Path(__file__).parent.parent / "data" / "tool-routing-seed.jsonl"))
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    cases = load_dataset(args.dataset)
    if not cases:
        print(f"No cases loaded from {args.dataset}", file=sys.stderr)
        sys.exit(1)

    print(f"Evaluating {len(cases)} cases against {args.bridge}\n")
    passes = 0
    for i, case in enumerate(cases, 1):
        tool, text = ask_bridge(args.bridge, case["query"])
        expected = case["expected"]
        ok = tool == expected
        if ok:
            passes += 1
        mark = "PASS" if ok else "FAIL"
        # Truncate long queries for readability in the report.
        q = case["query"][:60] + ("…" if len(case["query"]) > 60 else "")
        print(f"  {mark}  [{i:>2}/{len(cases)}]  expected={expected or '(none)':<24} got={tool or '(none)':<24}  {q}")
        if not ok and args.verbose:
            print(f"           reply: {text[:120]}")

    pct = 100.0 * passes / len(cases)
    print(f"\n{passes}/{len(cases)} ({pct:.0f}%)")
    sys.exit(0 if pct >= 80 else 1)


if __name__ == "__main__":
    main()
