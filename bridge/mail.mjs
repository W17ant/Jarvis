/** mail.mjs - Apple Mail.app integration via AppleScript.
 *  Read-only metadata + draft creation. Drafts are NEVER auto-sent — they open in Mail for human approval.
 *
 *  Tools:
 *    get_mail_summary({ unreadOnly, max })  - subject + from + date for recent messages
 *    draft_email({ to, subject, body, cc })  - opens a new outgoing message ready for the user to send
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function osa(script) {
  const { stdout, stderr } = await execFileP("osascript", ["-e", script], { maxBuffer: 8 * 1024 * 1024 });
  if (stderr && !stdout) throw new Error(stderr.trim());
  return stdout;
}

/* ---------- TOOL: get mail summary ---------- */
export async function getMailSummary({ unreadOnly = true, max = 10 } = {}) {
  /* AppleScript: enumerate inbox, format as "FROM | SUBJECT | DATE | READ?". */
  const filterClause = unreadOnly ? "whose read status is false" : "";
  const script = `set output to ""
set msgCount to 0
tell application "Mail"
  try
    set inboxMsgs to (messages of inbox ${filterClause})
    set msgCount to count of inboxMsgs
    repeat with i from 1 to (count of inboxMsgs)
      if i > ${max} then exit repeat
      set m to item i of inboxMsgs
      set s to (subject of m as string)
      set f to ""
      try
        set f to (sender of m as string)
      end try
      set d to (date received of m as string)
      set r to (read status of m as string)
      set output to output & f & " | " & s & " | " & d & " | " & r & linefeed
    end repeat
  end try
end tell
return msgCount as string & "::" & output`;

  const stdout = await osa(script);
  const [countStr = "0", lines = ""] = stdout.split("::");
  const messages = lines.trim().split("\n").filter(Boolean).map((line) => {
    const [from = "", subject = "", date = "", readStatus = ""] = line.split(" | ");
    return { from: from.trim(), subject: subject.trim(), date: date.trim(), unread: readStatus.trim() === "false" };
  });
  return { ok: true, totalMatching: parseInt(countStr, 10) || 0, messages };
}

/* ---------- TOOL: draft email (NEVER auto-send) ---------- */
export async function draftEmail({ to, subject, body, cc = "" }) {
  if (!to) throw new Error("to required");
  if (!subject) throw new Error("subject required");

  const script = `tell application "Mail"
    activate
    set newMsg to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:"${(body || "").replace(/"/g, '\\"').replace(/\n/g, "\\n")}", visible:true}
    tell newMsg
      make new to recipient with properties {address:"${to.replace(/"/g, '\\"')}"}
      ${cc ? `make new cc recipient with properties {address:"${cc.replace(/"/g, '\\"')}"}` : ""}
    end tell
    return "draft opened: " & subject of newMsg
  end tell`;

  const stdout = await osa(script);
  return { ok: true, status: stdout.trim(), to, subject };
}
