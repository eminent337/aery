import { describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	test("registers extensions diagnostics command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "extensions",
			description: "Show extension diagnostics (/extensions doctor)",
		});
	});
});
