# Aerys Workspace: Session Handoff & Quickstart

## Welcome to Aerys!

This workspace is dedicated to building the **all-powerful Aery Desktop Assistant & Multi-Agent Swarm Orchestrator (J.A.R.V.I.S.-like)**.

### Workspace Status
- **Location:** `/home/aryee/aery/aerys`
- **Git Branch:** `feat/aerys`
- **Origin Remote:** `https://github.com/eminent337/aery.git`
- **Build Status:** Verified clean build with `bun install`, 0 typecheck errors in all packages.
- **Session State:** Full transcript and agent history synced to `/home/aryee/.aery/agent/sessions/-aery-aerys/`.

---

## Core Objectives (Summary of OBJECTIVES.md)

1. **Multi-Terminal & Swarm Commander (Pillar 1)**
   - Kitty remote control (`kitty @ launch`) and Tmux split-window management.
   - Programmatically spawn visible worker panes and orchestrate parallel coding subagents.
2. **Desktop Vision & Computer Use (Pillar 2)**
   - DPI-aware screen/window capture.
   - Native desktop application control (mouse clicks, drags, keyboard shortcuts).
3. **Ambient Voice & Audio Duplex (Pillar 3)**
   - Streaming STT $\to$ LLM $\to$ Streaming TTS.
   - Real-time VAD & barge-in interruption handling.
4. **Personal Companion Memory (Pillar 4)**
   - Persistent cross-session relationship and project memory.
   - Witty, loyal, high-competence persona.

---

## Immediate Next Actions
1. **Clone reference open-source repos into a study cache (e.g. `study/`):**
   - `computer-use-demo` (Anthropic Quickstarts)
   - `open-interpreter`
   - `self-operating-computer`
   - `livekit-agents`
2. **Phase 1 Implementation:**
   - Create `packages/coding-agent/src/tools/terminal-pane.ts` to control Kitty/Tmux panes.
