"""End-to-end studio 60 fps check on the real machine.

Opt-in: set STUDIO_E2E=1 (it opens a headed Chrome window and takes ~60s).

Boots an isolated MediaMTX + server.js on free ports, launches a headed
Chrome with a REAL screen capture and a fake microphone, starts a 60 fps
studio broadcast, joins the real viewer, and verifies:

  * the studio still defaults to 24 fps before the test changes it
  * the bridge publishes live-h264 and NOT live-av1 (the two-output plan
    starved the relay at 60 fps: MediaMTX logged "reader is too slow", the
    relay dropped ~18 frames every 300ms, and viewers got ~30-35 fps)
  * the relay drops no video and never re-synchronises
  * the studio's Dropped meter stays at zero (browser, encoder queue and relay)
  * the viewer receives and decodes ~60 fps at the native 1080p size
  * the player boots in the Smooth (350ms) default and the measured playout
    stays near 350ms — a regression back to a 1s default fails here
  * switching to Cinema raises the measured playout by >=300ms while still
    decoding 60 fps with zero relay drops, proving the mode control works
  * a viewer that joins as soon as the stream appears is NOT rescued to 720p,
    and no rescue verdict is persisted for later visits

Why headed Chrome: headless Chrome throttles presentation after ~20s and
the media pipeline collapses, which looks exactly like the bug this test
must catch. Why an animation: Windows Desktop Duplication emits no frames
for a static desktop, so the test injects a small compositor-driven CSS
animation into the studio page itself — the window that is certainly
visible and being captured — to guarantee a real 60 Hz source.

Set STUDIO_E2E_KEEP=1 to leave the stack running for inspection; the test
prints the temp directory and PIDs. The production MediaMTX, server and
bridge are never touched: every port is free, the bridge PID/GPU state
files are redirected into the temp directory, and mediamtx.yml itself is
unchanged (ports are overridden through MTX_* environment variables).
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:  # optional dev dependency; the test skips without it
    websocket = None

# MediaMTX/ffmpeg logs contain characters the Windows console codepage cannot
# encode; losing the failure diagnostics to UnicodeEncodeError is worse than
# replacing a glyph.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="replace")

ROOT = Path(__file__).resolve().parent
MEDIAMTX = ROOT / "mediamtx_win" / "mediamtx.exe"
CONFIG = ROOT / "mediamtx.yml"

CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def free_port(used):
    while True:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        if port not in used:
            used.add(port)
            return port


def http_json(url, timeout=4):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read())


def windowed_stats_delay(now_total, now_count, old_total, old_count):
    """Per-window average from cumulative WebRTC jitter-buffer counters.

    Same formula as app.js windowedPlayoutDelayMs: dividing the session-long
    total by the session-long count hides a fresh slip behind the live edge.
    """
    if None in (now_total, now_count, old_total, old_count):
        return None
    emitted = now_count - old_count
    if old_count <= 0 or emitted <= 0 or now_total < old_total:
        return None
    return round(((now_total - old_total) / emitted) * 1000, 1)


def wait_http(url, timeout, label):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                response.read(1)
            return
        except Exception as err:
            last = err
            time.sleep(0.25)
    raise RuntimeError(f"{label} never answered {url}: {last}")


def kill_tree(pid):
    if not pid:
        return
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                   capture_output=True, timeout=20)


def tail(path, limit=40):
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-limit:])
    except OSError:
        return "(no log)"


class Browser:
    """Minimal CDP client over the browser-level websocket."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self.next_id = 0

    def send(self, method, params=None):
        self.next_id += 1
        self.ws.send(json.dumps({
            "id": self.next_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") != self.next_id:
                continue  # events are not used here
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message.get("result", {})

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


class Page:
    """Minimal CDP client for one page target."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self.next_id = 0
        self.send("Page.enable")
        self.send("Runtime.enable")

    def send(self, method, params=None):
        self.next_id += 1
        self.ws.send(json.dumps({
            "id": self.next_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") != self.next_id:
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression):
        result = self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
            "userGesture": True,
        })
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            value = details.get("exception", {}).get("description") or details.get("text")
            raise RuntimeError(value)
        return result.get("result", {}).get("value")

    def json_eval(self, expression):
        raw = self.evaluate(expression)
        return json.loads(raw) if isinstance(raw, str) else raw

    def navigate(self, url):
        self.send("Page.navigate", {"url": url})

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def wait_debug_port(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return http_json(f"http://127.0.0.1:{port}/json/version", timeout=1)
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("Chrome DevTools never came up")


def target_ws(port, target_id):
    for page in http_json(f"http://127.0.0.1:{port}/json", timeout=3):
        if page.get("id") == target_id:
            return page["webSocketDebuggerUrl"]
    raise RuntimeError(f"target {target_id} disappeared")


STUDIO_INJECT = """(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const response = await realFetch(input, init);
        try {
            const url = String(input);
            const method = String((init && init.method) || 'GET').toUpperCase();
            if (method === 'POST' && url.indexOf('/stream-api/studio/session') >= 0) {
                response.clone().json()
                    .then((body) => { window.__studioSession = body; })
                    .catch(() => {});
            }
        } catch (err) { /* not the session response */ }
        return response;
    };
})();"""

VIEWER_INJECT = """(() => {
    if (window.__probeInstalled) return;
    window.__probeInstalled = true;
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    function Wrapped(...args) {
        const pc = new Orig(...args);
        pc.__probeId = window.__pcs.length + 1;
        window.__pcs.push(pc);
        return pc;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
    window.__rvfc = { frames: 0, firstAt: 0, lastAt: 0 };
    function start() {
        const video = document.getElementById('stream-player');
        if (!video) { setTimeout(start, 250); return; }
        const callback = (now) => {
            const state = window.__rvfc;
            if (!state.firstAt) state.firstAt = now;
            state.frames += 1;
            state.lastAt = now;
            video.requestVideoFrameCallback(callback);
        };
        video.requestVideoFrameCallback(callback);
    }
    start();
})();"""

# Desktop Duplication emits frames only when the desktop changes. This
# compositor-driven animation is injected into the studio page itself (the
# window that is certainly visible and being captured), so the screen has a
# real 60 Hz source without relying on a second window staying unoccluded.
ANIMATOR_CSS = """
#__e2e_anim {
    position: fixed; left: 8px; bottom: 8px; width: 180px; height: 120px;
    z-index: 2147483647; pointer-events: none;
    background: linear-gradient(90deg, #f00, #0f0, #00f);
    animation: __e2e_slide 0.6s linear infinite alternate;
}
@keyframes __e2e_slide {
    from { transform: translateX(0) scaleX(0.2); }
    to   { transform: translateX(360px) scaleX(1); }
}
"""

ANIMATOR_JS = """(() => {
    if (document.getElementById('__e2e_anim')) return;
    const style = document.createElement('style');
    style.textContent = %s;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = '__e2e_anim';
    document.body.appendChild(box);
})();""" % json.dumps(ANIMATOR_CSS)


def main():
    if websocket is None:
        print("SKIP: the websocket-client Python package is not installed")
        return 2
    if not MEDIAMTX.is_file():
        print("SKIP: bundled MediaMTX is missing")
        return 2
    chrome = next((path for path in CHROME_CANDIDATES if path and Path(path).is_file()), None)
    if not chrome:
        print("SKIP: Chrome/Edge is not installed")
        return 2
    node = shutil.which("node")
    if not node:
        print("SKIP: node is not installed")
        return 2

    used = set()
    rtsp = free_port(used)
    rtmp = free_port(used)
    api = free_port(used)
    srt = free_port(used)
    webrtc = free_port(used)
    webrtc_udp = free_port(used)
    server_port = free_port(used)
    debug_port = free_port(used)

    work = Path(tempfile.mkdtemp(prefix="studio-e2e-"))
    mtx_log = work / "mediamtx.log"
    server_log = work / "server.log"
    chrome_profile = work / "chrome-profile"
    chrome_log = work / "chrome.log"
    bridge_pid = work / "bridge.pid"
    bridge_gpu = work / "bridge-gpu.json"

    print(f"[e2e] work dir: {work}")
    print(f"[e2e] ports: rtsp={rtsp} rtmp={rtmp} api={api} srt={srt} "
          f"webrtc={webrtc}/{webrtc_udp} server={server_port} cdp={debug_port}")

    env = os.environ.copy()
    env.update({
        "MTX_APIADDRESS": f"127.0.0.1:{api}",
        "MTX_RTSPADDRESS": f"127.0.0.1:{rtsp}",
        "MTX_RTMPADDRESS": f"127.0.0.1:{rtmp}",
        "MTX_SRTADDRESS": f"127.0.0.1:{srt}",
        "MTX_WEBRTCADDRESS": f"127.0.0.1:{webrtc}",
        "MTX_WEBRTCLOCALUDPADDRESS": f"127.0.0.1:{webrtc_udp}",
        # WebRTC viewers only; the bridge and the relay both use RTSP/TCP.
        "MTX_RTSPTRANSPORTS": "tcp",
        # Bridge env, inherited by the runOnAvailable hook:
        "RTSP_PORT": str(rtsp),
        "BRIDGE_RTMP_PORT": str(rtmp),
        "BRIDGE_API_BASE": f"http://127.0.0.1:{api}",
        # Never share the production bridge's PID/GPU records.
        "BRIDGE_PID_FILE": str(bridge_pid),
        "BRIDGE_GPU_STATE_FILE": str(bridge_gpu),
    })

    mtx = server = chrome_proc = None
    browser = studio = viewer = animator = None
    handles = []
    try:
        mtx_out = open(mtx_log, "w", encoding="utf-8")
        handles.append(mtx_out)
        mtx = subprocess.Popen(
            [str(MEDIAMTX), str(CONFIG)],
            cwd=str(ROOT), env=env,
            stdout=mtx_out, stderr=subprocess.STDOUT,
        )
        wait_http(f"http://127.0.0.1:{api}/v3/paths/list", 20, "MediaMTX API")
        print("[e2e] MediaMTX up")

        server_env = os.environ.copy()
        server_env.update({
            "PORT": str(server_port),
            "MEDIAMTX_PORT": str(webrtc),
            "MEDIAMTX_API_PORT": str(api),
            "STUDIO_RTSP_URL": f"rtsp://127.0.0.1:{rtsp}/live",
        })
        server_out = open(server_log, "w", encoding="utf-8")
        handles.append(server_out)
        server = subprocess.Popen(
            [node, "server.js"],
            cwd=str(ROOT), env=server_env,
            stdout=server_out, stderr=subprocess.STDOUT,
        )
        studio_url = f"http://127.0.0.1:{server_port}/streaming/studio"
        viewer_url = f"http://127.0.0.1:{server_port}/streaming/"
        wait_http(studio_url, 20, "server.js")
        print("[e2e] server.js up")

        chrome_args = [
            chrome,
            f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={chrome_profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-features=CalculateNativeWinOcclusion",
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-device-for-media-stream",
            "--auto-select-desktop-capture-source=Entire screen",
            "--enable-usermedia-screen-capturing",
            "--allow-http-screen-capture",
            "--window-size=640,480",
            "--window-position=0,0",
            "--new-window",
            "about:blank",
        ]
        chrome_out = open(chrome_log, "w", encoding="utf-8")
        handles.append(chrome_out)
        chrome_proc = subprocess.Popen(
            chrome_args, stdout=chrome_out, stderr=subprocess.STDOUT,
        )
        info = wait_debug_port(debug_port)
        browser = Browser(info["webSocketDebuggerUrl"])
        print("[e2e] Chrome up")

        # The page's own click is the user gesture getDisplayMedia needs.
        created = browser.send("Target.createTarget", {"url": "about:blank"})
        studio = Page(target_ws(debug_port, created["targetId"]))
        studio.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        studio.send("Page.addScriptToEvaluateOnNewDocument", {"source": STUDIO_INJECT})
        studio.navigate(studio_url)

        # Let the fake mic through without touching the screen picker.
        try:
            browser.send("Browser.grantPermissions", {
                "origin": f"http://127.0.0.1:{server_port}",
                "permissions": ["audioCapture"],
            })
        except Exception as err:
            print(f"[e2e] WARN: could not grant mic permission: {err}")

        deadline = time.time() + 20
        while time.time() < deadline:
            state = studio.json_eval("""JSON.stringify({
                ready: document.readyState,
                hasStart: Boolean(document.getElementById('btn-start')),
                hostNote: (document.getElementById('studio-host-note') || {}).textContent || null
            })""")
            if state.get("ready") == "complete" and state.get("hasStart"):
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("studio page did not load")

        default_fps = studio.evaluate("document.getElementById('sel-framerate').value")
        print(f"[e2e] studio default frame rate: {default_fps}")
        if default_fps != "24":
            raise RuntimeError(f"24 fps is no longer the default (got {default_fps})")

        # Create the viewer window before the broadcast starts: opening a new
        # Chrome window changes the captured desktop, and doing that mid-stream
        # produced a burst that the relay had to drop. It stays on about:blank
        # until the source is steady.
        viewer_target = browser.send("Target.createTarget", {"url": "about:blank", "newWindow": True})
        viewer = Page(target_ws(debug_port, viewer_target["targetId"]))
        viewer.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        viewer.send("Page.addScriptToEvaluateOnNewDocument", {"source": VIEWER_INJECT})
        # A previous run's rescue verdict would pin this viewer to 720p before
        # the test could see whether the new grace period works.
        viewer.send("Page.addScriptToEvaluateOnNewDocument", {
            "source": "try{localStorage.removeItem('rydius_h264_rescue')}catch(e){}"
        })
        try:
            window = browser.send("Browser.getWindowForTarget", {"targetId": viewer_target["targetId"]})
            browser.send("Browser.setWindowBounds", {
                "windowId": window["windowId"],
                "bounds": {"left": 650, "top": 210, "width": 640, "height": 480},
            })
        except Exception as err:
            print(f"[e2e] WARN: could not place the viewer window: {err}")

        # Load the viewer before the broadcast starts. Its page load repaints
        # the captured desktop, and doing that after capture begins showed up
        # as a burst of encoder-queue skips that had nothing to do with the
        # broadcast. The page polls until the stream is live, so it is ready to
        # join the moment the encoder publishes.
        viewer.navigate(viewer_url)

        # Keep the screen changing at 60 Hz for the whole broadcast.
        studio.evaluate(ANIMATOR_JS)
        studio.send("Page.bringToFront")

        picked = studio.evaluate("""(async () => {
            const fps = document.getElementById('sel-framerate');
            fps.value = '60';
            fps.dispatchEvent(new Event('change', { bubbles: true }));
            const mic = document.getElementById('chk-mic');
            if (mic) {
                mic.checked = true;
                mic.dispatchEvent(new Event('change', { bubbles: true }));
            }
            document.getElementById('btn-pick-source').click();
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline && document.getElementById('btn-start').disabled) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return JSON.stringify({
                startDisabled: document.getElementById('btn-start').disabled,
                status: (document.getElementById('studio-status-text') || {}).textContent || null,
                source: (document.getElementById('studio-source-label') || {}).textContent || null
            });
        })()""")
        picked = json.loads(picked)
        print(f"[e2e] source: {picked}")
        if picked.get("startDisabled"):
            raise RuntimeError("the real screen capture never produced a startable source")

        studio.evaluate("""(async () => {
            document.getElementById('btn-start').click();
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                const status = (document.getElementById('studio-status-text') || {}).textContent || '';
                if (window.__studioSession && /live/i.test(status)) return;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error('broadcast did not go live: '
                + ((document.getElementById('studio-status-text') || {}).textContent || ''));
        })()""")
        session = studio.json_eval("JSON.stringify(window.__studioSession || null)")
        if not session or not session.get("id"):
            raise RuntimeError("the studio never created an ingest session")
        print(f"[e2e] session {session['id']} video={session.get('video')}")
        if int(session.get("video", {}).get("fps") or 0) != 60:
            raise RuntimeError(f"the studio did not start at 60 fps: {session.get('video')}")

        status_url = f"http://127.0.0.1:{server_port}{session['statusUrl']}"
        paths_url = f"http://127.0.0.1:{api}/v3/paths/list"

        def relay_status():
            return http_json(status_url, timeout=4)

        # Wait for the bridge's single 720p rendition. live-av1 must stay down.
        deadline = time.time() + 25
        snapshot = {}
        while time.time() < deadline:
            snapshot = {item["name"]: item for item in http_json(paths_url).get("items", [])}
            h264 = snapshot.get("live-h264", {})
            live = snapshot.get("live", {})
            if live.get("ready") and h264.get("ready"):
                break
            time.sleep(0.5)
        tracks = {
            name: {
                "ready": bool(snapshot.get(name, {}).get("ready")),
                "tracks": snapshot.get(name, {}).get("tracks") or [],
            }
            for name in ("live", "live-av1", "live-h264")
        }
        print(f"[e2e] paths: {json.dumps(tracks, indent=2)}")
        if not tracks["live"]["ready"]:
            raise RuntimeError("the studio's native path never became ready")
        if not tracks["live-h264"]["ready"]:
            raise RuntimeError("the 720p H.264 rescue never became ready")
        if tracks["live-av1"]["ready"]:
            raise RuntimeError(
                "live-av1 is publishing alongside live-h264; the two-output bridge "
                "is the 60 fps regression this test exists to catch"
            )

        # Join the moment the stream appears, without waiting for the relay to
        # settle. This is deliberate: a viewer that arrives in the first
        # seconds used to look like a slow decoder, get rescued to 720p, and
        # persist that verdict for every later visit. The healthy path must
        # keep it on 1080p without a false rescue.
        prejoin = studio.json_eval("""JSON.stringify({
            meter: (document.getElementById('meter-fps') || {}).textContent || '',
            dropped: (document.getElementById('meter-dropped') || {}).textContent || ''
        })""")
        print(f"[e2e] pre-join: meter={prejoin.get('meter')} "
              f"dropped={prejoin.get('dropped')}")
        print("[e2e] joining as soon as the stream appears (rescue grace)")
        viewer.send("Page.bringToFront")

        deadline = time.time() + 30
        viewer_state = {}
        while time.time() < deadline:
            viewer_state = viewer.json_eval("""JSON.stringify((() => {
                const pcs = window.__pcs || [];
                const pc = pcs[pcs.length - 1];
                const video = document.getElementById('stream-player');
                return {
                    pcs: pcs.length,
                    ice: pc ? pc.iceConnectionState + '/' + pc.connectionState : null,
                    ready: video ? video.readyState : 0,
                    width: video ? video.videoWidth : 0,
                    height: video ? video.videoHeight : 0
                };
            })())""")
            if (viewer_state.get("ice") == "connected/connected"
                    and int(viewer_state.get("ready") or 0) >= 2
                    and int(viewer_state.get("width") or 0) > 0):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError(f"viewer never connected: {viewer_state}")
        print(f"[e2e] viewer: {viewer_state}")

        def viewer_sample():
            return viewer.json_eval("""(async () => {
                const pcs = window.__pcs || [];
                const pc = pcs[pcs.length - 1];
                const video = document.getElementById('stream-player');
                const out = {
                    at: performance.now(),
                    pcId: pc ? pc.__probeId : 0,
                    ice: pc ? pc.iceConnectionState + '/' + pc.connectionState : null,
                    width: video ? video.videoWidth : 0,
                    height: video ? video.videoHeight : 0,
                    rvfc: (window.__rvfc || {}).frames || 0,
                    stats: null
                };
                if (pc) {
                    const stats = await pc.getStats();
                    stats.forEach((entry) => {
                        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
                            out.stats = {
                                framesReceived: entry.framesReceived,
                                framesDecoded: entry.framesDecoded,
                                framesDropped: entry.framesDropped,
                                packetsLost: entry.packetsLost,
                                pliCount: entry.pliCount,
                                decoderImplementation: entry.decoderImplementation,
                                jitterBufferDelay: entry.jitterBufferDelay,
                                jitterBufferEmittedCount: entry.jitterBufferEmittedCount,
                                jitterBufferTargetDelay: entry.jitterBufferTargetDelay,
                                jitterBufferMinimumDelay: entry.jitterBufferMinimumDelay
                            };
                        }
                    });
                }
                return JSON.stringify(out);
            })()""")

        rows = []
        previous = None
        started = time.time()
        # 18s of samples: the viewer's first few seconds include page load and
        # decoder warm-up, which are not the steady-state behaviour this check
        # measures. The window below discards them.
        while time.time() - started < 18:
            relay = relay_status()
            sample = viewer_sample()
            row = {
                "at": round(time.time() - started, 2),
                "meterFps": studio.evaluate(
                    "(document.getElementById('meter-fps') || {}).textContent || ''"
                ),
                "meterDropped": studio.evaluate(
                    "(document.getElementById('meter-dropped') || {}).textContent || ''"
                ),
                "relay": {
                    "state": relay.get("state"),
                    "videoFrames": relay.get("videoFrames"),
                    "droppedVideo": relay.get("droppedVideo"),
                    "resyncs": relay.get("resyncs"),
                    "needKeyframe": relay.get("needKeyframe"),
                },
                "viewer": sample,
            }
            if previous:
                seconds = row["at"] - previous["at"]
                same_peer = row["viewer"].get("pcId") == previous["viewer"].get("pcId")
                counters_kept = (
                    row["viewer"].get("stats") and previous["viewer"].get("stats")
                    and row["viewer"]["stats"]["framesReceived"]
                    >= previous["viewer"]["stats"]["framesReceived"]
                )
                if seconds > 0 and same_peer and counters_kept:
                    now_stats = row["viewer"]["stats"]
                    old_stats = previous["viewer"]["stats"]
                    row["rxFps"] = round(
                        (now_stats["framesReceived"] - old_stats["framesReceived"]) / seconds, 1)
                    row["decFps"] = round(
                        (now_stats["framesDecoded"] - old_stats["framesDecoded"]) / seconds, 1)
                    row["rvfcFps"] = round(
                        (row["viewer"]["rvfc"] - previous["viewer"]["rvfc"]) / seconds, 1)
                    row["playoutMs"] = windowed_stats_delay(
                        now_stats.get("jitterBufferDelay"),
                        now_stats.get("jitterBufferEmittedCount"),
                        old_stats.get("jitterBufferDelay"),
                        old_stats.get("jitterBufferEmittedCount"))
                    row["targetMs"] = windowed_stats_delay(
                        now_stats.get("jitterBufferTargetDelay"),
                        now_stats.get("jitterBufferEmittedCount"),
                        old_stats.get("jitterBufferTargetDelay"),
                        old_stats.get("jitterBufferEmittedCount"))
                else:
                    # A rendition switch tears the peer connection down and
                    # resets its counters; a delta across it is meaningless.
                    row["reconnected"] = True
                if row["relay"]["videoFrames"] is not None:
                    row["relayFps"] = round(
                        (row["relay"]["videoFrames"] - previous["relay"]["videoFrames"]) / seconds, 1)
            rows.append(row)
            previous = row
            print(f"[e2e] {row['at']:5.1f}s meter={row['meterFps']:>3} "
                  f"relay={row.get('relayFps')} rx={row.get('rxFps')} dec={row.get('decFps')} "
                  f"playout={row.get('playoutMs')} target={row.get('targetMs')} "
                  f"dropped={row['relay']['droppedVideo']} meterDrop={row['meterDropped']} "
                  f"resyncs={row['relay']['resyncs']} "
                  f"{row['viewer'].get('width')}x{row['viewer'].get('height')}")
            time.sleep(1)

        steady = [row for row in rows
                  if row["at"] >= 6 and "decFps" in row and not row.get("reconnected")]
        if len(steady) < 8:
            raise RuntimeError("not enough steady-state samples")

        first = steady[0]["relay"]
        last = steady[-1]["relay"]
        dropped = (last["droppedVideo"] or 0) - (first["droppedVideo"] or 0)
        resyncs = (last["resyncs"] or 0) - (first["resyncs"] or 0)
        avg_rx = sum(row["rxFps"] for row in steady) / len(steady)
        avg_dec = sum(row["decFps"] for row in steady) / len(steady)
        min_dec = min(row["decFps"] for row in steady)
        widths = {row["viewer"].get("width") for row in steady}
        heights = {row["viewer"].get("height") for row in steady}
        meter_drops = [
            int(row["meterDropped"]) for row in rows
            if str(row.get("meterDropped") or "").strip().isdigit()
        ]
        rescue = viewer.evaluate("localStorage.getItem('rydius_h264_rescue')")
        playouts = [row["playoutMs"] for row in steady if row.get("playoutMs") is not None]
        targets = [row["targetMs"] for row in steady if row.get("targetMs") is not None]
        avg_playout = sum(playouts) / len(playouts) if playouts else None
        avg_target = sum(targets) / len(targets) if targets else None

        print(f"[e2e] steady: rx={avg_rx:.1f} dec={avg_dec:.1f} minDec={min_dec:.1f} "
              f"dropped={dropped} resyncs={resyncs} size={widths}x{heights} "
              f"meterDrop={max(meter_drops, default=None)} rescue={rescue!r}")
        print(f"[e2e] latency: playout avg={avg_playout} "
              f"min={min(playouts) if playouts else None} "
              f"max={max(playouts) if playouts else None} "
              f"target avg={avg_target}")

        problems = []
        if dropped != 0:
            problems.append(f"the relay dropped {dropped} video frames")
        if resyncs != 0:
            problems.append(f"the relay re-synchronised {resyncs} times")
        if not meter_drops:
            problems.append("the studio Dropped meter never reported a value")
        elif max(meter_drops) != 0:
            problems.append(
                f"the studio Dropped meter reached {max(meter_drops)} "
                "(browser, encoder queue or relay)")
        if rescue is not None:
            problems.append(f"a false 720p rescue was persisted: {rescue!r}")
        if avg_rx < 55:
            problems.append(f"viewer received only {avg_rx:.1f} fps")
        if avg_dec < 55:
            problems.append(f"viewer decoded only {avg_dec:.1f} fps")
        if widths != {1920} or heights != {1080}:
            problems.append(f"viewer played {widths}x{heights}, not the native 1920x1080")

        # The buffer mode must change the measured playout delay, not just the
        # HUD label. The first window above measured the DEFAULT, so pin its
        # absolute latency: a regression back to a 1s default fails here even
        # if the mode button still works. Then switch to Cinema and prove the
        # control really changes the delay while still decoding 60 fps.
        default_mode = viewer.evaluate(
            "document.getElementById('latency-mode-btn').title")
        print(f"[e2e] default latency mode: {default_mode}")
        if "Anti-Stutter" not in (default_mode or ""):
            problems.append(
                f"the player did not boot in the Smooth default: {default_mode!r}")

        if avg_playout is None:
            problems.append("the viewer never reported a playout delay")
        else:
            if avg_playout > 500:
                problems.append(
                    "the default latency mode buffered "
                    f"{avg_playout:.0f}ms; the default must stay near 350ms")

            viewer.evaluate(
                "document.getElementById('latency-mode-btn').click()")
            time.sleep(0.15)
            cinema_mode = viewer.evaluate(
                "document.getElementById('latency-mode-btn').title")
            print(f"[e2e] latency mode -> {cinema_mode}; settling")
            if "Cinema" not in (cinema_mode or ""):
                problems.append(
                    f"the mode button did not reach Cinema: {cinema_mode!r}")
            time.sleep(8)

            cinema_rows = []
            cinema_prev = None
            cinema_started = time.time()
            while time.time() - cinema_started < 12:
                relay = relay_status()
                sample = viewer_sample()
                row = {
                    "at": round(time.time() - cinema_started, 2),
                    "relay": relay,
                    "viewer": sample,
                }
                if cinema_prev:
                    seconds = row["at"] - cinema_prev["at"]
                    now_stats = row["viewer"].get("stats") or {}
                    old_stats = cinema_prev["viewer"].get("stats") or {}
                    same_peer = (
                        row["viewer"].get("pcId")
                        == cinema_prev["viewer"].get("pcId"))
                    if (seconds > 0 and same_peer and now_stats and old_stats
                            and now_stats["framesReceived"]
                            >= old_stats["framesReceived"]):
                        row["rxFps"] = round(
                            (now_stats["framesReceived"]
                             - old_stats["framesReceived"]) / seconds, 1)
                        row["decFps"] = round(
                            (now_stats["framesDecoded"]
                             - old_stats["framesDecoded"]) / seconds, 1)
                        row["playoutMs"] = windowed_stats_delay(
                            now_stats.get("jitterBufferDelay"),
                            now_stats.get("jitterBufferEmittedCount"),
                            old_stats.get("jitterBufferDelay"),
                            old_stats.get("jitterBufferEmittedCount"))
                        row["targetMs"] = windowed_stats_delay(
                            now_stats.get("jitterBufferTargetDelay"),
                            now_stats.get("jitterBufferEmittedCount"),
                            old_stats.get("jitterBufferTargetDelay"),
                            old_stats.get("jitterBufferEmittedCount"))
                cinema_rows.append(row)
                cinema_prev = row
                print(f"[e2e] cinema {row['at']:5.1f}s rx={row.get('rxFps')} "
                      f"dec={row.get('decFps')} playout={row.get('playoutMs')} "
                      f"target={row.get('targetMs')} "
                      f"dropped={row['relay'].get('droppedVideo')} "
                      f"resyncs={row['relay'].get('resyncs')}")
                time.sleep(1)

            cinema = [row for row in cinema_rows
                      if row["at"] >= 4 and row.get("playoutMs") is not None]
            if len(cinema) < 5:
                problems.append("the Cinema latency window produced too few samples")
            else:
                cinema_playout = (
                    sum(row["playoutMs"] for row in cinema) / len(cinema))
                cinema_dec = sum(row["decFps"] for row in cinema) / len(cinema)
                cinema_dropped = (
                    (cinema[-1]["relay"].get("droppedVideo") or 0)
                    - (cinema[0]["relay"].get("droppedVideo") or 0))
                cinema_resyncs = (
                    (cinema[-1]["relay"].get("resyncs") or 0)
                    - (cinema[0]["relay"].get("resyncs") or 0))
                print(f"[e2e] cinema: playout avg={cinema_playout:.1f} "
                      f"dec={cinema_dec:.1f} dropped={cinema_dropped} "
                      f"resyncs={cinema_resyncs} "
                      f"(default playout was {avg_playout:.1f})")
                if cinema_playout - avg_playout < 300:
                    problems.append(
                        "Cinema did not raise the measured playout delay: "
                        f"default {avg_playout:.0f}ms vs cinema "
                        f"{cinema_playout:.0f}ms")
                if cinema_dec < 55:
                    problems.append(
                        f"Cinema decoded only {cinema_dec:.1f} fps at 60 fps")
                if cinema_dropped != 0:
                    problems.append(
                        f"Cinema dropped {cinema_dropped} relay frames")
                if cinema_resyncs != 0:
                    problems.append(
                        f"Cinema re-synchronised {cinema_resyncs} times")

        if problems:
            raise RuntimeError("; ".join(problems))

        print("[e2e] PASS: real 60 fps studio broadcast reached the viewer cleanly")
        return 0
    except Exception as err:
        print(f"[e2e] FAIL: {err}")
        print("[e2e] --- server log tail ---")
        print(tail(server_log))
        print("[e2e] --- MediaMTX log tail ---")
        print(tail(mtx_log))
        print("[e2e] --- Chrome log tail ---")
        print(tail(chrome_log))
        return 1
    finally:
        if os.environ.get("STUDIO_E2E_KEEP") == "1":
            print(f"[e2e] KEEP: work={work} mtx={mtx and mtx.pid} "
                  f"server={server and server.pid} chrome={chrome_proc and chrome_proc.pid}")
        else:
            for page in (viewer, studio):
                try:
                    page.close()
                except Exception:
                    pass
            try:
                if browser:
                    browser.close()
            except Exception:
                pass
            kill_tree(chrome_proc and chrome_proc.pid)
            kill_tree(server and server.pid)
            kill_tree(mtx and mtx.pid)
            for handle in handles:
                try:
                    handle.close()
                except Exception:
                    pass
            try:
                shutil.rmtree(work, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
