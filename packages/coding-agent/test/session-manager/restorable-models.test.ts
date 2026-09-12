import { describe, expect, test } from "bun:test";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	getRestorableSessionModels,
} from "@aryee337/aery/session/session-manager";

describe("getRestorableSessionModels (resume model restore, omp parity)", () => {
	test("ephemeral fallback role restores the default model, not the transient one", () => {
		const models = { default: "openai/gpt-5", [EPHEMERAL_MODEL_CHANGE_ROLE]: "anthropic/claude-fallback" };
		expect(getRestorableSessionModels(models, EPHEMERAL_MODEL_CHANGE_ROLE)).toEqual(["openai/gpt-5"]);
	});

	test("'temporary' role still restores the switched model (user's explicit session model)", () => {
		const models = { default: "openai/gpt-5", temporary: "deepseek/deepseek-v4" };
		expect(getRestorableSessionModels(models, "temporary")).toEqual(["deepseek/deepseek-v4", "openai/gpt-5"]);
	});

	test("ephemeral constant matches omp upstream value", () => {
		expect(EPHEMERAL_MODEL_CHANGE_ROLE).toBe("fallback");
	});
});
