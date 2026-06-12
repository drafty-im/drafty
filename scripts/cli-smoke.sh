#!/bin/bash
# Real CLI round-trip against a running drafty.im server — for a CLI-only change
# that touches request/response handling (where preflight.ts's parse+boot check
# isn't enough). Needs a server + an auth token; isolated HOME so the real
# ~/.drafty is never touched.
#
#   # against a local web dev server, with a token you already have:
#   DRAFTY_TOKEN=<refresh-token> BASE=http://localhost:4056 bash scripts/cli-smoke.sh
#
#   # or reuse your real login (read-only-ish ops only — push creates a canvas):
#   bash scripts/cli-smoke.sh            # uses ~/.drafty + https://drafty.im
#
# Note: the WEB repo's ship-check already drives this binary against a throwaway
# app (web/scripts/cli-check.sh) — that's the contract gate for web changes.
# This is the CLI-side equivalent for when the CLI itself changes.
set -uo pipefail
CLI="$(cd "$(dirname "$0")/.." && pwd)/plugins/drafty/cli/canvas.ts"
BASE="${BASE:-https://drafty.im}"
# Which runtime drives the CLI — both are supported; run the smoke under each
# when the change touches runtime-sensitive code: RUNTIME=node bash scripts/cli-smoke.sh
RT="${RUNTIME:-bun}"
[ "$RT" = "node" ] && RT="node --disable-warning=ExperimentalWarning"

ISO="$(mktemp -d)"; trap 'rm -rf "$ISO"' EXIT
mkdir -p "$ISO/.drafty"
if [ -n "${DRAFTY_TOKEN:-}" ]; then
  printf '%s' "$DRAFTY_TOKEN" > "$ISO/.drafty/token"
  printf '{"signedIn":true,"email":"cli-smoke@local"}' > "$ISO/.drafty/identity.json"
elif [ -f "$HOME/.drafty/token" ]; then
  cp "$HOME/.drafty/token" "$ISO/.drafty/token"
  [ -f "$HOME/.drafty/identity.json" ] && cp "$HOME/.drafty/identity.json" "$ISO/.drafty/identity.json"
else
  echo "cli-smoke: no DRAFTY_TOKEN and no ~/.drafty/token — provide one."; exit 1
fi

WORK="$ISO/work"; mkdir -p "$WORK"
dcli() { HOME="$ISO" DRAFTY_BASE_URL="$BASE" $RT "$CLI" "$@"; }
fails=0; ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; fails=$((fails+1)); }

echo "cli-smoke against $BASE"
dcli whoami >/dev/null 2>&1 && ok "whoami" || bad "whoami"
printf "# cli-smoke\n\nround-trip bytes\n" > "$WORK/s.md"
( cd "$WORK" && dcli canvas push s.md --title "cli-smoke" --private ) >/dev/null 2>&1 && ok "push" || bad "push"
slug="$(cd "$WORK" && python3 -c "import json;d=json.load(open('.drafty/manifest.json'));d=d.get('files',d);print(d['s.md']['slug'])" 2>/dev/null)"
if [ -n "$slug" ]; then
  [ "$(dcli canvas pull "$slug" 2>/dev/null)" = "$(printf '# cli-smoke\n\nround-trip bytes\n')" ] && ok "pull byte-match" || bad "pull mismatch"
  dcli canvas rm "$slug" --yes >/dev/null 2>&1 && ok "rm (cleanup)" || bad "rm"
else
  bad "no slug from push"
fi

echo ""
[ "$fails" -gt 0 ] && { echo "cli-smoke FAILED ($fails)"; exit 1; }
echo "OK cli-smoke green."
