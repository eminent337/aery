import * as vscode from "vscode";

export class AeryChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "aery.chatView";

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case "chat":
					vscode.window.showInformationMessage(`Aery Chat received: ${data.value}`);
					break;
			}
		});
	}

	private _getHtmlForWebview(_webview: vscode.Webview) {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Aery Chat</title>
				<style>
					body {
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 10px;
                    }
                    #chat-container {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        box-sizing: border-box;
                    }
                    #messages {
                        flex: 1;
                        overflow-y: auto;
                        margin-bottom: 10px;
                    }
                    .message {
                        margin-bottom: 10px;
                        padding: 8px;
                        border-radius: 4px;
                        background: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                    }
                    #input-container {
                        display: flex;
                    }
                    input {
                        flex: 1;
                        padding: 8px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                    }
                    button {
                        padding: 8px 12px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        cursor: pointer;
                        margin-left: 5px;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
				</style>
			</head>
			<body>
				<div id="chat-container">
                    <div id="messages">
                        <div class="message">Hello! I am Aery, your coding assistant. How can I help you today?</div>
                    </div>
                    <div id="input-container">
                        <input type="text" id="chat-input" placeholder="Ask Aery something..." />
                        <button id="send-button">Send</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    const sendButton = document.getElementById('send-button');
                    const chatInput = document.getElementById('chat-input');
                    const messages = document.getElementById('messages');

                    sendButton.addEventListener('click', () => {
                        const text = chatInput.value;
                        if (text) {
                            const msgEl = document.createElement('div');
                            msgEl.className = 'message';
                            msgEl.textContent = 'You: ' + text;
                            messages.appendChild(msgEl);
                            
                            vscode.postMessage({
                                type: 'chat',
                                value: text
                            });
                            chatInput.value = '';
                        }
                    });

                    chatInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            sendButton.click();
                        }
                    });
                </script>
			</body>
			</html>`;
	}
}
