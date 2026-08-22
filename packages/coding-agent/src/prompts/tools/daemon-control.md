Inspect or stop detached daemons started by the `daemon` tool.

- action "list": show all live daemons (id, pid, uptime, command, log file). Dead records are cleaned up automatically.
- action "status": check one daemon — alive?, uptime, command, log path.
- action "logs": return the tail of the daemon's log file.
- action "stop": terminate the daemon's whole process group and remove its record.

Daemons are NOT managed by bash_control — those handles belong to the bash tool's session-scoped background mode, which is a different lifecycle (killed at session end).
