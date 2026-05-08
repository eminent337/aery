import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ledgerPath = "AERY_CUSTOMIZATIONS.md";
const since = process.argv.includes("--since")
	? process.argv[process.argv.indexOf("--since") + 1]
	: "30 days ago";

function runGit(args) {
	try {
		return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function expandSimpleGlob(pattern) {
	const starIndex = pattern.indexOf("*");
	if (starIndex === -1) return [pattern].filter((path) => existsSync(path));

	const before = pattern.slice(0, starIndex);
	const after = pattern.slice(starIndex + 1);
	const baseDir = before.endsWith("/") ? before.slice(0, -1) : before.replace(/\/[^/]*$/, "");
	if (!baseDir || !existsSync(baseDir) || !statSync(baseDir).isDirectory()) return [];

	return readdirSync(baseDir)
		.map((entry) => join(baseDir, entry, after.replace(/^\//, "")))
		.filter((candidate) => existsSync(candidate));
}

function extractSections(markdown) {
	const sectionRegex = /^### (.+)$/gm;
	const sections = [];
	let match;
	while ((match = sectionRegex.exec(markdown))) {
		sections.push({ title: match[1], start: match.index, bodyStart: sectionRegex.lastIndex });
	}
	return sections.map((section, index) => ({
		title: section.title,
		body: markdown.slice(section.bodyStart, sections[index + 1]?.start ?? markdown.length),
	}));
}

function extractOwnedPaths(sectionBody) {
	const heading = "Owned files and hooks:\n";
	const headingIndex = sectionBody.indexOf(heading);
	if (headingIndex === -1) return [];
	const afterHeading = sectionBody.slice(headingIndex + heading.length);
	const nextHeadingIndex = afterHeading.search(/\n[A-Z][A-Za-z ]+:\n/);
	const block = nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex);
	return block
		.split("\n")
		.map((line) => line.trim().match(/^- `([^`]+)`$/)?.[1])
		.filter(Boolean)
		.flatMap(expandSimpleGlob)
		.sort();
}

function recentChangesFor(path) {
	const output = runGit(["log", `--since=${since}`, "--format=%h %cs %s", "--", path]);
	return output ? output.split("\n").slice(0, 5) : [];
}

const ledger = readFileSync(ledgerPath, "utf-8");
const sections = extractSections(ledger);
const upstreamSensitive = [
	"packages/agent",
	"packages/ai",
	"packages/coding-agent",
	"packages/tui",
	".github/workflows/upstream-sync.yml",
	"scripts/check-aery-customizations.mjs",
	"scripts/check-aery-branding.mjs",
];

console.log("# Aery Ownership Report");
console.log("");
console.log(`Generated from ${ledgerPath}`);
console.log(`Recent change window: ${since}`);
console.log("");

for (const section of sections) {
	const ownedPaths = extractOwnedPaths(section.body);
	console.log(`## ${section.title}`);
	console.log("");
	if (ownedPaths.length === 0) {
		console.log("- No repository-owned paths listed.");
		console.log("");
		continue;
	}
	for (const path of ownedPaths) {
		console.log(`- ${path}`);
		const changes = recentChangesFor(path);
		for (const change of changes) {
			console.log(`  - ${change}`);
		}
	}
	console.log("");
}

console.log("## Upstream-Sensitive Areas");
console.log("");
for (const path of upstreamSensitive) {
	console.log(`- ${path}`);
	const changes = recentChangesFor(path);
	for (const change of changes) {
		console.log(`  - ${change}`);
	}
}
