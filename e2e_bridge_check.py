"""E2E verification of the codec bridge on the real machine.

Phase 1: boots the bundled MediaMTX with free ports, lets the
runOnAvailable hook launch codec_bridge.js for real, publishes a synthetic
H264+AAC stream with the bundled ffmpeg (the RTMP default workflow), and
verifies BOTH renditions come up: live-av1 (NVENC AV1 + Opus) and live-h264
(video copy + Opus — the audio rescue).

Phase 2: stops the publisher and starts it again (the OBS stop/start flow).
With runOnAvailableRestart: false MediaMTX may never re-run the hook, which
would silently lose all renditions for the second broadcast — a critical bug
if real.
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import shutil
from urllib.request import urlopen


def drain(pipe, sink):
    """Continuously drain a subprocess pipe so the child never blocks on a
    full buffer (a filled stdout pipe froze MediaMTX's logger in earlier
    runs, which then froze the hook's console.log — a harness bug)."""
    for line in iter(pipe.readline, b""):
        sink.append(line)

ROOT = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.join(ROOT, "ffmpeg_win", "ffmpeg-n8.1-latest-win64-gpl-shared-8.1", "bin", "ffmpeg.exe")
MEDIAMTX = os.path.join(ROOT, "mediamtx_win", "mediamtx.exe")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(pid):
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                   capture_output=True, timeout=15)


def start_publisher(rtmp, duration=None):
    args = [FFMPEG, "-hide_banner", "-loglevel", "warning",
         "-re", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30",
         "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100",
         "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
         "-pix_fmt", "yuv420p", "-g", "30", "-b:v", "2000k",
         "-c:a", "aac", "-b:a", "128k",
         "-f", "flv", f"rtmp://127.0.0.1:{rtmp}/live",
         *(["-t", str(duration)] if duration else [])]
    return subprocess.Popen(
        args,
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


LAST_API_ERROR = None

def paths_snapshot(api):
    global LAST_API_ERROR
    try:
        data = json.loads(urlopen(f"http://127.0.0.1:{api}/v3/paths/list", timeout=4).read())
        LAST_API_ERROR = None
        return {item["name"]: item for item in data.get("items", [])}
    except Exception as e:
        LAST_API_ERROR = f"{type(e).__name__}: {e}"
        return {}


def renditions_up(snapshot):
    live = snapshot.get("live", {})
    av1 = snapshot.get("live-av1", {})
    h264 = snapshot.get("live-h264", {})
    live_ok = bool(live.get("ready")) and "H264" in (live.get("tracks") or [])
    av1_ok = bool(av1.get("ready")) and any("AV1" in t for t in (av1.get("tracks") or [])) \
        and any("Opus" in t for t in (av1.get("tracks") or []))
    h264_ok = bool(h264.get("ready")) and any("H264" in t for t in (h264.get("tracks") or [])) \
        and any("Opus" in t for t in (h264.get("tracks") or []))
    return live_ok, av1_ok, h264_ok


def wait_renditions(api, timeout_s, label, mtx=None, publisher=None):
    deadline = time.time() + timeout_s
    snapshot = {}
    while time.time() < deadline:
        if mtx is not None and mtx.poll() is not None:
            print(f"[e2e] {label}: MEDIAMTX EXITED with code {mtx.returncode}")
            break
        if publisher is not None and publisher.poll() is not None:
            print(f"[e2e] {label}: publisher ffmpeg EXITED with code {publisher.returncode}")
            break
        snapshot = paths_snapshot(api)
        live_ok, av1_ok, h264_ok = renditions_up(snapshot)
        if live_ok and av1_ok and h264_ok:
            print(f"[e2e] {label}: ALL RENDITIONS UP")
            print("      live      tracks:", snapshot.get("live", {}).get("tracks"))
            print("      live-av1  tracks:", snapshot.get("live-av1", {}).get("tracks"))
            print("      live-h264 tracks:", snapshot.get("live-h264", {}).get("tracks"))
            return True
        time.sleep(1)
    print(f"[e2e] {label}: renditions NOT up in {timeout_s}s")
    print(f"      last API error: {LAST_API_ERROR}")
    for name in ("live", "live-av1", "live-h264"):
        item = snapshot.get(name, {})
        print(f"      {name} ready={item.get('ready')} tracks={item.get('tracks')}")
    # Is the API responding at all right now?
    import time as _t
    t0 = _t.time()
    try:
        urlopen(f"http://127.0.0.1:{api}/v3/paths/list", timeout=10).read()
        print(f"      direct API probe: OK in {_t.time()-t0:.2f}s")
    except Exception as e:
        print(f"      direct API probe: {type(e).__name__} after {_t.time()-t0:.2f}s: {e}")
    return False


def main():
    if not (os.path.isfile(FFMPEG) and os.path.isfile(MEDIAMTX)):
        print("SKIP: bundled binaries missing")
        return 2
    node = shutil.which("node")
    assert node, "node required"

    rtsp, rtmp, api, srt = (free_port() for _ in range(4))
    env = os.environ.copy()
    env.update({
        "MTX_APIADDRESS": f"127.0.0.1:{api}",
        "MTX_RTSPADDRESS": f"127.0.0.1:{rtsp}",
        "MTX_RTMPADDRESS": f"127.0.0.1:{rtmp}",
        "MTX_SRTADDRESS": f"127.0.0.1:{srt}",
        # The production host on this machine is running and owns the WebRTC
        # ports (8889/8189) and the RTSP UDP transport (8000/8001); this
        # sandbox needs none of those — WebRTC off, TCP-only RTSP (which is
        # exactly what the bridge reads anyway).
        "MTX_WEBRTC": "no",
        "MTX_RTSPTRANSPORTS": "tcp",
        # Bridge env (inherited by the runOnAvailable hook):
        "RTSP_PORT": str(rtsp),
        "BRIDGE_RTMP_PORT": str(rtmp),
        "BRIDGE_API_BASE": f"http://127.0.0.1:{api}",
    })

    print(f"[e2e] starting MediaMTX (api={api} rtsp={rtsp} rtmp={rtmp})")
    mtx = subprocess.Popen([MEDIAMTX, "mediamtx.yml"], cwd=ROOT, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    mtx_log = []
    threading.Thread(target=drain, args=(mtx.stdout, mtx_log), daemon=True).start()
    publisher = None
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                urlopen(f"http://127.0.0.1:{api}/v3/paths/list", timeout=0.5)
                break
            except Exception:
                time.sleep(0.2)
        else:
            print("FAIL: MediaMTX API never came up")
            return 1

        # --- Phase 1: first broadcast ---
        print("[e2e] phase 1: publishing testsrc2 H264 + AAC to RTMP live")
        publisher = start_publisher(rtmp, duration=9)
        if not wait_renditions(api, 50, "phase 1", mtx=mtx, publisher=publisher):
            return 1

        # --- Phase 2: OBS stop, then start again ---
        print("[e2e] phase 2: waiting for the graceful publish to end (OBS stop)")
        try:
            publisher.wait(timeout=20)
        except subprocess.TimeoutExpired:
            kill_tree(publisher.pid)
        publisher = None
        deadline = time.time() + 20
        while time.time() < deadline:
            snapshot = paths_snapshot(api)
            live = snapshot.get("live", {})
            if not (live.get("ready") or live.get("online")):
                break
            time.sleep(0.5)
        else:
            print("WARN: live path never went offline; continuing anyway")
        print("[e2e] phase 2: republishing (OBS start)")
        publisher = start_publisher(rtmp)
        ok = wait_renditions(api, 40, "phase 2 (second broadcast)", mtx=mtx, publisher=publisher)
        if not ok:
            print("E2E FAIL — the second broadcast lost its renditions")
            print("=== MediaMTX output tail ===")
            for line in mtx_log[-40:]:
                print(line.decode("utf-8", "replace").rstrip())
            return 1
        print("E2E OK — audio rescue verified end to end, "
              "and the bridge re-fires across OBS stop/start")
        return 0
    finally:
        for proc in (publisher, mtx):
            if proc and proc.poll() is None:
                try:
                    kill_tree(proc.pid)
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
