#!/usr/bin/env bun
// Local contract smoke for the CLI half of the canvas claim registry.
// Runs the real TypeScript entrypoint under both supported runtimes against a
// tiny HTTP/SSE stub; no Drafty account or web checkout required.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Call = { path: string; body: Record<string, unknown> };
type WatchCall = { scenario: string; url: string };
const calls: Call[] = [];
const watchCalls: WatchCall[] = [];
const streams = new Set<ServerResponse>();
const keepalives = new Map<ServerResponse, ReturnType<typeof setInterval>>();
let watchScenario = "steady";

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const path = requestUrl.pathname;
  if (path === "/get/api/comments.watch") {
    const scenario = watchScenario;
    watchCalls.push({ scenario, url: requestUrl.toString() });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    const scenarioAttempt = watchCalls.filter((call) => call.scenario === scenario).length;
    if (scenario.includes("cursor-") && scenarioAttempt === 1) {
      for (const createdAt of [1_700_000_000_001, 1_700_000_000_003, 1_700_000_000_002]) {
        res.write(`data: ${JSON.stringify({ ev: "comment", slug: "cursor-canvas", annotationId: `ann-${createdAt}`, author: "stub", body: "cursor", createdAt })}\n\n`);
      }
      setTimeout(() => res.end(), 5);
      return;
    }
    if (scenario.endsWith("-stall") && scenarioAttempt === 1) {
      streams.add(res);
      res.on("close", () => { streams.delete(res); });
      return;
    }
    res.write(": connected\n\n");
    streams.add(res);
    keepalives.set(res, setInterval(() => res.write(": keepalive\n\n"), 10));
    res.on("close", () => {
      streams.delete(res);
      const timer = keepalives.get(res);
      if (timer) clearInterval(timer);
      keepalives.delete(res);
    });
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path, body });
    res.setHeader("content-type", "application/json");
    if (path === "/get/api/canvas.heartbeat" && body.slug === "heartbeat-fails") {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: "stub heartbeat failure" }));
    } else if (path === "/get/api/canvas.claim-status") {
      const fresh = body.slug === "fresh-claim";
      res.end(JSON.stringify({ ok: true, handlerBy: fresh ? "session:fresh@stub" : "daemon:stale", handlerSeenAt: Date.now() - (fresh ? 1_000 : 301_000) }));
    } else if (path === "/get/api/canvas.push") {
      res.end(JSON.stringify({ ok: true, slug: "shape-slug", title: "Shape", mode: "feedback", created: false, rev: 1 }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("stub did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;
const cli = resolve(import.meta.dirname, "..", "plugins", "drafty", "cli", "canvas.ts");

function expect(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

async function run(runtime: "bun" | "node", home: string, args: string[], env: Record<string, string | undefined> = {}, interruptAfterClaim = false, cwd?: string): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    const callStart = calls.length;
    const child = spawn(runtime, [...(runtime === "node" ? ["--disable-warning=ExperimentalWarning"] : []), cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        DRAFTY_BASE_URL: base,
        DRAFTY_NO_ANALYTICS: "1",
        DRAFTY_NO_UPDATE_CHECK: "1",
        DRAFTY_STATE_DIR: undefined,
        DRAFTY_HANDLER_ID: undefined,
        CLAUDE_CODE_SESSION_ID: undefined,
        ...env,
      },
      cwd: cwd ?? home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const interrupt = interruptAfterClaim ? setInterval(() => {
      if (calls.slice(callStart).some((call) => call.path === "/get/api/canvas.heartbeat" && call.body.clear !== true)) {
        clearInterval(interrupt);
        child.kill("SIGINT");
      }
    }, 5) : undefined;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (interrupt) clearInterval(interrupt);
      code === 0 ? resolveRun(stdout) : reject(new Error(`${runtime} ${args.join(" ")} exited ${code}:\n${stdout}${stderr}`));
    });
  });
}

try {
  for (const runtime of ["bun", "node"] as const) {
    const home = mkdtempSync(join(tmpdir(), `drafty-claims-${runtime}-`));
    mkdirSync(join(home, ".drafty"), { recursive: true });
    writeFileSync(join(home, ".drafty", "token"), "stub-token\n");
    const canvas = join(home, "shape.md");
    writeFileSync(canvas, "# Shape\n");

    let start = calls.length;
    const heartbeatOut = await run(runtime, home, ["canvas", "heartbeat", "manual-heartbeat", "--handler-id", "daemon:override", "--clear"]);
    const manualHeartbeat = calls.slice(start).find((call) => call.path === "/get/api/canvas.heartbeat");
    expect(heartbeatOut === "", `${runtime}: heartbeat should be quiet on success`);
    expect(manualHeartbeat?.body.handlerId === "daemon:override" && manualHeartbeat.body.clear === true, `${runtime}: heartbeat override/clear payload is wrong`);
    const heartbeatJson = await run(runtime, home, ["canvas", "heartbeat", "manual-heartbeat", "--json"], { CLAUDE_CODE_SESSION_ID: "session-json" });
    expect(JSON.parse(heartbeatJson).ok === true, `${runtime}: heartbeat --json did not print the acknowledgement`);

    const freshClaim = JSON.parse(await run(runtime, home, ["canvas", "claim-status", "fresh-claim", "--json"]));
    const staleClaim = JSON.parse(await run(runtime, home, ["canvas", "claim-status", "stale-claim", "--json"]));
    expect(freshClaim.slug === "fresh-claim" && freshClaim.handlerBy === "session:fresh@stub" && freshClaim.fresh === true, `${runtime}: fresh claim-status shape is wrong`);
    expect(staleClaim.slug === "stale-claim" && staleClaim.handlerBy === "daemon:stale" && staleClaim.fresh === false, `${runtime}: stale claim-status freshness is wrong`);

    start = calls.length;
    await run(runtime, home, ["comments", "watch", "one-canvas", "--json", "--for", "80ms"], { CLAUDE_CODE_SESSION_ID: "session-123" });
    const heartbeats = calls.slice(start).filter((call) => call.path === "/get/api/canvas.heartbeat");
    expect(heartbeats.length === 2, `${runtime}: slug watch should claim once and clear once; got ${JSON.stringify(heartbeats)}`);
    expect(heartbeats[0].body.slug === "one-canvas", `${runtime}: heartbeat slug missing`);
    expect(heartbeats[0].body.handlerId === `session:session-123@${hostname()}`, `${runtime}: session handlerId shape is wrong`);
    expect(heartbeats[0].body.clear === undefined, `${runtime}: connect heartbeat unexpectedly clears`);
    expect(heartbeats[1].body.clear === true, `${runtime}: expiry heartbeat does not clear`);

    start = calls.length;
    await run(runtime, home, ["comments", "watch", "sigint-canvas", "--json"], { DRAFTY_HANDLER_ID: "daemon:stub" }, true);
    const sigintHeartbeats = calls.slice(start).filter((call) => call.path === "/get/api/canvas.heartbeat");
    expect(sigintHeartbeats.length === 2, `${runtime}: SIGINT should claim once and clear once`);
    expect(sigintHeartbeats[1].body.clear === true, `${runtime}: SIGINT heartbeat does not clear`);

    await run(runtime, home, ["comments", "watch", "heartbeat-fails", "--json", "--for", "40ms"]);

    start = calls.length;
    await run(runtime, home, ["comments", "watch", "--live", "--json", "--for", "40ms"], { DRAFTY_HANDLER_ID: "daemon:stub" });
    expect(!calls.slice(start).some((call) => call.path === "/get/api/canvas.heartbeat"), `${runtime}: --live must not heartbeat`);

    for (const live of [false, true]) {
      watchScenario = `${runtime}-${live ? "cursor-live" : "cursor-slug"}`;
      const watchStart = watchCalls.length;
      await run(runtime, home, ["comments", "watch", ...(live ? ["--live"] : ["cursor-canvas"]), "--json", "--for", "1800ms"]);
      const reconnects = watchCalls.slice(watchStart).map((call) => new URL(call.url));
      expect(reconnects.length >= 2, `${runtime}: ${live ? "live" : "slug"} cursor stream did not reconnect`);
      expect(!reconnects[0].searchParams.has("since"), `${runtime}: first ${live ? "live" : "slug"} connect unexpectedly sent since`);
      expect(reconnects[1].searchParams.get("since") === "1700000000003", `${runtime}: ${live ? "live" : "slug"} reconnect did not send the max createdAt`);
    }

    watchScenario = `${runtime}-stall`;
    const stallStart = watchCalls.length;
    await run(runtime, home, ["comments", "watch", "stall-canvas", "--json", "--for", "1800ms"], { DRAFTY_WATCH_STALL_MS: "25" });
    const stallReconnects = watchCalls.slice(stallStart).map((call) => new URL(call.url));
    expect(stallReconnects.length >= 2, `${runtime}: byte-silent stream was not aborted and reconnected`);
    expect(!stallReconnects[0].searchParams.has("since"), `${runtime}: first stalled-stream connect unexpectedly sent since`);
    watchScenario = "steady";

    await run(runtime, home, ["comments", "working", "ann-daemon"], {
      DRAFTY_HANDLER_ID: "daemon:stub",
      CLAUDE_CODE_SESSION_ID: "ignored-session",
    });
    await run(runtime, home, ["comments", "reply", "ann-session", "hello"], { CLAUDE_CODE_SESSION_ID: "session-456" });
    await run(runtime, home, ["canvas", "push", canvas, "--slug", "shape-slug"], { DRAFTY_HANDLER_ID: "daemon:stub" });
    expect(!readdirSync(join(home, ".drafty")).includes("canvases.json"), `${runtime}: push outside a git repo changed canvases.json`);

    const repo = join(home, "repo");
    mkdirSync(repo);
    const init = spawnSync("git", ["init", "--quiet"], { cwd: repo });
    expect(init.status === 0, `${runtime}: could not create test git repo`);
    const repoCanvas = join(repo, "repo-shape.md");
    writeFileSync(repoCanvas, "# Repo Shape\n");
    writeFileSync(join(home, ".drafty", "canvases.json"), "{ corrupt\n");
    const pushedAt = Date.now();
    await run(runtime, home, ["canvas", "push", repoCanvas, "--slug", "shape-slug"], { DRAFTY_HANDLER_ID: "daemon:stub" }, false, repo);
    const canvasMap = JSON.parse(readFileSync(join(home, ".drafty", "canvases.json"), "utf8"));
    expect(canvasMap["shape-slug"]?.repo === realpathSync(repo), `${runtime}: canvases.json repo root is wrong`);
    expect(typeof canvasMap["shape-slug"]?.updatedAt === "number" && canvasMap["shape-slug"].updatedAt >= pushedAt, `${runtime}: canvases.json updatedAt is wrong`);
    expect(!readdirSync(join(home, ".drafty")).some((name) => name.startsWith("canvases.json.") && name.endsWith(".tmp")), `${runtime}: atomic write left a temp file`);
    await run(runtime, home, ["comments", "working", "ann-anon"]);

    const daemonWorking = calls.findLast((call) => call.path === "/get/api/comments.working" && call.body.annotationId === "ann-daemon");
    const sessionReply = calls.findLast((call) => call.path === "/get/api/comments.reply" && call.body.annotationId === "ann-session");
    const push = calls.findLast((call) => call.path === "/get/api/canvas.push");
    const anonWorking = calls.findLast((call) => call.path === "/get/api/comments.working" && call.body.annotationId === "ann-anon");
    expect(daemonWorking?.body.handlerId === "daemon:stub", `${runtime}: injected handlerId did not win on comments.working`);
    expect(sessionReply?.body.handlerId === `session:session-456@${hostname()}`, `${runtime}: session handlerId missing on comments.reply`);
    expect(push?.body.handlerId === "daemon:stub", `${runtime}: handlerId missing on canvas.push`);
    expect(!Object.hasOwn(anonWorking?.body ?? {}, "handlerId"), `${runtime}: anonymous touch should omit handlerId`);
    console.log(`  ✓ ${runtime}: claims, reconnect cursors, stall watchdog, touch payloads, and repo write-through`);
    rmSync(home, { recursive: true, force: true });
  }
} finally {
  for (const stream of streams) stream.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

console.log("OK claim contract smoke green.");
