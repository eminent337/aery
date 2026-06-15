import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@aryee337/aery/extensibility/extensions/loader";
import { getAgentDir, getPluginsDir, setAgentDir, TempDir } from "@aryee337/aery-utils";

const currentAeryPath = Bun.resolveSync("@aryee337/aery", import.meta.dir);
const currentPiExtensionsPath = Bun.resolveSync("@aryee337/aery/extensibility/extensions", import.meta.dir);

describe("plugin extension discovery", () => {
	let projectDir: TempDir;
	let tempXdgDataHome = "";
	let originalXdgDataHome: string | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(() => {
		projectDir = TempDir.createSync("@aery-plugin-ext-");
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempXdgDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "aery-plugin-data-"));
		fs.mkdirSync(path.join(tempXdgDataHome, "aery"), { recursive: true });
		process.env.XDG_DATA_HOME = tempXdgDataHome;
		spyOn(os, "homedir").mockReturnValue(tempXdgDataHome);
		// Rebuild path caches after changing XDG env so plugin discovery resolves into the temp root.
		setAgentDir(originalAgentDir);

		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "@demo", "plugin");
		fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "aery-plugins",
				private: true,
				dependencies: {
					"@demo/plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "@demo/plugin",
				version: "1.0.0",
				aery: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "dist", "extension.ts"),
			`
				export default function(aery) {
					aery.registerCommand("plugin-ext", { handler: async () => {} });
				}
			`,
		);
	});

	afterEach(() => {
		mock.restore();
		projectDir.removeSync();
		fs.rmSync(tempXdgDataHome, { recursive: true, force: true });
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		setAgentDir(originalAgentDir);
	});

	it("loads installed plugin extensions declared in package.json", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path.endsWith(path.join("dist", "extension.ts")));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("plugin-ext")).toBe(true);
	});

	it("loads installed legacy Aery plugin extensions from Windows drive-letter paths", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "legacy-aery-plugin");
		const extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.rmSync(path.join(pluginsDir, "node_modules"), { recursive: true, force: true });
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "aery-plugins",
				private: true,
				dependencies: {
					"legacy-aery-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-aery-plugin",
				version: "1.0.0",
				aery: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import * as nodePath from "path";',
				'if (false) import("./optional-missing.js");',
				'import { isToolCallEventType as legacyRoot } from "@eminent337/pi-coding-agent";',
				'import { isToolCallEventType as legacyExtensions } from "@eminent337/pi-coding-agent/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentAeryPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				'if (typeof nodePath.join !== "function") throw new Error("node builtin import did not resolve");',
				"",
				"export default function(aery) {",
				"\tconst { Type } = aery.typebox;",
				"\taery.registerTool({",
				'\t\tname: "legacy-aery-ext",',
				'\t\tdescription: "Legacy Aery extension smoke test",',
				"\t\tparameters: Type.Object({}),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"\t});",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		if (process.platform === "win32") {
			expect(extensionPath).toMatch(/^[A-Za-z]:\\/);
		}
		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.tools.has("legacy-aery-ext")).toBe(true);
	});

	it("loads installed plugin extensions whose manifest entry points at a directory with index.ts", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "dir-entry-plugin");
		const extensionDir = path.join(pluginDir, ".aery", "extensions", "dir-entry");
		const extensionPath = path.join(extensionDir, "index.ts");
		fs.rmSync(path.join(pluginsDir, "node_modules"), { recursive: true, force: true });
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "aery-plugins",
				private: true,
				dependencies: {
					"dir-entry-plugin": "1.0.0",
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "dir-entry-plugin",
				version: "1.0.0",
				aery: {
					// Directory entry — loader must resolve to the directory's index file.
					extensions: [".aery/extensions/dir-entry"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(aery) {",
				'\taery.registerCommand("dir-entry-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path.includes(path.join("dir-entry-plugin", ".aery")));

		expect(pluginError).toBeUndefined();
		expect(extension).toBeDefined();
		expect(extension?.commands.has("dir-entry-ext")).toBe(true);
	});
});
