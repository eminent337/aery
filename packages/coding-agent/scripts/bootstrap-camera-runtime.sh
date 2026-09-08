#!/usr/bin/env bash
# Aery camera runtime bootstrap — first-run setup for a fresh machine.
# Installs the local vision runtime OUTSIDE the repo (mirrors the voice assets
# pattern): uv venv + opencv-python-headless, YuNet face detection model,
# SFace face recognition model, and the face_detect.py worker.
#
# Usage: scripts/bootstrap-camera-runtime.sh
# Requires: uv (auto-installed if missing) + internet for first run.

set -euo pipefail

CAMERA_DIR="${HOME}/.local/share/aerys/camera"
BIN_DIR="${CAMERA_DIR}/bin"
MODELS_DIR="${CAMERA_DIR}/models"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[aery-camera] runtime dir: ${CAMERA_DIR}"

# 1. Python venv via uv (PEP 668-safe, no system site-packages touched)
if [ ! -x "${CAMERA_DIR}/venv/bin/python" ]; then
	if ! command -v uv >/dev/null 2>&1; then
		echo "[aery-camera] installing uv..."
		curl -LsSf https://astral.sh/uv/install.sh | sh
		export PATH="${HOME}/.local/bin:${PATH}"
	fi
	echo "[aery-camera] creating venv with opencv-python-headless + numpy..."
	mkdir -p "${CAMERA_DIR}"
	cd "${CAMERA_DIR}"
	uv venv venv
	uv pip install --python venv/bin/python opencv-python-headless numpy
else
	echo "[aery-camera] venv already present, skipping"
fi

# 2. Models (OpenCV Zoo)
mkdir -p "${MODELS_DIR}"
YUNET="${MODELS_DIR}/face_detection_yunet_2023mar.onnx"
SFACE="${MODELS_DIR}/face_recognition_sface_2021dec.onnx"
if [ ! -s "${YUNET}" ]; then
	echo "[aery-camera] downloading YuNet face detection model (227KB)..."
	curl -fsSL -o "${YUNET}" \
		"https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
fi
if [ ! -s "${SFACE}" ]; then
	echo "[aery-camera] downloading SFace face recognition model (36.9MB)..."
	curl -fsSL -o "${SFACE}" \
		"https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"
fi

# 3. Worker script — shipped inside the repo, installed to the runtime dir
mkdir -p "${BIN_DIR}"
if [ -f "${SCRIPT_DIR}/camera-runtime/face_detect.py" ]; then
	cp "${SCRIPT_DIR}/camera-runtime/face_detect.py" "${BIN_DIR}/face_detect.py"
	echo "[aery-camera] installed face_detect.py from repo"
else
	echo "[aery-camera] WARNING: ${SCRIPT_DIR}/camera-runtime/face_detect.py not found."
	echo "  Copy your working face_detect.py to ${BIN_DIR}/face_detect.py manually,"
	echo "  or run this script from the aerys repo it ships with."
fi

# 4. System packages (Arch) — helpers used by tools; report, never auto-install
MISSING=()
for pkg in wf-recorder xorg-server-xvfb xdotool ffmpeg imagemagick imv; do
	pacman -Q "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [ ${#MISSING[@]} -gt 0 ]; then
	echo "[aery-camera] optional system packages not installed: ${MISSING[*]}"
	echo "  Install with: sudo pacman -S --needed ${MISSING[*]}"
	echo "  (wf-recorder = screen recording; xvfb+xdotool = headless desktop apps;"
	echo "   ffmpeg = webcam recording; imagemagick = xvfb screenshots; imv = image viewer)"
fi

# 5. Verify
echo "[aery-camera] verifying..."
"${CAMERA_DIR}/venv/bin/python" -c "import cv2; print('  opencv', cv2.__version__)"
[ -s "${YUNET}" ] && echo "  yunet: ok"
[ -s "${SFACE}" ] && echo "  sface: ok"
[ -f "${BIN_DIR}/face_detect.py" ] && echo "  worker: ok"

echo "[aery-camera] done. camera_control is ready (detection + recognition, fully local)."
