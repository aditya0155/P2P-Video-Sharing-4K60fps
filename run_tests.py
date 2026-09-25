"""Local checks for the Windows laptop streaming host (no remote services)."""

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
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HTML_PATH = ROOT / "index.html"
APP_PATH = ROOT / "app.js"
SERVER_PATH = ROOT / "server.js"
CONFIG_PATH = ROOT / "mediamtx.yml"
JS_CHECKS_PATH = ROOT / "js_checks.js"
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
        for path in (HTML_PATH, APP_PATH, SERVER_PATH, CONFIG_PATH, JS_CHECKS_PATH, LAUNCHER_PATH, MEDIAMTX_PATH):
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
        self.assertEqual(versions, ["2.8.0", "2.8.0"])

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
        for path in (SERVER_PATH, APP_PATH, JS_CHECKS_PATH):
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
        self.assertIn("iceServers: cachedIceServers", app, "PC must use the fetched ICE config")
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
        self.assertIn("catchUpUntil", app, "live-edge catch-up state missing")
        self.assertIn("adaptiveRaiseUntil", app, "stress-raise state missing")

    def test_frame_drop_auto_perf_mode_is_present(self):
        app = read_text(APP_PATH)
        self.assertIn("function maybeAutoPerfMode()", app)
        self.assertIn("maybeAutoPerfMode();", app, "frame-drop path must invoke the auto perf mode")
        self.assertIn("rydius_perf_mode", app, "auto perf mode must respect the manual preference key")

    def test_hud_exposes_jitter_and_buffer_target(self):
        html = read_text(HTML_PATH)
        app = read_text(APP_PATH)
        self.assertIn('id="hud-jitter"', html)
        self.assertIn('id="hud-buffer"', html)
        self.assertIn("getElementById('hud-jitter')", app)
        self.assertIn("getElementById('hud-buffer')", app)

    def test_mediamtx_queue_and_udp_buffers_are_tuned_for_viewers(self):
        config = read_text(CONFIG_PATH)
        self.assertRegex(config, r"(?m)^writeQueueSize:\s*1024\s*$",
                         "1024 is the documented packet-loss recommendation and bounds queueing delay")
        self.assertRegex(config, r"(?m)^udpReadBufferSize:\s*\d+\s*$",
                         "udpReadBufferSize must be set explicitly for bursty Wi-Fi viewers")
        self.assertNotRegex(config, r"(?m)^udpReadBufferSize:\s*0\s*$",
                            "OS-default UDP buffers drop bursts on Wi-Fi viewers")


if __name__ == "__main__":
    unittest.main(verbosity=2)
