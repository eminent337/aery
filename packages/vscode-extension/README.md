# Aery VS Code Extension

This is the official native Visual Studio Code extension for the Aery Orchestrator. 
It provides the Webview Sidebar Chat and the Visual Memory Graph renderer.

## How to Package and Install

Because Aery is a Bun-based monorepo with internal symlinks, the standard `vsce package` command will fail with an `ELSPROBLEMS` error. 

To properly package this extension into an installable `.vsix` file, use the custom script which bypasses the dependency checks (since `esbuild` already bundles everything we need):

```bash
npm run package:vsix
# or
bun run package:vsix
```

This will generate an `aery-vscode-X.X.X.vsix` file in this directory.

To install it into your editor:
1. Open VS Code
2. Go to the **Extensions** panel
3. Click the `...` menu at the top right
4. Select **"Install from VSIX..."**
5. Select the generated `.vsix` file.

## Extension Development Host
If you are developing this extension and want to test it locally without packaging:
1. Open this `packages/vscode-extension` directory in VS Code.
2. Press **`F5`**.
3. A new Extension Development Host window will launch with the Aery Sidebar enabled.
