#!/usr/bin/env bun
// drafty CLI — publish canvases to drafty.im/canvas/<slug>, then read and reply to
// feedback as Claude.
//
// A thin HTTP/SSE client: it holds a per-user guest token (minted by the server,
// stored under ~/.drafty) and drives everything through the public /get/api
// endpoints. No InstantDB dependency, no native deps — installs anywhere.
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const BASE_URL = process.env.DRAFTY_BASE_URL || "https://drafty.im";
const STATE_DIR = join(homedir(), ".drafty");
const TOKEN_FILE = join(STATE_DIR, "token");
// A durable marker of the last signed-in identity, kept alongside the token.
// If the token ever goes missing while this says we were signed in, we make the
// drop-to-guest LOUD instead of silent (see getToken / main) — so a lost session
// can never quietly publish under a throwaway guest.
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
// fire-and-forget POST to /api/track. No SDK, no API key (the ingest accepts
// body identity). Best-effort — never let telemetry break or slow a command.
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
    // Tie CLI activity to the signed-in account (same id the web uses) so a real
    // user's web + CLI events stitch into one funnel; fall back to the per-install
    // id only when signed out. `surface` + `cli_version` let funnel queries split
    // web vs cli and tell who's on the latest plugin.
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
    const p = join(import.meta.dir, "..", ".claude-plugin", "plugin.json");
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

// ── transport ────────────────────────────────────────────────────────────────
// Establish (or restore) this machine's guest identity. The server mints a real
// Instant guest and hands back its refresh token; we store the opaque string and
// send it as a Bearer. No InstantDB client here.
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
// On push, local image refs (<img src="./x.png">, url(./x.png)) are uploaded to
// drafty's object store and rewritten to served URLs in the *published* content.
// The on-disk file is left untouched, so it stays small and Read/Edit-able for
// the agent instead of bloating with base64. Remote/data:/already-hosted refs
// are left alone. The bytes go to /get/api/asset — the CLI never holds the store
// token (consistent with every other op).
const ASSET_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);
const ASSET_CONTENT_TYPE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
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
  const res = await fetch(`${BASE_URL}/get/api/asset?ext=${encodeURIComponent(ext)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": ASSET_CONTENT_TYPE[ext] || "application/octet-stream" },
    body: bytes,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) die(data.error || `asset upload failed (${res.status})`);
  return data.url as string;
}

// Upload every local image ref once, then rewrite only within matched <img src>
// / url(...) contexts so a filename can't accidentally match elsewhere.
async function uploadLocalAssets(content: string, file: string): Promise<string> {
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  const cssRe = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  const refs = new Set<string>();
  for (const re of [imgRe, cssRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) if (isLocalAssetRef(m[1].trim())) refs.add(m[1].trim());
  }
  if (!refs.size) return content;

  const dir = dirname(resolve(file));
  const map = new Map<string, string>();
  for (const ref of refs) {
    const path = resolve(dir, ref.split(/[?#]/)[0]);
    const f = Bun.file(path);
    if (!(await f.exists())) { console.error(`  ⚠ skipping missing asset: ${ref}`); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const url = await uploadAssetBytes(bytes, refExt(ref));
    map.set(ref, url);
    console.log(`  ⬆ ${ref}`);
  }
  if (!map.size) return content;

  const rewrite = (full: string, ref: string) =>
    map.has(ref.trim()) ? full.replace(ref, map.get(ref.trim())!) : full;
  return content
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi, rewrite)
    .replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, rewrite);
}

// ── commands ────────────────────────────────────────────────────────────────
async function canvasPush(args: string[]) {
  const file = args[0];
  if (!file) return die("usage: drafty canvas push <file> [--title T] [--slug S] [--mode M] [--format html|markdown] [--project P] [--tag T …]");
  const content = await Bun.file(file).text();
  if (!content.trim()) return die(`file is empty: ${file}`);
  // --format html|markdown is an explicit override; otherwise sniff content+extension.
  const formatFlag = flag(args, "format");
  if (formatFlag !== undefined && formatFlag !== "html" && formatFlag !== "markdown")
    return die(`--format must be html or markdown (got "${formatFlag}")`);
  const format = (formatFlag as "html" | "markdown" | undefined) ?? inferFormat(file, content);
  const title = flag(args, "title") || inferTitle(content, format, file);
  const mode = parseMode(flag(args, "mode"));
  const visibility = parseVisibility(args);
  const slug = flag(args, "slug");
  // Organize flags, parsed up front so a bad value fails before anything publishes.
  const project = flag(args, "project");
  const tags = multiFlag(args, "tag");
  // Upload local images → served URLs in the published copy; the file on disk is
  // left as-is (small + editable). Titles are inferred from the original content.
  const published = await uploadLocalAssets(content, file);
  // targetSlug = update intent (exact); newSlug = pre-hashed slug if we create.
  const r = await api("canvas.push", {
    body: { content: published, format, title, targetSlug: slug, newSlug: slugify(slug || title), ...(mode ? { mode } : {}), ...(visibility ? { visibility } : {}) },
  });
  if (r.created) {
    console.log(`✓ published "${r.title}"  ·  ${modeLabel[r.mode as Mode]}`);
  } else {
    console.log(`✓ updated "${r.title}"`);
    if (mode) console.log(`  ${modeLine(mode, r.slug)}`);
  }
  if (visibility) console.log(`  visibility: ${visibilityLabel[visibility]}`);
  // ?ref=cli attributes views of a freshly-published link back to the CLI publish
  // (the start of the creator→commenter→creator loop).
  console.log(`  ${url(r.slug)}?ref=cli`);

  // Organize at publish time: any --project/--tag flags are applied in a single
  // setmeta call, so the agent files a canvas under its initiative + kind as it
  // ships, instead of leaving it loose. Tags are additive (re-pushing keeps
  // existing ones); project overwrites.
  if (project !== undefined || tags.length) {
    const meta: Record<string, unknown> = { slug: r.slug };
    if (project !== undefined) meta.project = project;
    if (tags.length) meta.addTags = tags;
    const summary = fmtMeta(await api("canvas.set", { body: meta }));
    if (summary) console.log(`  ${summary}`);
  }

  if (r.created && r.mode === "feedback") {
    console.log(`  Claude waits for your go — run \`drafty canvas mode ${r.slug} live\` to work comments live`);
  }
  // First canvas ever → the server seeded a starter thread. Walk them through
  // the one rep that is the product: see the comment, have Claude answer it.
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
  const slug = args[0];
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
    console.log(`[${a.status === "completed" ? "✓ done" : "● open"}] ${anchorLabel(a)}`);
    console.log(`  ann: ${a.id}`);
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

async function canvasRestore(args: string[]) {
  const [slug, revisionId] = args;
  if (!slug || !revisionId) return die("usage: drafty canvas restore <slug> <revisionId>");
  await api("canvas.restore", { body: { slug, revisionId } });
  console.log(`✓ restored ${slug} to revision ${revisionId}`);
}

// Download the artifact body. Content goes to stdout (newline-terminated) so it
// pipes/redirects cleanly; metadata goes to stderr. --revision pulls a past
// version (ids come from `drafty canvas versions`); -o/--out writes a file instead.
async function canvasPull(args: string[]) {
  const slug = args[0];
  if (!slug || slug.startsWith("--")) return die("usage: drafty canvas pull <slug> [--revision <id>] [-o <file>] [--json]");
  const revisionId = flag(args, "revision") || flag(args, "rev");
  const outIdx = args.indexOf("-o");
  const out = flag(args, "out") || (outIdx >= 0 ? args[outIdx + 1] : undefined);
  const r = await api("canvas.pull", { method: "GET", query: { slug, ...(revisionId ? { revisionId } : {}) } });
  if (has(args, "json")) {
    console.log(JSON.stringify({ slug, title: r.title, format: r.format, revisionId: r.revisionId, createdAt: r.createdAt, content: r.content }, null, 2));
  } else {
    const ver = r.revisionId ? `revision ${r.revisionId}` : "current";
    console.error(`# ${r.title} — ${url(slug)}`);
    console.error(`  ${r.format} · ${ver}${r.createdAt ? ` · ${new Date(r.createdAt).toLocaleString()}` : ""}`);
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
  const slug = args[0];
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
  const slug = args[0];
  const mode = parseMode(args[1]);
  if (!slug || !mode) return die(`usage: drafty canvas mode <slug> <${MODES.join("|")}>`);
  await api("canvas.mode", { body: { slug, mode } });
  console.log(`✓ ${slug} is ${modeLabel[mode]}`);
  console.log(`  ${modeLine(mode, slug)}`);
}

// Change who can view an existing canvas. `private` is sugar for `invite`.
async function canvasVisibility(args: string[]) {
  const slug = args[0];
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
  const slug = args[0];
  if (!slug || slug.startsWith("--")) return die(`usage: drafty canvas ${archived ? "archive" : "unarchive"} <slug>`);
  await api("canvas.set", { body: { slug, archived } });
  if (archived) console.log(`✓ archived ${slug} — hidden from \`drafty canvas ls\` (link still opens); show with --archived`);
  else console.log(`✓ unarchived ${slug} — back in \`drafty canvas ls\``);
}

// Pin/unpin: a stick flag. Pinned canvases hold the "Pinned" lane on drafty.im/home
// (between Live and Recent) so a long-lived canvas never sinks into Recent as newer
// ones publish. Orthogonal to status/archive — it only affects list position.
async function canvasPin(args: string[], pinned: boolean) {
  const slug = args[0];
  if (!slug || slug.startsWith("--")) return die(`usage: drafty canvas ${pinned ? "pin" : "unpin"} <slug>`);
  await api("canvas.set", { body: { slug, pinned } });
  if (pinned) console.log(`✓ pinned ${slug} — held in the Pinned lane on your home, above Recent`);
  else console.log(`✓ unpinned ${slug} — back in Recent`);
}

// Cross-cutting labels for what a canvas *is* (plan, research, testing-report…).
// `tag` adds, `untag` removes (or --all clears). The server normalises + dedupes
// and returns the resulting set, which we echo back.
async function canvasTag(args: string[], add: boolean) {
  const slug = args[0];
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
  const slug = args[0];
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
  const slug = args.find((a) => !a.startsWith("--"));
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
    console.log(`• ${it.slug} — ${anchorLabel(it)}`);
    console.log(`  ${it.lastAuthor}: ${it.lastComment}`);
    console.log(`  ann: ${it.annotationId}\n`);
  }
  if (!slug && !has(args, "all") && r.parked) {
    console.log(`${r.parked} canvas${r.parked > 1 ? "es are" : " is"} collecting feedback — not shown. add --all to include.`);
  }
}

async function commentsWatch(args: string[]) {
  const slug = args[0];
  if (!slug) return die("usage: drafty comments watch <slug> [--json] [--backlog]");
  const asJson = has(args, "json");
  const token = await getToken();
  if (!asJson) console.error(`👀 watching ${url(slug)} — new comments will appear here\n`);

  let stop = false;
  process.on("SIGINT", () => { stop = true; process.exit(0); });

  const emit = (ev: any) => {
    if (asJson) {
      console.log(JSON.stringify({ annotationId: ev.annotationId, anchorTag: ev.anchorTag, anchorText: ev.anchorText, anchors: ev.anchors ?? null, anchorFx: ev.anchorFx ?? null, anchorFy: ev.anchorFy ?? null, status: ev.status, author: ev.author, body: ev.body, createdAt: ev.createdAt }));
    } else {
      console.log(`[${shortTime(ev.createdAt)}] ${ev.author} on ${anchorLabel(ev)}`);
      console.log(`  ${ev.body}`);
      console.log(`  ↳ reply: drafty comments reply ${ev.annotationId} "..."   resolve: drafty comments resolve ${ev.annotationId}\n`);
    }
  };

  // SSE connections don't live forever — a serverless host (Vercel) caps a
  // function's duration, so the stream WILL drop periodically. Reconnect so the
  // doorbell stays armed for the whole session. Comments that land during the
  // brief reconnect gap are caught by the next `inbox` reconcile (the doorbell
  // wakes you; inbox is the source of truth). Only the first connect honours
  // --backlog; reconnects start fresh so old comments aren't replayed.
  let attempt = 0;
  while (!stop) {
    const qs = new URLSearchParams({ slug, ...(has(args, "backlog") && attempt === 0 ? { backlog: "1" } : {}) });
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
          if (ev.ev === "comment") emit(ev);
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

// ── canvas management (owner-scoped via perms) ───────────────────────────────
function requireYes(args: string[], what: string) {
  if (!has(args, "yes")) die(`${what} is destructive — re-run with --yes to confirm.`);
}

async function canvasRename(args: string[]) {
  const slug = args[0];
  const title = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!slug || !title) return die('usage: drafty canvas rename <slug> "<new name>"');
  await api("canvas.rename", { body: { slug, title } });
  console.log(`✓ renamed to "${title}"`);
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
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) return die("usage: drafty comments clear <slug> --yes");
  requireYes(args, `clearing all threads on ${slug}`);
  const r = await api("comments.clear", { body: { slug } });
  console.log(`✓ cleared ${r.threads ?? 0} thread(s) on ${slug}`);
}

async function canvasRm(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
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

  if (!has(args, "archived") && !has(args, "all")) items = items.filter((d) => !d.archived);
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
  const slug = args[0];
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
      const p = Bun.spawnSync(["git", ...cmd], { cwd, stdout: "pipe", stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString().trim() || null : null;
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
  if (unfiled) console.log(`Unfiled:     ${unfiled} missing a project or tags — \`drafty canvas ls --unfiled\`, then \`drafty canvas set <slug> …\``);

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
  // Claiming is the conversion moment — pin the canvas to a real account, not a
  // throwaway guest. If the stored identity is still a guest, sign in first.
  if (me.isGuest) {
    console.error("Claiming keeps this canvas under your Drafty account — sign in first:");
    console.error(`  drafty login          opens your browser to sign in`);
    console.error(`then re-run:  DRAFTY_TOKEN=… drafty canvas claim ${slug}`);
    process.exit(1);
  }
  await api("canvas.claim", { token: provisionToken, body: { slug, newCreatorId: me.userId } });
  const who = me.email ? ` (${me.email})` : "";
  console.error(`✓ claimed — ${url(slug)} is yours now${who}. It won't expire, and it's in \`drafty canvas ls\`.`);
  // The demo→real conversion event — the activation funnel's bottom.
  await track("canvas.claimed", { slug });
}

// ── auth (email magic-code) ───────────────────────────────────────────────────
// Sign in by opening the browser. The /cli-auth page authenticates (magic-code,
// later Google) and POSTs the resulting session token back to a one-shot
// loopback listener we run here — so one action signs you in on BOTH the web and
// this CLI. Local-only by design: the browser must reach 127.0.0.1 on this
// machine. After sign-in we fold any canvases the prior guest made into the new
// account.
async function login() {
  const oldToken = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  let oldGuestId = "";
  if (oldToken) {
    try { const me = await api("whoami", { method: "GET", token: oldToken }); if (me.isGuest) oldGuestId = me.userId; } catch { /* ignore */ }
  }

  const state = crypto.randomUUID();
  let resolveCb!: (token: string) => void;
  let rejectCb!: (e: Error) => void;
  const got = new Promise<string>((res, rej) => { resolveCb = res; rejectCb = rej; });

  const allowOrigin = new URL(BASE_URL).origin;
  const cors = { "access-control-allow-origin": allowOrigin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" };
  const json = (b: unknown, status: number, origin: string | null) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json", ...(origin === allowOrigin ? { "access-control-allow-origin": origin } : {}) } });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const origin = req.headers.get("origin");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, ...(origin === allowOrigin ? { "access-control-allow-origin": origin } : {}) } });
      const u = new URL(req.url);
      if (u.pathname !== "/callback" || req.method !== "POST") return json({ ok: false }, 404, origin);
      if (origin !== allowOrigin) return json({ ok: false }, 403, origin); // only our web origin may hand a token back
      try {
        const body = (await req.json()) as { token?: string; state?: string };
        if (body.state !== state || !body.token) return json({ ok: false }, 400, origin);
        // Resolve on the next tick so this 200 flushes to the browser *before*
        // the main flow stops the server — otherwise the page sees a dropped
        // connection and shows a false error even though we got the token.
        const tok = body.token;
        setTimeout(() => resolveCb(tok), 50);
        return json({ ok: true }, 200, origin);
      } catch {
        return json({ ok: false }, 400, origin);
      }
    },
  });

  const d = Buffer.from(JSON.stringify({ port: server.port, state })).toString("base64url");
  const authUrl = `${BASE_URL}/cli-auth?d=${d}`;
  await track("auth.started", { method: "browser" });
  console.error("Opening your browser to sign in…");
  console.error(`  ${authUrl}`);
  openBrowser(authUrl);

  const timer = setTimeout(() => rejectCb(new Error("timed out waiting for the browser — re-run `drafty login`")), 180000);
  let token: string;
  try { token = await got; } catch (e) { server.stop(true); return die((e as Error).message); }
  clearTimeout(timer);
  server.stop(); // graceful — let the in-flight 200 finish flushing to the browser

  // Valid token in hand — store it first so login can't fail past this point.
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  await track("auth.completed", { method: "browser" });

  // Best-effort: identify (for the confirmation line) and fold guest canvases in.
  // Raw fetches, never `api()` — a hiccup here must not undo a successful sign-in.
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
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch { /* user can click the printed URL */ }
}

// Drop the stored identity; the next command mints a fresh guest.
function logout() {
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE, { force: true });
  clearIdentity(); // explicit sign-out — drop the marker so we don't warn about it
  console.error("✓ signed out — a new guest identity will be created on next use");
}

// ── setup / health ────────────────────────────────────────────────────────────
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
  bunV ? pass("bun runtime", `v${bunV}`) : fail("bun runtime", "not running under bun — install from bun.sh");

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const probe = join(STATE_DIR, ".doctor");
    writeFileSync(probe, "ok"); rmSync(probe);
    pass("state dir writable", STATE_DIR);
  } catch {
    fail("state dir writable", STATE_DIR);
  }

  // user-level (global) or any project-level .claude/ in an ancestor of cwd
  let skillAt = existsSync(SKILL_DST) ? SKILL_DST : null;
  for (let dir = process.cwd(); !skillAt; ) {
    const p = join(dir, ".claude", "skills", "drafty", "SKILL.md");
    if (existsSync(p)) { skillAt = p; break; }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  skillAt ? pass("skill installed", skillAt) : fail("skill not installed", "run `drafty setup` to register it for Claude Code");

  const launcher = Bun.which("drafty");
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
  const cliDir = import.meta.dir;
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
  writeFileSync(
    launcher,
    `#!/bin/sh\n# drafty CLI launcher — installed by \`drafty setup\`. Works in interactive\n# and non-interactive shells (an alias would not). Source: ${join(cliDir, "canvas.ts")}\nexec bun ${join(cliDir, "canvas.ts")} "$@"\n`,
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
  drafty canvas push <file> [--title T] [--slug S] [--mode M] [--visibility public|authed|invite] [--private] [--project P] [--tag T …]   publish/update + file it
  drafty canvas ls [--project P] [--tag T] [--unfiled] [--archived] [--json]   list your canvases
  drafty canvas show <slug>                meta: title, link, project, tags, mode, threads
  drafty canvas pull <slug> [--revision id] [-o f]   download the content
  drafty canvas versions <slug> [--json]   list a canvas's versions, newest first
  drafty canvas restore <slug> <revisionId>   restore to a past version
  drafty canvas rename <slug> "<title>"
  drafty canvas set <slug> [--project P|--no-project] [--tag T…] [--untag T…] [--clear-tags]   organize
  drafty canvas tag <slug> <label…> / untag <slug> <label…>   add/remove kind labels
  drafty canvas archive <slug> / unarchive <slug>   hide from / restore to \`canvas ls\`
  drafty canvas pin <slug> / unpin <slug>   hold in / release from the Pinned lane on your home
  drafty canvas mode <slug> <readonly|feedback|live>   how it behaves when shared
  drafty canvas visibility <slug> <public|authed|invite|private>   who can view it (invite/private = owner + invited only)
  drafty canvas rm <slug> --yes            remove a canvas entirely
  drafty canvas claim <slug>               keep a provisional canvas (DRAFTY_TOKEN=<provision token>)

COMMENTS — threads pinned to a canvas, and their replies
  drafty comments ls <slug> [--json] [--open]   threads + replies on a canvas
  drafty comments inbox [slug] [--json] [--all]   fresh threads that need Claude
  drafty comments watch <slug> [--json] [--backlog]   stream new comments live (SSE doorbell)
  drafty comments reply <annotationId> "<message>"   reply in a thread as Claude
  drafty comments working <annotationId>      shimmer the thread while you work on it
  drafty comments resolve <annotationId> / reopen <annotationId>   toggle a thread's done state
  drafty comments rm <annotationId>           delete a thread (+ its replies)
  drafty comments rm-reply <commentId>        delete a single reply
  drafty comments clear <slug> --yes          delete all threads on a canvas

  drafty context [--limit N] [--archived] [--json]   one-shot orientation: identity, git, projects, tags + recent canvases
  drafty changelog [--json]                   what shipped, by week
  drafty login / logout                       sign in (browser; web + CLI) / sign out
  drafty whoami                               show your identity
  drafty setup                                register the skill + launcher, then run doctor
  drafty doctor                               preflight: bun, state dir, skill, server, identity

Identity starts as a guest token (stored in ~/.drafty); \`drafty login\` upgrades
it into a real account in place. Point at another server with DRAFTY_BASE_URL.
`;

// Namespaced verb tables — `drafty <namespace> <verb> [args]`. The namespace
// disambiguates same-named verbs (`canvas ls` vs `comments ls`).
type Cmd = (args: string[]) => unknown;
const CANVAS: Record<string, Cmd> = {
  push: canvasPush, ls: canvasLs, show: canvasShow, pull: canvasPull,
  versions: canvasVersions, restore: canvasRestore, rename: canvasRename,
  set: canvasSet, tag: (a) => canvasTag(a, true), untag: (a) => canvasTag(a, false),
  archive: (a) => canvasArchive(a, true), unarchive: (a) => canvasArchive(a, false),
  pin: (a) => canvasPin(a, true), unpin: (a) => canvasPin(a, false),
  mode: canvasMode, visibility: canvasVisibility, rm: canvasRm, claim: canvasClaim,
};
const COMMENTS: Record<string, Cmd> = {
  ls: commentsLs, inbox: commentsInbox, watch: commentsWatch, reply: commentsReply, working: commentsWorking,
  resolve: (a) => commentsStatus(a, "completed"), reopen: (a) => commentsStatus(a, "open"),
  rm: commentsRm, "rm-reply": commentsRmReply, clear: commentsClear,
};
// Top-level: session / meta — not scoped to a canvas or a comment.
const TOP: Record<string, Cmd> = { context, changelog, login, logout, whoami, setup, doctor };

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
  if (head && TOP[head]) return TOP[head](rest);
  console.log(HELP);
  if (head && !["help", "--help", "-h"].includes(head)) process.exit(1);
}

main()
  .then(async () => { await maybeNudgeUpdate(); process.exit(0); })
  .catch((e) => die(e?.message ?? String(e)));
