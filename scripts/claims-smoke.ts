#!/usr/bin/env bun
// Local contract smoke for the CLI half of the canvas claim registry.
// Runs the real TypeScript entrypoint under both supported runtimes against a
// tiny HTTP/SSE stub; no Drafty account or web checkout required.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
const streams = new Set<ServerResponse>();
const keepalives = new Map<ServerResponse, ReturnType<typeof setInterval>>();

const server = createServer((req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (path === "/get/api/comments.watch") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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

async function run(runtime: "bun" | "node", home: string, args: string[], env: Record<string, string | undefined> = {}, interruptAfterClaim = false): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const callStart = calls.length;
    const child = spawn(runtime, [cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        DRAFTY_BASE_URL: base,
        DRAFTY_NO_ANALYTICS: "1",
        DRAFTY_NO_UPDATE_CHECK: "1",
        DRAFTY_HANDLER_ID: undefined,
        CLAUDE_CODE_SESSION_ID: undefined,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const interrupt = interruptAfterClaim ? setInterval(() => {
      if (calls.slice(callStart).some((call) => call.path === "/get/api/canvas.heartbeat" && call.body.clear !== true)) {
        clearInterval(interrupt);
        child.kill("SIGINT");
      }
    }, 5) : undefined;
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (interrupt) clearInterval(interrupt);
      code === 0 ? resolveRun() : reject(new Error(`${runtime} ${args.join(" ")} exited ${code}:\n${output}`));
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

    await run(runtime, home, ["comments", "working", "ann-daemon"], {
      DRAFTY_HANDLER_ID: "daemon:stub",
      CLAUDE_CODE_SESSION_ID: "ignored-session",
    });
    await run(runtime, home, ["comments", "reply", "ann-session", "hello"], { CLAUDE_CODE_SESSION_ID: "session-456" });
    await run(runtime, home, ["canvas", "push", canvas, "--slug", "shape-slug"], { DRAFTY_HANDLER_ID: "daemon:stub" });
    await run(runtime, home, ["comments", "working", "ann-anon"]);

    const daemonWorking = calls.findLast((call) => call.path === "/get/api/comments.working" && call.body.annotationId === "ann-daemon");
    const sessionReply = calls.findLast((call) => call.path === "/get/api/comments.reply" && call.body.annotationId === "ann-session");
    const push = calls.findLast((call) => call.path === "/get/api/canvas.push");
    const anonWorking = calls.findLast((call) => call.path === "/get/api/comments.working" && call.body.annotationId === "ann-anon");
    expect(daemonWorking?.body.handlerId === "daemon:stub", `${runtime}: injected handlerId did not win on comments.working`);
    expect(sessionReply?.body.handlerId === `session:session-456@${hostname()}`, `${runtime}: session handlerId missing on comments.reply`);
    expect(push?.body.handlerId === "daemon:stub", `${runtime}: handlerId missing on canvas.push`);
    expect(!Object.hasOwn(anonWorking?.body ?? {}, "handlerId"), `${runtime}: anonymous touch should omit handlerId`);
    console.log(`  ✓ ${runtime}: heartbeat lifecycle, --live exclusion, and touch payloads`);
    rmSync(home, { recursive: true, force: true });
  }
} finally {
  for (const stream of streams) stream.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

console.log("OK claim contract smoke green.");
