import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ledgerPath = "AERY_CUSTOMIZATIONS.md";
const content = readFileSync(ledgerPath, "utf-8");
const errors = [];

function expandSimpleGlob(pattern) {
	const starIndex = pattern.indexOf("*");
	if (starIndex === -1) return [pattern];

	const before = pattern.slice(0, starIndex);
	const after = pattern.slice(starIndex + 1);
	const baseDir = before.endsWith("/") ? before.slice(0, -1) : before.replace(/\/[^/]*$/, "");
	if (!baseDir || !existsSync(baseDir) || !statSync(baseDir).isDirectory()) return [];

	return readdirSync(baseDir)
		.map((entry) => join(baseDir, entry, after.replace(/^\//, "")))
		.filter((candidate) => existsSync(candidate));
}

function extractSectionBlocks(markdown) {
	const sectionRegex = /^### (.+)$/gm;
	const sections = [];
	let match;
	while ((match = sectionRegex.exec(markdown))) {
		sections.push({ title: match[1], start: match.index, bodyStart: sectionRegex.lastIndex });
	}

	return sections.map((section, index) => {
		const next = sections[index + 1];
		return {
			title: section.title,
			body: markdown.slice(section.bodyStart, next ? next.start : markdown.length),
		};
	});
}

function extractBulletBlock(sectionBody, heading) {
	const headingIndex = sectionBody.indexOf(`${heading}:\n`);
	if (headingIndex === -1) return [];

	const afterHeading = sectionBody.slice(headingIndex + heading.length + 2);
	const nextHeadingIndex = afterHeading.search(/\n[A-Z][A-Za-z ]+:\n/);
	const block = nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex);
	return block
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim());
}

function extractBacktickedValue(bullet) {
	const match = bullet.match(/^`([^`]+)`$/);
	return match?.[1];
}

const sections = extractSectionBlocks(content);
for (const section of sections) {
	const ownedBullets = extractBulletBlock(section.body, "Owned files and hooks");
	const verificationBullets = extractBulletBlock(section.body, "Verification");

	if (ownedBullets.length === 0) {
		errors.push(`${section.title}: missing owned files and hooks`);
	}
	if (verificationBullets.length === 0) {
		errors.push(`${section.title}: missing verification commands`);
	}

	for (const bullet of ownedBullets) {
		const path = extractBacktickedValue(bullet);
		if (!path) {
			errors.push(`${section.title}: owned entry must be a single backticked path: ${bullet}`);
			continue;
		}

		const matches = path.includes("*") ? expandSimpleGlob(path) : [path].filter((candidate) => existsSync(candidate));
		if (matches.length === 0) {
			errors.push(`${section.title}: owned path does not exist: ${path}`);
		}
	}
}

if (errors.length > 0) {
	console.error("Aery customization ledger check failed:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

console.log(`Aery customization ledger ok: ${sections.length} sections checked`);
