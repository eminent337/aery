import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [
	"package.json",
	"scripts",
	"packages/agent/src",
	"packages/ai/src",
	"packages/coding-agent/src",
	"packages/mom/src",
	"packages/pods/src",
	"packages/tui/src",
	"packages/web-ui/src",
	"packages/agent/package.json",
	"packages/ai/package.json",
	"packages/coding-agent/package.json",
	"packages/mom/package.json",
	"packages/pods/package.json",
	"packages/tui/package.json",
	"packages/web-ui/package.json",
];

const ignoredFiles = new Set(["scripts/check-aery-branding.mjs"]);

const forbidden = [
	{ label: "upstream npm scope", pattern: /@mariozechner\/pi[\w-]*/g },
	{ label: "upstream repository", pattern: /badlogic\/pi-mono/g },
	{ label: "upstream site", pattern: /pi\.dev/g },
	{ label: "upstream config path", pattern: /(?:~\/)?\.pi(?=\/|\\|"|'|`)/g },
	{ label: "upstream env var", pattern: /(?<![A-Z])PI_[A-Z0-9_]+/g },
	{ label: "upstream temp/log name", pattern: /pi-(?:browser|startup|debug|crash)/g },
];

function* walk(path) {
	if (!existsSync(path)) return;

	const stats = statSync(path);
	if (stats.isFile()) {
		yield path;
		return;
	}

	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "vendor") continue;
		yield* walk(join(path, entry.name));
	}
}

function isTextFile(path) {
	return /\.(cjs|js|json|jsx|mjs|ts|tsx)$/.test(path) || path.endsWith("package.json");
}

const errors = [];
for (const root of roots) {
	for (const file of walk(root)) {
		if (ignoredFiles.has(file) || !isTextFile(file)) continue;
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");

		for (const rule of forbidden) {
			rule.pattern.lastIndex = 0;
			let match;
			while ((match = rule.pattern.exec(content))) {
				const lineNumber = content.slice(0, match.index).split("\n").length;
				const line = lines[lineNumber - 1]?.trim() ?? "";
				errors.push(`${file}:${lineNumber}: ${rule.label}: ${match[0]} :: ${line}`);
			}
		}
	}
}

if (errors.length > 0) {
	console.error("Aery branding check failed:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

console.log("Aery branding check ok");
