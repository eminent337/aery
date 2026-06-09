/**
 * Regression: plugin extensions must resolve legacy scope imports across every scope
 * that has historically been used to publish or alias the internal packages.
 * The shim remaps all historical scopes to the same in-process bundled copy
 * so that plugins observe a single module registry regardless of which scope
 * name their peerDependencies happened to declare.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@aryee337/aery/extensibility/extensions/loader";
import { TempDir } from "@aryee337/aery-utils";

const canonicalCodingAgent = Bun.resolveSync("@aryee337/aery", import.meta.dir);
const canonicalCodingAgentExtensions = Bun.resolveSync("@aryee337/aery/extensibility/extensions", import.meta.dir);
const canonicalUtils = Bun.resolveSync("@aryee337/aery-utils", import.meta.dir);
const canonicalTui = Bun.resolveSync("@aryee337/aery-tui", import.meta.dir);
// Subpath remap: upstream `aery-ai/oauth` re-exported `utils/oauth/index`; the
// shim rewrites the legacy subpath onto its current home so plugins keep
// importing the upstream layout.
const canonicalAiOauth = Bun.resolveSync("@aryee337/aery-ai/utils/oauth", import.meta.dir);

interface AliasCase {
	id: string;
	aliasSpecifier: string;
	canonicalPath: string;
	symbol: string;
}

const CASES: readonly AliasCase[] = [
	// @aery self-import — canonical scope must still flow through the shim
	// so a duplicate copy is never dragged in from a plugin's own node_modules.
	{ id: "aery-utils", aliasSpecifier: "@aryee337/aery-utils", canonicalPath: canonicalUtils, symbol: "logger" },
	{ id: "aery-coding-agent", aliasSpecifier: "@aryee337/aery", canonicalPath: canonicalCodingAgent, symbol: "isToolCallEventType" },
	// @eminent337 — defends the original remap (regression: issue #973).
	{
		id: "eminent337-extensions",
		aliasSpecifier: "@eminent337/aery-coding-agent/extensibility/extensions",
		canonicalPath: canonicalCodingAgentExtensions,
		symbol: "isToolCallEventType",
	},
	// Subpath remap: legacy `aery-ai/oauth` should resolve to `aery-ai/utils/oauth`.
	{
		id: "eminent337-ai-oauth",
		aliasSpecifier: "@eminent337/aery-ai/oauth",
		canonicalPath: canonicalAiOauth,
		// `refreshOAuthToken` is exported by our `utils/oauth/index` and by
		// upstream's `oauth.d.ts`; it makes a stable probe across both layouts.
		symbol: "refreshOAuthToken",
	},
	// `Key` runtime helper restored on aery-tui (plannotator + rpiv-* import it).
	{
		id: "aery-tui-key",
		aliasSpecifier: "@aryee337/aery-tui",
		canonicalPath: canonicalTui,
		symbol: "Key",
	},
];

describe("aery-* scope aliases", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@aery-scope-aliases-");
		const pluginDir = path.join(projectDir.path(), "alias-probe-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "alias-probe-plugin",
				version: "1.0.0",
				aery: { extensions: ["./dist/extension.ts"] },
			}),
		);

		// Each case imports the same symbol via the aliased scope and via the
		// resolved canonical absolute path. The default factory throws unless the
		// two are object-identical, proving they came from a single module
		// instance.
		const lines: string[] = [];
		const checks: string[] = [];
		for (const [idx, c] of CASES.entries()) {
			lines.push(`import { ${c.symbol} as alias${idx} } from "${c.aliasSpecifier}";`);
			lines.push(`import { ${c.symbol} as canonical${idx} } from ${JSON.stringify(c.canonicalPath)};`);
			checks.push(
				`if (alias${idx} !== canonical${idx}) throw new Error(${JSON.stringify(
					`${c.aliasSpecifier} did not remap to the bundled copy (case ${c.id})`,
				)});`,
			);
		}

		fs.writeFileSync(
			extensionPath,
			[...lines, "", ...checks, "", "export default function(aery) {", "\t/* no-op */", "}"].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("remaps every aliased aery-* scope and known upstream subpath to the bundled in-process copy", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		expect(result.errors).toEqual([]);
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		expect(extension).toBeDefined();
	});
});
