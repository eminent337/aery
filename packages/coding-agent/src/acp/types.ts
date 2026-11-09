export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: any;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: any;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface AcpClientInfo {
	name: string;
	version: string;
}

export interface AcpInitializeParams {
	protocolVersion: number;
	clientInfo?: AcpClientInfo;
	clientCapabilities?: any;
}

export interface AcpInitializeResult {
	protocolVersion: number;
	agentCapabilities?: any;
	agentInfo?: { name: string; version: string };
	authMethods?: any[];
}

export interface AcpSessionNewParams {
	cwd: string;
	mcpServers?: any[];
}

export interface AcpSessionNewResult {
	sessionId: string;
}

export interface AcpSessionLoadParams {
	sessionId: string;
	cwd: string;
}

export interface AcpSessionPromptParams {
	sessionId: string;
	prompt: Array<{ type: string; text?: string; [key: string]: any }>;
}

export interface AcpSessionCancelParams {
	sessionId: string;
}

export interface AcpSessionUpdateNotification {
	sessionId: string;
	updateType: string;
	content?: any;
	toolCall?: any;
	status?: any;
}
