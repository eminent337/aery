/**
 * computer-use-teach.ts — Interactive Computer Use "Teach" Mode & Workflow Recipes.
 *
 * Enables users to demonstrate GUI workflows to Aery, records demonstrated steps,
 * saves them as reusable recipes in .aery/workflows/, and replays them autonomously.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod/v4";
import { DesktopControlTool } from "./desktop-control";

export interface WorkflowRecipeStep {
	index: number;
	step_type: "click" | "move" | "drag" | "type" | "key" | "scroll";
	target?: string;
	coords?: [number, number];
	end_coords?: [number, number];
	text?: string;
	keys?: string;
	button?: "left" | "right" | "middle";
	direction?: "up" | "down" | "left" | "right";
	count?: number;
	description?: string;
}

export interface WorkflowRecipe {
	id: string;
	name: string;
	description?: string;
	app?: string;
	createdAt: string;
	steps: WorkflowRecipeStep[];
}

export const computerUseTeachSchema = z.object({
	action: z
		.enum(["start_session", "record_step", "save_recipe", "list_recipes", "replay_recipe", "cancel_session"])
		.describe("Teach action to perform."),
	recipe_name: z.string().optional().describe("Human readable name for the workflow recipe."),
	recipe_id: z.string().optional().describe("Unique identifier of the recipe to load or replay."),
	description: z.string().optional().describe("Description or instructions for the workflow."),
	app: z.string().optional().describe("Target desktop application name or class."),
	step_type: z
		.enum(["click", "move", "drag", "type", "key", "scroll"])
		.optional()
		.describe("Action type of the recorded step."),
	target: z.string().optional().describe("Visual or OCR target element label."),
	coords: z.tuple([z.number(), z.number()]).optional().describe("Coordinates [x, y] of the step."),
	end_coords: z.tuple([z.number(), z.number()]).optional().describe("End coordinates [x2, y2] for drags."),
	text: z.string().optional().describe("Text typed during this step."),
	keys: z.string().optional().describe("Key combination or shortcut chord pressed."),
	button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button used."),
	direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction."),
	count: z.number().int().optional().describe("Number of clicks or scroll notches."),
});

export type ComputerUseTeachParams = z.infer<typeof computerUseTeachSchema>;

export class ComputerUseTeachTool implements AgentTool<typeof computerUseTeachSchema> {
	readonly name = "computer_use_teach";
	readonly approval = "execute" as const;
	readonly label = "Computer Use Teach Mode";
	readonly summary = "Record and replay demonstrated GUI workflows as reusable recipes";
	readonly description =
		"Interactive Computer Use teaching mode. Record user demonstrated clicks, keystrokes, and navigation flows into reusable workflow recipes that can be replayed autonomously.";
	readonly parameters = computerUseTeachSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly storageDir: string;
	private currentSession: {
		name: string;
		description?: string;
		app?: string;
		steps: WorkflowRecipeStep[];
	} | null = null;
	private readonly desktopControl: DesktopControlTool;

	constructor(opts?: { storageDir?: string; session?: any }) {
		this.storageDir = opts?.storageDir ?? path.join(process.cwd(), ".aery", "workflows");
		this.desktopControl = new DesktopControlTool(opts?.session);
	}

	static createIf(session?: any): ComputerUseTeachTool | null {
		return new ComputerUseTeachTool({ session });
	}

	private slugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	async execute(
		toolCallId: string,
		params: ComputerUseTeachParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		await fs.promises.mkdir(this.storageDir, { recursive: true });

		switch (params.action) {
			case "start_session": {
				const name = params.recipe_name || `Workflow ${new Date().toLocaleTimeString()}`;
				this.currentSession = {
					name,
					description: params.description,
					app: params.app,
					steps: [],
				};
				return {
					content: [
						{
							type: "text",
							text: `Started teaching session for "${name}"${params.app ? ` (app: ${params.app})` : ""}. Demonstrate actions and call record_step for each interaction.`,
						},
					],
				};
			}

			case "record_step": {
				if (!this.currentSession) {
					this.currentSession = {
						name: "Interactive Workflow",
						steps: [],
					};
				}

				if (!params.step_type) {
					return {
						isError: true,
						content: [{ type: "text", text: "step_type is required for record_step" }],
					};
				}

				const stepIndex = this.currentSession.steps.length + 1;
				const step: WorkflowRecipeStep = {
					index: stepIndex,
					step_type: params.step_type,
					target: params.target,
					coords: params.coords,
					end_coords: params.end_coords,
					text: params.text,
					keys: params.keys,
					button: params.button,
					direction: params.direction,
					count: params.count,
					description: params.description,
				};

				this.currentSession.steps.push(step);
				return {
					content: [
						{
							type: "text",
							text: `Step ${stepIndex} recorded: ${params.step_type}${params.target ? ` on "${params.target}"` : ""}${params.coords ? ` at (${params.coords[0]},${params.coords[1]})` : ""}. Total steps: ${this.currentSession.steps.length}.`,
						},
					],
				};
			}

			case "save_recipe": {
				if (!this.currentSession || this.currentSession.steps.length === 0) {
					return {
						isError: true,
						content: [{ type: "text", text: "No active teaching session with steps to save." }],
					};
				}

				const name = params.recipe_name || this.currentSession.name;
				const id = this.slugify(name);
				const recipe: WorkflowRecipe = {
					id,
					name,
					description: params.description || this.currentSession.description,
					app: params.app || this.currentSession.app,
					createdAt: new Date().toISOString(),
					steps: this.currentSession.steps,
				};

				const filePath = path.join(this.storageDir, `${id}.json`);
				await fs.promises.writeFile(filePath, JSON.stringify(recipe, null, 2), "utf-8");
				this.currentSession = null;

				return {
					content: [
						{
							type: "text",
							text: `Recipe saved successfully as "${id}" (${recipe.steps.length} steps) in ${filePath}.`,
						},
					],
				};
			}

			case "list_recipes": {
				try {
					const files = await fs.promises.readdir(this.storageDir);
					const recipes: Array<{ id: string; name: string; steps: number }> = [];

					for (const file of files) {
						if (file.endsWith(".json")) {
							try {
								const data = await fs.promises.readFile(path.join(this.storageDir, file), "utf-8");
								const parsed = JSON.parse(data) as WorkflowRecipe;
								recipes.push({
									id: parsed.id || file.replace(".json", ""),
									name: parsed.name || file,
									steps: parsed.steps?.length ?? 0,
								});
							} catch {}
						}
					}

					return {
						content: [
							{
								type: "text",
								text:
									recipes.length > 0
										? `Available workflow recipes (${recipes.length}):\n${recipes.map(r => `• ${r.id}: "${r.name}" (${r.steps} steps)`).join("\n")}`
										: "No workflow recipes found in storage directory.",
							},
						],
					};
				} catch {
					return {
						content: [{ type: "text", text: "No workflow recipes directory found." }],
					};
				}
			}

			case "replay_recipe": {
				if (!params.recipe_id) {
					return {
						isError: true,
						content: [{ type: "text", text: "recipe_id is required to replay a recipe." }],
					};
				}

				const id = this.slugify(params.recipe_id);
				const filePath = path.join(this.storageDir, `${id}.json`);
				let recipe: WorkflowRecipe;

				try {
					const data = await fs.promises.readFile(filePath, "utf-8");
					recipe = JSON.parse(data);
				} catch (err) {
					return {
						isError: true,
						content: [{ type: "text", text: `Could not load recipe "${id}": ${err}` }],
					};
				}

				let completed = 0;
				for (const step of recipe.steps) {
					if (signal?.aborted) {
						return {
							isError: true,
							content: [{ type: "text", text: `Replay aborted after ${completed} steps.` }],
						};
					}

					try {
						switch (step.step_type) {
							case "click":
								if (step.coords) {
									await this.desktopControl.execute("replay-click", {
										action: "click_at",
										x: step.coords[0],
										y: step.coords[1],
										button: step.button || "left",
										click_count: step.count || 1,
									});
								}
								break;
							case "move":
								if (step.coords) {
									await this.desktopControl.execute("replay-move", {
										action: "move_cursor",
										x: step.coords[0],
										y: step.coords[1],
									});
								}
								break;
							case "type":
								if (step.text) {
									await this.desktopControl.execute("replay-type", {
										action: "type_text",
										keys: step.text,
									});
								}
								break;
							case "key":
								if (step.keys) {
									await this.desktopControl.execute("replay-key", {
										action: "press_key",
										keys: step.keys,
									});
								}
								break;
							case "scroll":
								await this.desktopControl.execute("replay-scroll", {
									action: "scroll_at",
									direction: step.direction || "down",
									count: step.count || 3,
								});
								break;
							case "drag":
								if (step.coords && step.end_coords) {
									await this.desktopControl.execute("replay-drag", {
										action: "drag_and_drop_at",
										x: step.coords[0],
										y: step.coords[1],
										x2: step.end_coords[0],
										y2: step.end_coords[1],
									});
								}
								break;
						}
						completed++;
					} catch (stepErr) {
						// Continue best-effort
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `Replayed ${completed} step${completed === 1 ? "" : "s"} of recipe "${recipe.name}" (${recipe.id}).`,
						},
					],
				};
			}

			case "cancel_session": {
				this.currentSession = null;
				return {
					content: [{ type: "text", text: "Teaching session cancelled." }],
				};
			}

			default:
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
				};
		}
	}
}
