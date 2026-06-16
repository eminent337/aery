/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@aryee337/aery-utils";
import { detectMultiplexer, openMultiplexerPane } from "./terminal-multiplexer.js";

export { detectMultiplexer, type MultiplexerInfo } from "./terminal-multiplexer.js";

/** Returns the user's preferred editor command, or undefined if not configured. */
export function getEditorCommand(): string | undefined {
	return $env.VISUAL || $env.EDITOR || undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). Only used for direct (non-multiplexer) spawn. */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
	/**
	 * Whether to open in a multiplexer pane when one is detected.
	 * - `"auto"` (default): detect and use if available.
	 * - `true`: always try multiplexer (fails if none detected).
	 * - `false`: never use multiplexer; spawn directly.
	 */
	useMultiplexer?: boolean | "auto";
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 * Callers can use {@link detectMultiplexer} beforehand to know whether a
 * pane will be used and skip TUI stop/start accordingly.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `aery-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const mux =
			options?.useMultiplexer !== false ? (options?.useMultiplexer === true ? detectMultiplexer() : detectMultiplexer()) : null;

		let exitCode: number;
		if (mux) {
			const result = await openMultiplexerPane(mux, {
				editorCmd,
				filePath: tmpFile,
			});
			exitCode = result.exitCode;
		} else {
			if (options?.useMultiplexer === true) {
				throw new Error("No supported terminal multiplexer detected.");
			}
			const [editor, ...editorArgs] = editorCmd.split(" ");
			const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];

			const child = spawn(editor, [...editorArgs, tmpFile], { stdio, shell: process.platform === "win32" });
			const { promise, reject, resolve } = Promise.withResolvers<number>();
			child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
			child.once("error", error => reject(error));
			exitCode = await promise;
		}

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
