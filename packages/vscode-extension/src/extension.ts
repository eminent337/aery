import * as vscode from "vscode";
import { AeryChatViewProvider } from "./chatViewProvider";

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "aery-vscode" is now active!');

	const disposable = vscode.commands.registerCommand("aery.helloWorld", () => {
		vscode.window.showInformationMessage("Hello World from Aery!");
	});
	context.subscriptions.push(disposable);

	// Register Sidebar Webview
	const chatProvider = new AeryChatViewProvider(context.extensionUri);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(AeryChatViewProvider.viewType, chatProvider));

	// Register Context Menu Command
	const explainDisposable = vscode.commands.registerCommand("aery.explainCode", () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const selection = editor.selection;
			const text = editor.document.getText(selection);
			if (text) {
				vscode.window.showInformationMessage(`Aery is explaining ${text.length} characters of code...`);
			} else {
				vscode.window.showInformationMessage("Please select some code first.");
			}
		}
	});
	context.subscriptions.push(explainDisposable);
}

export function deactivate() {}
