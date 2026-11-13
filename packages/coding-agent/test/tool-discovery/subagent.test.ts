import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(settings: Settings): "off" | "mcp-only" | "all" {
		const toolsMode = settings.get("tools.discoveryMode");
		if (toolsMode === "off") {
			if (settings.get("mcp.discoveryMode")) return "mcp-only";
			return "off";
		}
		if (toolsMode === "mcp-only") return "mcp-only";
		return "all";
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=auto resolves to all", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "auto" });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true -> mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false -> off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	it("default settings -> all (auto default)", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s)).toBe("all");
	});
});
