/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@aryee337/aery/async";
import type { Rule } from "@aryee337/aery/capability/rule";
import { ModelRegistry } from "@aryee337/aery/config/model-registry";
import { Settings } from "@aryee337/aery/config/settings";
import { TtsrManager } from "@aryee337/aery/export/ttsr";
import type { AgentSession } from "@aryee337/aery/session/agent-session";
import type { AuthStorage } from "@aryee337/aery/session/auth-storage";
import { convertToLlm } from "@aryee337/aery/session/messages";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import { type AssistantMessage, getBundledModel, type Message, type ToolCall } from "@aryee337/aery-ai";
import { createMockModel } from "@aryee337/aery-ai/providers/mock";
import { AssistantMessageEventStream } from "@aryee337/aery-ai/utils/event-stream";
import { Agent, AgentBusyError, type AgentTool } from "@aryee337/aery-core";
import { Snowflake } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Mock stream that mimics AssistantMessageEventStream

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	// ... (rest of file)

	async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}

		throw new Error("Timed out waiting for condition");
	}

	// ... (rest of tests)
});
