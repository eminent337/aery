// ─── Public SDK Barrel ────────────────────────────────────────────────────────
//
// Import everything from "@aryee337/aery-sdk" to get the full SDK surface.
// For tree-shaking-friendly imports, use the subpath exports:
//
//   import type { AeryTool } from "@aryee337/aery-sdk/tools";
//   import type { AeryEventName } from "@aryee337/aery-sdk/events";
//   import type { SwarmAwareExtensionAPI } from "@aryee337/aery-sdk/swarm";

export * from "./commands";
export * from "./context";
export * from "./events";
export * from "./extension";
export * from "./swarm";
export * from "./tools";
export * from "./types";
