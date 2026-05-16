#!/usr/bin/env node
/**
 * scripts/patch-proxy-ts.mjs
 *
 * Applies Aery-specific tsgo compatibility fixes to packages/agent/src/proxy.ts
 * after every upstream sync. Upstream uses "const response = await fetch(...)"
 * which tsgo's strict mode cannot type-narrow — we need an explicit cast.
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

// Fix 2: close the fetch call with )) as Response;
// Pattern: the closing \t\t\t}); of the fetch options object, followed by blank line + if
src = src.replace(
	"\t\t\t});\n\n\t\t\tif (!response.ok)",
	"\t\t\t})) as Response;\n\n\t\t\tif (!response.ok)",
);

// Fix 3: replace body!.getReader() with explicit null check (tsgo TS18048)
src = src.replace(
	"reader = response.body!.getReader();",
	"const _rb = response.body;\n\t\t\tif (!_rb) throw new Error(\"Proxy response has no body\");\n\t\t\treader = _rb.getReader();",
);

if (src !== orig) {
	writeFileSync(path, src);
	console.log("proxy.ts: patched (tsgo Response type fix applied)");
} else {
	console.log("proxy.ts: already clean");
}
