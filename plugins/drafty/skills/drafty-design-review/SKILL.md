---
name: drafty-design-review
description: Turn a screen-recording walkthrough — someone narrating UI/UX critique while navigating an app — into a Drafty-branded design-review canvas: every spoken feedback point cataloged with a real screenshot at its timestamp, severity, category, a verbatim quote, and a concrete fix, ready to hand to a fixing agent. Gemini multimodal (video + audio) does the extraction; ffmpeg pulls the frames; the canvas is dual-theme (light + dark) Drafty brand and publishes with the `drafty` CLI. Use when given a recording of design/UX feedback to catalog, or asked to "turn this walkthrough into a canvas", "design review canvas", "catalog the feedback from this video", "what did they say about the app". Needs GEMINI_API_KEY + ffmpeg.
---

# Drafty design-review canvas

A recording where someone talks through an app giving design feedback → a
structured, screenshotted, fixable Drafty canvas. Two scripts:
`extract-feedback.sh` (video → `feedback.json` via Gemini) and `build-canvas.py`
(`feedback.json` + video → frames + branded canvas + push). The `drafty` command
ships with this plugin and is already on PATH; run `drafty login` once first.

## The pipeline

```
recording.mp4
  └─ extract-feedback.sh --estimate   →  see the cost, pick the model
  └─ extract-feedback.sh              →  feedback.json  (review + filter it)
  └─ build-canvas.py                  →  shots/ + design-review.html → drafty
```

### 1. Estimate cost first, then pick the model

Gemini is the right tool here (audio carries most of the feedback). Cost is
cents, but the model choice is a real quality fork — run `--estimate` first:

```sh
"${CLAUDE_PLUGIN_ROOT}/skills/drafty-design-review/scripts/extract-feedback.sh" \
  recording.mp4 --estimate
```

- **gemini-3.5-flash** (default) — best timestamp accuracy + UI-text reading +
  agent-ready fixes. ~$0.10–0.15 for a 12-min clip. Use unless cost matters.
- **gemini-2.5-flash** — ~5× cheaper, weaker timestamps/UI-text. Only if scaling.
- Timestamps drive screenshot extraction, so timestamp precision is what you're
  paying for — that's why 3.5 is the default.
- Gemini 3.x defaults video to LOW media resolution (~90 tok/sec incl. audio).
  Fine here — real frames are pulled locally, so Gemini only needs to know
  *which* screen, not OCR it.

### 2. Extract

```sh
"${CLAUDE_PLUGIN_ROOT}/skills/drafty-design-review/scripts/extract-feedback.sh" \
  recording.mp4 -o feedback.json
```
Needs `GEMINI_API_KEY`. Uploads via the Files API (videos >20MB can't go
inline), runs a forced-JSON schema, writes `feedback.json` with `app_overview`,
`screen_inventory`, and `feedback_items` (id, timestamp, screen, on_screen,
spoken_feedback, transcript_quote, ui_ux_problem, severity, category,
suggested_fix, is_speaker_opinion).

### 3. Review + filter against the product's intent (the judgment step)

Read `feedback.json` and weigh it — don't blindly publish. If the product has a
spec or design rationale grounded in real user data, feedback that contradicts a
data-backed decision should be flagged or dropped, not shipped as a fix (e.g.
"add more features" when the product's thesis is a focused core). Reviewers are
often not the target users — their craft opinions (spacing, hierarchy,
interaction) are gold; their product-direction opinions defer to the data.

Capture the keep-these constraints in a `respect.md` (markdown `- ` bullets,
`**bold**` ok) and pass `--respect` so the canvas carries a "Design decisions to
respect (don't fix these)" guard for the fixing agent.

### 4. Build + push

```sh
python3 "${CLAUDE_PLUGIN_ROOT}/skills/drafty-design-review/scripts/build-canvas.py" \
  feedback.json --video recording.mp4 --title "<App> — design feedback" \
  --project <project> [--respect respect.md] [--slug <existing>] [--out-dir out] \
  [--source-note "Recording … · Gemini 3.5 Flash · reviewers are designers, not target users"]
```
Extracts a real frame at each item's `timestamp_start`, renders the dual-theme
canvas, pushes `--private --mode feedback`, tags `design-feedback`, prints the
URL. Re-push with `--slug` to iterate in place (keeps version history).

## Images: local refs, never data URIs

`build-canvas.py` writes `<img src="shots/item_NN.png">` and `drafty canvas
push` **auto-uploads** each local image to Drafty's CDN, rewriting to served
URLs. Result: ~20KB HTML + lazy CDN images, not a multi-MB data-URI blob. Keep
the `shots/` dir next to the HTML so the refs resolve on push.

## Brand

The look lives in `scripts/drafty_theme.py` (one source of truth): Drafty's
magenta accent (`#c600db` light / `#e05cf0` dark) on a lavender/deep-purple
background, reserved 60-30-10 for HIGH severity + the Fix action — grays carry
everything else. Real dual-theme via `prefers-color-scheme` (a separate dark
palette, not an inversion); never declare a single `color-scheme` or you kill
the other theme. Any other canvas script can import `drafty_theme` for the same
look.

## Report

- Put the **bare URL** in the report (never bold-wrap links).
- Also send a couple of rendered crops to the user (e.g. via the host's file
  tool) — recipients often see the report first on mobile. Render with
  `drafty shot <file> --full`, then crop.
- Then watch it like any drafty canvas: comments are feedback on the work.

## Notes / gotchas

- `feedback.json` is editable — fix a wrong timestamp or drop an item before
  building; re-run `build-canvas.py` (cheap, no API call).
- Verify a few frames land on the right UI before pushing — a drifted timestamp
  means a screenshot of the wrong screen.
- If the recording's tail is silent navigation, Gemini returns no items there;
  say so rather than implying full coverage.
- `drafty shot <file.html>` renders the local file (resolves sibling `shots/`)
  for a pre-push preview; it can't toggle theme, so to preview dark, temporarily
  copy the dark `:root` vars over the light ones.
