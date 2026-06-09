const fs = require('fs');
const file = '/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/modes/controllers/event-controller.ts';
let code = fs.readFileSync(file, 'utf8');

// handleMessageStart (User message)
code = code.replace(/this\.ctx\.addMessageToChat\(event\.message\);/g, 'this.ctx.aeryScreen.appendMessage({ role: event.message.role as any, content: this.ctx.getUserMessageText(event.message) }); this.ctx.addMessageToChat(event.message);');

// handleMessageStart (Assistant message)
code = code.replace(/this\.ctx\.chatContainer\.addChild\(this\.ctx\.streamingComponent\);/g, 'this.ctx.aeryScreen.appendMessage({ role: "assistant", content: "" }); this.ctx.chatContainer.addChild(this.ctx.streamingComponent);');

// handleMessageUpdate (Assistant chunk streaming)
code = code.replace(/this\.ctx\.streamingComponent\.updateContent\(this\.ctx\.streamingMessage\);/g, `this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			const newContent = this.ctx.extractAssistantText(this.ctx.streamingMessage);
			const lastContent = this.ctx.streamingMessage.content.slice(0, -1).map(c => c.type === "text" ? c.text : "").join("");
			// Instead of slicing, just extract and diff? Let's keep it simple: AeryScreen needs chunks, but streamChunk just appends.
			// Actually, just passing the new text chunk from event if possible, but event.message has the full state.
			// Let's compute delta manually:
			if (!this._lastAssistantTextLength) this._lastAssistantTextLength = 0;
			const currentText = this.ctx.extractAssistantText(this.ctx.streamingMessage);
			if (currentText.length > this._lastAssistantTextLength) {
				this.ctx.aeryScreen.streamChunk(currentText.slice(this._lastAssistantTextLength));
				this._lastAssistantTextLength = currentText.length;
			}
`);

// Reset _lastAssistantTextLength in handleMessageEnd
code = code.replace(/this\.ctx\.streamingMessage = undefined;/g, `this.ctx.streamingMessage = undefined; this._lastAssistantTextLength = 0;`);

fs.writeFileSync(file, code);
