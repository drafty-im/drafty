#!/bin/zsh
# Refresh template for a self-updating Drafty canvas. Copy this next to your
# render script, fill in the three MARKED spots, and schedule it with the
# drafty-cron helper. It renders the artifact and pushes ONLY when the data
# changed, so a tight schedule (e.g. every 5 min) doesn't spam version history.
set -e

# launchd runs with a bare PATH — point at the real tools explicitly.
# Add whatever your render step needs (here: bun + the gcloud SDK for BigQuery).
export PATH="$HOME/.bun/bin:/opt/homebrew/share/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "${0:A:h}"   # this script's directory

SLUG="REPLACE-with-your-canvas-slug"
OUT="REPLACE-with-your-rendered-file.html"
DRAFTY="$HOME/Projects/drafty/plugins/drafty/cli/canvas.ts"   # version-stable source CLI

# 1) RENDER — replace with your own deterministic build step (query → HTML).
REPLACE_render_command   # e.g. bun render.ts

# 2) PUSH ONLY IF CHANGED — hash the output excluding any "Generated <time>" line.
new=$(grep -v 'Generated ' "$OUT" | shasum -a 256 | awk '{print $1}')
old=$(cat .last-hash 2>/dev/null || true)
if [ "$new" = "$old" ]; then
  echo "$(date '+%F %T') — no change, skipped push"; exit 0
fi

# --refresh marks the canvas as self-refreshing (free plan includes one; a
# second needs Drafty Pro — the push prints the upgrade link if it's gated).
bun "$DRAFTY" canvas push "$OUT" --private --refresh --slug "$SLUG" >/dev/null 2>&1
echo "$new" > .last-hash
echo "$(date '+%F %T') — data changed, pushed"
