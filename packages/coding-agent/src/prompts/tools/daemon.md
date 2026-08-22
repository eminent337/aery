Start a detached background process that KEEPS RUNNING after this session ends.

Use ONLY for long-lived services that someone connects to after you finish:
- web servers, APIs, databases, caches the user (or a grader) will query afterwards
- emulators / VMs that must stay up for external access
- anything whose whole purpose is to outlive you

Do NOT use for: builds, installs, tests, downloads, training runs, or ANY command with a natural end — use `bash` with a realistic timeout for those (and checkin_interval + bash_control for managed background). Managed background is the right default; it gets progress checkins, a deadline auto-kill, and cleanup at session end. Daemons get NONE of those: no timeout, no streamed output, no automatic cleanup. They just run.

After starting, verify the service actually works (e.g. curl it) and report the address to the user. Manage later via daemon_control (list / status / logs / stop).
