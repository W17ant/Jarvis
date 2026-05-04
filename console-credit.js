/** console-credit.js — developer signature in the browser console.
 *
 *  Mirrors aoneill.co.uk's ConsoleEasterEgg verbatim — same ASCII art, colour
 *  palette, and arg order — so the personal brand badge stays consistent
 *  across surfaces. One-shot per browser session via sessionStorage so it
 *  doesn't repeat on every nav. */

const SHOWN_KEY = "ao-credit-shown";

export function init() {
  if (sessionStorage.getItem(SHOWN_KEY) === "1") return;
  sessionStorage.setItem(SHOWN_KEY, "1");

  const font = "font-family: monospace; font-size: 12px;";
  const cyan   = `color: #22d3ee; ${font}`;
  const pink   = `color: #f472b6; ${font}`;
  const purple = `color: #c084fc; ${font}`;
  const blue   = `color: #60a5fa; ${font}`;
  const teal   = `color: #2dd4bf; ${font}`;
  const green  = `color: #4ade80; ${font}`;
  const yellow = `color: #facc15; ${font}`;
  const white  = `color: rgba(255,255,255,0.8); ${font}`;
  const dim    = `color: rgba(255,255,255,0.6); ${font}`;

  console.log(
    "%c╔═══════════════════════════════════════════════════════════════╗\n" +
    "║                                                               ║\n" +
    "%c║   █████╗  ██████╗ ███╗   ██╗███████╗██╗██╗     ██╗            ║\n" +
    "%c║  ██╔══██╗██╔═══██╗████╗  ██║██╔════╝██║██║     ██║            ║\n" +
    "%c║  ███████║██║   ██║██╔██╗ ██║█████╗  ██║██║     ██║            ║\n" +
    "%c║  ██╔══██║██║   ██║██║╚██╗██║██╔══╝  ██║██║     ██║            ║\n" +
    "%c║  ██║  ██║╚██████╔╝██║ ╚████║███████╗██║███████╗███████╗       ║\n" +
    "%c║  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═╝╚══════╝╚══════╝       ║\n" +
    "%c║                                                               ║\n" +
    "%c║                   A O N E I L L . C O . U K                  ║\n" +
    "%c║                                                               ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║                                                               ║\n" +
    "%c║  JARVIS · Voice-driven AI kiosk for an automotive agency      ║\n" +
    "║  Built by AI & ML Developer · Manchester, UK                  ║\n" +
    "%c║                                                               ║\n" +
    "%c║  Stack: Node · Ollama · Qwen 2.5 · Whisper · Kokoro · ffmpeg  ║\n" +
    "║  Focus: Local-first AI · Voice · Privacy · Studio ops         ║\n" +
    "%c║                                                               ║\n" +
    "%c║  github.com/W17ANT/Jarvis                                     ║\n" +
    "%c║  aoneill.co.uk                                                ║\n" +
    "╚═══════════════════════════════════════════════════════════════╝\n\n" +
    "%c  Looking to hire? Let's talk: Antony@aoneill.co.uk\n",
    cyan, pink, purple, blue, cyan, teal, green, cyan, yellow, cyan, white, cyan, dim, cyan, blue, cyan, green
  );

  console.log("%c👋 Thanks for checking out the console!", "color: #60a5fa; font-weight: bold;");
}
