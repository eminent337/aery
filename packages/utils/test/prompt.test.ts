import { describe, expect, it } from "bun:test";
import { render } from "../src/prompt";

describe("prompt handlebars helpers", () => {
	it("supports has as a block helper", () => {
		const template = '{{#has tools "bash"}}yes{{else}}no{{/has}}';
		expect(render(template, { tools: ["read", "bash"] })).toBe("yes");
		expect(render(template, { tools: ["read"] })).toBe("no");
	});

	it("supports has as an inline subexpression helper in ifAny", () => {
		const template = '{{#ifAny (has tools "browser") (has tools "desktop_control")}}active{{else}}inactive{{/ifAny}}';
		expect(render(template, { tools: ["browser"] })).toBe("active");
		expect(render(template, { tools: ["desktop_control"] })).toBe("active");
		expect(render(template, { tools: ["read", "bash"] })).toBe("inactive");
	});
});
