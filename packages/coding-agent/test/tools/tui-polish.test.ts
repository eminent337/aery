import { describe, expect, test } from "bun:test";
import {
	type BranchLine,
	branchConnector,
	fileTypeIcon,
	fmtFileHeader,
	fmtToolHeader,
} from "../../src/tools/tui-polish";

describe("fileTypeIcon", () => {
	test("returns correct icon for known extensions", () => {
		expect(fileTypeIcon("foo.ts")).toBe("󰛦");
		expect(fileTypeIcon("bar.js")).toBe("󰌞");
		expect(fileTypeIcon("baz.py")).toBe("󰌠");
		expect(fileTypeIcon("main.rs")).toBe("󱘗");
		expect(fileTypeIcon("server.go")).toBe("󰟓");
		expect(fileTypeIcon("index.html")).toBe("󰌝");
		expect(fileTypeIcon("style.css")).toBe("󰌜");
		expect(fileTypeIcon("data.json")).toBe("󰘦");
		expect(fileTypeIcon("config.yaml")).toBe("󰘦");
		expect(fileTypeIcon("readme.md")).toBe("󰍔");
		expect(fileTypeIcon("query.sql")).toBe("󰆼");
		expect(fileTypeIcon("script.sh")).toBe("󰲋");
		expect(fileTypeIcon("Dockerfile")).toBe("󰡨");
		expect(fileTypeIcon("foo.toml")).toBe("󰄛");
	});

	test("returns correct icon for tsx", () => {
		expect(fileTypeIcon("baz.tsx")).toBe("󰌞");
	});

	test("returns generic icon for unknown extensions", () => {
		expect(fileTypeIcon("foo.xyz")).toBe("󰈙");
		expect(fileTypeIcon("bar.abc")).toBe("󰈙");
	});

	test("returns generic icon for files without extension", () => {
		expect(fileTypeIcon("Makefile")).toBe("󰈙");
		expect(fileTypeIcon("README")).toBe("󰈙");
	});
});

describe("fmtFileHeader", () => {
	test("formats filename with icon", () => {
		expect(fmtFileHeader("foo.ts")).toBe("󰛦 foo.ts");
		expect(fmtFileHeader("bar.py")).toBe("󰌠 bar.py");
	});
});

describe("branchConnector", () => {
	test("renders tree lines correctly", () => {
		// Single level, not last: vertical bar + ├─
		const lines: BranchLine[] = [{ depth: 0, isLast: false }];
		expect(branchConnector(lines)).toBe("│ ├─");
	});

	test("handles last-child correctly (└─)", () => {
		// Single level, last: spaces + └─
		const lines: BranchLine[] = [{ depth: 0, isLast: true }];
		expect(branchConnector(lines)).toBe("  └─");
	});

	test("handles non-last correctly (├─)", () => {
		// Same as single-level not-last
		const lines: BranchLine[] = [{ depth: 0, isLast: false }];
		expect(branchConnector(lines)).toBe("│ ├─");
	});

	test("handles nested branches", () => {
		// Root is not last → vertical bar, child is last → spaces + └─
		const lines: BranchLine[] = [
			{ depth: 0, isLast: false },
			{ depth: 1, isLast: true },
		];
		expect(branchConnector(lines)).toBe("│   └─");
	});

	test("handles empty array", () => {
		expect(branchConnector([])).toBe("");
	});
});

describe("fmtToolHeader", () => {
	test("renders with branch lines", () => {
		const branches: BranchLine[] = [{ depth: 0, isLast: false }];
		expect(fmtToolHeader("read", {}, branches)).toBe("│ ├─ read");
	});

	test("renders with file icon when args.file is present", () => {
		const args = { file: "foo.ts" };
		expect(fmtToolHeader("edit", args)).toBe("󰛦 edit");
	});

	test("renders with file icon when args.path is present", () => {
		const args = { path: "bar.py" };
		expect(fmtToolHeader("read", args)).toBe("󰌠 read");
	});

	test("renders with file icon when args.filename is present", () => {
		const args = { filename: "baz.tsx" };
		expect(fmtToolHeader("write", args)).toBe("󰌞 write");
	});

	test("renders without prefix when no file arg", () => {
		expect(fmtToolHeader("bash", { command: "ls" })).toBe("bash");
	});

	test("combines branch and file prefix", () => {
		const branches: BranchLine[] = [{ depth: 0, isLast: true }];
		const args = { file: "main.go" };
		expect(fmtToolHeader("edit", args, branches)).toBe("  └─ 󰟓 edit");
	});
});
