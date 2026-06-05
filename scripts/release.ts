#!/usr/bin/env bun
// Cut a Marky plugin release. Bumps the version in plugin.json, commits, tags,
// and pushes. Users then pull it with `claude plugin marketplace update marky-im`.
//
// Day-to-day you don't need this: a plain `git push` already ships the change
// (Claude Code versions an un-pinned plugin by commit SHA). Use this only for an
// intentional, human-readable version bump.
//
//   bun scripts/release.ts 0.1.1
import { $ } from "bun";

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+$/.test(v)) {
  console.error("usage: bun scripts/release.ts <semver>   e.g. 0.1.1");
  process.exit(1);
}

const manifest = "plugins/marky/.claude-plugin/plugin.json";
const j = JSON.parse(await Bun.file(manifest).text());
const prev = j.version;
j.version = v;
await Bun.write(manifest, JSON.stringify(j, null, 2) + "\n");

await $`git add -A`;
await $`git commit -q -m ${`Release v${v}`}`;
await $`git tag ${`v${v}`}`;
await $`git push -q origin main --tags`;

console.log(`✓ released v${prev} → v${v}`);
console.log(`  users update with:  claude plugin marketplace update marky-im`);
