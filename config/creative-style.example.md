# Creative Style Guide

> Your "template for success" — the rules every generated email, document, message, or
> creative draft should follow. Think of this as the brief you'd give a freelance writer
> or assistant on day one.
>
> This file is read by the LLM on every request. Edit freely; changes take effect on the
> next message (no bridge restart needed).
>
> Copy this template to `config/creative-style.md` and replace the examples below with
> your own. The defaults are deliberately neutral so the LLM gets useful guidance even
> before you customise.

---

## Editorial voice

- **Tone**: confident, knowledgeable, slightly understated. Avoid breathless or salesy.
- **Sentence length**: vary it. Short. Then a longer one that gives the reader space to breathe. Then short again.
- **Active voice** by default. Switch to passive only when the actor is genuinely irrelevant.
- **British English** if that's your default ("colour", "centre", "organise") — set whatever you actually use here. The LLM will follow it.
- **Numbers** in words for under ten ("nine seconds"), digits for over ten ("450"). State your preference.
- **Avoid clichés**: "unleash", "next-level", "game-changer", "deep dive", "circle back".
- **Avoid filler**: "really", "very", "just", "simply", "in order to", "the fact that".

## Words we use

> Replace this list with vocabulary specific to your domain. Examples:
>
> - For a law firm: "matter" not "case", "instruction" not "request", "clauses" not "bits".
> - For a clinic: "appointment" not "session", "follow-up" not "check-in".
> - For an agency: brand names spelled exactly as the client uses them.

- _your-term-1_ — never _generic-alternative_
- _your-term-2_ — never _generic-alternative_

## Words we avoid

- Hyperbolic adjectives without earning them ("stunning", "incredible", "amazing")
- Corporate-speak ("synergy", "leverage", "best-in-class")
- Exclamation marks in any deliverable copy
- _Add your own pet peeves here so they show up in every generated draft._

## Email drafts

- **Greeting**: state your default — "Hi [first name]," or "Hello [first name]," or whatever fits.
- **First sentence**: state the reason for the email. No "I hope you're well."
- **Sign-off**: pick one and stick to it — "All the best," / "Speak soon," / "Kind regards,".
- **Signature**: name on its own line, role on the next, contact on the third.
- **Length**: under 120 words for cold pitches; under 200 for follow-ups.

## Document drafts

- **Headers**: sentence case, not Title Case ("Quarterly review" not "Quarterly Review").
- **Bullet lists**: parallel structure — every bullet starts with the same part of speech.
- **Numbers + units**: always with a non-breaking space ("£250", "30 mph", "4 GB").

## Specific deliverables

> Add per-deliverable rules below if you have any. Examples:
>
> - **Press releases**: lead with the news, not the company. Quote a real human in the second paragraph.
> - **Social captions**: Instagram = scene-setting first sentence; LinkedIn = insight + question; TikTok = no captions, leave to the speaker.
> - **Internal Slack**: bullet points, never paragraphs. Emoji allowed. Active verbs.

## What to escalate, not draft

The LLM should ask first, not draft, when:

- A claim depends on a fact it doesn't have.
- The recipient or audience is ambiguous.
- The draft would reveal information that's been flagged as confidential.

## Examples

> Paste 1-3 examples of writing you're proud of below. The LLM uses these as the strongest
> signal of what "good" looks like for you. One paragraph each is enough.

**Example 1 — Email reply (the kind you'd be happy to send):**

```
Hi Sam,

Thanks for the detail. The constraint that matters here is the launch date — we can fit
either A or B inside it, but not both. My read is A, because it unblocks the team
review that's already in the calendar. If B turns out to be the bigger lever I'd rather
delay than do half-quality work on both.

Speak soon,
Antony
```

**Example 2 — Document opening (the kind that earns the reader's attention):**

```
The migration ran clean for ten weeks. Then last Tuesday, between 14:02 and 14:18, the
write-path errored at twelve times the baseline rate. This document is the post-mortem.
```

---

_Last reviewed: yyyy-mm-dd_
