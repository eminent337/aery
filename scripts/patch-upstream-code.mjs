#!/usr/bin/env node
/**
 * scripts/patch-proxy-ts.mjs
 *
 * Applies Aery-specific tsgo compatibility fixes to packages/agent/src/proxy.ts
 * after every upstream sync. Upstream uses "const response = await fetch(...)"
 * which tsgo fails on because the agent tsconfig uses lib: ["ES2022"] — no DOM
 * types — so "Response" is unknown. We cast to "any" to bypass this.
 *
 * Safe to run multiple times (idempotent).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";

const path = "packages/agent/src/proxy.ts";
if (!existsSync(path)) {
	console.log("proxy.ts: not found, skipping");
	process.exit(0);
}

let src = readFileSync(path, "utf-8");
const orig = src;

// Fix 1: open the fetch call paren for cast
src = src.replace(
	"const response = await fetch(`",
	"const response = (await fetch(`",
);

// Fix 2: close fetch with )) as any (avoids needing DOM lib)
// Handles both LF and CRLF line endings
src = src
	.replace("})) as Response;", "})) as any;")
	.replace("\t\t\t});\n\n\t\t\tif (!response.ok)", "\t\t\t})) as any;\n\n\t\t\tif (!response.ok)")
	.replace("\t\t\t});\r\n\r\n\t\t\tif (!response.ok)", "\t\t\t})) as any;\r\n\r\n\t\t\tif (!response.ok)");

// Fix 3: simplify body access (any cast makes .body accessible without null check)
src = src
	.replace(
		/reader = response\.body!\.getReader\(\);/,
		"reader = (response.body as ReadableStream<Uint8Array>).getReader();",
	)
	.replace(
		/const rawBody = response\.body;\n\t+if \(!rawBody\) throw new Error\([^)]+\);\n\t+reader = \(rawBody as ReadableStream<Uint8Array>\)\.getReader\(\);/,
		"reader = (response.body as ReadableStream<Uint8Array>).getReader();",
	);

if (src !== orig) {
	writeFileSync(path, src);
	console.log("proxy.ts: patched (tsgo ES2022 lib compatibility fix applied)");
} else {
	console.log("proxy.ts: already clean");
}

const sdkPath = "packages/coding-agent/src/core/sdk.ts";
if (!existsSync(sdkPath)) {
	console.log("sdk.ts: not found, skipping");
	process.exit(0);
}

let sdkSrc = readFileSync(sdkPath, "utf-8");
const sdkOrig = sdkSrc;

// Fix 4: StreamFn type mismatch when bundling between workspace packages
sdkSrc = sdkSrc.replace(
	/attributionHeaders \|\| auth\.headers \|\| options\?\.headers\s+\? \{ \.\.\.attributionHeaders, \.\.\.auth\.headers, \.\.\.options\?\.headers \}\s+: undefined,\s+\}\);/,
	"attributionHeaders || auth.headers || options?.headers\n\t\t\t\t\t\t? { ...attributionHeaders, ...auth.headers, ...options?.headers }\n\t\t\t\t\t\t: undefined,\n\t\t\t}) as any;"
);

if (sdkSrc !== sdkOrig) {
	writeFileSync(sdkPath, sdkSrc);
	console.log("sdk.ts: patched (StreamFn type mismatch bypassed)");
} else {
	console.log("sdk.ts: already clean");
}

// Fix 5: Ensure coding-agent/package.json has bin: { aery: "dist/cli.js" }
// Upstream declares the binary as "pi" — we must rename it to "aery" so that
// `npm install -g @eminent337/aery` installs the `aery` command, not `pi`.
const pkgPath = "packages/coding-agent/package.json";
if (existsSync(pkgPath)) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	const bin = pkg.bin ?? {};
	const needsFix = !bin.aery || bin.pi;
	if (needsFix) {
		pkg.bin = { aery: bin.pi ?? bin.aery ?? "dist/cli.js" };
		writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
		console.log("coding-agent/package.json: patched bin pi → aery");
	} else {
		console.log("coding-agent/package.json: bin already set to aery");
	}
}
