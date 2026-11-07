# Spec: Native OS Accessibility Driver & Agent-Desktop Integration for Aery

**Author**: Antigravity (AI Pair Programmer)  
**Date**: November 7, 2026  
**Status**: In Progress  
**Target Package**: `@aryee337/aery-coding-agent` (`packages/coding-agent`)

---

## 1. Problem Statement & Motivation

Prior desktop automation in Aery relied heavily on visual OCR (`live_eye`) and simulated mouse clicks (`live_click` via `ydotool`/`xdotool`). While functional for general desktop navigation, this paradigm exhibited major limitations:

1. **Slow Execution**: Vision processing (taking screenshot -> writing to disk / in-memory -> OCR / multimodal LLM inference) requires 300ms to 1500ms per step.
2. **Brittle Element Resolution**: Guessing coordinates or text bounding boxes often fails on complex document layouts, form fields, disabled controls, custom web components, or when screens re-render or scale.
3. **Cursor Interference**: Physical mouse hijacking steals user control and focus.
4. **Failure on Document Layouts**: On applications such as LibreOffice, Word, Evince, or web PDF viewers, OCR does not capture document structure, hierarchy, styles, or editable text boundaries.

### The Solution: OS Accessibility Tree & Agent-Desktop Architecture

Vercel Labs' open-sourced **`agent-desktop`** demonstrates that OS-native accessibility trees (AX on macOS, UI Automation on Windows, and AT-SPI on Linux):
- Run in **<15ms**.
- Provide rich semantic node hierarchies (`role`, `name`, `value`, `states`, `actions`).
- Assign deterministic snapshot-scoped reference IDs (`@<snapshot_id>:e<N>`).
- Allow **headless action dispatching** (e.g., semantic `click`, `type`, `set_value`, `toggle`, `select`) without moving the mouse pointer or stealing focus.

By embedding and integrating `agent-desktop` directly into Aery:
- Aery gains instant OS accessibility tree inspection and headless interaction.
- Visual-first document rules can inspect actual application accessibility widgets and document models before modifying files.
- Desktop automation becomes deterministic, ultra-fast, and completely non-intrusive.

---

## 2. Architecture & Design

```
+-------------------------------------------------------------+
|                        Aery Agent                           |
|       (Autonomous Loop / Gemini Computer Use / Live)        |
+-------------------------------------------------------------+
                               |
               +---------------+---------------+
               |                               |
       [Visual Pipeline]             [Accessibility Pipeline]
    (live_eye / grim / OCR)           (desktop_accessibility)
               |                               |
               |                               v
               |               +-------------------------------+
               |               |  DesktopAccessibilityDriver   |
               |               |  (Node/TypeScript wrapper)    |
               |               +-------------------------------+
               |                               |
               |                               v
               |               +-------------------------------+
               |               |     agent-desktop Native      |
               |               |      (Rust release binary)    |
               |               +-------------------------------+
               |                               |
               |           +-------------------+-------------------+
               |           |                   |                   |
               v           v                   v                   v
     [Physical Mouse/Keys] [Linux AT-SPI]  [macOS AX]   [Windows UI Automation]
```

### 2.1 Core Tool Interface: `desktop_accessibility`

The `desktop_accessibility` tool exposes native accessibility operations via JSON:

```typescript
export interface DesktopAccessibilityParams {
  action:
    | "status"          // Check platform accessibility bus & permissions
    | "snapshot"        // Snapshot app or window accessibility tree
    | "click"           // Click element by ref (@<snapshot_id>:e<N>)
    | "type"            // Type text into element by ref
    | "set_value"       // Directly set text/value of element by ref
    | "clear"           // Clear text of element by ref
    | "press"           // Press key or shortcut (e.g. Return, Ctrl+S)
    | "focus"           // Focus element by ref
    | "toggle"          // Toggle checkbox or switch
    | "select"          // Select dropdown item
    | "scroll"          // Scroll element or window
    | "find"            // Find element by role/name
    | "list_apps"       // List running desktop applications
    | "list_windows"    // List open desktop windows
    | "wait";           // Wait for element/window condition

  app?: string;         // Target application name (e.g. "libreoffice", "kitty")
  window_id?: string;   // Window ID if targeting a specific window
  ref?: string;         // Qualified ref ID (@snapshot_id:eN)
  text?: string;        // Text to type or value to set
  key?: string;         // Key or key combination to press
  role?: string;        // Role filter for find/snapshot (e.g. "button", "entry")
  name?: string;        // Name filter for find/snapshot
  interactive_only?: boolean; // Default true: only return interactive elements (-i)
  compact?: boolean;    // Default true: compact output without redundant empty groups
  root_ref?: string;    // Subtree drill-down root ref
  headed?: boolean;     // Whether to force physical pointer/focus
  timeout_ms?: number;  // Operation timeout in ms
}
```

### 2.2 Integration with `desktop-drivers.ts`

`desktop-drivers.ts` is enhanced to include:
- `accessibility`: An `AccessibilityControl` interface on `DesktopDriver`.
- Detection of `agent-desktop` binary availability in:
  1. Aery internal vendor/natives directory (`dist/bin/agent-desktop` or bundled vendor path).
  2. System `$PATH` (`which agent-desktop`).

### 2.3 Headless vs. Headed Execution Rules
- By default, ref actions are headless: they call native AT-SPI / AX semantic APIs directly without moving the physical cursor.
- If an action requires physical coordinates (e.g., on Wayland unsupported custom widgets), the system safely falls back to visual verification + `ydotool` / `hyprctl`.
