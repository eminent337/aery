---
name: leanai
description: Use when inspecting application architectures, decoding binary formats and protocols, analyzing Electron/Go/native runtimes, or extracting type schemas and API contracts for interoperability.
---

# leanai: Application Architecture Inspection & Schema Synthesis Framework

`leanai` is a zero-dependency, high-velocity software architecture inspection and interface synthesis framework. It provides automated **TypeScript schema synthesis**, **runtime inspection**, **protobuf wire decoding**, and **native binary forensics**.

---

## 1. Core Principles & Workflow

### The 3-Turn Architecture Recon Cycle
Turns cost more than bytes. Complete architecture inspection in 2–4 targeted turns:
1. **Turn 1 (Recon & Routing)**: Run `leanai <target>` to inventory file format, runtime, dependencies, and API routes.
2. **Turn 2 (Schema & Code Slicing)**: Run `leanai schema <target>` or slice exact function/channel logic.
3. **Turn 3 (Synthesis & Evidence)**: Deliver a structured report citing concrete offsets, endpoints, or generated TypeScript interfaces.

### Evidence Classification Rule
Never guess or hallucinate code paths. In your final report, strictly tag every assertion:
* **`[SEEN: target@offset/symbol]`**: Directly witnessed in output (e.g. `[SEEN: agy@0x81fa7c0]`).
* **`[INFERRED]`**: Logically deduced from surrounding structures, imports, or naming.
* **`[UNKNOWN]`**: Not located during the session (never claim "absent" when search is incomplete).

---

## 2. CLI Reference (`leanai`)

```sh
# 1. Inspect architecture of any executable, package, or database
leanai <target-path>
# Deep disassembly & instruction slicing mode:
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

| Target Ecosystem | Native Fast Path Command | Key Output |
| :--- | :--- | :--- |
| **Electron (`app.asar`)** | `leanai schema app.asar` | Auto-generated TypeScript IPC interface & manifests |
| **Web / Minified JS** | `jq -r '.sources[]' < map` or `prettier --parser babel F` | Formatted source tree & module recovery |
| **Go Executable** | `leanai ./bin` | Pclntab offset, Bazel/cgo sections, and RPC endpoints |
| **Protobuf / Wire Streams** | `leanai decode-proto <hex\|base64\|file>` | Structured JSON & inferred Protobuf type definitions |
| **Rust Executable** | `strings -a T \| rg -o '/rustc/[0-9a-f]{40}'` | Compiler toolchain & dependency crate audit |
| **ELF (Linux Native)** | `readelf -hlSW T`, `nm -D T`, `objdump -d -M intel T` | Dynamic libraries, exports, and disassembly |
| **Mach-O (macOS Native)** | `otool -L`, `otool -tV`, `nm -gU`, `xcrun swift-demangle` | Load commands, entitlements, and ObjC/Swift classes |
| **Android APK** | `unzip -l a.apk`, `apktool d --no-src -o X a.apk` | Manifest, DEX count, Flutter Dart AOT, Hermes |
| **SQLite / State DB** | `leanai schema db.sqlite` | Auto-generated TypeScript table row types |
| **OS Keyring / Tokens** | `leanai env` | DBus / Secret-Service / Keychain active credentials |

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
- [ ] Is the output focused on answering the user's specific feature/schema question?
