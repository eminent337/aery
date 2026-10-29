---
name: leanai
description: Use when inspecting application architectures, decoding binary formats and protocols, analyzing Electron/Go/native runtimes, or extracting type schemas and API contracts for interoperability.
---

# leanai: Application Architecture Inspection & Schema Synthesis Framework

`leanai` is a multi-ecosystem software architecture inspection and interface synthesis framework. It combines **zero-dependency native CLI speed** with **automated TypeScript schema generation**, **protobuf wire decoding**, and **REA semantic analysis**.

---

## 1. Core Principles & Workflow

### The 3-Turn Architecture Recon Cycle
1. **Turn 1 (Recon & Routing)**: Run `leanai <target>` or a single batched native probe (`file`, magic bytes, strings, imports/exports).
2. **Turn 2 (Targeted Slicing & Schemas)**: Use `leanai schema <target>` or slice exact function/channel logic.
3. **Turn 3 (Synthesis & Evidence)**: Synthesize findings citing concrete offsets, endpoints, or types.

### Evidence Classification Rule
Never guess or hallucinate code paths. In your final report, strictly tag every assertion:
* **`[SEEN: target@offset/symbol]`**: Directly witnessed in output (e.g. `[SEEN: agy@0x81fa7c0]`).
* **`[INFERRED]`**: Logically deduced from surrounding structures, imports, or naming.
* **`[UNKNOWN]`**: Not located during the session (never claim "absent" when search is incomplete).

### Dual-Engine Strategy (Fast CLI + REA Integration)
* **Default / Fast Path**: Use native CLI tools (`readelf`, `objdump`, `nm`, `strings`, `rg -uu`, `jq`, `@electron/asar`, `python3`). Guaranteed zero setup, runs instantly on any server.
* **Deep Semantic Path**: When `rea` is available (installed at `rea` / MCP), use high-level commands (`rea analyze`, `rea compare-application-versions`, `rea recover-javascript-sources`, `rea xrefs`).
* **Resilience Rule**: If `rea` returns `provider_unavailable` (missing external disassemblers), **immediately drop to native CLI tools without failing**.

---

## 2. CLI Reference (`leanai`)

```sh
# 1. Inspect architecture of any executable, package, or database
leanai <target-path>
# Deep mode with REA semantic engine:
leanai <target-path> --deep

# 2. Automatically synthesize TypeScript interfaces and API schemas
leanai schema <target-path>

# 3. Decode arbitrary Protobuf binary payloads (hex, base64, or file)
leanai decode-proto <hex|base64|file>

# 4. Non-invasive environment inspection (keyrings, state DBs, active ports)
leanai env
```

---

## 3. Architecture Routers & Fast Paths

| Target Ecosystem | Primary Fast Path (`leanai` / Native) | REA Semantic Command (If available) |
| :--- | :--- | :--- |
| **Electron (`app.asar`)** | `leanai schema app.asar` $\rightarrow$ auto-generates IPC interface | `rea analyze-javascript-application` |
| **Web / Minified JS** | `jq -r '.sources[]' < map` or `prettier --parser babel F` $\rightarrow$ `rg -uu -o` | `rea recover-javascript-sources` |
| **Go Executable** | `leanai ./bin` (auto-detects pclntab, Bazel sections, and RPC endpoints) | `rea analyze ./bin` |
| **Protobuf / Binary Wire** | `leanai decode-proto <hex\|base64\|file>` $\rightarrow$ JSON + inferred types | `protoc --decode_raw` |
| **Rust Executable** | `strings -a T \| rg -o '/rustc/[0-9a-f]{40}'` + `cargo audit bin T` | `rea analyze T` |
| **ELF (Linux Native)** | `readelf -hlSW T`, `nm -D T`, `objdump -d -M intel T` | `rea decompile --procedure <name>` |
| **Mach-O (macOS Native)** | `otool -L`, `otool -tV`, `nm -gU`, `xcrun swift-demangle` | `rea demangle-swift`, `rea xrefs` |
| **Android APK** | `unzip -l a.apk`, `apktool d --no-src -o X a.apk`, detect Flutter / Hermes | `rea decode-android-resources` |
| **SQLite / State DB** | `leanai schema db.sqlite` $\rightarrow$ auto-generates TypeScript Row types | `sqlite3 'file:db?mode=ro' '.schema'` |
| **OS Keyring / Tokens** | `leanai env` (reads DBus / Secret-Service / Keychain) | System keyring inspection |

---

## 4. Deep Inspection Playbooks

### A. Stripped Go Binaries & Hidden Endpoints
Even when `strip` is run on a Go binary:
1. **Module & Dependencies**: Run `go version -m ./binary`. If built with standard `go build`, full module tree and compile flags are extracted.
2. **Pclntab Recovery**: Go runtime requires the `pclntab` (Program Counter Line Table) to print stack traces on panic. Search for the magic header `\xfb\xff\xff\xff` (Go 1.18+) or `\xfa\xff\xff\xff` (Go 1.16). Function names remain present in this table.
3. **Endpoint & RPC Mining**: Go strings are stored in single contiguous blobs without null terminators. Slice with:
   ```sh
   strings -a -n 8 ./binary | rg -E '(/v1internal:|/v1beta:|https://[a-zA-Z0-9_\.]+\.googleapis\.com)' | sort -u
   ```

### B. Electron IPC & Capabilities Forensics
1. **Extract**: `npx -y @electron/asar extract app.asar /tmp/app`
2. **Auto-Generate Types**: `leanai schema app.asar`
3. **Inspect Electron Fuses**: Check if Node.js CLI inspection is disabled:
   ```sh
   npx -y @electron/fuses read --app /path/to/App.app
   ```

### C. Protobuf Payload Decoding
Decode unknown binary payloads exchanged over HTTP/SSE/WebSocket:
```sh
# Hex string
leanai decode-proto 0801120568656c6c6f
# File on disk
leanai decode-proto /tmp/captured_payload.bin
```

---

## 5. Quality Checklist Before Replying
- [ ] Did you avoid `cat` on large/minified files and use `rg -uu -o` slicing?
- [ ] Are all factual assertions tagged as `[SEEN: location]` or `[INFERRED]`?
- [ ] If a tool was missing, did you seamlessly switch to a native fallback?
- [ ] Is the output focused on answering the user's specific feature/schema question?
