import { AgentSession } from "./packages/coding-agent/src/session/agent-session";
import { ExtensionRunner } from "./packages/coding-agent/src/extensibility/extensions/runner";

console.log(Object.getOwnPropertyNames(AgentSession.prototype).includes("executeExtensionCommand"));
