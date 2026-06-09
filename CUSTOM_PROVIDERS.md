# Custom OpenAI-Compatible Providers

Aery can talk to any LLM endpoint that speaks an OpenAI-compatible protocol. Instead of waiting for built-in support, you register the provider yourself in `~/.aery/agent/models.yml`.

This guide covers the full `models.yml` schema, the auth resolution chain, compatibility flags, and a complete working example.

---

## Table of Contents

- [Where to Put the Config](#where-to-put-the-config)
- [Minimal Example](#minimal-example)
- [Full Schema Reference](#full-schema-reference)
  - [Provider-level Fields](#provider-level-fields)
  - [Model-level Fields](#model-level-fields)
  - [Compatibility Options (`compat`)](#compatibility-options-compat)
  - [Reasoning Effort Maps](#reasoning-effort-maps)
- [Auth Resolution Chain](#auth-resolution-chain)
- [The `auth-json` Sentinel Bug](#the-auth-json-sentinel-bug)
- [Complete Example: Kimchi](#complete-example-kimchi)
- [Validating Your Config](#validating-your-config)
- [Troubleshooting](#troubleshooting)

---

## Where to Put the Config

The file lives at:

```
~/.aery/agent/models.yml
```

If the directory does not exist, create it:

```sh
mkdir -p ~/.aery/agent
```

Aery reloads this file on every startup. You do not need to restart a long-running session; the registry is re-parsed at the start of each new invocation.

---

## Minimal Example

The smallest valid custom provider needs a `baseUrl`, an `apiKey`, and at least one model:

```yaml
providers:
  my-proxy:
    baseUrl: https://api.example.com/v1
    apiKey: sk-my-real-key
    models:
      - id: gpt-4o-mini
        name: GPT-4o Mini
```

That is enough for Aery to list the model, route chat requests to the proxy, and authenticate with the key you supplied.

---

## Full Schema Reference

### Provider-level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | `string` | Recommended | Root URL of the provider's API. Must include the version path (e.g. `/v1`) if the endpoint requires it. |
| `apiKey` | `string` | Recommended | Bearer token sent in the `Authorization` header. Omit only when the provider requires no authentication or when you rely on env vars / stored credentials. |
| `api` | `string` | Optional | API dialect. Defaults to `openai-completions`. Other values: `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`. |
| `compat` | `object` | Optional | Compatibility tweaks described below. |
| `headers` | `object` | Optional | Extra headers merged into every request. Keys and values are strings. |
| `auth` | `string` | Optional | Auth mode: `apiKey` (default), `none`, or `oauth`. Use `none` for local servers like Ollama. |
| `authHeader` | `boolean` | Optional | Whether to send the API key in an `Authorization: Bearer ...` header. Defaults to `true`. |
| `discovery` | `object` | Optional | Auto-discovery rule. See the provider-discovery docs. |
| `models` | `array` | Required | List of model definitions. At least one entry. |
| `modelOverrides` | `object` | Optional | Per-model override dictionary keyed by model ID. Useful for patching an existing provider without rewriting the whole model list. |
| `disableStrictTools` | `boolean` | Optional | Disable strict JSON-schema tool definitions for this provider. |
| `transport` | `string` | Optional | Set to `"aery-native"` to route every model under this provider through the auth-gateway's streaming endpoint instead of the per-provider SDK. |

### Model-level Fields

Each entry in `models` is an object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Provider-side model identifier. Sent in the `model` field of the request body. |
| `name` | `string` | No | Human-readable label shown in the model picker. Defaults to the `id`. |
| `reasoning` | `boolean` | No | Whether the model emits a reasoning trace before its final answer. Defaults to `false`. |
| `thinking` | `object` | No | Thinking-control configuration. Contains `minLevel`, `maxLevel`, `mode`, `defaultLevel`, and `levels`. Used when the provider supports explicit thinking-effort parameters. |
| `input` | `array` | No | Supported input modalities. Items are `"text"` and/or `"image"`. Defaults to `["text"]`. |
| `cost` | `object` | No | Per-token pricing: `{ input: number, output: number, cacheRead?: number, cacheWrite?: number }`. |
| `premiumMultiplier` | `number` | No | Cost multiplier for premium features (e.g. extended context). |
| `contextWindow` | `number` | No | Maximum context length in tokens. Defaults to `128000`. |
| `maxTokens` | `number` | No | Maximum completion length in tokens. Defaults to `16384`. |
| `headers` | `object` | No | Per-model headers merged with provider-level headers. |
| `compat` | `object` | No | Per-model compatibility overrides. Merged with provider-level `compat`. |
| `contextPromotionTarget` | `string` | No | Target model ID for automatic context-window promotion when the session grows too large. |

### Compatibility Options (`compat`)

The `compat` block tells Aery how to translate its internal representation into provider-specific quirks. All fields are optional booleans, strings, or objects.

| Flag | Type | What It Does |
|------|------|--------------|
| `supportsStore` | `boolean` | The provider supports the `store` parameter for persisting completions server-side. |
| `supportsDeveloperRole` | `boolean` | The provider accepts a `developer` system-message role instead of `system`. |
| `supportsMultipleSystemMessages` | `boolean` | The provider allows more than one system message in the conversation array. |
| `supportsReasoningEffort` | `boolean` | The provider accepts a `reasoning_effort` parameter. |
| `reasoningEffortMap` | `object` | Maps Aery's five effort levels to provider-specific strings. See [Reasoning Effort Maps](#reasoning-effort-maps). |
| `maxTokensField` | `string` | Rename the outgoing `max_tokens` field. Allowed values: `"max_completion_tokens"` or `"max_tokens"`. |
| `supportsUsageInStreaming` | `boolean` | The provider embeds `usage` objects inside streaming chunks. |
| `requiresToolResultName` | `boolean` | Tool-result messages must carry a `name` field. |
| `requiresMistralToolIds` | `boolean` | Tool IDs must be prefixed with the Mistral convention. |
| `requiresAssistantAfterToolResult` | `boolean` | An `assistant` message is required immediately after every `tool` result. |
| `requiresThinkingAsText` | `boolean` | Reasoning content must be injected as a plain-text assistant message rather than a separate field. |
| `reasoningContentField` | `string` | Field name for reasoning content in the response. `"reasoning_content"`, `"reasoning"`, or `"reasoning_text"`. |
| `requiresReasoningContentForToolCalls` | `boolean` | Tool calls must be preceded by reasoning content. |
| `allowsSyntheticReasoningContentForToolCalls` | `boolean` | Aery may inject synthetic reasoning content before tool calls when the model omits it. |
| `requiresAssistantContentForToolCalls` | `boolean` | Tool-call messages must also contain non-empty `content`. |
| `supportsToolChoice` | `boolean` | The provider supports the `tool_choice` parameter for forcing tool invocation. |
| `disableReasoningOnForcedToolChoice` | `boolean` | Disable reasoning when `tool_choice` is `required` or a named function. |
| `disableReasoningOnToolChoice` | `boolean` | Broader variant: disable reasoning whenever any `tool_choice` is active. |
| `thinkingFormat` | `string` | Format of thinking blocks. `"openai"`, `"openrouter"`, `"zai"`, `"qwen"`, `"qwen-chat-template"`. |
| `openRouterRouting` | `object` | `{ only?: string[], order?: string[] }`. Provider-id filter and ordering for OpenRouter routing. |
| `vercelGatewayRouting` | `object` | Same shape as `openRouterRouting`, for Vercel AI Gateway. |
| `extraBody` | `object` | Arbitrary key/value pairs merged into every request body. |
| `supportsStrictMode` | `boolean` | The provider supports strict JSON-schema tool definitions. |
| `toolStrictMode` | `string` | Override strict mode per provider. `"all_strict"` or `"none"`. |

### Reasoning Effort Maps

Aery uses five internal effort levels: `minimal`, `low`, `medium`, `high`, `xhigh`. Not every provider accepts the same strings. When `supportsReasoningEffort: true` is set, you can supply a `reasoningEffortMap` to translate Aery's levels into whatever the provider expects.

```yaml
compat:
  supportsReasoningEffort: true
  reasoningEffortMap:
    minimal: low
    low: low
    medium: medium
    high: high
    xhigh: high
```

In this example, Aery's `minimal`, `low`, and `medium` map to the provider's `low` and `medium`, while `high` and `xhigh` both map to `high`. The map is optional: if you omit it, Aery sends the raw internal level name.

---

## Auth Resolution Chain

When Aery needs a credential for a provider, it walks the following chain from highest to lowest priority:

1. **Runtime override** — set with `aery --api-key sk-...` or programmatically via `setRuntimeApiKey()`.
2. **Config override** — the `apiKey` field in `models.yml` for that provider. Loaded by `setConfigApiKey()` during registry refresh.
3. **Stored credentials** — API keys saved in Aery's local SQLite credential store (`~/.aery/agent/auth.db`).
4. **OAuth tokens** — OAuth credentials that were obtained via `aery login <provider>` and can be refreshed automatically.
5. **Environment variables** — provider-specific env vars such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
6. **Fallback resolver** — last-resort hook for custom providers that do not match any of the above.

This means that **pinning an `apiKey` in `models.yml` overrides everything except an explicit CLI `--api-key` flag**. If you want Aery to use a stored credential or OAuth flow instead, remove the `apiKey` line from `models.yml`.

---

## The `auth-json` Sentinel Bug

Older versions of the custom-provider flow wrote `apiKey: auth-json` into `models.yml` as a placeholder and then resolved the real key through a side channel. This has two problems:

1. `auth-json` is not a real key, so validation fails when no stored credential exists.
2. Because config overrides rank above stored credentials, a lingering `auth-json` entry shadows a freshly saved key in the credential store.

**Always write the real key in `models.yml`:**

```yaml
# Correct
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    apiKey: sk-real-key-here
    models:
      - id: gpt-4o

# Wrong — do not do this
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    apiKey: auth-json
    models:
      - id: gpt-4o
```

If you previously used `auth-json`, delete the `apiKey` line entirely (to let stored credentials win) or replace it with the real key.

---

## Complete Example: Kimchi

Below is a production-grade `models.yml` snippet for a fictional provider "kimchi" that exposes five models. Two models support reasoning with a custom effort map; the other three do not.

```yaml
providers:
  kimchi:
    baseUrl: https://api.kimchi.ai/v1
    apiKey: sk-kimchi-production-key
    api: openai-completions
    compat:
      supportsDeveloperRole: true
      supportsReasoningEffort: true
      reasoningEffortMap:
        minimal: low
        low: low
        medium: medium
        high: high
        xhigh: high
      supportsToolChoice: true
      supportsUsageInStreaming: true
      requiresAssistantAfterToolResult: true
      maxTokensField: max_completion_tokens
    models:
      - id: kimi-k2.6
        name: Kimi K2.6
        reasoning: true
        thinking:
          minLevel: low
          maxLevel: high
          mode: effort
          defaultLevel: medium
        input:
          - text
          - image
        contextWindow: 256000
        maxTokens: 8192

      - id: kimi-k2.5
        name: Kimi K2.5
        reasoning: true
        thinking:
          minLevel: low
          maxLevel: high
          mode: effort
          defaultLevel: medium
        input:
          - text
        contextWindow: 128000
        maxTokens: 8192
        compat:
          supportsReasoningEffort: true

      - id: nemotron
        name: NVIDIA Nemotron
        reasoning: false
        input:
          - text
        contextWindow: 128000
        maxTokens: 4096

      - id: minimax
        name: MiniMax
        reasoning: false
        input:
          - text
        contextWindow: 8192
        maxTokens: 4096
        compat:
          supportsDeveloperRole: false

      - id: minimax-pro
        name: MiniMax Pro
        reasoning: false
        input:
          - text
          - image
        contextWindow: 16384
        maxTokens: 8192
        cost:
          input: 0.000001
          output: 0.000002
```

### Notes on the Kimchi example

- **Provider-level `compat`** applies to every model unless a model defines its own `compat` block. Model-level values are merged on top of provider-level values.
- **Reasoning effort map**: Kimchi only understands `low`, `medium`, and `high`. The map collapses Aery's `minimal` and `low` into `low`, and `high` and `xhigh` into `high`. This prevents 400 errors from unsupported effort strings.
- **`maxTokensField: max_completion_tokens`** renames the outgoing field because Kimchi's endpoint expects OpenAI's newer Responses API naming rather than the legacy Chat Completions field.
- **Cost fields** are optional but help Aery display estimated spend in the status line when usage tracking is enabled.

---

## Validating Your Config

After editing `models.yml`, verify that Aery can parse and load your provider without errors:

```sh
aery --list-models kimchi
```

Replace `kimchi` with your provider ID. If the config is valid, Aery prints a table with every model, its context window, max tokens, and input modalities. If there is a schema error, the CLI prints the validation message and exits non-zero.

You can also list **all** registered models to see how your custom entries coexist with built-ins:

```sh
aery --list-models
```

### Dry-run a request

To confirm auth and routing are working end-to-end, start a one-shot session against a custom model:

```sh
aery -p "say hello" --model kimchi/kimi-k2.6
```

The `provider/model-id` syntax pins the model for that single invocation.

---

## Troubleshooting

### `registry.getError()` reports a validation error

- Check that every model has a non-empty `id`.
- Check that `baseUrl` starts with `https://` or `http://`.
- If you omitted `apiKey`, either set `auth: none` or ensure a credential exists in the SQLite store (`aery login` or `aery auth-broker`).

### Requests return 401 Unauthorized

- Verify the auth resolution chain. If `models.yml` has an `apiKey`, that value is sent verbatim. If the value is wrong, requests fail.
- If you intended to use a stored credential, remove the `apiKey` line from `models.yml` so the stored credential is not shadowed.

### Reasoning content is missing or garbled

- Set `reasoning: true` on the model definition.
- If the provider returns reasoning in a non-standard field, set `reasoningContentField` to the correct key name.
- If the provider requires reasoning content to precede tool calls, enable `requiresReasoningContentForToolCalls`.

### Tool calls fail with schema errors

- Try `disableStrictTools: true` at the provider level.
- If the provider requires tool-result names, set `requiresToolResultName: true`.
- If the provider requires an `assistant` message after every tool result, set `requiresAssistantAfterToolResult: true`.

### Model is not listed in `--list-models`

- Confirm the provider ID matches exactly (it is case-sensitive).
- Confirm `models.yml` is at `~/.aery/agent/models.yml`, not a custom path.
- Run `aery --list-models` with no argument and grep for a known model ID to verify the file was loaded.
