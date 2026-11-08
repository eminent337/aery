import { describe, expect, it } from "bun:test";
import {
	AppBridgeRegistry,
	AppBridgeTool,
	type AppProfile,
} from "../src/tools/app-bridge";

describe("AppBridge Registry and Pre-loaded Profiles", () => {
	it("pre-loads outlook profile with 8 actions", () => {
		const registry = new AppBridgeRegistry();
		const outlook = registry.getProfile("outlook");
		expect(outlook).toBeDefined();
		expect(outlook?.id).toBe("outlook");
		expect(outlook?.name).toBe("Outlook");

		const actions = registry.getAppActions("outlook");
		const expectedActions = [
			"send_mail",
			"create_draft",
			"create_reply_draft",
			"update_event",
			"respond_to_event",
			"delete_event",
			"modify_thread_labels",
			"batch_delete_messages",
		];
		expect(actions.length).toBe(8);
		for (const action of expectedActions) {
			expect(actions).toContain(action);
		}
	});

	it("pre-loads google_drive profile with 4 actions", () => {
		const registry = new AppBridgeRegistry();
		const drive = registry.getProfile("google_drive");
		expect(drive).toBeDefined();
		expect(drive?.id).toBe("google_drive");

		const actions = registry.getAppActions("google_drive");
		const expectedActions = [
			"export_file",
			"sync_artifact",
			"list_folder",
			"read_file",
		];
		expect(actions.length).toBe(4);
		for (const action of expectedActions) {
			expect(actions).toContain(action);
		}
	});

	it("pre-loads office_document profile with 4 actions", () => {
		const registry = new AppBridgeRegistry();
		const office = registry.getProfile("office_document");
		expect(office).toBeDefined();
		expect(office?.id).toBe("office_document");

		const actions = registry.getAppActions("office_document");
		const expectedActions = [
			"read_document",
			"append_content",
			"export_slides",
			"read_sheet",
		];
		expect(actions.length).toBe(4);
		for (const action of expectedActions) {
			expect(actions).toContain(action);
		}
	});

	it("pre-loads chrome_browser profile with 4 actions", () => {
		const registry = new AppBridgeRegistry();
		const chrome = registry.getProfile("chrome_browser");
		expect(chrome).toBeDefined();
		expect(chrome?.id).toBe("chrome_browser");

		const actions = registry.getAppActions("chrome_browser");
		const expectedActions = [
			"inspect_tab",
			"read_dom",
			"click_element",
			"eval_script",
		];
		expect(actions.length).toBe(4);
		for (const action of expectedActions) {
			expect(actions).toContain(action);
		}
	});
});

describe("AppBridgeTool operations", () => {
	const tool = new AppBridgeTool();

	it("has valid tool metadata and schema", () => {
		expect(tool.name).toBe("app_bridge");
		expect(tool.description).toBeDefined();
		expect(tool.parameters).toBeDefined();
		expect(tool.summary).toBeDefined();
	});

	it("list_apps action returns registered apps, description, version, and action lists", async () => {
		const res = await tool.execute("call_1", { action: "list_apps" });
		expect(res.content[0].type).toBe("text");
		expect(res.details).toBeDefined();

		const details = res.details as { apps: Array<{ id: string; description: string; version: string; actions: string[] }> };
		expect(details.apps).toBeDefined();
		expect(details.apps.length).toBeGreaterThanOrEqual(4);

		const outlookApp = details.apps.find((a) => a.id === "outlook");
		expect(outlookApp).toBeDefined();
		expect(outlookApp?.description).toBeDefined();
		expect(outlookApp?.version).toBeDefined();
		expect(outlookApp?.actions.length).toBe(8);
	});

	it("get_schema action returns parameters and schema documentation for a specified app and action", async () => {
		const res = await tool.execute("call_2", {
			action: "get_schema",
			app: "outlook",
			appAction: "send_mail",
		});
		expect(res.content[0].type).toBe("text");
		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("send_mail");
		expect(text).toContain("to");
		expect(text).toContain("subject");
		expect(text).toContain("body");

		const details = res.details as { app: string; action: string; schema: { parameters: Record<string, unknown> } };
		expect(details.app).toBe("outlook");
		expect(details.action).toBe("send_mail");
		expect(details.schema.parameters).toBeDefined();
		expect(details.schema.parameters.to).toBeDefined();
	});

	it("execute action validates parameters and executes handler returning success or actionable error", async () => {
		const successRes = await tool.execute("call_3", {
			action: "execute",
			app: "outlook",
			appAction: "send_mail",
			parameters: {
				to: "test@example.com",
				subject: "Meeting updates",
				body: "Hello team",
			},
		});
		expect(successRes.content[0].type).toBe("text");
		const successDetails = successRes.details as { success: boolean };
		expect(successDetails.success).toBe(true);

		const failRes = await tool.execute("call_4", {
			action: "execute",
			app: "outlook",
			appAction: "send_mail",
			parameters: {
				subject: "No recipient",
			},
		});
		expect(failRes.isError).toBe(true);
		expect((failRes.content[0] as { text: string }).text).toContain("to");
		const failDetails = failRes.details as { success: boolean; error: string };
		expect(failDetails.success).toBe(false);
		expect(failDetails.error).toBeDefined();
	});

	it("register_profile dynamically registers a new app profile and its actions", async () => {
		const customProfile: AppProfile = {
			id: "slack",
			name: "Slack",
			description: "Slack messaging and channel management",
			version: "1.0.0",
			actions: [
				{
					name: "post_message",
					description: "Post a message to a channel",
					parameters: {
						channel: { type: "string", description: "Target channel id", required: true },
						text: { type: "string", description: "Message text", required: true },
					},
					handler: (params) => ({ messageId: "msg_123", channel: params.channel, text: params.text }),
				},
			],
		};

		const regRes = await tool.execute("call_5", {
			action: "register_profile",
			profile: customProfile,
		});
		expect(regRes.isError).toBeFalsy();

		const schemaRes = await tool.execute("call_6", {
			action: "get_schema",
			app: "slack",
			appAction: "post_message",
		});
		expect((schemaRes.content[0] as { text: string }).text).toContain("channel");

		const execRes = await tool.execute("call_7", {
			action: "execute",
			app: "slack",
			appAction: "post_message",
			parameters: {
				channel: "general",
				text: "Hello from test",
			},
		});
		expect(execRes.isError).toBeFalsy();
		const execDetails = execRes.details as { success: boolean; data: { messageId: string } };
		expect(execDetails.success).toBe(true);
		expect(execDetails.data.messageId).toBe("msg_123");
	});

	it("returns actionable errors for unregistered apps and unknown actions", async () => {
		const missingAppSchema = await tool.execute("call_8", {
			action: "get_schema",
			app: "unknown_app",
			appAction: "do_something",
		});
		expect(missingAppSchema.isError).toBe(true);
		expect((missingAppSchema.content[0] as { text: string }).text).toContain("unknown_app");

		const unknownActionSchema = await tool.execute("call_9", {
			action: "get_schema",
			app: "outlook",
			appAction: "unknown_action",
		});
		expect(unknownActionSchema.isError).toBe(true);
		expect((unknownActionSchema.content[0] as { text: string }).text).toContain("unknown_action");

		const missingAppExec = await tool.execute("call_10", {
			action: "execute",
			app: "non_existent",
			appAction: "foo",
		});
		expect(missingAppExec.isError).toBe(true);
		expect((missingAppExec.content[0] as { text: string }).text).toContain("non_existent");

		const unknownActionExec = await tool.execute("call_11", {
			action: "execute",
			app: "google_drive",
			appAction: "non_existent_drive_action",
		});
		expect(unknownActionExec.isError).toBe(true);
		expect((unknownActionExec.content[0] as { text: string }).text).toContain("non_existent_drive_action");
	});

	it("supports pluggable and mockable execution handlers", async () => {
		const registry = new AppBridgeRegistry();
		registry.setHandler("chrome_browser", "click_element", async (params) => {
			return { clicked: true, customMock: true, selector: params.selector };
		});

		const customTool = new AppBridgeTool(registry);
		const res = await customTool.execute("call_12", {
			action: "execute",
			app: "chrome_browser",
			appAction: "click_element",
			parameters: { selector: "#submit-btn" },
		});
		expect(res.isError).toBeFalsy();
		const details = res.details as { success: boolean; data: { customMock: boolean; selector: string } };
		expect(details.success).toBe(true);
		expect(details.data.customMock).toBe(true);
		expect(details.data.selector).toBe("#submit-btn");
	});
});
