# Aerys: The Desktop Commander & Autonomous Orchestrator

## 1. Vision & Purpose

**Aery** is our high-performance AI coding agent: surgical, terminal-first, and deeply integrated into software repositories.

**Aerys** is the evolutionary leap: an **all-powerful, ambient desktop orchestrator and companion**. It sits above your entire operating system, listens to your voice, watches your screens, operates desktop applications, and acts as the **General commanding an army of sub-agents across visible terminal panes**.

### Non-Goals
- **No Physical Hardware Fabrication:** We are not 3D printing or soldering physical boards; this is 100% focused on software, operating system control, and multi-agent developer workflows.

---

## 2. The 4 Core Pillars

### Pillar 1: Multi-Terminal & Swarm Commander
- **Visual Pane Spawning:** Programmatically spawn, split, and arrange visual terminal panes via terminal multiplexer sockets (**Kitty remote control** `kitty @ launch` / **Tmux control mode** `tmux split-window`).
- **Orchestration:** Launch dedicated coding subagents (Aery instances, workers) in visible panes, dispatch work, monitor their progress, and aggregate diffs.
- **Inter-Agent Protocol:** Leverage Aery's built-in IRC bus and task delegation so subagents coordinate directly.

### Pillar 2: Desktop Vision & "Computer Use"
- **Screen & Window Awareness:** High-speed capture of the full desktop or targeted application windows (using native OS tools / X11 / Wayland / macOS screencapture).
- **Coordinate Scaling & Normalization:** Scale high-DPI/Retina screens down for vision models and map predicted coordinates back up to physical pixels.
- **App Control:** Drive native desktop apps and browsers (mouse click, drag, scroll, keyboard shortcuts) using accessibility APIs or native input drivers.

### Pillar 3: Ambient Voice & Audio Duplex
- **Low-Latency Speech Loop:** Speech-to-Text (STT) $\to$ Orchestrator $\to$ Text-to-Speech (TTS) with sub-second turnaround.
- **Voice Activity Detection (VAD):** Hands-free ambient activation without clunky wake-word delays.
- **Barge-in / Interruption Handling:** Immediate audio cutoff when the user speaks mid-sentence.

### Pillar 4: Personal Companion & Persistent Memory
- **Autonomous Memory Engine:** Long-term recall of user preferences, project context, history, and work habits across sessions.
- **Witty, Loyal Persona:** A true technical partner—dry wit, sharp insights, proactive status updates, and deep technical competence.

---

## 3. Reference Open-Source Projects to Study

| Component | Target Repositories to Clone & Study | Key Lessons to Extract |
| :--- | :--- | :--- |
| **Desktop / Mouse & Keyboard** | `anthropics/anthropic-quickstarts` (`computer-use-demo`)<br>`open-interpreter/open-interpreter`<br>`OthersideAI/self-operating-computer` | Coordinate scaling, screen diffing, click accuracy, accessibility fallback |
| **Terminal Pane Multiplexing** | `kovidgoyal/kitty` (Remote control protocol)<br>`tmux/tmux` (Control mode `tmux -CC`) | Socket communication, pane lifecycle, capturing buffer output without theft of focus |
| **Real-Time Voice & Audio** | `livekit/agents`<br>`open-interpreter/01` | Silero VAD, WebRTC streaming, instant interruption cancellation |
| **Agent Swarm Coordination** | `All-Hands-AI/OpenHands`<br>Aery's native `task` + `irc` engines | Structured delegation, parallel execution, cross-agent handoff |

---

## 4. Phased Implementation Roadmap

### Phase 1: Terminal Pane Spawner Tool
- [ ] Implement `packages/coding-agent/src/tools/terminal-pane.ts`
- [ ] Add Kitty socket detection (`KITTY_LISTEN_ON`) and fallback to Tmux
- [ ] Support commands: `split_pane`, `send_keys`, `read_pane`, `close_pane`
- [ ] Connect `task` dispatching to visually open worker panes on request

### Phase 2: Screen Vision & Desktop Control
- [ ] Implement `packages/coding-agent/src/tools/desktop-control.ts`
- [ ] Add `take_screenshot` (full display or window handle) with DPI-aware downscaling
- [ ] Add `mouse_click`, `mouse_move`, `mouse_drag`, `type_text`, `key_combo`
- [ ] Verify against common apps (VS Code, browser, Figma, terminal)

### Phase 3: Ambient Voice Companion Daemon
- [ ] Build a lightweight streaming voice gateway (`packages/voice-gateway` or companion daemon)
- [ ] Wire VAD $\to$ Streaming STT (Whisper/Deepgram) $\to$ Aery Session IPC $\to$ Streaming TTS (Cartesia/ElevenLabs/Piper)
- [ ] Implement instant audio cancel on user speech detection

### Phase 4: Full Desktop Commander Integration
- [ ] Wire the voice gateway to the TUI session manager
- [ ] Enable proactive voice notifications from background terminal workers
- [ ] End-to-end testing: voice prompt $\to$ 3 visual terminal splits $\to$ subagent execution $\to$ verbal summary
