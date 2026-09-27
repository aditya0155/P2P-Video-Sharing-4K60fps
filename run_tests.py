"""Local checks for the Windows laptop streaming host (no remote services)."""

import gzip
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from html.parser import HTMLParser
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError, URLError
from urllib.parse import unquote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HTML_PATH = ROOT / "index.html"
APP_PATH = ROOT / "app.js"
SERVER_PATH = ROOT / "server.js"
CONFIG_PATH = ROOT / "mediamtx.yml"
JS_CHECKS_PATH = ROOT / "js_checks.js"
BRIDGE_PATH = ROOT / "codec_bridge.js"
LAUNCHER_PATH = ROOT / "start_host.ps1"
MEDIAMTX_PATH = ROOT / "mediamtx_win" / "mediamtx.exe"


class IdCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "id" and value:
                self.ids.append(value)


def read_text(path):
    return path.read_text(encoding="utf-8")


def find_free_port():
    """Hand back a loopback port that was free a moment ago."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def start_node_server(node, env_overrides):
    """Start server.js on loopback with explicit overrides (PORT, upstream ports)."""
    env = os.environ.copy()
    for key in (
        "PORT", "MEDIAMTX_PORT", "MEDIAMTX_API_PORT",
        "CF_TURN_KEY_ID", "CF_TURN_KEY_TOKEN", "CF_TURN_API_BASE", "CF_TURN_TTL_SECONDS",
    ):
        env.pop(key, None)
    env.update({key: str(value) for key, value in env_overrides.items()})
    return subprocess.Popen(
        [node, str(SERVER_PATH)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def wait_until_ready(test_case, process, base_url, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            test_case.fail("Node site server exited before becoming ready")
        try:
            with urlopen(base_url + "/streaming/", timeout=0.5):
                return
        except (URLError, OSError):
            time.sleep(0.1)
    test_case.fail("Node site server did not become ready")


def stop_process(process):
    """Terminate a subprocess and return everything it printed (for failures)."""
    if process is None:
        return ""
    process.terminate()
    try:
        output, _ = process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate(timeout=3)
    return output.decode("utf-8", "replace") if output else ""


class CaseInsensitiveHeaders(dict):
    """HTTP header names are case-insensitive, even when raw casing varies."""

    def __init__(self, headers):
        super().__init__((name.lower(), value) for name, value in headers)

    def get(self, name, default=None):
        return super().get(name.lower(), default)

    def __getitem__(self, name):
        return super().__getitem__(name.lower())


def http_request(port, method, path, body=None, headers=None):
    """Raw HTTP call that never follows redirects (unlike urlopen)."""
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        return response.status, CaseInsensitiveHeaders(response.getheaders()), payload
    finally:
        connection.close()


def run_js_check(test_case, case_name):
    """Run one js_checks.js case and fail with its diagnostics on error."""
    node = shutil.which("node")
    test_case.assertIsNotNone(node, "Node.js is required to host the site")
    result = subprocess.run(
        [node, str(JS_CHECKS_PATH), case_name],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    test_case.assertEqual(
        result.returncode,
        0,
        "js_checks.js case {!r} failed:\n{}{}".format(case_name, result.stdout, result.stderr),
    )


class _QuietHTTPServer(HTTPServer):
    """Keeps proxy keep-alive resets from dumping tracebacks into the report."""

    allow_reuse_address = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class StubMediaMTX:
    """Loopback stand-in for MediaMTX that records every proxied request.

    ``routes`` maps ``(method, path)`` to a callable receiving the stub and
    returning ``(status, headers, body)``. Unmatched requests answer 200.
    """

    def __init__(self, routes=None):
        self.routes = routes or {}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format_string, *args):
                pass

            def _dispatch(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                stub.requests.append({
                    "method": self.command,
                    "path": self.path,
                    "host": self.headers.get("Host"),
                    "content_type": self.headers.get("Content-Type"),
                    "authorization": self.headers.get("Authorization"),
                    "body": body.decode("utf-8", "replace"),
                })
                route = stub.routes.get((self.command, self.path))
                if route is None:
                    status, extra_headers, payload = 200, {}, b"stub-ok"
                else:
                    status, extra_headers, payload = route(stub)
                self.send_response(status)
                for key, value in extra_headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if payload:
                    self.wfile.write(payload)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _dispatch

        self.server = _QuietHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        self.thread = Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def clear(self):
        del self.requests[:]


class LaptopHostChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = read_text(HTML_PATH)
        cls.app = read_text(APP_PATH)
        cls.server = read_text(SERVER_PATH)
        cls.config = read_text(CONFIG_PATH)

    def test_required_local_files_exist(self):
        for path in (HTML_PATH, APP_PATH, SERVER_PATH, CONFIG_PATH, JS_CHECKS_PATH, BRIDGE_PATH, LAUNCHER_PATH, MEDIAMTX_PATH):
            with self.subTest(path=path.name):
                self.assertTrue(path.is_file(), "Missing required host file")

    def test_html_ids_are_unique_and_referenced_ids_exist(self):
        parser = IdCollector()
        parser.feed(self.html)
        self.assertEqual(len(parser.ids), len(set(parser.ids)), "HTML contains duplicate IDs")
        html_ids = set(parser.ids)
        js_ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", self.app))
        self.assertEqual(js_ids - html_ids, set(), "app.js references IDs absent from index.html")

    def test_page_assets_use_one_cache_version(self):
        versions = re.findall(r"/(?:streaming/)?(?:style\.css|app\.js)\?v=([^\"']+)", self.html)
        self.assertEqual(len(versions), 2, "both style.css and app.js must be cache-versioned")
        self.assertEqual(len(set(versions)), 1, "both assets must share one cache version")
        self.assertRegex(versions[0], r"^\d+\.\d+\.\d+$", "cache version must be semver-like")

    def test_page_text_is_clean_utf8_without_mojibake(self):
        # index.html once shipped Windows-1252 double-encoded text (scrambled
        # emoji and apostrophes) that only mobile viewers noticed, because
        # desktop browsers were serving stale cached bytes. Keep it out for good.
        self.assertNotRegex(self.html, r"[\x80-\x9f]",
                            "index.html contains C1 controls (double-encoded bytes)")
        for marker in ("\u00e2\u20ac", "\u00f0\u0178", "\u00c3\u00a2", "\u00ef\u00b8"):
            self.assertNotIn(marker, self.html,
                             "index.html contains double-encoded (mojibake) text")
        self.assertNotIn("\ufffd", self.html,
                         "index.html contains replacement characters")

    def test_obs_and_player_use_the_laptop_stream_path(self):
        self.assertIn("rtmp://127.0.0.1:1935/live", self.html)
        self.assertIn("srt://127.0.0.1:8890?streamid=publish:live", self.html)
        self.assertIn("http://127.0.0.1:8889/live/whip", self.html)
        self.assertIn("const WHEP_PATH = '/stream-api/live/whep';", self.app)
        self.assertIn("requestUrl.pathname.startsWith('/stream-api/')", self.server)
        self.assertIn("const targetPath = requestUrl.pathname.slice('/stream-api'.length)", self.server)
        self.assertRegex(
            self.server,
            r"const MEDIAMTX_PORT = Number\.parseInt\(process\.env\.MEDIAMTX_PORT \|\| '8889', 10\)",
        )
        self.assertIn("rtmpAddress: 127.0.0.1:1935", self.config)
        self.assertIn("webrtcAddress: 127.0.0.1:8889", self.config)
        self.assertIn("srtAddress: 127.0.0.1:8890", self.config)

    def test_share_link_is_derived_from_current_host(self):
        self.assertIn("new URL('/streaming/', window.location.origin).href", self.app)
        self.assertNotIn("rydius.in/streaming", self.html)

    def test_host_server_binds_to_loopback_and_has_explicit_routes(self):
        self.assertIn("server.listen(PORT, '127.0.0.1'", self.server)
        self.assertIn("const STATIC_FILES = new Map(", self.server)
        self.assertIn("res.writeHead(404", self.server)

    def test_node_files_parse(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to host the site")
        for path in (SERVER_PATH, APP_PATH, JS_CHECKS_PATH, BRIDGE_PATH):
            result = subprocess.run(
                [node, "--check", str(path)],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=15,
            )
            with self.subTest(path=path.name):
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_mediamtx_config_validates(self):
        result = subprocess.run(
            [str(MEDIAMTX_PATH), "--validate-conf", str(CONFIG_PATH)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("configuration file is valid", result.stdout.lower())

    def test_codec_bridge_is_wired_into_the_mediamtx_config(self):
        # The companion-rendition bridge must be fully reachable from the
        # config: loopback RTSP (the only protocol that can serve AV1 back
        # out of MediaMTX), both rendition paths, and hooks that start and
        # stop codec_bridge.js with the source stream.
        self.assertIn("rtsp: yes", self.config)
        rtsp = re.search(r"^rtspAddress:\s*(\S+)$", self.config, re.MULTILINE)
        self.assertIsNotNone(rtsp, "missing rtspAddress in mediamtx.yml")
        self.assertTrue(rtsp.group(1).startswith("127.0.0.1:"),
                        "RTSP must bind loopback only, got {}".format(rtsp.group(1)))
        self.assertIn('runOnAvailable: node "codec_bridge.js"', self.config)
        self.assertIn('runOnUnavailable: node "codec_bridge.js" --cleanup', self.config)
        self.assertIn("  live-av1:", self.config)
        self.assertIn("  live-h264:", self.config)

        # The bridge's default ports must agree with this config, otherwise
        # the hook silently transcodes into a dead endpoint.
        bridge = read_text(BRIDGE_PATH)
        rtmp = re.search(r"^rtmpAddress:\s*127\.0\.0\.1:(\d+)", self.config, re.MULTILINE)
        api = re.search(r"^apiAddress:\s*(\S+)$", self.config, re.MULTILINE)
        self.assertIsNotNone(rtmp, "missing rtmpAddress in mediamtx.yml")
        self.assertIsNotNone(api, "missing apiAddress in mediamtx.yml")
        self.assertIn("BRIDGE_RTMP_PORT || '{}'".format(rtmp.group(1)), bridge)
        self.assertIn("BRIDGE_API_BASE || 'http://{}'".format(api.group(1)), bridge)
        self.assertIn("RTSP_PORT || '{}'".format(rtsp.group(1).rsplit(":", 1)[1]), bridge)

    def test_local_site_routes_and_404_behavior(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to host the site")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]

        env = os.environ.copy()
        env["PORT"] = str(port)
        env.pop("MEDIAMTX_PORT", None)
        process = subprocess.Popen(
            [node, str(SERVER_PATH)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        base = "http://127.0.0.1:{}".format(port)
        try:
            deadline = time.time() + 8
            while time.time() < deadline:
                if process.poll() is not None:
                    self.fail("Node site server exited before becoming ready")
                try:
                    with urlopen(base + "/streaming/", timeout=0.5) as response:
                        page = response.read().decode("utf-8")
                    break
                except (URLError, OSError):
                    time.sleep(0.1)
            else:
                self.fail("Node site server did not become ready")

            self.assertIn("Rydius Stream", page)
            for route in ("/streaming/style.css?v=2.2.0", "/streaming/app.js?v=2.2.0"):
                with self.subTest(route=route):
                    with urlopen(base + route, timeout=2) as response:
                        self.assertEqual(response.status, 200)

            for route in ("/run_tests.py", "/mediamtx.yml", "/unknown-page"):
                with self.subTest(route=route):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + route, timeout=2)
                    self.assertEqual(error.exception.code, 404)
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def test_proxy_rewrites_whep_session_location(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to host the site")

        class StubWHEPHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(201)
                self.send_header(
                    "Location",
                    "http://127.0.0.1:{}/live/whep/session-id?keep=1".format(self.server.server_port),
                )
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format_string, *args):
                pass

        upstream = HTTPServer(("127.0.0.1", 0), StubWHEPHandler)
        upstream_thread = Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]

        env = os.environ.copy()
        env["PORT"] = str(port)
        env["MEDIAMTX_PORT"] = str(upstream.server_port)
        process = subprocess.Popen(
            [node, str(SERVER_PATH)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        base = "http://127.0.0.1:{}".format(port)
        try:
            deadline = time.time() + 8
            while time.time() < deadline:
                if process.poll() is not None:
                    self.fail("Node site server exited before becoming ready")
                try:
                    with urlopen(base + "/streaming/", timeout=0.5):
                        break
                except (URLError, OSError):
                    time.sleep(0.1)
            else:
                self.fail("Node site server did not become ready")

            request = Request(base + "/stream-api/live/whep", data=b"", method="POST")
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 201)
                self.assertEqual(response.headers.get("Location"), "/stream-api/live/whep/session-id?keep=1")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=1)


    def test_status_probe_uses_mediamtx_control_api(self):
        # An OPTIONS probe on the WHEP endpoint always answers 204 (verified against
        # MediaMTX v1.21.1) whether or not a publisher exists, so it can never detect
        # offline status. The player must read the control API's real path state instead.
        self.assertIn("'/stream-api/v3/paths/list'", self.app)
        self.assertNotIn("method: 'OPTIONS'", self.app)
        self.assertIn("startsWith('/stream-api/v3/')", self.server)
        self.assertIn("MEDIAMTX_API_PORT", self.server)
        self.assertRegex(
            self.server,
            r"const MEDIAMTX_API_PORT = Number\.parseInt\(process\.env\.MEDIAMTX_API_PORT \|\| '8888', 10\)",
        )
        self.assertIn("apiAddress: 127.0.0.1:8888", self.config)
        self.assertIn("api: yes", self.config)

    def test_no_simulated_viewer_counts(self):
        # Fake viewer stats were removed in the UI pass; keep them out for good.
        for marker in ("startViewerSimulation", "stopViewerSimulation", "mockViewerCount", "viewerInterval"):
            with self.subTest(marker=marker):
                self.assertNotIn(marker, self.app)


class _SiteUnderTest(unittest.TestCase):
    """Boots a fresh server.js per test, wired to stub or intentionally dead upstreams.

    ``routes=None`` points that upstream at a port nobody listens on, which is
    how the "MediaMTX is not running" paths get exercised.
    """

    def setUp(self):
        self.node = shutil.which("node")
        self.assertIsNotNone(self.node, "Node.js is required to host the site")
        self.server_process = None
        self.signaling = None
        self.api = None
        self._stubs = []

    def tearDown(self):
        stop_process(self.server_process)
        for stub in self._stubs:
            stub.stop()

    def start_site(self, signaling_routes=None, api_routes=None, extra_env=None):
        overrides = {"PORT": find_free_port()}
        if signaling_routes is None:
            overrides["MEDIAMTX_PORT"] = find_free_port()
        else:
            self.signaling = StubMediaMTX(signaling_routes).start()
            self._stubs.append(self.signaling)
            overrides["MEDIAMTX_PORT"] = self.signaling.port
        if api_routes is None:
            overrides["MEDIAMTX_API_PORT"] = find_free_port()
        else:
            self.api = StubMediaMTX(api_routes).start()
            self._stubs.append(self.api)
            overrides["MEDIAMTX_API_PORT"] = self.api.port
        if extra_env:
            overrides.update(extra_env)

        self.port = overrides["PORT"]
        self.base_url = "http://127.0.0.1:{}".format(self.port)
        self.server_process = start_node_server(self.node, overrides)
        wait_until_ready(self, self.server_process, self.base_url)


class JsLogicChecks(unittest.TestCase):
    """Browser-logic checks that run the real app.js functions inside js_checks.js.

    These cover the transforms and state transitions that break silently in a
    browser: SDP munging, the status poll, reconnect backoff and the cross-file
    endpoint invariants.
    """

    def test_sdp_advertises_exactly_one_video_bandwidth_ceiling(self):
        run_js_check(self, "sdp-bandwidth-ceiling")

    def test_sdp_feedback_lines_stay_inside_the_video_section(self):
        run_js_check(self, "sdp-feedback-scoped-to-video")

    def test_sdp_tuning_is_idempotent_and_audio_only_safe(self):
        run_js_check(self, "sdp-idempotent-and-audio-only-safe")

    def test_poll_connects_when_publisher_is_ready(self):
        run_js_check(self, "poll-connects-when-publisher-ready")

    def test_poll_goes_offline_when_publisher_is_missing(self):
        run_js_check(self, "poll-offline-when-publisher-missing")

    def test_poll_goes_offline_when_mediamtx_is_unreachable(self):
        run_js_check(self, "poll-offline-when-mediamtx-unreachable")

    def test_poll_is_skipped_while_connected_or_connecting(self):
        run_js_check(self, "poll-skipped-while-connected-or-connecting")

    def test_reconnect_backoff_grows_then_caps(self):
        run_js_check(self, "poll-backoff-grows-and-caps")

    def test_disconnect_cleans_up_and_schedules_a_reconnect(self):
        run_js_check(self, "disconnect-schedules-reconnect")

    def test_latency_mode_cycle_matches_the_mode_table(self):
        run_js_check(self, "latency-mode-cycle-matches-mode-table")

    def test_stream_endpoints_are_consistent_across_files(self):
        run_js_check(self, "stream-endpoints-are-consistent-everywhere")

    def test_playout_delay_drift_uses_windowed_deltas(self):
        run_js_check(self, "playout-delay-is-windowed")

    def test_poll_warns_about_av1_only_broadcast(self):
        run_js_check(self, "poll-warns-about-av1-only-broadcast")

    def test_poll_resets_rendition_wait_state(self):
        run_js_check(self, "poll-resets-rendition-wait-state")

    def test_buffer_supervisor_sleeps_while_hidden(self):
        run_js_check(self, "buffer-supervisor-sleeps-while-hidden")

    def test_jitter_buffer_floor_tracks_measured_jitter(self):
        run_js_check(self, "jitter-buffer-floor")

    def test_granted_playout_target_is_read_back(self):
        """jitterBufferTarget is a hint with a UA-chosen min/max, so the value
        written is not evidence of the value in force. See
        ViewerSmoothnessRegressionChecks for the full rationale."""
        run_js_check(self, "granted-target-readback")

    def test_granted_target_gap_is_bounded_and_pure(self):
        """A diagnostic, deliberately not a control input. See
        ViewerSmoothnessRegressionChecks for the full rationale."""
        run_js_check(self, "granted-target-gap")

    def test_jitter_target_write_is_clamped_to_the_legal_range(self):
        """The setter's range is [0, 4000] and outside it throws a RangeError.
        See ViewerSmoothnessRegressionChecks for the full rationale."""
        run_js_check(self, "jitter-target-clamp")

    def test_effective_playback_rate_is_measured_and_smoothed(self):
        """playbackRate reads 1.0 for a MediaStream, so it cannot see the
        "speeds up / slows down" symptom. See ViewerSmoothnessRegressionChecks
        for the full rationale."""
        run_js_check(self, "effective-playback-rate")

    def test_audio_clock_drift_is_measured_in_ppm(self):
        """Audio time vs wall time. The app previously read no audio stats at
        all. See ViewerSmoothnessRegressionChecks for the full rationale."""
        run_js_check(self, "audio-clock-drift")

    def test_spec_freeze_threshold_scales_with_frame_rate(self):
        """The spec's freeze bound is frame-rate dependent. See
        ViewerSmoothnessRegressionChecks for the full rationale."""
        run_js_check(self, "spec-freeze-threshold")


    def test_abr_switching_state_machine(self):
        run_js_check(self, "abr-switching-state-machine")

    def test_stream_path_selection_by_browser_codec_support(self):
        run_js_check(self, "choose-stream-path-matrix")

    def test_poll_waits_for_a_decodable_rendition(self):
        run_js_check(self, "poll-waits-for-compatible-rendition")

    def test_poll_prefers_the_av1_rendition_when_available(self):
        run_js_check(self, "poll-picks-rendition-path")

    def test_codec_bridge_direction_and_command(self):
        run_js_check(self, "codec-bridge-direction-matrix")

    def test_unmute_overlay_follows_the_mute_state(self):
        run_js_check(self, "unmute-overlay-follows-mute-state")


class StreamApiProxyChecks(_SiteUnderTest):
    """Every byte the player exchanges with MediaMTX crosses this proxy."""

    SIGNALING_ROUTES = property(lambda self: {
        ("POST", "/live/whep?token=abc"): lambda stub: (
            201,
            {"Location": "http://127.0.0.1:{}/live/whep/session-id?keep=1".format(stub.port)},
            b"",
        ),
        ("GET", "/live/whep"): lambda stub: (404, {}, b'{"error":"no publisher"}'),
        ("GET", "/abs-redirect"): lambda stub: (
            302,
            {"Location": "http://127.0.0.1:{}/live/other".format(stub.port)},
            b"",
        ),
        ("GET", "/rel-redirect"): lambda stub: (302, {"Location": "/live/other"}, b""),
        ("GET", "/ext-redirect"): lambda stub: (302, {"Location": "https://example.invalid/elsewhere"}, b""),
    })

    API_ROUTES = property(lambda self: {
        ("GET", "/v3/paths/list"): lambda stub: (
            200,
            {"Content-Type": "application/json"},
            json.dumps({
                "itemCount": 1,
                "items": [{"name": "live", "ready": False, "online": False}],
            }).encode("utf-8"),
        ),
    })

    def setUp(self):
        super().setUp()
        self.start_site(signaling_routes=self.SIGNALING_ROUTES, api_routes=self.API_ROUTES)

    def test_static_assets_serve_gzip_when_requested(self):
        # The page assets ride gzip when the browser allows it: app.js is
        # ~170 KB raw and ~40 KB gzipped, which cuts the first page load on
        # the LAN/Tailscale paths roughly 4x (the Cloudflare tunnel already
        # compresses). Without Accept-Encoding the identity bytes (and the
        # exact Content-Length) must be served as before.
        status, headers, body = http_request(
            self.port, "GET", "/streaming/app.js",
            headers={"Accept-Encoding": "gzip"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        self.assertEqual(headers.get("Vary"), "Accept-Encoding")
        self.assertNotIn("Content-Length", headers,
                         "a preset Content-Length on gzipped output would truncate the body")
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as decoded:
            self.assertEqual(decoded.read(), APP_PATH.read_bytes(),
                             "the gzipped body must decompress to the exact asset bytes")

        status, headers, body = http_request(self.port, "GET", "/streaming/app.js")
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Encoding", headers,
                         "no Accept-Encoding must mean no content coding")
        self.assertEqual(headers.get("Content-Length"), str(APP_PATH.stat().st_size))

    def test_whep_post_is_forwarded_and_session_location_is_rewritten(self):
        sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n"
        status, headers, _ = http_request(
            self.port, "POST", "/stream-api/live/whep?token=abc",
            body=sdp, headers={"Content-Type": "application/sdp"},
        )

        self.assertEqual(status, 201)
        # The player reads Location to DELETE the session on teardown, and CORS
        # only exposes headers that are listed explicitly.
        self.assertEqual(headers.get("Location"), "/stream-api/live/whep/session-id?keep=1")
        self.assertIn("Location", headers.get("Access-Control-Expose-Headers", ""))
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

        forwarded = self.signaling.requests[-1]
        self.assertEqual(forwarded["method"], "POST")
        self.assertEqual(forwarded["path"], "/live/whep?token=abc")
        self.assertEqual(forwarded["host"], "127.0.0.1:{}".format(self.signaling.port))
        self.assertEqual(forwarded["content_type"], "application/sdp")
        self.assertEqual(forwarded["body"], sdp)
        self.assertEqual(self.api.requests, [], "WHEP signaling must not hit the control API port")

    def test_status_probe_is_routed_to_the_control_api_port(self):
        status, _, body = http_request(self.port, "GET", "/stream-api/v3/paths/list")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["items"][0]["name"], "live")
        self.assertIn("ready", payload["items"][0])

        self.assertEqual(self.api.requests[-1]["path"], "/v3/paths/list")
        self.assertEqual(self.api.requests[-1]["host"], "127.0.0.1:{}".format(self.api.port))
        self.assertEqual(self.signaling.requests, [], "the status probe must not reach the WHEP port")

    def test_location_rewrite_only_touches_same_origin(self):
        expectations = [
            ("/stream-api/abs-redirect", "/stream-api/live/other"),
            ("/stream-api/rel-redirect", "/stream-api/live/other"),
            ("/stream-api/ext-redirect", "https://example.invalid/elsewhere"),
        ]
        for path, expected_location in expectations:
            with self.subTest(path=path):
                status, headers, _ = http_request(self.port, "GET", path)
                self.assertEqual(status, 302)
                self.assertEqual(headers.get("Location"), expected_location)

    def test_upstream_404_passes_through_and_is_never_cached(self):
        status, headers, body = http_request(self.port, "GET", "/stream-api/live/whep")
        self.assertEqual(status, 404)
        self.assertIn("no publisher", body.decode("utf-8"))
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_preflight_is_answered_locally_without_touching_mediamtx(self):
        self.signaling.clear()
        self.api.clear()

        status, headers, _ = http_request(self.port, "OPTIONS", "/stream-api/live/whep")
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))
        self.assertIn("Location", headers.get("Access-Control-Expose-Headers", ""))
        self.assertEqual(self.signaling.requests, [], "preflight must not reach MediaMTX")
        self.assertEqual(self.api.requests, [], "preflight must not reach MediaMTX")

    def test_turn_endpoint_serves_cloudflare_stun_without_turn_config(self):
        # Without CF_TURN_KEY_* the endpoint must still answer 200 with the
        # free Cloudflare STUN entry (the cardless punch-through path), and
        # POSTs must be refused instead of leaking into the MediaMTX proxy.
        status, headers, body = http_request(self.port, "GET", "/stream-api/turn")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertEqual(
            json.loads(body.decode("utf-8")),
            {"iceServers": [{"urls": ["stun:stun.cloudflare.com:3478"]}]},
        )
        status, _, _ = http_request(self.port, "POST", "/stream-api/turn", body="x")
        self.assertEqual(status, 405)
        self.assertEqual(self.signaling.requests, [], "the TURN endpoint must not reach MediaMTX")
        self.assertEqual(self.api.requests, [], "the TURN endpoint must not reach MediaMTX")


class TurnCredentialProxyChecks(_SiteUnderTest):
    """Remote viewers receive Cloudflare TURN credentials minted by the local server.

    The stub plays Cloudflare's TURN API: server.js must call it with the
    server-side token, cache a single mint for the whole room, strip every
    non-TURN entry (Google STUN, port 53), prepend the always-on Cloudflare
    STUN entry and never echo the token back to a browser.
    """

    MINT_PATH = "/v1/turn/keys/test-turn-key/credentials/generate-ice-servers"

    def setUp(self):
        super().setUp()
        minted = json.dumps({
            "iceServers": [
                {"urls": ["stun:stun.cloudflare.com:3478"]},
                {"urls": ["stun:stun.l.google.com:19302"]},
                {
                    "urls": [
                        "turn:turn.cloudflare.com:3478?transport=udp",
                        "turn:turn.cloudflare.com:443?transport=udp",
                        "turn:turn.cloudflare.com:53?transport=udp",
                        "turns:turn.cloudflare.com:443?transport=tcp",
                    ],
                    "username": "minted-user",
                    "credential": "minted-secret",
                },
            ]
        }).encode("utf-8")

        self.cf = StubMediaMTX({
            ("POST", self.MINT_PATH): lambda stub: (
                201, {"Content-Type": "application/json"}, minted,
            ),
        }).start()
        self._stubs.append(self.cf)
        self.start_site(extra_env={
            "CF_TURN_KEY_ID": "test-turn-key",
            "CF_TURN_KEY_TOKEN": "test-api-token",
            "CF_TURN_API_BASE": "http://127.0.0.1:{}".format(self.cf.port),
            "CF_TURN_TTL_SECONDS": "3600",
        })

    def test_mint_uses_server_side_token_and_viewers_see_turn_only(self):
        status, headers, body = http_request(self.port, "GET", "/stream-api/turn")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(
            payload["iceServers"][0],
            {"urls": ["stun:stun.cloudflare.com:3478"]},
            "the served first entry must be the always-on Cloudflare STUN",
        )
        self.assertNotIn("stun.l.google.com", body.decode("utf-8"), "Google STUN must never be served")
        self.assertEqual(len(payload["iceServers"]), 2, "STUN + one TURN entry expected")
        entry = payload["iceServers"][1]
        for url in entry["urls"]:
            self.assertTrue(url.startswith(("turn:", "turns:")), "non-TURN URL survived: " + url)
            self.assertNotIn(":53?", url, "browser-blocked port-53 URL must be stripped")
        self.assertEqual(entry["username"], "minted-user")
        self.assertEqual(entry["credential"], "minted-secret")
        self.assertNotIn("test-api-token", body.decode("utf-8"), "the mint token must never reach a viewer")

        mint = self.cf.requests[-1]
        self.assertEqual(mint["method"], "POST")
        self.assertEqual(mint["path"], self.MINT_PATH)
        self.assertEqual(mint["authorization"], "Bearer test-api-token")
        self.assertEqual(mint["content_type"], "application/json")
        self.assertEqual(json.loads(mint["body"]), {"ttl": 3600})

        # One mint is shared by every viewer in the room.
        second_status, _, second_body = http_request(self.port, "GET", "/stream-api/turn")
        self.assertEqual(second_status, 200)
        self.assertEqual(second_body, body)
        self.assertEqual(len(self.cf.requests), 1, "repeat requests must reuse the cached mint")

    def test_mint_failure_returns_empty_and_backs_off(self):
        self.cf.routes[("POST", self.MINT_PATH)] = lambda stub: (500, {}, b'{"err":"nope"}')
        status, _, body = http_request(self.port, "GET", "/stream-api/turn")
        self.assertEqual(status, 200, "a Cloudflare outage must not take the player down")
        self.assertEqual(
            json.loads(body.decode("utf-8")),
            {"iceServers": [{"urls": ["stun:stun.cloudflare.com:3478"]}]},
            "without TURN credentials the free STUN path must still be served",
        )
        http_request(self.port, "GET", "/stream-api/turn")
        self.assertEqual(len(self.cf.requests), 1, "failed mints must back off instead of hammering")

    def test_mint_renews_at_half_life_and_viewer_cache_stays_shorter(self):
        # Cloudflare disconnects TURN allocations once their credentials expire
        # (FAQ), so the server must never serve a mint with less than TTL/2 of
        # validity left, and the viewer's ICE cache must stay shorter than that
        # floor — the old TTL-300s schedule + 30-minute viewer cache could
        # hand a reconnecting viewer expired credentials and kill its relay.
        server = read_text(SERVER_PATH)
        app = read_text(APP_PATH)
        self.assertIn("(CF_TURN_TTL_SECONDS / 2) * 1000", server,
                      "server must renew mints on a TTL/2 half-life schedule")
        self.assertRegex(app, r"cachedIceServersAt (?:<=>|> |<=) 10 \* 60 \* 1000",
                         "viewer ICE cache (10 min) must stay below the mint's >=30 min validity floor")


class MediaMtxUnavailableChecks(_SiteUnderTest):
    """MediaMTX is down before OBS starts — the page must still behave."""

    def test_control_api_probe_returns_actionable_json(self):
        self.start_site()
        status, headers, body = http_request(self.port, "GET", "/stream-api/v3/paths/list")
        self.assertEqual(status, 502)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertIn("start_host.bat", body.decode("utf-8"))

    def test_whep_endpoint_returns_actionable_json(self):
        self.start_site()
        status, _, body = http_request(self.port, "GET", "/stream-api/live/whep")
        self.assertEqual(status, 502)
        self.assertIn("MediaMTX is not running", body.decode("utf-8"))

    def test_preflight_still_succeeds_without_mediamtx(self):
        self.start_site()
        status, headers, _ = http_request(self.port, "OPTIONS", "/stream-api/v3/paths/list")
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")


class StaticServerHardeningChecks(_SiteUnderTest):
    """The allowlist map is the only thing standing between the page and the repo."""

    PRIVATE_PATHS = (
        "/server.js",
        "/js_checks.js",
        "/run_tests.py",
        "/start_host.ps1",
        "/start_host.bat",
        "/README.md",
        "/_verify_bugs.js",
        "/mediamtx.yml",
        "/legacy_vps/deploy.py",
    )

    def test_head_returns_headers_but_no_body(self):
        self.start_site()
        status, headers, body = http_request(self.port, "HEAD", "/streaming/app.js?v=2.2.0")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type", ""))
        self.assertEqual(int(headers["Content-Length"]), APP_PATH.stat().st_size)
        self.assertEqual(body, b"")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

    def test_write_methods_are_rejected_with_allow_header(self):
        self.start_site()
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            with self.subTest(method=method):
                status, headers, _ = http_request(self.port, method, "/streaming/")
                self.assertEqual(status, 405)
                self.assertEqual(headers.get("Allow"), "GET, HEAD")

    def test_host_source_files_are_never_served(self):
        self.start_site()
        for path in self.PRIVATE_PATHS:
            with self.subTest(path=path):
                status, _, _ = http_request(self.port, "GET", path)
                self.assertEqual(status, 404)

    def test_bare_stream_api_path_is_not_proxied(self):
        # "/stream-api" (no trailing slash) must not fall into the proxy branch.
        self.start_site()
        status, _, _ = http_request(self.port, "GET", "/stream-api")
        self.assertEqual(status, 404)


class StartupConfigurationChecks(unittest.TestCase):
    """A bad PORT must abort at boot instead of silently binding something else."""

    def _boot(self, overrides):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to host the site")
        env = os.environ.copy()
        for key in (
            "PORT", "MEDIAMTX_PORT", "MEDIAMTX_API_PORT",
            "CF_TURN_KEY_ID", "CF_TURN_KEY_TOKEN", "CF_TURN_API_BASE", "CF_TURN_TTL_SECONDS",
        ):
            env.pop(key, None)
        env.update({key: str(value) for key, value in overrides.items()})
        process = subprocess.Popen(
            [node, str(SERVER_PATH)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        try:
            output, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)
            self.fail("server.js accepted {!r} and kept running".format(overrides))
        return process.returncode, output.decode("utf-8", "replace")

    def test_non_numeric_port_exits_with_a_clear_error(self):
        returncode, output = self._boot({"PORT": "not-a-port", "MEDIAMTX_PORT": 8889, "MEDIAMTX_API_PORT": 8888})
        self.assertNotEqual(returncode, 0)
        self.assertIn("PORT must be a valid TCP port", output)

    def test_out_of_range_port_exits_with_a_clear_error(self):
        returncode, output = self._boot({"PORT": 70000, "MEDIAMTX_PORT": 8889, "MEDIAMTX_API_PORT": 8888})
        self.assertNotEqual(returncode, 0)
        self.assertIn("PORT must be a valid TCP port", output)

    def test_invalid_api_port_exits_with_a_clear_error(self):
        returncode, output = self._boot({"PORT": find_free_port(), "MEDIAMTX_PORT": 8889, "MEDIAMTX_API_PORT": "abc"})
        self.assertNotEqual(returncode, 0)
        self.assertIn("MEDIAMTX_API_PORT must be a valid TCP port", output)


class CrossFileConsistencyChecks(unittest.TestCase):
    """Ports, stream names and asset URLs are each written down in several files."""

    @classmethod
    def setUpClass(cls):
        cls.html = read_text(HTML_PATH)
        cls.app = read_text(APP_PATH)
        cls.server = read_text(SERVER_PATH)
        cls.config = read_text(CONFIG_PATH)
        cls.launcher = read_text(LAUNCHER_PATH)

    def test_ports_agree_between_config_site_page_and_launcher(self):
        def address(protocol):
            match = re.search(r"^{}Address:\s*(\S+)$".format(protocol), self.config, re.MULTILINE)
            self.assertIsNotNone(match, "missing {}Address in mediamtx.yml".format(protocol))
            return match.group(1)

        addresses = {
            "api": address("api"),
            "rtmp": address("rtmp"),
            "webrtc": address("webrtc"),
            "srt": address("srt"),
            "rtsp": address("rtsp"),
        }
        for label, value in addresses.items():
            with self.subTest(binding=label):
                self.assertTrue(value.startswith("127.0.0.1:"),
                                "{} must bind loopback only, got {}".format(label, value))

        ports = {label: value.rsplit(":", 1)[1] for label, value in addresses.items()}
        defaults = dict(re.findall(
            r"const (MEDIAMTX_(?:API_)?PORT) = Number\.parseInt\(process\.env\.\w+ \|\| '(\d+)'",
            self.server,
        ))
        self.assertEqual(defaults.get("MEDIAMTX_PORT"), ports["webrtc"],
                         "server.js WHEP proxy default must match webrtcAddress")
        self.assertEqual(defaults.get("MEDIAMTX_API_PORT"), ports["api"],
                         "server.js control-API proxy default must match apiAddress")

        self.assertIn("rtmp://{}/live".format(addresses["rtmp"]), self.html)
        self.assertIn("srt://{}?streamid=publish:live".format(addresses["srt"]), self.html)
        self.assertIn("http://{}/live/whip".format(addresses["webrtc"]), self.html)

        self.assertIn("Test-LocalTcpPort {}".format(ports["webrtc"]), self.launcher)
        self.assertIn("http://127.0.0.1:{}/v3/paths/list".format(ports["api"]), self.launcher)

    def test_html_assets_are_all_in_the_static_allowlist(self):
        references = re.findall(r"(?:href|src)=\"(/streaming/[^\"]+)\"", self.html)
        self.assertTrue(references, "expected at least one local asset reference in index.html")

        versions = set()
        for reference in references:
            with self.subTest(reference=reference):
                asset_path, _, query = reference.partition("?")
                self.assertIn("'{}'".format(asset_path), self.server,
                              "{} is missing from the server.js STATIC_FILES allowlist".format(asset_path))
                version = re.search(r"[?&]v=([^&]+)", "?" + query)
                self.assertIsNotNone(version, "{} has no ?v= cache buster".format(reference))
                versions.add(version.group(1))
        self.assertEqual(len(versions), 1,
                         "all assets must share one cache version, got {}".format(sorted(versions)))

    def test_query_selectors_used_by_app_exist_in_html(self):
        selectors = re.findall(r"querySelector(?:All)?\(\s*['\"]([^'\"]+)['\"]\s*\)", self.app)
        self.assertTrue(selectors, "expected app.js to select at least one element")

        html_classes = set()
        for class_attribute in re.findall(r'class="([^"]*)"', self.html):
            html_classes.update(class_attribute.split())
        parser = IdCollector()
        parser.feed(self.html)
        html_ids = set(parser.ids)

        for selector in selectors:
            with self.subTest(selector=selector):
                if selector.startswith("."):
                    for class_name in selector.lstrip(".").split("."):
                        self.assertIn(class_name, html_classes,
                                      "class .{} used by app.js is absent from index.html".format(class_name))
                elif selector.startswith("#"):
                    self.assertIn(selector[1:], html_ids,
                                  "id {} used by app.js is absent from index.html".format(selector[1:]))
                else:
                    self.fail("unsupported selector {!r} — extend this check".format(selector))


class MediaMTXControlApiContractChecks(unittest.TestCase):
    """Locks the MediaMTX behaviour app.js depends on (this breaks on upgrades).

    Online/offline is decided from ``GET /v3/paths/list`` (``items[].name`` with
    ``ready``/``online``), never from an OPTIONS probe — preflight answers 204
    whether or not a publisher exists, which is exactly the bug that used to
    make every poll start a doomed WebRTC handshake.
    """

    def test_paths_api_and_whep_match_what_the_player_expects(self):
        if not MEDIAMTX_PATH.is_file():
            self.skipTest("MediaMTX binary is not installed")

        api_port = find_free_port()
        webrtc_port = find_free_port()
        media_port = find_free_port()
        config = (
            "logLevel: warn\n"
            "logDestinations: [stdout]\n"
            "api: yes\n"
            "apiAddress: 127.0.0.1:{api}\n"
            "rtsp: no\n"
            "hls: no\n"
            "rtmp: no\n"
            "srt: no\n"
            "webrtc: yes\n"
            "webrtcAddress: 127.0.0.1:{webrtc}\n"
            "webrtcLocalUDPAddress: 127.0.0.1:{media}\n"
            "webrtcLocalTCPAddress: 127.0.0.1:{media}\n"
            "webrtcIPsFromInterfaces: no\n"
            "webrtcAdditionalHosts: [127.0.0.1]\n"
            "paths:\n"
            "  live:\n"
            "    overridePublisher: yes\n"
        ).format(api=api_port, webrtc=webrtc_port, media=media_port)

        with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False, encoding="ascii") as handle:
            handle.write(config)
            config_path = Path(handle.name)

        process = None
        try:
            process = subprocess.Popen(
                [str(MEDIAMTX_PATH), str(config_path)],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            payload = None
            deadline = time.time() + 15
            while time.time() < deadline and payload is None:
                if process.poll() is not None:
                    self.fail("MediaMTX exited during startup:\n{}".format(
                        (process.communicate()[0] or b"").decode("utf-8", "replace")))
                try:
                    with urlopen("http://127.0.0.1:{}/v3/paths/list".format(api_port), timeout=1) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                except (URLError, OSError, ValueError):
                    time.sleep(0.2)
            self.assertIsNotNone(payload, "MediaMTX control API never answered on port {}".format(api_port))

            live = next((item for item in payload.get("items", []) if item.get("name") == "live"), None)
            self.assertIsNotNone(live, "the configured 'live' path must be listed, got: {}".format(payload))
            self.assertIs(live.get("ready"), False, "no publisher means ready must be false")
            self.assertIs(live.get("online"), False, "no publisher means online must be false")

            # Why the player must never use OPTIONS as a liveness probe:
            status, _, _ = http_request(webrtc_port, "OPTIONS", "/live/whep")
            self.assertEqual(status, 204)

            # With no publisher, WHEP session creation has to fail fast.
            status, _, _ = http_request(
                webrtc_port, "POST", "/live/whep",
                body="v=0\r\n", headers={"Content-Type": "application/sdp"},
            )
            self.assertEqual(status, 404)
        finally:
            stop_process(process)
            config_path.unlink(missing_ok=True)


class ReceiverLagFixChecks(unittest.TestCase):
    """Guards for the receiver-side lag fixes, each one verified live.

    Every check here protects a fix that was confirmed against a running
    MediaMTX v1.21.1 instance and must not silently regress:

    * Remote viewing works without any carded Cloudflare product: both sides
      get the free stun.cloudflare.com entry (verified reachable from this
      network with a real binding request) so they can hole-punch a direct
      path, and /stream-api/turn adds server-minted Cloudflare TURN relay
      credentials only when CF_TURN_KEY_* is configured. Google STUN —
      historically unreachable here — is stripped everywhere.
    * The adaptive buffer supervisor reads jitter/loss/jitter-buffer-delay
      every second and drives the live-edge catch-up plus the stress raise;
      the stats loop must keep calling it.
    * The WHEP handshake must be time-bounded so a stalled POST fails in
      seconds instead of waiting for the 12s watchdog.
    * Sustained frame drops auto-enable Eco Mode (respecting a manual choice)
      so decorative blur animations stop competing with video decode.
    """

    def test_ice_config_is_cloudflare_stun_plus_optional_turn(self):
        app = read_text(APP_PATH)
        config = read_text(CONFIG_PATH)
        server = read_text(SERVER_PATH)
        # The player asks the local server for ICE config and hands exactly
        # that to RTCPeerConnection; it never hardcodes servers of its own.
        self.assertIn("'/stream-api/turn'", app, "player must fetch ICE config from the local endpoint")
        self.assertIn("cachedIceServers", app, "PC must use the fetched ICE config")
        self.assertIn("allowedIceServers", app, "player must filter ICE entries through the allow-list")
        self.assertNotRegex(
            app,
            r"stun:(?!stun\.cloudflare\.com)",
            "the player may only ever reference Cloudflare STUN",
        )
        # The Cloudflare API token stays server-side, behind the mint endpoint.
        self.assertIn("'/stream-api/turn'", server, "server must expose the TURN endpoint")
        self.assertIn(
            "credentials/generate-ice-servers",
            server,
            "server must mint through Cloudflare's TURN API",
        )
        self.assertIn(
            "process.env.CF_TURN_KEY_TOKEN",
            server,
            "mint token must come from the environment",
        )
        self.assertIn("CF_STUN_ENTRY", server, "server must always serve the Cloudflare STUN entry")
        self.assertNotRegex(
            server,
            r"stun:(?!stun\.cloudflare\.com)",
            "server may only ever reference Cloudflare STUN",
        )
        # MediaMTX uses Cloudflare STUN only — no Google STUN, no TURN in config.
        self.assertRegex(
            config,
            r"(?m)^  - url: stun:stun\.cloudflare\.com:3478$",
            "mediamtx.yml must configure the verified Cloudflare STUN server",
        )
        self.assertNotRegex(
            config,
            r"stun:(?!stun\.cloudflare\.com)",
            "mediamtx.yml must not configure any other STUN server",
        )

    def test_whep_handshake_is_time_bounded(self):
        app = read_text(APP_PATH)
        self.assertIn("whepPostTimeout = setTimeout(", app, "WHEP POST needs a timeout timer")
        self.assertIn("signal: whepAbortController.signal", app, "WHEP POST must be abortable")
        self.assertIn("clearTimeout(whepPostTimeout)", app, "the POST timeout must be cleared on completion/teardown")

    def test_adaptive_buffer_supervision_is_wired_into_the_stats_loop(self):
        app = read_text(APP_PATH)
        self.assertIn("function superviseAdaptiveBuffer()", app)
        self.assertIn("superviseAdaptiveBuffer();", app, "the stats loop must call the supervisor")
        self.assertIn("jitterBufferDelay", app, "drift detection needs the playout-delay stats")
        self.assertIn("function currentBufferTargetMs()", app, "effective target helper missing")
        self.assertIn("accommodationTargetMs", app, "accommodation state missing")
        self.assertIn("bufferAccommodationMs", app, "buffer accommodation missing")
        self.assertIn("adaptiveRaiseUntil", app, "stress-raise state missing")

    def test_frame_drop_auto_perf_mode_is_present(self):
        app = read_text(APP_PATH)
        self.assertIn("function maybeAutoPerfMode()", app)
        self.assertIn("maybeAutoPerfMode();", app, "frame-drop path must invoke the auto perf mode")
        self.assertIn("rydius_perf_mode", app, "auto perf mode must respect the manual preference key")
        # The rolling window catches GOP-periodic drop bursts the old
        # strictly-consecutive counter missed, and the first tick after a
        # (re)start only re-baselines instead of counting the hidden span.
        self.assertIn("dropWindow", app, "rolling drop window missing")
        self.assertIn("dropTickPending", app, "first-tick re-baseline guard missing")

    def test_hud_exposes_jitter_and_buffer_target(self):
        html = read_text(HTML_PATH)
        app = read_text(APP_PATH)
        self.assertIn('id="hud-jitter"', html)
        self.assertIn('id="hud-buffer"', html)
        self.assertIn("getElementById('hud-jitter')", app)
        self.assertIn("getElementById('hud-buffer')", app)

    def test_mediamtx_queue_and_udp_buffers_are_tuned_for_viewers(self):
        config = read_text(CONFIG_PATH)
        # 2048 = double MediaMTX's documented packet-loss recommendation: an
        # empty queue costs nothing on a healthy link, while on a hotspot
        # hiccup the backlog survives instead of overflowing (an overflow
        # drops packets or the reader — lost packets break decode until the
        # next keyframe, which is exactly the receiver "frame drops" fought
        # here). The player's buffer accommodation absorbs the added latency.
        self.assertRegex(config, r"(?m)^writeQueueSize:\s*2048\s*$",
                         "2048 packets ride out hotspot hiccups without overflowing")
        self.assertRegex(config, r"(?m)^udpReadBufferSize:\s*\d+\s*$",
                         "udpReadBufferSize must be set explicitly for bursty Wi-Fi viewers")
        self.assertNotRegex(config, r"(?m)^udpReadBufferSize:\s*0\s*$",
                            "OS-default UDP buffers drop bursts on Wi-Fi viewers")

    def test_buffer_accommodation_is_drop_gated(self):
        # The measured jitter-buffer delay always tracks the jitterBufferTarget
        # hint Chrome was given, so a controller that raises the target to meet
        # the measurement chases its own tail: every session inflates to the
        # cap within half a minute, throwing away the user's latency choice
        # and re-purging the buffer on every mode switch. Raising must require
        # hard evidence (frames actually discarded while the buffer outgrew
        # the base target) and calm must drain it back.
        run_js_check(self, "buffer-accommodation-gate")
        app = read_text(APP_PATH)
        self.assertIn("droppedDelta > 0", app,
                      "the stats loop must gate the accommodation raise on actual drops")
        self.assertIn("baseBufferTargetMs()", app,
                      "the raise must be measured against the pre-accommodation target")
        self.assertIn("accommodationCalmTicks", app,
                      "the decay must require sustained drop-free ticks")

    def test_playout_delay_drift_measurement_is_windowed(self):
        # Chrome exposes jitterBufferDelay/jitterBufferEmittedCount as
        # cumulative session totals; the cumulative average they produce hides
        # fresh drift within seconds of steady playback. The supervisor must
        # consume per-tick deltas instead.
        app = read_text(APP_PATH)
        self.assertIn("function windowedPlayoutDelayMs(", app,
                      "windowed delta helper missing")
        self.assertIn("lastJitterDelayTotal", app, "delay baseline state missing")
        self.assertIn("lastJitterEmittedTotal", app, "emitted-count baseline state missing")
        self.assertNotIn("videoStats.jitterBufferDelay / videoStats.jitterBufferEmittedCount", app,
                         "the cumulative-average form must stay gone")

    def test_hud_shows_measured_playout_delay(self):
        app = read_text(APP_PATH)
        self.assertIn("updateBufferHud", app)
        self.assertRegex(app, r"live \$\{Math\.round\(avgPlayoutDelayMs\)\}",
                         "HUD buffer item must print the measured live delay when it diverges")

    def test_latency_mode_defaults_to_balanced_and_persists(self):
        # 'smooth' (350ms) as the default left every fresh viewer 170ms behind
        # the live edge even on a clean network; 'balanced' is the new floor
        # and a manual choice must survive reloads.
        app = read_text(APP_PATH)
        html = read_text(HTML_PATH)
        self.assertIn("let currentLatencyMode = 'balanced';", app,
                      "balanced (180ms) must be the default playout target")
        self.assertIn("rydius_latency_mode", app,
                      "the latency choice must persist across visits")
        self.assertIn('title="Latency Buffer: Balanced (180ms)"', html,
                      "the latency button must boot in the default mode's state")

    def test_stats_loop_resume_keeps_measurement_baselines(self):
        # A returning background tab used to restart telemetry by zeroing the
        # byte/frame baselines while the cumulative counters kept growing,
        # printing a garbage multi-Gbps bitrate spike. Resume must re-arm the
        # interval without touching baselines.
        app = read_text(APP_PATH)
        self.assertIn("function beginStatsLoop()", app, "resume-safe stats starter missing")
        self.assertGreaterEqual(app.count("beginStatsLoop();"), 2,
                                "both a fresh session and tab-resume must go through beginStatsLoop")
        self.assertNotIn("startTelemetry();\n                startAudioMeter", app,
                         "visibilitychange must not zero baselines on resume")

    def test_codec_bridge_runs_a_low_latency_pipeline(self):
        # Every added stage removes a measured source of rendition lag: UDP
        # RTSP loss, encoder lookahead, sparse keyframes and CPU decode
        # contention with OBS capture. nobuffer/low_delay input flags were
        # live-tested and made RTSP joins flaky or broken — they must stay out.
        bridge = read_text(BRIDGE_PATH)
        for flag in ("'-rtsp_transport', 'tcp'", "'-tune', 'ull'", "'-forced-idr', '1'",
                     "'-max_interleave_delta', '0'",
                     # Burst cap: bare -b:v measured 2.4x-target 100ms peaks;
                     # -maxrate/-bufsize must stay glued to every encoder plan.
                     "'-maxrate'", "'-bufsize'"):
            self.assertIn(flag, bridge, "low-latency ffmpeg flag missing: {}".format(flag))
        # The GOP must track the source frame rate (probe) with an env override.
        self.assertIn("probeGopFrames", bridge, "frame-rate GOP probe missing")
        self.assertIn("BRIDGE_GOP", bridge, "GOP override environment variable missing")
        self.assertNotIn("'-fflags', 'nobuffer'", bridge,
                         "nobuffer made RTSP joins fail or break DTS in live testing")
        self.assertNotIn("'-flags', 'low_delay'", bridge,
                         "low_delay broke AV1 decode ordering in live testing")
        self.assertIn("h264_cuvid", bridge, "NVDEC H264 decode support missing")
        self.assertIn("av1_cuvid", bridge, "NVDEC AV1 decode support missing")
        self.assertIn("function pickDecoderArgs(", bridge, "decoder selection helper missing")
        self.assertIn("BRIDGE_GPU_DECODE", bridge, "GPU decode must stay opt-out configurable")
        # A decoder that crash-looped once must be remembered, so later
        # broadcasts skip the crash cycles and start renditions immediately.
        self.assertIn("gpuDecodeBlocked", bridge, "GPU-decode failure memory missing")
        self.assertIn("rememberGpuDecodeFailure", bridge, "GPU-decode failure recording missing")
        self.assertIn("clearGpuDecodeFailure", bridge, "GPU-decode recovery clearing missing")
        # Fast failures must retry quickly (cold start is viewer-visible).
        self.assertIn("await sleep(400);", bridge, "fast-failure retry must not wait the full 2s")
        # A transcoder that publishes audio but never video (the verified OBS
        # WHIP AV1 hang) must be detected and restarted, not left running.
        self.assertIn("renditionHasVideo", bridge, "rendition video watchdog missing")
        self.assertIn("RENDITION_START_TIMEOUT_MS", bridge, "watchdog timeout missing")
        self.assertIn("restarting the transcoder", bridge, "watchdog restart log missing")
        # ... and a transcoder that STOPS producing output after video
        # already flowed (hung NVENC session, dead RTSP leg that never
        # errors) must be detected and restarted too — MediaMTX keeps the
        # path online either way, so the rendition viewers would freeze
        # indefinitely. The liveness signal is the control API's per-path
        # byte counter, NOT ffmpeg's stderr: ffmpeg prints its "frame="
        # stats line at AV_LOG_INFO and the bridge runs at -loglevel
        # warning, so a stderr-gated watchdog can never fire at all
        # (verified: 0 matching lines at warning, present at info). Bytes
        # landing on the published path is also the stronger evidence.
        self.assertIn("RENDITION_STALL_TIMEOUT_MS", bridge, "mid-broadcast stall timeout missing")
        self.assertIn("renditionBytesIngested", bridge, "stall detection must read the path ingest counter")
        self.assertIn("bytesReceived", bridge,
                      "the counter MUST be bytesReceived: MediaMTX bytesSent is EGRESS to readers and "
                      "reads a flat 0 whenever nobody is watching, which rebuilt a healthy transcoder "
                      "every 38.2s for the whole broadcast")
        self.assertNotIn("targetPath.bytesSent", bridge, "the egress counter must never gate liveness")
        self.assertIn("stalledSamples", bridge, "a single slow API read must not kill a healthy bridge")
        self.assertNotIn("_progressSeen", bridge,
                         "stderr progress gating is dead code at -loglevel warning")
        self.assertIn("stopped publishing bytes for", bridge, "stall restart log missing")
        # The bundled ffmpeg 8.1 carries the AV1 RTP fragmented-keyframe fix
        # (d12791ef) that lets OBS WHIP AV1 sources bridge; the bridge must
        # prefer it automatically while keeping the env/PATH overrides.
        self.assertIn("function resolveFfmpegBinary(", bridge, "bundled-ffmpeg resolver missing")
        self.assertIn("ffmpeg_win", bridge, "bundled ffmpeg path missing")
        self.assertIn("process.env.BRIDGE_FFMPEG", bridge, "BRIDGE_FFMPEG override missing")
        # The tunable env defaults are load-bearing for the mediamtx wiring test.
        self.assertIn("process.env.BRIDGE_RTMP_PORT || '1935'", bridge)
        self.assertIn("process.env.RTSP_PORT || '8554'", bridge)
        self.assertIn("process.env.BRIDGE_API_BASE || 'http://127.0.0.1:8888'", bridge)

    def test_player_selects_path_by_decode_quality_and_warns_av1_only(self):
        # RTCRtpReceiver.getCapabilities lists software decoders too: a viewer
        # without AV1 hardware "supports" AV1 yet drops frames at high
        # resolution. The Media Capabilities probe decides whether the
        # low-bandwidth AV1 rendition is actually smooth on this device.
        app = read_text(APP_PATH)
        self.assertIn("mediaCapabilities", app, "Media Capabilities probe missing")
        self.assertIn("decodingInfo", app, "decodingInfo call missing")
        self.assertIn("async function probeAv1DecodeSmooth()", app)
        self.assertIn("function chooseStreamPath(items, av1Capable, av1Smooth = true, preference = 'auto', h265Capable = true)",
                      app, "path selection must take the decode-quality and ABR arguments")
        # A legacy browser on an AV1-only broadcast must be told WHY nothing
        # plays instead of waiting on "connecting" forever.
        self.assertIn("renditionWaitPolls", app, "rendition wait counter missing")
        self.assertIn("broadcast H.264 via WHIP", app, "AV1-only viewer notice missing")

    def test_abr_never_downgrades_to_an_undecodable_rendition(self):
        # The ABR downgrade target is the AV1 rendition: a browser without
        # AV1 support (or with software-only decode) must keep its decodable
        # full-bitrate path — an undecodable session is strictly worse than
        # the stutter it is escaping. The upgrade path consults the same
        # capabilities, and H265 sources route non-H265 browsers to the AV1
        # rendition instead of a black native session.
        run_js_check(self, "abr-switching-state-machine")
        run_js_check(self, "choose-stream-path-matrix")
        app = read_text(APP_PATH)
        self.assertIn("browserSupportsAv1() && av1DecodeSmooth !== false", app,
                      "the ABR downgrade must require real AV1 decode capability")
        self.assertIn("function browserSupportsH265(", app,
                      "H265 receive-capability probe missing")
        self.assertIn("sourceIsH265 && h265Capable === false", app,
                      "H265 sources must be gated on browser decode support")

    def test_connected_black_limbo_recovers(self):
        # A session where the handshake succeeds but no frame ever decodes
        # (publisher vanished mid-handshake, undecodable codec) hangs black
        # forever: the freeze watchdog needs bytes flowing AND a decoded
        # frame to fire. The stats loop must detect the limbo and rejoin,
        # capped so a genuinely broken broadcast cannot loop forever.
        app = read_text(APP_PATH)
        self.assertIn("noMediaRejoinCount", app, "limbo rejoin counter missing")
        self.assertIn("decoded === 0 && performance.now() - connectionStartTime > 10000", app,
                      "limbo detection (no frame 10s after connect) missing")
        self.assertIn("No video arrived on this session", app,
                      "limbo rejoin viewer message missing")

    def test_freeze_recovery_stages_cannot_wedge_on_a_dead_session(self):
        # player.play() stays pending forever on a session with no media;
        # awaiting it unconditionally in the recovery stages wedges recovery
        # with isRecovering stuck true, disabling the watchdog. Stage 2 must
        # also prove it restored playback instead of skipping stage 3.
        app = read_text(APP_PATH)
        self.assertIn("Promise.race([", app,
                      "recovery stages must be time-bounded against pending play() promises")
        self.assertIn("Stage 2 flush did not restore playback", app,
                      "stage 2 must escalate to the full session renewal when the flush fails")

    def test_ice_candidate_errors_are_surfaced(self):
        # A network that blocks STUN/TURN loops connecting->offline with no
        # explanation; onicecandidateerror is the only place the cause is
        # visible. It must be wired, deduped, and reported in diagnostics.
        app = read_text(APP_PATH)
        self.assertIn("onicecandidateerror", app, "ICE candidate error handler missing")
        self.assertIn("iceErrorNoticed", app, "candidate-error dedupe missing")
        self.assertIn("iceCandidateError: iceErrorNoticed", app,
                      "the diagnostic export must report candidate errors")

    def test_decode_lag_state_machine(self):
        run_js_check(self, "decode-lag-state-machine")

    def test_decode_pressure_switching(self):
        run_js_check(self, "decode-pressure-switching")

    def test_hidden_tab_return_recovers_playout_delay(self):
        run_js_check(self, "catch-up-arms-on-visibility-return")

    def test_receiver_anti_drop_hardening_is_present(self):
        # Latency is explicitly traded for smoothness in this project: the
        # playout floor grows with measured jitter (late frames left
        # under-buffered are what a viewer sees as "frame drops"), drift
        # limits are per-mode, ABR switches stressed viewers onto the
        # low-bitrate rendition, and the HUD distinguishes decoded frames
        # from actually rendered frames.
        app = read_text(APP_PATH)
        self.assertIn("function jitterBufferFloorMs(", app, "jitter-proportional floor missing")
        self.assertIn("jitterFloorEmaMs = jitterBufferFloorMs(",
                      app, "floor must be updated from the stats loop")
        self.assertIn("target = Math.max(target, jitterFloorEmaMs);",
                      app, "floor must feed the playout target")
        self.assertIn("driftLimitMs", app, "per-mode drift limits missing")
        self.assertIn("function switchRendition(", app, "ABR switch helper missing")
        self.assertIn("startRenditionPathsPoll();",
                      app, "the connected-state ladder poll must be armed on connect")
        self.assertIn("lighter rendition", app, "ABR downgrade viewer message missing")
        self.assertIn("metadata.presentedFrames", app, "presented-frames counter missing")
        self.assertIn("updateDecodeLag", app, "decode-pressure state machine missing")
        self.assertIn("hardware-decodable path for smooth playback", app,
                      "decode-pressure viewer message missing")
        self.assertIn("fps rendered", app, "HUD render-rate readout missing")


class ChatFeatureChecks(_SiteUnderTest):
    def test_chat_broadcast_between_multiple_clients(self):
        self.start_site()
        # Connect client B to SSE stream
        conn_b = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn_b.request("GET", "/stream-api/chat/events")
        res_b = conn_b.getresponse()
        self.assertEqual(res_b.status, 200)
        self.assertIn("text/event-stream", res_b.headers.get("Content-Type", ""))

        # Read the init event from B
        init_event = b""
        while b"\n\n" not in init_event:
            chunk = res_b.fp.readline()
            if not chunk:
                break
            init_event += chunk
        self.assertIn(b"event: init", init_event)

        # Client A sends a message via POST
        status, _, body = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "Hello stream viewers!", "author": "Alice", "clientId": "client-a"}),
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertEqual(data["message"]["text"], "Hello stream viewers!")
        self.assertEqual(data["message"]["author"], "Alice")

        # Client B must receive the broadcast message event!
        b_msg_event = b""
        for _ in range(10):
            line = res_b.fp.readline()
            b_msg_event += line
            if b"\n\n" in b_msg_event:
                if b"event: message" in b_msg_event:
                    break
                b_msg_event = b""
        self.assertIn(b"event: message", b_msg_event)
        self.assertIn(b"Hello stream viewers!", b_msg_event)
        conn_b.close()

    def test_reactions_are_rate_limited_per_ip(self):
        self.start_site()
        codes = []
        for _ in range(12):
            status, _, body = http_request(
                self.port,
                "POST",
                "/stream-api/chat/reactions",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"emoji": "fire", "clientId": "client-a"}),
            )
            codes.append(status)
        self.assertIn(200, codes, "the first reactions must succeed")
        self.assertIn(429, codes, "reactions past the per-IP budget must be rejected")
        # Rejections are JSON with a friendly message, not a stack trace.
        status, _, body = http_request(
            self.port,
            "POST",
            "/stream-api/chat/reactions",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"emoji": "fire", "clientId": "client-a"}),
        )
        self.assertEqual(status, 429)
        self.assertIn(b"slow down", body)

    def test_chat_history_and_validation(self):
        self.start_site()
        # Empty message should be rejected
        status, _, _ = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "   "}),
        )
        self.assertEqual(status, 400)

        # Too long message should be rejected
        status, _, _ = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "x" * 201}),
        )
        self.assertEqual(status, 400)

        # Post a valid message
        status, _, _ = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "Persistent chat note", "author": "Charlie"}),
        )
        self.assertEqual(status, 200)

        # Check GET /stream-api/chat/messages returns the message in history
        status, _, body = http_request(self.port, "GET", "/stream-api/chat/messages")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data.get("ok"))
        texts = [m["text"] for m in data.get("messages", [])]
        self.assertIn("Persistent chat note", texts)

    def test_host_badge_security(self):
        self.start_site()
        # Direct loopback without proxy headers can assume HOST badge
        status, _, body = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "Host greeting", "author": "Host", "badge": "HOST"}),
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["message"]["badge"], "HOST")

        # Remote viewer passing Cf-Connecting-Ip header attempting to spoof HOST badge is forced to USER
        status, _, body = http_request(
            self.port,
            "POST",
            "/stream-api/chat/messages",
            headers={
                "Content-Type": "application/json",
                "Cf-Connecting-Ip": "203.0.113.195",
            },
            body=json.dumps({"text": "Imposter host", "author": "Host", "badge": "HOST"}),
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["message"]["badge"], "USER")

    def test_reactions_endpoint_and_broadcast(self):
        self.start_site()
        # Invalid emoji rejected
        status, _, _ = http_request(
            self.port,
            "POST",
            "/stream-api/chat/reactions",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"emoji": "alien"}),
        )
        self.assertEqual(status, 400)

        # Valid emoji accepted
        status, _, body = http_request(
            self.port,
            "POST",
            "/stream-api/chat/reactions",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"emoji": "fire"}),
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertGreaterEqual(data.get("count", 0), 1)



class StreamingHardeningChecks(unittest.TestCase):
    """Hardening pass: audio-rescue renditions, codec-change re-planning,
    viewer count, route HUD, single-path volume, network-change recovery and
    the server-side SSE/proxy stability work."""

    @classmethod
    def setUpClass(cls):
        cls.app = read_text(APP_PATH)
        cls.html = read_text(HTML_PATH)
        cls.server = read_text(SERVER_PATH)
        cls.bridge = read_text(BRIDGE_PATH)

    def test_bridge_publishes_an_audio_rescue_rendition(self):
        # An RTMP/SRT source carries AAC, which MediaMTX never serves to
        # WebRTC readers: the native path plays VIDEO-ONLY. The bridge must
        # emit a second output with Opus audio so every viewer gets sound.
        self.assertIn("extraOutputs", self.bridge, "audio-rescue output plan missing")
        self.assertIn("function planTargets(", self.bridge, "multi-target helper missing")
        self.assertIn("'-c:v', 'copy'", self.bridge,
                      "the H264 audio-rescue output must copy video (zero GPU cost)")
        self.assertIn("hasAudio && !hasOpusAudio", self.bridge)
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to exercise the bridge plan")
        script = (
            "const b=require('./codec_bridge.js');"
            "const p=b.decideBridge(['MPEG-4 Audio','H264']);"
            "if(!p.extraOutputs||p.extraOutputs.length!==1) throw new Error('missing rescue output');"
            "if(p.extraOutputs[0].target!=='live-h264') throw new Error('wrong rescue target');"
            "if(p.extraOutputs[0].videoArgs.join(' ')!=='-c:v copy') throw new Error('rescue must copy video');"
            "const args=b.buildFfmpegArgs(p);"
            "const line=args.join(' ');"
            "if(!line.includes('rtmp://127.0.0.1:1935/live-av1')) throw new Error('primary output missing');"
            "if(!line.includes('rtmp://127.0.0.1:1935/live-h264')) throw new Error('rescue output missing');"
            "if((line.match(/-map 0:v:0/g)||[]).length!==2) throw new Error('each output needs its own maps');"
            "const q=b.decideBridge(['H264','Opus']);"
            "if(q.extraOutputs) throw new Error('Opus sources must not get a rescue output');"
            "if(b.planTargets(p).join(',')!=='live-av1,live-h264') throw new Error('planTargets wrong');"
            "const r=b.decideBridge(['MPEG-4 Audio','AV1']);"
            "if(!r.extraOutputs||r.extraOutputs[0].target!=='live-av1') throw new Error('AV1-source rescue missing');"
        )
        result = subprocess.run([node, "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_bridge_replans_when_the_source_codec_changes(self):
        # OBS auto-reconnect swaps the publisher without taking the path
        # offline (so the runOnAvailable hook is NOT re-run); a mid-broadcast
        # encoder switch must re-plan the renditions instead of crash-looping
        # on a plan built for the previous codec.
        self.assertIn("source codec changed", self.bridge, "codec-change re-plan missing")
        self.assertIn("function resolveDecodeArgs(", self.bridge,
                      "decode args must be re-derived for the new codec")

    def test_player_routes_viewers_to_the_audio_rescue_rendition(self):
        self.assertIn("hasOpusAudio", self.app, "audio-aware path choice missing")
        self.assertIn("ready('live-h264')", self.app, "audio-rescue rendition check missing")
        self.assertIn("preferNonTranscode", self.app, "ABR upgrade preference missing")

    def test_player_abr_covers_the_audio_rescue_path(self):
        self.assertIn("onFullBitratePath", self.app,
                      "ABR must be able to step down from the audio-rescue path too")

    def test_server_sse_hardening_is_present(self):
        # id: lines let a native EventSource reconnect replay exactly the
        # missed messages through the server's Last-Event-ID support.
        self.assertIn("id: ${eventId}", self.server, "SSE event ids missing")
        self.assertIn("broadcastChatEvent('message', message, message.id)", self.server)
        # A subscriber that stops reading is destroyed instead of buffering
        # unbounded memory server-side.
        self.assertIn("_slowWrites", self.server, "SSE backpressure guard missing")
        # The per-IP rate-limit map is swept of expired entries.
        self.assertIn("chatRateLimits.delete(ip)", self.server, "rate-limit sweep missing")
        # The proxy reuses pooled keep-alive connections to MediaMTX.
        self.assertIn("new http.Agent({ keepAlive: true", self.server, "keep-alive agent missing")
        self.assertIn("agent: MEDIAMTX_AGENT", self.server)

    def test_server_reports_an_occupied_port_clearly(self):
        self.assertIn("EADDRINUSE", self.server, "occupied-port handler missing")

    def test_player_volume_is_controlled_exactly_once(self):
        # The WebAudio graph taps the element AFTER its volume property, so
        # driving both controls attenuates twice (slider 50% played at 25%).
        self.assertIn("lastVolumeMultiplier", self.app, "single-path volume state missing")
        self.assertGreaterEqual(self.app.count("player.volume = 1.0;"), 2,
                                "element volume must be released when the GainNode carries the multiplier")

    def test_network_change_reestablishes_the_session(self):
        self.assertIn("navigator.connection", self.app, "network-change listener missing")
        self.assertIn("lastNetworkType", self.app, "interface-type change detection missing")

    def test_hud_shows_the_selected_ice_route(self):
        self.assertIn('id="hud-route"', self.html, "route HUD item missing")
        self.assertIn("getElementById('hud-route')", self.app)
        self.assertIn("relay (TURN)", self.app, "relay route label missing")

    def test_diagnostic_report_includes_route_and_recovery(self):
        self.assertIn("iceRoute: lastRouteText", self.app)
        self.assertIn("recovery: lastRecoveryCounts", self.app)
        self.assertIn("pliCount", self.app, "PLI recovery counters missing")

    def test_chat_dedupe_memory_is_capped(self):
        self.assertIn("seenMessageIds.size > 500", self.app,
                      "marathon sessions must not grow the dedupe set without bound")

    def test_ice_prefetch_and_candidate_pool(self):
        self.assertIn("prefetchIceServers();", self.app, "startup ICE prefetch missing")
        # iceCandidatePoolSize was asserted here for years and removed by an
        # audit round, correctly: the pool belongs to the RTCPeerConnection
        # being created and is discarded with it, so it can never accelerate the
        # NEXT connection — and Chrome dropped candidate-pool support in M80
        # anyway. The comment claiming it "lets the srflx gather of the next
        # connection start early" was simply false. This is the real speedup.
        self.assertNotIn("iceCandidatePoolSize", self.app,
                         "the candidate pool is discarded with its own peer connection and "
                         "cannot help the next one; the ICE prefetch is the actual optimisation")

    def test_switch_cooldown_survives_the_switch_reconnect(self):
        # switchRendition()/maybeRejoinOnReturn() stamp the ABR cooldown anchor
        # and then reconnect through handleConnected -> startTelemetry. If a
        # fresh session wiped that anchor, the 60s cooldown would reopen on the
        # very next stats tick and a link under sustained stress could switch
        # renditions every ~8s — the reconnect storm the cooldown prevents.
        # Runs the REAL startTelemetry() out of app.js in a VM: a genuinely
        # fresh session still starts uncooled, because the anchor is declared
        # as -60000 and any anchor from an earlier session is already older
        # than the cooldown window.
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to exercise startTelemetry")
        script = (
            "const {compileFunction,quietConsole}=require('./js_checks.js');"
            "const NOW=100000;"
            "const sb={performance:{now:()=>NOW},beginStatsLoop(){},hudRoute:{innerText:'x'},"
            "console:quietConsole(),lastRenditionSwitchAt:NOW};"
            "const {fn,sandbox}=compileFunction('startTelemetry',sb);"
            "fn();"
            "if(sandbox.lastRenditionSwitchAt!==NOW){"
            "throw new Error('startTelemetry reset the ABR cooldown anchor to '+sandbox.lastRenditionSwitchAt);}"
            "if(!(NOW-sandbox.lastRenditionSwitchAt<=60000)){"
            "throw new Error('switch cooldown is open again right after a switch');}"
        )
        result = subprocess.run([node, "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_bridge_watchdog_never_kills_through_the_reassigned_child(self):
        # `child` is a main()-scope binding the retry loop reassigns, and the
        # startup phase of the watchdog awaits the control API (up to 3s) before
        # killing. A tick already inside that await resumes after clearInterval()
        # and would kill the NEXT iteration's freshly spawned ffmpeg — counted by
        # the loop as a fast failure (a bogus 24h NVDEC block) and, ten times
        # over, a terminal exit with runOnAvailableRestart: false.
        #
        # This runs the REAL watchdog callback out of codec_bridge.js and lets the
        # retry loop advance `child` while the tick is parked on the await, so the
        # test fails for any variant that re-reads `child` after the await (the
        # original bug) as well as for one that kills nothing at all.
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to exercise the bridge watchdog")
        script = """
        const fs=require('fs'),vm=require('vm');
        const src=fs.readFileSync('codec_bridge.js','utf8');
        const start=src.indexOf('setInterval(async () => {');
        const end=src.indexOf(', RENDITION_WATCHDOG_POLL_MS)',start);
        if(start<0||end<0) throw new Error('watchdog callback not extractable');
        const fnSrc=src.slice(src.indexOf('(',start)+1,end);
        const mk=()=>({_progressSeen:true,_lastProgressAt:0,killed:0,kill(){this.killed++;}});
        // A: the child this tick judged, already dead. B: the child the retry
        // loop spawns while the tick waits on the control API.
        async function tick({respawnDuringAwait}) {
          const A=mk(),B=mk();
          const sb={child:A,watchdogKilled:false,renditionEverReady:false,
            startedAt:Date.now()-60000,RENDITION_START_TIMEOUT_MS:20000,
            RENDITION_STALL_TIMEOUT_MS:15000,planTargetList:['live-av1'],
            logError(){},Date,
            renditionHasVideo: async()=>{ if(respawnDuringAwait) sb.child=B; return false; }};
          const fn=vm.runInNewContext('('+fnSrc+')',vm.createContext(sb));
          await fn();
          return {A,B};
        }
        (async()=>{
          const raced=await tick({respawnDuringAwait:true});
          if(raced.A.killed!==1) throw new Error('watchdog did not kill the hung child it judged (A.killed='+raced.A.killed+')');
          if(raced.B.killed!==0) throw new Error('watchdog killed the NEXT iteration\\'s ffmpeg after resuming from the await');
          const solo=await tick({respawnDuringAwait:false});
          if(solo.A.killed!==1) throw new Error('watchdog kills nothing when no respawn races it');
          console.log('ok');
        })();
        """
        result = subprocess.run([node, "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)

    def test_switch_cooldown_is_only_stamped_never_reset(self):
        # Closes the relocation bypass: the cooldown anchor must be assigned at
        # its declaration and by the two functions that deliberately switch
        # (switchRendition, maybeRejoinOnReturn) and nowhere else. A reset
        # smuggled into startTelemetry() OR beginStatsLoop() — which
        # startTelemetry() also calls, and which the tab-resume path calls
        # directly — would reopen the 60s cooldown on the next stats tick.
        self.assertEqual(self.app.count("lastRenditionSwitchAt = "), 3,
                         "lastRenditionSwitchAt must be declared once and stamped by the two "
                         "switch paths, never reset by a session-start routine")
        for name in ("function startTelemetry(", "function beginStatsLoop("):
            at = self.app.index(name)
            self.assertNotEqual(at, -1, f"{name} not found in app.js")
            body = self.app[at:self.app.index("\n    }", at)]
            # Assignment form only: the routines may legitimately mention the
            # anchor in a comment explaining why it is left alone.
            self.assertNotIn("lastRenditionSwitchAt =", body,
                             f"{name} must not reset the ABR switch-cooldown anchor")

    def test_bridge_cleanup_kills_its_own_ffmpeg_but_never_a_recycled_pid(self):
        # Two properties of the runOnUnavailable cleanup, checked together
        # because they constrain each other.
        #
        # (1) The PID record is stamped once, when ffmpeg starts, and never
        #     refreshed, so a "stale record" age gate silently disabled this
        #     cleanup for every broadcast longer than the gate — while
        #     clearPidFile() unlinked the record either way, leaving nothing to
        #     retry with. The record must therefore be cleaned up at ANY age.
        # (2) Dropping that gate is only safe because PID reuse is now decided by
        #     PROCESS age: our ffmpeg is always older than createdAt (stamped just
        #     after spawn), whereas a recycled PID is always newer. The target
        #     substring alone is far too loose to carry that weight — it also
        #     matches an ffplay or a debug command that merely mentions the path.
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to exercise codec_bridge --cleanup")
        if shutil.which("powershell") is None:
            self.skipTest("cleanup kills through PowerShell; not available on this host")
        script = """
        const {spawn,spawnSync}=require('child_process');
        const fs=require('fs'),os=require('os'),path=require('path');
        const PID_FILE=path.join(os.tmpdir(),'rydius_reuse_probe_'+process.pid+'.pid');
        const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
        const alive=(pid)=>{try{process.kill(pid,0);return true;}catch(e){return false;}};
        // olderThanRecordMs>0: the decoy IS the ffmpeg the record describes.
        // <0: the PID was recycled onto a process newer than createdAt.
        async function run(olderThanRecordMs,exe,expectKilled){
          const d=spawn(process.execPath,['-e','setTimeout(()=>{},120000)','live-av1'],{stdio:'ignore'});
          await sleep(800);
          if(!alive(d.pid)) throw new Error('decoy failed to start');
          const rec={pid:d.pid,targets:['live-av1'],createdAt:Date.now()+olderThanRecordMs};
          if(exe) rec.exe=exe;
          fs.writeFileSync(PID_FILE,JSON.stringify(rec));
          spawnSync(process.execPath,['codec_bridge.js','--cleanup'],
            {timeout:30000,env:Object.assign({},process.env,{BRIDGE_PID_FILE:PID_FILE})});
          await sleep(600);
          const wasKilled=!alive(d.pid);
          if(wasKilled){}else{try{process.kill(d.pid);}catch(e){}}
          try{fs.unlinkSync(PID_FILE);}catch(e){}
          await sleep(250);
          if(wasKilled!==expectKilled){
            throw new Error('olderThanRecord='+olderThanRecordMs+' exe='+exe
              +' -> killed='+wasKilled+', expected '+expectKilled);
          }
        }
        (async()=>{
          await run(11*60*1000,'node.exe',true);   // long broadcast: must be killed
          await run(1000,'node.exe',true);        // fresh: must be killed
          await run(-30*60*1000,'node.exe',false); // recycled: must survive
          await run(-30*60*1000,null,false);      // legacy record, no exe: must survive
          await run(1000,'ffmpeg-nvenc.exe',false); // wrong executable: must survive
          console.log('ok');
        })();
        """
        result = subprocess.run([node, "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=180)
        try:
            os.unlink(os.path.join(tempfile.gettempdir(), f"rydius_reuse_probe_{os.getpid()}.pid"))
        except OSError:
            pass
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("ok", result.stdout)


class ViewerCountRuntimeChecks(_SiteUnderTest):
    def test_viewer_count_broadcasts_on_join_and_leave(self):
        self.start_site()

        def read_frame(response, want):
            """Read SSE frames until one contains the wanted bytes."""
            buffer = b""
            for _ in range(20):
                line = response.fp.readline()
                if not line:
                    break
                buffer += line
                if b"\n\n" in buffer:
                    if want in buffer:
                        return buffer
                    buffer = b""
            return buffer

        conn_a = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn_a.request("GET", "/stream-api/chat/events")
        res_a = conn_a.getresponse()
        self.assertEqual(res_a.status, 200)
        init_a = b""
        while b"\n\n" not in init_a:
            chunk = res_a.fp.readline()
            if not chunk:
                break
            init_a += chunk
        self.assertIn(b"event: init", init_a)
        self.assertIn(b'"subscriberCount":1', init_a)

        # Second page subscribes: the first page must learn the new count.
        conn_b = HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn_b.request("GET", "/stream-api/chat/events")
        res_b = conn_b.getresponse()
        init_b = b""
        while b"\n\n" not in init_b:
            chunk = res_b.fp.readline()
            if not chunk:
                break
            init_b += chunk
        self.assertIn(b"event: init", init_b)
        self.assertIn(b'"subscriberCount":2', init_b, "init must include the joining page itself")
        # A's own join already broadcast count:1 - skip it and find B's join.
        join_event = read_frame(res_a, b'"count":2')
        self.assertIn(b'"count":2', join_event, "join must broadcast the new count to existing viewers")

        # Leave: the remaining viewer is told the count dropped.
        conn_b.close()
        leave_event = read_frame(res_a, b'"count":1')
        self.assertIn(b'"count":1', leave_event, "leave must broadcast the dropped count")
        conn_a.close()



class EndToEndBridgeChecks(unittest.TestCase):
    """Opt-in END-TO-END check on the real machine: boots the bundled
    MediaMTX with free ports, lets the runOnAvailable hook launch
    codec_bridge.js for real, publishes a synthetic H264+AAC broadcast with
    the bundled ffmpeg, and verifies both renditions come up (live-av1 with
    NVENC AV1 + Opus, live-h264 with the video-copy audio rescue) — plus
    that the bridge re-fires across an OBS stop/start cycle.

    Runs only when RYDIUS_E2E=1 (it takes ~60s and needs the GPU encoders);
    the default suite stays fast and hermetic.
    """

    def test_bridge_end_to_end_on_real_mediamtx(self):
        if os.environ.get("RYDIUS_E2E") != "1":
            self.skipTest("opt-in: set RYDIUS_E2E=1 to run the ~60s real-MediaMTX bridge check")
        script = ROOT / "e2e_bridge_check.py"
        self.assertTrue(script.is_file(), "e2e_bridge_check.py missing")
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the E2E check")
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=300,
        )
        self.assertEqual(
            result.returncode,
            0,
            "E2E bridge check failed: " + result.stdout[-4000:] + " " + result.stderr[-2000:],
        )


class ViewerSmoothnessRegressionChecks(unittest.TestCase):
    """Regression guards for the viewer-smoothness audit.

    Each test pins a specific defect that was found by inspecting the real code
    (and, where noted, reproduced by running the extracted logic). They exist so
    the fixes cannot silently regress while someone tunes a constant.
    """

    def setUp(self):
        self.app = read_text(APP_PATH)
        self.css = read_text(ROOT / "style.css")
        self.server = read_text(SERVER_PATH)
        self.config = read_text(CONFIG_PATH)
        self.bridge = read_text(BRIDGE_PATH)
        self.launcher = read_text(LAUNCHER_PATH)

    def test_playout_target_uses_only_the_standardized_api(self):
        """`playoutDelayHint` is not a real API and must not be written.

        It is in no W3C Recommendation, no engine IDL (Blink or Gecko) and no
        WPT test — it belonged to an abandoned getPlayoutDelay()/
        setTargetDelay() family. The old fallback branch could never be taken
        and, worse, advertised a compatibility path that does not exist: a
        maintainer reading it would believe non-Chromium receivers were
        covered. `jitterBufferTarget` is the only standardized control, and it
        is in milliseconds.
        """
        code = self._strip_comments(self.app, "js")
        self.assertNotIn("playoutDelayHint", code,
                         "playoutDelayHint does not exist in any browser; do not write it")
        self.assertIn("jitterBufferTarget", code,
                      "the standardized playout-delay control must still be used")
        self.assertIn("clampJitterBufferTargetMs(currentBufferTargetMs())", code,
                      "the write must clamp to the settler's legal range first")

    def test_app_reads_media_time_from_rvfc(self):
        """The rVFC callback must consume metadata.mediaTime, not just presentedFrames.

        `presentedFrames` counts what reached the compositor; `mediaTime` is
        the only field that says how FAST it is being consumed. Without it the
        single most user-reported symptom in this class of bug is structurally
        invisible to the app.
        """
        self.assertIn("metadata.mediaTime", self.app,
                      "the rVFC callback must read mediaTime to measure playback rate")
        self.assertIn("effectivePlaybackRate(", self.app,
                      "the measured rate must go through the smoothing helper")

    def test_stats_loop_reads_the_audio_report(self):
        """The audio inbound-rtp report arrives in the same getStats() walk.

        Filtering on kind === 'video' only threw it away for free. It carries
        totalSamplesDuration (the audio clock), concealmentEvents (audible
        gaps), and insertedSamplesForDeceleration — the UA stretching audio to
        reach the video target, which the code comments reason about at length
        but could not previously observe.
        """
        self.assertIn("report.kind === 'audio'", self.app,
                      "the audio report must be captured from the same stats walk")
        self.assertIn("measureAudioStats(", self.app,
                      "the audio report must actually be consumed")
        self.assertIn("concealmentEvents", self.app,
                      "audio concealment (audible gaps) must be counted")
        self.assertIn("insertedSamplesForDeceleration", self.app,
                      "UA audio stretching must be observable, not just theorised about")

    def test_audio_measurement_is_gated_on_audio_actually_being_pulled(self):
        """Chromium only advances the audio jitter buffer once audio is pulled.

        Before the WebAudio tap is attached, totalSamplesDuration is frozen
        while wall time keeps moving, which would read as an enormous
        audio-clock drift. This is the same class of guard the video
        controllers already apply via document.hidden and player.paused.
        """
        self.assertIn("function audioIsPulled(", self.app,
                      "audio measurement must be gated on audio being pulled")
        body = self.app[self.app.index("function audioIsPulled("):]
        body = body[:body.index("\n    }")]
        self.assertIn("player.paused", body,
                      "a paused viewer does not pull audio")
        self.assertIn("audioSourceNode", body,
                      "audio is not pulled until the WebAudio tap exists")

    def test_granted_target_readback_is_never_a_control_input(self):
        """The read-back observes the controller; it must not drive it.

        If the granted-target gap fed the control law it would close a second,
        faster loop around the very controller it is meant to audit, and a
        transient read would move the buffer. The gap is computed into its own
        state and surfaced in the HUD and the diagnostic export instead.
        """
        code = self._strip_comments(self.app, "js")
        self.assertIn("grantedTargetDeltaMs = grantedTargetGapMs(", code,
                      "the gap must be recorded, not returned into the control law")
        supervisor = code[code.index("function superviseAdaptiveBuffer("):]
        supervisor = supervisor[:supervisor.index("function updateBufferHud(")]
        self.assertNotIn("grantedTargetDeltaMs", supervisor,
                         "the buffer supervisor must not steer on the read-back")
        self.assertNotIn("grantedTargetMs", supervisor,
                         "the buffer supervisor must not steer on the read-back")

    def test_separate_baselines_for_target_and_minimum_delay(self):
        """jitterBufferTargetDelay and jitterBufferMinimumDelay are distinct series.

        Both are cumulative and both are averaged against jitterBufferEmittedCount,
        but differencing one against the other's baseline produces a garbage
        average that can be enormous or negative. The project has already been
        bitten exactly this way once (a cumulative average hiding fresh drift),
        so the baselines are separate by construction.
        """
        self.assertIn("let lastJitterTargetTotal = 0;", self.app)
        self.assertIn("let lastJitterMinTotal = 0;", self.app,
                      "the minimum-delay series needs its own baseline")
        self.assertIn("lastJitterMinTotal", self.app,
                      "the minimum-delay read must use the minimum-delay baseline")

    def test_per_session_measurement_state_is_reset(self):
        """Cumulative counters are per session, not per app load.

        Differencing a carried-over counter against a zero baseline yields one
        enormous first-tick reading. For the audio clock that would look like a
        huge drift, and for the granted target it would look like the UA
        instantly applied a multi-second buffer.

        Scoped to the startTelemetry() body and to the 8-space indent on
        purpose. A bare `f"{state} = "` search is satisfied by the 4-space
        `let` DECLARATION as well as by the reset, so it passes even with the
        entire reset block deleted — a guard that cannot fail.
        """
        body = self.app[self.app.index("function startTelemetry("):]
        body = body[:body.index("\n    function ")]
        for state in ("lastJitterTargetTotal", "lastJitterMinTotal", "grantedTargetMs",
                      "audioStatsReport", "lastAudioSamplesDuration", "audioDriftPpm",
                      "lastMediaTimeSec", "playbackRate"):
            # 8 spaces = the per-session reset inside startTelemetry(), not the
            # 4-space declaration.
            self.assertIn(f"\n        {state} = ", body,
                          f"{state} must be reset when a new session starts")

    @staticmethod
    def _strip_comments(text, kind):
        """Comments explain these fixes by name, so a naive substring check
        would flag the explanation as if it were the defect. Both block and
        line comments are removed.

        The opener must be preceded by whitespace or a line start, otherwise a
        path literal such as '/stream-api/**' contains '/*' and a non-greedy
        match would swallow real code until the next '*/'."""
        opener = r"(?:^|(?<=\s))[ \t]*/\*"
        if kind == "css":
            return re.sub(opener + r".*?\*/", "", text, flags=re.DOTALL | re.MULTILINE)
        without_block = re.sub(opener + r".*?\*/", "", text, flags=re.DOTALL | re.MULTILINE)
        return re.sub(r"(?m)^[ \t]*//.*$", "", without_block)

    @staticmethod
    def _css_rule(css, selector):
        """Return the declaration block of the rule whose selector is exactly
        `selector` at the start of a line. Anchoring matters: several of these
        selectors also appear inside a `body.perf-mode ...` selector list, and
        matching that would assert against the wrong rule."""
        match = re.search(r"(?m)^[ \t]*" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
        return match.group(1) if match else None

    @staticmethod
    def _js_function_body(source, name):
        """Declarations of a `function name(...)` up to the next function at the
        SAME indentation. Matching the sibling indentation (rather than a fixed
        4 spaces) is what lets this work for both app.js, whose declarations sit
        inside the DOMContentLoaded closure, and server.js, whose are top level.
        A `\\n    }` anchor would also end too early, because these functions
        contain nested declarations."""
        start = re.search(r"(?m)^([ \t]*)function " + re.escape(name) + r"\(", source)
        if not start:
            return None
        indent = start.group(1)
        rest = source[start.end():]
        nxt = re.search(r"(?m)^" + re.escape(indent) + r"function ", rest)
        return rest[: nxt.start()] if nxt else rest

    # -- transport ---------------------------------------------------------

    def test_udp_payload_size_does_not_claim_a_fragmentation_fix(self):
        """Regression guard for a RETRACTED claim.

        An earlier version of this test (and of the mediamtx.yml comment) held
        that MediaMTX's 1452-byte default was fragmenting every packet to remote
        viewers because this host's Tailscale adapter reports an MTU of 1280.
        That was measured A/B and is FALSE: with a real 1280x720 H264 publish
        read by real headless Chrome through a real WHEP session, the mean
        inbound video RTP packet size was 901.1-902.1 bytes at 200, at 1200 AND
        at 1452 — the WebRTC path does not read this key at all, it packetizes
        with its own ~1200-byte MTU, which fits a 1280-byte MTU with room to
        spare. There was never fragmentation on the WebRTC path.

        The value stays at 1200 because the key is real and honoured by
        MediaMTX's other RTP consumers, but the config must not assert a
        WebRTC fragmentation fix that was never happening."""
        match = re.search(r"^\s*udpMaxPayloadSize\s*:\s*(\d+)", self.config, re.MULTILINE)
        self.assertIsNotNone(match, "udpMaxPayloadSize must be set explicitly in mediamtx.yml")
        payload = int(match.group(1))
        self.assertLess(payload, 1452, "udpMaxPayloadSize must stay under the MediaMTX default")
        # The comment block for this key must record the measurement and must not
        # re-assert the refuted claim.
        block = self.config[max(0, match.start() - 1600): match.start()]
        self.assertIn("MEASURED", block, "the reasoning for this value must record that it was measured")
        self.assertNotIn("EVERY RTP packet to a remote viewer was split",
                         block,
                         "the refuted IP-fragmentation claim must not be reinstated")

    def test_write_queue_does_not_disconnect_a_congested_viewer(self):
        """A reader queue is the only thing between a brief congestion event
        and a hard disconnect. Keep the tuning, and keep the comment honest
        about the packet size actually in use."""
        self.assertIn("writeQueueSize: 2048", self.config)
        # The comment claimed "2048 packets ~= 2.4s at 6 Mbps" while the packet
        # size in the same file was 1452 (4.0s). The claim is only true at the
        # size actually configured now.
        self.assertIn("1200", self.config)

    def test_bridge_can_restart_itself_when_media_returns(self):
        self.assertIn("runOnAvailableRestart: true", self.config,
                      "an exited bridge must be re-run, or its rendition is dead for the whole broadcast")

    def test_bridge_failure_budget_is_consecutive_not_cumulative(self):
        """Ten unrelated ffmpeg exits spread over a long broadcast must not
        eventually trip the cap and kill the rendition permanently."""
        self.assertIn("MAX_CONSECUTIVE_FFMPEG_FAILURES", self.bridge)
        self.assertRegex(
            self.bridge, r"if \(runSeconds >= 30\) \{\s*\n\s*failures = 0;",
            "a long healthy run must clear the consecutive-failure counter")

    def test_stall_watchdog_uses_published_bytes_not_ffmpeg_stderr(self):
        """ffmpeg emits its 'frame=' stats line at AV_LOG_INFO and the bridge
        runs at -loglevel warning, so a stderr-gated mid-broadcast watchdog can
        never fire at all. The signal must be the control API's byte counter,
        and a single slow read must not kill a healthy transcoder."""
        self.assertIn("-loglevel', 'warning", self.bridge)
        self.assertNotIn("_progressSeen", self.bridge,
                         "dead stderr progress gating must not come back")
        self.assertIn("renditionBytesIngested", self.bridge)
        self.assertIn("bytesReceived", self.bridge)
        self.assertIn("stalledSamples", self.bridge)
        self.assertIn("n !== lastBytesSeen", self.bridge,
                      "a counter DECREASE means a new publisher connected, not a stall; only an "
                      "unchanged value is evidence of one")
        self.assertNotIn("targetPath.bytesSent", self.bridge,
                         "bytesSent is EGRESS to readers; using it inverts the watchdog")

    def test_opus_rescue_corrects_timestamps(self):
        self.assertIn("aresample=async=1", self.bridge,
                      "a drifting audio clock makes the browser nudge playbackRate forever")

    # -- compositing / render path ----------------------------------------

    def test_nothing_animates_on_the_video_surface(self):
        """The video container's box IS the video texture. Animating anything on
        it repaints a video-sized layer every frame for the whole session, and
        will-change: transform on the video's parent is the documented way to
        pull it off the hardware-overlay path."""
        css = self._strip_comments(self.css, "css")
        body = self._css_rule(css, ".video-container")
        self.assertIsNotNone(body, ".video-container rule not found")
        self.assertNotIn("animation:", body,
                         ".video-container must not animate anything (border-breathe "
                         "was a full-video-sized repaint every frame)")
        self.assertNotIn("will-change", body,
                         "will-change on the video's parent costs the hardware overlay path")
        self.assertNotIn("@keyframes border-breathe", css)
        self.assertNotIn("@keyframes drift", css)

    def test_ambient_backdrop_is_static_so_blurs_can_be_cached(self):
        """Three surfaces carry a backdrop-filter over the ambient orbs. While
        the orbs animated, every one of those re-ran a Gaussian blur on every
        decoded frame. Frozen orbs let the compositor cache the result."""
        body = self._css_rule(self._strip_comments(self.css, "css"), ".ambient-orb")
        self.assertIsNotNone(body, ".ambient-orb rule not found")
        self.assertIn("animation: none", body,
                      "the orb backdrop must be static or the blurs above it recompute every frame")

    def test_no_backdrop_filter_sits_over_live_video(self):
        """Autoplay is only permitted muted, so the unmute overlay is on screen
        for the whole session by default. A backdrop-filter directly over the
        video forces a render surface and a per-frame sample of that texture."""
        css = self._strip_comments(self.css, "css")
        for selector in (".unmute-btn", ".action-feedback", ".volume-toast"):
            body = self._css_rule(css, selector)
            self.assertIsNotNone(body, "{} rule not found".format(selector))
            self.assertNotIn("backdrop-filter: blur", body,
                             "{} is drawn over live video and must not blur it".format(selector))

    def test_idle_video_overlays_leave_the_render_tree(self):
        """opacity:0 still keeps an element in the render tree. These two are
        idle for an entire session between gestures."""
        css = self._strip_comments(self.css, "css")
        for selector in (".action-feedback", ".volume-toast"):
            body = self._css_rule(css, selector)
            self.assertIn("visibility: hidden", body,
                          "{} must be hidden with visibility, not only opacity".format(selector))

    def test_reaction_overlay_density_is_bounded(self):
        """Every accepted reaction is broadcast to every viewer, where it becomes
        an animated layer over live video. Aggregate rate is per-viewer rate x
        viewer count, so it must be bounded globally and per client."""
        self.assertIn("MAX_FLYING_EMOJI", self.app,
                      "concurrent reaction layers over the video must be capped")
        self.assertIn("REACTION_GLOBAL_CAP_PER_SEC", self.server,
                      "aggregate reaction broadcast rate must be capped regardless of viewer count")
        body = self._css_rule(self._strip_comments(self.css, "css"), ".flying-emoji")
        self.assertIsNotNone(body, ".flying-emoji rule not found")
        self.assertNotIn("drop-shadow", body,
                         "a filter on a promoted layer over video forces its own render pass")

    # -- player control loop ----------------------------------------------

    def test_playout_target_writes_are_rate_limited(self):
        """Every jitterBufferTarget write re-paces the browser's playout, so an
        unguarded 25-50ms step per tick is a per-second re-pace forever."""
        self.assertIn("BUFFER_TARGET_BAND_MS", self.app, "a hysteresis band is required")
        self.assertIn("BUFFER_TARGET_DWELL_MS", self.app, "a dwell between applied changes is required")
        self.assertIn("recentDropAt", self.app,
                      "a protective raise while frames are actually dropped must stay instant")

    def test_stress_raise_is_a_hold_not_a_countdown(self):
        """A wall-clock stamp expiring after 15s produced a proven square wave
        on a continuously marginal link: 350ms for 15s, 180ms for 7s, five
        target steps per minute, forever, on a link that never went calm."""
        code = self._strip_comments(self.app, "js")
        self.assertNotIn("adaptiveRaiseUntil", code,
                         "the stress raise must be a level, not an expiring timestamp")
        self.assertIn("adaptiveRaiseLevelMs", code)

    def test_drift_rejoin_requires_a_fresh_measurement(self):
        """avgPlayoutDelayMs latches when a window produces no measurement, so
        three ticks containing zero new readings used to satisfy the
        confirmation and force a 2-4s hard teardown of a healthy session."""
        self.assertIn("avgPlayoutDelayAt", self.app)
        self.assertIn("driftReadingIsFresh", self.app)

    def test_return_from_hidden_tab_does_not_rejoin_on_one_reading(self):
        """A normal Alt-Tab measures 1.7-2.8s, within 300ms of the 3.1s trip
        point, so a single-reading decision could end in a hard freeze."""
        self.assertIn("returnDriftChecks", self.app)
        self.assertIn("returnDriftChecks >= 3", self.app)

    def test_playout_target_is_not_pushed_to_the_audio_receiver(self):
        """For synchronized tracks the UA SHOULD use the larger of the two
        JitterBufferTargets for BOTH, so a video-scale target on the audio
        receiver stretches audio instead of containing itself."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "reapplyBufferTargets")
        self.assertIsNotNone(body, "reapplyBufferTargets not found")
        self.assertIn("kind === 'video'", body)
        # Every remaining call site must be guarded the same way: the ontrack
        # hook and the manual-mode override are separate from the supervisor.
        for anchor in ("applyPlayoutDelay(event.receiver, event.track.kind)",
                       "applyPlayoutDelay(r, 'video')"):
            for match in re.finditer(re.escape(anchor), code):
                guard = code[max(0, match.start() - 120): match.start()]
                self.assertIn("kind === 'video'", guard,
                              "{} must be guarded to video receivers only".format(anchor))
        self.assertNotIn("applyPlayoutDelay(r, r.track ? r.track.kind : 'media')", code,
                         "the manual-mode override must not push to the audio receiver either")

    def test_buffer_target_is_not_latched_before_it_is_written(self):
        """Latching first meant a mid-reconnect receiver list left the app
        believing it had granted a target it never did, so it never retried and
        every downstream decision regulated against a fiction."""
        body = self._js_function_body(self.app, "reapplyBufferTargets")
        guard = body.index("if (applied === 0) return false;")
        latch = body.index("lastAppliedTargetMs = targetMs;")
        self.assertLess(guard, latch,
                        "the change latch must be written only after a receiver accepted the target")

    def test_accommodation_uses_an_independent_late_frame_signal(self):
        """The measured delay is a mean over the frames that LEFT the jitter
        buffer, so late-discarded frames are excluded from numerator and
        denominator alike. Gating the anti-stutter raise on it made the
        mechanism structurally unreachable on a slow link."""
        self.assertIn("lateFrameEvidence", self.app)
        self.assertIn("droppedDelta > 0 || lateFrameEvidence", self.app)

    def test_hidden_span_does_not_drive_the_accommodation(self):
        """The stats loop sleeps while hidden, so the first tick after a tab
        return spans the whole hidden span. Acting on it snapped the
        accommodation to its cap and left it inert for the rest of the session."""
        code = self._strip_comments(self.app, "js")
        # The flag is read TWICE in one stats tick: once to seed the rolling drop
        # window, and again ~100 lines later to decide whether the accommodation
        # controller may act. The first read CLEARS it, so the second is
        # statically always false and the tab-return re-baseline is dead code —
        # the guard's own comment describes the exact damage it prevents. The
        # intent must be captured once, before the clear.
        self.assertIn("const rebaseThisTick = dropTickPending;", code,
                      "the re-baseline intent must be captured before the flag is cleared")
        self.assertRegex(code, r"const rebaseThisTick = dropTickPending;\s*\n\s*if \(dropTickPending\) \{\s*\n\s*dropTickPending = false;",
                         "the alias must be taken before the clear, not after")
        idx = code.find("const lateFrameEvidence")
        self.assertGreater(idx, 0, "the late-frame evidence signal was not found")
        window = code[max(0, idx - 1500): idx + 1200]
        guard = window.find("if (rebaseThisTick) {")
        self.assertGreater(guard, -1,
                           "the accommodation must be gated on the CAPTURED intent, not on the cleared flag")
        self.assertIn("accommodationCalmTicks", window[guard:guard + 200],
                      "the hidden-span branch must re-baseline the accommodation")
        self.assertIn("bufferAccommodationMs", window[guard:],
                      "the accommodation update must be in the ELSE of that branch")

    def test_freeze_watchdog_does_not_walk_the_stats_graph_twice(self):
        """getStats() walks every RTP report and allocates a fresh report set.
        Doing it 1.67x per second is avoidable main-thread work on exactly the
        low-end receivers this code protects."""
        body = self._js_function_body(self._strip_comments(self.app, "js"), "startFreezeWatchdog")
        self.assertIsNotNone(body, "startFreezeWatchdog not found")
        self.assertNotIn("getStats()", body,
                         "the freeze watchdog must reuse the stats loop's snapshot")
        self.assertIn("inboundSnapshot", body)
        self.assertIn("INBOUND_SNAPSHOT_MAX_AGE_MS", self.app,
                      "a stale snapshot must be rejected rather than read as 'no progress'")

    def test_level_meter_cannot_spin_at_display_rate(self):
        """A style.width write per frame invalidates layout, and rAF callbacks
        are scheduled in the same frame update that presents the video."""
        self.assertIn("AUDIO_METER_INTERVAL_MS", self.app,
                      "the level meter must be sampled at a bounded rate")
        self.assertIn("renderAudioMeter", self.app,
                      "the meter must only write when the rounded value changes")
        body = self._js_function_body(self.app, "startAudioMeter")
        self.assertIn("stopAudioMeterLoop();", body,
                      "the meter must stop when there is nothing to measure")
        self.assertNotIn("hudAudioLevel.style.width = '0%';", body,
                         "the idle branch must not write layout every frame")

    def test_auto_eco_mode_is_not_permanently_disabled_by_the_toggle(self):
        """A stored '0' (Turbo GPU) is not a request to stutter through a
        measured drop storm, and it used to veto the relief forever."""
        body = self._js_function_body(self.app, "maybeAutoPerfMode")
        self.assertIsNotNone(body, "maybeAutoPerfMode not found")
        self.assertIn("storedPerfChoice === '1'", body,
                      "only an explicit Eco choice may veto the relief")
        self.assertNotIn("storedPerfChoice !== null", body,
                         "any prior toggle click must not permanently disable the relief")

    def test_stage_two_recovery_cannot_freeze_a_marginal_link_repeatedly(self):
        """Reassigning srcObject tears down and rebuilds the media pipeline, so
        it guarantees a freeze. Run on every watchdog trip it made a marginal
        link stutter on top of whatever it was already struggling with."""
        self.assertIn("stage2AttemptedThisSession", self.app)
        self.assertIn("!stage2AttemptedThisSession", self.app)

    def test_degradation_preference_pins_picture_detail(self):
        """The default 'balanced' lets Chrome trade resolution away silently;
        on a live stream the picture just gets softer and no controller can see
        it, because nothing is lost — the frames are only smaller."""
        self.assertIn("degradationPreference", self.app)
        self.assertIn("maintain-resolution", self.app)

    # -- signaling ---------------------------------------------------------

    def test_keep_alive_outlives_the_client_poll_cadence(self):
        """Node's default is 5s and the player polls every 5s, so pooled
        sockets were torn down in a race with the next request. A WHEP
        handshake is a POST, which browsers do not reliably retry on a reused
        socket -> failed handshake -> visible freeze on a healthy link."""
        self.assertIn("server.keepAliveTimeout = 65000", self.server)
        self.assertIn("server.headersTimeout = 66000", self.server)

    def test_forwarded_headers_are_only_trusted_behind_the_tunnel(self):
        """x-forwarded-for is attacker-controlled. A unique value per request
        is a unique rate-limit key per request, so the per-IP reaction limit
        could be bypassed outright and the map could be filled with one entry
        per spoofed string."""
        self.assertIn("TRUST_FORWARDED_HEADERS", self.server)
        self.assertIn("clientIpForRateLimit", self.server)
        self.assertNotIn("req.headers['x-forwarded-for'] || (req.socket", self.server,
                         "an unvalidated x-forwarded-for must not be a rate-limit key")

    def test_sse_backpressure_counts_real_queue_depth(self):
        """write()===false only trips once Node's own 16KB highWaterMark is
        exceeded, which cannot happen until the kernel socket buffer is already
        full. Measured: 6000 events (~1.2MB) produced zero false returns, so the
        old consecutive-false counter never tripped at all. The guard must read
        the stream's own queue depth instead."""
        broadcast = self._js_function_body(self._strip_comments(self.server, "js"),
                                           "broadcastChatEvent")
        self.assertIsNotNone(broadcast, "broadcastChatEvent not found")
        self.assertIn("writableLength", broadcast,
                      "the guard must use the stream's real queue depth")
        self.assertIn("SSE_MAX_QUEUED_BYTES", self.server)

    def test_304_advertises_the_encoding_it_was_served_with(self):
        # A 304 that omits Vary can let a shared cache hand a gzip body to a
        # client that never advertised gzip — a hard decode error.
        start = self.server.find("writeHead(304")
        self.assertGreater(start, 0, "the 304 branch was not found")
        branch = self.server[start:start + 900]
        self.assertIn("Vary': 'Accept-Encoding", branch,
                      "the 304 response must carry the same Vary the 200 does")

    def test_launcher_refuses_a_stale_mediamtx_instance(self):
        """The launcher reused a running MediaMTX without comparing config, so
        editing a tuning knob and re-running was a silent no-op — the exact
        failure mode of a 'tuned' setting that does nothing."""
        self.assertIn("/v3/config/global/get", self.launcher)
        self.assertIn("DIFFERENT configuration", self.launcher)
        for key in ("writeQueueSize", "udpReadBufferSize", "udpMaxPayloadSize", "logLevel"):
            self.assertIn(key, self.launcher,
                          "{} must be compared before reusing a running instance".format(key))


    def test_sse_backpressure_uses_the_stream_not_a_running_total(self):
        """A hand-rolled running byte total is the wrong instrument here, and was
        actively destructive: `drain` only fires after a write() has previously
        returned false, so a HEALTHY reader never drains, never resets, and the
        accumulator climbs forever. Real payload 173 bytes -> destroyed after
        ceil(262144/173) = 1516 events (~1.2h of busy chat), for every viewer at
        once, each then auto-reconnecting. `writableLength` is the stream's own
        count of what is still queued and falls back to 0 by itself."""
        broadcast = self._js_function_body(self.server, "broadcastChatEvent")
        self.assertIsNotNone(broadcast, "broadcastChatEvent not found")
        self.assertIn("writableLength", broadcast,
                      "the backpressure guard must use the stream's own queue depth")
        self.assertNotIn("_queuedBytes", broadcast,
                         "a cumulative byte counter destroys healthy subscribers; it must not come back")
        self.assertNotIn("+ Buffer.byteLength(payload)", broadcast)
        # The slow-reader flag must be able to recover rather than latch dark.
        self.assertIn("_lagging = false", self.server)
        self.assertIn("res.on('drain'", self.server)
        self.assertIn("_lagSince", self.server,
                      "a subscriber that never recovers must be closed so the browser reconnects")

    def test_audio_rescue_preserves_the_source_av_offset(self):
        """`first_pts=0` does not tidy a timeline, it drags the audio track onto
        the video track's head. Measured with the bundled ffmpeg on a source
        whose audio starts 279ms after its video: the shipped filter turned that
        into -7ms (destroyed, sign flipped) while plain async=1 preserved it at
        +294ms. A viewer sees a permanent lip-sync error they report as "janky
        video"."""
        bridge = self._strip_comments(self.bridge, "js")
        self.assertIn("aresample=async=1", bridge,
                      "the Opus rescue must resample asynchronously to stop A/V drift")
        self.assertNotIn("first_pts", bridge,
                         "first_pts re-bases audio onto the video head and destroys the source A/V offset")

    def test_a_suspended_audio_context_recovers_by_itself(self):
        """Once createMediaElementSource is attached the element's audio is
        rendered by the WebAudio graph, so a later suspension (device change,
        headset connect, audio service restart) is permanent silence — the
        gesture listeners that would otherwise rescue it have already removed
        themselves. A suspended context does not stall the video, so this is
        invisible in the video path."""
        self.assertIn("audioCtx.onstatechange", self.app,
                      "a context that suspends after wiring must be resumed, not left silent")
        self.assertIn("audioCtx.resume().catch", self.app)

    def test_sfx_nodes_are_released_and_voices_capped(self):
        """Each effect is an OscillatorNode -> GainNode pair connected to the
        destination: a connected subgraph anchored on a long-lived node, which
        is not the shape WebAudio's collector reclaims cheaply. Measured: 200
        calls created 400 nodes and disconnected 0. playSfx fires on every
        incoming reaction, so the churn is continuous during a hype train."""
        sfx = self._js_function_body(self.app, "playSfx")
        self.assertIsNotNone(sfx, "playSfx not found")
        self.assertIn("disconnect()", sfx, "SFX nodes must be explicitly disconnected")
        self.assertIn("onended", sfx, "release must be tied to the oscillator ending")
        self.assertIn("MAX_SFX_VOICES", self.app, "concurrent SFX voices must be capped")

    def test_aborted_whep_post_runs_a_real_teardown(self):
        """The AbortError branch must not merely clear isConnecting.

        The 16s connectTimeout is gated on `isConnecting && !isConnected`, and
        only handleDisconnected() re-arms the status poll. Clearing the flag
        alone left a hung-POST attempt with no watchdog, no cleanupConnection
        (PeerConnection still open and gathering, no WHEP DELETE ever sent) and
        no retry — measured as still "connecting" after 60s with 1 POST, 0
        DELETEs and zero pending timers. That regression was introduced by an
        earlier fix in this same file, which is exactly why it is pinned."""
        code = self._strip_comments(self.app, "js")
        start = code.find("error.name === 'AbortError'")
        self.assertGreater(start, 0, "the AbortError branch was not found")
        # Take a generous window: the branch contains a nested guard, so a
        # brace-matching regex would stop at the wrong one.
        body = code[start:start + 1200]
        self.assertIn("handleDisconnected()", body,
                      "an aborted WHEP POST must run the real teardown, not just clear a flag")
        self.assertNotRegex(body, r"isConnecting = false;\s*\n\s*return;",
                            "clearing the flag and returning is the bug: it disables the watchdog "
                            "and never re-arms the poll")
        self.assertIn("superseded()", body,
                      "a superseded attempt must not paint the page offline behind the live session")

    def test_connect_watchdog_covers_ice_separately_from_signaling(self):
        """The watchdog used to be armed before signaling and only cleared on
        connect, so it had to cover 2.5s ICE fetch + 3s gather + up to 10s WHEP
        POST = 15.5s of a 15s budget, leaving 0.5s for the actual ICE
        connection. A remote or relayed viewer that would connect at 16s was
        torn down at 15s, and every retry repeated it — it could never play.
        LAN viewers connect in ~50ms and never saw it."""
        code = self._strip_comments(self.app, "js")
        self.assertGreaterEqual(code.count("connectTimeout = setTimeout"), 2,
                                "the ICE window needs its own watchdog, re-armed after the answer")
        tail = code.rfind("setRemoteDescription")
        after = code[tail:tail + 2000]
        self.assertIn("connectTimeout", after,
                      "the ICE-only watchdog must be armed after the answer is applied")

    def test_offer_is_not_sent_before_a_routable_candidate_exists(self):
        """WHEP is non-trickle, so whatever candidates exist when the POST goes
        out are the only ones the server gets. This page never calls
        getUserMedia, so Chrome mDNS-obfuscates host candidates as *.local, and
        MediaMTX (Pion) resolves no mDNS — an offer carrying only those has
        nothing to connect to. A fixed 3s deadline POSTed exactly that on the
        networks the code itself diagnoses as blocking UDP STUN, and a `turns:`
        relay needing >3s to allocate was cut off the same way."""
        code = self._strip_comments(self.app, "js")
        self.assertIn("hasRoutableCandidate", code,
                      "the gather window must wait for a usable candidate, not just a deadline")
        self.assertIn(".local", code, "mDNS-obfuscated candidates must be recognised and waited past")
        window = re.search(r"const hasRoutableCandidate = \(\) => \{(.*?)\n            \};",
                           code, re.DOTALL)
        self.assertIsNotNone(window, "hasRoutableCandidate was not found")
        self.assertIn("a=candidate:", window.group(1),
                      "the routability check must actually inspect the SDP candidates")
        self.assertIn(".local", window.group(1),
                      "mDNS-obfuscated candidates must be recognised as NOT routable")
        # ORDER: the gather cap must be armed BEFORE the first poll call. The
        # poll's guard tests `gatherTimeout === null` to know the window is open,
        # so priming the poll first made it return immediately and never
        # reschedule — the whole routable-candidate path was dead code and the
        # window silently degraded to "gathering complete or the cap". This is
        # the same class of bug pass 2 already found once (a flag cleared before
        # its second reader), so it is pinned explicitly.
        armed = code.find("gatherTimeout = setTimeout(() => finish('6s cap reached')")
        polled = code.find("pollRoutable();", armed - 600 if armed > 0 else 0)
        self.assertGreater(armed, 0, "the gather cap is missing")
        self.assertGreater(polled, 0, "the routable poll is never started")
        self.assertLess(armed, polled,
                        "the gather cap must be armed before pollRoutable() is first called, "
                        "or the poll's `gatherTimeout === null` guard kills the loop on tick one")

    def test_rtcp_fb_collection_is_scoped_to_the_video_section(self):
        """The collection pass swept the WHOLE document while the injection pass
        was section-scoped, so a payload type also present in m=audio was
        recorded as already having feedback and the video section silently kept
        only what audio declared — reproduced with a colliding fixture, where
        the video came out with nack pli and goog-remb but NO nack, i.e. no
        retransmission at all."""
        code = self._strip_comments(self.app, "js")
        collect = re.search(r"presentFeedback = new Set\(\);(.*?)\}\)\(\);", code, re.DOTALL)
        self.assertIsNotNone(collect, "the scoped collection pass was not found")
        self.assertIn("inVideo", collect.group(1),
                      "the collection pass must be scoped to the video section, like the injection pass")

    def test_teardown_clears_every_peer_connection_handler(self):
        """onicecandidateerror was the one handler missing from the teardown
        list. It calls addSystemMessage, so a candidate error from a gathering
        pass still in flight posted a chat warning after the offline banner,
        for a session that no longer existed."""
        teardown = self._js_function_body(self.app, "cleanupConnection")
        self.assertIsNotNone(teardown, "cleanupConnection not found")
        for handler in ("ontrack", "onconnectionstatechange", "oniceconnectionstatechange",
                        "onicegatheringstatechange", "onicecandidate", "onicecandidateerror"):
            self.assertIn(handler + " = null", teardown,
                          "{} must be cleared on teardown".format(handler))

    def test_film_grain_is_one_static_layer_not_a_fixed_overlay(self):
        """The grain used to be a fixed, inset:0 overlay element the compositor
        carried over the ambient stack every frame, at 0.035 opacity, behind the
        app container. It is now painted once into the body background. The
        hazard this guards is a comment that no longer matches the code: an
        earlier revision claimed the data-URI had been relocated while it had in
        fact been deleted outright."""
        css = self._strip_comments(self.css, "css")
        self.assertEqual(css.count("feTurbulence"), 1,
                         "the grain must exist exactly once; 0 means it was dropped, "
                         "2 means the overlay and the body both paint it")
        noise = self._css_rule(css, ".noise-overlay")
        self.assertIsNotNone(noise, ".noise-overlay rule not found")
        self.assertIn("display: none", noise,
                      "the fixed overlay element must be removed from the render tree")
        self.assertNotIn("background-image", noise,
                         "the overlay must not keep painting the grain as a layer")
        body = re.search(r"(?m)^body\s*\{([^}]*)\}", css)
        self.assertIsNotNone(body, "no body rule found")
        self.assertIn("feTurbulence", body.group(1),
                      "the grain must be relocated onto the body background")

    def test_relocated_grain_keeps_its_low_alpha(self):
        """Moving the grain off the fixed overlay and onto the body background
        dropped its alpha on the way: a background-image cannot be faded from
        CSS — there is no background-opacity — so the byte-identical data-URI
        painted at FULL strength and the whole page rendered as visible TV
        static behind the player. Nothing about the relocation was visible in a
        test, and the comment above the rule even claimed the 0.035 had come
        along, so the grain has to carry its own alpha inside the SVG now."""
        css = self._strip_comments(self.css, "css")
        body = re.search(r"(?m)^body\s*\{([^}]*)\}", css)
        self.assertIsNotNone(body, "no body rule found")
        grain = unquote(body.group(1))
        rect = re.search(r"<rect[^>]*>", grain)
        self.assertIsNotNone(rect, "the grain texture no longer has a rect to fade")
        alpha = re.search(r"opacity=[\"']([0-9.]+)[\"']", rect.group(0))
        self.assertIsNotNone(
            alpha, "the grain rect has no opacity; a background-image cannot be "
                   "faded from CSS, so the texture would paint at full strength")
        self.assertLessEqual(
            float(alpha.group(1)), 0.05,
            "the grain alpha is no longer the subtle 0.035 texture it is meant to be")

    def test_eco_mode_still_drops_the_relocated_grain(self):
        """The same relocation silently deleted Eco Mode's grain toggle.
        `body.perf-mode .noise-overlay { display: none }` was dropped along with
        the overlay it targeted, and nothing replaced it: once the grain moved
        onto the body background, hiding an element cannot unset a background
        on an ancestor, so the old selector had become a no-op even if it had
        survived. Eco Mode therefore stopped shedding the one texture it exists
        to shed, with no test failing to say so. The toggle has to be re-issued
        against whichever element actually owns the grain."""
        css = self._strip_comments(self.css, "css")
        perf = self._css_rule(css, "body.perf-mode")
        self.assertIsNotNone(perf, "no body.perf-mode rule found; Eco Mode has lost "
                                   "its ability to drop the body grain")
        self.assertIn("background-image: none", perf,
                      "Eco Mode must unset the grain on the body, which is where "
                      "the relocation put it")

    def test_unmute_prompt_is_hidden_until_the_stream_is_live(self):
        """"Click to unmute" was painted across "Stream is Offline". The grouped
        overlay rule sets display:flex for all three player overlays and the
        markup ships #unmute-overlay with no inline display, so the very first
        paint — before the status poll has answered — laid the prompt over the
        offline banner, both being inset:0 and both centring their content.
        Only app.js may show it, and it always does so with an inline
        display, so the stylesheet default has to be the hidden one (which is
        what .player-loader has always done)."""
        css = self._strip_comments(self.css, "css")
        unmute = self._css_rule(css, ".unmute-overlay")
        self.assertIsNotNone(unmute, ".unmute-overlay rule not found")
        self.assertIn("display: none", unmute,
                      "the unmute prompt must be hidden by default and shown only by app.js")


if __name__ == "__main__":
    unittest.main(verbosity=2)

    def test_self_sent_chat_ids_are_pruned(self):
        """A sender's own echoed message hits an early return before the prune,
        so the set grew 1:1 with self-sends and the stated 500 cap never held."""
        send_path = self._js_function_body(self.app, "addMessage") or self.app
        idx = self.app.find("seenClientMsgIds.add(clientMsgId)")
        self.assertGreater(idx, 0, "the send-path insert was not found")
        window = self.app[idx:idx + 600]
        self.assertIn("seenClientMsgIds.size", window,
                      "the send path must prune the set it just grew")

    def test_root_cursor_write_is_not_repeated_per_mousemove(self):
        """applyCursorState writes the ROOT element's inline style, the broadest
        invalidation available, and it runs on every qualifying mousemove while
        the value being written is identical. Outside fullscreen `hide` is
        always false, so this was the same no-op write dozens of times a
        second."""
        fn = self._js_function_body(self.app, "applyCursorState")
        self.assertIsNotNone(fn, "applyCursorState not found")
        self.assertIn("lastCursorHidden", fn,
                      "the root cursor write must be skipped when the value is unchanged")

    def test_chat_autoscroll_is_batched_into_one_layout(self):
        """Reading scrollHeight right after appendChild is a forced synchronous
        layout, so a chat burst cost one full sidebar layout per message on the
        same thread that decodes video."""
        self.assertIn("scheduleChatAutoscroll", self.app)
        self.assertNotIn("chatMessages.scrollTop = chatMessages.scrollHeight;\n        \n        // Prune",
                         self.app)
        fn = self._js_function_body(self.app, "scheduleChatAutoscroll")
        self.assertIsNotNone(fn, "scheduleChatAutoscroll not found")
        self.assertIn("requestAnimationFrame", fn,
                      "the scroll read must be deferred so a burst coalesces into one layout")
        self.assertIn("chatScrollScheduled", fn, "the deferral must be coalesced, not one rAF per message")

    def test_webfont_display_is_not_optional(self):
        """`display=optional` was tried here to avoid a post-handshake font-swap
        reflow, on the reasoning that the stylesheet is cross-origin. Both halves
        of that are wrong: the <link rel=stylesheet> is render-blocking whatever
        `display` says, and `display` governs the FONT FILE fetch. The real cost
        is that `optional` gives the face ~100ms and then keeps the fallback for
        the whole page load with no swap — and this host's uplink is a phone
        hotspot already saturated carrying the video, so the .woff2 would
        routinely miss that window and the brand fonts would silently never
        render for any viewer. That is a visible regression traded for one
        layout pass, so it was reverted to the default `swap`."""
        html = read_text(HTML_PATH)
        self.assertIn("fonts.googleapis.com", html)
        self.assertIn("display=swap", html,
                      "the brand fonts must still be able to load on a slow uplink")
        self.assertNotIn("display=optional", html,
                         "display=optional silently drops the brand fonts for the whole "
                         "page load on a saturated link")

    def test_abr_seam_keeps_the_audio_track(self):
        """The ABR seam swapped the element's stream for a VIDEO-ONLY one.

        A WHEP answer usually delivers the audio track's ontrack BEFORE the
        video one, so by the time the seam closed the audio track was already
        sitting in the previous (now stale) stream — and replacing the stream
        dropped it. The viewer kept a picture and lost all sound, and because
        which track arrives first is not guaranteed it presented as "sometimes
        video, sometimes music" rather than as a reliable fault. The tell in the
        telemetry was RESOLUTION: -- (player.videoWidth === 0, so the element
        had nothing to size) together with a rising framesDecoded counter and a
        live audio meter: WebRTC decodes regardless of what the element holds.
        """
        code = self._strip_comments(self.app, "js")
        seam = re.search(r"if \(switchSeamPending && event\.track\.kind === 'video'\) \{(.*?)\n                \}",
                         code, re.DOTALL)
        self.assertIsNotNone(seam, "the ABR seam block was not found")
        body = seam.group(1)
        self.assertNotRegex(body, r"replacement\.addTrack\(event\.track\)",
                            "adding only the incoming video track drops the audio track")
        self.assertIn("getReceivers()", body,
                      "the seam must take every track the session has produced, not just the video one")

    def test_every_element_stream_keeps_all_tracks(self):
        """No path may hand the <video> element a single-track stream while the
        session has more than one. Each assignment site is checked for the same
        shape, so a future edit cannot reintroduce the seam's original bug."""
        code = self._strip_comments(self.app, "js")
        sites = [m.start() for m in re.finditer(r"player\.srcObject = ", code)]
        self.assertGreaterEqual(len(sites), 3,
                                "expected the seam, the first-track and the stage-2 assignments")
        for start in sites:
            window = code[max(0, start - 700): start + 120]
            if "new MediaStream()" in window or "freshStream" in window or "replacement" in window:
                self.assertTrue(
                    "getReceivers()" in window or "addTrack(event.track)" in window,
                    "a stream assigned to the element must carry every available track")

    def test_element_stream_is_rebuilt_for_a_new_session(self):
        """The black-screen root cause.

        A <video> renders its FIRST video track. A graceful teardown
        (cleanupConnection(true), used by Stage 2 and every ICE failure) leaves
        the previous stream on screen on purpose, so the next session's tracks
        were APPENDED to it and the dead first video track stayed in charge of
        rendering. Measured symptom: framesDecoded climbing (the new session
        decodes fine), PACKETS LOST 0, audio working, and RESOLUTION "--"
        because player.videoWidth is 0 for a track that produces nothing.
        The stream must therefore be tagged with the session that built it."""
        code = self._strip_comments(self.app, "js")
        self.assertIn("elementStreamSessionId", code,
                      "the element's stream must be tagged with the session that built it")
        pc_site = code.find("new RTCPeerConnection(")
        bump = code.find("currentSessionId += 1", pc_site if pc_site > 0 else 0)
        self.assertGreater(bump, 0, "each peer connection must start a new session id")
        self.assertGreater(bump, pc_site,
                           "the session id must be bumped where the peer connection is created")
        guard = code.find("elementStreamSessionId !== currentSessionId")
        self.assertGreater(guard, 0,
                           "a stream from an older session must be rebuilt, not appended to")
        window = code[guard:guard + 700]
        self.assertIn("getReceivers()", window,
                      "the rebuild must take the current session's tracks")

    def test_seam_pending_is_actually_left_set(self):
        """`switchSeamPending` was set true and then cleared two lines later in
        the same synchronous block, with the first `await` ~100 lines further
        down — so no ontrack could ever fire in between and the whole seam was
        provably unreachable. Every rendition switch silently fell through to
        appending to the stale stream, which is what the seam exists to prevent
        (and is why the audio-drop fix inside it had no effect at all)."""
        code = self._strip_comments(self.app, "js")
        start = code.find("switchSeamPending = true;")
        self.assertGreater(start, 0, "the seam is never armed")
        end = code.find("await new Promise(r => setTimeout(r, 200))", start)
        self.assertGreater(end, start, "the first await after arming was not found")
        between = code[start:end]
        self.assertNotIn("switchSeamPending = false", between,
                         "clearing the flag before the first await makes the seam dead code")

    def test_seam_safety_timer_is_cancelled_by_teardown(self):
        """cleanupConnection did not know about the seam's 12s safety net, so an
        ICE failure landing inside that window tore everything down, painted
        offline, and then had the orphan fire 12s later and reconnect on its own
        — the page flipping offline -> connecting -> live by itself. It must
        also clear the pending flag, or the next session's first ontrack would
        take the seam branch on a teardown that never asked for a switch."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "cleanupConnection")
        self.assertIsNotNone(body, "cleanupConnection not found")
        self.assertIn("switchSeamTimer", body, "teardown must cancel the seam safety net")
        self.assertIn("switchSeamPending = false", body,
                      "teardown must clear the pending flag so a later session is not hijacked")

    def test_gop_env_is_bounded(self):
        """`BRIDGE_GOP` was passed to ffmpeg with only a /^\\d+$/ test, so '0'
        and 999999999 both reached the encoder. Measured with the bundled
        encoder at 1080p60: `-g 0` means every frame is an IDR and produced
        5145 KB where `-g 60` produced 3073 KB over the same 4s — a 67%
        SUSTAINED bitrate overrun for the whole broadcast. `-g 999999999` is
        the opposite: one keyframe, then no viewer who joins or drops a packet
        ever gets another."""
        bridge = self._strip_comments(self.bridge, "js")
        self.assertRegex(bridge, r"Number\.isInteger\(n\)\s*&&\s*n >= 1\s*&&\s*n <= 300",
                         "BRIDGE_GOP must be bounded to a sane frame count")
        self.assertNotRegex(bridge, r"/\^\\d\+\$/\.test\(forced\)\s*return forced;",
                            "an unbounded digits-only test lets -g 0 and -g 999999999 through")

    def test_probe_failure_keeps_the_designed_interval(self):
        """The probe has exactly one call site and the track-fetch retry loop
        never re-enters it, so the log line claiming it "will retry" was false
        and an operator would rely on it. On failure it silently reverted to
        the hard-coded 60 frames the rework exists to remove — 1.0s at 60fps,
        twice the intended 0.5s, and 2.0s at 30fps."""
        bridge = self._strip_comments(self.bridge, "js")
        self.assertIn("60 * seconds", bridge,
                      "a failed probe must fall back to the designed interval at the host's 60fps")
        self.assertNotIn("will retry or keep the default", bridge,
                         "the log must not promise a retry that does not exist")
        self.assertIn("NOT retried", bridge,
                      "the log must say plainly that the value is final for this run")

    def test_unknown_byte_counter_is_not_a_stall(self):
        """The stall watchdog's most dangerous failure mode. A path that has
        disappeared from the control API, or a non-numeric counter, returns
        null, and `Number.isFinite(null)` is false — so an UNKNOWN reading was
        scored exactly like a frozen counter. Five consecutive 3s API timeouts
        on a box also running OBS/NVENC/MediaMTX/Node/tunnel would kill a
        healthy transcoder, which drops its RTMP publish and tears down every
        WHEP session on the path: a room-wide hard stop for a broadcast that
        never stalled."""
        code = self._strip_comments(self.bridge, "js")
        watchdog = self._js_function_body(code, "advance")
        body = code
        idx = body.find("const advanced = counts.some(")
        self.assertGreater(idx, 0, "the advance test was not found")
        window = body[max(0, idx - 900): idx]
        self.assertIn("!Number.isFinite(n)", window,
                      "a non-finite reading is UNKNOWN and must reset the stall counter")
        self.assertIn("stalledSamples = 0", window,
                      "an unknown reading must not accumulate toward a kill")

    def test_crash_cycle_cannot_reset_the_circuit_breaker(self):
        """The 30s 'healthy run' reset was doing double duty. A crash cycle
        landing in the 30-45s band (run 35s, exit, 2s sleep, respawn) reset the
        strike counter every iteration, so the give-up cap could never fire —
        an unbounded loop where every cycle drops the RTMP publisher and
        therefore hard-stops the whole room roughly every 37 seconds. A long,
        uninterrupted run has to be the thing that earns forgiveness."""
        code = self._strip_comments(self.bridge, "js")
        self.assertIn("lastHealthyRunAt", code,
                      "a long healthy run must be tracked separately from the strike count")
        self.assertRegex(code, r"if \(runSeconds >= 300\) \{\s*\n\s*lastHealthyRunAt = Date\.now\(\);",
                         "only a genuinely long run should mark the bridge as healthy")
        check = code.find("if (failures >= MAX_CONSECUTIVE_FFMPEG_FAILURES")
        self.assertGreater(check, 0, "the give-up check was not found")
        window = code[check:check + 400]
        self.assertIn("noHealthyRunFor", window,
                      "the breaker must also trip when the bridge never produces a long run")

    def test_launcher_stale_config_is_a_warning_not_a_site_outage(self):
        """The comparison used to `throw`, and the launcher's outer catch exits
        before Node and cloudflared start — so a stale MediaMTX config took the
        entire website and tunnel DOWN, which is the opposite of what the check
        exists to protect. The streaming stack is already running; refusing to
        bring the site up next to it helps nobody."""
        idx = self.launcher.find("DIFFERENT configuration")
        self.assertGreater(idx, 0, "a stale-config comparison must exist at all")
        window = self.launcher[max(0, idx - 300): idx + 900]
        self.assertIn("Write-Warning", window,
                      "a stale config must warn and continue, not abort the host")
        self.assertNotIn("throw", window.split("Write-Warning")[0][-300:],
                         "nothing before the warning may throw — the outer catch exits before "
                         "Node and cloudflared start, taking the whole site down")
        self.assertIn("its config was NOT verified", self.launcher,
                      "the reassuring 'config matches' line must never print when the "
                      "comparison did not actually run")
        self.assertIn("$configVerified", self.launcher,
                      "the launcher must distinguish a verified config from an unverified one")

    def test_write_queue_comment_arithmetic(self):
        """The comment claimed 2048 packets x 1200 B = 3.3s at 6 Mbps. It is
        2.46 MB, which is ~0.41s — the claim was 8x high, and anyone sizing a
        burst budget from it would be badly wrong. The 2048 value itself is
        sound (measured worst 100ms window is ~5% of the queue)."""
        block = self.config[max(0, self.config.find("writeQueueSize") - 1400):
                            self.config.find("writeQueueSize")]
        self.assertIn("0.41s", block, "the queue-depth arithmetic must be correct")
        self.assertNotIn("3.3s at 6 Mbps", block, "the 8x-wrong figure must not come back")

    def test_grain_background_has_no_fixed_attachment(self):
        """`background-attachment: fixed` is a no-op while html/body's background
        is colour-only (this background propagates to the canvas, and canvas
        backgrounds never scroll) but becomes a real per-scroll repaint cost the
        moment that stops applying. It bought nothing, so it is removed rather
        than left as a trap."""
        css = self._strip_comments(self.css, "css")
        self.assertNotIn("background-attachment", css,
                         "a no-op fixed background attachment is a trap, not a setting")


if __name__ == "__main__":
    unittest.main(verbosity=2)
