# Session Handoff & Project Briefing: Aery Jarvis

## Executive Summary
This workspace (`/home/aryee/aery/aery-jarvis`) is the dedicated evolution of **Aery** into **Aery Jarvis**: an all-powerful, ambient desktop commander and agent orchestrator.

- **`aery`** (`/home/aryee/aery/ai_agent/aery`) remains the surgical, high-performance terminal AI coding agent (all latest rendering, image dedup, video retry, and crash-loop fixes are committed and pushed to `origin/main` on GitHub).
- **`aery-jarvis`** (`/home/aryee/aery/aery-jarvis`) is the new home where we build the overarching assistant (audio voice duplex, desktop/app vision and computer use, and multi-terminal swarm orchestration across Kitty/Tmux panes).

---

## Workspace Setup Status
1. **Repository Location:** `/home/aryee/aery/aery-jarvis`
2. **Git Branch:** `feat/aery-jarvis`
3. **Remote:** `https://github.com/eminent337/aery.git` (synchronized with upstream main)
4. **Dependencies & Build:** `bun install` completed; `packages/coding-agent` and `packages/tui` both typecheck with **0 errors**.
5. **Session State:** Full transcript and session data from the original session have been copied to:
   `/home/aryee/.aery/agent/sessions/-aery-aery-jarvis/2026-06-08T23-16-03-588Z_019ea985-9184-7000-8a4e-53ab11080dc1.jsonl`

---

## Objectives & Roadmap Overview (Detailed in `OBJECTIVES.md`)

### The 4 Core Pillars
1. **Multi-Terminal & Swarm Commander:**
   - Programmatically spawn, arrange, and manage visible terminal panes via Kitty remote control (`kitty @ launch`) and Tmux control mode (`tmux split-window`).
   - Command and coordinate sub-agents visually across multiple terminal windows instead of hidden background threads.
2. **Desktop Vision & Computer Use:**
   - OS-level screen/window capture with high-DPI coordinate scaling.
   - Native mouse/keyboard interaction with desktop apps (VS Code, browser, Figma, etc.).
3. **Ambient Voice & Audio Duplex:**
   - Real-time streaming voice loop (VAD $\to$ STT $\to$ LLM $\to$ TTS) with sub-second turnaround and instant interruption/barge-in.
4. **Companion Memory & Technical Persona:**
   - Long-term cross-session memory with a sharp, dry-witted, loyal technical copilot persona.

---

## Next Steps to Execute Here
- **Phase 1 (Immediate Next Task):** Implement `packages/coding-agent/src/tools/terminal-pane.ts`
  - Support Kitty socket API (`KITTY_LISTEN_ON` or `--to`) and Tmux fallback.
  - Expose actions: `split_pane`, `send_keys`, `read_pane`, `close_pane`.
  - Connect agent task delegation so workers can be spawned in live, visible terminal panes.
- **Reference Repos to Study:**
  - `anthropics/anthropic-quickstarts/computer-use-demo` (screen coordinates & input automation)
  - `open-interpreter/open-interpreter` (OS mode & computer control)
  - `livekit/agents` (low-latency voice loop & VAD)
