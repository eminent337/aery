# Upstream Updates Backlog (surveyed 2026-08-22)

Upstream refs (fetched, read-only):
- omp  (oh-my-pi)     omp/main      cb05e10459
- kimchi              upstream/master a9ba98cbc5
- jcode               jcode/master dd8755f7e7
- Aery HEAD           fad1bdda6b

## NOT in Aery yet (candidates for manual port)

### omp (oh-my-pi)
- [ ] Spelling suggestions + granular text decoration (tui/coding-agent/natives): cb05e10459, 443d912beb, c36c15bd02, 4af848d737
- [ ] Persistent startup composer UI + cache (b74dcee574, 585900ee41, c441d39a2b, 4687e8d5ef)
- [ ] Mixed-workload benchmark profiles (55689ca914, e6f710fa4b)
- [ ] Verbatim edit mode with explicit markers (4687e8d5ef)
- [ ] Incremental highlight streaming for markdown fences (f5c6ae15f6)
- [ ] /shake thinking mode variant (2e64d4ebe3) — Aery has /shake but not thinking-drop variant
- [ ] Frequency-ranked slash command autocomplete (f3324da5e3, 084440b0c5)
- [ ] Handoff summary context + rendering (a9ea8c87fd)
- [ ] Unified sparse-edit format with recovery (4945caca6d, 63baaa2af2, 2b5eed286d)
- [ ] kitty-vt-wasm engine + tests (561d212726)

### kimchi (getkimchi/kimchi)
- [ ] daemon + daemon_control tools — session-surviving processes (a9ba98cbc5 #1075)
- [ ] /teleport autocomplete for flags (ca4bb20479 #1078)
- [ ] teleport compaction hint for long sessions (4cb2f4460d #986)
- [ ] acp: expose skills as slash commands, preload like TUI (c2cb469b84 #1072)
- [ ] cli: multi-model selection via --model / --multi-model (8d6126d1d8 #1069)
- [ ] fermentation execution hardening + effective inline compaction (28b720104e #1043)
- [ ] model-switch session-based compaction (3a4837eb42 #1000)
- [ ] permission EventBus channels (#1055)
- [ ] OpenCode Codex login support (dfca5a9b65 #1041)

### jcode
- [ ] batch nudge / sequential-tool-use nudging (4973f3e148, 2ae5bcb2a6)
- [ ] todo feedback loop relevance gating (a822cd8616)
- [ ] desktop model picker in transcript (0a74240a90)
- [ ] turn notification broker (macOS) (ba1b629475)
- [ ] ACP model/effort selectors + token usage over ACP (c9d5858557)
- [ ] metered hosted billing UX (d1aecc6946)

### Already present in Aery (checked; skip)
- slash command autocomplete (base)
- /shake command (base) — but not the thinking-drop variant
- acp builtin slash commands — present
- model-switch session handling — present (agent-session #closeProviderSessionsForModelSwitch)
