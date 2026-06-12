#!/usr/bin/env bun
// CLI preflight — the self-contained gate that must pass before the plugin
// ships (release.ts runs it; run it yourself before a plain `git push`, since
// an un-pinned plugin ships by commit SHA). The CLI is one file with no test
// suite, so the floor is: it parses, and it loads + dispatches without
// crashing. That alone catches the "syntax error / bad import / crash-on-load
// shipped to every user" class.
//
// This does NOT exercise the HTTP contract — that needs a drafty.im server and
// lives in the WEB repo's ship-check (web/scripts/cli-check.sh drives this exact
// binary against a throwaway app). For a CLI-only change that touches request/
// response handling, also run scripts/cli-smoke.sh against a local web dev
// server (or prod) before pushing.
import { $ } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, readFileSync } from "fs";

const CLI = join(import.meta.dir, "..", "plugins", "drafty", "cli", "canvas.ts");
let failed = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { console.log(`  ✗ ${m}`); failed++; };

// 1. Parse + bundle: catches syntax errors and unresolved imports.
try {
  await $`bun build ${CLI} --target bun --outfile /dev/null`.quiet();
  ok("canvas.ts parses + bundles");
} catch (e) {
  bad(`canvas.ts failed to build:\n${(e as { stderr?: Buffer }).stderr ?? e}`);
}

// 1b. Runtime portability: the CLI must run under plain Node (≥22.18, native
//     type stripping), so bun-only globals and meta fields must never come back.
//     `Bun.<api>` and `import.meta.dir` (the bun-only spelling — the regex's \b
//     does not match inside `import.meta.dirname`, which is fine in both).
{
  const src = readFileSync(CLI, "utf8");
  const bunisms = src.match(/\bBun\.\w+|import\.meta\.dir\b/g) ?? [];
  if (bunisms.length) bad(`bun-only API in canvas.ts (breaks Node): ${[...new Set(bunisms)].join(", ")}`);
  else ok("no bun-only APIs in the source");
}

// 2. Load + dispatch: an isolated HOME so a real ~/.drafty is never touched.
//    --help is offline (no server), so it proves the binary boots and the
//    command tables resolve.
const ISO = mkdtempSync(join(tmpdir(), "drafty-preflight-"));
try {
  const help = await $`bun ${CLI} --help`.env({ ...process.env, HOME: ISO }).text();
  if (help.includes("drafty") && help.includes("canvas push")) ok("binary boots + prints the command surface");
  else bad("--help output is missing the expected command surface");
} catch (e) {
  bad(`binary crashed on --help:\n${e}`);
}

// 3. A signed-out op fails with the friendly "Not signed in", not a stack trace
//    — the dispatch + error path is intact.
try {
  // The friendly error is printed via die() → stderr, so capture both streams.
  const res = await $`bun ${CLI} whoami`.env({ ...process.env, HOME: ISO }).nothrow().quiet();
  const out = res.stdout.toString() + res.stderr.toString();
  if (/Not signed in/i.test(out)) ok("signed-out op gives the friendly error, not a crash");
  else bad(`signed-out whoami unexpected output: ${out.slice(0, 120)}`);
} catch (e) {
  bad(`whoami crashed: ${e}`);
}

// 4. The same boot + signed-out checks under NODE — the other supported runtime.
//    Catches non-erasable TS syntax (parameter properties, enums) and runtime
//    bun-isms the grep can't see. Skipped (loudly) when node isn't installed.
const nodeBin = Bun.which("node");
if (!nodeBin) {
  console.log("  - node not on PATH — node-boot checks skipped (install Node ≥22.18 to gate both runtimes)");
} else {
  const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]; // same flags as the bin/ launcher
  try {
    const help = await $`${nodeBin} ${NODE_FLAGS} ${CLI} --help`.env({ ...process.env, HOME: ISO }).text();
    if (help.includes("drafty") && help.includes("canvas push")) ok(`binary boots under node (${(await $`${nodeBin} --version`.text()).trim()})`);
    else bad("--help under node is missing the expected command surface");
  } catch (e) {
    bad(`binary crashed on --help under node:\n${e}`);
  }
  try {
    const res = await $`${nodeBin} ${NODE_FLAGS} ${CLI} whoami`.env({ ...process.env, HOME: ISO }).nothrow().quiet();
    const out = res.stdout.toString() + res.stderr.toString();
    if (/Not signed in/i.test(out)) ok("signed-out op under node gives the friendly error");
    else bad(`signed-out whoami under node unexpected output: ${out.slice(0, 120)}`);
  } catch (e) {
    bad(`whoami under node crashed: ${e}`);
  }
}

console.log("");
if (failed > 0) {
  console.error(`CLI preflight FAILED (${failed}) — do not ship.`);
  process.exit(1);
}
console.log("OK CLI preflight green.");
