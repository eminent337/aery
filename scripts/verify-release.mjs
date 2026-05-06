import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(command, args) {
	try {
		return execFileSync(command, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `unavailable (${message})`;
	}
}

const packageJson = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf-8"));
const localVersion = packageJson.version;
const npmVersion = run("npm", ["view", "@eminent337/aery", "version"]);
const releaseJson = run("gh", ["release", "view", "--repo", "eminent337/aery", "--json", "tagName,url,publishedAt"]);

console.log(`local package: @eminent337/aery@${localVersion}`);
console.log(`npm package:   @eminent337/aery@${npmVersion}`);

if (releaseJson.startsWith("{")) {
	const release = JSON.parse(releaseJson);
	console.log(`github tag:    ${release.tagName}`);
	console.log(`published at:  ${release.publishedAt}`);
	console.log(`release url:   ${release.url}`);
} else {
	console.log(`github release: ${releaseJson}`);
}

if (npmVersion === localVersion) {
	console.log("status:        local and npm versions match");
} else {
	console.log("status:        local and npm versions differ");
	process.exitCode = 1;
}
