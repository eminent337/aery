import type { ExtensionAPI } from "@aryee337/aery";

let browser: any = null;
let page: any = null;

async function getPage() {
	if (!browser) {
		let playwright;
		try {
			playwright = await import("playwright");
		} catch (e) {
			throw new Error("Playwright is not installed. Please run `npm i playwright` to use the browser extension.");
		}
		browser = await playwright.chromium.launch({ headless: true });
		page = await browser.newPage();
	}
	return page;
}

export default function browserExtension(aery: ExtensionAPI) {
	aery.registerTool({
		name: "browser_navigate",
		label: "Browser: Navigate",
		description: "Navigate the persistent browser to a specific URL",
		parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		async execute(_id, args: any) {
			const p = await getPage();
			await p.goto((args as any).url);
			return { content: [{ type: "text", text: `Successfully navigated to ${(args as any).url}` }] };
		},
	});

	aery.registerTool({
		name: "browser_click",
		label: "Browser: Click",
		description: "Click an element on the persistent browser page using a CSS selector",
		parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
		async execute(_id, args: any) {
			const p = await getPage();
			await p.click((args as any).selector);
			return { content: [{ type: "text", text: `Successfully clicked ${(args as any).selector}` }] };
		},
	});

	aery.registerTool({
		name: "browser_screenshot",
		label: "Browser: Screenshot",
		description:
			"Take a screenshot of the current page in the persistent browser. The image will be returned natively.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _args: any) {
			const p = await getPage();
			const buffer = await p.screenshot();
			return {
				content: [
					{ type: "text", text: "Screenshot captured:" },
					{ type: "image", mimeType: "image/png", data: buffer.toString("base64") },
				],
			};
		},
	});

	aery.registerTool({
		name: "browser_html",
		label: "Browser: HTML",
		description: "Get the current HTML content of the page",
		parameters: { type: "object", properties: {} },
		async execute(_id, _args: any) {
			const p = await getPage();
			const html = await p.content();
			return { content: [{ type: "text", text: html }] };
		},
	});
}
