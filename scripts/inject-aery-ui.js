const fs = require('fs');

const target = 'packages/coding-agent/src/modes/interactive/interactive-mode.ts';
if (!fs.existsSync(target)) {
  console.error("interactive-mode.ts not found!");
  process.exit(1);
}

let content = fs.readFileSync(target, 'utf-8');

// 1. Constants
const consts = `const CUSTOM_OPENAI_COMPATIBLE_PROVIDER_LABEL = "Custom OpenAI-compatible";
const AERY_GATEWAY_PROVIDER_ID = "__aery-gateway__";
const AERY_GATEWAY_BASE_URL = "https://aery-gateway.eminent337.workers.dev/v1";`;

if (!content.includes('AERY_GATEWAY_PROVIDER_ID')) {
  if (content.includes('CUSTOM_OPENAI_COMPATIBLE_PROVIDER_LABEL')) {
    content = content.replace(
      /const CUSTOM_OPENAI_COMPATIBLE_PROVIDER_LABEL = "Custom OpenAI-compatible";/,
      consts
    );
  } else {
    content = content.replace(
      /const API_KEY_LOGIN_PROVIDER_BLOCKLIST = new Set\(\["amazon-bedrock", "llama\.cpp", "lmstudio", "ollama"\]\);/,
      `const API_KEY_LOGIN_PROVIDER_BLOCKLIST = new Set(["amazon-bedrock", "llama.cpp", "lmstudio", "ollama"]);\n${consts}`
    );
  }
}

// 2. getLoginProviderOptions
const getLoginProviderOptionsAdd = `\t\tif (!authType || authType === "api_key") {
\t\t\toptions.push({
\t\t\t\tid: AERY_GATEWAY_PROVIDER_ID,
\t\t\t\tname: "Aery Gateway",
\t\t\t\tauthType: "api_key",
\t\t\t});
\t\t\toptions.push({
\t\t\t\tid: CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID,
\t\t\t\tname: CUSTOM_OPENAI_COMPATIBLE_PROVIDER_LABEL,
\t\t\t\tauthType: "api_key",
\t\t\t});
\t\t}`;

if (!content.includes('AERY_GATEWAY_PROVIDER_ID,') || !content.includes('name: "Aery Gateway"')) {
  content = content.replace(
    /\t\tif \(\!authType \|\| authType === "api_key"\) \{\n\t\t\toptions\.push\(\{\n\t\t\t\tid: CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID,\n\t\t\t\tname: CUSTOM_OPENAI_COMPATIBLE_PROVIDER_LABEL,\n\t\t\t\tauthType: "api_key",\n\t\t\t\}\);\n\t\t\}/g,
    "" // Remove existing if we injected earlier
  );
  content = content.replace(
    /const filteredOptions = authType \? options\.filter\(\(option\) => option\.authType === authType\) : options;/,
    `${getLoginProviderOptionsAdd}\n\n\t\tconst filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;`
  );
}

// 3. showLoginProviderSelector
const showLoginProviderSelectorAdd = `if (providerOption.id === AERY_GATEWAY_PROVIDER_ID) {
\t\t\t\t\t\tawait this.showAeryGatewayLoginDialog();
\t\t\t\t\t} else if (providerOption.id === CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID) {
\t\t\t\t\t\tawait this.showCustomOpenAICompatibleLoginDialog();
\t\t\t\t\t} else if (providerOption.authType === "oauth") {`;

if (!content.includes('this.showAeryGatewayLoginDialog()')) {
  if (content.includes('providerOption.id === CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID')) {
    content = content.replace(
      /if \(providerOption\.id === CUSTOM_OPENAI_COMPATIBLE_PROVIDER_ID\) \{\n\t\t\t\t\t\tawait this\.showCustomOpenAICompatibleLoginDialog\(\);\n\t\t\t\t\t\} else if \(providerOption\.authType === "oauth"\) \{/,
      showLoginProviderSelectorAdd
    );
  } else {
    content = content.replace(
      /if \(providerOption\.authType === "oauth"\) \{/,
      showLoginProviderSelectorAdd
    );
  }
}

// 4. showAeryGatewayLoginDialog method
const gatewayMethod = `
\tprivate async showAeryGatewayLoginDialog(): Promise<void> {
\t\tconst dialog = new LoginDialogComponent(
\t\t\tthis.ui,
\t\t\tAERY_GATEWAY_PROVIDER_ID,
\t\t\t(_success, _message) => {},
\t\t\t"Connect to Aery Gateway",
\t\t);

\t\tthis.editorContainer.clear();
\t\tthis.editorContainer.addChild(dialog);
\t\tthis.ui.setFocus(dialog);
\t\tthis.ui.requestRender();

\t\tconst restoreEditor = () => {
\t\t\tthis.editorContainer.clear();
\t\t\tthis.editorContainer.addChild(this.editor);
\t\t\tthis.ui.setFocus(this.editor);
\t\t\tthis.ui.requestRender();
\t\t};

\t\ttry {
\t\t\tconst aeryKey = (await dialog.showPrompt("Enter your Aery key:", "aery_...")).trim();
\t\t\tif (!aeryKey) throw new Error("Aery key cannot be empty.");

\t\t\tconst provider = (
\t\t\t\tawait dialog.showPrompt("Provider to route through (e.g. anthropic, openai, openrouter):", "anthropic")
\t\t\t).trim();
\t\t\tif (!provider) throw new Error("Provider cannot be empty.");

\t\t\tconst modelId = (await dialog.showPrompt("Model ID:", "claude-sonnet-4-5")).trim();
\t\t\tif (!modelId) throw new Error("Model ID cannot be empty.");

\t\t\tconst baseUrl = \`\${AERY_GATEWAY_BASE_URL}/\${provider}\`;
\t\t\tconst saved = saveCustomOpenAICompatibleProvider({
\t\t\t\tmodelsPath: getModelsPath(),
\t\t\t\tbaseUrl,
\t\t\t\tmodelId,
\t\t\t});
\t\t\tthis.session.modelRegistry.authStorage.set(saved.providerId, { type: "api_key", key: aeryKey });
\t\t\tthis.session.modelRegistry.refresh();

\t\t\trestoreEditor();
\t\t\tawait this.updateAvailableProviderCount();
\t\t\tthis.footer.invalidate();
\t\t\tthis.updateEditorBorderColor();

\t\t\tconst model = this.session.modelRegistry.find(saved.providerId, saved.modelId);
\t\t\tif (model) {
\t\t\t\ttry {
\t\t\t\t\tawait this.session.setModel(model);
\t\t\t\t\tthis.showStatus(\`Connected to Aery Gateway → \${provider}/\${modelId}.\`);
\t\t\t\t} catch {
\t\t\t\t\tthis.showStatus(\`Aery Gateway configured. Use /model to select \${saved.providerId}/\${modelId}.\`);
\t\t\t\t}
\t\t\t}
\t\t} catch (error: unknown) {
\t\t\trestoreEditor();
\t\t\tconst errorMsg = error instanceof Error ? error.message : String(error);
\t\t\tif (errorMsg !== "Login cancelled") {
\t\t\t\tthis.showError(\`Failed to connect to Aery Gateway: \${errorMsg}\`);
\t\t\t}
\t\t}
\t}`;

if (!content.includes('showAeryGatewayLoginDialog() {')) {
  content = content.replace(
    /private showOAuthLoginSelect\(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt\): Promise<string \| undefined> \{/,
    `${gatewayMethod}\n\n\tprivate showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {`
  );
}

// 5. Codex-style banner box (replaces ASCII art mascot)
if (!content.includes('Codex-style info banner')) {
  // Remove old ASCII art mascot if present
  content = content.replace(
    /\/\/ Aery ASCII art mascot\n[\s\S]*?this\.headerContainer\.addChild\(new Spacer\(1\)\);/,
    `// Codex-style info banner (always shown, re-reads state on each render)
\t\tconst version = this.version;
\t\tconst accent = (t: string) => theme.fg("accent", t);
\t\tconst dim = (t: string) => theme.fg("dim", t);
\t\tconst borderMuted = (t: string) => theme.fg("borderMuted", t);
\t\tconst boxLine = (content: string, inner: number, rawLen: number): string => {
\t\t\tconst pad = Math.max(0, inner - rawLen);
\t\t\treturn \`\${borderMuted("│")} \${content}\${" ".repeat(pad)} \${borderMuted("│")}\`;
\t\t};
\t\tconst tips = [
\t\t\t"/model to change model",
\t\t\t"/settings to configure",
\t\t\t"/login to authenticate",
\t\t\t"/new to start fresh",
\t\t\t"/tree to browse history",
\t\t\t"/share to export session",
\t\t\t"/hotkeys for shortcuts",
\t\t\t"Ctrl+O to expand output",
\t\t\t"Shift+Tab: cycle thinking",
\t\t\t"! to run bash commands",
\t\t];
\t\tlet lastTipEntryCount = 0;
\t\tlet tipIndex = 0;
\t\tconst session = this.session;
\t\tconst sessionMgr = this.sessionManager;
\t\tthis.bannerLogo = {
\t\t\tinvalidate() {},
\t\t\trender(width: number): string[] {
\t\t\t\tconst model = session.model;
\t\t\t\tconst modelName = model?.name || model?.id || "";
\t\t\t\tconst thinkingLevel = session.thinkingLevel || "off";
\t\t\t\tconst modelStr = modelName ? \`\${modelName}\${thinkingLevel !== "off" ? \` \${thinkingLevel}\` : ""}\` : "not set";
\t\t\t\tconst cwd = sessionMgr.getCwd();
\t\t\t\tconst cwdDisplay = cwd.replace(/^\\/$/, "~");
\t\t\t\tconst entryCount = sessionMgr.getEntries().length;
\t\t\t\tif (entryCount !== lastTipEntryCount) {
\t\t\t\t\ttipIndex = (tipIndex + 1) % tips.length;
\t\t\t\t\tlastTipEntryCount = entryCount;
\t\t\t\t}
\t\t\t\tconst inner = width - 4;
\t\t\t\tconst top = \`\${borderMuted("╭")}\${borderMuted("─".repeat(inner))}\${borderMuted("╮")}\`;
\t\t\t\tconst bottom = \`\${borderMuted("╰")}\${borderMuted("─".repeat(inner))}\${borderMuted("╰")}\`;
\t\t\t\tconst titleRaw = \`>_ \${APP_TITLE} (v\${version})\`;
\t\t\t\tconst tip = tips[tipIndex];
\t\t\t\tconst modelRaw = \`model:     \${modelStr}   \${dim(tip)}\`;
\t\t\t\tconst dirRaw = \`directory: \${cwdDisplay}\`;
\t\t\t\treturn [
\t\t\t\t\ttop,
\t\t\t\t\tboxLine(accent(titleRaw), inner, titleRaw.length),
\t\t\t\t\tboxLine("", inner, 0),
\t\t\t\t\tboxLine(dim(modelRaw), inner, modelRaw.length),
\t\t\t\t\tboxLine(dim(dirRaw), inner, dirRaw.length),
\t\t\t\t\tbottom,
\t\t\t\t];
\t\t\t},
\t\t};
\t\tthis.headerContainer.addChild(this.bannerLogo);
\t\tthis.headerContainer.addChild(new Spacer(1));`
  );
}

fs.writeFileSync(target, content);
console.log("Injected aery-gateway to interactive-mode.ts");
