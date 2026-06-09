import * as path from "node:path";
import { injectAeryExtensionCliRoots } from "./discovery/aery-extension-roots";

/**
 * Extension Bridge
 * Registers Aery's built-in extension packs (Architect, Superpowers, Design)
 * into AERY's internal extension discovery system.
 */
export function registerAeryExtensions(home: string, cwd: string): void {
	// Assuming this file is compiled into dist/
	// and aery is run from the monorepo root or packaged binary.
	// Actually, we can resolve relative to __dirname.
	// In the source tree: packages/coding-agent/src/extension-bridge.ts
	// The extensions are in: extensions/packs/architect

	const repoRoot = path.resolve(__dirname, "../../../");
	const packsDir = path.join(repoRoot, "extensions", "packs");

	const builtInPacks = [
		path.join(packsDir, "architect"),
		path.join(packsDir, "superpowers"),
		path.join(packsDir, "design"),
	];

	// Inject them as if they were provided via --extension CLI flags
	injectAeryExtensionCliRoots(builtInPacks, home, cwd);
}
