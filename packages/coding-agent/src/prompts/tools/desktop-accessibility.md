OS-Native Desktop Accessibility Tool powered by agent-desktop (AT-SPI on Linux, AX on macOS, UI Automation on Windows).

<instruction>
- Provides sub-15ms deterministic UI tree inspection and headless semantic interactions without moving the physical mouse cursor.
- Actions:
  - `snapshot`: Inspect the accessibility tree of active windows or a target app/window title (`target`). Returns hierarchical element nodes with ref IDs (`@<snapshot_id>:e<N>`), roles, names, values, states, and available actions.
  - `click`: Headless click on element ref ID (`ref: "@s1:e5"`). Does not move the mouse pointer.
  - `type`: Type text into an element ref ID (`ref: "@s1:e5"`, `text: "hello"`).
  - `set_value`: Set an input, slider, or combobox value directly.
  - `toggle`: Toggle checkboxes or switch elements.
  - `focus`: Focus an element.
  - `select`: Select an element or dropdown item.
  - `list_windows`: List all active desktop windows with titles, app IDs, and PIDs.
  - `status`: Check accessibility daemon permissions and platform status.
- Elements are identified deterministically by ref IDs (@<snapshot_id>:e<N>). Always run `snapshot` first to obtain fresh ref IDs before invoking `click`, `type`, or `set_value`.
- Prefer `desktop_accessibility` over visual OCR (`desktop_control`) whenever interacting with desktop windows, dialogs, forms, and apps: it is 10x faster, deterministic, and does not hijack the user's cursor.
</instruction>

<examples>
# List open windows
`{"action":"list_windows"}`

# Snapshot active or targeted window
`{"action":"snapshot","target":"Brave","maxDepth":4}`

# Headless click on element
`{"action":"click","ref":"@s1:e12"}`

# Type into element
`{"action":"type","ref":"@s1:e15","text":"search query"}`
</examples>
