Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory, not `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- **PTY mode (`pty: true`)** — opens an interactive terminal overlay where the user can type directly (passwords, sudo, ssh passphrases, etc.).
  - **Auto-detection:** commands starting with `sudo`, `su`, `passwd`, `ssh`, `gpg`, `mysql`, or `psql` are automatically promoted to interactive mode — you don't need to set `pty: true` for these.
  - **When to use manually:** any other command that requires user input — passphrase-protected tools, or any command that pauses waiting for the user.
  - **How to use:** tell the user what's happening, then call bash with `pty: true`. The overlay appears — the user types their password (or other input) and presses Enter. The command continues.
  - **After the user types:** the command resumes automatically. You will see the result in the next tool output. Do NOT retry the command — just wait for the result.
  - **Default is `false`** (non-interactive, captures stdout/stderr only).
- Use `;` only when later commands should run regardless of earlier failures
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
</instruction>

<critical>
- NEVER use Linux coreutils (`cat`, `head`, `tail`, `less`, `more`, `ls`, `grep`, `rg`, `awk`, `sed`, `find`, `fd`, etc.) when a dedicated tool suffices — ALWAYS prefer `read`, `search`, `find`, `edit`, `write`.
- NEVER pipe through `| head -n N` or `| tail -n N` — output is already truncated with the full result available via `artifact://<id>`.
- NEVER redirect with `2>&1` or `2>/dev/null` — stdout and stderr are already merged.
</critical>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps the **wall-clock duration** of the command. When it elapses the process is killed and the call returns with a timeout annotation. Range: `1`–`3600`s; default `300`s (see `clampTimeout("bash", …)` in `tool-timeouts.ts`).
- `async: true` only defers **reporting** of the result — it does NOT disable, extend, or detach the timeout. A daemon started with `async: true` is still killed when `timeout` elapses, regardless of how long the agent waits before reading the result.
- For long-running daemons (dev servers, watchers): either pass an explicit large `timeout` (up to `3600`), or fully detach the process from this shell using `nohup …  &` / `setsid … &` / `disown` so it survives independent of the bash call's lifecycle.

## Background Interactive Commands

When a command needs interactive input AND won't finish quickly, combine `pty: true` with `async: true`:

```
bash(command="sudo apt install something", pty=true, async=true)
```

This runs the command in the background. When it prompts for input, use `send_input` to type:

```
send_input(jobId="bg_1", input="yourpassword\n")
```

The `send_input` tool is the way to type passwords, passphrases, or yes/no responses into a running background command. After the user types, the command continues automatically.
{{/if}}

# Output minimizer

- Bash stdout/stderr may be rewritten before you see it: long output is head/tail truncated, and test/lint runners (e.g. `bun test`, `cargo test`, ESLint) are passed through heuristic filters that drop noise and keep failures.
- When the minimizer changes the visible text, the tool appends a `[raw output: artifact://<id>]` footer pointing at the **full untouched capture**. If a run looks suspicious (e.g. only a version banner) or you need the exact bytes, read that artifact.
- If no footer is present, what you see is what the command actually emitted.
