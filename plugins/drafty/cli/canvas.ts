#!/usr/bin/env node
// drafty CLI — publish canvases to drafty.im/canvas/<slug>, then read and reply to
// feedback as Claude.
//
// A thin HTTP/SSE client: it holds the user's account token (from `drafty login`,
// stored under ~/.drafty) and drives everything through the public /get/api
// endpoints. No InstantDB dependency, no native deps — installs anywhere.
//
// Runtime: Node ≥22.18 or bun — Node builtins only, and only erasable TS syntax
// (no enums/namespaces/parameter properties), so plain `node canvas.ts` works
// with native type stripping. No bun-only globals or meta fields — preflight
// greps the source to keep it that way.
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

const BASE_URL = process.env.DRAFTY_BASE_URL || "https://drafty.im";
// Login/token/manifest state lives in ~/.drafty by default. DRAFTY_STATE_DIR
// overrides it so a sandboxed run (an e2e harness, or an agent under test) keeps
// its login fully separate from the real ~/.drafty — same spirit as DRAFTY_BASE_URL.
const STATE_DIR = process.env.DRAFTY_STATE_DIR || join(homedir(), ".drafty");
const TOKEN_FILE = join(STATE_DIR, "token");
// A durable marker of the last signed-in identity, kept alongside the token.
// If the token ever goes missing while this says we were signed in, we say so
// LOUDLY instead of failing vaguely (see getToken / main) — a lost session asks
// for `drafty login` again rather than quietly publishing as someone else.
const IDENTITY_FILE = join(STATE_DIR, "identity.json");
type Identity = { signedIn?: boolean; email?: string; userId?: string; sessionLost?: boolean };

function readIdentity(): Identity | null {
  try { return existsSync(IDENTITY_FILE) ? JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) : null; }
  catch { return null; }
}
function writeIdentity(id: Identity): void {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(IDENTITY_FILE, JSON.stringify(id), { mode: 0o600 }); }
  catch { /* marker is best-effort; never block a command on it */ }
}
function clearIdentity(): void {
  try { if (existsSync(IDENTITY_FILE)) rmSync(IDENTITY_FILE, { force: true }); } catch { /* non-fatal */ }
}
const ANALYTICS_ID_FILE = join(STATE_DIR, "analytics-id");

// Thin analytics: a stable per-install id (the agent is its own "user") and a
// fire-and-forget POST to /api/track. No SDK. Best-effort — never let telemetry
// break or slow a command.
function analyticsId(): string {
  try {
    if (existsSync(ANALYTICS_ID_FILE)) return readFileSync(ANALYTICS_ID_FILE, "utf8").trim();
  } catch { /* fall through */ }
  const id = crypto.randomUUID();
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ANALYTICS_ID_FILE, id, { mode: 0o600 });
  } catch { /* ignore */ }
  return id;
}
async function track(eventName: string, props: Record<string, unknown> = {}): Promise<void> {
  if (process.env.DRAFTY_NO_ANALYTICS) return;
  try {
    // Attribute events to the signed-in account when there is one; fall back to
    // the per-install id only when signed out.
    const idn = readIdentity();
    const userId = idn?.signedIn && idn.userId ? idn.userId : analyticsId();
    await fetch(`${BASE_URL}/api/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        records: [{
          kind: "event",
          row: {
            event_id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            event_name: eventName,
            user_id: userId,
            anonymous_id: idn?.signedIn ? analyticsId() : null,
            session_id: null,
            properties: JSON.stringify({
              ...props,
              source: "drafty-cli",
              surface: "cli",
              cli_version: installedVersion(),
              authed: !!idn?.signedIn,
            }),
          },
        }],
      }),
    });
  } catch { /* best-effort */ }
}
const SKILL_DST = join(homedir(), ".claude", "skills", "drafty", "SKILL.md");

// ── update check ─────────────────────────────────────────────────────────────
// A quiet, npm-style nudge: compare the installed version against the latest
// published one and, if behind, print a one-liner to stderr (never stdout, so it
// can't corrupt --json output). Throttled to once a day, cached in ~/.drafty.
// The apply step is left to the human on purpose — `claude plugin update` mutates
// their environment, and the running session won't pick the new version up until
// /reload-plugins anyway. Set DRAFTY_NO_UPDATE_CHECK=1 to silence it.
const UPDATE_CHECK_FILE = join(STATE_DIR, "update-check.json");
const UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/drafty-im/drafty/main/plugins/drafty/.claude-plugin/plugin.json";
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

function installedVersion(): string | null {
  try {
    const p = join(import.meta.dirname, "..", ".claude-plugin", "plugin.json");
    return (JSON.parse(readFileSync(p, "utf8")).version as string) || null;
  } catch { return null; }
}
// -1 if a < b, 0 if equal, 1 if a > b. Plain x.y.z, no pre-release tags.
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(UPDATE_MANIFEST_URL, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const v = (await res.json())?.version;
    return typeof v === "string" ? v : null;
  } catch { return null; }
}
// Latest published version: returns the cached value when fresh, else refetches
// (and re-stamps the cache so an offline run doesn't re-hit the network each call).
async function latestVersion(): Promise<string | null> {
  let cache: { latest?: string; checkedAt?: number } = {};
  try { if (existsSync(UPDATE_CHECK_FILE)) cache = JSON.parse(readFileSync(UPDATE_CHECK_FILE, "utf8")); } catch { /* ignore */ }
  if (cache.checkedAt && Date.now() - cache.checkedAt < UPDATE_TTL_MS) return cache.latest ?? null;
  const fetched = await fetchLatestVersion();
  const next = { latest: fetched ?? cache.latest, checkedAt: Date.now() };
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(next)); } catch { /* ignore */ }
  return next.latest ?? null;
}
async function maybeNudgeUpdate(): Promise<void> {
  if (process.env.DRAFTY_NO_UPDATE_CHECK) return;
  const cur = installedVersion();
  if (!cur) return;
  const latest = await latestVersion();
  if (!latest || cmpSemver(cur, latest) >= 0) return;
  const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
  process.stderr.write(
    `\n${y(`▲ drafty ${latest} available`)} \x1b[2m(you're on ${cur})\x1b[0m\n` +
    `  ${y("claude plugin update drafty@drafty-im")} then ${y("/reload-plugins")}\n` +
    `  — or just ask me to "update drafty".\n`,
  );
}

// ── pure helpers (no network) ────────────────────────────────────────────────
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function shortHash(n = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
// Readable, collision-proof slug from a base: "launch-plan-9fk2q".
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${base || "canvas"}-${shortHash()}`;
}
function inferFormat(file: string, content: string): "markdown" | "html" {
  // Content wins over extension. A full HTML document pushed from a non-.html file
  // (e.g. the default `canvas pull -o x.txt` → edit → push loop) must not be
  // silently downgraded to markdown — that flips the stored format and renders the
  // raw <html> as text, blanking the canvas. Only a document that *opens* with a
  // doctype/<html> counts; markdown that merely embeds a <div> stays markdown.
  if (/^﻿?\s*<(?:!doctype\s+html|html[\s>])/i.test(content)) return "html";
  return /\.html?$/i.test(file) ? "html" : "markdown";
}
// Titles are stored and rendered as plain text, but inferTitle reads HTML *source*
// (and markdown, where renderers also honor entities) — so "A &amp; B" must become
// "A & B" here. &amp; is decoded last so "&amp;lt;" doesn't double-decode.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
function inferTitle(content: string, format: string, file: string): string {
  if (format === "markdown") {
    const m = content.match(/^#\s+(.+)$/m);
    if (m) return decodeEntities(m[1].trim());
  } else {
    const t = content.match(/<title[^>]*>([^<]+)<\/title>/i) || content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (t) return decodeEntities(t[1].trim());
  }
  return basename(file).replace(/\.[^.]+$/, "");
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(`--${name}`);
// Collect every value of a repeatable flag: `--tag plan --tag research` → ["plan","research"].
// Also splits a single comma-separated value (`--tag plan,research`) for convenience.
function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) out.push(...args[i + 1].split(","));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
const url = (slug: string) => `${BASE_URL}/canvas/${slug}`;
const shortTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// Parse a human duration → ms: "20m", "90s", "1h", "500ms", or a bare number (= seconds).
// null if unparseable. Lets long-running commands self-bound without an external
// `timeout` (which macOS doesn't ship — the classic agent "command not found: timeout").
function parseDurationMs(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[(m[2] || "s").toLowerCase()] ?? 1000;
  return Math.round(Number(m[1]) * mult);
}
// Compact "time since" for listings — "just now" / "3h ago" / "5d ago".
function relTime(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const MODES = ["readonly", "feedback", "live"] as const;
type Mode = (typeof MODES)[number];
const modeLabel: Record<Mode, string> = { readonly: "read-only", feedback: "collecting feedback", live: "live" };
function parseMode(value: string | undefined): Mode | undefined {
  if (value === undefined) return undefined;
  if (!(MODES as readonly string[]).includes(value)) die(`mode must be one of: ${MODES.join(", ")}`);
  return value as Mode;
}
function modeLine(mode: Mode, slug: string): string {
  if (mode === "readonly") return "view only — comments are off";
  if (mode === "feedback") return `people can comment; Claude waits for your go — run \`drafty canvas mode ${slug} live\``;
  return "Claude works new comments as they arrive";
}

// Visibility = WHO can view, orthogonal to mode (who can comment). 'public' =
// anyone with the link (default); 'authed' = any signed-in account; 'invite' =
// only the owner + emails on the canvas's invite list. With no invites added,
// 'invite' means owner-only — i.e. private. Enforced server-side by the `view`
// perm; `--private` is sugar for `--visibility invite`.
const VISIBILITIES = ["public", "authed", "invite"] as const;
type Visibility = (typeof VISIBILITIES)[number];
const visibilityLabel: Record<Visibility, string> = {
  public: "anyone with the link",
  authed: "any signed-in account",
  invite: "you + invited emails only (private)",
};
// Resolve --visibility / --private into a visibility value (or undefined = leave as-is).
function parseVisibility(args: string[]): Visibility | undefined {
  const raw = flag(args, "visibility");
  const priv = has(args, "private");
  if (priv && raw && raw !== "invite") die(`--private conflicts with --visibility ${raw}`);
  if (priv) return "invite";
  if (raw === undefined) return undefined;
  if (!(VISIBILITIES as readonly string[]).includes(raw)) die(`--visibility must be one of: ${VISIBILITIES.join(", ")}`);
  return raw as Visibility;
}

// One-line summary of a canvas's organize state, from a setmeta response
// (`▸ project   #tag …`). Shared by push + organize. "" when nothing set.
function fmtMeta(m: { project?: string | null; tags?: unknown }): string {
  return [
    m.project ? `▸ ${m.project}` : null,
    Array.isArray(m.tags) && m.tags.length ? (m.tags as string[]).map((t) => `#${t}`).join(" ") : null,
  ].filter(Boolean).join("   ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// A point anchor (opaque visual: image/screenshot) carries a fractional (fx,fy)
// inside the element. Turn it into a human region + percentages so you know
// *where* on the image the comment sits (e.g. `@ top-right (78%,22%)`).
function pointHint(a: any): string {
  if (typeof a.anchorFx !== "number" || typeof a.anchorFy !== "number") return "";
  const col = a.anchorFx < 0.34 ? "left" : a.anchorFx > 0.66 ? "right" : "center";
  const row = a.anchorFy < 0.34 ? "top" : a.anchorFy > 0.66 ? "bottom" : "middle";
  const region = row === "middle" && col === "center" ? "center" : `${row}-${col}`;
  return ` @ ${region} (${Math.round(a.anchorFx * 100)}%,${Math.round(a.anchorFy * 100)}%)`;
}

function anchorLabel(a: any): string {
  const grp = Array.isArray(a.anchors) ? a.anchors : null;
  if (grp && grp.length > 1) {
    const parts = grp.slice(0, 3).map((x: any) => `<${x.tag}> "${x.text}"`).join(" + ");
    const more = grp.length > 3 ? ` + ${grp.length - 3} more` : "";
    return `${grp.length} elements — ${parts}${more}`;
  }
  return `<${a.anchorTag}> "${a.anchorText}"${pointHint(a)}`;
}

function die(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}

// ── canvas refs: accept a slug, a long URL, a short link, or a host-relative path ─
// A command's <slug> arg gets pasted in whatever shape the human has on hand:
//   • bare slug:            launch-plan-9fk2q
//   • full canvas URL:      https://drafty.im/canvas/launch-plan-9fk2q?ref=cli
//   • short link:           https://drafty.im/l/drafty-feedback-ni5yd1   (302 → /canvas/<slug>)
//   • host-relative path:   /canvas/launch-plan-9fk2q  ·  /l/drafty-feedback-ni5yd1
// Long forms are pure string-parsing; only a short link needs a network hop — we
// follow its 302 ourselves so the agent never has to curl the redirect by hand.

// The <code> out of any /l/<code> shape (URL, host-relative, or bare l/<code>), else null.
// Codes are slug-shaped (e.g. drafty-feedback-ni5yd1), so hyphens are part of the code —
// the char class must include them or the code truncates at the first hyphen.
function shortlinkCode(input: string): string | null {
  const m = input.trim().match(/(?:^|\/)l\/([a-z0-9-]+)\b/i);
  return m ? m[1] : null;
}
// The canvas slug out of a bare token or a …/canvas/<slug> URL/path. null when the
// input is a short link (resolve it first) or an unrecognized URL shape.
function slugFromRef(input: string): string | null {
  const s = input.trim().replace(/^[<"'\s]+|[>"'\s]+$/g, ""); // strip wrapping <>, quotes
  if (!s || shortlinkCode(s)) return null;
  const m = s.match(/\/canvas\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  if (!s.includes("/")) return s.split(/[?#]/)[0]; // bare slug/id (may carry ?ref / #frag)
  return null; // a URL/path that isn't /canvas/<slug> — refuse to guess
}
// Resolve a /l/<code> short link to its canvas slug by following the 302 we'd
// otherwise hand the agent to curl. The bot-labeled UA keeps these resolutions
// out of the human shortlink-click counts (the redirect classifies by UA).
async function resolveShortlink(code: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/l/${encodeURIComponent(code)}`, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": `drafty-cli/${installedVersion() ?? "0"} (resolve; bot)` },
    });
  } catch (e: any) {
    return die(`couldn't resolve /l/${code}: ${String(e?.message || e)}`);
  }
  // Unknown/disabled codes 302 to the homepage (no /canvas/…) — treat as not-found.
  const slug = res.headers.get("location") ? slugFromRef(res.headers.get("location")!) : null;
  if (!slug) return die(`no canvas behind /l/${code} — the short link is unknown, disabled, or points somewhere other than a canvas`);
  return slug;
}
// Resolve any canvas ref to its slug. Pass-through for falsy / --flag inputs so a
// command's own usage-guard still fires; short links hit the network, the rest are pure.
async function resolveSlug(input: string | undefined): Promise<string> {
  if (!input || input.startsWith("--")) return input as string;
  const code = shortlinkCode(input);
  if (code) return resolveShortlink(code);
  const slug = slugFromRef(input);
  if (slug) return slug;
  return die(`couldn't read a canvas from "${input}" — paste a slug, a ${BASE_URL}/canvas/<slug> link, or a ${BASE_URL}/l/<code> short link`);
}

// ── transport ────────────────────────────────────────────────────────────────
// Restore this machine's account token — written by `drafty login`, stored as an
// opaque string under ~/.drafty and sent as a Bearer. Nothing is minted here: with
// no stored token we ask the human to sign in. No InstantDB client here.
async function getToken(): Promise<string> {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  // Plugin commands run on the human's REAL account — there is no anonymous guest
  // mode here (the no-install demo at <base>/get is the guest path). With no stored
  // token the human just needs to sign in; never silently mint a guest.
  const id = readIdentity();
  const who = id?.signedIn && id.email ? ` as ${id.email}` : "";
  throw new Error(`Not signed in — run \`drafty login\`${who} to use Drafty.  (The no-install demo lives at ${BASE_URL}/get.)`);
}

type ApiOpts = { method?: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string>; token?: string };
// Transient server hiccups — the legacy core-client's ~6s mutation-ack timeout,
// a cold function, the admin-path read raising "the query took too long to
// complete", or a 5xx — shouldn't surface to the user on their primary action.
// A timeout almost always means the write never committed, so a quiet retry is
// safe; on the rare commit-but-lost-response it just adds a duplicate revision
// (cosmetic in History). Bounded so a real outage still fails.
const RETRIABLE = /timed out|timeout|too long|ECONNRESET|ECONNREFUSED|fetch failed|network|socket hang up/i;
function isRetriable(status: number, msg: string): boolean {
  return status === 502 || status === 503 || status === 504 || RETRIABLE.test(msg);
}
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(op: string, opts: ApiOpts = {}): Promise<any> {
  // Most ops act as *you* (the stored identity). `claim` is the exception — it
  // must authorize with the canvas's provision token, so callers pass it in.
  const token = opts.token ?? (await getToken());
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const reqInit = {
    method: opts.method ?? "POST",
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  };
  const MAX = 3;
  let lastErr = `${op} failed`;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/get/api/${op}${qs}`, reqInit);
    } catch (e: any) {
      lastErr = String(e?.message || e);
      if (attempt < MAX && isRetriable(0, lastErr)) { await nap(300 * attempt); continue; }
      die(lastErr);
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return data;
    lastErr = data.error || `${op} failed (${res.status})`;
    if (attempt < MAX && isRetriable(res.status, lastErr)) { await nap(300 * attempt); continue; }
    die(lastErr);
  }
  die(lastErr); // unreachable — the loop always returns or dies
}

// ── asset pass ───────────────────────────────────────────────────────────────
// On push, local media refs (<img src>, <video>/<source src>, poster=, url(...))
// are uploaded to drafty's object store and rewritten to served URLs in the
// *published* content. The on-disk file is left untouched, so it stays small and
// Read/Edit-able for the agent instead of bloating with base64. Remote/data:/
// already-hosted refs are left alone. Bytes go straight to Blob via a presigned
// PUT URL the server mints (/get/api/asset-presign) — the CLI never holds the
// store token, and nothing (video included) is proxied through a function.
const ASSET_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "mp4", "webm", "mov"]);
const ASSET_CONTENT_TYPE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};

function refExt(ref: string): string {
  return (ref.split(/[?#]/)[0].split(".").pop() || "").toLowerCase();
}

function isLocalAssetRef(ref: string): boolean {
  if (!ref) return false;
  if (/^(https?:)?\/\//i.test(ref)) return false; // remote or protocol-relative
  if (/^data:/i.test(ref)) return false; // already inline
  if (ref.startsWith("#")) return false; // svg fragment / in-page anchor
  return ASSET_EXTS.has(refExt(ref));
}

async function uploadAssetBytes(bytes: Uint8Array, ext: string): Promise<string> {
  const token = await getToken();
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ct = ASSET_CONTENT_TYPE[ext] || "application/octet-stream";
  // 1) Ask the server where to put these bytes. It content-addresses by sha, so a
  //    re-push of unchanged media is a dedup hit (no upload); otherwise it mints a
  //    presigned PUT URL scoped to this exact pathname + content-type + size cap.
  const res = await fetch(`${BASE_URL}/get/api/asset-presign`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sha, ext, size: bytes.byteLength }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) die(data.error || `asset presign failed (${res.status})`);
  if (data.dedup) return data.url as string;
  // 2) Upload straight to Blob via the opaque presigned URL — just a dumb PUT with
  //    the content-type the token was signed for. No infra creds, no SDK.
  const put = await fetch(data.uploadUrl as string, {
    method: "PUT",
    headers: { "content-type": ct },
    body: bytes,
  });
  if (!put.ok) die(`asset upload failed (${put.status} ${put.statusText})`);
  const putData: any = await put.json().catch(() => ({}));
  return (putData.url as string) || (data.publicUrl as string);
}

// Upload every local media ref once, then rewrite only within matched src=/poster=
// / url(...) contexts so a filename can't accidentally match elsewhere. The src
// regex spans <img>, <video>, and <source> (a <video>'s <source src>); poster=
// covers a <video> thumbnail.
const MEDIA_SRC_RE = /<(?:img|video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const POSTER_RE = /\bposter\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
// Markdown image syntax: ![alt](url), ![alt](<url>), ![alt](url "title"). The three
// capture groups isolate the URL (g2) from its surrounding `![alt](` + optional `<`
// (g1) and the trailing `>`/title/`)` (g3) so only the URL is rewritten — the alt
// text is never touched even if it repeats the filename.
const MD_IMAGE_RE = /(!\[[^\]]*\]\(\s*<?)([^)>\s"']+)(>?[^)]*\))/g;

async function uploadLocalAssets(content: string, file: string): Promise<string> {
  const refs = new Set<string>();
  for (const re of [MEDIA_SRC_RE, POSTER_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) if (isLocalAssetRef(m[1].trim())) refs.add(m[1].trim());
  }
  MD_IMAGE_RE.lastIndex = 0;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = MD_IMAGE_RE.exec(content))) if (isLocalAssetRef(mdMatch[2].trim())) refs.add(mdMatch[2].trim());
  if (!refs.size) return content;

  const dir = dirname(resolve(file));
  const map = new Map<string, string>();
  for (const ref of refs) {
    const path = resolve(dir, ref.split(/[?#]/)[0]);
    if (!existsSync(path)) { console.error(`  ⚠ skipping missing asset: ${ref}`); continue; }
    const bytes = new Uint8Array(readFileSync(path));
    const url = await uploadAssetBytes(bytes, refExt(ref));
    map.set(ref, url);
    console.log(`  ⬆ ${ref}`);
  }
  if (!map.size) return content;

  const rewrite = (full: string, ref: string) =>
    map.has(ref.trim()) ? full.replace(ref, map.get(ref.trim())!) : full;
  return content
    .replace(MEDIA_SRC_RE, rewrite)
    .replace(POSTER_RE, rewrite)
    .replace(CSS_URL_RE, rewrite)
    .replace(MD_IMAGE_RE, (full, pre, ref, post) =>
      map.has(ref.trim()) ? `${pre}${map.get(ref.trim())}${post}` : full);
}

// ── local↔canvas manifest (agent-eyes S1) ───────────────────────────────────
// .drafty/manifest.json at the repo root (nearest .git above the pushed file;
// the file's own directory when not in a repo). Maps a root-relative file path
// → { slug, lastRev, lastRevisionId, lastPushedHash }, so:
//   • `push <file>` with no --slug updates the SAME canvas next time,
//   • push can send baseRev (the divergence guard: refuse to clobber a canvas
//     that moved under us — browser edit, restore, another agent),
//   • `revert`/`status` know which canvas a file binds to and what was synced.
// The directory ships its own `.gitignore` (`*`), so it never needs an entry in
// the user's — git ignores it natively.
type ManifestEntry = { slug: string; lastRev: number | null; lastRevisionId: string | null; lastPushedHash: string | null };

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function manifestRootFor(file: string): string {
  let dir = dirname(resolve(file));
  for (let d = dir; ; ) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return dir;
    d = up;
  }
}
function manifestFileFor(root: string): string {
  return join(root, ".drafty", "manifest.json");
}
function readManifest(root: string): Record<string, ManifestEntry> {
  try {
    const p = manifestFileFor(root);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch { return {}; }
}
function manifestKey(root: string, file: string): string {
  const abs = resolve(file);
  return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
}
function manifestLookup(file: string): { root: string; key: string; entry: ManifestEntry | null } {
  const root = manifestRootFor(file);
  const key = manifestKey(root, file);
  return { root, key, entry: readManifest(root)[key] ?? null };
}
function writeManifestEntry(file: string, entry: ManifestEntry): void {
  try {
    const root = manifestRootFor(file);
    const dir = join(root, ".drafty");
    mkdirSync(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const all = readManifest(root);
    all[manifestKey(root, file)] = entry;
    writeFileSync(manifestFileFor(root), JSON.stringify(all, null, 2) + "\n");
  } catch { /* the manifest is a convenience — never fail the command on it */ }
}

// ── commands ────────────────────────────────────────────────────────────────
async function canvasPush(args: string[]) {
  const file = args[0];
  if (!file) return die("usage: drafty canvas push <file> [--title T] [--description D] [--slug S] [--mode M] [--format html|markdown] [--project P] [--tag T …] [--refresh]");
  const content = readFileSync(file, "utf8");
  if (!content.trim()) return die(`file is empty: ${file}`);
  // --format html|markdown is an explicit override; otherwise sniff content+extension.
  const formatFlag = flag(args, "format");
  if (formatFlag !== undefined && formatFlag !== "html" && formatFlag !== "markdown")
    return die(`--format must be html or markdown (got "${formatFlag}")`);
  const format = (formatFlag as "html" | "markdown" | undefined) ?? inferFormat(file, content);
  const title = flag(args, "title") || inferTitle(content, format, file);
  // One-line summary of the artifact for the link unfurl (og:description). The
  // publishing agent writes this — it has the full content in context. The
  // server only overwrites the stored description when one is sent, so a bare
  // re-push keeps the existing unfurl text.
  const description = flag(args, "description");
  const mode = parseMode(flag(args, "mode"));
  const visibility = parseVisibility(args);
  // Slug: an explicit --slug wins; otherwise the manifest remembers which canvas
  // this file published to, so a bare re-push updates instead of forking a new
  // canvas under a fresh hash.
  const mf = manifestLookup(file);
  const slugFlag = flag(args, "slug");
  const slug = slugFlag ?? mf.entry?.slug;
  if (!slugFlag && mf.entry?.slug) console.error(`  ↪ updating ${mf.entry.slug} (from .drafty/manifest.json)`);
  // Organize flags, parsed up front so a bad value fails before anything publishes.
  const project = flag(args, "project");
  const tags = multiFlag(args, "tag");
  // --refresh marks this push as coming from a scheduled job (drafty-cron). The
  // server stamps the canvas as self-refreshing (arming a new one may be
  // plan-gated server-side); re-pushes to an armed canvas always pass.
  const refresh = has(args, "refresh");
  // Divergence guard (agent-eyes S3): send the rev counter we last synced so the
  // server refuses to clobber a canvas that moved (browser edit, restore,
  // another agent). --force skips it; refreshes and manifest-less pushes never
  // send one, so their behavior is unchanged.
  const force = has(args, "force");
  const baseRev = !force && !refresh && mf.entry && mf.entry.slug === slug && mf.entry.lastRev != null ? mf.entry.lastRev : undefined;
  // Upload local images → served URLs in the published copy; the file on disk is
  // left as-is (small + editable). Titles are inferred from the original content.
  const published = await uploadLocalAssets(content, file);
  // targetSlug = update intent (exact); newSlug = pre-hashed slug if we create.
  const r = await api("canvas.push", {
    body: { content: published, format, title, targetSlug: slug, newSlug: slugify(slug || title), ...(description ? { description } : {}), ...(mode ? { mode } : {}), ...(visibility ? { visibility } : {}), ...(refresh ? { refresh: true } : {}), ...(baseRev != null ? { baseRev } : {}) },
  });
  if (r.diverged) {
    const who = r.headAuthorKind === "human" ? `${r.headAuthor} (in the browser)` : r.headAuthor || "someone";
    const when = r.headAt ? ` ${relTime(r.headAt)}` : "";
    return die(
      `canvas moved since your last sync (rev ${r.baseRev} → ${r.rev}) — last write by ${who}${when}.\n` +
      `  pushing now would overwrite their changes. either:\n` +
      `    drafty canvas pull ${r.slug} -o ${file}   # take the canvas's version\n` +
      `    drafty canvas push ${file} --force        # overwrite it with yours`,
    );
  }
  // Record what we just synced: slug (bare re-push targets the same canvas),
  // rev/revisionId (the guard's base next time), and the local content hash
  // (status's local-ahead check). Servers predating rev/revisionId return
  // undefined — store nulls and the guard simply stays off.
  writeManifestEntry(file, {
    slug: r.slug,
    lastRev: r.rev ?? null,
    lastRevisionId: r.revisionId ?? mf.entry?.lastRevisionId ?? null,
    lastPushedHash: contentHash(content),
  });
  if (r.created) {
    console.log(`✓ published "${r.title}"  ·  ${modeLabel[r.mode as Mode]}`);
  } else {
    console.log(`✓ updated "${r.title}"`);
    if (mode) console.log(`  ${modeLine(mode, r.slug)}`);
  }
  if (visibility) console.log(`  visibility: ${visibilityLabel[visibility]}`);
  // Server-sent aside (e.g. the first self-refreshing canvas on the free plan).
  // Relay it verbatim — it's written for the human, not the log.
  if (r.notice) console.log(`  ${r.notice}`);
  // ?ref=cli marks the link as CLI-published.
  console.log(`  ${url(r.slug)}?ref=cli`);

  // Organize at publish time: any --project/--tag flags are applied in a single
  // setmeta call, so the agent files a canvas under its initiative + kind as it
  // ships, instead of leaving it loose. Tags are additive (re-pushing keeps
  // existing ones); project overwrites. A fresh canvas with no --project is
  // auto-filed under the cwd repo (the usual initiative) — explicit --project
  // wins, --no-project keeps it loose, updates are never re-filed.
  const autoProject = r.created && project === undefined && !has(args, "no-project") ? gitContext().repo ?? undefined : undefined;
  const effProject = project !== undefined ? project : autoProject;
  if (effProject !== undefined || tags.length) {
    const meta: Record<string, unknown> = { slug: r.slug };
    if (effProject !== undefined) meta.project = effProject;
    if (tags.length) meta.addTags = tags;
    const summary = fmtMeta(await api("canvas.set", { body: meta }));
    if (summary) console.log(`  ${summary}${autoProject !== undefined ? "  (project from git — --no-project to skip)" : ""}`);
  }

  // Tags stay the agent's call — one line so a fresh canvas isn't left kindless.
  if (r.created && !tags.length) {
    console.log(`  no kind tag yet — drafty canvas tag ${r.slug} <plan|research|design|…>`);
  }

  if (r.created && r.mode === "feedback") {
    console.log(`  Claude waits for your go — run \`drafty canvas mode ${r.slug} live\` to work comments live`);
  }
  // First canvas ever → the server seeded a starter thread. Walk them through
  // it: see the comment, have Claude answer it.
  if (r.welcomeSeeded) {
    console.log("");
    console.log("  ✦ your first canvas — a starter comment is waiting on it.");
    console.log("    1. open the link above and find the pinned comment");
    console.log("    2. back here, say: address the canvas comments");
    console.log("    3. watch the reply land on the page — that round-trip is the product");
  }
  await track("canvas.published", { slug: r.slug, created: !!r.created, format, mode: r.mode, ...(r.welcomeSeeded ? { welcome_seeded: true } : {}) });
}

async function commentsLs(args: string[]) {
  const slug = await resolveSlug(args[0]);
  if (!slug) return die("usage: drafty comments ls <slug> [--json] [--open]");
  const r = await api("comments.ls", { method: "GET", query: { slug } });
  let anns = r.annotations as any[];
  if (has(args, "open")) anns = anns.filter((a) => a.status !== "completed");
  if (has(args, "json")) {
    console.log(JSON.stringify({ slug, title: r.title, annotations: anns }, null, 2));
    return;
  }
  console.log(`# ${r.title} — ${url(slug)}`);
  console.log(`${anns.length} thread(s)\n`);
  for (const a of anns) {
    console.log(`[${a.status === "completed" ? "✓ done" : "● open"}] ${anchorLabel(a)}${a.stale === true ? "  ⚠ stale — feedback predates the current version" : ""}`);
    console.log(`  ann: ${a.id}`);
    if (a.viewportW) console.log(`  view: ${a.viewportW}px${a.canvasRevisionId ? ` @ rev ${String(a.canvasRevisionId).slice(0, 8)}` : ""} — see it: drafty shot ${slug} --annotation ${a.id}`);
    for (const c of a.comments) console.log(`  · ${c.authorName} (${c.authorKind}): ${c.body}`);
    console.log();
  }
}

async function commentsReply(args: string[]) {
  const [annId, ...rest] = args;
  const body = rest.join(" ").trim();
  if (!annId || !body) return die('usage: drafty comments reply <annotationId> "<message>"');
  await api("comments.reply", { body: { annotationId: annId, body } });
  console.log(`✓ replied to ${annId}`);
  await track("agent.replied", { annotationId: annId });
}

async function commentsWorking(args: string[]) {
  const annId = args[0];
  if (!annId) return die("usage: drafty comments working <annotationId>");
  await api("comments.working", { body: { annotationId: annId } });
  console.log(`✦ working on ${annId} (shimmering on the canvas)`);
  await track("agent.working", { annotationId: annId });
}

async function commentsStatus(args: string[], status: "open" | "completed") {
  const annId = args[0];
  if (!annId) return die(`usage: drafty ${status === "completed" ? "resolve" : "reopen"} <annotationId>`);
  await api(status === "completed" ? "comments.resolve" : "comments.reopen", { body: { annotationId: annId } });
  console.log(`✓ ${status === "completed" ? "resolved" : "reopened"} ${annId}`);
  await track(status === "completed" ? "thread.resolved" : "thread.reopened", { annotationId: annId, by: "agent" });
}

// Author a NEW thread on a canvas, as Claude — the create counterpart to reply.
// `--anchor "<text>"` pins it to the element whose text best matches (the server
// resolves by fuzzy match and hard-errors below a confidence floor, so a weak
// match never lands silently on the wrong element); `--at <fx>,<fy>` adds a point
// inside that element (0..1 — for pinning on a screenshot in a present board);
// `--canvas` makes it a canvas-level note with no anchor. Lets `present` stay a
// pure capture tool while analysis layers on as anchored comments that survive a
// --refresh (annotations are separate data, re-anchored on every re-push).
async function commentsCreate(args: string[]) {
  const VALUE_FLAGS = new Set(["anchor", "at"]);
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("--")) { if (VALUE_FLAGS.has(t.slice(2))) i++; continue; }
    positionals.push(t);
  }
  const slug = await resolveSlug(positionals[0]);
  const body = positionals.slice(1).join(" ").trim();
  const anchor = flag(args, "anchor");
  const canvas = has(args, "canvas");
  const at = flag(args, "at");
  const usage = 'usage: drafty comments create <slug> --anchor "<element text>" [--at <fx>,<fy>] "<message>"   (or --canvas for an unanchored note)';
  if (!slug || slug.startsWith("--") || !body) return die(usage);
  if (!canvas && !anchor) return die(`${usage}\n  pass --anchor "<text>" to pin to an element, or --canvas for a canvas-level note`);
  let fx: number | undefined, fy: number | undefined;
  if (at !== undefined) {
    const [a, b] = at.split(",").map((s) => Number(s.trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 1 || b < 0 || b > 1) return die("--at expects <fx>,<fy> as fractions 0..1 (e.g. --at 0.78,0.22)");
    if (canvas) return die("--at is a point inside an anchored element; it can't combine with --canvas");
    fx = a; fy = b;
  }
  const r = await api("comments.create", { body: { slug, body, ...(canvas ? { canvas: true } : { anchor }), ...(fx !== undefined ? { fx, fy } : {}) } });
  console.log(`✓ comment created on ${url(slug)}`);
  if (r.canvasLevel) console.log(`  canvas-level note (no anchor)`);
  else {
    const score = typeof r.matchScore === "number" && r.matchScore < 1 ? ` · ${Math.round(r.matchScore * 100)}% match` : "";
    const at2 = fx !== undefined ? ` @ (${Math.round(fx * 100)}%,${Math.round(fy! * 100)}%)` : "";
    const txt = r.anchorText ? ` "${String(r.anchorText).slice(0, 50)}"` : "";
    console.log(`  anchored to <${r.anchorTag}>${txt}${at2}${score}`);
  }
  console.log(`  thread ${r.annotationId} — reply: drafty comments reply ${r.annotationId} "..."   resolve: drafty comments resolve ${r.annotationId}`);
  await track("agent.comment_created", { slug, annotationId: r.annotationId, canvasLevel: !!r.canvasLevel });
}

async function canvasRestore(args: string[]) {
  const [rawSlug, revisionId] = args;
  const slug = await resolveSlug(rawSlug);
  if (!slug || !revisionId) return die("usage: drafty canvas restore <slug> <revisionId>");
  await api("canvas.restore", { body: { slug, revisionId } });
  console.log(`✓ restored ${slug} to revision ${revisionId}`);
  console.log(`  note: this restored the canvas only. if a local file tracks it, prefer \`drafty canvas revert <file>\` — it resyncs the file too.`);
}

// Atomic undo (agent-eyes S2): server restore + pull the restored body + rewrite
// the local file + update the manifest — one command, both sides in sync. The
// hand-revert footgun (restore is server-only, the next push silently re-
// introduces the reverted content) stops being possible to motivate.
async function canvasRevert(args: string[]) {
  const target = args[0];
  if (!target || target.startsWith("--")) return die("usage: drafty canvas revert <file|slug> [--to <revisionId>]");
  const isFile = existsSync(target);
  let slug: string;
  let file: string | null = null;
  if (isFile) {
    const mf = manifestLookup(target);
    if (!mf.entry?.slug) return die(`${target} has no manifest entry — push it once first (or revert by slug: drafty canvas revert <slug>)`);
    slug = mf.entry.slug;
    file = target;
  } else {
    slug = await resolveSlug(target);
  }
  let to = flag(args, "to");
  if (!to) {
    // Default = the previous revision: index 1 of the newest-first listing
    // (index 0 is the current head).
    const v = await api("canvas.versions", { method: "GET", query: { slug } });
    const prev = (v.revisions as any[])?.[1];
    if (!prev) return die(`${slug} has no previous revision to revert to`);
    to = prev.id;
  }
  const r = await api("canvas.restore", { body: { slug, revisionId: to } });
  const pulled = await api("canvas.pull", { method: "GET", query: { slug, revisionId: to as string } });
  if (file) {
    writeFileSync(file, pulled.content.endsWith("\n") ? pulled.content : pulled.content + "\n");
    writeManifestEntry(file, {
      slug,
      lastRev: r.rev ?? null,
      lastRevisionId: r.newRevisionId ?? null,
      lastPushedHash: contentHash(pulled.content.endsWith("\n") ? pulled.content : pulled.content + "\n"),
    });
    console.log(`✓ reverted ${slug} to revision ${to} — canvas AND ${file} now match`);
  } else {
    console.log(`✓ reverted ${slug} to revision ${to} (canvas only — no local file tracks this slug here)`);
  }
  console.log(`  ${url(slug)}`);
}

// Git-style sync report (agent-eyes S3): where the local file stands relative
// to the canvas. in-sync / local-ahead (edited since last push) / canvas-ahead
// (canvas moved: browser edit, restore, another agent) / diverged (both).
async function canvasStatus(args: string[]) {
  const file = args[0];
  if (!file || file.startsWith("--")) return die("usage: drafty canvas status <file>");
  if (!existsSync(file)) return die(`no such file: ${file}`);
  const mf = manifestLookup(file);
  if (!mf.entry?.slug) return die(`${file} has no manifest entry — it hasn't been pushed from here yet`);
  const entry = mf.entry;
  const content = readFileSync(file, "utf8");
  const localDirty = entry.lastPushedHash != null && contentHash(content) !== entry.lastPushedHash;
  const v = await api("canvas.versions", { method: "GET", query: { slug: entry.slug } });
  const canvasMoved = entry.lastRev != null && v.rev != null && v.rev !== entry.lastRev;
  const state = localDirty && canvasMoved ? "diverged" : localDirty ? "local-ahead" : canvasMoved ? "canvas-ahead" : "in-sync";
  console.log(`${file} ↔ ${entry.slug}: ${state}`);
  if (state === "local-ahead") console.log(`  the file changed since the last push — \`drafty canvas push ${file}\` to publish`);
  if (state === "canvas-ahead") {
    const head = (v.revisions as any[])?.[0];
    if (head) console.log(`  canvas moved (rev ${entry.lastRev} → ${v.rev}) — last write by ${head.authorName} ${relTime(head.createdAt)}`);
    console.log(`  \`drafty canvas pull ${entry.slug} -o ${file}\` to take it, or push --force to overwrite`);
  }
  if (state === "diverged") console.log(`  BOTH sides changed — pull to a scratch file and merge by hand, or push --force to overwrite the canvas`);
  if (has(args, "json")) console.log(JSON.stringify({ file, slug: entry.slug, state, lastRev: entry.lastRev, canvasRev: v.rev ?? null }));
}

// ── drafty shot (agent-eyes R4): render-to-image, the agent's eyes ──────────
// One command, three targets:
//   • a local .html file or any URL → headless Chrome on this machine
//   • a public canvas slug → the server render service (Firecrawl, cached on Blob)
//   • a private canvas slug → pull the content (token-bearing) and render it
//     locally, so private pixels never transit the crawler or public storage
// Prints the image path on stdout so an agent can immediately Read it.
function findChrome(): string | null {
  const cands = [
    process.env.DRAFTY_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

// Deterministic frames: jump finite CSS animations to their end state and
// disable transitions before shooting (matches the server's ?freeze=1).
// Injected over CDP after load, so it works for files and URLs alike.
const FREEZE_JS =
  '(() => { const s = document.createElement("style"); s.textContent = "*{animation-delay:-10000s!important;animation-play-state:paused!important;transition:none!important}"; (document.head || document.documentElement).appendChild(s); })()';

// ── CDP-driven local rendering ───────────────────────────────────────────────
// One persistent headless Chrome per process, driven over the DevTools
// Protocol. This replaces per-shot `--screenshot` launches, which had three
// structural problems: a cold Chrome start per image, no reliable settle
// timeout in headless=new (pages holding live sockets ran out their natural
// load — minutes), and a ~500px window floor that forced an iframe harness
// for phone widths. CDP gives us tabs (cheap, parallel), our own settle
// clock (load event OR a hard cap), and true viewport emulation at any width.
type CdpPending = { resolve: (v: any) => void; reject: (e: Error) => void };

class CdpBrowser {
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private sessionEvents = new Map<string, (method: string, params: any) => void>();
  // Plain fields + assignments (not constructor parameter properties — those
  // are non-erasable TS that Node's type stripping rejects).
  private proc: ChildProcess;
  private ws: WebSocket;
  private profile: string;
  private constructor(proc: ChildProcess, ws: WebSocket, profile: string) {
    this.proc = proc;
    this.ws = ws;
    this.profile = profile;
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      for (const [, pend] of this.pending) pend.reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
  }

  static async launch(): Promise<CdpBrowser> {
    const chrome = findChrome();
    if (!chrome) die("no Chrome/Chromium found for local rendering — set DRAFTY_CHROME to a browser binary");
    const profile = join(tmpdir(), `drafty-cdp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const proc = spawn(
      chrome,
      ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--disable-extensions", "--hide-scrollbars", "--mute-audio", `--user-data-dir=${profile}`, "about:blank"],
      { stdio: "ignore" },
    );
    // Chrome publishes its ephemeral DevTools port in the profile dir.
    const portFile = join(profile, "DevToolsActivePort");
    let port = 0;
    let path = "";
    for (let i = 0; i < 150 && !port; i++) {
      if (existsSync(portFile)) {
        const [portLine, wsPath] = readFileSync(portFile, "utf8").split("\n");
        if (Number(portLine) && wsPath) { port = Number(portLine); path = wsPath.trim(); }
      }
      if (!port) await new Promise((r) => setTimeout(r, 100));
    }
    if (!port) { try { proc.kill(); } catch { /* already gone */ } die("chrome did not expose a DevTools port"); }
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("could not connect to Chrome's DevTools socket"));
    });
    return new CdpBrowser(proc, ws, profile);
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null) {
      const pend = this.pending.get(msg.id);
      if (pend) {
        this.pending.delete(msg.id);
        if (msg.error) pend.reject(new Error(msg.error.message || "CDP error"));
        else pend.resolve(msg.result);
      }
      return;
    }
    if (msg.sessionId) this.sessionEvents.get(msg.sessionId)?.(msg.method, msg.params);
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
    });
  }

  // Render one page in its own tab: emulate the exact viewport, navigate, wait
  // for the load event OR the settle cap (whichever first — pages holding live
  // sockets never "finish"), give paint one beat, freeze animations, shoot.
  async shot(url: string, opts: { width: number; height: number; out: string; full?: boolean; format?: "png" | "webp" | "jpeg"; anchor?: { tag?: string; text?: string; fx: number; fy: number } }): Promise<void> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      let loaded!: () => void;
      let idle!: () => void;
      const loadP = new Promise<void>((r) => { loaded = r; });
      const idleP = new Promise<void>((r) => { idle = r; });
      this.sessionEvents.set(sessionId, (method, params) => {
        if (method === "Page.loadEventFired") loaded();
        // networkIdle = no in-flight requests for 500ms — the signal that an
        // SPA's after-load data fetching actually finished. (WebSockets don't
        // count, so live-socket pages still idle.)
        if (method === "Page.lifecycleEvent" && params?.name === "networkIdle") idle();
      });
      await this.send("Page.enable", {}, sessionId);
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      await this.send(
        "Emulation.setDeviceMetricsOverride",
        // mobile:false on purpose — we want the LITERAL layout width (matching the
        // artifact iframe these widths are calibrated against), not phone-browser
        // semantics where a meta-less page falls back to a 980px layout viewport.
        { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await this.send("Page.navigate", { url }, sessionId);
      // Settle in three stages, each there for a failure mode we've actually
      // shipped: (1) load + networkIdle, capped — SPA shells fire `load` before
      // their data, which put spinners on boards; (2) poll until the page has
      // PAINTED something (auth redirects go network-quiet while still blank);
      // (3) one paint beat.
      await Promise.race([Promise.all([loadP, idleP]), new Promise((r) => setTimeout(r, 12_000))]);
      await new Promise((r) => setTimeout(r, 400));
      if (!process.env.DRAFTY_NO_FREEZE) await this.send("Runtime.evaluate", { expression: FREEZE_JS }, sessionId).catch(() => { /* about:blank etc. */ });
      // Capturing below the fold (a full page, or an anchor crop that may sit
      // below it) needs lazy images forced eager or they ship as blanks.
      if (opts.full || opts.anchor) {
        await this.send(
          "Runtime.evaluate",
          { expression: "document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; })" },
          sessionId,
        ).catch(() => { /* no DOM */ });
        await new Promise((r) => setTimeout(r, 1_200));
      }
      let clip: Record<string, number> | undefined;
      if (opts.full) {
        const m = await this.send("Page.getLayoutMetrics", {}, sessionId);
        const contentH = Math.ceil(m.cssContentSize?.height ?? m.contentSize?.height ?? opts.height);
        clip = { x: 0, y: 0, width: opts.width, height: Math.min(20_000, Math.max(opts.height, contentH)), scale: 1 };
      }
      // Anchor crop: find the commented element, drop a marker at the exact
      // (fx,fy) point the user pinned, then tighten the clip to that
      // neighbourhood — so the agent sees precisely what the comment points at,
      // not the whole page. Falls back to the full render if it can't locate it.
      if (opts.anchor) {
        const a = opts.anchor;
        const expr =
          "(() => {" +
          "  const tag = " + JSON.stringify((a.tag || "").toLowerCase()) + ";" +
          "  const text = " + JSON.stringify((a.text || "").replace(/\s+/g, " ").trim()) + ";" +
          "  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();" +
          "  const cand = Array.from(document.querySelectorAll(tag || '*'));" +
          "  let el = cand.find(e => norm(e.getAttribute('alt')) === text || norm(e.textContent) === text);" +
          "  if (!el && text) el = cand.find(e => norm(e.getAttribute('alt')).includes(text) || norm(e.textContent).includes(text));" +
          "  if (!el) return null;" +
          "  const r = el.getBoundingClientRect();" +
          "  const left = r.left + window.scrollX, top = r.top + window.scrollY;" +
          "  const px = left + " + a.fx + " * r.width, py = top + " + a.fy + " * r.height;" +
          "  const m = document.createElement('div');" +
          "  m.style.cssText = 'position:absolute;left:'+(px-16)+'px;top:'+(py-16)+'px;width:32px;height:32px;border:3px solid #ff2d55;border-radius:9999px;box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 20px 5px rgba(255,45,85,.6);z-index:2147483647;pointer-events:none';" +
          "  document.documentElement.appendChild(m);" +
          "  return { px, py, left, top, w: r.width, h: r.height };" +
          "})()";
        const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId).catch(() => null);
        const v = res?.result?.value;
        if (v && typeof v.px === "number") {
          const cropW = Math.min(opts.width, Math.max(420, Math.round(v.w + 80)));
          const cropH = Math.min(1000, Math.max(380, Math.round(v.h + 200)));
          const cx = v.left + v.w / 2;
          clip = {
            x: Math.max(0, Math.round(cx - cropW / 2)),
            y: Math.max(0, Math.round(v.py - cropH / 2)),
            width: cropW,
            height: cropH,
            scale: 1,
          };
        }
      }
      // Stability gate: the only honest "has it painted?" signal is the pixels.
      // Recapture until two consecutive frames match byte-for-length and aren't
      // blank-tiny (a flat white frame compresses to almost nothing). Pages
      // that are GENUINELY minimal settle instantly; slow SPAs get up to ~9s of
      // extra patience; a truly blank page ships blank — the truth.
      const capture = async () =>
        this.send(
          "Page.captureScreenshot",
          { format: opts.format ?? "png", ...(opts.format && opts.format !== "png" ? { quality: 82 } : {}), ...(clip ? { clip, captureBeyondViewport: true } : {}) },
          sessionId,
        );
      let frame = await capture();
      for (let i = 0; i < 12; i++) {
        const blankish = frame.data.length < 12_000; // base64 length ≈ bytes × 4/3
        await new Promise((r) => setTimeout(r, blankish ? 700 : 350));
        const next = await capture();
        const stable = Math.abs(next.data.length - frame.data.length) / Math.max(next.data.length, frame.data.length) < 0.005;
        frame = next;
        if (stable && !blankish) break;
      }
      writeFileSync(opts.out, Buffer.from(frame.data, "base64"));
    } finally {
      this.sessionEvents.delete(sessionId);
      this.send("Target.closeTarget", { targetId }).catch(() => { /* tab already gone */ });
    }
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already gone */ }
    // Chrome may still be flushing the profile dir as it dies — retry briefly,
    // and never let temp-dir cleanup fail the command (the OS reaps /tmp).
    try { rmSync(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* best-effort */ }
  }
}

// Shared browser for the process: `shot` pays one launch; `present` reuses it
// across every screen. Killed on exit so no headless Chrome outlives the CLI.
let cdpLive: CdpBrowser | null = null;
let cdpLaunching: Promise<CdpBrowser> | null = null;
function cdpBrowser(): Promise<CdpBrowser> {
  if (!cdpLaunching) {
    cdpLaunching = CdpBrowser.launch().then((b) => { cdpLive = b; return b; });
    process.on("exit", () => cdpLive?.close());
  }
  return cdpLaunching;
}

async function localShot(target: string, opts: { width: number; height: number; out: string; full?: boolean; format?: "png" | "webp" | "jpeg"; anchor?: { tag?: string; text?: string; fx: number; fy: number } }): Promise<void> {
  const url = existsSync(target) ? "file://" + resolve(target) : target;
  const browser = await cdpBrowser();
  await browser.shot(url, opts);
  if (!existsSync(opts.out)) die("render failed: empty screenshot");
}

async function shot(args: string[]) {
  let target = args[0];
  if (!target || target.startsWith("--"))
    return die("usage: drafty shot <slug|file.html|url> [--width N] [--height N] [--revision R] [--annotation A] [--full] [-o out]");
  // A pasted drafty canvas link or /l/<code> short link → resolve to the bare slug
  // so it renders through the server path (private-aware, annotation highlight),
  // not as a live-page screenshot. Bare slugs, local files, and other URLs pass through.
  if (shortlinkCode(target) || /\/canvas\//i.test(target)) target = await resolveSlug(target);
  const widthFlag = flag(args, "width");
  const heightFlag = flag(args, "height");
  const full = has(args, "full");
  const annotationId = flag(args, "annotation");
  const revisionId = flag(args, "revision") ?? flag(args, "rev");
  const outIdx = args.indexOf("-o");
  let out = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? flag(args, "out");

  // Local file / arbitrary URL — no server involved. The see-before-push loop:
  // render the mockup you just wrote, look at it, then publish.
  if (existsSync(target) || /^https?:\/\//.test(target)) {
    const width = widthFlag ? Number(widthFlag) : 390;
    const height = heightFlag ? Number(heightFlag) : 844;
    out = out ?? join(tmpdir(), `drafty-shot-${Date.now()}-${width}.png`);
    await localShot(target, { width, height, out, full });
    console.log(out);
    return;
  }

  // Canvas slug → the render service (public canvases; rendered once per
  // (revision, width, crop), cached forever on Blob).
  const slug = target;
  const query: Record<string, string> = { slug };
  if (widthFlag) query.width = widthFlag;
  if (heightFlag) query.height = heightFlag;
  if (revisionId) query.revisionId = revisionId;
  if (annotationId) query.annotationId = annotationId;
  if (full) query.full = "1";
  const r = await api("canvas.render", { method: "GET", query });

  if (r.private) {
    // Private canvas: render the pulled content locally instead.
    console.error(`  ${slug} is ${r.visibility} — rendering locally from pulled content`);
    let annRevision = revisionId;
    let width = widthFlag ? Number(widthFlag) : 390;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ann: any;
    if (annotationId) {
      const ls = await api("comments.ls", { method: "GET", query: { slug } });
      ann = (ls.annotations as any[]).find((a) => a.id === annotationId);
      if (ann?.viewportW) width = Math.round(ann.viewportW);
      if (!annRevision && ann?.canvasRevisionId) annRevision = ann.canvasRevisionId;
    }
    const anchor =
      ann && typeof ann.anchorFx === "number" && typeof ann.anchorFy === "number"
        ? { tag: ann.anchorTag as string | undefined, text: ann.anchorText as string | undefined, fx: ann.anchorFx as number, fy: ann.anchorFy as number }
        : undefined;
    if (annotationId)
      console.error(
        anchor
          ? `  marking the pin at ${Math.round(anchor.fx * 100)}%,${Math.round(anchor.fy * 100)}% of "${anchor.text ?? anchor.tag}" and cropping to it`
          : "  note: this annotation has no point anchor to mark — rendering the full page",
      );
    const pulled = await api("canvas.pull", { method: "GET", query: { slug, ...(annRevision ? { revisionId: annRevision } : {}) } });
    if (pulled.format === "markdown")
      console.error("  note: markdown renders approximately here (plain text, not the canvas styling)");
    const body =
      pulled.format === "markdown"
        ? `<!doctype html><meta charset="utf-8"><body style="max-width:768px;margin:2rem auto;padding:0 1rem;font-family:ui-sans-serif,system-ui;line-height:1.6;white-space:pre-wrap">${pulled.content.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</body>`
        : pulled.content;
    const tmpHtml = join(tmpdir(), `drafty-shot-pull-${process.pid}.html`);
    writeFileSync(tmpHtml, body);
    out = out ?? join(tmpdir(), `drafty-shot-${slug}-${width}${annotationId ? `-${String(annotationId).slice(0, 8)}` : ""}.png`);
    await localShot(tmpHtml, { width, height: heightFlag ? Number(heightFlag) : 844, out, full, anchor });
    rmSync(tmpHtml, { force: true });
    console.log(out);
    return;
  }

  // Download the stored render so the agent can Read it from a local path.
  out = out ?? join(tmpdir(), `drafty-shot-${slug}-${r.width}${annotationId ? `-${String(annotationId).slice(0, 8)}` : ""}.jpg`);
  const res = await fetch(r.url);
  if (!res.ok) die(`fetching render failed: ${res.status}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.error(`  ${r.cached ? "cache hit" : "rendered"} · ${r.width}px${r.revisionId ? ` · revision ${r.revisionId}` : ""} · ${r.url}`);
  console.log(out);
  await track("canvas.shot", { slug, width: r.width, cached: !!r.cached, annotation: !!annotationId });
}

// ── drafty present (site boards) ─────────────────────────────────────────────
// `drafty present <url>` → a canvas of the site's main screens, annotatable.
// Pipeline: map → curate → shoot → compose → push. No crawling, no Firecrawl:
// discovery reads what sites already publish (robots.txt → sitemap.xml →
// homepage links), curation is heuristic (URL-template collapse, nav order,
// cap), shots are local headless Chrome, and the board pushes through the
// normal asset pipeline. Deterministic for a given site state — which is what
// makes the refresh recipe a one-liner (`--slug <board> --refresh` re-shoots
// the same screens as a tick).

const PRESENT_UA = "Mozilla/5.0 (compatible; drafty-present; +https://drafty.im)";
// Paths that are never "main screens": auth/account/commerce plumbing, API-ish, legal boilerplate.
const PRESENT_SKIP_PATH = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|logout|account|admin|cart|checkout|api|cdn-cgi|wp-admin|wp-json|legal|terms|privacy)(\/|$)/i;
// Asset/document extensions — not pages.
const PRESENT_SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|gz|xml|rss|atom|json|css|js|mjs|map|txt|mp4|webm|mp3|woff2?)$/i;
const PRESENT_SKIP_PAGINATION = /\/page\/\d+(\/|$)/i;

async function presentFetch(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": PRESENT_UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Normalize to origin + pathname (query/fragment dropped — they're almost never
// distinct "screens", and dropping them collapses utm/tracking variants).
function presentNorm(u: URL): string {
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return u.origin + path;
}

function presentKeep(u: URL, root: URL): boolean {
  if (u.origin !== root.origin) return false;
  if (PRESENT_SKIP_EXT.test(u.pathname)) return false;
  if (PRESENT_SKIP_PATH.test(u.pathname)) return false;
  if (PRESENT_SKIP_PAGINATION.test(u.pathname)) return false;
  return true;
}

// Discovery: robots.txt sitemaps (following one level of sitemap index), else
// /sitemap.xml, plus the homepage's own links — which double as the nav-order
// ranking signal (what the site promotes from its front door).
async function presentDiscover(root: URL): Promise<{ all: string[]; navOrder: string[] }> {
  const all = new Set<string>([presentNorm(root)]);
  const robots = await presentFetch(new URL("/robots.txt", root).href, 8000);
  let sitemaps = robots ? [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  if (!sitemaps.length) sitemaps = [new URL("/sitemap.xml", root).href];
  const queue = sitemaps.slice(0, 5);
  let fetched = 0;
  let pageUrls: string[] = [];
  while (queue.length && fetched < 8 && pageUrls.length < 2000) {
    const sm = queue.shift()!;
    fetched++;
    const xml = await presentFetch(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) queue.push(...locs.slice(0, 6));
    else pageUrls = pageUrls.concat(locs);
  }
  for (const raw of pageUrls) {
    try {
      const u = new URL(raw);
      if (presentKeep(u, root)) all.add(presentNorm(u));
    } catch { /* malformed loc */ }
  }
  const navOrder: string[] = [];
  const home = await presentFetch(root.href);
  if (home) {
    for (const m of home.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+?)["']/gi)) {
      try {
        const u = new URL(m[1], root);
        if (!presentKeep(u, root)) continue;
        const n = presentNorm(u);
        if (!navOrder.includes(n)) navOrder.push(n);
        all.add(n);
      } catch { /* relative junk */ }
    }
  }
  return { all: [...all], navOrder };
}

// Curation: pick the "main screens" without a model. Root first, then what the
// homepage links to (the site's own sense of what matters), then one exemplar
// per URL template — /recipes/[slug] is one screen, not three hundred. Depth-1
// pages never collapse (they ARE the nav); deeper siblings sharing a parent
// path collapse once the group has 3+ members.
function presentCurate(root: URL, all: string[], navOrder: string[], cap: number): string[] {
  const rootNorm = presentNorm(root);
  const depth = (s: string) => new URL(s).pathname.split("/").filter(Boolean).length;
  const parentKey = (s: string) => {
    const segs = new URL(s).pathname.split("/").filter(Boolean);
    return segs.length >= 2 ? segs.slice(0, -1).join("/") : null;
  };
  const groups = new Map<string, string[]>();
  for (const s of all) {
    const k = parentKey(s);
    if (k != null) groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const isTemplateMember = (s: string) => {
    const k = parentKey(s);
    return k != null && (groups.get(k)?.length ?? 0) >= 3;
  };
  const navRank = (s: string) => {
    const i = navOrder.indexOf(s);
    return i < 0 ? Infinity : i;
  };
  const chosen: string[] = [rootNorm];
  const seenGroups = new Set<string>();
  const take = (s: string) => {
    if (chosen.length >= cap || chosen.includes(s)) return;
    const k = parentKey(s);
    if (k != null && isTemplateMember(s)) {
      if (seenGroups.has(k)) return; // one exemplar per template
      seenGroups.add(k);
    }
    chosen.push(s);
  };
  // 1) homepage order — non-template pages first (real nav destinations)…
  for (const s of navOrder) if (!isTemplateMember(s)) take(s);
  // 2) …then template exemplars the homepage itself promotes (featured item).
  for (const s of navOrder) take(s);
  // 3) remaining non-template pages, shallow + short first.
  const rest = all.filter((s) => !chosen.includes(s)).sort((a, b) => depth(a) - depth(b) || a.length - b.length);
  for (const s of rest) if (!isTemplateMember(s)) take(s);
  // 4) remaining template exemplars (sections the homepage didn't link).
  for (const s of rest) take(s);
  return chosen.slice(0, cap);
}

function presentPrettyPath(s: string): string {
  const path = new URL(s).pathname;
  if (path === "/" || path === "") return "Home";
  const last = path.split("/").filter(Boolean).pop()!;
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function presentLabels(urls: string[]): Promise<string[]> {
  return Promise.all(
    urls.map(async (s) => {
      const html = await presentFetch(s, 8000);
      const m = html?.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (!m) return presentPrettyPath(s);
      let t = m[1]
        .replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
        .replace(/&quot;/g, '"').replace(/&#x2f;/gi, "/").replace(/&gt;/g, ">").replace(/&lt;/g, "<")
        .replace(/\s+/g, " ").trim();
      // Drop the "| Site Name" / "— Site Name" boilerplate tail.
      t = t.split(/\s+[|·—–-]\s+/)[0].trim() || t;
      return t.length > 64 ? t.slice(0, 63) + "…" : t || presentPrettyPath(s);
    }),
  );
}

type PresentScreen = { url: string; label: string };

// The board: self-contained HTML, point-anchor friendly (one plain <img> per
// shot), timestamp prominent, live URL quiet. The JSON meta block is what makes
// refresh deterministic — a re-run with --slug reads it back instead of
// re-discovering.
function presentBoardHtml(root: URL, screens: PresentScreen[], widths: number[], stamp: string, shotFile: (i: number, w: number) => string, dupNote: (i: number) => string | undefined = () => undefined): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const meta = JSON.stringify({ kind: "drafty-present", root: root.href, widths, screens }, null, 1);
  const sections = screens
    .map((sc, i) => {
      const path = new URL(sc.url).pathname || "/";
      const figs = widths
        .map(
          (w) =>
            // lazy + async + explicit dimensions: off-screen frames don't load
            // until scrolled to, and the layout never shifts while they do.
            `<figure><img src="${shotFile(i, w)}" alt="${esc(sc.label)} — ${w}px" width="${w}" height="${w < 500 ? 844 : 900}" loading="lazy" decoding="async" /><figcaption>${w}px</figcaption></figure>`,
        )
        .join("\n      ");
      return `  <section class="screen">
    <h2>${esc(sc.label)}</h2>
    <p class="meta"><a href="${esc(sc.url)}" rel="noopener">${esc(path)}</a> · captured ${stamp}${dupNote(i) ? ` · <em>⚠ ${esc(dupNote(i)!)}</em>` : ""}</p>
    <div class="pair">
      ${figs}
    </div>
  </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(root.host)} — site board</title>
<style>
  :root { --ink:#16181d; --muted:#5b6470; --line:#e3e6ea; --bg:#f6f7f9; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8eaee; --muted:#9aa3ad; --line:#2a2e35; --bg:#0b0c0f; --card:#15171c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:36px 18px; background:var(--bg); color:var(--ink);
         font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; line-height:1.5; }
  main { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 26px; letter-spacing: -0.02em; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 14px; margin: 0 0 26px; }
  .sub a { color: inherit; }
  .screen { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
            padding: 18px 20px; margin: 0 0 18px; }
  h2 { font-size: 17px; margin: 0 0 2px; }
  .meta { font-size: 12px; color: var(--muted); margin: 0 0 12px; font-family: ui-monospace, monospace; }
  .meta a { color: inherit; }
  .pair { display: grid; grid-template-columns: ${widths.length > 1 ? "2fr 1fr" : "1fr"}; gap: 14px; align-items: start; }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
  figure { margin: 0; }
  figure img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  figcaption { font-size: 11px; color: var(--muted); margin-top: 5px; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>${esc(root.host)} — site board</h1>
  <p class="sub">captured ${stamp} · ${screens.length} screen${screens.length === 1 ? "" : "s"} · <a href="${esc(root.href)}" rel="noopener">${esc(root.host)}</a></p>
${sections}
</main>
<script type="application/json" id="drafty-present-meta">${meta}</script>
</body>
</html>
`;
}

async function present(args: string[]) {
  const usage =
    "usage: drafty present <url> [--screens N] [--widths 1280,390] [--urls a,b,c] [--slug S] [--title T] [--visibility public|authed|invite] [--refresh] [--project P] [--tag T …] [--dry-run]";
  const slugFlag = flag(args, "slug");
  const refresh = has(args, "refresh");
  const dry = has(args, "dry-run");
  const cap = Math.max(1, Math.min(40, Number(flag(args, "screens") ?? 20)));
  let widths = (flag(args, "widths") ?? "1280,390").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (!widths.length) widths = [1280, 390];

  let rootStr = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  let screens: PresentScreen[] | null = null;

  // Refresh / re-run against an existing board: read the screen list back from
  // the board's own meta block, so the run is byte-deterministic with the
  // original (same URLs, same widths) — no re-discovery drift. An explicit
  // --urls beats the meta: that's how a board's screens get re-curated.
  if (slugFlag && !multiFlag(args, "urls").length) {
    try {
      const pulled = await api("canvas.pull", { method: "GET", query: { slug: slugFlag } });
      const m = String(pulled.content).match(/<script type="application\/json" id="drafty-present-meta">([\s\S]*?)<\/script>/);
      if (m) {
        const meta = JSON.parse(m[1]);
        if (meta?.kind === "drafty-present" && Array.isArray(meta.screens)) {
          screens = meta.screens;
          rootStr = rootStr ?? meta.root;
          if (!flag(args, "widths") && Array.isArray(meta.widths) && meta.widths.length) widths = meta.widths;
          console.error(`  ↻ re-shooting ${screens!.length} screens from the board's meta`);
        }
      }
    } catch { /* board doesn't exist yet — treat as a fresh run targeting that slug */ }
  }
  if (!rootStr) return die(usage);
  const root = new URL(/^https?:\/\//i.test(rootStr) ? rootStr : "https://" + rootStr);

  if (!screens) {
    const urlsFlag = multiFlag(args, "urls");
    let chosen: string[];
    if (urlsFlag.length) {
      chosen = urlsFlag.map((u) => presentNorm(new URL(/^https?:\/\//i.test(u) ? u : "https://" + u))).slice(0, cap);
    } else {
      console.error(`  ⌕ mapping ${root.host} (robots → sitemap → homepage links)…`);
      const { all, navOrder } = await presentDiscover(root);
      if (!all.length) return die(`found no pages at ${root.href}`);
      chosen = presentCurate(root, all, navOrder, cap);
      console.error(`  ⌕ ${all.length} pages found → ${chosen.length} screens curated`);
    }
    const labels = await presentLabels(chosen);
    // SPAs often serve one generic <title> for every route — disambiguate
    // duplicates with the path so screens stay tellable-apart.
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    screens = chosen.map((url, i) => ({
      url,
      label: (counts.get(labels[i]) ?? 0) > 1 ? `${labels[i]} · ${presentPrettyPath(url)}` : labels[i],
    }));
  }

  if (dry) {
    console.log(`# ${root.host} — ${screens.length} screen(s), widths ${widths.join("/")}`);
    screens.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.label}\n    ${s.url}`));
    return;
  }

  // Shoot every screen at every width (local Chrome — zero credits).
  const work = join(tmpdir(), `drafty-present-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(work, "screens"), { recursive: true });
  // WebP: page screenshots of photo-heavy sites are ~5x smaller than PNG,
  // which is what keeps a 16-image board from being laggy to scroll.
  const shotFile = (i: number, w: number) => `screens/${i}-${w}.webp`;
  // Pool of 4 concurrent tabs (one shared Chrome): wider pools made heavy SPAs
  // starve each other's rendering — frames went blank under contention.
  const jobs: Array<{ i: number; w: number }> = [];
  for (let i = 0; i < screens.length; i++) for (const w of widths) jobs.push({ i, w });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { i, w } = jobs[next++];
      console.error(`  ◉ ${screens![i].label} @ ${w}px`);
      await localShot(screens![i].url, { width: w, height: w < 500 ? 844 : 900, out: join(work, shotFile(i, w)), format: "webp" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  // Self-heal: concurrent heavy-SPA tabs can starve each other's compositor and
  // ship blank frames (verified: the same URLs render fine single-tab). A blank
  // WebP/PNG is tiny, so re-shoot the tiny ones serially in a calm browser.
  const blanks = jobs.filter(({ i, w }) => {
    try { return statSync(join(work, shotFile(i, w))).size < 12_000; } catch { return true; }
  });
  if (blanks.length) {
    console.error(`  ↻ ${blanks.length} frame${blanks.length > 1 ? "s" : ""} look blank — re-shooting serially`);
    for (const { i, w } of blanks) {
      console.error(`  ◉ ${screens![i].label} @ ${w}px (retry)`);
      await localShot(screens![i].url, { width: w, height: w < 500 ? 844 : 900, out: join(work, shotFile(i, w)), format: "webp" });
    }
  }

  // Auth-walled routes all render the same sign-in screen — flag clusters of
  // near-identical frames (byte-size proximity per width is a cheap, honest
  // proxy) so a board can't quietly show one wall five times.
  const dupNotes = new Map<number, string>();
  for (const w of widths) {
    const sized = screens.map((sc, i) => {
      try { return { i, size: statSync(join(work, shotFile(i, w))).size }; } catch { return { i, size: -1 }; }
    }).filter((x) => x.size > 0);
    for (let a = 0; a < sized.length; a++) {
      const cluster = sized.filter((b) => Math.abs(b.size - sized[a].size) / Math.max(b.size, sized[a].size) < 0.02);
      if (cluster.length >= 3 && !dupNotes.has(sized[a].i)) {
        for (const c of cluster) dupNotes.set(c.i, `renders nearly identically to ${cluster.length - 1} other screen${cluster.length > 2 ? "s" : ""} — possibly auth-walled`);
      }
    }
  }
  if (dupNotes.size) {
    const names = [...dupNotes.keys()].map((i) => screens[i].label).join(", ");
    console.error(`  ⚠ ${dupNotes.size} screens render nearly identically (login wall?): ${names}`);
    console.error(`    re-run with --urls to swap them for public pages, or leave them as the anonymous-visitor truth`);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const html = presentBoardHtml(root, screens, widths, stamp, shotFile, (i) => dupNotes.get(i));
  const boardFile = join(work, "board.html");
  writeFileSync(boardFile, html);

  console.error(`  ⬆ publishing board (${screens.length * widths.length} images)…`);
  const published = await uploadLocalAssets(html, boardFile);
  const title = flag(args, "title") ?? `${root.host} — site board`;
  const visibility = parseVisibility(args);
  const r = await api("canvas.push", {
    body: {
      content: published,
      format: "html",
      title,
      targetSlug: slugFlag,
      newSlug: slugify(slugFlag || title),
      ...(visibility ? { visibility } : {}),
      ...(refresh ? { refresh: true } : {}),
    },
  });
  // File it: explicit flags win; otherwise every board gets the site-board tag.
  const project = flag(args, "project");
  const tags = multiFlag(args, "tag");
  try {
    await api("canvas.set", { body: { slug: r.slug, ...(project !== undefined ? { project } : {}), addTags: tags.length ? tags : ["site-board"] } });
  } catch { /* organizing is best-effort */ }
  rmSync(work, { recursive: true, force: true });

  console.log(`✓ ${r.created ? "published" : r.tick ? "refreshed" : "updated"} "${r.title}" — ${screens.length} screens × ${widths.join("/")}px`);
  if (r.notice) console.log(`  ${r.notice}`);
  console.log(`  ${url(r.slug)}?ref=cli`);
  // Boards exist to be shared (clients, teammates) — surface the gate that the
  // private-by-default server applies, so "they can't open my board" is never
  // a surprise. --visibility public skips it at creation.
  if (r.created && !visibility)
    console.log(`  visibility: private to you — run \`drafty canvas visibility ${r.slug} public\` to share it`);
  if (r.created && !refresh)
    console.log(`  keep it fresh: drafty present --slug ${r.slug} --refresh   (re-shoots the same screens)`);
  await track("canvas.presented", { slug: r.slug, screens: screens.length, widths: widths.length, refresh, created: !!r.created });
}

// Download the artifact body. Content goes to stdout (newline-terminated) so it
// pipes/redirects cleanly; metadata goes to stderr. --revision pulls a past
// version (ids come from `drafty canvas versions`); -o/--out writes a file instead.
async function canvasPull(args: string[]) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) return die("usage: drafty canvas pull <slug> [--revision <id>] [-o <file>] [--json]");
  const revisionId = flag(args, "revision") || flag(args, "rev");
  const outIdx = args.indexOf("-o");
  const out = flag(args, "out") || (outIdx >= 0 ? args[outIdx + 1] : undefined);
  const r = await api("canvas.pull", { method: "GET", query: { slug, ...(revisionId ? { revisionId } : {}) } });
  // `state` is the canvas's owner-private window.drafty.persist data, folded into
  // every pull by the server so an agent reading a canvas always sees it without
  // a separate fetch — empty/absent for canvases that never called persist.set.
  const state = (r.state as Record<string, unknown> | undefined) || {};
  const hasState = Object.keys(state).length > 0;
  if (has(args, "json")) {
    console.log(JSON.stringify({ slug, title: r.title, format: r.format, revisionId: r.revisionId, createdAt: r.createdAt, content: r.content, state }, null, 2));
  } else {
    const ver = r.revisionId ? `revision ${r.revisionId}` : "current";
    console.error(`# ${r.title} — ${url(slug)}`);
    console.error(`  ${r.format} · ${ver}${r.createdAt ? ` · ${new Date(r.createdAt).toLocaleString()}` : ""}`);
    if (hasState) console.error(`  persisted state: ${JSON.stringify(state)}`);
    if (out) {
      writeFileSync(out, r.content);
      console.error(`✓ wrote ${out}`);
    } else {
      process.stdout.write(r.content);
      if (!r.content.endsWith("\n")) process.stdout.write("\n");
    }
  }
  await track("canvas.pulled", { slug, revision: r.revisionId || "current", out: out ? "file" : "stdout" });
}

async function canvasVersions(args: string[]) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) return die("usage: drafty canvas versions <slug> [--json]");
  const r = await api("canvas.versions", { method: "GET", query: { slug } });
  const revs = r.revisions as any[];
  if (has(args, "json")) {
    console.log(JSON.stringify({ slug, title: r.title, revisions: revs }, null, 2));
    return;
  }
  console.log(`# ${r.title} — ${url(slug)}`);
  console.log(`${revs.length} version(s) — newest first\n`);
  for (const v of revs) {
    console.log(v.id);
    console.log(`  ${new Date(v.createdAt).toLocaleString()} · ${v.authorName} (${v.authorKind})${v.note ? ` · ${v.note}` : ""}`);
    console.log(`  pull: drafty canvas pull ${slug} --revision ${v.id}\n`);
  }
}

async function canvasMode(args: string[]) {
  const slug = await resolveSlug(args[0]);
  const mode = parseMode(args[1]);
  if (!slug || !mode) return die(`usage: drafty canvas mode <slug> <${MODES.join("|")}>`);
  await api("canvas.mode", { body: { slug, mode } });
  console.log(`✓ ${slug} is ${modeLabel[mode]}`);
  console.log(`  ${modeLine(mode, slug)}`);
}

// Change who can view an existing canvas. `private` is sugar for `invite`.
async function canvasVisibility(args: string[]) {
  const slug = await resolveSlug(args[0]);
  const raw = args[1] === "private" ? "invite" : args[1];
  if (!slug || !raw) return die(`usage: drafty canvas visibility <slug> <${VISIBILITIES.join("|")}|private>`);
  if (!(VISIBILITIES as readonly string[]).includes(raw)) die(`visibility must be one of: ${VISIBILITIES.join(", ")} (or private)`);
  const vis = raw as Visibility;
  await api("canvas.visibility", { body: { slug, visibility: vis } });
  console.log(`✓ ${slug} — ${visibilityLabel[vis]}`);
}

// Archive/unarchive: a hide flag. Archived canvases keep their status but drop
// out of `drafty canvas ls` and are parked for the Claude loop — the link still works.
async function canvasArchive(args: string[], archived: boolean) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) return die(`usage: drafty canvas ${archived ? "archive" : "unarchive"} <slug>`);
  await api("canvas.set", { body: { slug, archived } });
  if (archived) console.log(`✓ archived ${slug} — hidden from \`drafty canvas ls\` (link still opens); show with --archived`);
  else console.log(`✓ unarchived ${slug} — back in \`drafty canvas ls\``);
}

// Close-out — the whole "this canvas's work landed" sequence as one command:
// stamp a Shipped receipt onto the body (markdown or HTML to match the
// canvas), reply + resolve every open thread with the landing commits, then
// archive — closing the canvas the way you'd close a tracking issue. Safe to
// re-run on a half-finished close: a receipt that already names every given
// commit isn't stamped twice, and resolved threads are skipped.
async function canvasClose(args: string[]) {
  const slug = await resolveSlug(args[0]);
  const commits = multiFlag(args, "commit");
  if (!slug || slug.startsWith("--") || !commits.length)
    return die('usage: drafty canvas close <slug> --commit <sha>[,<sha>…] [--note "<one line>"] [--repo <name>]');

  // Normalize against the cwd repo when possible: short shas in the receipt,
  // the repo name in parentheses, and the first commit's subject as the default
  // note. Outside a repo (or for refs it can't resolve) values pass through.
  const git = gitContext();
  const gitOut = (cmd: string[]): string | null => {
    if (!git.root) return null;
    try {
      const p = spawnSync("git", cmd, { cwd: git.root, stdio: ["ignore", "pipe", "ignore"] });
      return p.status === 0 ? p.stdout.toString().trim() || null : null;
    } catch { return null; }
  };
  const shas = commits.map((ref) => gitOut(["rev-parse", "--short=7", `${ref}^{commit}`]) ?? ref);
  const repo = flag(args, "repo") ?? git.repo ?? undefined;
  const note = flag(args, "note") ?? gitOut(["log", "-1", "--format=%s", shas[0]]) ?? undefined;

  const r = await api("canvas.pull", { method: "GET", query: { slug } });
  console.error(`# ${r.title} — ${url(slug)}`);

  // Receipt. Skipped when the body already carries a Shipped block naming every
  // given commit — re-running a ship must not stack duplicate footers.
  // Local date, not toISOString(): UTC rolls the day back for anyone east of it.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const stamped = r.content.includes("Shipped") && shas.every((s) => r.content.includes(s));
  if (stamped) {
    console.log(`  receipt already present — not stamping again`);
  } else {
    const tail = `${repo ? ` (${repo})` : ""}${note ? ` — ${note}` : ""}`;
    let content: string;
    if (r.format === "html") {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const receipt =
        `<section style="margin-top:48px;padding-top:14px;border-top:1px solid rgba(127,127,127,.35);` +
        `font:13px/1.6 system-ui,sans-serif;color:#888">✅ Shipped — ${today} · Landed in ` +
        `${shas.map((s) => `<code>${esc(s)}</code>`).join(", ")}${esc(tail)}.</section>`;
      const at = r.content.toLowerCase().lastIndexOf("</body>");
      content = at >= 0 ? `${r.content.slice(0, at)}${receipt}\n${r.content.slice(at)}` : `${r.content}\n${receipt}\n`;
    } else {
      const receipt = `\n---\n\n## ✅ Shipped — ${today}\n\nLanded in ${shas.map((s) => `\`${s}\``).join(", ")}${tail}.\n`;
      content = `${r.content.replace(/\n*$/, "\n")}${receipt}`;
    }
    await api("canvas.push", { body: { content, format: r.format, title: r.title, targetSlug: slug, newSlug: slug } });
    console.log(`✓ receipt stamped — Shipped ${today}, ${shas.join(", ")}${repo ? ` (${repo})` : ""}`);
  }

  // Close the loop for commenters: every still-open thread gets the landing
  // commit as a reply, then a resolve — closure, not silence.
  const open = ((await api("comments.ls", { method: "GET", query: { slug } })).annotations as any[]).filter((a) => a.status !== "completed");
  const replyBody = `Shipped in ${shas.join(", ")}${note ? ` — ${note}` : ""}`;
  for (const a of open) {
    await api("comments.reply", { body: { annotationId: a.id, body: replyBody } });
    await api("comments.resolve", { body: { annotationId: a.id } });
  }
  console.log(open.length ? `✓ closed ${open.length} open thread(s) — replied "${replyBody}" + resolved` : `  no open threads`);

  await api("canvas.set", { body: { slug, archived: true } });
  console.log(`✓ archived ${slug} — off your list; link + history kept`);
  console.log(`  ${url(slug)}`);
  await track("canvas.closed", { slug, commits: shas.length, threads_closed: open.length, receipt: stamped ? "existing" : "stamped" });
}

// Pin/unpin: a stick flag. Pinned canvases hold the "Pinned" lane on drafty.im/home
// (between Live and Recent) so a long-lived canvas never sinks into Recent as newer
// ones publish. Orthogonal to status/archive — it only affects list position.
async function canvasPin(args: string[], pinned: boolean) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) return die(`usage: drafty canvas ${pinned ? "pin" : "unpin"} <slug>`);
  await api("canvas.set", { body: { slug, pinned } });
  if (pinned) console.log(`✓ pinned ${slug} — held in the Pinned lane on your home, above Recent`);
  else console.log(`✓ unpinned ${slug} — back in Recent`);
}

// Cross-cutting labels for what a canvas *is* (plan, research, testing-report…).
// `tag` adds, `untag` removes (or --all clears). The server normalises + dedupes
// and returns the resulting set, which we echo back.
async function canvasTag(args: string[], add: boolean) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) {
    return die(add ? "usage: drafty canvas tag <slug> <label> [label…]" : "usage: drafty canvas untag <slug> <label> [label…]   (or --all)");
  }
  const labels = args.slice(1).filter((a) => !a.startsWith("--"));
  const body: Record<string, unknown> = { slug };
  if (!add && has(args, "all")) body.tags = []; // clear every tag
  else if (labels.length) body[add ? "addTags" : "removeTags"] = labels;
  else return die(add ? "give at least one label: drafty canvas tag <slug> <label> [label…]" : "give a label to remove, or --all to clear");
  const r = await api("canvas.set", { body });
  const tags = (r.tags as string[]) || [];
  console.log(`✓ ${slug} — ${tags.length ? tags.map((t) => `#${t}`).join(" ") : "(no tags)"}`);
}

// `canvas set` — the single organizer for an existing canvas, in one call and
// without re-publishing: --project P | --no-project, --tag T… (add), --untag T…
// (remove), --clear-tags. The primitive for filing one canvas or a whole tidy-up
// pass (`canvas ls --unfiled`).
async function canvasSet(args: string[]) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) {
    return die("usage: drafty canvas set <slug> [--project P | --no-project] [--tag T…] [--untag T…] [--clear-tags]");
  }
  const meta: Record<string, unknown> = { slug };
  if (has(args, "no-project")) meta.project = "";
  else { const p = flag(args, "project"); if (p !== undefined) meta.project = p; }
  if (has(args, "clear-tags")) meta.tags = [];
  else {
    const add = multiFlag(args, "tag"); if (add.length) meta.addTags = add;
    const rm = multiFlag(args, "untag"); if (rm.length) meta.removeTags = rm;
  }
  if (Object.keys(meta).length === 1) return die("nothing to set — pass --project/--no-project, --tag, --untag, and/or --clear-tags");
  const summary = fmtMeta(await api("canvas.set", { body: meta }));
  console.log(`✓ ${slug}${summary ? " — " + summary : " — cleared"}`);
}

async function commentsInbox(args: string[]) {
  const slug = await resolveSlug(args.find((a) => !a.startsWith("--")));
  const scope = has(args, "all") ? "all" : "live";
  const query: Record<string, string> = { scope };
  if (slug) query.slug = slug;
  const r = await api("comments.inbox", { method: "GET", query });
  const items = r.items as any[];
  if (has(args, "json")) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) console.log("no fresh comments to work on");
  for (const it of items) {
    console.log(`• ${it.slug} — ${anchorLabel(it)}${it.stale === true ? "  ⚠ stale — feedback predates the current version" : ""}`);
    console.log(`  ${it.lastAuthor}: ${it.lastComment}`);
    if (it.viewportW) console.log(`  view: ${it.viewportW}px — see it: drafty shot ${it.slug} --annotation ${it.annotationId}`);
    console.log(`  ann: ${it.annotationId}\n`);
  }
  if (!slug && !has(args, "all") && r.parked) {
    console.log(`${r.parked} canvas${r.parked > 1 ? "es are" : " is"} collecting feedback — not shown. add --all to include.`);
  }
}

// Shared SSE doorbell loop for `comments watch` and `inbox watch`: --for
// self-bounding, SIGINT, and reconnect-with-backoff around the single
// /get/api/comments.watch stream; the caller picks which events it prints.
//
// --for/--timeout: self-bound the stream so callers (esp. agents) never need an
// external `timeout`. On the deadline we exit 0 cleanly — a bounded watch is a
// success, not a failure (the old "wrap it in `timeout`" path died with 127 on
// macOS, which has no `timeout`). The SSE loop keeps the process alive, so the
// timer reliably fires; unref'd so it can never itself hold exit open.
async function watchLoop(slug: string, args: string[], asJson: boolean, onEv: (ev: any) => void, live = false) {
  const token = await getToken();
  const forRaw = flag(args, "for") ?? flag(args, "timeout");
  if (forRaw !== undefined) {
    const ms = parseDurationMs(forRaw);
    if (ms === null || ms <= 0) return die(`--for: couldn't read duration "${forRaw}" — try 20m, 90s, 1h, or a plain number of seconds`);
    const t = setTimeout(() => {
      if (!asJson) console.error(`\n⏲ watch window (${forRaw}) elapsed — exiting cleanly. Re-run to keep listening.`);
      process.exit(0);
    }, ms);
    if (typeof t.unref === "function") t.unref();
    if (!asJson) console.error(`   (auto-exits after ${forRaw} — no external \`timeout\` needed)`);
  }

  let stop = false;
  process.on("SIGINT", () => { stop = true; process.exit(0); });

  // SSE connections don't live forever — a serverless host (Vercel) caps a
  // function's duration, so the stream WILL drop periodically. Reconnect so the
  // doorbell stays armed for the whole session. Events that land during the
  // brief reconnect gap are caught by the next inbox reconcile (the doorbell
  // wakes you; inbox is the source of truth). Only the first connect honours
  // --backlog; reconnects start fresh so old events aren't replayed.
  let attempt = 0;
  while (!stop) {
    // --live streams comments for ALL the creator's live canvases over one
    // connection: send scope=live in lieu of a slug (the server resolves the
    // creator from the auth token and multiplexes; each event carries its slug).
    const qs = new URLSearchParams({ ...(live ? { scope: "live" } : { slug }), ...(has(args, "backlog") && attempt === 0 ? { backlog: "1" } : {}) });
    try {
      const res = await fetch(`${BASE_URL}/get/api/comments.watch?${qs}`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`watch failed (${res.status})`);
      attempt = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break; // stream closed (host duration cap or network) → reconnect
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue; // keepalive (": ...") or non-data frame
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          let ev: any;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.ev === "error") { console.error("watch error:", ev.message); continue; }
          onEv(ev);
        }
      }
    } catch (e: any) {
      if (!asJson) console.error(`watch: ${e?.message ?? e}`);
    }
    if (stop) break;
    const delay = Math.min(1000 * 2 ** attempt++, 10000); // backoff, capped 10s
    if (!asJson) console.error(`… stream closed (host duration cap or network); reconnecting in ${delay}ms — the doorbell stays armed`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function commentsWatch(args: string[]) {
  const asJson = has(args, "json");
  const live = has(args, "live");
  const slugArg = args[0] && !args[0].startsWith("--") ? args[0] : undefined;

  // --live and a <slug> are mutually exclusive: --live streams comments from
  // EVERY canvas the creator has live (scope=live in lieu of a slug), each event
  // tagged with its own slug. A slug watch stays exactly as before.
  if (live && slugArg) return die("comments watch: pass a <slug> OR --live, not both — --live streams every one of your live canvases over one connection");

  if (live) {
    // scope=live has no guest mode: the server scopes to the creator behind the
    // auth token, so a signed-out watch can't be resolved. Fail fast + specific.
    try { await getToken(); }
    catch { return die("comments watch --live needs a signed-in creator — scope=live streams your own live canvases (no guest mode). Run `drafty login` first."); }
    if (!asJson) console.error(`👀 watching every canvas you have live — new comments appear here, each tagged with its canvas slug\n`);
    await watchLoop("", args, asJson, (ev) => {
      if (ev.ev !== "comment") return;
      if (asJson) {
        console.log(JSON.stringify({ slug: ev.slug ?? null, annotationId: ev.annotationId, anchorTag: ev.anchorTag, anchorText: ev.anchorText, anchors: ev.anchors ?? null, anchorFx: ev.anchorFx ?? null, anchorFy: ev.anchorFy ?? null, status: ev.status, author: ev.author, body: ev.body, createdAt: ev.createdAt }));
      } else {
        console.log(`[${shortTime(ev.createdAt)}] [${ev.slug ?? "?"}] ${ev.author} on ${anchorLabel(ev)}`);
        console.log(`  ${ev.body}`);
        console.log(`  ↳ reply: drafty comments reply ${ev.annotationId} "..."   resolve: drafty comments resolve ${ev.annotationId}\n`);
      }
    }, true);
    return;
  }

  const slug = await resolveSlug(args[0]);
  if (!slug) return die("usage: drafty comments watch <slug> [--json] [--backlog] [--for DURATION]");
  if (!asJson) console.error(`👀 watching ${url(slug)} — new comments will appear here\n`);
  await watchLoop(slug, args, asJson, (ev) => {
    if (ev.ev !== "comment") return;
    if (asJson) {
      console.log(JSON.stringify({ annotationId: ev.annotationId, anchorTag: ev.anchorTag, anchorText: ev.anchorText, anchors: ev.anchors ?? null, anchorFx: ev.anchorFx ?? null, anchorFy: ev.anchorFy ?? null, status: ev.status, author: ev.author, body: ev.body, createdAt: ev.createdAt }));
    } else {
      console.log(`[${shortTime(ev.createdAt)}] ${ev.author} on ${anchorLabel(ev)}`);
      console.log(`  ${ev.body}`);
      console.log(`  ↳ reply: drafty comments reply ${ev.annotationId} "..."   resolve: drafty comments resolve ${ev.annotationId}\n`);
    }
  });
}

// ── the capture inbox — screenshot → agent fixes → proof ─────────────────────
// The account's single inbox canvas: slug-less captures from the iOS/Mac apps
// land there as `todo` entries (the board renders Todo/Doing/Review/Done). The
// agent loop: `inbox watch` (doorbell) → `inbox ls --status todo` → `claim` →
// `classify` (on pickup, with the screenshot in view) → fix → `review --pr …
// --proof …` (the agent's terminal action). `done` is the human's approval;
// items stay on the board as the ledger, receipts attached.
async function inboxLs(args: string[]) {
  const query: Record<string, string> = {};
  const status = flag(args, "status");
  if (status) query.status = status;
  const project = flag(args, "project");
  if (project) query.project = project;
  const r = await api("inbox.ls", { method: "GET", query });
  if (has(args, "json")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!r.slug) {
    console.log("no inbox yet — share a capture from the Drafty iOS or Mac app and it appears here");
    return;
  }
  const items = (r.items as any[]) || [];
  console.log(`# Inbox — ${r.url}`);
  if (!items.length) {
    console.log(status || project ? "no matching items" : "inbox is empty");
    return;
  }
  for (const it of items) {
    const tagStr = Array.isArray(it.tags) && it.tags.length ? `  #${it.tags.join(" #")}` : "";
    console.log(`• [${it.status}] ${it.summary || it.text || "(capture, unclassified)"}${it.project ? `  (${it.project})` : ""}${tagStr}`);
    if (it.mediaUrl) console.log(`  media: ${it.mediaUrl}`);
    if (it.status === "doing" && it.claimedBy) console.log(`  claimed by ${it.claimedBy}`);
    if (it.status === "done" || it.status === "review") {
      const receipts = [it.proofSlug ? `proof: ${BASE_URL}/canvas/${it.proofSlug}` : "", it.fixRef ? `pr: ${it.fixRef}` : ""].filter(Boolean).join("  ");
      if (receipts) console.log(`  ${receipts}`);
    }
    console.log(`  id: ${it.entryId}\n`);
  }
}

async function inboxClaim(args: string[]) {
  const entryId = args.find((a) => !a.startsWith("--"));
  if (!entryId) return die("usage: drafty inbox claim <entryId> [--agent name]");
  const body: Record<string, unknown> = { entryId };
  const agent = flag(args, "agent");
  if (agent) body.agent = agent;
  const r = await api("inbox.claim", { body });
  console.log(`✓ claimed → doing  (${r.entryId})`);
  console.log(`  classify it while the capture is in view: drafty inbox classify ${r.entryId} --project P --tag T --summary "…"`);
}

async function inboxClassify(args: string[]) {
  const entryId = args.find((a) => !a.startsWith("--"));
  if (!entryId) return die('usage: drafty inbox classify <entryId> [--project P] [--tag T …] [--summary "…"]');
  const body: Record<string, unknown> = { entryId };
  const project = flag(args, "project");
  if (project) body.project = project;
  const tags = multiFlag(args, "tag");
  if (tags.length) body.tags = tags;
  const summary = flag(args, "summary");
  if (summary) body.summary = summary;
  if (!(project || tags.length || summary)) return die("classify needs at least one of --project / --tag / --summary");
  const r = await api("inbox.classify", { body });
  console.log(`✓ classified  (${r.entryId})`);
}

async function inboxDone(args: string[]) {
  const entryId = args.find((a) => !a.startsWith("--"));
  if (!entryId) return die("usage: drafty inbox done <entryId> [--pr URL] [--proof slug]");
  const body: Record<string, unknown> = { entryId };
  const pr = flag(args, "pr");
  if (pr) body.fixRef = pr;
  const proof = flag(args, "proof");
  if (proof) body.proofSlug = proof;
  const r = await api("inbox.done", { body });
  console.log(`✓ done  (${r.entryId})${pr || proof ? " — receipts attached" : ""}`);
}

async function inboxReview(args: string[]) {
  const entryId = args.find((a) => !a.startsWith("--"));
  if (!entryId) return die("usage: drafty inbox review <entryId> [--pr URL] [--proof slug]");
  const body: Record<string, unknown> = { entryId };
  const pr = flag(args, "pr");
  if (pr) body.fixRef = pr;
  const proof = flag(args, "proof");
  if (proof) body.proofSlug = proof;
  const r = await api("inbox.review", { body });
  console.log(`✓ ready for review  (${r.entryId})${pr || proof ? " — receipts attached" : ""}`);
}

async function inboxReopen(args: string[]) {
  const entryId = args.find((a) => !a.startsWith("--"));
  if (!entryId) return die("usage: drafty inbox reopen <entryId>");
  const r = await api("inbox.reopen", { body: { entryId } });
  console.log(`✓ reopened → todo  (${r.entryId})`);
}

async function inboxWatch(args: string[]) {
  // The inbox doorbell: same SSE stream as comments watch, filtered to `entry`
  // events (new captures). Resolve the inbox slug first; no inbox yet = nothing
  // to watch (it's created by the first capture).
  const r = await api("inbox.ls", { method: "GET", query: {} });
  const slug = r.slug as string | null;
  if (!slug) return die("no inbox yet — share a capture from the Drafty iOS or Mac app first");
  const asJson = has(args, "json");
  if (!asJson) console.error(`👀 watching your inbox (${url(slug)}) — new captures will appear here\n`);
  await watchLoop(slug, args, asJson, (ev) => {
    if (ev.ev !== "entry") return;
    if (asJson) {
      console.log(JSON.stringify({ entryId: ev.entryId, kind: ev.kind, text: ev.text ?? null, mediaUrl: ev.mediaUrl ?? null, mediaType: ev.mediaType ?? null, status: ev.status ?? null, project: ev.project ?? null, createdAt: ev.createdAt }));
    } else {
      console.log(`[${shortTime(ev.createdAt)}] new capture${ev.text ? `: ${ev.text}` : ""}`);
      if (ev.mediaUrl) console.log(`  media: ${ev.mediaUrl}`);
      console.log(`  ↳ claim it: drafty inbox claim ${ev.entryId}\n`);
    }
  });
}

// ── canvas management (owner-scoped via perms) ───────────────────────────────
function requireYes(args: string[], what: string) {
  if (!has(args, "yes")) die(`${what} is destructive — re-run with --yes to confirm.`);
}

async function canvasRename(args: string[]) {
  const slug = await resolveSlug(args[0]);
  const title = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!slug || !title) return die('usage: drafty canvas rename <slug> "<new name>"');
  await api("canvas.rename", { body: { slug, title } });
  console.log(`✓ renamed to "${title}"`);
}

// ── shortlinks ───────────────────────────────────────────────────────────────
// drafty.im/l/<code> redirect links with utm/ref attribution stored behind the
// code — one short link instead of a hand-built query string. Targets are a
// canvas slug or a same-origin /path; the server refuses external URLs.
async function linkCreate(args: string[]) {
  const target = args[0];
  if (!target || target.startsWith("--"))
    return die("usage: drafty link create <slug|/path> [--code C] [--source S] [--medium M] [--campaign C] [--content C] [--ref R]");
  const body: Record<string, unknown> = target.startsWith("/") ? { path: target } : { slug: target };
  for (const k of ["code", "source", "medium", "campaign", "content", "ref"]) {
    const v = flag(args, k);
    if (v) body[k] = v;
  }
  const r = await api("link.create", { body });
  await track("cli.link.created", { code: r.code, reused: !!r.reused });
  console.log(r.url + (r.reused ? "   (existing link reused)" : ""));
}

async function linkLs(args: string[]) {
  const r = await api("link.ls", { method: "GET" });
  const links = (r.links ?? []) as Record<string, unknown>[];
  if (has(args, "json")) return console.log(JSON.stringify(links, null, 2));
  if (!links.length) return console.log("no shortlinks yet — drafty link create <slug>");
  for (const l of links) {
    const target = l.slug ? `/canvas/${l.slug}` : String(l.path ?? "");
    const utm = ["source", "medium", "campaign", "content"]
      .map((k) => (l[k] ? `${k}=${l[k]}` : null))
      .filter(Boolean)
      .join(" ");
    console.log(`${l.url}  →  ${target}${utm ? `   [${utm}]` : ""}${l.disabled ? "   (disabled)" : ""}`);
  }
}

async function linkRm(args: string[]) {
  const code = args[0];
  if (!code || code.startsWith("--")) return die("usage: drafty link rm <code>");
  await api("link.rm", { body: { code } });
  console.log(`✓ removed /l/${code}`);
}

// Resolve any drafty link to the canvas behind it — a slug, a /canvas/<slug>
// URL, or a /l/<code> short link. The point: paste a short link and get the
// canvas without curling the redirect. Slug on stdout (so it pipes:
// `drafty canvas pull "$(drafty resolve <link>)"`), the full URL on stderr.
async function resolveCmd(args: string[]) {
  const input = args[0];
  if (!input || input.startsWith("--"))
    return die("usage: drafty resolve <slug|canvas-url|short-link>   — print the canvas behind any drafty link");
  const slug = await resolveSlug(input);
  if (has(args, "json")) { console.log(JSON.stringify({ slug, url: url(slug) })); return; }
  console.error(`# ${url(slug)}`);
  console.log(slug);
}

async function commentsRmReply(args: string[]) {
  const commentId = args[0];
  if (!commentId) return die("usage: drafty comments rm-reply <commentId>");
  await api("comments.rm-reply", { body: { commentId } });
  console.log(`✓ deleted comment ${commentId}`);
}

async function commentsRm(args: string[]) {
  const annId = args[0];
  if (!annId) return die("usage: drafty comments rm <annotationId>");
  const r = await api("comments.rm", { body: { annotationId: annId } });
  console.log(`✓ deleted thread ${annId} (+${r.comments ?? 0} comments)`);
}

async function commentsClear(args: string[]) {
  const slug = await resolveSlug(args.find((a) => !a.startsWith("--")));
  if (!slug) return die("usage: drafty comments clear <slug> --yes");
  requireYes(args, `clearing all threads on ${slug}`);
  const r = await api("comments.clear", { body: { slug } });
  console.log(`✓ cleared ${r.threads ?? 0} thread(s) on ${slug}`);
}

async function canvasRm(args: string[]) {
  const slug = await resolveSlug(args.find((a) => !a.startsWith("--")));
  if (!slug) return die("usage: drafty canvas rm <slug> --yes");
  requireYes(args, `removing canvas ${slug}`);
  await api("canvas.rm", { body: { slug } });
  console.log(`✓ removed canvas ${slug}`);
}

// Print canvases grouped by project (named projects alphabetical, ungrouped
// last), each row showing slug · title · tags · open count · when, newest first.
// Shared by `canvases` and `context` so a canvas always renders the same way.
// One flat list, newest first — the same order as the web home (Recents) and
// `drafty context`, so the three surfaces never disagree on ordering. Project is
// shown inline per row (no grouping) so a single recency scan stays intact.
function printCanvasList(items: any[]) {
  const rows = [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const d of rows) {
    const tags = Array.isArray(d.tags) && d.tags.length ? "  " + d.tags.map((t: string) => `#${t}`).join(" ") : "";
    const proj = d.project ? ` · ${d.project}` : "";
    const open = d.open ? ` · ${d.open} open` : "";
    const upd = d.updatedAt ? ` · ${relTime(d.updatedAt)}` : "";
    const arch = d.archived ? " · archived" : "";
    console.log(`  ${d.slug}  ${d.title}${tags}${proj}${open}${upd}${arch}`);
  }
}

// List your canvases, newest first (flat — same order as the web home and
// `drafty context`). Archived canvases are hidden unless --archived. Filter with
// --project "<name>", --tag, or --unfiled. --json emits the (filtered) rows.
async function canvasLs(args: string[] = []) {
  const r = await api("canvas.ls", { method: "GET" });
  let items = r.items as any[];

  // Scope: active by default, --archived = just the shelf, --all = everything.
  // (--archived used to mean "include archived too", which forced callers to
  // diff two lists by hand to see what's actually shelved.)
  if (has(args, "archived")) items = items.filter((d) => d.archived);
  else if (!has(args, "all")) items = items.filter((d) => !d.archived);
  const projectFilter = flag(args, "project");
  if (projectFilter !== undefined) items = items.filter((d) => (d.project || "") === projectFilter);
  const tagFilter = flag(args, "tag");
  if (tagFilter !== undefined) {
    const want = tagFilter.replace(/^#+/, "").toLowerCase();
    items = items.filter((d) => Array.isArray(d.tags) && d.tags.includes(want));
  }
  // Unfiled = not fully organized: missing a project OR has no tags. The work-list
  // for a tidy-up pass (`drafty canvas set <slug> …`).
  const unfiled = has(args, "unfiled");
  if (unfiled) items = items.filter((d) => !d.project || !(Array.isArray(d.tags) && d.tags.length));

  if (has(args, "json")) { console.log(JSON.stringify(items, null, 2)); return; }

  if (!items.length) {
    console.log(unfiled ? "✓ every canvas has a project and tags — nothing to file" : projectFilter ? "(no canvases match that filter)" : "(no canvases yet — publish one with `drafty canvas push <file>`)");
    return;
  }
  printCanvasList(items);
  console.log(`\nNewest first. To update a canvas, push its exact slug; a push without it creates a new one.`);
}

// Show one canvas's metadata — title, link, project, tags, mode, thread counts.
// Composed from your `canvas ls` data (your own canvases only).
async function canvasShow(args: string[]) {
  const slug = await resolveSlug(args[0]);
  if (!slug || slug.startsWith("--")) return die("usage: drafty canvas show <slug>");
  const r = await api("canvas.ls", { method: "GET" });
  const d = (r.items as any[]).find((x) => x.slug === slug);
  if (!d) return die(`no canvas "${slug}" under your account — try \`drafty canvas ls\``);
  if (has(args, "json")) { console.log(JSON.stringify(d, null, 2)); return; }
  const tags = Array.isArray(d.tags) && d.tags.length ? "   " + d.tags.map((t: string) => `#${t}`).join(" ") : "";
  console.log(d.title);
  console.log(`  ${url(d.slug)}`);
  if (d.project || tags) console.log(`  ${d.project ? `▸ ${d.project}` : ""}${tags}`);
  console.log(`  mode: ${d.mode || "feedback"}  ·  visibility: ${d.visibility || "public"}${d.archived ? " · archived" : ""}${d.open ? ` · ${d.open} open thread(s)` : ""}`);
  if (d.description) console.log(`  ${d.description}`);
  if (d.updatedAt) console.log(`  updated ${relTime(d.updatedAt)}`);
}

// Best-effort local repo context, so the agent can infer a project and decide
// create-vs-update. Every field is null outside a git repo / when git is absent.
function gitContext(): { cwd: string; root: string | null; repo: string | null; branch: string | null; dirty: boolean | null } {
  const cwd = process.cwd();
  const git = (cmd: string[]): string | null => {
    try {
      const p = spawnSync("git", cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      return p.status === 0 ? p.stdout.toString().trim() || null : null;
    } catch { return null; }
  };
  const root = git(["rev-parse", "--show-toplevel"]);
  return {
    cwd,
    root,
    repo: root ? basename(root) : null,
    branch: root ? git(["rev-parse", "--abbrev-ref", "HEAD"]) : null,
    dirty: root ? !!git(["status", "--porcelain"]) : null,
  };
}

// ── sweep — reconcile canvases with shipped code ─────────────────────────────
// Deterministic *evidence*, not verdicts: which active canvases look shipped
// (their slug shows up in a commit made after the canvas last changed) or stale
// (idle for weeks with no open threads). The judgment — "is this spec actually
// implemented?" — is prose-vs-code reading, so it belongs to the agent; the CLI
// just gathers the facts and the skill carries the workflow (receipt → close
// threads → archive).
const SWEEP_IDLE_DAYS = 21;
const SWEEP_LOG_WINDOW = "180.days";

type SweepCommit = { sha: string; ts: number; subject: string };
type SweepRow = {
  slug: string; title: string; project: string | null; tags: string[];
  open: number; updatedAt: number; idleDays: number;
  commits: SweepCommit[]; commitsAfterUpdate: number;
  looksShipped: boolean; looksStale: boolean;
};

// One pass over HEAD's recent history (not --all: a slug on an unmerged branch
// isn't shipped). \x1f/\x1e separators can't appear in commit text.
function gitLogEntries(root: string | null): { sha: string; ts: number; subject: string; text: string }[] {
  if (!root) return [];
  try {
    const p = spawnSync(
      "git",
      ["log", `--since=${SWEEP_LOG_WINDOW}`, "--pretty=format:%H%x1f%ct%x1f%s%x1f%B%x1e"],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (p.status !== 0) return [];
    return p.stdout.toString().split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [sha, ct, subject, body] = rec.split("\x1f");
      return { sha: (sha || "").slice(0, 7), ts: (Number(ct) || 0) * 1000, subject: subject || "", text: body || "" };
    });
  } catch { return []; }
}

// Pinned canvases are deliberately long-lived (dashboards, living docs) — never
// sweep candidates. Slugs are collision-proof (`launch-plan-9fk2q`), so a plain
// substring match against commit messages is exact enough.
function sweepEvidence(items: any[], log: ReturnType<typeof gitLogEntries>): SweepRow[] {
  const now = Date.now();
  return items.filter((d) => !d.archived && !d.pinned).map((d) => {
    const commits = log.filter((e) => e.text.includes(d.slug)).map(({ sha, ts, subject }) => ({ sha, ts, subject }));
    const commitsAfterUpdate = commits.filter((c) => c.ts > (d.updatedAt || 0)).length;
    const idleDays = d.updatedAt ? Math.floor((now - d.updatedAt) / 86_400_000) : 0;
    const looksShipped = commitsAfterUpdate > 0;
    const looksStale = !looksShipped && idleDays >= SWEEP_IDLE_DAYS && !(d.open || 0);
    return {
      slug: d.slug, title: d.title, project: d.project || null, tags: Array.isArray(d.tags) ? d.tags : [],
      open: d.open || 0, updatedAt: d.updatedAt || 0, idleDays,
      commits, commitsAfterUpdate, looksShipped, looksStale,
    };
  });
}

// ── tidy — one audit pass over the canvas list ────────────────────────────────
// The mechanical half of "tidy my canvases", in one report: unfiled canvases
// (no project or no tags, archived included: filters span the shelf too), junk
// candidates (untitled/blank titles), tag drift (plural twins, one-off tags),
// and the sweep — active canvases that look shipped (slug in a commit after the
// canvas last changed) or stale (idle 3+ weeks, no open threads), with their
// commit evidence. `--sweep` renders just that last section (the ship-moment
// micro-sweep, where filing noise is irrelevant); `--project` scopes any form.
// The CLI detects; classification (which project, which tags merge, is the spec
// truly implemented) is the agent's judgment, and deleting is the human's call.
async function tidy(args: string[] = []) {
  const r = await api("canvas.ls", { method: "GET" });
  let all = (r.items as any[]) || [];
  const projectFilter = flag(args, "project");
  if (projectFilter !== undefined) all = all.filter((d) => (d.project || "") === projectFilter);
  const sweepOnly = has(args, "sweep");
  const active = all.filter((d) => !d.archived);
  const git = gitContext();

  const isUnfiled = (d: any) => !d.project || !(Array.isArray(d.tags) && d.tags.length);
  const isJunk = (d: any) => !(d.title || "").trim() || /^untitled\b/i.test((d.title || "").trim());
  const unfiled = all
    .filter((d) => isUnfiled(d) && !isJunk(d))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const junk = all.filter(isJunk);

  // Tag drift: a tag and its plural living side by side, and tags used exactly
  // once (synonym suspects — `plan` at 12 next to `proposal` at 1). String
  // heuristics only; whether they actually mean the same thing is judgment.
  const tagCount = new Map<string, number>();
  for (const d of all) for (const t of Array.isArray(d.tags) ? d.tags : []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const pluralTwins = [...tagCount.keys()].filter((t) => tagCount.has(`${t}s`)).map((t) => ({ a: t, an: tagCount.get(t)!, b: `${t}s`, bn: tagCount.get(`${t}s`)! }));
  const singletons = tagCount.size >= 4 ? [...tagCount.entries()].filter(([, n]) => n === 1).map(([t]) => t).sort() : [];

  const sweepRows = sweepEvidence(active, gitLogEntries(git.root));
  const shipped = sweepRows.filter((x) => x.looksShipped);
  const stale = sweepRows.filter((x) => x.looksStale);
  const current = sweepRows.filter((x) => !x.looksShipped && !x.looksStale);

  await track("tidy.run", { sweep_only: sweepOnly, unfiled: unfiled.length, junk: junk.length, plural_twins: pluralTwins.length, singletons: singletons.length, looks_shipped: shipped.length, looks_stale: stale.length, git: !!git.root });

  if (has(args, "json")) {
    const row = (d: any) => ({ slug: d.slug, title: d.title, description: d.description || null, project: d.project || null, tags: Array.isArray(d.tags) ? d.tags : [], archived: !!d.archived, updatedAt: d.updatedAt || 0 });
    console.log(JSON.stringify({
      local: git,
      gitWindow: git.root ? SWEEP_LOG_WINDOW : null,
      idleDays: SWEEP_IDLE_DAYS,
      counts: { active: active.length, archived: all.length - active.length },
      ...(sweepOnly ? {} : {
        unfiled: unfiled.map(row),
        junk: junk.map(row),
        tags: { tally: [...tagCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), pluralTwins, singletons },
      }),
      sweep: sweepRows,
    }, null, 2));
    return;
  }

  console.log(`Tidy${sweepOnly ? " (sweep)" : ""} — ${active.length} active, ${all.length - active.length} archived  ·  ${git.root ? `git: ${git.repo} @ ${git.branch} (commit evidence from the last ${SWEEP_LOG_WINDOW.replace(".", " ")})` : "no git repo here — idle signals only; run from the repo for commit evidence"}`);
  const clean = (sweepOnly || (!unfiled.length && !junk.length && !pluralTwins.length)) && !shipped.length && !stale.length;
  if (clean) {
    console.log(sweepOnly
      ? "\n✓ nothing to sweep — no active canvas looks shipped or stale" + (projectFilter ? " in that project" : "")
      : "\n✓ nothing to tidy — every canvas is filed, titled, and current" + (singletons.length ? ` (one-off tags worth a look: ${singletons.map((t) => `#${t}`).join(" ")})` : ""));
    return;
  }

  if (!sweepOnly) {
    if (unfiled.length) {
      console.log(`\nUnfiled (${unfiled.length}) — missing a project or tags; file each with \`drafty canvas set <slug> --project P --tag T\`:`);
      for (const d of unfiled) console.log(`  ${d.slug}  ${d.title}${d.archived ? "  · archived" : ""}${d.project ? `  · ▸ ${d.project}` : ""}${Array.isArray(d.tags) && d.tags.length ? `  · ${d.tags.map((t: string) => `#${t}`).join(" ")}` : ""}`);
    }
    if (junk.length) {
      console.log(`\nJunk candidates (${junk.length}) — blank/untitled; confirm with the human before \`drafty canvas rm <slug> --yes\`:`);
      for (const d of junk) console.log(`  ${d.slug}  "${d.title}"${d.archived ? "  · archived" : ""}  · updated ${relTime(d.updatedAt || 0)}`);
    }
    if (pluralTwins.length || singletons.length) {
      console.log(`\nTag drift — same meaning, different labels splinter the filters:`);
      for (const p of pluralTwins) console.log(`  #${p.a} (${p.an}) and #${p.b} (${p.bn}) — merge? \`drafty canvas set <slug> --tag ${p.an >= p.bn ? p.a : p.b} --untag ${p.an >= p.bn ? p.b : p.a}\``);
      if (singletons.length) console.log(`  one-off tags (synonym suspects): ${singletons.map((t) => `#${t}`).join(" ")}`);
    }
  }

  const evidenceLine = (x: SweepRow, evidence: string) => {
    console.log(`  ${x.slug}  ${x.title}${x.project ? ` · ${x.project}` : ""}`);
    console.log(`    ${evidence}`);
  };
  if (shipped.length) {
    console.log(`\nLooks shipped (${shipped.length}) — commits reference the canvas after its last update:`);
    for (const x of shipped) {
      const recent = x.commits.filter((c) => c.ts > x.updatedAt).slice(0, 3);
      evidenceLine(x, `${recent.map((c) => `${c.sha} "${c.subject}"`).join(", ")}${x.commitsAfterUpdate > 3 ? ` +${x.commitsAfterUpdate - 3} more` : ""} · ${x.open ? `${x.open} open thread(s)` : "no open threads"} · idle ${x.idleDays}d`);
      console.log(`    if truly shipped: drafty canvas close ${x.slug} --commit ${recent.map((c) => c.sha).join(",")}`);
    }
  }
  if (stale.length) {
    console.log(`\nLooks stale (${stale.length}) — idle ${SWEEP_IDLE_DAYS}d+ with no open threads, no commit evidence:`);
    for (const x of stale) evidenceLine(x, `idle ${x.idleDays}d · 0 open — shipped elsewhere, superseded, or abandoned?`);
  }
  if (sweepOnly && current.length) {
    console.log(`\nStill current (${current.length}) — leave alone:`);
    for (const x of current) console.log(`  ${x.slug}  ${x.title}${x.open ? ` · ${x.open} open` : ""} · ${relTime(x.updatedAt)}`);
  }

  console.log(`\nDetection only — classify each finding with your own read (titles/descriptions usually`);
  console.log(`suffice; \`drafty canvas pull <slug>\` if not) and reuse the existing project/tag vocabulary`);
  console.log(`(\`drafty context\`). Junk deletions: propose to the human — never rm unasked.`);
  if (shipped.length || stale.length) {
    console.log(`For a truly shipped canvas, run its \`canvas close\` line above (receipt + threads + archive).`);
    console.log(`Propose the list to the human first unless you shipped the work yourself this session.`);
  }
}

// One-shot orientation: who you are, where you are (git), the projects + tags
// already in use, and the canvas list — everything needed to decide what to put
// on the next push/update (which project, which tags, create vs. update). Run it
// at the start of a drafty task. --json for tooling; --archived to include shelved.
async function context(args: string[] = []) {
  const [me, docsRes] = await Promise.all([
    api("whoami", { method: "GET" }),
    api("canvas.ls", { method: "GET" }),
  ]);
  const all = (docsRes.items as any[]) || [];
  const items = has(args, "archived") || has(args, "all") ? all : all.filter((d) => !d.archived);
  const archived = all.length - items.length;
  const git = gitContext();

  // Tally projects + tags over the visible set so the agent reuses existing labels.
  const projCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const d of items) {
    projCount.set(d.project || "", (projCount.get(d.project || "") || 0) + 1);
    for (const t of Array.isArray(d.tags) ? d.tags : []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const projects = [...projCount.entries()].filter(([k]) => k).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const ungrouped = projCount.get("") || 0;
  const tags = [...tagCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const unfiled = items.filter((d) => !d.project || !(Array.isArray(d.tags) && d.tags.length)).length;

  // The sweep nudge — the primary trigger for reconciling canvases with shipped
  // code. Same evidence as `drafty tidy --sweep`, boiled down to one count, surfaced
  // here because context opens every drafty session: the human never has to
  // remember to ask. One extra git invocation; cheap.
  const sweepRows = sweepEvidence(items, gitLogEntries(git.root));
  const sweepShipped = sweepRows.filter((x) => x.looksShipped).length;
  const sweepStale = sweepRows.filter((x) => x.looksStale).length;

  // The canvas list is capped to the most-recently-updated N (default 15) so it
  // stays readable as the account grows — the project/tag aggregates above stay
  // complete, so the full landscape is always visible. --limit 0 shows all.
  const limitArg = flag(args, "limit");
  const limit = limitArg !== undefined && Number.isFinite(parseInt(limitArg, 10)) ? Math.max(0, parseInt(limitArg, 10)) : 15;
  const byRecent = [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const shown = limit === 0 ? byRecent : byRecent.slice(0, limit);
  const more = items.length - shown.length;

  if (has(args, "json")) {
    console.log(JSON.stringify({
      me: { email: me.email || null, isGuest: me.isGuest, canvases: me.canvases },
      local: git,
      projects, ungrouped, tags, archived, unfiled,
      sweep: { looksShipped: sweepShipped, looksStale: sweepStale },
      shownCanvases: shown.length, moreCanvases: more,
      canvases: shown.map((d) => ({
        slug: d.slug, title: d.title, description: d.description || null, project: d.project || null,
        tags: d.tags || [], open: d.open || 0, updatedAt: d.updatedAt || 0,
      })),
    }, null, 2));
    return;
  }

  console.log(`Signed in as ${me.isGuest ? "guest (not signed in)" : me.email || "signed in"} · ${me.canvases} canvas(es)`);
  console.log(`Working dir  ${git.cwd}  (${git.root ? `git: ${git.repo} @ ${git.branch}${git.dirty ? ", dirty" : ""}` : "no git repo"})`);
  const projLine = projects.map((p) => `${p.name} (${p.count})`).concat(ungrouped ? [`ungrouped (${ungrouped})`] : []).join(" · ");
  console.log(`\nProjects (${projects.length})${projLine ? ":  " + projLine : ""}`);
  console.log(`Tags (${tags.length})${tags.length ? ":      " + tags.map((t) => `#${t.name} (${t.count})`).join(" · ") : ""}`);
  if (archived) console.log(`Archived:    ${archived} hidden (pass --archived to include)`);
  if (unfiled) console.log(`Unfiled:     ${unfiled} missing a project or tags — \`drafty tidy\` for the work-list, then \`drafty canvas set <slug> …\``);
  if (sweepShipped + sweepStale > 0) {
    const parts = [sweepShipped ? `${sweepShipped} look${sweepShipped === 1 ? "s" : ""} shipped` : null, sweepStale ? `${sweepStale} look${sweepStale === 1 ? "s" : ""} stale` : null].filter(Boolean).join(", ");
    console.log(`Sweep:       ${parts} — \`drafty tidy --sweep\` for the evidence (judge before archiving)`);
  }

  if (!items.length) { console.log(`\n(no canvases yet — publish one with \`drafty canvas push <file>\`)`); return; }
  console.log(`\nMost recent${more > 0 ? ` ${shown.length} of ${items.length}` : ""}:`);
  printCanvasList(shown);
  if (more > 0) console.log(`\n  …+${more} more — \`drafty canvas ls\` for the full list, or \`drafty canvas ls --project <name>\` to drill in`);
  console.log(`\nReuse a project/tag above before inventing a new one. To update a canvas, push its exact slug; otherwise a push creates a new one.`);
}

// Take ownership of a provisional canvas an agent minted. The provision token
// (which owns the canvas) authorizes the transfer; the new owner is *you*, the
// stored identity. The agent that created the canvas holds that token — pass it
// via DRAFTY_TOKEN or --token. After this the canvas stops being ephemeral and
// shows up in `drafty canvas ls`.
async function canvasClaim(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) return die("usage: DRAFTY_TOKEN=<provision token> drafty canvas claim <slug>");
  const provisionToken = process.env.DRAFTY_TOKEN || flag(args, "token");
  if (!provisionToken) {
    return die(
      "claim needs the canvas's provision token (the agent that created it holds it).\n" +
        `  run:  DRAFTY_TOKEN=<token from /get/provision> drafty canvas claim ${slug}`,
    );
  }
  const me = await api("whoami", { method: "GET" }); // my identity = the new owner
  // Claiming pins the canvas to a real account, not a throwaway guest. If the
  // stored identity is still a guest, sign in first.
  if (me.isGuest) {
    console.error("Claiming keeps this canvas under your Drafty account — sign in first:");
    console.error(`  drafty login          opens your browser to sign in`);
    console.error(`then re-run:  DRAFTY_TOKEN=… drafty canvas claim ${slug}`);
    process.exit(1);
  }
  await api("canvas.claim", { token: provisionToken, body: { slug, newCreatorId: me.userId } });
  const who = me.email ? ` (${me.email})` : "";
  console.error(`✓ claimed — ${url(slug)} is yours now${who}. It won't expire, and it's in \`drafty canvas ls\`.`);
  await track("canvas.claimed", { slug });
}

// ── auth (email magic-code) ───────────────────────────────────────────────────
// Sign in by opening the browser. The /cli-auth page authenticates (magic-code,
// later Google) and POSTs the resulting session token back to a one-shot
// loopback listener we run here — so one action signs you in on BOTH the web and
// this CLI. Local-only by design: the browser must reach 127.0.0.1 on this
// machine. After sign-in we fold any canvases the prior guest made into the new
// account.
async function login(args: string[] = []) {
  const ti = args.indexOf("--token");
  const connectCode = ti >= 0 ? args[ti + 1] : undefined;

  const oldToken = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  let oldGuestId = "";
  if (oldToken) {
    try { const me = await api("whoami", { method: "GET", token: oldToken }); if (me.isGuest) oldGuestId = me.userId; } catch { /* ignore */ }
  }

  // Non-interactive sign-in: trade a one-time connect code (from the web
  // /connect page) for the account's session — no browser, no loopback. Used by
  // the agent in the post-signup "connect your agent" flow.
  if (connectCode) {
    await track("auth.started", { method: "token" });
    let token: string;
    try {
      const r = await fetch(`${BASE_URL}/get/api/connect.exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: connectCode }) });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; refreshToken?: string };
      if (!r.ok || d.ok === false || !d.refreshToken) throw new Error(d.error || "the connect code was rejected");
      token = d.refreshToken;
    } catch (e) { return die((e as Error).message); }
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    await track("auth.completed", { method: "token" });
    await finishSignIn(token, oldToken, oldGuestId);
    return;
  }

  const state = crypto.randomUUID();
  let resolveCb!: (token: string) => void;
  let rejectCb!: (e: Error) => void;
  const got = new Promise<string>((res, rej) => { resolveCb = res; rejectCb = rej; });

  const allowOrigin = new URL(BASE_URL).origin;
  const cors = { "access-control-allow-origin": allowOrigin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" };

  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? null;
    const respond = (status: number, b: unknown) => {
      res.writeHead(status, { ...cors, "content-type": "application/json", ...(origin === allowOrigin ? { "access-control-allow-origin": origin } : {}) });
      res.end(JSON.stringify(b));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, ...(origin === allowOrigin ? { "access-control-allow-origin": origin } : {}) });
      return res.end();
    }
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (u.pathname !== "/callback" || req.method !== "POST") return respond(404, { ok: false });
    if (origin !== allowOrigin) return respond(403, { ok: false }); // only our web origin may hand a token back
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { token?: string; state?: string };
        if (body.state !== state || !body.token) return respond(400, { ok: false });
        // Resolve on the next tick so this 200 flushes to the browser *before*
        // the main flow stops the server — otherwise the page sees a dropped
        // connection and shows a false error even though we got the token.
        const tok = body.token;
        setTimeout(() => resolveCb(tok), 50);
        respond(200, { ok: true });
      } catch {
        respond(400, { ok: false });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const d = Buffer.from(JSON.stringify({ port, state })).toString("base64url");
  const authUrl = `${BASE_URL}/cli-auth?d=${d}`;
  await track("auth.started", { method: "browser" });
  console.error("Opening your browser to sign in…");
  console.error(`  ${authUrl}`);
  openBrowser(authUrl);

  const timer = setTimeout(() => rejectCb(new Error("timed out waiting for the browser — re-run `drafty login`")), 180000);
  let token: string;
  try { token = await got; } catch (e) { server.closeAllConnections(); server.close(); return die((e as Error).message); }
  clearTimeout(timer);
  server.close(); // graceful — let the in-flight 200 finish flushing to the browser

  // Valid token in hand — store it first so login can't fail past this point.
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  await track("auth.completed", { method: "browser" });
  await finishSignIn(token, oldToken, oldGuestId);
}

// Best-effort post-sign-in: identify (for the confirmation line) and fold the
// old guest's canvases into the account. Raw fetches, never `api()` — a hiccup
// here must not undo a sign-in that already stored the token. Shared by the
// loopback (`login`) and non-interactive (`login --token`) paths.
async function finishSignIn(token: string, oldToken: string, oldGuestId: string) {
  let label = "";
  try {
    const meRes = await fetch(`${BASE_URL}/get/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
    const me = (await meRes.json().catch(() => ({}))) as { userId?: string; email?: string };
    if (me.userId) {
      label = me.email || me.userId;
      // Remember who we are so a future lost session can be detected (not silent).
      writeIdentity({ signedIn: true, email: me.email, userId: me.userId, sessionLost: false });
      if (oldGuestId && me.userId !== oldGuestId) {
        const mr = await fetch(`${BASE_URL}/get/api/merge`, { method: "POST", headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json" }, body: JSON.stringify({ newCreatorId: me.userId }) });
        const md = (await mr.json().catch(() => ({}))) as { merged?: number };
        if (md.merged) console.error(`  brought ${md.merged} canvas(es) over from your guest session`);
      }
    }
  } catch { /* ignore */ }
  console.error(`✓ signed in${label ? ` as ${label}` : ""}`);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try { spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref(); } catch { /* user can click the printed URL */ }
}

// Drop the stored identity; every command then asks for `drafty login` again.
function logout() {
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE, { force: true });
  clearIdentity(); // explicit sign-out — drop the marker so we don't warn about it
  console.error("✓ signed out — run `drafty login` to sign back in");
}

// ── setup / health ────────────────────────────────────────────────────────────
// Minimal `which`: first PATH entry holding a file by that name.
function whichOnPath(name: string): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep).filter(Boolean)) {
    try { const p = join(dir, name); if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

async function whoami() {
  const r = await api("whoami", { method: "GET" });
  // Keep the marker in step with reality: refresh it when signed in (also clears
  // any stale session-lost flag after a re-login).
  if (!r.isGuest) writeIdentity({ signedIn: true, email: r.email, userId: r.userId, sessionLost: false });
  console.log(`identity : ${r.isGuest ? "guest (not signed in)" : r.email || "signed in"}`);
  console.log(`user id  : ${r.userId}`);
  console.log(`canvases : ${r.canvases}`);
  console.log(`server   : ${BASE_URL}`);
  console.log(`stored   : ${STATE_DIR}`);
  if (r.isGuest) console.log(`\nSign in to keep canvases under your account:  drafty login`);
}

async function doctor() {
  let ok = true;
  const pass = (l: string, d = "") => console.log(`  \x1b[32m✓\x1b[0m ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ""}`);
  const fail = (l: string, d = "") => { ok = false; console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ""}`); };
  // An available update isn't a broken state — surface it, don't fail on it.
  const warn = (l: string, d = "") => console.log(`  \x1b[33m▲\x1b[0m ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ""}`);

  console.log("drafty — doctor\n");

  const bunV = (globalThis as any).Bun?.version;
  const nodeV = process.versions?.node;
  if (bunV) pass("runtime", `bun v${bunV}`);
  else if (nodeV) pass("runtime", `node v${nodeV}`);
  else fail("runtime", "needs Node ≥22.18 (nodejs.org) or bun (bun.sh)");

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const probe = join(STATE_DIR, ".doctor");
    writeFileSync(probe, "ok"); rmSync(probe);
    pass("state dir writable", STATE_DIR);
  } catch {
    fail("state dir writable", STATE_DIR);
  }

  // The skill ships INSIDE the plugin (…/skills/drafty/SKILL.md next to cli/),
  // which Claude Code loads directly — no `drafty setup` registration needed.
  // The setup-registered copies (user-level ~/.claude/skills or a project
  // .claude/) are legacy paths from the pre-plugin era; still honored.
  let skillAt: string | null = null;
  const bundled = join(import.meta.dirname, "..", "skills", "drafty", "SKILL.md");
  if (existsSync(bundled)) skillAt = bundled;
  if (!skillAt && existsSync(SKILL_DST)) skillAt = SKILL_DST;
  for (let dir = process.cwd(); !skillAt; ) {
    const p = join(dir, ".claude", "skills", "drafty", "SKILL.md");
    if (existsSync(p)) { skillAt = p; break; }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  skillAt
    ? pass(skillAt === bundled ? "skill bundled with the plugin" : "skill installed", skillAt)
    : fail("skill not installed", "run `drafty setup` to register it for Claude Code");

  const launcher = whichOnPath("drafty");
  launcher ? pass("drafty on PATH", launcher) : fail("drafty not on PATH", "run `drafty setup`");

  const cur = installedVersion();
  const latest = await latestVersion();
  if (cur && latest && cmpSemver(cur, latest) < 0) {
    warn("update available", `${cur} → ${latest} · claude plugin update drafty@drafty-im then /reload-plugins`);
  } else if (cur) {
    pass("version", latest ? `v${cur} (latest)` : `v${cur}`);
  }

  try {
    const res = await Promise.race([
      fetch(`${BASE_URL}/get/guide`),
      new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timed out")), 12000)),
    ]);
    res.ok ? pass("server reachable", BASE_URL) : fail("server reachable", `${BASE_URL} → ${res.status}`);
  } catch (e: any) {
    fail("server reachable", `${BASE_URL} — ${e?.message ?? String(e)}`);
  }

  try {
    const r = await api("whoami", { method: "GET" });
    pass("identity ready", `${r.userId} · ${r.canvases} canvas(es)`);
  } catch (e: any) {
    fail("identity ready", e?.message ?? String(e));
  }

  console.log(`\n${ok ? "\x1b[32m✓ all good\x1b[0m" : "\x1b[31m✗ issues above — see hints\x1b[0m"}`);
  if (!ok) process.exit(1);
}

async function setup() {
  const cliDir = import.meta.dirname;
  console.log("drafty — setup\n");

  const skillSrc = join(cliDir, "skill", "SKILL.md");
  if (existsSync(skillSrc)) {
    mkdirSync(join(homedir(), ".claude", "skills", "drafty"), { recursive: true });
    rmSync(SKILL_DST, { force: true });
    symlinkSync(skillSrc, SKILL_DST);
    console.log(`• registered skill → ${SKILL_DST}`);
  } else {
    console.log(`• skill source not found at ${skillSrc} — skipping skill install`);
  }

  const { path: launcherPath, binDir, onPath } = installLauncher(cliDir);
  console.log(`• installed launcher → ${launcherPath}`);
  if (onPath) {
    console.log(`  (${binDir} is on your PATH — run \`drafty\` from anywhere, incl. background sessions)`);
  } else {
    console.log(`\n⚠  ${binDir} is not on your PATH. Add it, then restart your shell:`);
    console.log(`  echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc`);
  }
  console.log("");

  await doctor();
}

// Write an executable `drafty` launcher into a PATH dir (works in interactive AND
// non-interactive shells, unlike an alias).
function installLauncher(cliDir: string): { path: string; binDir: string; onPath: boolean } {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const candidates = [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin")];
  const binDir = candidates.find((d) => pathDirs.includes(d)) ?? candidates[0];
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "drafty");
  const src = join(cliDir, "canvas.ts");
  writeFileSync(
    launcher,
    `#!/bin/sh\n# drafty CLI launcher — installed by \`drafty setup\`. Works in interactive\n# and non-interactive shells (an alias would not). Source: ${src}\nif command -v bun >/dev/null 2>&1; then exec bun "${src}" "$@"; fi\nif command -v node >/dev/null 2>&1; then exec node --disable-warning=ExperimentalWarning "${src}" "$@"; fi\necho "drafty: needs Node >=22.18 (https://nodejs.org) or bun (https://bun.sh) on PATH." >&2\nexit 127\n`,
  );
  chmodSync(launcher, 0o755);
  return { path: launcher, binDir, onPath: pathDirs.includes(binDir) };
}

// What shipped, by week. Public feed — no token. The server renders the
// ready-to-print text; --json passes the structured weeks through.
async function changelog(args: string[]) {
  const wantJson = has(args, "json");
  const res = await fetch(`${BASE_URL}/get/api/changelog${wantJson ? "" : "?format=text"}`);
  if (!res.ok) return die(`changelog failed (${res.status})`);
  process.stdout.write(await res.text());
}

const HELP = `drafty — publish canvases for annotation, read & reply to the comments

CANVAS — the canvas you publish
  drafty canvas push <file> [--title T] [--slug S] [--mode M] [--visibility public|authed|invite] [--private] [--project P|--no-project] [--tag T …]   publish/update + file it (new canvases auto-file under the cwd repo)
  drafty canvas ls [--project P] [--tag T] [--unfiled] [--archived|--all] [--json]   list your canvases (--archived = just the shelf)
  drafty canvas show <slug>                meta: title, link, project, tags, mode, threads
  drafty canvas pull <slug> [--revision id] [-o f]   download the content
  drafty canvas versions <slug> [--json]   list a canvas's versions, newest first
  drafty canvas restore <slug> <revisionId>   restore to a past version (server only)
  drafty canvas revert <file|slug> [--to revisionId]   undo: restore AND resync the local file (atomic)
  drafty canvas status <file>              sync report: in-sync / local-ahead / canvas-ahead / diverged
  drafty canvas rename <slug> "<title>"
  drafty canvas set <slug> [--project P|--no-project] [--tag T…] [--untag T…] [--clear-tags]   organize
  drafty canvas tag <slug> <label…> / untag <slug> <label…>   add/remove kind labels
  drafty canvas archive <slug> / unarchive <slug>   hide from / restore to \`canvas ls\`
  drafty canvas close <slug> --commit <sha>[,…] [--note "…"]   close out shipped work: stamp receipt, resolve threads, archive
  drafty canvas pin <slug> / unpin <slug>   hold in / release from the Pinned lane on your home
  drafty canvas mode <slug> <readonly|feedback|live>   how it behaves when shared
  drafty canvas visibility <slug> <public|authed|invite|private>   who can view it (invite/private = owner + invited only)
  drafty canvas rm <slug> --yes            remove a canvas entirely
  drafty canvas claim <slug>               keep a provisional canvas (DRAFTY_TOKEN=<provision token>)

COMMENTS — threads pinned to a canvas, and their replies
  drafty comments ls <slug> [--json] [--open]   threads + replies on a canvas
  drafty comments inbox [slug] [--json] [--all]   fresh threads that need Claude
  drafty comments watch <slug> [--json] [--backlog] [--for DUR]   stream new comments live (SSE doorbell); --for 20m self-exits, no external timeout needed
  drafty comments watch --live [--json] [--for DUR]   stream comments from EVERY canvas you have live over ONE connection; each event is tagged with its slug (run in one comms session)
  drafty comments create <slug> --anchor "<text>" [--at fx,fy] "<msg>"   open a NEW thread as Claude (--canvas for an unanchored note)
  drafty comments reply <annotationId> "<message>"   reply in a thread as Claude
  drafty comments working <annotationId>      shimmer the thread while you work on it
  drafty comments resolve <annotationId> / reopen <annotationId>   toggle a thread's done state
  drafty comments rm <annotationId>           delete a thread (+ its replies)
  drafty comments rm-reply <commentId>        delete a single reply
  drafty comments clear <slug> --yes          delete all threads on a canvas

INBOX — your capture inbox: screenshots from the iOS/Mac apps, worked by agents
  drafty inbox ls [--status todo|doing|review|done] [--project P] [--json]   the board as a task queue
  drafty inbox watch [--json] [--backlog] [--for DUR]   stream new captures live (the doorbell)
  drafty inbox claim <entryId> [--agent name]   take a todo item (todo → doing)
  drafty inbox classify <entryId> [--project P] [--tag T …] [--summary "…"]   file it on pickup
  drafty inbox review <entryId> [--pr URL] [--proof slug]   hand it back for approval with receipts (→ review)
  drafty inbox done <entryId> [--pr URL] [--proof slug]   human approval — accept the work (→ done)
  drafty inbox reopen <entryId>               send it back to todo (receipts kept)

LINKS — short tracked links (drafty.im/l/<code>) with attribution baked in
  drafty link create <slug|/path> [--code C] [--source S] [--medium M] [--campaign C] [--content C]   mint (or reuse) a shortlink
  drafty link ls [--json]                     your shortlinks, newest first
  drafty link rm <code>                       remove a shortlink
  drafty resolve <link> [--json]              print the canvas behind any drafty link (slug, /canvas/ URL, or /l/ short link)

  drafty shot <slug|file.html|url> [--width N] [--revision R] [--annotation A] [--full] [-o out]   render to an image and print its path (the agent's eyes)
  drafty present <url> [--screens N] [--widths 1280,390] [--urls a,b…] [--slug S] [--refresh] [--dry-run]   site board: map → curate → shoot → annotatable canvas
  drafty context [--limit N] [--archived] [--json]   one-shot orientation: identity, git, projects, tags + recent canvases
  drafty tidy [--project P] [--sweep] [--json]   one audit pass: unfiled canvases, junk titles, tag drift + which look shipped/stale (commit evidence); --sweep = just the shipped/stale section
  drafty changelog [--json]                   what shipped, by week
  drafty login / logout                       sign in (browser; web + CLI) / sign out
  drafty whoami                               show your identity
  drafty setup                                register the skill + launcher, then run doctor
  drafty doctor                               preflight: runtime, state dir, skill, server, identity

Any <slug> above also accepts a full ${BASE_URL}/canvas/<slug> URL or a
${BASE_URL}/l/<code> short link — paste what you have, no need to extract the slug.

Sign in first — \`drafty login\` (browser handback, token stored in ~/.drafty). The
plugin never mints an anonymous identity: with no stored login, every command just
says "Not signed in" (guest mode lives only in the no-install demo at ${BASE_URL}/get).
Point at another server with DRAFTY_BASE_URL.
`;

// Namespaced verb tables — `drafty <namespace> <verb> [args]`. The namespace
// disambiguates same-named verbs (`canvas ls` vs `comments ls`).
type Cmd = (args: string[]) => unknown;
const CANVAS: Record<string, Cmd> = {
  push: canvasPush, ls: canvasLs, show: canvasShow, pull: canvasPull,
  versions: canvasVersions, restore: canvasRestore, revert: canvasRevert, status: canvasStatus, rename: canvasRename,
  set: canvasSet, tag: (a) => canvasTag(a, true), untag: (a) => canvasTag(a, false),
  archive: (a) => canvasArchive(a, true), unarchive: (a) => canvasArchive(a, false), close: canvasClose,
  pin: (a) => canvasPin(a, true), unpin: (a) => canvasPin(a, false),
  mode: canvasMode, visibility: canvasVisibility, rm: canvasRm, claim: canvasClaim,
};
const COMMENTS: Record<string, Cmd> = {
  ls: commentsLs, inbox: commentsInbox, watch: commentsWatch, create: commentsCreate, reply: commentsReply, working: commentsWorking,
  resolve: (a) => commentsStatus(a, "completed"), reopen: (a) => commentsStatus(a, "open"),
  rm: commentsRm, "rm-reply": commentsRmReply, clear: commentsClear,
};
const INBOX: Record<string, Cmd> = {
  ls: inboxLs, claim: inboxClaim, classify: inboxClassify, review: inboxReview, done: inboxDone, reopen: inboxReopen, watch: inboxWatch,
};
const LINK: Record<string, Cmd> = { create: linkCreate, ls: linkLs, rm: linkRm, resolve: resolveCmd };
// Top-level: session / meta — not scoped to a canvas or a comment.
// `sweep` (released ≤0.25.0) folded into `tidy --sweep`; the alias keeps old
// muscle memory working but help/skill document only tidy.
const TOP: Record<string, Cmd> = { context, changelog, login, logout, whoami, setup, doctor, shot, tidy, audit: tidy, sweep: (a) => tidy([...a, "--sweep"]), present, resolve: resolveCmd };

function runGroup(name: string, table: Record<string, Cmd>, args: string[]) {
  const [verb, ...rest] = args;
  const fn = verb ? table[verb] : undefined;
  if (!fn) {
    console.error(`✗ unknown \`${name}\` command: ${verb ?? "(none)"}\n`);
    console.log(HELP);
    return process.exit(1);
  }
  return fn(rest);
}

async function main() {
  const [head, ...rest] = process.argv.slice(2);
  // `canvas` is canonical; `canvases`/`documents`/`document`/`doc` stay as aliases
  // so existing muscle memory and older docs keep working.
  if (["canvas", "canvases", "documents", "document", "doc"].includes(head)) return runGroup("canvas", CANVAS, rest);
  if (head === "comments" || head === "comment") return runGroup("comments", COMMENTS, rest);
  if (head === "inbox") return runGroup("inbox", INBOX, rest);
  if (head === "link" || head === "links") return runGroup("link", LINK, rest);
  if (head && TOP[head]) return TOP[head](rest);
  console.log(HELP);
  if (head && !["help", "--help", "-h"].includes(head)) process.exit(1);
}

main()
  .then(async () => { await maybeNudgeUpdate(); process.exit(0); })
  .catch((e) => die(e?.message ?? String(e)));
