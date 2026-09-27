Desktop screen vision and window manager tool. Takes full-screen or window-targeted screenshots with DPI scaling, lists open windows, focuses or closes applications, and manages workspaces.

<instruction>
- Actions: 'screenshot', 'live_eye', 'highlight', 'list_windows', 'focus_window',
  'close_window', 'switch_workspace', 'launch_app', 'cursor_pos', 'system_control'
  (subAction: volume/media/brightness/lock/web_search), plus opt-in live app control
  ('live_mode_on' then 'live_click'/'live_type'/'live_key'/'live_drag'/'live_scroll').
- Headless GUI testing — 'xvfb_*' runs an app on a private virtual display, no real
  desktop touched, fully local: 'xvfb_launch' spawns it (command + optional url),
  'xvfb_screenshot' captures and OCRs it, 'xvfb_click'/'xvfb_drag'/'xvfb_type'/
  'xvfb_key' drive it, 'xvfb_list_windows' lists survivors, 'xvfb_close' tears
  the display and its apps down. 'xvfb_drag' sweeps press-to-release for text
  selection ('target' + 'target2' for word-to-word, or x/y + x2/y2 raw).
- Project to the user when they should see or do it themselves — 'xvfb_project'
  streams the headless display onto the real desktop (live, ~12fps, with a cursor
  overlay so your clicks/drags are visible) and forwards the user's mouse and
  keyboard back in, so they can type INTO the headless app. Use it when the user
  asks to watch, and whenever a step needs a HUMAN — a password, sudo, an SSH
  passphrase, 2FA/PIN, a captcha or any secret you must never handle. Modes:
  'start' (default; optional 'target' = a window name, else the whole workspace),
  'status', 'stop'.
- The user types; you never read it. The projection exists so secrets stay between
  the user and the app: do NOT OCR, screenshot-crop, clipboard-read or log that
  window while they type, and never ask them to tell you the secret. When they say
  they're done, verify success from the app's OWN state (a file it wrote, its
  exit code, a change in its output) — never from the keystrokes.
- Stop the projection when the handoff is over ('mode':'stop'); 'xvfb_close' also
  stops it. One projection at a time.
- Screenshot first, always: word click targets come from the LAST xvfb_screenshot
  (or live_eye) reading. After xvfb_launch, a new window, or any state change, take
  a fresh screenshot before clicking. 'ocr:false' or an empty capture clears all
  targets — a click then refuses and tells you to screenshot again.
- Click or drag what the eye actually offers: pass a word target when one matches
  ('xvfb_click' resolves it to display px for you; 'xvfb_drag' takes 'target' for
  the press word and 'target2' for the release word). Fall back to raw frame x/y
  (and x2/y2 for a drag) only for regions OCR missed. Never guess coordinates
  without a current frame.
- Dragging selects: 'xvfb_drag' presses at the start anchor, travels the held sweep
  (eased, never a yank), dwells, then releases — that is what makes a text field
  select instead of hover. Verify the selection from the app's own state.
- OCR is honest, not perfect: short labels can mangle ("Save" → "swe"). If the word
  you want is missing or garbled, click the nearest offered label, or drive the
  keyboard instead ('xvfb_key Return', app shortcuts) — then VERIFY the effect
  (re-screenshot, or check the app's own output) before declaring success.
- Typing works without a window manager: xvfb_type/xvfb_key set input focus on the
  target window first (active window, else window under the pointer, else first
  named window) and report which window received the keys. 'no_keyboard_target'
  means nothing was focusable — screenshot, launch the app, and retry.
- Crossing the screen or tracing a route? Glide there as ONE motion — 'live_move'
  with 'path' (2-64 frame-px waypoints) eases off the current cursor, sweeps
  through EVERY waypoint (never cutting a corner), eases through each turn
  instead of snapping direction at full speed, settles onto the final point and
  cursor-verifies it (Δ≤2px): a single focus/freshness guard and one verify
  frame for the whole journey. Plain x/y stays a single eased aim. 'path' mixes
  with neither x/y nor target.
- Set 'pace' with 'path' to choose the effort: 'brisk' for quick hops,
  'natural' (default) for the even unhurried glide, 'deliberate' when the user
  is watching or you want careful tracing — it slows the straights and widens
  the turn easing. Every pace stays wall-clock capped (on a very long route the
  cap wins over the easing, so it never hangs). 'pace' without 'path' is refused.
- Eye and cursor run TOGETHER: a 'screenshot'/'live_eye' issued in the same
  turn as an in-flight 'live_move' executes concurrently and returns a
  mid-motion frame — pair them to WATCH the pointer travel instead of waiting
  blind. Glide results carry 'midFlightFrames' (paths of up to 4 captures
  taken DURING the journey) in details; a cancelled glide reports
  aborted/applied/total with focus re-asserted and no landing warp. Reading
  state stays coherent under concurrency: a target pool measured against a
  different window refuses to resolve — re-eye and retry, never force it.
- Same-turn calls run in PARALLEL, but PRESSES ('live_click'/'live_type'/
  'live_key'/'live_drag'/'live_scroll') are serialized in the order you issue
  them — so "click the field, then type into it" works in ONE turn, exactly as
  written. Reads ('screenshot'/'live_eye') and 'live_move' never queue, so pair
  an eye with any action freely and the eye still returns mid-motion.
- While a path glide owns the pointer, any press refuses with
  'glide_in_flight' rather than pressing at a mid-path coordinate — 'live_move'
  does not queue behind a keyboard, so wait for the glide to land, then
  re-issue. The eye is never blocked by this.
- 'verify: true' (default) attaches a follow-up capture after live_* input so you
  can self-correct; keep it on for multi-step flows.
- 'textOnly'/'ocr:false' skip the image read when you only need words; 'maxWidth'/
  'maxHeight' cap the scaled frame (coordinates still map through it correctly).
</instruction>

<examples>
# Launch, read, click a button by its word
`xvfb_launch {"command":"yad --title Contact --form --field Name --field Email"}`
`xvfb_screenshot {}` → words include "Name", "Email", "Cancel"
`xvfb_click {"word":"Name"}` then `xvfb_type {"text":"Ada Lovelace"}`

# Keyboard-driven flow with recovery
`xvfb_key {"keys":"alt+F4"}` / `xvfb_key {"keys":"Return"}` when a button's OCR box drifted
# One continuous, paced glide across the screen (not N separate moves)
`live_move {"path":[{"x":60,"y":690},{"x":640,"y":360},{"x":1200,"y":80}]}`
# Slower, more deliberate tracing when the user is watching (corners ease through)
`live_move {"path":[{"x":60,"y":690},{"x":640,"y":360},{"x":1200,"y":80}],"pace":"deliberate"}`
# Eye + cursor in ONE turn: watch the glide while it runs
`live_move {"path":[{"x":60,"y":690},{"x":640,"y":360}]}` together with `screenshot {}`
→ the screenshot returns the pointer mid-transit; the glide keeps going.

# A step needs the user's password — project it and hand over
`xvfb_launch {"command":"sudo apt upgrade"}` → prompt appears
`xvfb_project {}` → "Projection live…" (user sees it, types the password)
# …user types on their own keyboard…
`xvfb_project {"mode":"status"}` → frames climbing, inputs forwarded
`xvfb_project {"mode":"stop"}` when done, then verify from the app's own output

# Project one window only
`xvfb_project {"target":"Contact"}` → just the Contact window is mirrored

# Clean up when done — kills the apps too
`xvfb_close {}` → "Xvfb gone, no lock file, no socket"
</examples>

<critical>
- One xvfb display at a time: don't run overlapping xvfb sessions or concurrent
  OCR-heavy work — capture/OCR pipelines collide.
- Word targets are frame-bound: they die when the display changes or the reading
  is superseded; a refused click is the signal to re-screenshot, never to retry blind.
- Always xvfb_close when finished — it removes the lock file, socket, and spawned
  apps; leaving them running blocks the next session.
- Screenshots return the frame geometry in details — trust the returned mapping,
  don't rescale by hand.
- A projection is one-way for secrets: the user's keystrokes cross into the headless
  session and never come back through you. Don't capture, OCR or log the projected
  window while the user is typing credentials — the app's own state is the only
  proof of success you may read.
</critical>
