#!/usr/bin/env python3
"""
Aerys camera capture + face detection worker.

Captures a single frame from the webcam (via ffmpeg) and runs OpenCV YuNet
face detection, returning JSON on stdout. Kept outside the TS repo so aerys
and aery stay byte-identical while the operating-machine runtime (cv2 venv)
lives in ~/.local/share/aerys/camera like the voice assets.

Usage:
    face_detect.py --device /dev/video0 --resolution 1280x720 \
        --face-detect --score-threshold 0.5 [--output /path/out.jpg]

Output (JSON):
    {
      "capture": { "device": "/dev/video0", "size": [1280, 720],
                   "jpeg": "<base64>", "latencyMs": 123 },
      "faces": [ { "x": 558, "y": 142, "w": 244, "h": 315,
                   "confidence": 0.98 } ],
      "detectionTimeMs": 4.2,
      "error": null
    }
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import numpy as np  # noqa: E402 (imported before cv2 to avoid the OPENCV_LOG_LEVEL race)
from pathlib import Path

# cv2 5.0 prints a startup warning about the new graph engine to stderr; keep
# stdout pure JSON by bumping warning verbosity before importing cv2.
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")

MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "face_detection_yunet_2023mar.onnx"
SFACE_PATH = Path(__file__).resolve().parent.parent / "models" / "face_recognition_sface_2021dec.onnx"
PROFILES_DIR = Path(__file__).resolve().parent.parent / "profiles"
SFACE_MATCH_THRESHOLD = 0.363  # standard cosine threshold for SFace


def _aligned_face(img, face: "dict | list") -> "np.ndarray | None":
    """Crop + warp the detected face to the 112x112 SFace input using YuNet landmarks."""
    import cv2
    if isinstance(face, dict):
        x, y, w, h = face["x"], face["y"], face["w"], face["h"]
        lm = face.get("landmarks") or []
    else:
        x, y, w, h = (int(v) for v in face[:4])
        lm = [float(v) for v in face[4:14]]  # 5 landmark pairs x,y
    if len(lm) >= 10:
        src = np.array(lm[:10], dtype=np.float32).reshape(5, 2)
    else:
        # fallback: simple crop around the box
        x0, y0 = max(0, x), max(0, y)
        crop = img[y0 : y0 + h, x0 : x0 + w]
        return None if crop.size == 0 else cv2.resize(crop, (112, 112))
    dst = np.array(
        [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
         [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32,
    )
    M = cv2.getAffineTransform(src[:3].astype(np.float32), dst[:3])
    return cv2.warpAffine(img, M, (112, 112))


def _sface_embedder():
    import cv2
    if not SFACE_PATH.exists():
        return None
    try:
        return cv2.FaceRecognizerSF_create(str(SFACE_PATH), "")
    except Exception:
        return None


def _embed(aligned: "np.ndarray", recognizer) -> "np.ndarray | None":
    import cv2
    try:
        vec = recognizer.feature(aligned)
        return np.asarray(vec, dtype=np.float32).flatten()
    except Exception:
        return None


def enroll_face(frame_buf: bytes, name: str, score_threshold: float) -> dict:
    """Capture-side enroll: detect the largest face, store its embedding."""
    import cv2
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    arr = np.frombuffer(frame_buf, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "error": "could not decode frame"}
    h, w = img.shape[:2]
    det = cv2.FaceDetectorYN_create(model=str(MODEL_PATH), config="", input_size=(w, h),
                                    score_threshold=score_threshold)
    _, faces = det.detect(img)
    if faces is None or len(faces) == 0:
        return {"ok": False, "error": "no face detected in frame"}
    # largest face = the person enrolling
    idx = int(np.argmax([f[2] * f[3] for f in faces]))
    recognizer = _sface_embedder()
    if recognizer is None:
        return {"ok": False, "error": f"SFace model missing at {SFACE_PATH}"}
    aligned = _aligned_face(img, faces[idx])
    if aligned is None:
        return {"ok": False, "error": "face alignment failed"}
    vec = _embed(aligned, recognizer)
    if vec is None:
        return {"ok": False, "error": "embedding failed"}
    out_path = PROFILES_DIR / f"{name}.npy"
    np.save(out_path, vec)
    return {"ok": True, "profile": str(out_path), "facesInFrame": len(faces)}


def identify_frame(img, raw_faces, score_threshold: float) -> "tuple[list[dict], float]":
    """Full identify pipeline on a decoded frame: returns (rows with identity, timeMs).

    raw_faces are the raw YuNet rows (each 15 floats); we re-align + re-embed each
    face and match against enrolled profiles by cosine similarity.
    """
    import cv2
    t0 = time.monotonic()
    recognizer = _sface_embedder()
    profiles = {}
    if PROFILES_DIR.exists():
        for p in sorted(PROFILES_DIR.glob("*.npy")):
            try:
                profiles[p.stem] = np.load(p).flatten().astype(np.float32)
            except Exception:
                continue
    out: list[dict] = []
    for f in raw_faces:
        x, y, fw, fh = (int(v) for v in f[:4])
        row = {"x": x, "y": y, "w": fw, "h": fh,
               "confidence": float(f[14] if len(f) > 14 else f[4])}
        if recognizer is not None and profiles:
            aligned = _aligned_face(img, f)
            vec = _embed(aligned, recognizer) if aligned is not None else None
            if vec is not None:
                best_name, best_sim = "unknown", -1.0
                for name, pv in profiles.items():
                    sim = float(recognizer.match(vec, pv, cv2.FaceRecognizerSF_FR_COSINE))
                    if sim > best_sim:
                        best_name, best_sim = name, sim
                if best_sim >= SFACE_MATCH_THRESHOLD:
                    row["identity"] = {"name": best_name, "similarity": round(best_sim, 3)}
                else:
                    row["identity"] = {"name": "unknown", "similarity": round(best_sim, 3)}
        else:
            row["identity"] = None
        out.append(row)
    return out, round((time.monotonic() - t0) * 1000, 1)


def ffmpeg_capture(device: str, resolution: str) -> tuple[bytes, int] | None:
    """Capture one JPEG frame from the webcam. Returns (bytes, latencyMs)."""
    t0 = time.monotonic()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp_path = tmp.name
    width, height = resolution.split("x")[0], resolution.split("x")[1]
    try:
        res = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "v4l2", "-input_format", "mjpeg",
                "-video_size", f"{width}x{height}",
                "-i", device,
                "-frames:v", "1",
                "-y", tmp_path,
            ],
            capture_output=True,
            timeout=15,
        )
        if res.returncode != 0:
            return None
        buf = Path(tmp_path).read_bytes()
        return buf, int((time.monotonic() - t0) * 1000)
    except Exception:
        return None
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def detect_faces(frame_buf: bytes, score_threshold: float) -> tuple[list[dict], float]:
    """Run YuNet face detection. Returns (faces, detectionTimeMs)."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return [], 0.0

    t0 = time.monotonic()
    arr = np.frombuffer(frame_buf, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return [], 0.0
    h, w = img.shape[:2]
    detector = cv2.FaceDetectorYN_create(
        model=str(MODEL_PATH),
        config="",
        input_size=(w, h),
        score_threshold=score_threshold,
    )
    _, faces = detector.detect(img)
    out: list[dict] = []
    if faces is not None and len(faces) > 0:
        for f in faces:
            x, y, fw, fh = (int(v) for v in f[:4])
            confidence = float(f[14] if len(f) > 14 else f[4])
            out.append({"x": x, "y": y, "w": fw, "h": fh, "confidence": confidence})
    return out, round((time.monotonic() - t0) * 1000, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Aerys camera capture + face detect/identify")
    parser.add_argument("--device", default="/dev/video0")
    parser.add_argument("--resolution", default="1280x720")
    parser.add_argument("--face-detect", action="store_true",
                        help="Run YuNet face detection after capture")
    parser.add_argument("--identify", action="store_true",
                        help="Detect + identify faces against enrolled profiles (implies --face-detect)")
    parser.add_argument("--enroll", metavar="NAME", default=None,
                        help="Enroll the largest detected face as NAME (uses a fresh capture)")
    parser.add_argument("--score-threshold", type=float, default=0.5)
    parser.add_argument("--output", default=None, help="Write JPEG to a path (debug)")
    args = parser.parse_args()
    if args.identify:
        args.face_detect = True

    result = {"capture": None, "faces": [], "detectionTimeMs": 0.0, "error": None}
    capture = ffmpeg_capture(args.device, args.resolution)
    if capture is None:
        result["error"] = f"Failed to capture from {args.device}"
        print(json.dumps(result))
        return 2

    frame_buf, latency = capture
    # The camera may ignore the requested size and emit its native MJPEG width
    # (e.g. 848x480 for a 640x480 request). Decode just the header to report the
    # true frame dimensions rather than the requested ones.
    try:
        import cv2 as _cv2
        _arr = np.frombuffer(frame_buf, dtype=np.uint8)
        _img = _cv2.imdecode(_arr, _cv2.IMREAD_COLOR)
        actual_h, actual_w = _img.shape[:2]
    except Exception:
        actual_w, actual_h = int(args.resolution.split("x")[0]), int(args.resolution.split("x")[1])
    result["capture"] = {
        "device": args.device,
        "size": [actual_w, actual_h],
        "jpeg": base64.b64encode(frame_buf).decode("ascii"),
        "latencyMs": latency,
    }
    if args.output:
        Path(args.output).write_bytes(frame_buf)

    if args.enroll:
        enroll_res = enroll_face(frame_buf, args.enroll, args.score_threshold)
        result["enroll"] = enroll_res
        if not enroll_res.get("ok"):
            result["error"] = enroll_res.get("error")

    if args.identify:
        import cv2
        arr = np.frombuffer(frame_buf, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            result["error"] = "could not decode frame for identification"
        else:
            h, w = img.shape[:2]
            det = cv2.FaceDetectorYN_create(model=str(MODEL_PATH), config="",
                                            input_size=(w, h), score_threshold=args.score_threshold)
            _, raw = det.detect(img)
            rows, ident_ms = identify_frame(img, raw if raw is not None else [], args.score_threshold)
            result["faces"] = rows
            result["detectionTimeMs"] = ident_ms
    elif args.face_detect:
        faces, detect_ms = detect_faces(frame_buf, args.score_threshold)
        result["faces"] = faces
        result["detectionTimeMs"] = detect_ms

    print(json.dumps(result))
    return 0

if __name__ == "__main__":
    sys.exit(main())
