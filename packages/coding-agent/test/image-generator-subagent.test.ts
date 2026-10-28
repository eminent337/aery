import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../src/registry/agent-registry";
import {
	BUILTIN_SUBAGENTS,
	getBuiltinSubagentDefinition,
	listBuiltinSubagents,
} from "../src/registry/builtin-subagents";
import { ManageSubagentsTool } from "../src/tools/manage-subagents";

describe("Built-in image-generator Subagent with Self-Inspection Loop", () => {
	it("retrieves the image-generator subagent definition with correct role and tools", () => {
		const def = getBuiltinSubagentDefinition("image-generator");
		expect(def).toBeDefined();
		expect(def?.typeName).toBe("image-generator");
		expect(def?.role).toBe("Image Creator & Visual Editor");
		expect(def?.description).toContain("Generates or edits images");
		expect(def?.tools).toContain("image_gen");
		expect(def?.tools).toContain("inspect_image");
	});

	it("system prompt enforces prompt decomposition, image_gen, 3-attempt self-inspection loop, and artifact directory", () => {
		const def = getBuiltinSubagentDefinition("image-generator");
		expect(def).toBeDefined();
		const prompt = def!.systemPrompt;

		// 1. Prompt decomposition with subject, lighting, composition, style
		expect(prompt).toMatch(/decomposition/i);
		expect(prompt).toMatch(/subject/i);
		expect(prompt).toMatch(/lighting/i);
		expect(prompt).toMatch(/composition/i);
		expect(prompt).toMatch(/style/i);

		// 2. Calling image_gen
		expect(prompt).toContain("image_gen");

		// 3. 3-attempt self-inspection loop
		expect(prompt).toMatch(/3[- ]attempt/i);
		expect(prompt).toMatch(/self-inspection/i);

		// 4. Verifying image quality via inspect_image
		expect(prompt).toContain("inspect_image");
		expect(prompt).toMatch(/quality/i);

		// 5. Saving to <artifactDir>/images/
		expect(prompt).toContain("<artifactDir>/images/");
	});

	it("lists all built-in subagents including self, research, and image-generator", () => {
		const builtins = listBuiltinSubagents();
		const typeNames = builtins.map(b => b.typeName);

		expect(typeNames).toContain("self");
		expect(typeNames).toContain("research");
		expect(typeNames).toContain("image-generator");

		// BUILTIN_SUBAGENTS map contains each type
		expect(BUILTIN_SUBAGENTS.self).toBeDefined();
		expect(BUILTIN_SUBAGENTS.research).toBeDefined();
		expect(BUILTIN_SUBAGENTS["image-generator"]).toBeDefined();
	});

	it("is accessible via AgentRegistry global instance", () => {
		const registry = AgentRegistry.global();
		expect(typeof (registry as any).getBuiltinSubagent).toBe("function");
		expect(typeof (registry as any).listBuiltinSubagents).toBe("function");

		const def = (registry as any).getBuiltinSubagent("image-generator");
		expect(def).toBeDefined();
		expect(def?.typeName).toBe("image-generator");

		const all = (registry as any).listBuiltinSubagents();
		expect(all.map((b: any) => b.typeName)).toContain("image-generator");
	});

	it("integrates with ManageSubagentsTool to expose built-in subagents", async () => {
		const tool = new ManageSubagentsTool();
		const result = await tool.execute("call-list", { Action: "list" });
		expect(result).toBeDefined();
		expect(result.details).toBeDefined();
		expect((result.details as any).builtinSubagents).toBeDefined();
		const builtinNames = (result.details as any).builtinSubagents.map((b: any) => b.typeName);
		expect(builtinNames).toContain("image-generator");
	});
});
