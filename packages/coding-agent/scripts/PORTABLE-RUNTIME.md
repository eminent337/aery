# Aery Portable Setup

Everything Aery knows travels with this repo (byte-identical across
`aerys`/`feat/aerys` and `aery`/`main`). This file explains what a fresh
machine needs beyond `npm i` so **all** capabilities work flawlessly.

## What ships in the repo (zero extra work)
- All tools: bash, browser (headless by default), desktop_control (incl.
  headless `xvfb_*` actions), camera_control (capture/face ID/record/record
  screen/live-watch), voice_control, and the rest.
- System prompt sections: Live Eye, Invisible Execution, Camera & Face
  Tracking — the agent's memory of its powers.
- Camera worker: `scripts/camera-runtime/face_detect.py`.
- Camera bootstrap: `scripts/bootstrap-camera-runtime.sh`.

## One-time setup on a new machine

```bash
# 1. Install the package (normal flow)
npm i -g @aryee337/aery   # or from this repo: npm i && npm run build

# 2. Camera/face runtime (venv + models + worker, fully local)
bash packages/coding-agent/scripts/bootstrap-camera-runtime.sh

# 3. System packages (Arch) for recording + headless desktop apps
sudo pacman -S --needed wf-recorder xorg-server-xvfb xdotool ffmpeg imagemagick imv

# 4. Voice stack (PipeWire echo-cancel, TTS/STT assets) — already handled by
#    the voice runtime bootstrap that ships with the voice feature.
```

Settings gates (`camera.enabled`, `browser.headless`, `voice.*`) default ON.

## Notes
- Face profiles (`~/.local/share/aerys/camera/profiles/*.npy`) are personal
  biometric data — NOT synced; enroll on each machine (one `enroll_face` call).
- Headless desktop apps use a virtual display (":99", 1600x900); Wayland
  apps are forced onto X11 automatically.
- `wf-recorder -d` is the DRM device flag, not duration — the tool spawns and
  SIGINTs to stop. This is already handled in code; documented here so nobody
  re-introduces the bug.
- Telegram: `ai_connect telegram` links a bot token; Saved Messages access
  needs a one-time QR login via the headless browser (web.telegram.org).
