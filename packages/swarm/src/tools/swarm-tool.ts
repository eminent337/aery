import type { MemberRegistry } from "../store/member-registry";
import type { WorktreeManager } from "../workspace/worktree-manager";
import type { WorkspaceMode } from "../types";

export interface SwarmToolParams {
	action: "status" | "models" | "add" | "model" | "kill" | "title";
	name?: string;
	brief?: string;
	model?: string;
	workspace?: WorkspaceMode;
	title?: string;
}

export function createSwarmTool(deps: {
	registry: MemberRegistry;
	worktreeManager: WorktreeManager;
}) {
	return {
		name: "swarm",
		description: "Manage swarm agents: add, status, model hot-swap, and termination.",
		execute: async (params: SwarmToolParams) => {
			switch (params.action) {
				case "status": {
					return { success: true, members: deps.registry.listMembers() };
				}
				case "models": {
					return {
						success: true,
						models: [
							"gemini-3.5-flash-lite",
							"gemini-3.6-flash",
							"claude-3-7-sonnet",
							"gpt-4o",
						],
					};
				}
				case "add": {
					if (!params.name || !params.brief) {
						return { success: false, error: "name and brief are required for 'add'" };
					}
					const wsMode = params.workspace ?? "inherit";
					const wt = deps.worktreeManager.createWorktree(params.name, wsMode);
					deps.registry.addMember({
						name: params.name,
						brief: params.brief,
						model: params.model,
						state: "waiting",
						workspace: wsMode,
						workspacePath: wt.workspacePath,
						branchName: wt.branchName,
						lastSeqRead: 0,
						createdAt: new Date().toISOString(),
					});
					return { success: true, member: deps.registry.getMember(params.name) };
				}
				case "model": {
					if (!params.name || !params.model) {
						return { success: false, error: "name and model are required for 'model'" };
					}
					const updated = deps.registry.updateMember(params.name, {
						model: params.model,
						state: "waiting",
					});
					return { success: !!updated, member: updated };
				}
				case "kill": {
					if (!params.name) {
						return { success: false, error: "name is required for 'kill'" };
					}
					deps.worktreeManager.removeWorktree(params.name);
					deps.registry.updateMember(params.name, { state: "killed" });
					return { success: true };
				}
				case "title": {
					return { success: true, title: params.title };
				}
				default:
					return { success: false, error: `Unknown action: ${(params as any).action}` };
			}
		},
	};
}
