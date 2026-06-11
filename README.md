<p align="center">
  <img src="assets/hero.png" alt="Drafty — share a Claude artifact as a link. Anyone opens it, points at a line, drops a comment. Claude ships the edit." width="1100" />
</p>

**Drafty** is point-and-comment review for the things Claude makes. Claude writes a plan, a spec, a page — you publish it to a link, then click any element and leave a note, Figma-style. Claude reads the comments and ships a new version on the same link, with history. No screenshots, no re-pasting "the third paragraph, the one about pricing."

```
/plugin marketplace add drafty-im/drafty
/plugin install drafty@drafty-im
/reload-plugins
```

Or just ask in a Claude Code session — *"install the drafty-im/drafty plugin"* — and Claude runs those for you. `/reload-plugins` switches everything on live (the `drafty` skill and the `drafty` command on PATH), no restart. Requires [bun](https://bun.sh). Sign in once with `drafty login` — Claude prompts you the first time you publish.

## Capabilities

- **"drafty it."** Tell Claude to drafty the thing it just wrote → you get a `drafty.im/canvas/<slug>` link. Anyone you share it with hovers an element, clicks, and leaves a threaded comment — live cursors, no sign-up needed to comment.
- **Claude closes the loop.** "Address the canvas" → Claude reads each thread, edits the source file, pushes a new version on the same link, replies on the canvas, and marks threads done. Set a canvas `live` and Claude works comments as they arrive.
- **Agent eyes.** `drafty shot` renders a canvas, a local HTML file, or any URL to an image so Claude can *see* what it built — including a commenter's exact view (their viewport width, their revision, the anchored element highlighted) instead of guessing at "looks squished on my phone" from text alone.
- **Site boards.** `drafty present <url>` maps a site (robots → sitemap → homepage links), curates the main screens, captures each at desktop + phone width with local Chrome, and publishes an annotatable board. `--refresh` re-shoots the same screens as a tick — competitor tracking, staging watch.
- **Versioned, with a real undo.** Every push snapshots a revision. `revert` rolls the canvas back AND resyncs the local file atomically; `status` reports in-sync / local-ahead / canvas-ahead / diverged; a push that would clobber an edit made elsewhere (browser, another agent) is refused with instructions, never silently applied.
- **Organized, and self-tidying.** Projects, tags, pin, archive — and `drafty sweep` cross-references your canvases against the repo's git log to flag the ones whose work already shipped, so finished specs get receipted and archived instead of rotting on the list.
- **Self-refreshing dashboards.** The bundled `drafty-cron` skill wires a plain OS cron — no model, no credits at runtime — that re-renders and pushes a data-backed canvas on a timer.

## How it works

Once installed, just tell Claude to **"drafty it"** after it writes something:

1. Claude runs `drafty canvas push <file>` and hands you a `drafty.im/canvas/<slug>` link.
2. Open it. Hover any element, click, leave a comment. Share the link — guests can comment too, live.
3. Tell Claude "address the canvas" (or set it live) — it reads each thread, edits the source, and pushes a new version on the same link. Old versions are kept.

You talk; Claude runs the commands. You never touch the CLI yourself.

## What's in the box

- **The `drafty` skill** — teaches Claude the whole loop: publish, read comments, reply, mark threads done, push revisions, render-and-look before claiming a visual fix, sweep shipped canvases, roll back. Claude loads it on its own when you say "drafty it" / "share this for feedback" / "what did they comment".
- **The `drafty` CLI** — a single-file, thin HTTP client. Every command is a call to drafty.im's public API; ownership and visibility are enforced server-side. No keys ship in the plugin — auth is a browser sign-in (`drafty login`), one sign-in covering web + CLI.
- **The `drafty-cron` skill** — the control plane for self-refreshing canvases (author a deterministic query → render → push script once; launchd runs it forever).

## Modes & visibility

Two orthogonal controls, both set by Claude from how you talk:

**Mode** — who can comment, and whether Claude acts:

| Mode | Viewers comment | Claude acts on comments |
|---|---|---|
| `readonly` | no | — |
| `feedback` *(default)* | yes | no — parked until you say go |
| `live` | yes | yes — works them as they arrive |

"Go live" arms a realtime doorbell so Claude reacts the moment you comment; "park it" stops it.

**Visibility** — who can view: `public` (anyone with the link — the default), `authed` (any signed-in account), or `invite` (you + invited emails only; `--private` on push). Private is server-enforced — the content is never served to anyone else.

<details>
<summary><b>Command reference</b></summary>

Claude drives these; the reference is here so you can audit what it's doing.

**Canvas**

| Command | What it does |
|---|---|
| `drafty canvas push <file> [--title] [--slug] [--mode] [--private] [--project] [--tag]` | Publish or update a `.md`/`.html` file → prints the URL. Push remembers the canvas (a repo-local manifest), so a bare re-push updates instead of forking. |
| `drafty canvas ls / show / pull / versions` | List, inspect, download content, list revisions. |
| `drafty canvas revert <file\|slug> [--to rev]` | The undo: restore the canvas AND rewrite the local file to match, atomically. (`restore` is the server-only half.) |
| `drafty canvas status <file>` | Sync report: in-sync / local-ahead / canvas-ahead / diverged. |
| `drafty canvas set / tag / untag / rename` | Organize: project, tags, title. |
| `drafty canvas archive / unarchive / pin / unpin` | Shelve finished work; hold living docs at the top of home. |
| `drafty canvas mode / visibility` | Who comments / who views (see above). |
| `drafty canvas rm <slug> --yes` | Delete a canvas (+ revisions + threads). |

**Comments**

| Command | What it does |
|---|---|
| `drafty comments ls <slug> [--open]` | Every thread + reply, with the anchored element and the commenter's viewport. |
| `drafty comments inbox [slug] [--all]` | Fresh threads that need Claude — open, latest comment from a human, loop-safe. |
| `drafty comments watch <slug> --json` | Realtime SSE stream of new comments — the doorbell for live mode. |
| `drafty comments reply / working / resolve / reopen` | Reply as Claude, shimmer the thread while working, toggle done. |
| `drafty comments rm / rm-reply / clear` | Delete a thread / one reply / everything. |

**Seeing & presenting**

| Command | What it does |
|---|---|
| `drafty shot <slug\|file.html\|url> [--width N] [--annotation A] [--full]` | Render to an image, print the path. `--annotation` reproduces a commenter's exact view. Local files/URLs and private canvases render with your own headless Chrome; public canvases use the server's cached render. |
| `drafty present <url> [--screens N] [--urls …] [--slug S --refresh] [--dry-run]` | Site board: map → curate (≤20 screens) → shoot at 1280+390px → publish annotatable board. |
| `drafty marks ls / rm` | Row-level "done/saved" state humans set on live canvases — refresh scripts read it back. |

**Session**

| Command | What it does |
|---|---|
| `drafty context` | One-shot orientation: identity, git repo/branch, projects + tags in use, recent canvases, sweep nudge. |
| `drafty sweep [--project P]` | Evidence for which canvases look shipped (slug in a commit after last update) or stale. |
| `drafty changelog` | What shipped on Drafty, by week. |
| `drafty login / logout / whoami / doctor` | Browser sign-in, identity, environment preflight. |

</details>

## Trust, privacy & telemetry

This runs on your machine, so the trust story is short and auditable — the whole CLI is one file, [`plugins/drafty/cli/canvas.ts`](plugins/drafty/cli/canvas.ts):

- **No keys, no secrets.** Nothing ships in the plugin. `drafty login` opens your browser; a one-shot listener on `127.0.0.1` (origin-checked) receives the session token, stored at `~/.drafty/token` with `0600` perms. Without a login, commands refuse and say so — nothing publishes anonymously.
- **It talks to drafty.im and nothing else** (override with `DRAFTY_BASE_URL`), plus one cached-daily GET to this repo's `plugin.json` on GitHub for the update nudge.
- **Private stays local.** `shot` renders local files and private canvases with your own headless Chrome — private content never transits the server's render pipeline or public storage. `present` captures are shot locally too, so boards of localhost/staging work.
- **Permissions are server-side.** The client sends intent; ownership, visibility, and the edit-clobber guard are enforced by the server. Editing the CLI doesn't get anyone more access.
- **Telemetry:** basic usage events (e.g. `canvas.published`) go to drafty.im so I can see what's used. `DRAFTY_NO_ANALYTICS=1` turns it off.

| Env var | Effect |
|---|---|
| `DRAFTY_BASE_URL` | Point at another server (default `https://drafty.im`) |
| `DRAFTY_NO_ANALYTICS=1` | No usage events |
| `DRAFTY_NO_UPDATE_CHECK=1` | No update nudge |
| `DRAFTY_CHROME` | Path to the browser binary for local rendering |

## Links

- The product: **[drafty.im](https://drafty.im)**
- What's new: `drafty changelog`, or [drafty.im/changelog](https://drafty.im/changelog)
- Agent quickstart (no install, demo only): [drafty.im/get](https://drafty.im/get)

MIT licensed.
