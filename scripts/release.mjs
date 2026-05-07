#!/usr/bin/env node
/**
 * Dispatch the repository's GitHub publish workflow.
 *
 * Aery does not use lockstep package versions: @eminent337/aery, aery-ai,
 * and aery-core are intentionally bumped independently by publish.yml.
 * Keeping local release commands as workflow dispatches avoids duplicating
 * that release logic and prevents stale local version assumptions.
 */

import { execFileSync } from "node:child_process";

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const allowedTargets = new Set(["patch"]);

function usage(exitCode = 1) {
	console.error("Usage: node scripts/release.mjs patch [--dry-run]");
	console.error("");
	console.error("This command dispatches .github/workflows/publish.yml on main.");
	console.error("Minor, major, and explicit versions are not supported by the current GitHub publish workflow.");
	process.exit(exitCode);
}

function run(command, args, options = {}) {
	const printable = [command, ...args].join(" ");
	console.log(`$ ${printable}`);
	if (dryRun && options.mutates) {
		return "";
	}
	return execFileSync(command, args, { encoding: "utf8", stdio: options.silent ? "pipe" : "inherit" });
}

if (!target || process.argv.includes("--help") || process.argv.includes("-h")) {
	usage(target ? 0 : 1);
}

if (!allowedTargets.has(target)) {
	console.error(`Unsupported release target: ${target}`);
	usage(1);
}

const branch = run("git", ["branch", "--show-current"], { silent: true }).trim();
if (branch !== "main") {
	console.error(`Release must be dispatched from main. Current branch: ${branch || "(detached)"}`);
	process.exit(1);
}

const status = run("git", ["status", "--porcelain"], { silent: true });
if (status.trim()) {
	console.error("Release requires a clean working tree:");
	console.error(status);
	process.exit(1);
}

run("git", ["fetch", "origin", "main"], { mutates: true });

const local = run("git", ["rev-parse", "HEAD"], { silent: true }).trim();
const remote = run("git", ["rev-parse", "origin/main"], { silent: true }).trim();
if (local !== remote) {
	console.error("Local main must match origin/main before dispatching a release.");
	console.error(`local:  ${local}`);
	console.error(`origin: ${remote}`);
	console.error("Push or pull first, then rerun the release command.");
	process.exit(1);
}

run("gh", ["workflow", "run", "publish.yml", "--repo", "eminent337/aery", "--ref", "main"], { mutates: true });

console.log("");
if (dryRun) {
	console.log("Dry run complete. No GitHub workflow was dispatched.");
} else {
	console.log("Publish workflow dispatched for main.");
	console.log("Track it with: gh run list --repo eminent337/aery --workflow 'Publish on Push' --limit 1");
}
