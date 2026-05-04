/** daily-digest.mjs - 18:00 EOD activity digest.
 *
 *  Runs once per day at 18:00 local time. Reuses the existing teamStandup tool
 *  to gather the day's activity (renders, PDFs, conversations, memory growth)
 *  and surfaces it as an info-level notification. The operator sees it in the
 *  notification drawer alongside any in-progress task results.
 *
 *  The digest is purely a SUMMARY — it doesn't auto-email anything. If the
 *  operator wants it emailed, they say "draft tonight's digest as an email"
 *  and the LLM picks draft_email with the digest text.
 *
 *  Why a separate module rather than just a setInterval in server.mjs: keeps
 *  scheduling logic out of the request-handling code and makes the digest unit-
 *  testable (call generateDigest() directly, no clock dependency). */

import * as Agency from "./agency.mjs";

let _broadcaster = null;
export function setBroadcaster(fn) { _broadcaster = fn; }

/** Compute milliseconds until next 18:00 local, accounting for already-passed-today. */
function msUntilNextRun(targetHour = 18, targetMin = 0) {
  const now = new Date();
  const target = new Date();
  target.setHours(targetHour, targetMin, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** Generate the digest by reusing teamStandup with a 24h window. Returns the
 *  full standup-summary text + raw counts for downstream consumers. */
export async function generateDigest() {
  const r = await Agency.teamStandup({ hours: 24 });
  return r;
}

/** Fire the digest: generate + broadcast as a notification-friendly event. */
async function fireDigest() {
  try {
    const r = await generateDigest();
    if (!r?.ok) {
      console.warn(`[daily-digest] standup returned no summary`);
      return;
    }
    /* Emit as a task.complete envelope so notifications.js picks it up via its
     * existing subscription. The kind is digest-specific so the strip can label
     * it distinctly. */
    if (_broadcaster) {
      _broadcaster({
        type: "task.complete",
        ts: Date.now(),
        data: {
          kind: "digest",
          label: "EOD digest",
          /* Keep body short — the notification's body field truncates at ~140 chars
           * naturally. Operator opens the conversation drawer or asks "tell me
           * tonight's digest" for the full text. */
          summary: r.summary?.slice(0, 280) || "Digest ready.",
          standupRaw: r.raw,
        },
      });
    }
    console.log(`[daily-digest] fired (${r.raw?.teasers || 0} teasers, ${r.raw?.pdfs || 0} pdfs, ${r.raw?.conversations || 0} conversations)`);
  } catch (e) {
    console.warn(`[daily-digest] failed: ${e.message}`);
  }
}

/** Schedule daily firing at 18:00 local. Re-arms after each fire. */
export function schedule() {
  const arm = () => {
    setTimeout(async () => {
      await fireDigest();
      arm();
    }, msUntilNextRun(18, 0));
  };
  arm();
}
