---
name: drafty-cron
description: Keep a Drafty canvas auto-updated from live data on a schedule, using a LOCAL macOS launchd cron — with no Claude in the loop at runtime (no claude -p, no /loop, no credits). Claude authors the refresh script once and installs/manages the cron; launchd runs the deterministic "query → render → push" job forever. Use when the user wants a canvas (a metrics/growth dashboard, a status board, anything data-backed) to refresh itself periodically, or says "keep this canvas updated", "schedule this canvas", "refresh every N minutes", "make it live", "auto-update the dashboard", "pause/stop the schedule", or "what's scheduled".
---

# drafty-cron — self-refreshing Drafty canvases

A canvas refresh is **mechanical**: run a script (pull data → render HTML → push). No reasoning, no model needed at run time. So it should NOT run through Claude — it runs as a plain OS cron.

- **Control plane (occasional, you):** author the refresh script, install the cron, manage it. That's this skill.
- **Data plane (continuous, no Claude):** a `launchctl` job runs the script on a timer. Free, runs whether or not Claude is around.

Do **not** reach for `/loop`, `claude -p`, or `CronCreate` here — those re-invoke the model every run (credits + a live session). Use a real OS cron (`launchctl`).

> Platform note: this skill uses **macOS launchd**. The pattern (a plain OS cron running a render→push script) works anywhere; only the install helper is macOS-specific.

## Helper

`drafty-cron.sh` (bundled next to this SKILL.md) manages the launchd jobs. On first use, copy it to a stable path so launchd references survive plugin updates:

```sh
mkdir -p ~/.drafty && cp "$(dirname "$0")/drafty-cron.sh" ~/.drafty/cron.sh 2>/dev/null || true
CRON=~/.drafty/cron.sh   # or run the bundled copy directly
"$CRON" add <name> <interval_secs> <command...>   # install + start (RunAtLoad fires immediately)
"$CRON" ls                                          # list drafty crons (PID/status)
"$CRON" log <name>                                  # tail the run log
"$CRON" rm <name>                                   # stop + remove
```

## Setting up a refresh for a canvas

1. **Author the refresh script** (the smart, one-time part) — start from `refresh.template.sh` bundled here. It must, deterministically:
   - pull the data (a `bq query`, a SQL connector, an API call, …),
   - render a self-contained HTML file,
   - **push only if the data changed** — hash the HTML *excluding* any "Generated <timestamp>" line, compare to a `.last-hash` sidecar, and skip the push when unchanged. This is what makes a tight cadence safe (no no-op revisions).
   - **push with `--refresh`** — marks the canvas as self-refreshing on the server. The free plan includes one; arming a second prints an upgrade link (Drafty Pro runs unlimited). Re-pushes to an already-armed canvas always go through, so a running schedule never breaks.
2. **launchd has a bare PATH** — the #1 gotcha. Export an explicit PATH in the script pointing at the real tools (`~/.bun/bin`, the gcloud SDK bin, `/opt/homebrew/bin`). Use the **version-stable** drafty source CLI for the push (`bun ~/Projects/drafty/plugins/drafty/cli/canvas.ts canvas push …`), not the version-pinned plugin-cache binary.
3. **Install the cron**, e.g. every 5 minutes:
   ```sh
   "$CRON" add my-dashboard 300 "/abs/path/to/refresh.sh"
   ```
4. **Verify** with `"$CRON" log my-dashboard` — the first run fires on load; expect "pushed" or "no change, skipped".

## Cadence

Local crons are free per run, so aggressive cadences (every 5 min = `300`) are fine. The only real costs are (a) data-source query bytes — keep queries cheap/capped — and (b) version history, which the push-only-if-changed guard already protects. Match the interval to how fast the data actually moves; 5–15 min suits most dashboards.

## Honesty / caveats

- **Local only.** launchd jobs run while the Mac is awake (they survive reboot/logout, not power-off; on sleep, missed runs coalesce to one run on wake). For always-on (laptop-closed) refresh you'd need a cloud runner — out of scope here.
- Needs the runtime creds present locally (e.g. gcloud auth for BigQuery, the `~/.drafty` token for push).
