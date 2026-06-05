#!/usr/bin/env bun
// drafty CLI — publish docs to drafty.im/canvas/<slug>, then read and reply to
// feedback as Claude.
//
// A thin HTTP/SSE client: it holds a per-user guest token (minted by the server,
// stored under ~/.drafty) and drives everything through the public /get/api
// endpoints. No InstantDB dependency, no native deps — installs anywhere.
import { basename, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const BASE_URL = process.env.DRAFTY_BASE_URL || "https://drafty.im";
const STATE_DIR = join(homedir(), ".drafty");
const TOKEN_FILE = join(STATE_DIR, "token");
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
            user_id: analyticsId(),
            anonymous_id: null,
            session_id: null,
            properties: JSON.stringify({ ...props, source: "drafty-cli" }),
          },
        }],
      }),
    });
  } catch { /* best-effort */ }
}
const SKILL_DST = join(homedir(), ".claude", "skills", "drafty", "SKILL.md");

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
function inferFormat(file: string): "markdown" | "html" {
  return /\.html?$/i.test(file) ? "html" : "markdown";
}
function inferTitle(content: string, format: string, file: string): string {
  if (format === "markdown") {
    const m = content.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } else {
    const t = content.match(/<title[^>]*>([^<]+)<\/title>/i) || content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (t) return t[1].trim();
  }
  return basename(file).replace(/\.[^.]+$/, "");
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(`--${name}`);
const url = (slug: string) => `${BASE_URL}/canvas/${slug}`;
const shortTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
  if (mode === "feedback") return `people can comment; Claude waits for your go — run \`drafty mode ${slug} live\``;
  return "Claude works new comments as they arrive";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anchorLabel(a: any): string {
  const grp = Array.isArray(a.anchors) ? a.anchors : null;
  if (grp && grp.length > 1) {
    const parts = grp.slice(0, 3).map((x: any) => `<${x.tag}> "${x.text}"`).join(" + ");
    const more = grp.length > 3 ? ` + ${grp.length - 3} more` : "";
    return `${grp.length} elements — ${parts}${more}`;
  }
  return `<${a.anchorTag}> "${a.anchorText}"`;
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
  const res = await fetch(`${BASE_URL}/get/api/auth`, { method: "POST" });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) die(`couldn't establish a Drafty identity (${res.status}). Is ${BASE_URL} reachable?`);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, data.token, { mode: 0o600 });
  return data.token;
}

type ApiOpts = { method?: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string>; token?: string };
async function api(op: string, opts: ApiOpts = {}): Promise<any> {
  // Most ops act as *you* (the stored identity). `claim` is the exception — it
  // must authorize with the canvas's provision token, so callers pass it in.
  const token = opts.token ?? (await getToken());
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const res = await fetch(`${BASE_URL}/get/api/${op}${qs}`, {
    method: opts.method ?? "POST",
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) die(data.error || `${op} failed (${res.status})`);
  return data;
}

// ── commands ────────────────────────────────────────────────────────────────
async function push(args: string[]) {
  const file = args[0];
  if (!file) return die("usage: drafty push <file> [--title T] [--description D] [--slug S] [--mode M]");
  const content = await Bun.file(file).text();
  if (!content.trim()) return die(`file is empty: ${file}`);
  const format = inferFormat(file);
  const title = flag(args, "title") || inferTitle(content, format, file);
  // One-line summary of the artifact for the link unfurl (og:description). The
  // publishing agent writes this — it has the full content in context.
  const description = flag(args, "description");
  const mode = parseMode(flag(args, "mode"));
  const slug = flag(args, "slug");
  // targetSlug = update intent (exact); newSlug = pre-hashed slug if we create.
  const r = await api("push", {
    body: { content, format, title, targetSlug: slug, newSlug: slugify(slug || title), ...(description ? { description } : {}), ...(mode ? { mode } : {}) },
  });
  if (r.created) {
    console.log(`✓ published "${r.title}"  ·  ${modeLabel[r.mode as Mode]}`);
  } else {
    console.log(`✓ updated "${r.title}"`);
    if (mode) console.log(`  ${modeLine(mode, r.slug)}`);
  }
  console.log(`  ${url(r.slug)}`);
  if (r.created && r.mode === "feedback") {
    console.log(`  Claude waits for your go — run \`drafty mode ${r.slug} live\` to work comments live`);
  }
  await track("canvas.published", { slug: r.slug, created: !!r.created, format, mode: r.mode });
}

async function list(args: string[]) {
  const slug = args[0];
  if (!slug) return die("usage: drafty list <slug> [--json] [--open]");
  const r = await api("list", { method: "GET", query: { slug } });
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

async function reply(args: string[]) {
  const [annId, ...rest] = args;
  const body = rest.join(" ").trim();
  if (!annId || !body) return die('usage: drafty reply <annotationId> "<message>"');
  await api("reply", { body: { annotationId: annId, body } });
  console.log(`✓ replied to ${annId}`);
  await track("agent.replied", { annotationId: annId });
}

async function working(args: string[]) {
  const annId = args[0];
  if (!annId) return die("usage: drafty working <annotationId>");
  await api("working", { body: { annotationId: annId } });
  console.log(`✦ working on ${annId} (shimmering on the canvas)`);
  await track("agent.working", { annotationId: annId });
}

async function setStatus(args: string[], status: "open" | "completed") {
  const annId = args[0];
  if (!annId) return die(`usage: drafty ${status === "completed" ? "resolve" : "reopen"} <annotationId>`);
  await api(status === "completed" ? "resolve" : "reopen", { body: { annotationId: annId } });
  console.log(`✓ ${status === "completed" ? "resolved" : "reopened"} ${annId}`);
  await track(status === "completed" ? "thread.resolved" : "thread.reopened", { annotationId: annId, by: "agent" });
}

async function restore(args: string[]) {
  const [slug, revisionId] = args;
  if (!slug || !revisionId) return die("usage: drafty restore <slug> <revisionId>");
  await api("restore", { body: { slug, revisionId } });
  console.log(`✓ restored ${slug} to revision ${revisionId}`);
}

async function setMode(args: string[]) {
  const slug = args[0];
  const mode = parseMode(args[1]);
  if (!slug || !mode) return die(`usage: drafty mode <slug> <${MODES.join("|")}>`);
  await api("mode", { body: { slug, mode } });
  console.log(`✓ ${slug} is ${modeLabel[mode]}`);
  console.log(`  ${modeLine(mode, slug)}`);
}

async function inbox(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
  const scope = has(args, "all") ? "all" : "live";
  const query: Record<string, string> = { scope };
  if (slug) query.slug = slug;
  const r = await api("inbox", { method: "GET", query });
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

async function watch(args: string[]) {
  const slug = args[0];
  if (!slug) return die("usage: drafty watch <slug> [--json] [--backlog]");
  const asJson = has(args, "json");
  const token = await getToken();
  if (!asJson) console.error(`👀 watching ${url(slug)} — new comments will appear here\n`);

  let stop = false;
  process.on("SIGINT", () => { stop = true; process.exit(0); });

  const emit = (ev: any) => {
    if (asJson) {
      console.log(JSON.stringify({ annotationId: ev.annotationId, anchorTag: ev.anchorTag, anchorText: ev.anchorText, anchors: ev.anchors ?? null, status: ev.status, author: ev.author, body: ev.body, createdAt: ev.createdAt }));
    } else {
      console.log(`[${shortTime(ev.createdAt)}] ${ev.author} on ${anchorLabel(ev)}`);
      console.log(`  ${ev.body}`);
      console.log(`  ↳ reply: drafty reply ${ev.annotationId} "..."   resolve: drafty resolve ${ev.annotationId}\n`);
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
      const res = await fetch(`${BASE_URL}/get/api/watch?${qs}`, {
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

async function rename(args: string[]) {
  const slug = args[0];
  const title = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!slug || !title) return die('usage: drafty rename <slug> "<new name>"');
  await api("rename", { body: { slug, title } });
  console.log(`✓ renamed to "${title}"`);
}

async function rmComment(args: string[]) {
  const commentId = args[0];
  if (!commentId) return die("usage: drafty rm-comment <commentId>");
  await api("rm-comment", { body: { commentId } });
  console.log(`✓ deleted comment ${commentId}`);
}

async function rmThread(args: string[]) {
  const annId = args[0];
  if (!annId) return die("usage: drafty rm-thread <annotationId>");
  const r = await api("rm-thread", { body: { annotationId: annId } });
  console.log(`✓ deleted thread ${annId} (+${r.comments ?? 0} comments)`);
}

async function clearCanvas(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) return die("usage: drafty clear <slug> --yes");
  requireYes(args, `clearing all threads on ${slug}`);
  const r = await api("clear", { body: { slug } });
  console.log(`✓ cleared ${r.threads ?? 0} thread(s) on ${slug}`);
}

async function rm(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) return die("usage: drafty rm <slug> --yes");
  requireYes(args, `removing canvas ${slug}`);
  await api("rm", { body: { slug } });
  console.log(`✓ removed canvas ${slug}`);
}

async function docs() {
  const r = await api("docs", { method: "GET" });
  const items = r.items as any[];
  if (!items.length) console.log("(no canvases yet — publish one with `drafty push <file>`)");
  for (const d of items) console.log(`${d.slug}\t${d.open} open\t${d.title}`);
}

// Take ownership of a provisional canvas an agent minted. The provision token
// (which owns the canvas) authorizes the transfer; the new owner is *you*, the
// stored identity. The agent that created the canvas holds that token — pass it
// via DRAFTY_TOKEN or --token. After this the canvas stops being ephemeral and
// shows up in `drafty docs`.
async function claim(args: string[]) {
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) return die("usage: DRAFTY_TOKEN=<provision token> drafty claim <slug>");
  const provisionToken = process.env.DRAFTY_TOKEN || flag(args, "token");
  if (!provisionToken) {
    return die(
      "claim needs the canvas's provision token (the agent that created it holds it).\n" +
        `  run:  DRAFTY_TOKEN=<token from /get/provision> drafty claim ${slug}`,
    );
  }
  const me = await api("whoami", { method: "GET" }); // my identity = the new owner
  // Claiming is the conversion moment — pin the canvas to a real account, not a
  // throwaway guest. If the stored identity is still a guest, sign in first.
  if (me.isGuest) {
    console.error("Claiming keeps this canvas under your Drafty account — sign in first:");
    console.error(`  drafty login          opens your browser to sign in`);
    console.error(`then re-run:  DRAFTY_TOKEN=… drafty claim ${slug}`);
    process.exit(1);
  }
  await api("claim", { token: provisionToken, body: { slug, newCreatorId: me.userId } });
  const who = me.email ? ` (${me.email})` : "";
  console.error(`✓ claimed — ${url(slug)} is yours now${who}. It won't expire, and it's in \`drafty docs\`.`);
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
  console.error("✓ signed out — a new guest identity will be created on next use");
}

// ── setup / health ────────────────────────────────────────────────────────────
async function whoami() {
  const r = await api("whoami", { method: "GET" });
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

const HELP = `drafty — share docs for annotation, read & reply to feedback

  drafty push <file> [--title T] [--slug S] [--mode M]   publish/update a doc
  drafty mode <slug> <readonly|feedback|live> set how the canvas behaves when shared
  drafty list <slug> [--json] [--open]        snapshot all threads + comments
  drafty inbox [slug] [--json] [--all]        fresh threads that need Claude (one-shot)
  drafty watch <slug> [--json] [--backlog]    stream new comments live (SSE doorbell)
  drafty reply <annotationId> "<message>"     reply in a thread as Claude
  drafty working <annotationId>               shimmer the thread while you work on it
  drafty resolve <annotationId>               mark a thread complete (clears shimmer)
  drafty reopen <annotationId>                reopen a thread
  drafty restore <slug> <revisionId>          restore the doc to a past version
  drafty docs                                 list your canvases
  drafty claim <slug>                         keep a provisional canvas (DRAFTY_TOKEN=<provision token>)

  drafty login                                sign in (opens your browser; signs in web + CLI)
  drafty logout                               drop the stored identity (back to a fresh guest)

  drafty rename <slug> "<new name>"           rename a canvas
  drafty rm-comment <commentId>               delete one comment
  drafty rm-thread <annotationId>             delete a thread (annotation + its comments)
  drafty clear <slug> --yes                   delete all threads on a canvas
  drafty rm <slug> --yes                      remove a canvas entirely

  drafty setup                                register the skill + launcher, then run doctor
  drafty doctor                               preflight: bun, state dir, skill, server, identity
  drafty whoami                               show your canvas identity

Identity starts as a guest token (stored in ~/.drafty); \`drafty login\` upgrades
it into a real account in place. Point at another server with DRAFTY_BASE_URL.
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "push": return push(args);
    case "mode": return setMode(args);
    case "list": case "pull": return list(args);
    case "inbox": case "pending": return inbox(args);
    case "watch": return watch(args);
    case "reply": case "comment": return reply(args);
    case "working": case "wip": return working(args);
    case "resolve": case "done": return setStatus(args, "completed");
    case "reopen": return setStatus(args, "open");
    case "restore": return restore(args);
    case "docs": case "ls": return docs();
    case "claim": return claim(args);
    case "login": case "signin": return login();
    case "logout": case "signout": return logout();
    case "rename": return rename(args);
    case "rm-comment": return rmComment(args);
    case "rm-thread": return rmThread(args);
    case "clear": return clearCanvas(args);
    case "rm": return rm(args);
    case "setup": return setup();
    case "doctor": return doctor();
    case "whoami": case "me": return whoami();
    default:
      console.log(HELP);
      if (cmd && !["help", "--help", "-h"].includes(cmd)) process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => die(e?.message ?? String(e)));
