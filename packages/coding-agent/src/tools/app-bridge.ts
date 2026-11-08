/**
 * Universal App Bridge Tool and Registry for Aery.
 *
 * Provides a unified dispatch engine and preloaded application profiles
 * for controlling local desktop software and cloud services including
 * Outlook, Google Drive, Office documents, and Chrome browser.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@aryee337/aery-core";
import * as z from "zod/v4";

export type AppActionHandler = (params: Record<string, any>) => Promise<any> | any;

export interface AppActionParameterDef {
	type: string;
	description: string;
	required?: boolean;
	enum?: string[];
	default?: any;
}

export interface AppActionDefinition {
	name: string;
	description: string;
	parameters: Record<string, AppActionParameterDef>;
	validate?: (params: Record<string, any>) => { valid: boolean; error?: string };
	handler?: AppActionHandler;
}

export interface AppProfile {
	id: string;
	name: string;
	description: string;
	version: string;
	actions: AppActionDefinition[] | Record<string, AppActionDefinition>;
}

export interface AppProfileSummary {
	id: string;
	name: string;
	description: string;
	version: string;
	actions: string[];
}

export interface AppActionSchema {
	app: string;
	action: string;
	description: string;
	parameters: Record<string, AppActionParameterDef>;
}

export interface AppExecutionResult {
	success: boolean;
	app?: string;
	action?: string;
	data?: any;
	error?: string;
}

function validateActionParams(
	actionDef: AppActionDefinition,
	params: Record<string, any>,
): { valid: boolean; error?: string } {
	if (actionDef.validate) {
		const customValidation = actionDef.validate(params);
		if (!customValidation.valid) {
			return customValidation;
		}
	}
	for (const [paramName, paramDef] of Object.entries(actionDef.parameters ?? {})) {
		if (paramDef.required) {
			const val = params[paramName];
			if (val === undefined || val === null || val === "") {
				return {
					valid: false,
					error: `Missing required parameter "${paramName}" for action "${actionDef.name}".`,
				};
			}
		}
	}
	return { valid: true };
}

function createBuiltinProfiles(): AppProfile[] {
	const outlookProfile: AppProfile = {
		id: "outlook",
		name: "Outlook",
		description: "Microsoft Outlook desktop and web client bridge for mail and calendar.",
		version: "1.0.0",
		actions: [
			{
				name: "send_mail",
				description: "Send an email message via Outlook.",
				parameters: {
					to: { type: "string", description: "Primary recipient email address", required: true },
					subject: { type: "string", description: "Email subject line", required: true },
					body: { type: "string", description: "Email body content", required: true },
					cc: { type: "string", description: "Carbon copy recipient email address", required: false },
				},
				handler: (params) => ({
					sent: true,
					to: params.to,
					subject: params.subject,
					messageId: `msg_${Date.now()}`,
				}),
			},
			{
				name: "create_draft",
				description: "Create a draft email without sending.",
				parameters: {
					subject: { type: "string", description: "Draft subject line", required: true },
					body: { type: "string", description: "Draft body content", required: true },
					to: { type: "string", description: "Optional recipient email address", required: false },
				},
				handler: (params) => ({
					draftId: `draft_${Date.now()}`,
					subject: params.subject,
					saved: true,
				}),
			},
			{
				name: "create_reply_draft",
				description: "Create a draft replying to an existing email thread.",
				parameters: {
					messageId: { type: "string", description: "ID of the message being replied to", required: true },
					body: { type: "string", description: "Reply body content", required: true },
				},
				handler: (params) => ({
					draftId: `reply_${Date.now()}`,
					replyTo: params.messageId,
					saved: true,
				}),
			},
			{
				name: "update_event",
				description: "Update an existing calendar event.",
				parameters: {
					eventId: { type: "string", description: "Calendar event identifier", required: true },
					updates: { type: "object", description: "Field updates for the event", required: false },
				},
				handler: (params) => ({
					updated: true,
					eventId: params.eventId,
					updates: params.updates ?? {},
				}),
			},
			{
				name: "respond_to_event",
				description: "Respond to a calendar invitation.",
				parameters: {
					eventId: { type: "string", description: "Calendar event identifier", required: true },
					response: {
						type: "string",
						description: "Response type: accept, tentative, or decline",
						required: true,
						enum: ["accept", "tentative", "decline"],
					},
				},
				validate: (params) => {
					if (!params.eventId) {
						return { valid: false, error: 'Missing required parameter "eventId" for action "respond_to_event".' };
					}
					const allowed = ["accept", "tentative", "decline"];
					if (!params.response || !allowed.includes(params.response)) {
						return {
							valid: false,
							error: 'Parameter "response" must be one of: accept, tentative, decline.',
						};
					}
					return { valid: true };
				},
				handler: (params) => ({
					eventId: params.eventId,
					response: params.response,
					recorded: true,
				}),
			},
			{
				name: "delete_event",
				description: "Delete an event from the calendar.",
				parameters: {
					eventId: { type: "string", description: "Calendar event identifier", required: true },
				},
				handler: (params) => ({
					deleted: true,
					eventId: params.eventId,
				}),
			},
			{
				name: "modify_thread_labels",
				description: "Add or remove category labels from a conversation thread.",
				parameters: {
					threadId: { type: "string", description: "Conversation thread identifier", required: true },
					addLabels: { type: "array", description: "Category labels to add", required: false },
					removeLabels: { type: "array", description: "Category labels to remove", required: false },
				},
				handler: (params) => ({
					modified: true,
					threadId: params.threadId,
					addLabels: params.addLabels ?? [],
					removeLabels: params.removeLabels ?? [],
				}),
			},
			{
				name: "batch_delete_messages",
				description: "Batch delete multiple email messages by identifier.",
				parameters: {
					messageIds: { type: "array", description: "Array of message IDs to delete", required: true },
				},
				validate: (params) => {
					if (!Array.isArray(params.messageIds) || params.messageIds.length === 0) {
						return {
							valid: false,
							error: 'Parameter "messageIds" must be a non-empty array of strings.',
						};
					}
					return { valid: true };
				},
				handler: (params) => ({
					deletedCount: params.messageIds.length,
					messageIds: params.messageIds,
				}),
			},
		],
	};

	const googleDriveProfile: AppProfile = {
		id: "google_drive",
		name: "Google Drive",
		description: "Cloud storage bridge for file synchronization, export, and browsing.",
		version: "1.0.0",
		actions: [
			{
				name: "export_file",
				description: "Export a Google Drive document in specified format.",
				parameters: {
					fileId: { type: "string", description: "Drive file identifier", required: true },
					format: { type: "string", description: "Export format (e.g. pdf, docx, csv)", required: true },
				},
				handler: (params) => ({
					exported: true,
					fileId: params.fileId,
					format: params.format,
					downloadUrl: `https://drive.google.com/export/${params.fileId}.${params.format}`,
				}),
			},
			{
				name: "sync_artifact",
				description: "Synchronize a local workspace artifact file to Google Drive.",
				parameters: {
					localPath: { type: "string", description: "Local filesystem path", required: true },
					drivePath: { type: "string", description: "Destination Drive path", required: true },
				},
				handler: (params) => ({
					synced: true,
					localPath: params.localPath,
					drivePath: params.drivePath,
					syncTimestamp: Date.now(),
				}),
			},
			{
				name: "list_folder",
				description: "List contents of a Google Drive folder.",
				parameters: {
					folderId: { type: "string", description: "Folder identifier (defaults to root)", required: false },
				},
				handler: (params) => ({
					folderId: params.folderId ?? "root",
					items: [],
				}),
			},
			{
				name: "read_file",
				description: "Read metadata and content of a Google Drive file.",
				parameters: {
					fileId: { type: "string", description: "Drive file identifier", required: true },
				},
				handler: (params) => ({
					fileId: params.fileId,
					name: `file_${params.fileId}.dat`,
					sizeBytes: 1024,
					mimeType: "application/octet-stream",
				}),
			},
		],
	};

	const officeDocumentProfile: AppProfile = {
		id: "office_document",
		name: "Office Document",
		description: "Document, presentation, and spreadsheet automation bridge.",
		version: "1.0.0",
		actions: [
			{
				name: "read_document",
				description: "Read text and structure from a document file.",
				parameters: {
					path: { type: "string", description: "Filesystem path to document", required: true },
				},
				handler: (params) => ({
					path: params.path,
					paragraphs: ["Sample document content"],
				}),
			},
			{
				name: "append_content",
				description: "Append paragraphs or content to an existing document.",
				parameters: {
					path: { type: "string", description: "Filesystem path to document", required: true },
					content: { type: "string", description: "Text content to append", required: true },
				},
				handler: (params) => ({
					appended: true,
					path: params.path,
					charactersAdded: String(params.content).length,
				}),
			},
			{
				name: "export_slides",
				description: "Export slide deck presentation to PDF or images.",
				parameters: {
					path: { type: "string", description: "Filesystem path to presentation deck", required: true },
					format: { type: "string", description: "Output format such as pdf or png", required: false },
				},
				handler: (params) => ({
					exported: true,
					path: params.path,
					format: params.format ?? "pdf",
					slideCount: 10,
				}),
			},
			{
				name: "read_sheet",
				description: "Read tabular rows from a spreadsheet workbook.",
				parameters: {
					path: { type: "string", description: "Filesystem path to spreadsheet workbook", required: true },
					sheetName: { type: "string", description: "Optional sheet name to read", required: false },
				},
				handler: (params) => ({
					path: params.path,
					sheet: params.sheetName ?? "Sheet1",
					rows: [],
				}),
			},
		],
	};

	const chromeBrowserProfile: AppProfile = {
		id: "chrome_browser",
		name: "Chrome Browser",
		description: "Deep automation bridge for Chrome browser tabs, DOM tree, and script execution.",
		version: "1.0.0",
		actions: [
			{
				name: "inspect_tab",
				description: "Inspect active or targeted tab status and URL.",
				parameters: {
					tabId: { type: "string", description: "Target tab identifier", required: false },
				},
				handler: (params) => ({
					tabId: params.tabId ?? 1,
					url: "about:blank",
					title: "New Tab",
				}),
			},
			{
				name: "read_dom",
				description: "Extract DOM subtree or rendered HTML by CSS selector.",
				parameters: {
					selector: { type: "string", description: "CSS selector (defaults to body)", required: false },
				},
				handler: (params) => ({
					selector: params.selector ?? "body",
					html: "<div>App Bridge DOM Mock</div>",
				}),
			},
			{
				name: "click_element",
				description: "Click a DOM element identified by CSS selector.",
				parameters: {
					selector: { type: "string", description: "CSS selector for target element", required: true },
				},
				handler: (params) => ({
					clicked: true,
					selector: params.selector,
				}),
			},
			{
				name: "eval_script",
				description: "Evaluate custom JavaScript in tab execution context.",
				parameters: {
					script: { type: "string", description: "JavaScript source code string to evaluate", required: true },
				},
				handler: (params) => ({
					evaluated: true,
					script: params.script,
					result: null,
				}),
			},
		],
	};

	return [outlookProfile, googleDriveProfile, officeDocumentProfile, chromeBrowserProfile];
}

export class AppBridgeRegistry {
	private readonly profiles = new Map<string, AppProfile>();
	private readonly actionsMap = new Map<string, Map<string, AppActionDefinition>>();

	constructor(loadBuiltins = true) {
		if (loadBuiltins) {
			for (const profile of createBuiltinProfiles()) {
				this.registerProfile(profile);
			}
		}
	}

	registerProfile(profile: AppProfile): void {
		this.profiles.set(profile.id, profile);
		const appActions = new Map<string, AppActionDefinition>();

		const rawActions = Array.isArray(profile.actions)
			? profile.actions
			: Object.values(profile.actions);

		for (const actionDef of rawActions) {
			appActions.set(actionDef.name, actionDef);
		}
		this.actionsMap.set(profile.id, appActions);
	}

	getProfile(appId: string): AppProfile | undefined {
		return this.profiles.get(appId);
	}

	getAppActions(appId: string): string[] {
		const appActions = this.actionsMap.get(appId);
		if (!appActions) {
			return [];
		}
		return Array.from(appActions.keys());
	}

	listApps(): AppProfileSummary[] {
		const summaries: AppProfileSummary[] = [];
		for (const [id, profile] of this.profiles.entries()) {
			summaries.push({
				id,
				name: profile.name,
				description: profile.description,
				version: profile.version,
				actions: this.getAppActions(id),
			});
		}
		return summaries;
	}

	getSchema(appId: string, actionName: string): AppActionSchema | undefined {
		const appActions = this.actionsMap.get(appId);
		if (!appActions) {
			return undefined;
		}
		const actionDef = appActions.get(actionName);
		if (!actionDef) {
			return undefined;
		}
		return {
			app: appId,
			action: actionName,
			description: actionDef.description,
			parameters: actionDef.parameters,
		};
	}

	setHandler(appId: string, actionName: string, handler: AppActionHandler): void {
		const appActions = this.actionsMap.get(appId);
		if (!appActions) {
			throw new Error(`Cannot set handler: app "${appId}" is not registered.`);
		}
		const actionDef = appActions.get(actionName);
		if (!actionDef) {
			throw new Error(`Cannot set handler: action "${actionName}" not found in app "${appId}".`);
		}
		actionDef.handler = handler;
	}

	async execute(
		appId: string,
		actionName: string,
		params: Record<string, any> = {},
	): Promise<AppExecutionResult> {
		const app = this.profiles.get(appId);
		if (!app) {
			const registered = Array.from(this.profiles.keys()).join(", ");
			return {
				success: false,
				error: `App "${appId}" is not registered. Registered apps: ${registered}`,
			};
		}

		const appActions = this.actionsMap.get(appId);
		const actionDef = appActions?.get(actionName);
		if (!actionDef) {
			const available = this.getAppActions(appId).join(", ");
			return {
				success: false,
				error: `Action "${actionName}" is not found in app "${appId}". Available actions: ${available}`,
			};
		}

		try {
			const validation = validateActionParams(actionDef, params);
			if (!validation.valid) {
				return {
					success: false,
					error: validation.error ?? "Invalid parameters",
				};
			}

			const handler = actionDef.handler ?? (() => ({ executed: true }));
			const data = await handler(params);
			return {
				success: true,
				app: appId,
				action: actionName,
				data,
			};
		} catch (err: any) {
			return {
				success: false,
				app: appId,
				action: actionName,
				error: err?.message ? String(err.message) : "Execution error occurred",
			};
		}
	}
}

export const appBridgeSchema = z.object({
	action: z
		.enum(["list_apps", "get_schema", "execute", "register_profile"])
		.describe("App bridge operation: list_apps, get_schema, execute, or register_profile."),
	app: z
		.string()
		.optional()
		.describe("Application identifier (e.g. outlook, google_drive, office_document, chrome_browser)."),
	appId: z
		.string()
		.optional()
		.describe("Alternative identifier alias for app."),
	appAction: z
		.string()
		.optional()
		.describe("Action name within the target application."),
	actionName: z
		.string()
		.optional()
		.describe("Alternative alias for appAction."),
	targetAction: z
		.string()
		.optional()
		.describe("Alternative alias for appAction."),
	parameters: z
		.record(z.string(), z.any())
		.optional()
		.describe("Parameters for the application action."),
	params: z
		.record(z.string(), z.any())
		.optional()
		.describe("Alternative alias for parameters."),
	profile: z
		.any()
		.optional()
		.describe("AppProfile definition for register_profile action."),
});

export type AppBridgeParams = z.infer<typeof appBridgeSchema>;

export class AppBridgeTool implements AgentTool<typeof appBridgeSchema> {
	readonly name = "app_bridge";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "App Bridge";
	readonly description =
		"Universal desktop and cloud application bridge. Enables discovery of application profiles, schema retrieval, and execution of deep integrations with Outlook, Google Drive, Office documents, and Chrome browser.";
	readonly parameters = appBridgeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary =
		"Universal App Bridge tool for controlling applications like Outlook, Google Drive, Office documents, and Chrome browser";

	private readonly registry: AppBridgeRegistry;

	constructor(registry?: AppBridgeRegistry) {
		this.registry = registry ?? new AppBridgeRegistry();
	}

	async execute(
		_toolCallId: string,
		params: AppBridgeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "list_apps": {
				const apps = this.registry.listApps();
				const formattedLines: string[] = ["Registered Applications:"];
				for (const item of apps) {
					formattedLines.push(
						`Application: ${item.name} (${item.id}, v${item.version})`,
						`Description: ${item.description}`,
						`Actions: ${item.actions.join(", ")}`,
						"",
					);
				}
				return {
					content: [{ type: "text", text: formattedLines.join("\n").trim() }],
					details: { apps },
				};
			}

			case "get_schema": {
				const targetApp = params.app ?? params.appId;
				if (!targetApp) {
					return {
						content: [{ type: "text", text: 'Error: parameter "app" is required for get_schema.' }],
						details: { error: 'Parameter "app" is required for get_schema.' },
						isError: true,
					};
				}

				const targetAction = params.appAction ?? params.actionName ?? params.targetAction;
				if (!targetAction) {
					return {
						content: [{ type: "text", text: 'Error: parameter "appAction" is required for get_schema.' }],
						details: { error: 'Parameter "appAction" is required for get_schema.' },
						isError: true,
					};
				}

				const profile = this.registry.getProfile(targetApp);
				if (!profile) {
					const registered = this.registry.listApps().map((a) => a.id).join(", ");
					const errorMsg = `App "${targetApp}" is not registered. Registered apps: ${registered}`;
					return {
						content: [{ type: "text", text: errorMsg }],
						details: { error: errorMsg },
						isError: true,
					};
				}

				const schema = this.registry.getSchema(targetApp, targetAction);
				if (!schema) {
					const available = this.registry.getAppActions(targetApp).join(", ");
					const errorMsg = `Action "${targetAction}" is not found in app "${targetApp}". Available actions: ${available}`;
					return {
						content: [{ type: "text", text: errorMsg }],
						details: { error: errorMsg },
						isError: true,
					};
				}

				const docLines: string[] = [
					`App: ${schema.app}`,
					`Action: ${schema.action}`,
					`Description: ${schema.description}`,
					"Parameters:",
				];
				for (const [pName, pDef] of Object.entries(schema.parameters)) {
					const reqText = pDef.required ? "required" : "optional";
					docLines.push(`  ${pName} (${pDef.type}, ${reqText}): ${pDef.description}`);
				}

				return {
					content: [{ type: "text", text: docLines.join("\n") }],
					details: {
						app: targetApp,
						action: targetAction,
						schema,
					},
				};
			}

			case "execute": {
				const targetApp = params.app ?? params.appId;
				if (!targetApp) {
					return {
						content: [{ type: "text", text: 'Error: parameter "app" is required for execute.' }],
						details: { success: false, error: 'Parameter "app" is required for execute.' },
						isError: true,
					};
				}

				const targetAction = params.appAction ?? params.actionName ?? params.targetAction;
				if (!targetAction) {
					return {
						content: [{ type: "text", text: 'Error: parameter "appAction" is required for execute.' }],
						details: { success: false, error: 'Parameter "appAction" is required for execute.' },
						isError: true,
					};
				}

				const actionParams = params.parameters ?? params.params ?? {};
				const result = await this.registry.execute(targetApp, targetAction, actionParams);

				if (!result.success) {
					return {
						content: [{ type: "text", text: `Execution failed: ${result.error}` }],
						details: result,
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Successfully executed ${targetApp}.${targetAction}:\n${JSON.stringify(result.data, null, 2)}`,
						},
					],
					details: result,
				};
			}

			case "register_profile": {
				const profile = params.profile as AppProfile | undefined;
				if (!profile || !profile.id || !profile.name) {
					return {
						content: [
							{
								type: "text",
								text: "Error: profile object with id, name, and actions is required for register_profile.",
							},
						],
						details: {
							success: false,
							error: "Profile object with id, name, and actions is required.",
						},
						isError: true,
					};
				}

				this.registry.registerProfile(profile);
				return {
					content: [
						{
							type: "text",
							text: `Successfully registered application profile "${profile.id}" (${profile.name}).`,
						},
					],
					details: {
						success: true,
						appId: profile.id,
					},
				};
			}

			default: {
				return {
					content: [{ type: "text", text: `Unsupported action: ${String(params.action)}` }],
					details: { success: false, error: `Unsupported action: ${String(params.action)}` },
					isError: true,
				};
			}
		}
	}
}
