import { describe, expect, test } from "vitest";
import { formatExtensionUpdateSuccessMessage } from "../src/package-manager-cli.js";

describe("package-manager CLI", () => {
	test("formats all-extension update success clearly", () => {
		expect(formatExtensionUpdateSuccessMessage()).toBe("Updated installed extensions");
	});

	test("formats single-extension update success clearly", () => {
		expect(formatExtensionUpdateSuccessMessage("github.com/eminent337/aery-extensions")).toBe(
			"Updated extension package github.com/eminent337/aery-extensions",
		);
	});
});
