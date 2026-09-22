#!/usr/bin/env python3
"""Project a headless Xvfb display (or a window on it) to the user's REAL
desktop, live, and forward the user's mouse/keyboard back into the headless
display — so the user can see and interact with what the agent is doing,
including entering secrets (passwords, passphrases) that the agent must never
read.

No new packages: ffmpeg x11grab streams frames, GTK3 draws them, python-xlib
XTest injects input into the target. Frames are read but never treated as data.

A cursor overlay is composited onto every frame: the pointer position is
queried on the target display and painted as a ring, so the agent's cursor
motion (xvfb_click / xvfb_drag smooth paths) is visible in the projection.

Usage: xvfb-mirror.py [--target :99] [--window <id>|--workspace]
                      [--width 960] [--fps 12] [--title T]

Output protocol (stdout, one line each):
  READY  geom=X,Y,W,H view=VWxVH scale=F   viewer mapped, stream starting
  FRAME1 ...                              first painted frame (gate on this)
  STAT n frames, m inputs forwarded       every 1s
  FWD click/motion ...                    input forwarded (never key contents)
Exit code 0 on clean stop.
"""
import argparse
import os
import re
import subprocess
import sys
import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

from Xlib import X, XK, display as xdisplay  # noqa: E402
from Xlib.ext import xtest  # noqa: E402

SHIFT_L = None
SHIFT_R = None


def sh(*cmd, env=None):
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env={**os.environ, **(env or {})})
    return p.stdout.strip()


class Mirror(Gtk.Window):
    def __init__(self, args):
        super().__init__(title=args.title)
        self.args = args
        self.td = xdisplay.Display(args.target)
        self.scale = 1.0
        self.geom = None
        self.proc = None
        self.stopping = False
        self.frames = 0
        self.fwd = 0
        self.pixbuf = None

        geo = self.geometry()
        disp_w, disp_h = geo["W"], geo["H"]
        self.vw = args.width
        self.vh = max(1, round(args.width * disp_h / disp_w))
        self.scale = disp_w / self.vw

        self.da = Gtk.DrawingArea()
        self.da.set_size_request(self.vw, self.vh)
        self.da.connect("draw", self.on_draw)
        self.add(self.da)
        self.set_can_focus(True)
        self.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.KEY_PRESS_MASK
            | Gdk.EventMask.KEY_RELEASE_MASK
            | Gdk.EventMask.STRUCTURE_MASK
        )
        self.connect("button-press-event", self.on_button_press)
        self.connect("button-release-event", self.on_button_release)
        self.connect("motion-notify-event", self.on_motion)
        self.connect("key-press-event", self.on_key_press)
        self.connect("key-release-event", self.on_key_release)
        self.connect("destroy", self.on_destroy)

        self.focus_target_window()
        self.start_stream()
        GLib.timeout_add(1000, self.report)

    # ---------- geometry / framing ----------
    def geometry(self):
        a = self.args
        if a.window:
            g = sh("xdotool", "getwindowgeometry", "--shell", a.window,
                   env={"DISPLAY": a.target})
            d = dict(re.findall(r"^(\w+)=(-?\d+)$", g, re.M))
            if d:
                self.geom = (int(d["X"]), int(d["Y"]),
                             int(d["WIDTH"]), int(d["HEIGHT"]))
        else:
            g = sh("xdotool", "getdisplaygeometry", env={"DISPLAY": a.target})
            m = re.match(r"(\d+) (\d+)", g)
            if m:
                self.geom = (0, 0, int(m.group(1)), int(m.group(2)))
        if not self.geom:
            print("mirror: cannot determine target geometry", file=sys.stderr)
            sys.exit(2)
        x, y, w, h = self.geom
        return {"X": x, "Y": y, "W": w, "H": h}

    def focus_target_window(self):
        """No WM on the target: set input focus explicitly so forwarded keys land."""
        if not self.args.window:
            return
        try:
            w = self.td.create_resource_object("window", int(self.args.window))
            self.td.set_input_focus(w, X.RevertToParent, X.CurrentTime)
            self.td.sync()
        except Exception as e:  # noqa: BLE001
            print(f"mirror: focus failed: {e}", file=sys.stderr)

    # ---------- frame pump ----------
    def source(self):
        x, y, w, h = self.geom
        src = f"{self.args.target}.0+{x},{y}"
        vf = f"scale={self.vw}:{self.vh}:flags=fast_bilinear"
        return [
            "ffmpeg", "-loglevel", "error",
            "-f", "x11grab", "-framerate", str(self.args.fps),
            "-video_size", f"{w}x{h}", "-i", src,
            "-vf", vf, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ]

    def start_stream(self):
        self.proc = subprocess.Popen(self.source(), stdout=subprocess.PIPE,
                                     bufsize=10**8)
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        need = self.vw * self.vh * 3
        while not self.stopping:
            buf = self.proc.stdout.read(need)
            if not buf or len(buf) < need:
                break
            GLib.idle_add(self.draw, buf)

    def draw(self, buf):
        try:
            self.pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                GLib.Bytes.new(buf), GdkPixbuf.Colorspace.RGB, False, 8,
                self.vw, self.vh, self.vw * 3)
            self.frames += 1
            if self.frames == 1:
                print("FRAME1 first painted frame", flush=True)
            self.da.queue_draw()
        except Exception as e:  # noqa: BLE001
            print(f"mirror: draw failed: {e}", file=sys.stderr)
        return False

    # ---------- cursor overlay ----------
    def sample_cursor(self):
        """Query the target pointer; map to view coords. None when unreachable
        or outside the viewed region."""
        try:
            p = self.td.screen().root.query_pointer()
            tx, ty = p.root_x, p.root_y
            x, y = self.geom[0], self.geom[1]
            vx = (tx - x) / self.scale
            vy = (ty - y) / self.scale
            if 0 <= vx <= self.vw and 0 <= vy <= self.vh:
                return (vx, vy)
            return None
        except Exception:  # noqa: BLE001
            return None

    def on_draw(self, _widget, cr):
        if self.pixbuf is not None:
            Gdk.cairo_set_source_pixbuf(cr, self.pixbuf, 0, 0)
            cr.paint()
        cur = self.sample_cursor()
        if cur is not None:
            vx, vy = cur
            # Ring + dot: visible on light and dark content.
            cr.set_source_rgb(1.0, 0.35, 0.1)
            cr.set_line_width(2.0)
            cr.arc(vx, vy, 8, 0, 2 * 3.141592653589793)
            cr.stroke()
            cr.arc(vx, vy, 2, 0, 2 * 3.141592653589793)
            cr.fill()
        return False

    # ---------- input forwarding ----------
    def to_target(self, x, y):
        tx = self.geom[0] + round(x * self.scale)
        ty = self.geom[1] + round(y * self.scale)
        return tx, ty

    def on_motion(self, _w, ev):
        tx, ty = self.to_target(ev.x, ev.y)
        xtest.fake_input(self.td, X.MotionNotify, x=tx, y=ty)
        self.td.sync()
        return False

    def on_button_press(self, _w, ev):
        tx, ty = self.to_target(ev.x, ev.y)
        xtest.fake_input(self.td, X.MotionNotify, x=tx, y=ty)
        xtest.fake_input(self.td, X.ButtonPress, int(ev.button))
        self.td.sync()
        self.fwd += 1
        print(f"FWD click {ev.button} -> target {tx},{ty}", flush=True)
        return False

    def on_button_release(self, _w, ev):
        xtest.fake_input(self.td, X.ButtonRelease, int(ev.button))
        self.td.sync()
        return False

    def keycode(self, keyval):
        kc = self.td.keysym_to_keycode(keyval)
        if kc == 0:  # try the unshifted keysym for shifted characters
            ks = Gdk.keyval_to_lower(keyval)
            kc = self.td.keysym_to_keycode(ks)
        return kc

    def on_key_press(self, _w, ev):
        kc = self.keycode(ev.keyval)
        if not kc:
            return False
        shifted = bool(ev.get_state() & Gdk.ModifierType.SHIFT_MASK)
        # Also shift when the keysym only exists on this keycode's shift level.
        if not shifted:
            try:
                shifted = (self.td.keycode_to_keysym(kc, 0) != ev.keyval
                           and self.td.keycode_to_keysym(kc, 1) == ev.keyval)
            except Exception:  # noqa: BLE001
                pass
        if shifted:
            xtest.fake_input(self.td, X.KeyPress, SHIFT_L)
        xtest.fake_input(self.td, X.KeyPress, kc)
        self.td.sync()
        self.fwd += 1
        # NEVER log the keyval: this path carries the user's password.
        print(f"FWD key #{self.fwd} delivered", flush=True)
        return False

    def on_key_release(self, _w, ev):
        kc = self.keycode(ev.keyval)
        if not kc:
            return False
        xtest.fake_input(self.td, X.KeyRelease, kc)
        shifted = bool(ev.get_state() & Gdk.ModifierType.SHIFT_MASK)
        if shifted:
            xtest.fake_input(self.td, X.KeyRelease, SHIFT_L)
        self.td.sync()
        return False

    def report(self):
        if self.stopping:
            return False
        print(f"STAT {self.frames} frames, {self.fwd} inputs forwarded",
              flush=True)
        return True

    def on_destroy(self, *_a):
        self.stop()
        Gtk.main_quit()

    def stop(self):
        self.stopping = True
        if self.proc:
            try:
                self.proc.kill()
                self.proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass


def main():
    global SHIFT_L, SHIFT_R
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=":99")
    ap.add_argument("--window", default="")
    ap.add_argument("--workspace", action="store_true")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--title", default="headless LIVE")
    args = ap.parse_args()

    m = Mirror(args)
    SHIFT_L = m.td.keysym_to_keycode(XK.string_to_keysym("Shift_L"))
    SHIFT_R = m.td.keysym_to_keycode(XK.string_to_keysym("Shift_R"))
    m.show_all()
    print(f"READY geom={m.geom} view={m.vw}x{m.vh} scale={m.scale:.3f}",
          flush=True)
    Gtk.main()


if __name__ == "__main__":
    main()
