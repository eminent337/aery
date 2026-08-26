Inspects, waits, or cancels async jobs.

Background job results are delivered automatically when complete via reactive wakeups — you do NOT need to poll in a loop. Reach for this tool only when you need to explicitly intervene.

# Operations

## `list: true`
Use to inspect currently running or recently completed jobs.

## `poll: [id, …]`
Explicitly block until specified jobs finish or the wait window elapses.
- Only use when you have an explicit reason to block synchronously and cannot end the turn.
- Returns the current snapshot when the timer elapses; running jobs remain running.
- Completed jobs include their final output in the returned snapshot.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
- Returns immediately after cancelling.
