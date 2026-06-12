# drafty CLI plugin — guidance

The out-of-repo `drafty` CLI + skill, shipped as a Claude Code plugin
(`github.com/drafty-im/drafty`). The CLI is **one file** —
`plugins/drafty/cli/canvas.ts` (single-file TypeScript on Node builtins, no
build step, no deps) — a thin HTTP/SSE client of the drafty.im web app's
public `/get/api/*` + `/api/track` contract. The web app's CLAUDE.md owns the
server side; keep that contract stable in both directions.

**Dual runtime — keep it that way.** The CLI runs under bun OR plain Node
≥22.18 (native type stripping); `bin/drafty` picks whichever is on PATH (bun
first). Hard rules when editing `canvas.ts`: Node builtins only — no `Bun.*`
globals, no `import.meta.dir` (use `.dirname`) — and only **erasable** TS
syntax (no enums, no namespaces, no constructor parameter properties).
preflight greps for bun-isms and boots the binary under both runtimes, so a
violation fails the gate before it ships.

## Shipping = pushing (no CI, all local)

An un-pinned plugin ships **by commit SHA on plain `git push`** — so a broken
`canvas.ts` reaches every installed user the moment you push. There is no CI.
The gate is local and mandatory:

- **Before any push: `bun scripts/preflight.ts`** (~3s, self-contained). Parses
  + bundles the CLI, boots it (`--help`), and checks the signed-out error path —
  catches the "syntax error / bad import / crash-on-load shipped to everyone"
  class. `scripts/release.ts` runs it automatically and aborts the release on
  failure, so an intentional version bump is gated too.
- **For a change that touches request/response handling** (new op, changed field
  read, manifest/sync logic): also run a REAL round-trip. Two ways:
  - `web/scripts/cli-check.sh` in the **web repo's** ship-check already drives
    THIS binary against a throwaway app — that's the contract gate for *web*
    changes. Run the web ship-check if the change spans both.
  - `bash scripts/cli-smoke.sh` here, against a running server you point it at:
    `DRAFTY_TOKEN=<refresh-token> BASE=http://localhost:<port> bash scripts/cli-smoke.sh`
    (or no env = your real `~/.drafty` + prod; push creates a real canvas).

preflight + cli-smoke both use an **isolated HOME** so the real `~/.drafty`
login is never touched.

## Release

`bun scripts/release.ts <semver>` — gates via preflight, bumps
`plugins/drafty/.claude-plugin/plugin.json`, commits, tags, pushes. Users update
with `claude plugin marketplace update drafty-im`. **Plugin/CLI releases are a
separate authorization** (per the ship-it skill) — don't cut one without John's
explicit go.

## The contract seam

`canvas.ts` reads specific response fields off each `/get/api/*` op with NO
shared types — e.g. `canvas.push` → `{slug, rev, title, …}`, `canvas.pull` →
`{content, format, title}`, `canvas.ls` → `{items: [{slug, title, mode,
visibility, …}]}`. The web app must not drop these; its `test/http-smoke.test.ts`
locks the shapes + the legacy `documents.*`→`canvas.*` aliases, and
`cli-check.sh` proves the real binary still works. If you add a field the CLI
reads, add it to the web's smoke asserts in the same change.
