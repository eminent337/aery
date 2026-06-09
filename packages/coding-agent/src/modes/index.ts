import { emergencyTerminalRestore } from "@aryee337/aery-tui";
import { postmortem } from "@aryee337/aery-utils";

/**
 * Run modes for the coding agent.
 */
export { runAcpMode } from "./acp";
export { type FermentModeOptions, runFermentMode } from "./ferment-mode";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export {
	defineRpcClientTool,
	type ModelInfo,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientOptions,
	type RpcClientToolContext,
	type RpcClientToolResult,
	type RpcEventListener,
} from "./rpc/rpc-client";
export { runRpcMode } from "./rpc/rpc-mode";
export type {
	RpcCommand,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});
