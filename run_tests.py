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
import threading
import time
import unittest
from http.client import HTTPConnection
import http.client as http_exc
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

class SiteStartupError(Exception):
    """server.js exited before it answered; ``output`` is everything it printed."""

    def __init__(self, message, output=""):
        super().__init__(message)
        self.output = output or ""


def wait_until_ready(test_case, process, base_url, timeout=15):
    """Block until the site server answers /streaming/.

    Raises SiteStartupError - carrying the child's own stdout/stderr - if the
    process dies first, and fails the test if it stays up but never answers.
    Surfacing that output is the whole point: every way this server can fail at
    startup says why on the way out ("Port N is already in use", "PORT must be
    a valid TCP port"), and discarding it collapses all of them into one opaque
    "exited before becoming ready" that reads like a product bug. That is how a
    port collision came to be reported against the static-file allowlist.

    The per-attempt budget is 2s rather than a fraction of a second because a
    cold server.js answers its first request in ~0.52s (median of 25 boots on
    this host, max 1.05s) while every later request takes 3-25ms. A 0.5s
    attempt budget therefore sat directly on top of the median, so the probe
    discarded its first attempt on most boots and only ever succeeded on a
    retry - and under load, when the cold request runs long, the retries were
    the only thing keeping the test alive.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SiteStartupError(
                "Node site server exited before becoming ready (exit code {}).".format(
                    process.returncode),
                stop_process(process),
            )
        try:
            with urlopen(base_url + "/streaming/", timeout=2) as response:
                response.read()
            return
        except (URLError, OSError):
            time.sleep(0.1)
    test_case.fail("Node site server did not become ready at {}".format(base_url))


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


def read_response_until_terminal(port, path, timeout=6):
    """Classify how a response ends, keeping "hung forever" distinguishable.

    http_request() cannot express the interesting outcome: a proxy that leaves a
    half-sent response open just blocks until the socket timeout, which reads
    the same as a proxy that is merely slow. This returns one of

      "end"       -- the server closed after sending every promised byte
      "truncated" -- the server closed with the promised Content-Length unsatisfied
      "reset"     -- the connection was torn down mid-response
      "timeout"   -- nothing terminal happened within `timeout` seconds

    so a test can assert the specific guarantee ("cut loose") rather than the
 absence of a crash.
    """
    connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        connection.sendall(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n".format(
                path, port
            ).encode("ascii")
        )
        received = b""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return "timeout", received
            connection.settimeout(remaining)
            try:
                chunk = connection.recv(4096)
            except socket.timeout:
                return "timeout", received
            except OSError:
                return "reset", received
            if not chunk:
                break
            received += chunk

        head, _, body = received.partition(b"\r\n\r\n")
        promised = 0
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                promised = int(value.strip() or b"0")
        return ("end" if len(body) >= promised else "truncated"), received
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


class _DiesMidBody:
    """Sentinel body for StubMediaMTX routes: promise bytes, send some, then die.

    A plain route can only ever produce a well-formed response, so without this
    the "upstream fails after its headers are already on the wire" path -- the
    one shape a WHEP POST or a status probe can actually hit -- is unreachable
    from a test.
    """


DIES_MID_BODY = _DiesMidBody()


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
                    # The full header set as it arrived, so a test can assert on
                    # hop-by-hop headers the proxy must NOT relay. `self.headers`
                    # is case-insensitive but iterating it gives the original
                    # spellings, which is what a smuggling defence must match on.
                    "headers": {key: value for key, value in self.headers.items()},
                    "header_names": {key.lower() for key in self.headers.keys()},
                })
                route = stub.routes.get((self.command, self.path))
                if route is None:
                    status, extra_headers, payload = 200, {}, b"stub-ok"
                else:
                    status, extra_headers, payload = route(stub)
                if payload is DIES_MID_BODY:
                    # Send headers promising far more than follows, flush a
                    # little of the body, then kill the connection. The pause
                    # lets the proxy forward those bytes to the client before
                    # the fault, so a test can assert the client really did
                    # receive a partial response and was then cut loose --
                    # rather than failing before any body existed.
                    self.send_response(status)
                    for key, value in extra_headers.items():
                        self.send_header(key, value)
                    self.send_header("Content-Length", "4096")
                    self.end_headers()
                    self.wfile.write(b"v=0\r\n")
                    self.wfile.flush()
                    time.sleep(0.2)
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return
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


class _TruncatingUpstream:
    """Node upstream that answers with headers, starts a body, then dies.

    This is the only way to reproduce a MediaMTX restart landing mid-response.

    It has to be a NODE server. With a Python upstream the socket failure also
    surfaces on the proxy's request object, so `proxyReq.on('error')` handles it
    and the response is cut whether or not the response stream is listened to —
    the case then cannot tell the two apart and passes against the broken code.
    A Node upstream destroying its own socket reproduces the real condition,
    where the request side has already completed successfully and only a handler
    on the RESPONSE stream can notice anything went wrong.
    """

    def __init__(self):
        self.process = None
        self.port = None

    def start(self):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("Node.js is required for this case")
        self.process = subprocess.Popen(
            [node, str(ROOT / "truncating_upstream.js"), "0"],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        # The fixture prints its bound port once it is listening.
        line = self.process.stdout.readline().strip()
        if not line.isdigit():
            output = ""
            if self.process.poll() is not None:
                output = self.process.stdout.read()
            self.stop()
            raise AssertionError("truncating upstream never reported a port: " + output)
        self.port = int(line)
        return self

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self.process = None


def truncated_request_outcome(port, path, timeout=5):
    """GET `path` over a RAW socket and report how (or whether) it settled.

    A raw socket is deliberate. `http.client` sits on a buffered reader, so a
    connection that is closed mid-body and one that simply stalls look alike
    from Python and the distinction — which is the entire point — is lost. Here
    the only thing that can end the read is the peer actually closing the
    connection, so:

    * EOF/RST well before `timeout` = the proxy noticed and cut it (the fix);
    * still blocked at `timeout` = nobody noticed, and the player's 5s status
      poll stalls on a request that will never settle (the pre-fix failure).
    """
    outcome = {"settled": False, "how": None, "bytes": 0, "elapsed": None,
               "prompt": False, "status_line": None}
    started = time.time()
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        sock.settimeout(timeout)
        sock.sendall(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n"
            .format(path, port).encode("ascii")
        )
        # Read until EOF, an RST, or the timeout. A short first chunk tells us
        # the response started, which is the precondition for the whole case.
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            except ConnectionResetError:
                outcome.update(settled=True, how="reset")
                break
            if not chunk:
                outcome.update(settled=True, how="eof")
                break
            if outcome["status_line"] is None:
                outcome["status_line"] = chunk.split(b"\r\n", 1)[0].decode("latin-1")
            outcome["bytes"] += len(chunk)
    finally:
        elapsed = round(time.time() - started, 3)
        outcome["elapsed"] = elapsed
        outcome["prompt"] = elapsed < timeout * 0.5
        try:
            sock.close()
        except OSError:
            pass
    return outcome

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

    def test_mediamtx_runs_in_the_folder_that_owns_the_hooks(self):
        # mediamtx.yml invokes the bridge as a RELATIVE command
        # (`node "codec_bridge.js"`) on purpose: that config is shared by every
        # checkout on this machine and must not embed a machine-specific
        # absolute path. MediaMTX therefore resolves those hooks against its OWN
        # working directory, which it inherits from the launcher.
        #
        # start_host.bat masks this by `cd /d "%~dp0"` first, so the launcher
        # alone has to carry the guarantee. Without -WorkingDirectory, launching
        # `powershell -File start_host.ps1` from anywhere else -- notably from a
        # DIFFERENT checkout of this same repo -- makes MediaMTX run that copy's
        # codec_bridge.js while the config and the web server still come from
        # this folder: renditions produced by the wrong code, with nothing in
        # the logs to say so.
        launcher = read_text(LAUNCHER_PATH)
        start = re.search(
            r"Start-Process\s+-FilePath\s+\$mediamtxPath\b[^\n]*", launcher)
        self.assertIsNotNone(start, "the MediaMTX launch line was not found")
        self.assertIn(
            "-WorkingDirectory $scriptDir", start.group(0),
            "MediaMTX must be launched with -WorkingDirectory $scriptDir: the "
            "codec_bridge.js hooks are relative, so MediaMTX resolves them "
            "against its own cwd, which is otherwise just wherever the user "
            "launched from (possibly another checkout of this repo)",
        )
        # ...and the launcher must anchor every path it hands out to its own
        # location, not to the caller's working directory.
        self.assertIn("$scriptDir = Split-Path -Parent $PSCommandPath", launcher,
                      "the launcher must anchor its paths to its own location")
        self.assertIn("$configPath = Join-Path $scriptDir 'mediamtx.yml'", launcher)
        self.assertIn("$serverPath = Join-Path $scriptDir 'server.js'", launcher)

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
        # ...but rtspAddress ALONE does not achieve that. It pins only the
        # TCP/RTSP listener; with rtspTransports left at the MediaMTX default
        # ([udp, multicast, tcp]) the server also binds rtpAddress/rtcpAddress
        # (:8000/:8001) on EVERY interface. Verified against the bundled
        # v1.21.1: "[RTSP] started with listeners on 127.0.0.1:8554
        # (TCP/RTSP), :8000 (UDP/RTP), :8001 (UDP/RTCP)" and Get-NetUDPEndpoint
        # reports LocalAddress "::" for both.
        #
        # That is a broadcast-wide outage, not an RTSP-only one: the bind is
        # FATAL, so anything already holding UDP 8000 aborts the whole
        # MediaMTX process and the API/WebRTC/RTMP/SRT listeners never come
        # up. start_host.ps1 pre-flights TCP 8889 and UDP 8189 but never 8000,
        # so it surfaced only as a generic "MediaMTX exited during startup".
        transports = re.search(r"^rtspTransports:\s*\[(.*?)\]\s*$", self.config, re.MULTILINE)
        self.assertIsNotNone(transports,
                             "missing rtspTransports in mediamtx.yml; without it MediaMTX "
                             "binds UDP 8000/8001 on every interface, not loopback")
        enabled = {t.strip().lower() for t in transports.group(1).split(",") if t.strip()}
        self.assertNotIn("udp", enabled,
                         "rtspTransports enables udp, so RTSP RTP binds :8000 on all "
                         "interfaces; the bridge only ever reads RTSP over TCP")
        self.assertNotIn("multicast", enabled,
                         "rtspTransports enables multicast, binding an all-interface socket")
        self.assertEqual(enabled, {"tcp"},
                         "this project only ever speaks RTSP over TCP "
                         "(codec_bridge.js passes -rtsp_transport tcp)")
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

    # find_free_port() closes its probe socket before returning the number, so
    # the port is free at the moment it is drawn and unreserved by the time
    # server.js binds it a moment later. Anything else on the box can take it in
    # that window - a second run of this suite, or an outbound connection that
    # happens to be assigned the same number - and server.js then exits 1 with
    # "Port N is already in use". That is a collision in the harness, not a
    # defect in the code under test, so it earns a fresh port rather than a red
    # test. Anything else the child reports is a real failure and is surfaced
    # with the child's own words attached.
    BOOT_ATTEMPTS = 5

    def start_site(self, signaling_routes=None, api_routes=None, extra_env=None):
        overrides = {}
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

        # A caller may pin PORT deliberately; a pinned port that is taken is a
        # genuine failure, not a race worth retrying.
        pinned_port = overrides.get("PORT")
        attempts = 1 if pinned_port is not None else self.BOOT_ATTEMPTS
        startup_error = None
        for _ in range(attempts):
            if pinned_port is None:
                overrides["PORT"] = find_free_port()
            self.port = overrides["PORT"]
            self.base_url = "http://127.0.0.1:{}".format(self.port)
            self.server_process = start_node_server(self.node, overrides)
            try:
                wait_until_ready(self, self.server_process, self.base_url)
                return
            except SiteStartupError as error:
                startup_error = error
                if "already in use" not in error.output.lower():
                    break
        self.fail("{}\nServer output:\n{}".format(
            startup_error, (startup_error.output or "<none>").strip()))

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

    def test_loss_accounting_excludes_retransmissions(self):
        """`packetsReceived` includes retransmissions, so the old
        dLost/(dRx+dLost) ratio reported a fully RTX-repaired link as 0% loss
        and could not see an SFU queue overflow at all."""
        run_js_check(self, "network-loss-accounting")

    def test_loss_metric_scale_matches_controller_thresholds(self):
        """Dividing by the loss alone turns a smooth 0.5%-loss link into a 33%
        reading, which permanently pins it to 3000k and makes the upgrade-back
        unreachable. Ties the metric to the real 5/2.5/2% thresholds."""
        run_js_check(self, "loss-metric-scale-matches-controller-thresholds")

    def test_picture_loss_ratio_is_reported(self):
        """The standard broadcast QoE metric was never computed even though
        framesReceived and framesDecoded were both already being read."""
        run_js_check(self, "picture-loss-ratio")

    def test_freeze_watchdog_judges_decode_progress_as_a_rate(self):
        """`decodedDelta === 0` was blind to a partially-wedged decoder and
        could false-fire on a sampling artefact."""
        run_js_check(self, "decoder-stall-detection")


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

    def test_abr_seam_survives_the_teardown_it_is_armed_across(self):
        """Runs the real switchRendition + cleanupConnection and watches the flag.

        `switchSeamPending` was armed and then cleared one line later by
        cleanupConnection(true), in the same synchronous block and before the
        first await -- so the ontrack seam branch was dead code AND the 12s
        safety net it was supposed to cancel was orphaned, firing on its own
        into a hard reconnect 12s after every successful switch. The
        string-only check below cannot see that, because the clear lives in a
        different function's body."""
        run_js_check(self, "seam_survives_the_teardown_it_is_armed_across")

    def test_superseded_attempt_cannot_disarm_a_live_attempt(self):
        """Runs the real `finish()` and the real WHEP POST `finally` bodies.

        `whepPostTimeout` and `gatherTimeout` are module globals purely so
        cleanupConnection() can cancel an in-flight connectStream attempt, which
        makes each one a slot that TWO attempts write to. Both were cleared
        unconditionally, so a torn-down attempt's late callback disarmed the
        attempt that replaced it: the live attempt lost its 10s POST bound (and,
        for the gather cap, its whole routable-candidate poll loop, which
        guarded on the very global the stale attempt nulled).

        This case also asserts the OLD bodies still reproduce the fault, so it
        cannot pass vacuously."""
        run_js_check(self, "superseded-attempt-cannot-disarm-a-live-attempt")

    def test_superseded_session_error_must_not_tear_down_the_live_session(self):
        """A stale connectStream failure must not kill the session that replaced it.

        Only the AbortError branch carried a `superseded()` guard. AbortError is
        not the only way a torn-down attempt fails: cleanupConnection() calls
        `pc.close()` while the attempt is still suspended on createOffer() or
        setLocalDescription(), and those reject with InvalidStateError. That
        landed in the generic branch, which unconditionally cleared isConnecting
        and ran handleDisconnected() -- clearing the LIVE attempt's 26s connect
        watchdog, closing the LIVE attempt's peer connection and painting the
        page OFFLINE. A clean connect followed by an unexplained drop."""
        run_js_check(self, "superseded-session-error-must-not-tear-down-the-live-session")

    def test_catchup_latch_returns_the_element_to_1x(self):
        """Live-edge catch-up must release the playbackRate it took.

        Catch-up drives the media element's playbackRate above 1.0 to drain a
        drift, and that rate is a property of the ELEMENT, not of the peer
        connection: it survives every teardown in the player. Without an
        explicit release a viewer whose session ended while catching up starts
        the next one running fast, with nothing on screen to explain it."""
        run_js_check(self, "catchup-latch-returns-the-element-to-1x")

    def test_catchup_probe_is_abandoned_when_measurement_stops(self):
        """The saturation probe must not judge a drain on a stale baseline.

        Catch-up's self-verification marks the mechanism useless when the rate
        saturates and the buffer stops draining. Clearing the probe whenever the
        controller is NOT asking for the full cap is what keeps a long slow
        ramp from being judged against a measurement taken minutes earlier."""
        run_js_check(self, "catchup-probe-is-abandoned-when-measurement-stops")


    def test_chat_notification_behaviour_is_pinned_by_execution(self):
        """Runs the real notification functions against a stub DOM, so the
        burst cap, the hidden-at-zero badge, the 99+ clamp and the layer's
        release after a burst are proven by observation rather than by the
        presence of an identifier."""
        run_js_check(self, "chat-notification-behaviour")


    def test_chat_notification_gate_decisions_are_pinned_by_execution(self):
        """The source guards can only see that `!isSelf && !isHistory` and
        `if (isHost)` appear in handleIncomingMessage — not that the call is
        nested inside that gate. This drives the real function and checks which
        branch each of the four message kinds actually takes."""
        run_js_check(self, "chat-notification-gate-decisions")


    def test_chat_init_replay_classification_is_pinned_by_execution(self):
        """The server answers a native auto-reconnect with exactly the messages
        this client missed. The real connectChatEvents is driven with a stubbed
        EventSource to prove the init payload is classified by whether a
        watermark already existed, rather than blanket-marked as history."""
        run_js_check(self, "chat-init-replay-classification")


    def test_polling_catch_up_is_silent_by_execution(self):
        """Runs the real poll body with a stubbed fetch. A string check cannot
        tell an isCatchUp that is genuinely derived from the watermark from one
        that is hardcoded false, nor catch a watermark re-read after the await
        (which the batch itself advances) — so the receive path is observed
        directly."""
        run_js_check(self, "polling-fallback-catch-up-is-silent")



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
        # MediaMTX that answers, then dies before the body is finished.
        ("GET", "/live/truncated"): lambda stub: (
            200, {"Content-Type": "application/sdp"}, DIES_MID_BODY,
        ),
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

    # --- the control plane must not be a public remote control ---------------
    #
    # MediaMTX's API is unauthenticated and this whole server is published
    # through the Cloudflare Tunnel, so proxying /stream-api/v3/** verbatim
    # exposed config writes and stream teardown to anyone on the internet. The
    # player and studio only ever issue a read-only GET of the path list, so
    # everything else is refused here without touching the upstream.
    CONTROL_API_WRITE_PROBES = (
        ("PATCH", "/stream-api/v3/config/global/set", b'{"logLevel":"debug"}'),
        ("POST", "/stream-api/v3/recordings/disk/start", b"{}"),
        ("DELETE", "/stream-api/v3/paths/list/live-h264/readystate", None),
        ("GET", "/stream-api/v3/config/global/get", None),
        ("POST", "/stream-api/v3/paths/list/live/readystate", b"{}"),
    )

    def test_control_api_is_read_only_paths_list_only(self):
        for method, path, body in self.CONTROL_API_WRITE_PROBES:
            with self.subTest(method=method, path=path):
                self.api.clear()
                status, headers, _ = http_request(self.port, method, path, body=body)
                self.assertEqual(
                    status, 403,
                    f"{method} {path} must be refused: the control plane is "
                    f"unauthenticated upstream and this server is public",
                )
                self.assertEqual(
                    self.api.requests, [],
                    f"{method} {path} must be blocked BEFORE the proxy runs",
                )
                # The refusal itself must be readable cross-origin, or the viewer
                # sees an opaque CORS failure instead of the explanation.
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_the_one_control_api_route_the_player_needs_still_works(self):
        # The allow-list must not break the status probe: this is the only
        # control-API call app.js and studio.js make.
        self.api.clear()
        status, _, body = http_request(self.port, "GET", "/stream-api/v3/paths/list")
        self.assertEqual(status, 200)
        self.assertEqual(len(self.api.requests), 1, "the probe must still be proxied")
        json.loads(body.decode("utf-8"))

    def test_hop_by_hop_headers_are_not_forwarded_upstream(self):
        # Connection-scoped headers must not be relayed (RFC 9110 7.6.1): they
        # describe THIS hop, and forwarding them creates conflicting framing (a
        # smuggling surface against MediaMTX) and defeats the keep-alive pool.
        #
        # `connection` itself is NOT asserted absent: Node's agent legitimately
        # sets its own Connection on every upstream request, so its presence
        # proves nothing either way. These are headers Node never synthesises,
        # so if they appear upstream they arrived from the client and were
        # relayed.
        self.api.clear()
        http_request(
            self.port, "GET", "/stream-api/v3/paths/list",
            headers={
                "Proxy-Authorization": "Basic should-not-be-relayed",
                "TE": "trailers",
                "Trailer": "X-Smuggled",
                "X-Keep-Me": "yes",
            },
        )
        self.assertEqual(len(self.api.requests), 1)
        record = self.api.requests[0]
        for hop in ("proxy-authorization", "te", "trailer"):
            self.assertNotIn(
                hop, record["header_names"],
                f"{hop} is hop-by-hop and must not be relayed upstream",
            )
        # Look the end-to-end header up case-insensitively: the stub records the
        # original spelling the client used, and asserting on an exact-cased key
        # would make this test depend on the casing the client happened to pick.
        forwarded = {k.lower(): v for k, v in record["headers"].items()}
        self.assertEqual(
            forwarded.get("x-keep-me"), "yes",
            "ordinary end-to-end headers must still be forwarded",
        )

    def test_headers_named_in_the_connection_field_are_not_forwarded(self):
        # RFC 9110 7.6.1 makes any header NAMED in Connection hop-by-hop for
        # that message, and that list is attacker-controlled. A fixed blocklist
        # alone still relays `Connection: X-Smuggled` together with X-Smuggled,
        # which is the actual smuggling surface.
        self.api.clear()
        http_request(
            self.port, "GET", "/stream-api/v3/paths/list",
            headers={"Connection": "X-Smuggled", "X-Smuggled": "yes", "X-Real": "ok"},
        )
        self.assertEqual(len(self.api.requests), 1)
        record = self.api.requests[0]
        self.assertNotIn(
            "x-smuggled", record["header_names"],
            "a header nominated by Connection is hop-by-hop and must not be "
            "relayed upstream",
        )
        self.assertEqual(
            {k.lower(): v for k, v in record["headers"].items()}.get("x-real"), "ok",
            "headers that Connection does not nominate must still be forwarded",
        )

    def test_forwarded_client_ip_is_ignored_unless_a_tunnel_is_configured(self):
        # This server binds 127.0.0.1, so the peer address cannot distinguish the
        # Cloudflare tunnel from Tailscale serve or a local client -- all three
        # arrive on loopback. Honouring CF-Connecting-Ip on that basis would let
        # any of them mint a fresh rate-limit bucket per request, which is the
        # bypass the old unguarded x-forwarded-for chain had. The launcher sets
        # CF_TUNNEL_HOST when it actually starts cloudflared, so the deployment
        # that needs per-viewer limits is the one that enables them.
        server = read_text(SERVER_PATH)
        self.assertIn("TRUST_FORWARDED_HEADERS", server)
        body = self._js_function_body(server, "clientIpForRateLimit") \
            if hasattr(self, "_js_function_body") else None
        if body is not None:
            self.assertIn(
                "TRUST_FORWARDED_HEADERS", body,
                "the forwarded-IP branch must be gated on explicit tunnel config",
            )
        # The launcher is the thing that turns that gate on, and only when the
        # tunnel actually came up.
        launcher = read_text(LAUNCHER_PATH)
        self.assertIn("CF_TUNNEL_HOST", launcher,
                      "the launcher must enable tunnel trust or every remote "
                      "viewer shares one rate-limit bucket")

    def test_if_none_match_accepts_star_and_lists_per_rfc(self):
        # RFC 9110 13.1.2: `*` and comma-separated lists both satisfy the
        # precondition. Comparing the whole header to one etag only ever caught
        # the exact form, so a revalidating client re-downloaded the asset.
        status, headers, _ = http_request(self.port, "GET", "/app.js")
        self.assertEqual(status, 200, "app.js must be served before probing etags")
        etag = headers.get("ETag")
        self.assertTrue(etag, "static assets must carry an ETag to revalidate against")
        for header in ("*", f'W/"other", {etag}', f'{etag}, W/"other"'):
            with self.subTest(if_none_match=header):
                status, _, body = http_request(
                    self.port, "GET", "/app.js", headers={"If-None-Match": header},
                )
                self.assertEqual(status, 304, f"If-None-Match: {header} must revalidate to 304")
                self.assertEqual(body, b"", "a 304 must carry no body")
        # A genuinely stale etag must still re-download, or the 304 above is
        # worthless as a freshness guarantee.
        status, _, _ = http_request(
            self.port, "GET", "/app.js", headers={"If-None-Match": 'W/"stale"'},
        )
        self.assertEqual(status, 200, "a non-matching etag must return the body")

    @staticmethod
    def _read_chat_init(port, query=""):
        """Open the SSE stream and read exactly the `init` frame.

        The stream never ends, so reading to EOF hangs -- which is how the
        first version of this test deadlocked. Read the one frame we need off
        the socket and close.
        """
        conn = HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("GET", f"/stream-api/chat/events{query}")
            response = conn.getresponse()
            if response.status != 200:
                return response.status, None
            frame = b""
            while b"\n\n" not in frame:
                chunk = response.fp.readline()
                if not chunk:
                    break
                frame += chunk
            if b"event: init" not in frame:
                return response.status, None
            payload = frame.split(b"data: ", 1)[1].split(b"\n", 1)[0]
            return response.status, json.loads(payload.decode("utf-8"))
        finally:
            conn.close()

    def test_chat_replay_does_not_silently_drop_messages_across_a_restart(self):
        # A browser keeps recent ids for deduplication, so the next server
        # process must issue larger ids instead of reusing the previous range.
        self.start_site()
        old_ids = []
        for text in ("alpha", "bravo", "charlie"):
            status, _, body = http_request(
                self.port, "POST", "/stream-api/chat/messages",
                body=json.dumps({"text": text, "author": "Viewer"}).encode("utf-8"),
            )
            self.assertEqual(status, 200)
            old_ids.append(json.loads(body.decode("utf-8"))["message"]["id"])

        previous_last_id = old_ids[-1]
        stop_process(self.server_process)
        self.server_process = None
        time.sleep(0.01)
        self.start_site()

        current_ids = []
        for text in ("delta", "echo", "foxtrot"):
            status, _, body = http_request(
                self.port, "POST", "/stream-api/chat/messages",
                body=json.dumps({"text": text, "author": "Viewer"}).encode("utf-8"),
            )
            self.assertEqual(status, 200)
            current_ids.append(json.loads(body.decode("utf-8"))["message"]["id"])
        self.assertGreater(current_ids[0], previous_last_id,
                           "a restarted server must not reuse ids held by open clients")

        status, init = self._read_chat_init(self.port, "?lastId={}".format(previous_last_id))
        self.assertEqual(status, 200)
        self.assertIsNotNone(init, "the init frame must be readable")
        texts = [m.get("text") for m in init["history"]]
        for text in ("delta", "echo", "foxtrot"):
            self.assertIn(
                text, texts,
                "a previous process id must fall back to the full "
                "retained window instead of silently dropping messages",
            )
        # A legitimate in-range replay must still replay only what followed it,
        # or the fix would just resend the whole log to every reconnecting tab.
        status, init = self._read_chat_init(
            self.port, "?lastId={}".format(current_ids[0]))
        self.assertEqual(status, 200)
        self.assertEqual(
            [m.get("text") for m in init["history"]], ["echo", "foxtrot"],
            "an id inside the retained window must replay only what followed it",
        )

    def test_upstream_that_dies_mid_body_is_cut_loose_instead_of_hanging(self):
        # A response that dies AFTER its headers is reported on Node's *response*
        # object, never on the request, and pipe() does not forward source errors
        # to the destination -- so the proxy used to simply leave the client's
        # socket open forever. Measured against an upstream that destroys the
        # socket mid-body, the client saw no end, no abort and no error in 40s,
        # and the 30s request timeout never fired either, because it only arms
        # while there is still no response. That is precisely the freeze the
        # timeout's own comment says it exists to prevent: a status probe that
        # hangs leaves the player's reconnect loop with no error to retry on.
        outcome, received = read_response_until_terminal(self.port, "/stream-api/live/truncated")

        self.assertIn(b"v=0", received,
                      "the client must actually have received the partial body, otherwise this "
                      "test is not exercising a mid-body death at all")
        self.assertNotEqual(
            outcome, "timeout",
            "the proxy left the client's socket open after the upstream died mid-body; "
            "the client will hang until the browser gives up",
        )
        self.assertIn(outcome, ("truncated", "reset"),
                      "the partial response must be cut, not left dangling: got {!r}".format(outcome))

        # Cutting the socket must not wedge the proxy for the next viewer.
        status, _, _ = http_request(self.port, "GET", "/stream-api/live/whep")
        self.assertEqual(status, 404, "the proxy must still serve normally after a cut response")

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
        # Assert the SCHEDULE, not one literal spelling of it. The half-life
        # term used to be written as `(CF_TURN_TTL_SECONDS / 2) * 1000` and
        # pinning that exact string meant any correct rewrite of the expression
        # failed the suite — so this now checks the property it protects: the
        # renewal offset is the TTL/2 term.
        self.assertRegex(
            server,
            r"renewAt\s*=\s*now\s*\+\s*Math\.max\([^;]*ttlMs\s*/\s*2",
            "server must renew mints on a TTL/2 half-life schedule",
        )
        # ...and that the offset is additionally clamped to the credential's own
        # lifetime. A fixed 60s floor equalled the FULL TTL at Cloudflare's
        # minimum 60s TTL, so a mint served at the tail of its window carried
        # zero remaining validity and the allocation silently failed.
        self.assertRegex(
            server,
            r"renewAt\s*=\s*now\s*\+\s*Math\.max\([^;]*ttlMs\s*-\s*5000",
            "the renewal offset must be clamped to the credential lifetime, or a "
            "short TTL schedules renewal at/after expiry and serves dead credentials",
        )
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

class ProxyUpstreamFailureChecks(_SiteUnderTest):
    """The proxy's failure paths, exercised against upstreams that really fail.

    Most proxy bugs are invisible to a stub that always answers: the request
    side completes normally and `pipe()` does the rest. These cases drive the
    failure modes that only appear when the upstream dies mid-flight.
    """

    @staticmethod
    def _strip_comments(text):
        """Block and line comments are removed so a check cannot match the
        explanation of a fix instead of the fix."""
        without_block = re.sub(r"(?:^|(?<=\s))[ \t]*/\*.*?\*/", "", text,
                               flags=re.DOTALL | re.MULTILINE)
        return re.sub(r"(?m)^[ \t]*//.*$", "", without_block)

    def test_mid_response_upstream_reset_does_not_hang_the_client(self):
        """A MediaMTX restart or crash while a response body is in flight.

        Only `proxyReq` had an error handler. Once MediaMTX has sent response
        headers the REQUEST side is already complete, so the failure is reported
        on `proxyRes` — and `proxyRes.pipe(res)` does not forward errors to the
        destination. With nothing listening, `res` was never ended and never
        destroyed: the client's fetch() neither resolved nor rejected, so the
        player's 5s status poll hung forever on a request that would never
        settle, and the response, the upstream message and the client socket
        were retained for the lifetime of the process. The 30s
        `proxyReq.setTimeout` does not help — the socket is already gone, so the
        timer is cleared without ever firing.

        Verified against the real server: without the handler the client HUNG for
        the full timeout; with it, the client is told immediately."""
        truncating = _TruncatingUpstream().start()
        self._stubs.append(truncating)
        self.start_site(api_routes=None, extra_env={
            "MEDIAMTX_API_PORT": str(truncating.port),
        })
        outcome = truncated_request_outcome(self.port, "/stream-api/v3/paths/list")
        self.assertIsNotNone(outcome["status_line"],
                             "the proxy never sent response headers (outcome={!r})"
                             .format(outcome))
        self.assertTrue(outcome["status_line"].startswith("HTTP/1.1 200"),
                        "the test needs the response to START before it is cut "
                        "(outcome={!r})".format(outcome))
        self.assertTrue(
            outcome["settled"],
            "a truncated upstream response must close the client connection, not "
            "leave it hanging (outcome={!r})".format(outcome),
        )
        self.assertTrue(
            outcome["prompt"],
            "the client waited the full {0}s: nothing noticed the upstream dying, so "
            "the player's status poll stalls on a request that never settles "
            "(outcome={1!r})".format(outcome["elapsed"], outcome),
        )

    def test_upstream_that_never_answers_times_out_to_502(self):
        """The pre-header path must still answer 502 rather than hang."""
        self.start_site()
        status, _, body = http_request(self.port, "GET", "/stream-api/v3/paths/list")
        self.assertEqual(status, 502)
        self.assertIn(b"MediaMTX", body)

    def test_a_non_fatal_accept_error_does_not_kill_every_viewers_stream(self):
        """`server.on('error')` exited the process for EVERY error, not just
        EADDRINUSE — which contradicts the long-lived-host policy stated at the
        uncaughtException handler ("a single stray failure would otherwise kill
        the whole process mid-broadcast").

        An `http.Server` also emits 'error' when libuv reports an ACCEPT-side
        failure: EMFILE / ENFILE / ECONNABORTED on Windows, all routine under
        connection pressure. `process.exit()` is a deliberate call, so it
        bypasses the uncaughtException net entirely. One accept failure from a
        burst of viewer connections therefore killed the host instantly, dropping
        every viewer's WHEP session, chat stream and status probe at once, when
        the correct response was to log it and keep accepting.

        Genuinely fatal listen failures (EADDRINUSE and friends) must still exit
        so the launcher can report them — otherwise a second host comes up
        silently and the operator has no idea why nothing is being served."""
        code = self._strip_comments(read_text(SERVER_PATH))
        body = re.search(
            r"server\.on\('error',\s*\(error\)\s*=>\s*\{(?P<inner>.*?)\n\}\);",
            code, re.DOTALL,
        )
        self.assertIsNotNone(body, "the server error handler was not found")
        inner = body.group("inner")
        self.assertIn("EADDRINUSE", inner,
                      "a second launcher must still fail with a readable reason")
        # Split at the EADDRINUSE branch: everything after it is the "any other
        # error" path, which must not be unconditionally fatal.
        tail = inner[inner.index("EADDRINUSE"):]
        tail = tail[tail.index("return;") + len("return;"):] if "return;" in tail else tail
        fatal_exit = tail.find("process.exit(")
        self.assertNotEqual(
            fatal_exit, 0,
            "every non-EADDRINUSE server error exited the process, so one routine "
            "accept-side failure (EMFILE/ENFILE/ECONNABORTED) kills the host and "
            "every viewer's stream with it",
        )
        if fatal_exit != -1:
            window = tail[max(0, fatal_exit - 400): fatal_exit]
            self.assertIn("fatal", window,
                          "a surviving process.exit() must be guarded by an explicit "
                          "fatal-error list, not reached unconditionally")

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

class SiteStartupDiagnosticsChecks(_SiteUnderTest):
    """A server that dies at startup must say why, in its own words.

    A cold `server.js` answered its first request in ~0.52s (median of 25
    boots here, max 1.05s) while later requests took 3-25ms, and the readiness
    probe gave each attempt 0.5s. The probe therefore threw its first attempt
    away on most boots, and when the process died during startup it reported
    only "exited before becoming ready" - discarding the very output that
    explains the death. That is how a port collision in the harness got
    reported as a static-file allowlist failure, pointing at server.js's
    allowlist instead of at the harness's port choice.
    """

    def test_a_taken_port_is_retried_and_then_reported_with_the_childs_words(self):
        main = sys.modules[__name__]
        taken = find_free_port()
        # A plain listening socket, exactly like find_free_port()'s probe but
        # never closed. SO_REUSEADDR is deliberately NOT set: on Windows that
        # would let server.js bind the same port anyway, so the collision this
        # test needs would never happen.
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", taken))
        blocker.listen(5)
        # Accept and immediately drop, so a readiness probe aimed at the taken
        # port fails in milliseconds instead of sitting out the full per-attempt
        # timeout five times over.
        stop_blocker = threading.Event()

        def drain():
            blocker.settimeout(0.2)
            while not stop_blocker.is_set():
                try:
                    conn, _addr = blocker.accept()
                except (socket.timeout, OSError):
                    continue
                conn.close()

        drainer = threading.Thread(target=drain, daemon=True)
        drainer.start()

        original_port = main.find_free_port
        original_start = main.start_node_server
        spawns = []

        def counting_start(node, env_overrides):
            spawns.append(env_overrides.get("PORT"))
            return original_start(node, env_overrides)

        main.find_free_port = lambda: taken
        main.start_node_server = counting_start
        try:
            with self.assertRaises(AssertionError) as caught:
                self.start_site()
        finally:
            main.find_free_port = original_port
            main.start_node_server = original_start
            stop_blocker.set()
            drainer.join(timeout=2)
            blocker.close()

        message = str(caught.exception)
        self.assertIn("already in use", message,
                      "the child's own reason for exiting must reach the report")
        self.assertEqual(len(spawns), self.BOOT_ATTEMPTS,
                         "a port collision must be retried with a fresh port, "
                         "not reported as a product failure")

    def test_the_readiness_probe_outlasts_a_cold_first_response(self):
        # A server whose first answer takes longer than the old 0.5s attempt
        # budget must still be recognised as ready, or every slow boot is
        # reported as a server that never came up.
        class SlowHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                time.sleep(1.2)
                body = b"ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format_string, *args):
                pass

        class _Alive:
            def poll(self):
                return None

        slow = HTTPServer(("127.0.0.1", 0), SlowHandler)
        Thread(target=slow.serve_forever, daemon=True).start()
        try:
            # Raises on failure; returning at all is the assertion.
            wait_until_ready(self, _Alive(), "http://127.0.0.1:%d" % slow.server_port)
        finally:
            slow.shutdown()
            slow.server_close()

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

    def test_every_mediamtx_config_disables_moq(self):
        """MoQ binds fixed WILDCARD ports, so any config that omits it leaks.

        The bundled MediaMTX ships MoQ on by default (:8892 TCP+UDP and :8893
        UDP, wildcard on every interface). mediamtx.yml sets `moq: no`, but a
        config that lists only the keys it cares about inherits the default -
        which is exactly how the suite's sandboxed instance came to hold 8892
        and collide with anything else on the machine. Pin the flag everywhere a
        config is authored, including the literals the tests generate.
        """
        with self.subTest(config="mediamtx.yml"):
            self.assertRegex(self.config, r"(?m)^moq:\s*no\s*$",
                             "mediamtx.yml must disable MoQ (:8892/:8893 on the wildcard)")

        source = read_text(Path(__file__).resolve().parent / "run_tests.py")
        blocks = re.findall(r'"logLevel: warn\\n"[\s\S]{0,4000}?"paths:\\n"', source)
        self.assertTrue(blocks, "expected at least one generated MediaMTX config in the suite")
        for index, block in enumerate(blocks):
            with self.subTest(generated_config=index):
                self.assertIn('"moq: no\\n"', block,
                              "a generated MediaMTX config leaves MoQ enabled and inherits "
                              "fixed wildcard ports :8892/:8893")

        e2e = read_text(ROOT / "e2e_bridge_check.py")
        self.assertNotIn("MTX_MOQ", e2e,
                         "the e2e sandbox must not re-enable MoQ through the environment")

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
                         "all page assets must share one cache version, got {}".format(sorted(versions)))

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
            # MoQ (Media over QUIC) is ON by default in the bundled binary and
            # binds FIXED, NON-LOOPBACK addresses (:8892 TCP/UDP and :8893 UDP,
            # wildcard on every interface) that this config never declares. The
            # three ports above are drawn with find_free_port(), so they cannot
            # collide, but these inherited ones can: any other process, another
            # test run, or a second sandbox on the box holding 8892 made
            # MediaMTX exit at startup with
            #   listen tcp :8892: bind: Only one usage of each socket address ...
            # which surfaced as a real, reproducible suite failure rather than
            # an environment quirk. It is also the only listener the test binds
            # on 0.0.0.0 instead of loopback. The production mediamtx.yml already
            # disables it (moq: no); the test config must say the same.
            "moq: no\n"
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

    def test_sandboxed_mediamtx_binds_nothing_on_a_wildcard_address(self):
        """The generated config must not inherit a fixed, non-loopback listener.

        The bundled MediaMTX enables MoQ by default, binding :8892 (TCP+UDP) and
        :8893 (UDP) on the wildcard address. Those ports are not drawn by
        find_free_port(), so they are the one thing in this sandbox that can
        collide with another process - and when they do, MediaMTX exits at
        startup and the failure is reported as a broken control-API contract
        rather than a port clash. It is also the only socket the tests open to
        the whole network instead of loopback. Asserted here against the real
        binary so the inherited default cannot come back unnoticed.
        """
        if not MEDIAMTX_PATH.is_file():
            self.skipTest("MediaMTX binary is not installed")
        if os.name != "nt":
            self.skipTest("listener inspection is Windows-specific")

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
            "moq: no\n"
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

            # Every socket this process owns must be loopback-scoped. A wildcard
            # (0.0.0.0 / ::) listener here is exactly the inherited MoQ default.
            # Built by concatenation, not .format(): the script is full of
            # PowerShell braces that .format() would try to interpret.
            script = (
                "$p = " + str(process.pid) + "; "
                "$bad = @(); "
                "Get-NetTCPConnection -State Listen -OwningProcess $p -ErrorAction SilentlyContinue "
                "| ForEach-Object { if ($_.LocalAddress -ne '127.0.0.1') "
                "{ $bad += ('tcp ' + $_.LocalAddress + ':' + $_.LocalPort) } }; "
                "Get-NetUDPEndpoint -OwningProcess $p -ErrorAction SilentlyContinue "
                "| ForEach-Object { if ($_.LocalAddress -ne '127.0.0.1') "
                "{ $bad += ('udp ' + $_.LocalAddress + ':' + $_.LocalPort) } }; "
                "$bad -join ','"
            )
            listing = subprocess.run(
                ["powershell", "-NoProfile", "-Command", script],
                capture_output=True, text=True, timeout=60,
            )
            offenders = [item for item in listing.stdout.strip().split(",") if item]
            self.assertEqual(
                offenders, [],
                "the sandboxed MediaMTX opened non-loopback sockets: {}".format(offenders),
            )
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
        self.assertIn("whepPostTimeout = myPostTimeout", app, "WHEP POST needs a timeout timer")
        self.assertIn("signal: myAbortController.signal", app, "WHEP POST must be abortable")
        self.assertIn("clearTimeout(myPostTimeout)", app, "the POST timeout must be cleared on completion/teardown")

    def test_superseded_attempt_cannot_clear_a_live_attempts_timers(self):
        """A torn-down connectStream attempt must not disarm the one that replaced it.

        `whepPostTimeout` and `gatherTimeout` are module globals purely so
        cleanupConnection() can cancel an in-flight attempt, which makes each one
        a slot that two attempts write to. connectStream's `finally` block and
        the ICE-gather window's `finish()` used to clear those slots
        unconditionally, so this interleaving disarmed the LIVE attempt:

          A arms the 10s WHEP POST bound and awaits fetch
          A is torn down; cleanupConnection clears + nulls the global
          B starts and arms its own 10s bound
          A's aborted fetch rejects, A's `finally` runs
            -> clearTimeout(B's bound); whepPostTimeout = null

        B is then left with a WHEP POST that no timeout can end and that
        teardown can no longer cancel, so it hangs to the 26s connect watchdog
        instead of 10s. The identical shape applied to `gatherTimeout`, where
        it additionally killed the routable-candidate poll loop - that loop
        guarded on `gatherTimeout === null`, i.e. on the very global the stale
        attempt had just nulled.

        Both are now attempt-owned and released only under an identity check.
        """
        app = read_text(APP_PATH)
        code = ViewerSmoothnessRegressionChecks._strip_comments(app, "js")
        connect = ViewerSmoothnessRegressionChecks._js_function_body(code, "connectStream")
        self.assertIsNotNone(connect, "connectStream not found")

        # The WHEP POST bound.
        self.assertIn("if (whepPostTimeout === myPostTimeout) whepPostTimeout = null;",
                      connect,
                      "the POST `finally` must release the shared slot only when it "
                      "still holds this attempt's handle")
        # The ICE gather cap: released under an identity check, and the window's
        # own liveness flag is attempt-local so a foreign null cannot stop it.
        self.assertIn("if (gatherTimeout === gatherCap) gatherTimeout = null;",
                      connect,
                      "the gather window must release the shared slot only when it "
                      "still holds this attempt's cap")
        self.assertIn("let gatherOpen = false;", connect,
                      "the gather window's liveness must be attempt-local state, "
                      "not the shared global a stale attempt can null")
        self.assertIn("if (routableSettle || !gatherOpen) return;", connect,
                      "the routable-candidate poll must guard on the attempt-local "
                      "window flag, or a stale attempt's null silently kills it")
        # And no unconditional clear of either shared slot may remain in the
        # attempt body - that is the defect itself.
        self.assertNotRegex(connect,
                            r"if \(gatherTimeout\) \{ clearTimeout\(gatherTimeout\); gatherTimeout = null; \}",
                            "the unconditional gatherTimeout clear is the cross-attempt bug")
        self.assertNotRegex(connect,
                            r"if \(whepPostTimeout\) \{[^}]*clearTimeout\(whepPostTimeout\)[^}]*\}",
                            "the unconditional whepPostTimeout clear is the cross-attempt bug")

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

    def test_latency_mode_defaults_to_cinema_and_persists(self):
        # 'balanced' (180ms) as the default kept every fresh viewer's jitter
        # buffer oscillating around the fixed point on bursty arrivals —
        # overshoot drained back at ~150ms/s of catch-up ("a few ms fast"),
        # under-run held a frame ("a few ms slow") — the exact micro-stutter
        # receivers reported with 0% loss. For a movie broadcast latency is
        # welcome, so 'cinema' (1s) is the default; a manual choice must
        # survive reloads.
        app = read_text(APP_PATH)
        html = read_text(HTML_PATH)
        self.assertIn("let currentLatencyMode = 'cinema';", app,
                      "cinema (1s) must be the default playout target")
        self.assertIn("rydius_latency_mode", app,
                      "the latency choice must persist across visits")
        self.assertIn('title="Latency Buffer: Cinema (1s)"', html,
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

        # The PATH fallback must be ANNOUNCED, not taken silently.
        #
        # `ffmpeg_win/` is gitignored, so it is present in the main checkout and
        # absent from every git worktree and every fresh clone — which is exactly
        # where code gets edited. The resolver used to return a bare `'ffmpeg'`
        # with no diagnostic, so a worktree operator silently transcoded with
        # whatever ffmpeg was first on PATH: a different build, without the AV1
        # RTP depacketizer fix (d12791ef) that the bridge exists to rely on. The
        # host starts, the local page plays, and the symptom is that edits appear
        # to do nothing — or an AV1/WHIP source stalls on the RTSP leg — neither
        # of which points at the encoder. `FFMPEG` must also stay a plain string,
        # because the ffprobe sibling derivation branches on `!== 'ffmpeg'`.
        self.assertIn("reportFfmpegResolution", bridge,
                      "the resolved ffmpeg must be reported at startup")
        self.assertIn("reportFfmpegResolution();", bridge,
                      "the startup report must actually be called")
        self.assertIn("PATH fallback", bridge,
                      "the resolver must record that it fell back to PATH")
        self.assertIn("FALLING BACK TO PATH", bridge,
                      "a PATH fallback must be announced loudly, naming the missing path")
        self.assertIn("gitignored", bridge,
                      "the fallback must explain the gitignore/worktree cause, not just the symptom")
        self.assertIn("const FFMPEG = FFMPEG_RESOLVED.binary;", bridge,
                      "FFMPEG must stay a plain string for the ffprobe sibling derivation")
        # The launcher must surface the same condition before the stream starts.
        launcher = read_text(LAUNCHER_PATH)
        self.assertIn("ffmpeg_win", launcher,
                      "the launcher must check for the gitignored bundled ffmpeg")
        self.assertIn("BRIDGE_FFMPEG", launcher,
                      "the launcher must name the override that bypasses the check")
        # The tunable env defaults are load-bearing for the mediamtx wiring test.
        self.assertIn("process.env.BRIDGE_RTMP_PORT || '1935'", bridge)
        self.assertIn("process.env.RTSP_PORT || '8554'", bridge)
        self.assertIn("process.env.BRIDGE_API_BASE || 'http://127.0.0.1:8888'", bridge)

    def test_silent_ffmpeg_fallback_is_reported(self):
        """`ffmpeg_win/` is gitignored, so it exists in the MAIN checkout and in
        NONE of this repo's ~40 git worktrees. A bridge started from a worktree
        therefore took the PATH fallback SILENTLY, and the PATH ffmpeg on this
        host is 8.0 -- the exact version that cannot bridge a WHIP AV1 source
        (it loops forever on "Unexpected fragment continuation"). The failure
        presented minutes later as a mystery circuit-breaker trip with nothing
        in the log tying it to a missing directory. The fallback must announce
        itself and name the version it found."""
        bridge = read_text(BRIDGE_PATH)
        self.assertIn("Bundled ffmpeg NOT found at:", bridge,
                      "a missing bundled ffmpeg must be reported, not taken silently")
        self.assertIn("PATH ffmpeg reports:", bridge,
                      "the fallback must name the ffmpeg it actually resolved")
        # The report must fire on the PATH fallback specifically, and must NOT
        # fire when an explicit override or the bundled build is in use.
        self.assertIn("process.env.BRIDGE_FFMPEG", bridge)
        reporter = re.search(
            r"if \(process\.env\.BRIDGE_FFMPEG\) return;.*?if \(resolved !== 'ffmpeg'\) return;",
            bridge, re.S)
        self.assertIsNotNone(reporter,
                             "the ffmpeg report must be skipped for an override or a bundled build")
        # The warning has to name the worktree cause, or it reads as a generic
        # "not installed" message and the real fix stays hidden.
        self.assertIn("gitignored", bridge,
                      "the ffmpeg warning must explain that git worktrees lack ffmpeg_win/")

    def test_host_identifies_the_checkout_it_starts(self):
        """This repo has ~40 git worktrees plus a main checkout, each with its
        own copy of app.js/server.js, and every port in mediamtx.yml is fixed
        (3000/8888/1935/8554/8889/8189). So "my edit did nothing" is almost
        always the OTHER checkout still serving. Both ends of that confusion
        must now name themselves."""
        launcher = read_text(LAUNCHER_PATH)
        server = read_text(SERVER_PATH)

        # The launcher prints which directory it is starting.
        self.assertIn("Starting host from:", launcher,
                      "start_host.ps1 must name the checkout it starts")
        # ...and says so when that checkout is a worktree rather than the main
        # one, since a worktree is missing the gitignored machine-local assets.
        self.assertIn("WORKTREE", launcher,
                      "start_host.ps1 must flag that it is running from a worktree")
        # The two assets that make a worktree a strictly worse place to run:
        # the AV1-capable ffmpeg, and the public tunnel.
        self.assertIn("ffmpeg_win", launcher,
                      "start_host.ps1 must warn when the bundled ffmpeg is absent")
        self.assertIn("cloudflared_config.yml", launcher,
                      "start_host.ps1 must warn when the tunnel config is absent")

        # A port conflict must name the holder rather than just the port, since
        # the actionable fact is WHICH checkout holds it.
        self.assertIn("already held by", launcher,
                      "a port conflict must name the process holding the port")
        self.assertIn("CHECKOUT", launcher,
                      "the port-conflict message must connect the conflict to this repo's checkouts")
        # `OwningProcess` is a property of the connection, not of Win32_Process.
        # Reading it off the process is what produced "node.exe (pid )" -- an
        # empty pid in the one message whose entire purpose is identification.
        self.assertIn("$holderPid = $conn.OwningProcess", launcher,
                      "the pid must be read from the connection, not the process")

        # The server serves __dirname, so it must say which directory that is.
        self.assertIn("Serving from:", server,
                      "server.js must name the directory it serves from")
        self.assertIn("STATIC_DIR", server)

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

    def test_live_edge_catch_up_rate_law(self):
        run_js_check(self, "catchup-rate-drains-without-a-teardown")

    def test_seam_switch_actually_lands(self):
        run_js_check(self, "seam-switch-actually-lands")

    def test_catchup_guard_ignores_a_healthy_refilling_buffer(self):
        run_js_check(self, "catchup-self-verification-ignores-a-refilling-buffer")

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

    def test_concurrent_requests_cannot_blow_past_the_chat_limit(self):
        """The reservation must happen SYNCHRONOUSLY, before the body is read.

        An earlier version of the fix moved the charge into the post-validation
        callback to stop rejected requests spending quota. That left the
        pre-check and the charge decoupled by an await: every request in a
        burst reads the same (empty) window, all pass the check, and all are
        accepted — so the limit bounded nothing and one parallel batch could
        flood the room.

        The reservation is therefore synchronous and a rejection REFUNDS it, so
        both properties hold at once."""
        self.start_site()
        from concurrent.futures import ThreadPoolExecutor

        def post(_):
            return http_request(
                self.port, "POST", "/stream-api/chat/messages",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"text": "burst", "author": "A"}),
            )[0]

        with ThreadPoolExecutor(max_workers=24) as pool:
            codes = list(pool.map(post, range(24)))
        accepted = codes.count(200)
        self.assertLessEqual(
            accepted, 5,
            "24 concurrent valid messages were accepted in one burst; the per-IP "
            "limit (5 per 2s) must be reserved synchronously or it bounds "
            "nothing (codes={})".format(sorted(codes)),
        )
        self.assertIn(429, codes, "the limit must actually engage under concurrency")

    def test_rejected_requests_do_not_spend_the_senders_rate_limit_budget(self):
        """Rate-limit stamps were recorded BEFORE the body was parsed and
        validated, so a request that was then answered 400 (malformed JSON,
        empty text, oversize body) had still consumed quota. A client whose
        first five attempts were all rejected was 429'd on its sixth VALID
        message — it could be silenced by making it send bad requests.

        The charge now happens on the acceptance path, so only messages that
        are actually delivered cost the sender anything."""
        self.start_site()
        def post(payload, raw=None):
            body = raw if raw is not None else json.dumps(payload)
            return http_request(
                self.port, "POST", "/stream-api/chat/messages",
                headers={"Content-Type": "application/json"}, body=body)[0]

        # Five invalid attempts, all rejected.
        for _ in range(5):
            self.assertEqual(post(None, raw="{not json"), 400)
            self.assertEqual(post({"text": "   "}), 400)

        # A valid message must still be accepted on the sixth attempt.
        self.assertEqual(post({"text": "still allowed", "author": "A"}), 200,
                         "rejected requests spent the sender's quota, so a valid "
                         "message after 5 rejections was throttled")

    def test_rejected_reactions_do_not_spend_the_global_reaction_budget(self):
        """Same ordering error on the reaction path, and it also charged the
        room-wide global budget. An invalid emoji is answered 400 and never
        broadcast, so it must not count against the cap that exists to bound
        the on-screen compositing cost for everyone."""
        self.start_site()
        cap = 25
        # Spend the entire global budget with VALID reactions, one IP each so
        # the per-IP limiter (10 per 2s) never interferes.
        accepted = 0
        for i in range(cap + 15):
            status, _, _ = http_request(
                self.port, "POST", "/stream-api/chat/reactions",
                headers={"Content-Type": "application/json", "X-Forwarded-For": ""},
                body=json.dumps({"emoji": "fire"}),
            )
            if status == 200:
                accepted += 1
            else:
                self.assertEqual(status, 429)
                break
        self.assertLessEqual(
            accepted, cap,
            "the global cap must hold; accepted={} cap={}".format(accepted, cap),
        )

    def test_reaction_global_cap_holds_across_a_second_boundary(self):
        """The cap was a FIXED window: a counter reset at each wall-clock second
        boundary, so 25 reactions at t=999ms and 25 more at t=1001ms were both
        accepted — 50 in a 2ms span, double the cap. The cap exists precisely
        because that aggregate is composited as animation layers over live
        video on every screen in the room, so the overshoot lands at the worst
        moment.

        The window is now sliding: expired stamps are dropped on every check,
        so the invariant is 'never more than CAP accepted in any trailing 1s'.
        This test hammers from several IPs (so the per-IP limiter cannot be
        what rejects) and asserts the total accepted inside one second never
        exceeds the cap."""
        self.start_site()
        cap = 25
        accepted = 0
        rejected = 0
        # 60 attempts, tight loop, so the whole burst spans well under 1s.
        for _ in range(60):
            status, _, _ = http_request(
                self.port, "POST", "/stream-api/chat/reactions",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"emoji": "heart"}),
            )
            if status == 200:
                accepted += 1
            else:
                rejected += 1
        self.assertGreater(rejected, 0,
                           "the burst should have hit the ceiling at all")
        self.assertLessEqual(
            accepted, cap,
            "a fixed window let up to 2x the cap through across a second "
            "boundary (accepted={} cap={})".format(accepted, cap),
        )

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
            "console:quietConsole(),lastRenditionSwitchAt:NOW,"
            # startTelemetry resets the live-edge catch-up rate. playbackRate is a
            # property of the media ELEMENT, not of the peer connection, so it
            # survives every teardown; a new session must start at 1.0x. Stubbed
            # here to prove the call is actually reachable from a real session.
            "player:{playbackRate:1.06},resetLiveEdgeCatchUp:()=>{"
            "  if(sb.player.playbackRate!==1.06){throw new Error('unexpected rate');}"
            "  sb.player.playbackRate=1;}};"
            "const {fn,sandbox}=compileFunction('startTelemetry',sb);"
            "fn();"
            "if(sandbox.player.playbackRate!==1){"
            "throw new Error('a new session inherited a stale playbackRate of '+sandbox.player.playbackRate);}"
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
        contain nested declarations.

        The optional `async` prefix is matched: `async function switchRendition`
        is just as much a function declaration as a synchronous one, and an
        anchor that skipped it would report the caller as missing."""
        start = re.search(r"(?m)^([ \t]*)(?:async\s+)?function " + re.escape(name) + r"\(", source)
        if not start:
            return None
        indent = start.group(1)
        rest = source[start.end():]
        nxt = re.search(r"(?m)^" + re.escape(indent) + r"(?:async\s+)?function ", rest)
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

    def test_playout_target_is_identical_on_both_receivers(self):
        """The playout target must be set on BOTH receivers, at the SAME value.

        The two tracks play out of one <video> element and Chrome honours each
        receiver's buffer depth independently (measured live: unwritten audio
        sat at ~933ms while targeted video sat at ~271ms — a ~660ms constant
        lip-sync offset). The element keeps video presentation on the audio
        clock, so ANY difference between the two targets is lip-sync error, not
        a contained setting: the old AUDIO_PLAYOUT_CAP_MS=400 turned the 1s
        Cinema default into a permanent 600ms audio-early offset for every
        fresh viewer, and skewed accommodated sessions (video 2200 / audio 400)
        by 1.8s. A raise is silent buffering in NetEQ and every lower is
        already step-limited to 50ms/tick, so identical writes keep the two
        surfaces in lockstep under either reading of the spec's
        larger-of-the-two rule."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "reapplyBufferTargets")
        self.assertIsNotNone(body, "reapplyBufferTargets not found")
        self.assertIn("kind === 'audio'", body,
                      "audio must be targeted too, or the shared target is set by neglect")
        self.assertNotIn("AUDIO_PLAYOUT_CAP_MS", body,
                         "audio must receive the SAME target as video — a cap "
                         "re-introduces a lip-sync offset of cap-minus-target")
        # ontrack and the manual mode switch must write both kinds as well, so
        # the 1s stats tick is never the only thing keeping the two in step.
        self.assertIn("applyPlayoutDelay(event.receiver, event.track.kind)",
                      code, "ontrack must target both kinds as they arrive")
        # The latency-mode switch must retarget EVERY receiver, immediately, with
        # the SAME target for both kinds -- an override argument here would
        # re-introduce exactly the lip-sync offset this test exists to prevent.
        #
        # This asserts the property, not one spelling of the call. The call is
        # currently written `if (r.track && applyPlayoutDelay(r, r.track.kind))`
        # so the boolean return can drive the latch rule; an earlier form was
        # `if (r.track) { applyPlayoutDelay(...); }`. Both satisfy the invariant,
        # and pinning either one turns this into a change-detector.
        switch_at = code.find("latencyModeBtn.addEventListener('click'")
        self.assertGreater(switch_at, 0, "the latency-mode switch must exist at all")
        # Bound the window to the HANDLER BODY, not an arbitrary character
        # count: the retarget loop sits ~2.9 KB into the listener (past the
        # mode table, the localStorage write and the adaptive resets), so a
        # fixed slice silently excluded it and every assertion below passed
        # vacuously -- including on a build that only retargeted video.
        switch_end = code.find("\n    });", switch_at)
        self.assertGreater(switch_end, switch_at, "the latency-mode listener must be bounded")
        switch_body = code[switch_at:switch_end]
        self.assertIn("getReceivers()", switch_body,
                      "the latency-mode switch must walk every receiver, not just one")
        self.assertIn("applyPlayoutDelay(r, r.track.kind)", switch_body,
                      "the latency-mode switch must retarget both receivers immediately, "
                      "with the same target for audio and video")
        # ...and it must NOT filter the loop by kind. The lip-sync bug this test
        # exists for is precisely "only the video receiver was retargeted".
        # A regex for a guarded call misses the inline form
        # (`if (r.track && r.track.kind === 'video' && applyPlayoutDelay(...))`),
        # where the filter sits INSIDE the condition, so the check is structural:
        # take the text between the receiver loop and the call and require that
        # no kind comparison appears in it.
        call_at = switch_body.find("applyPlayoutDelay(r, r.track.kind)")
        self.assertGreater(call_at, 0, "the retarget call must be inside the handler")
        loop_at = switch_body.rfind("forEach", 0, call_at)
        self.assertGreater(loop_at, 0, "the retarget must happen inside a receiver loop")
        between = switch_body[loop_at:call_at]
        self.assertNotRegex(between, r"\.kind\s*===",
                            "the latency-mode switch must not gate the playout write on a "
                            "track kind: that retargets only one receiver and reintroduces "
                            "the audio/video lip-sync offset")

    def test_stress_raise_releases_on_a_clock_not_a_quiet_streak(self):
        """The raise must not latch.

        This is the cause of "receivers feel a small but continuous lag while the
        streamer, on a direct local path, feels none". The raise held until 20
        CONSECUTIVE calm seconds (jitter under 25ms AND loss under 0.8%) before
        taking even one 25-50ms step, and with several steps to unwind that is
        minutes of extra permanent latency. A mobile viewer's jitter sits around
        the 55ms raise threshold and essentially never sustains below 25ms for 20
        straight seconds, so it latched on the first blip and stayed there. "Not
        stressed" is already the signal that the cushion is unneeded, so the
        release must key off that rather than off near-perfect calm."""
        code = self._strip_comments(self.app, "js")
        idx = code.find("const stressed = (lastNetJitterMs")
        self.assertGreater(idx, 0, "the stress predicate was not found")
        window = code[idx:idx + 3000]
        self.assertIn("raiseReleaseTicks", window,
                      "the release must run on its own tick clock")
        self.assertNotRegex(window, r"calmRunSec >= 20 && \(adaptiveRaiseLevelMs !== 0",
                            "gating each release step behind 20 consecutive calm seconds "
                            "latches the raise for minutes on a mobile link")
        # The hold must still exist: this is a level, not a countdown.
        self.assertIn("adaptiveRaiseLevelMs = ADAPTIVE_RAISE_MS", window,
                      "the raise must still latch WHILE the link is stressed")

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
        armed = code.find("gatherCap = setTimeout(() => finish('6s cap reached')")
        polled = code.find("pollRoutable();", armed - 600 if armed > 0 else 0)
        self.assertGreater(armed, 0, "the gather cap is missing")
        self.assertGreater(polled, 0, "the routable poll is never started")
        self.assertLess(armed, polled,
                        "the gather cap must be armed before pollRoutable() is first called, "
                        "or the poll's window guard kills the loop on tick one")
        # The window must also be OPEN before the poll, and the poll must read
        # that attempt-local flag rather than the shared module global: a
        # superseded attempt can null the global out from under the live one,
        # which silently kills this whole loop.
        opened = code.find("gatherOpen = true;")
        self.assertGreater(opened, 0, "the gather window is never opened")
        self.assertLess(opened, polled,
                        "the window must be opened before pollRoutable() is first called")
        self.assertIn("if (routableSettle || !gatherOpen) return;", code,
                      "the poll must guard on the attempt-local window flag, not "
                      "the shared module global a superseded attempt can null")

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
        # Comments first. This page's own comment block explains at length why
        # `display=optional` was tried and reverted, and a raw substring search
        # finds that explanation and reports the very fix the test exists to
        # forbid as still present. The test was written before the comment
        # described the decision, and never ran, so nothing caught the
        # contradiction. The assertion is about the stylesheet link, so read
        # the markup with its prose removed.
        markup = re.sub(r"(?s)<!--.*?-->", "", html)
        self.assertIn("fonts.googleapis.com", markup)
        self.assertIn("display=swap", markup,
                      "the brand fonts must still be able to load on a slow uplink")
        self.assertNotIn("display=optional", markup,
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
        """`switchSeamPending` must survive the SYNCHRONOUS part of switchRendition
        and still be true when control reaches the first `await`, or the seam
        branch in ontrack is unreachable dead code and every rendition switch
        falls through to appending to the stale stream.

        Two distinct ways to break this, both shipped at some point:

        1. Clearing the flag a couple of lines after arming it, in the same
           synchronous block.
        2. Arming the flag and THEN calling `cleanupConnection(true)`, which
           clears the flag itself as part of its teardown — clobbering the arm
           synchronously, with no `await` in between and therefore nothing in
           the source text between the two statements to notice. This is the
           one that was live, and it is invisible to any "is the flag cleared
           between arming and the await?" scan, because the clear happens in a
           CALLEE.

        So the ordering is asserted directly, and a clear inside the window is
        only tolerated when it sits in a deferred timer callback (the 12s safety
        net legitimately disarms itself), never as straight-line code.
        """
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "switchRendition")
        self.assertIsNotNone(body, "switchRendition not found")

        arm = body.find("switchSeamPending = true;")
        self.assertGreater(arm, 0, "the seam is never armed")
        teardown = body.find("cleanupConnection(true)")
        self.assertGreater(teardown, 0, "the keep-picture teardown is missing")
        self.assertLess(
            teardown, arm,
            "switchSeamPending is armed BEFORE cleanupConnection(true), which clears "
            "the flag itself — the arm is undone synchronously and the seam can "
            "never be observed true",
        )

        end = body.find("await new Promise(r => setTimeout(r, 200))", arm)
        self.assertGreater(end, arm, "the first await after arming was not found")
        window = body[arm:end]
        for offset, line in enumerate(window.splitlines()):
            if "switchSeamPending = false" not in line:
                continue
            # A clear is only legal inside a deferred callback. The 12s safety
            # net disarming itself is fine; straight-line code is not, because it
            # runs before the first await can ever yield to ontrack.
            self.assertIn(
                "setTimeout", window[: window.find(line)],
                "switchSeamPending is cleared as straight-line code between arming "
                "and the first await, which makes the seam dead code",
            )
            self.assertIsNotNone(offset)

    def test_seam_safety_net_cancels_itself_and_the_flags_do_not_latch(self):
        """The 12s safety net exists to convert a seam that never lands into a
        real reconnect. It could not: it called connectStream() while
        `isConnecting` was still true from the abandoned attempt, and
        connectStream() returns immediately when `isConnecting || isConnected`
        — so the "recovery" silently did nothing and the viewer was left on a
        torn-down session with a null srcObject and no attempt in flight."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "switchRendition")
        self.assertIsNotNone(body, "switchRendition not found")
        arm = body.find("switchSeamTimer = setTimeout(")
        self.assertGreater(arm, 0, "the seam safety net is missing")
        window = body[arm: arm + 1600]
        reconnect = window.find("connectStream()")
        self.assertGreater(reconnect, 0, "the safety net does not reconnect")
        before = window[:reconnect]
        self.assertIn("isConnected = false", before,
                      "the safety net must clear isConnected before reconnecting")
        self.assertIn("isConnecting = false", before,
                      "the safety net must clear isConnecting before reconnecting, "
                      "or connectStream() refuses to start and the viewer is wedged")

    def test_seam_is_closed_by_any_track_that_takes_over_the_element(self):
        """The flag and its 12s net are only cleared by the seam branch, which
        requires a VIDEO track. A WHEP answer routinely delivers AUDIO first,
        and that first track is the one that rebuilds `player.srcObject` — via
        the `elementStreamSessionId !== currentSessionId` branch, which set the
        session id but left the net armed. Twelve seconds later it fired on a
        session that was already healthy: pause the element, null srcObject,
        teardown, and a refused reconnect.

        So every branch that hands the element a stream belonging to the CURRENT
        session must close the seam, not only the video one.
        """
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "closeRenditionSeam")
        self.assertIsNotNone(body, "closeRenditionSeam not found")
        self.assertIn("switchSeamPending = false", body,
                      "closing the seam must clear the pending flag")
        self.assertIn("clearTimeout", body,
                      "closing the seam must cancel the 12s safety net")

        # Every `elementStreamSessionId = currentSessionId` assignment means the
        # element now belongs to this session — which is exactly the moment the
        # seam is over.
        assignments = [m.start() for m in re.finditer(
            r"elementStreamSessionId = currentSessionId;", code)]
        self.assertGreaterEqual(len(assignments), 3,
                                "expected the initial, rebuild and seam assignments")
        for pos in assignments:
            self.assertIn("closeRenditionSeam()", code[pos: pos + 240],
                          "a branch that hands the element this session's stream must "
                          "close the rendition seam, or the 12s net fires on a healthy "
                          "session and wedges the player")

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

    def test_seam_is_armed_after_the_teardown_that_clears_it(self):
        """The regression this pins is subtler than the one above, and the test
        above could not see it.

        `switchRendition` armed the seam and THEN called
        `cleanupConnection(true)`. But cleanupConnection owns the seam's
        lifetime — it cancels the safety net and clears the flag on every
        teardown path (it must: Stage 2 and every graceful ICE teardown go
        through it) — so that call destroyed the flag one statement after it
        was set, and the seam stayed dead.

        The text scan in test_seam_pending_is_actually_left_set passed
        throughout, because the clearing statement lives in a DIFFERENT
        function. Only the ORDER of the two calls proves anything, so that is
        what is asserted here."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "switchRendition")
        self.assertIsNotNone(body, "switchRendition not found")
        arm = body.find("switchSeamPending = true;")
        teardown = body.find("cleanupConnection(true)")
        self.assertGreater(arm, 0, "the seam is never armed")
        self.assertGreater(teardown, 0, "switchRendition must still tear the old session down")
        self.assertLess(teardown, arm,
                        "cleanupConnection clears switchSeamPending, so the seam must be "
                        "armed AFTER it or the seam is dead code again")

    def test_seam_safety_net_can_actually_reconnect(self):
        """The 12s seam safety net could not recover, which turned it into the
        thing it was written to prevent.

        On a healthy switch it fired anyway (its only success-path cancel lives
        inside the unreachable seam branch). When it did fire it blanked the
        element and called cleanupConnection(), but cleanupConnection only
        releases resources — it never clears isConnected/isConnecting, and
        handleConnected() had set isConnected = true for the replacement
        session. connectStream() therefore hit its own duplicate guard and
        returned without doing anything.

        The resulting state was `player.srcObject === null`,
        `peerConnection === null`, `isConnected === true` — and every recovery
        path is gated off by exactly that combination: the freeze watchdog needs
        a peerConnection AND an unpaused element, the stats loop needs a
        connected peerConnection, rVFC needs frames, and the status poll skips
        while isConnected. The viewer was left with a permanent black screen
        that only a manual reload could clear.

        The fix is to clear the flags before reconnecting, so the net
        genuinely reconnects instead of winding the session down."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "switchRendition")
        self.assertIsNotNone(body, "switchRendition not found")
        net = body.find("switchSeamTimer = setTimeout(")
        self.assertGreater(net, 0, "the seam safety net is not armed")
        window = body[net:net + 900]
        self.assertIn("connectStream()", window, "the net must attempt a reconnect")
        clear_connected = window.find("isConnected = false;")
        clear_connecting = window.find("isConnecting = false;")
        self.assertGreater(clear_connected, 0,
                           "the net must clear isConnected before reconnecting, or "
                           "connectStream() no-ops and leaves a permanent black screen")
        self.assertGreater(clear_connecting, 0,
                           "the net must clear isConnecting before reconnecting")
        self.assertLess(clear_connected, window.find("connectStream()"),
                        "the flags must be cleared BEFORE connectStream(), not after")
        self.assertLess(clear_connecting, window.find("connectStream()"),
                        "the flags must be cleared BEFORE connectStream(), not after")

    def test_seam_safety_net_is_cancelled_on_every_teardown_path(self):
        """The net's cancel used to sit INSIDE the `if (keepPicture)`
        early-return, so a full teardown (Stage 3 of freeze recovery,
        handleDisconnected) left the orphan armed. The page painted offline and
        then, 12 seconds later, the orphan fired and reconnected the stream on
        its own — the page flipping offline -> connecting -> live by itself,
        which is precisely what that early return was written to prevent.

        Both statements must therefore sit BEFORE the keepPicture branch."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "cleanupConnection")
        self.assertIsNotNone(body, "cleanupConnection not found")
        self.assertIn("switchSeamTimer", body, "teardown must cancel the seam safety net")
        self.assertIn("switchSeamPending = false", body,
                      "teardown must clear the pending flag so a later session is not hijacked")
        branch = body.find("if (keepPicture)")
        self.assertGreater(branch, 0, "the keepPicture early-return is gone")
        timer = body.find("clearTimeout(switchSeamTimer)")
        flag = body.find("switchSeamPending = false")
        self.assertLess(timer, branch,
                        "the safety-net cancel must run on the full-teardown path too, "
                        "not only inside the keepPicture early-return")
        self.assertLess(flag, branch,
                        "the pending flag must be cleared on the full-teardown path too")

    def test_live_edge_catch_up_replaces_the_black_screen_rejoin(self):
        """Drift was answered with exactly one thing: tear the WHEP session
        down and rebuild it. That costs a 2-4s HARD BLACK SCREEN plus a full
        ICE + WHEP renegotiation to recover what is purely accumulated
        latency — and the dominant source of it is an ordinary Alt-Tab, which
        the project's own measurements put at 1.7-2.8s of delay.

        Every production low-latency player instead speeds the media element up
        to drain the jitter buffer and returns to 1.0x, which costs no black
        frame and no renegotiation. The player had no playbackRate control at
        all (its own comment at the latency-mode table described a "stepwise
        catch-up" that did not exist), so this is the single highest-value
        addition available on the receiver side."""
        app = read_text(APP_PATH)
        self.assertIn("function catchUpPlaybackRate(", app, "catch-up rate law missing")
        self.assertIn("function updateLiveEdgeCatchUp()", app, "catch-up controller missing")
        self.assertIn("player.playbackRate = wanted;", app,
                      "the controller must actually drive playbackRate")
        body = self._js_function_body(self._strip_comments(app, "js"), "superviseAdaptiveBuffer")
        self.assertIn("updateLiveEdgeCatchUp()", body,
                      "the stats supervisor must drive live-edge catch-up")
        # It must run BEFORE the teardown branch, otherwise the rejoin fires on
        # the very first drifted tick and catch-up never gets a chance to help.
        catch_up = body.find("updateLiveEdgeCatchUp()")
        rejoin = body.find("rejoinCapMs")
        self.assertGreater(catch_up, 0, "catch-up must be invoked by the supervisor")
        self.assertLess(catch_up, rejoin,
                        "catch-up must be attempted BEFORE the hard-rejoin branch")
        # The hard path must still exist as an escalation.
        self.assertIn("switchRendition(activeStreamPath", body,
                      "the hard rejoin must remain as the escalation when catch-up stalls")

    def test_live_edge_catch_up_is_bounded_and_self_verifying(self):
        """Two failure modes make catch-up worse than not having it, and both
        are guarded:

        1. An unbounded rate. `playbackRate` is not a nudge, it is a direct
           multiplier, so a formula that scales with the raw delay turns a 5s
           drift into a fast-forward. It is capped.
        2. A mechanism that does not work. Some engines accept the write and
           ignore it; a link too congested for 8% to matter looks identical.
           Either way the viewer would sit at a permanently elevated rate with
           the real problem untreated, so the controller PROVES the drain and
           disables itself if the delay does not fall."""
        app = read_text(APP_PATH)
        self.assertIn("const CATCHUP_MAX_RATE = 1.08;", app,
                      "the catch-up rate must be capped, and the cap is shared with "
                      "the self-verification so the two cannot diverge")
        self.assertIn("catchUpProvenUseless", app,
                      "a catch-up that fails to drain must disable itself")
        body = self._js_function_body(self._strip_comments(app, "js"), "updateLiveEdgeCatchUp")
        self.assertIn("catchUpProvenUseless = true", body,
                      "self-verification must exist inside the controller")
        self.assertIn("catchUpProbeDelayMs", body,
                      "the controller must remember the delay it started from")
        # The proof needs a real window and a real comparison, not a flag flip.
        self.assertIn("catchUpProbeAt > 5000", body,
                      "self-verification needs a settling window before judging the drain")
        # ...and it must only judge a SATURATED rate. Judged at any rate above
        # 1.0, the early seconds of the 1%-per-tick ramp are judged on a delay
        # that is still falling, and a healthy refilling buffer gets the
        # working mechanism permanently disabled.
        self.assertIn("catchUpRate >= CATCHUP_MAX_RATE", body,
                      "the drain may only be judged once the rate is saturated; judging a "
                      "slow ramp disables catch-up on healthy links")
        sup = self._js_function_body(self._strip_comments(app, "js"), "superviseAdaptiveBuffer")
        self.assertIn("catchUpProvenUseless", sup,
                      "the supervisor must honour a proven-useless verdict")
        self.assertIn("catchingUp", sup, "the supervisor must know catch-up is engaged")

    def test_catch_up_rate_is_reset_for_every_new_session(self):
        """`playbackRate` is a property of the media ELEMENT, not of the peer
        connection, so it survives every teardown in this file. A session that
        ended while catching up would otherwise hand the next session an
        inherited fast rate the viewer cannot explain or undo. It must be reset
        when a new session starts, and when the tab is backgrounded (where
        presentation is suspended and there is nothing to drain)."""
        app = read_text(APP_PATH)
        self.assertIn("function resetLiveEdgeCatchUp()", app, "the reset helper is missing")
        self.assertIn("player.playbackRate = 1;", app, "the reset must restore 1.0x")
        self.assertGreaterEqual(app.count("resetLiveEdgeCatchUp();"), 2,
                                "a new session and the tab-hide path must both reset the rate")
        body = self._js_function_body(self._strip_comments(app, "js"), "startTelemetry")
        self.assertIn("resetLiveEdgeCatchUp()", body,
                      "every new session must start at 1.0x")

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
        # The threshold is a named constant now; what matters is its VALUE, so
        # the assertion is on the constant, not on a hard-coded 300 inline.
        match = re.search(r"const HEALTHY_RUN_SECONDS\s*=\s*(\d+)\s*;", code)
        self.assertIsNotNone(match, "the healthy-run threshold must be a named constant")
        self.assertGreaterEqual(int(match.group(1)), 300,
                                "only a genuinely long run should mark the bridge as healthy")
        self.assertRegex(code, r"if \(runSeconds >= HEALTHY_RUN_SECONDS\) \{\s*\n\s*lastHealthyRunAt = Date\.now\(\);",
                         "the strike-clearing 30s reset must not be what marks the bridge healthy")
        check = code.find("if (failures >= MAX_CONSECUTIVE_FFMPEG_FAILURES")
        if check > 0:
            # Inline form: the second arm must sit in the same condition.
            window = code[check:check + 400]
            self.assertIn("noHealthyRunFor", window,
                          "the breaker must also trip when the bridge never produces a long run")
        else:
            # Extracted form: the same guarantee now lives in a callable
            # shouldGiveUp(), which test_bridge_retry_budget_is_reachable
            # executes directly.
            self.assertIn("function shouldGiveUp(", code,
                          "the give-up check must be a single testable function")
            self.assertIn("NO_HEALTHY_RUN_LIMIT_MS", code,
                          "the no-healthy-run window must still exist and be named")
            self.assertIn("shouldGiveUp(failures, lastHealthyRunAt",
                          code[code.find("shouldGiveUp(failures"):][:120],
                          "the retry loop must actually consult the breaker")

    def test_bridge_retry_budget_is_reachable(self):
        """The breaker tripped on the FIRST ffmpeg exit, not the tenth.

        `lastHealthyRunAt` was seeded with 0 and the give-up site read it as
        `lastHealthyRunAt ? now - lastHealthyRunAt : Infinity`, so the
        "no healthy run yet" case became `Infinity > 900000` = true and the
        bridge gave up after a single attempt. That made the
        MAX_CONSECUTIVE_FFMPEG_FAILURES = 10 retry budget, the
        `gpuFastFailures >= 2` NVDEC -> CPU fallback, and the 400ms/2s backoff
        ladder unreachable: any one ffmpeg exit (a stall-watchdog kill, an OBS
        reconnect) slept the full GIVE_UP_BACKOFF_MS and exited 1 with the
        renditions dead instead of restarting.

        This executes the real exported shouldGiveUp() over the whole failure
        budget and over the 15-minute no-healthy-run window.
        """
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to exercise the bridge breaker")
        script = """
        const b = require('./codec_bridge.js');
        if (typeof b.shouldGiveUp !== 'function') throw new Error('shouldGiveUp is not exported');
        const T0 = 1750000000000;
        const cap = b.MAX_CONSECUTIVE_FFMPEG_FAILURES;
        // The full consecutive-failure budget must be usable.
        for (let f = 1; f < cap; f++) {
            if (b.shouldGiveUp(f, T0, T0 + f * 1000)) {
                throw new Error('gave up after ' + f + ' failure(s); budget is ' + cap);
            }
        }
        if (!b.shouldGiveUp(cap, T0, T0 + cap * 1000)) {
            throw new Error('the consecutive-failure cap never fires');
        }
        // The second arm must still work: crash-cycling with few failures must
        // still trip once the no-healthy-run window has elapsed...
        if (!b.shouldGiveUp(3, T0, T0 + b.NO_HEALTHY_RUN_LIMIT_MS + 1000)) {
            throw new Error('a crash cycle that never reaches 300s must eventually trip the breaker');
        }
        // ...but not before it.
        if (b.shouldGiveUp(3, T0, T0 + b.NO_HEALTHY_RUN_LIMIT_MS - 60000)) {
            throw new Error('the breaker fired inside its own window');
        }
        // The exact regression: a falsy stamp means "no long run yet", which
        // must NOT be read as an infinitely long gap.
        if (b.shouldGiveUp(1, 0, T0 + 1000)) {
            throw new Error('a falsy lastHealthyRunAt must not trip the breaker on the first exit');
        }
        // And a real wall clock measured from the bridge start behaves the same.
        if (b.shouldGiveUp(1, T0, T0 + 5000)) {
            throw new Error('the first exit inside the window must be retried');
        }
        console.log('breaker budget OK');
        """
        result = subprocess.run([node, "-e", script], cwd=str(ROOT),
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_give_up_breaker_is_not_armed_at_process_start(self):
        """The give-up breaker had `lastHealthyRunAt = 0`, which is falsy, so the
        elapsed-time check took its `: Infinity` branch and
        `Infinity > 15 * 60 * 1000` is UNCONDITIONALLY TRUE. The 15-minute health
        window was therefore never measured from any baseline and the breaker
        fired on the very FIRST ffmpeg exit, with `failures` still 0 — logging
        "giving up after 0 failed attempts".

        That nullified the entire retry design. Every exit shorter than 300s — an
        OBS auto-reconnect, a host stall, a 35s crash cycle, all of which the code
        around it was explicitly written to survive — slept the 60s backoff with
        no transcoder running and exited. Under runOnAvailableRestart that
        re-launches the hook, which republishes with overridePublisher and KICKS
        the healthy publisher, dropping the RTMP connection and tearing down every
        WHEP session on the path; the loop repeated until MediaMTX's hook budget
        was gone and the renditions stayed dead for the rest of the broadcast.

        So: the baseline must exist and must be a real timestamp, and the
        Infinity fallback must be gone.

        This guard is deliberately IMPLEMENTATION-AGNOSTIC. Two branches fixed
        the identical bug two different ways — seeding `lastHealthyRunAt` with
        the process start, or keeping an explicit "no long run yet" sentinel and
        falling back to the process start at the give-up site — and a test that
        pinned one spelling failed the moment the other was merged in, even
        though both are correct. It asserts the PROPERTY (a falsy/absent stamp
        can never be read as an infinite gap) and accepts either spelling.
        The arithmetic counterpart is executed against the real decision
        function by `test_bridge_retry_budget_is_reachable`, which is a
        stronger check than a regex over the source text.
        """
        code = self._strip_comments(self.bridge, "js")
        self.assertNotIn("let lastHealthyRunAt = 0;", code,
                         "0 is falsy, so the check falls through to its Infinity branch "
                         "and the breaker fires on the first ffmpeg exit")
        self.assertNotIn(": Infinity", code,
                         "a no-healthy-run window measured from Infinity is "
                         "unconditionally expired, so the breaker is armed at birth")
        # A real baseline must exist: either the stamp is seeded from this
        # process's own start, or "no long run yet" is an explicit sentinel.
        self.assertTrue(
            re.search(r"lastHealthyRunAt\s*=\s*(?:BRIDGE_STARTED_AT|bridgeStartedAt)", code)
            or re.search(r"let lastHealthyRunAt\s*=\s*null;", code),
            "the health window needs a real baseline: seed the stamp from the "
            "process start, or mark 'no long run yet' with an explicit sentinel",
        )
        # And the give-up site must actually reach that baseline rather than
        # treating a falsy stamp as an infinite gap: either it falls back to the
        # start-time constant, or the decision function owns the fallback.
        self.assertTrue(
            re.search(r"lastHealthyRunAt\s*\|\|\s*(?:BRIDGE_STARTED_AT|bridgeStartedAt)", code)
            or re.search(r"lastHealthyRunAt\s*===\s*null\s*\?\s*(?:BRIDGE_STARTED_AT|bridgeStartedAt)", code)
            or "function shouldGiveUp(" in code,
            "before the first long run the window must be measured from this "
            "process's own start, not from a sentinel that trips the breaker",
        )
        # The window must be a real number of minutes rather than a bare literal
        # that could be tightened to nothing by a later edit.
        grace = re.search(
            r"NO_HEALTHY_RUN_(?:GRACE|LIMIT|GIVE_UP)_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000", code)
        self.assertIsNotNone(grace, "the no-healthy-run window should be expressed in minutes")
        self.assertGreaterEqual(int(grace.group(1)) * 60, 300,
                                "the no-healthy-run window must exceed the 300s health "
                                "threshold it is measured against, or a bridge merely "
                                "between two long runs trips on itself")

    def test_gpu_decode_state_file_cannot_wedge_the_bridge(self):
        """`readGpuDecodeState` returned whatever JSON.parse produced, and
        JSON.parse SUCCEEDS for `null`, `"x"`, `42` and `[1]` — only a
        syntactically invalid file reaches the catch. The callers then assign a
        property on the result (`state[decoder] = ...`), which under this file's
        'use strict' throws `TypeError: Cannot set properties of null` on null
        and on a primitive string/number.

        `rememberGpuDecodeFailure` is called from inside the retry loop with no
        try around it, so that rejected the whole main() and landed in the
        top-level `fatal:` handler — and because the bad file is never
        repaired, every later bridge start repeated it. A persistent wedge, not
        a one-off."""
        code = self._strip_comments(self.bridge, "js")
        body = self._js_function_body(code, "readGpuDecodeState")
        self.assertIsNotNone(body, "readGpuDecodeState not found")
        self.assertIn("typeof parsed !== 'object'", body,
                      "a JSON scalar/array parses successfully but cannot carry "
                      "per-decoder entries; it must be rejected as unusable state")
        self.assertIn("!parsed", body,
                      "a literal `null` parses successfully and would throw on the "
                      "next property assignment")
        self.assertIn("Array.isArray(parsed)", body,
                      "an array parses successfully but assigning a decoder name to "
                      "it does not persist the failure memory")

    def test_bridge_state_file_is_never_assumed_to_be_writable(self):
        """The two writers of the GPU-decode state file must keep their own
        try/catch: the file lives in the temp directory and a locked or
        read-only path is a normal condition, not an exception-worthy one."""
        code = self._strip_comments(self.bridge, "js")
        for name in ("rememberGpuDecodeFailure", "clearGpuDecodeFailure"):
            body = self._js_function_body(code, name)
            self.assertIsNotNone(body, "{} not found".format(name))
            self.assertIn("writeFileSync", body)
            self.assertIn("catch", body,
                          "{} must tolerate an unwritable state file".format(name))

    def test_launcher_detects_a_mediamtx_started_from_another_checkout(self):
        """"config matches mediamtx.yml" must not be able to hide the case where
        the running MediaMTX belongs to a DIFFERENT copy of this project.

        This repo is checked out many times over (a main checkout plus one
        worktree per task) and sibling worktrees usually sit on the SAME commit,
        so their mediamtx.yml files are byte-identical. The launcher's guard
        compares the running instance's VALUES against the file on disk, so in
        that situation every comparison passes and it reports a clean match --
        while `runOnAvailable: node "codec_bridge.js"` is a RELATIVE path
        resolved against MediaMTX's working directory, meaning the bridge
        actually transcoding is the other checkout's file. Editing
        codec_bridge.js then does nothing at all, with the launcher actively
        reassuring you that it is in effect.

        So the guard has to ask WHICH config file the running process was started
        with, which is available from its own command line.
        """
        ps = self.launcher
        self.assertIn("$foreignConfig", ps,
                      "the launcher must detect a reused MediaMTX that was "
                      "started from a different copy of this project")
        self.assertIn("Get-CimInstance Win32_Process", ps,
                      "the running instance's own command line is the signal that "
                      "names the config file it was started with")
        self.assertIn("Resolve-Path -LiteralPath $liveConfigPath", ps,
                      "the live config path must be resolved before it can be "
                      "compared with this checkout's")
        self.assertIn("DIFFERENT copy of this project", ps,
                      "the operator must be told which copy is actually serving")
        # The reassuring message must not be reachable while a foreign config is
        # in use, and must not claim a scope it does not have: the scalar reader
        # is anchored at column 0, so the whole `paths:` block -- which holds the
        # rendition hooks -- is never compared.
        match = re.search(
            r"if \(\$configVerified -and \$compared -gt 0 (-and -not \$foreignConfig)?\) \{",
            ps)
        self.assertIsNotNone(match, "the reuse-branch success condition was not found")
        self.assertIn("-not $foreignConfig", match.group(0),
                      "the 'config matches' message is still reachable while a "
                      "foreign MediaMTX is running")
        self.assertIn("are NOT compared", ps,
                      "the reuse message must state that path-level settings, "
                      "including the codec-bridge hooks, were not compared")
        self.assertIn("runOnAvailable", ps,
                      "the warning must explain that the rendition hook is a "
                      "relative path, since that is why the other copy wins")

    def test_launcher_derives_the_webrtc_udp_port_from_the_config(self):
        """The UDP pre-flight must not be able to drift from the config it guards.

        `$webrtcUdpPort` was the one value in the launcher that was hard-coded
        while everything else is derived from mediamtx.yml, so editing
        `webrtcLocalUDPAddress` left the conflict check probing a port nothing
        binds: the guard silently went dead on exactly the edit it exists to
        catch. It has to be parsed out of the file, with the literal kept only
        as a fallback."""
        ps = self.launcher
        # The literal is kept only as a fallback for a missing/unreadable file,
        # so the thing to prove is that it is OVERRIDDEN from the config, not
        # that it is absent.
        self.assertIn("webrtcLocalUDPAddress", ps,
                      "the WebRTC UDP port must be derived from mediamtx.yml")
        self.assertIn("Select-String", ps,
                      "the port must be read out of the config at launch time")
        derive = re.search(
            r"\$webrtcUdpPort\s*=\s*\$parsedPort", ps)
        self.assertIsNotNone(derive,
                             "the parsed port from mediamtx.yml must actually be "
                             "assigned to $webrtcUdpPort, not merely computed")
        # The derivation must sit after the fallback literal, not before it.
        literal = ps.find("$webrtcUdpPort = 8189")
        self.assertGreaterEqual(literal, 0, "the fallback literal is gone entirely")
        self.assertLess(literal, derive.start(),
                        "the config-derived port must override the fallback literal, "
                        "not be overwritten by it")
        # And it must be read by matching the KEY, not by assuming a fixed line
        # number or column - the same class of drift the fallback literal caused.
        self.assertRegex(
            ps, r"webrtcLocalUDPAddress:\s*\\s\*",
            "the port must be read by matching the webrtcLocalUDPAddress key, "
            "not by assuming a fixed line number or column")
        # And the key it parses must still exist in the config.
        config = read_text(ROOT / "mediamtx.yml")
        self.assertIsNotNone(
            re.search(r"^\s*webrtcLocalUDPAddress:\s*\S*?:(\d{1,5})\s*$", config, re.MULTILINE),
            "webrtcLocalUDPAddress has no parseable port in mediamtx.yml")

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

    def test_launcher_refuses_to_broadcast_from_a_linked_worktree(self):
        """The launcher must refuse to serve from a throwaway checkout.

        This is not hypothetical: the live site on port 3000 was being served
        by a git worktree whose copy of `app.js` had already diverged from the
        real project folder. `server.js` resolves `STATIC_DIR` from its own
        `__dirname` and the launcher starts MediaMTX with the config sitting
        beside it, so a sandbox checkout silently becomes what every viewer
        is served -- while the operator edits a different folder entirely.

        Nothing in the logs says so. The failure mode is a fix that "did
        nothing", or a config change that never takes effect, which is far
        harder to diagnose than a refusal is to accept.

        A linked worktree is identified structurally, not by its path: its
        `.git` is a FILE (a pointer into the real repo's worktree directory),
        whereas the real project's `.git` is a DIRECTORY. Keying on that means
        a worktree at ANY location is caught, and the real project is never
        blocked -- which a path check or a hard-coded folder name would not
        guarantee.
        """
        self.assertIn("Refusing to start from a linked git worktree", self.launcher,
                      "the launcher must refuse to serve a throwaway checkout")
        marker = self.launcher.find("Refusing to start from a linked git worktree")
        window = self.launcher[max(0, marker - 1200): marker]
        self.assertIn(".PSIsContainer", window,
                      "the check must distinguish a worktree (.git is a FILE) from the "
                      "real project (.git is a DIRECTORY); matching on the path or a "
                      "hard-coded folder name would miss every other worktree location")
        # The refusal has to be placed BEFORE anything real is started, or the
        # host would come up and then abort half-way through, leaving MediaMTX
        # or cloudflared orphaned behind it.
        server_at = self.launcher.find("Join-Path $scriptDir 'server.js'")
        guard_at = self.launcher.find("Refusing to start from a linked git worktree")
        self.assertLess(guard_at, server_at,
                        "the worktree refusal must come before the host starts anything")
        mediamtx_at = self.launcher.find("mediamtx_win")
        self.assertLess(guard_at, mediamtx_at,
                        "the worktree refusal must come before MediaMTX is launched, "
                        "or a refused start leaves an orphaned process holding its ports")

    def test_write_queue_comment_arithmetic(self):
        """The comment claimed 2048 packets x 1200 B = 3.3s at 6 Mbps. It is
        2.46 MB, which is ~0.41s — the claim was 8x high, and anyone sizing a
        burst budget from it would be badly wrong. The 2048 value itself is
        sound (measured worst 100ms window is ~5% of the queue)."""
        block = self.config[max(0, self.config.find("writeQueueSize") - 1400):
                            self.config.find("writeQueueSize")]
        self.assertIn("0.41s", block, "the queue-depth arithmetic must be correct")

        # The corrected comment has to NAME the figure it retracted, so a plain
        # "3.3s must not appear" search fails on the very text that documents
        # the fix. What actually matters is that 3.3s is never asserted as the
        # CURRENT figure: every mention must sit in the sentence that retracts
        # it. So each occurrence is checked against its own context rather than
        # banned outright, and re-introducing 3.3s as live arithmetic fails.
        retracted = ("earlier version", "would need", "too high", "retract")
        for match in re.finditer(r"3\.3s", block):
            context = block[max(0, match.start() - 260): match.end() + 260]
            self.assertTrue(
                any(marker in context for marker in retracted),
                "3.3s appears in the writeQueueSize comment without being marked "
                "as the retracted figure: ...{0}...".format(context.strip()))

    def test_grain_background_has_no_fixed_attachment(self):
        """`background-attachment: fixed` is a no-op while html/body's background
        is colour-only (this background propagates to the canvas, and canvas
        backgrounds never scroll) but becomes a real per-scroll repaint cost the
        moment that stops applying. It bought nothing, so it is removed rather
        than left as a trap."""
        css = self._strip_comments(self.css, "css")
        self.assertNotIn("background-attachment", css,
                         "a no-op fixed background attachment is a trap, not a setting")

    # -- fourth pass: the seam orphan, the bridge breaker, the TURN race ----

    def test_seam_timer_is_cleared_on_every_teardown_path(self):
        """The seam's 12s safety net was disarmed only inside the keepPicture
        branch, which is the one call where nothing goes offline.

        Only switchRendition() passes keepPicture=true. The callers the hazard
        was written for — handleDisconnected() and the freeze watchdog's
        Stage 3 — pass nothing, so the orphan stayed armed precisely when it
        was dangerous: a switch whose replacement failed fast painted offline
        and then had the orphan reconnect 12s later on its own; on a healthy
        live session the orphan nulled srcObject (black + no audio) and then
        called connectStream(), which no-ops while isConnected is still true;
        and it forced viewerPausedByChoice=false, resuming a viewer who had
        deliberately paused.

        The old assertion only proved the tokens exist SOMEWHERE in the
        function, which the keepPicture branch satisfied, so it could not catch
        this. The clear must now be positioned before the branch."""
        code = self._strip_comments(self.app, "js")
        body = self._js_function_body(code, "cleanupConnection")
        self.assertIsNotNone(body, "cleanupConnection not found")
        clear_at = body.find("clearTimeout(switchSeamTimer)")
        self.assertGreater(clear_at, 0, "teardown must cancel the seam safety net")
        branch_at = body.find("if (keepPicture)")
        self.assertGreater(branch_at, 0, "the keepPicture branch not found")
        self.assertLess(clear_at, branch_at,
                        "the seam timer must be cleared BEFORE the keepPicture "
                        "branch, or every non-keepPicture teardown leaves the "
                        "12s orphan armed")
        # The pending flag has to move with the timer, or the next session's
        # first ontrack takes the seam branch on a teardown nobody asked for.
        pending_at = body.find("switchSeamPending = false")
        self.assertGreater(pending_at, 0, "teardown must clear the pending flag")
        self.assertLess(pending_at, branch_at,
                        "switchSeamPending must be cleared on every path too")

    def test_bridge_give_up_needs_a_real_healthy_run_not_never(self):
        """`noHealthyRunFor` fell back to Infinity when the bridge had not yet
        produced a >=300s run, and `Infinity > 15 * 60 * 1000` is true — so the
        breaker fired on the FIRST ffmpeg exit of every fresh process, whatever
        the actual failure count.

        This is MediaMTX's runOnAvailable hook with runOnAvailableRestart, and
        a publisher drop closes every WHEP reader on the path, so one transient
        cold-start ffmpeg error took the whole rendition tier down, then slept
        GIVE_UP_BACKOFF_MS (60s) and exited. It also made three documented
        safeguards unreachable: the 10-strike cap, the NVDEC->CPU fallback
        (which needs a second iteration), and the in-process retry."""
        code = self._strip_comments(self.bridge, "js")
        self.assertNotIn(": Infinity", code,
                         "the no-healthy-run window must be measured from a real "
                         "timestamp, never from a sentinel that trips the breaker")
        # The window must fall back to THIS process's own start. That fallback is
        # implemented as the exported shouldGiveUp() (covered behaviourally by
        # test_bridge_retry_budget_is_reachable, which executes it), so assert the
        # BEHAVIOUR here rather than one particular identifier spelling: either
        # the call site falls back to a start-time constant, or the function
        # itself is what receives it.
        self.assertTrue(
            re.search(r"lastHealthyRunAt\s*\|\|\s*(BRIDGE_STARTED_AT|bridgeStartedAt)", code)
            or "function shouldGiveUp(" in code,
            "before the first long run the window must be measured from "
            "this process's own start")
        # The grace must exceed the health threshold it protects against, or a
        # bridge merely sitting between two long runs trips on itself. The named
        # constant may be spelled either way between the two branches.
        grace = re.search(r"NO_HEALTHY_RUN_(?:GRACE|LIMIT)_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000", code)
        self.assertIsNotNone(grace, "the grace window should be expressed in minutes")
        self.assertGreaterEqual(int(grace.group(1)) * 60, 300,
                                "the no-healthy-run grace must exceed the 300s "
                                "health threshold it is measured against")

    def test_client_ice_fetch_outlives_the_server_turn_mint(self):
        """The browser aborted the ICE-config fetch after 2.5s while
        server.js mints Cloudflare credentials with AbortSignal.timeout(4000),
        and it only mints on a cache miss — the first viewer, or the first after
        the half-life renewal. So a cold cache always lost: the fetch threw
        AbortError, the cache was set to null, and the handshake continued with
        host candidates only. For precisely the viewers who need the relay
        (remote/mobile networks that cannot be punched through) that is the
        difference between connecting and never connecting."""
        app = self._strip_comments(self.app, "js")
        fetch_fn = self._js_function_body(app, "fetchIceServers")
        self.assertIsNotNone(fetch_fn, "fetchIceServers not found")
        client_cap = re.search(r"setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*(\d+)\)", fetch_fn)
        self.assertIsNotNone(client_cap, "the ICE fetch abort cap was not found")
        client_ms = int(client_cap.group(1))

        server = self._strip_comments(self.server, "js")
        mint = re.search(r"AbortSignal\.timeout\((\d+)\)", server)
        self.assertIsNotNone(mint, "the server TURN mint timeout was not found")
        server_ms = int(mint.group(1))

        self.assertGreater(client_ms, server_ms,
                           f"the client ICE cap ({client_ms}ms) must outlast the "
                           f"server's TURN mint budget ({server_ms}ms), or a cold "
                           f"cache aborts a request the server is still serving")

        # And the connect watchdog must still cover the whole legitimate stack,
        # or raising the ICE cap just moves the failure into the watchdog.
        connect = self._js_function_body(app, "connectStream")
        self.assertIsNotNone(connect, "connectStream not found")
        watchdog = re.search(r"connectTimeout = setTimeout\(.*?,\s*(\d+)\);", connect, re.DOTALL)
        gather = re.search(r"gatherCap = setTimeout\([^,]+,\s*(\d+)\)", connect)
        post = re.search(r"myPostTimeout = setTimeout\([^,]+,\s*(\d+)\)", connect)
        self.assertIsNotNone(watchdog, "the connect watchdog was not found")
        self.assertIsNotNone(gather, "the ICE gather cap was not found")
        self.assertIsNotNone(post, "the WHEP POST cap was not found")
        self.assertGreater(int(watchdog.group(1)),
                           client_ms + int(gather.group(1)) + int(post.group(1)),
                           "the connect watchdog must exceed ICE fetch + gather + "
                           "WHEP POST, or it fires before a slow viewer can finish")

    def test_reaction_bumps_do_not_force_synchronous_layout(self):
        """Each reaction restarted its animations with
        `classList.remove(c); void el.offsetWidth; classList.add(c)`, which
        forces Blink to run UpdateStyleAndLayout inside the frame. This runs
        for EVERY reaction from EVERY viewer (aggregate capped at 25/s), and
        the count element's bump followed a textContent write that changes the
        element's intrinsic width — dirtying the flex chain up to
        `.reaction-section`, which carries a backdrop-filter. Three barriers
        per reaction is up to 75/s of main-thread work on the decode thread,
        landing exactly when the decoder is closest to its limit."""
        code = self._strip_comments(self.app, "js")
        pop = self._js_function_body(code, "triggerButtonPop")
        self.assertIsNotNone(pop, "triggerButtonPop not found")
        self.assertNotIn("offsetWidth", pop,
                         "restarting the reaction pop must not force a layout")
        self.assertIn("restartCssAnimation", pop,
                      "the pop must go through the reflow-free helper")

        start = code.find("chatSource.addEventListener('reaction'")
        self.assertGreater(start, 0, "the reaction SSE handler was not found")
        handler = code[start:]
        nxt = handler.find("chatSource.addEventListener(", 10)
        if nxt > 0:
            handler = handler[:nxt]
        self.assertNotIn("offsetWidth", handler,
                         "the reaction handler must not force a layout per event")

        helper = self._js_function_body(code, "restartCssAnimation")
        self.assertIsNotNone(helper, "restartCssAnimation not found")
        self.assertNotIn("offsetWidth", helper,
                         "the restart helper must not force a layout")
        self.assertIn("getAnimations", helper,
                      "the restart must address the running animation instead of "
                      "flushing layout")
        # REPLAY, not just "no forced layout". Cancelling a CSS animation does
        # not restart it: the class stays applied, so the computed animation-name
        # never changes and the engine never re-creates it. Verified in Chrome
        # against this exact stylesheet — cancel+add animated the FIRST reaction
        # only, and the button's `forwards` fill made cancel() actively kill a
        # finished animation. Seeking currentTime back to 0 is what replays it,
        # and both animations need a fill-mode so a finished one still exists in
        # getAnimations() to be seeked.
        self.assertNotIn(".cancel()", helper,
                         "cancel() removes the animation without replaying it; "
                         "seek currentTime to 0 instead")
        self.assertIn("currentTime = 0", helper,
                      "the restart must seek the animation back to its start")
        # The animation name is not always the class name (btn-popping vs
        # emoji-btn-pop), so it has to be passed explicitly rather than derived.
        self.assertIn("'btn-popping', 'emoji-btn-pop'", code,
                      "the button's keyframes name must be passed explicitly")

        # count-bump has to be a real keyframe animation: a static class cannot
        # be replayed by re-adding it, and needs a timer to be removed.
        css = self._strip_comments(self.css, "css")
        self.assertRegex(css, r"@keyframes\s+count-bump",
                         "count-bump must be a keyframe animation so it can be "
                         "replayed and left applied without a removal timer")
        rule = self._css_rule(css, ".emoji-count.count-bump")
        self.assertIsNotNone(rule, ".emoji-count.count-bump rule not found")
        self.assertIn("animation", rule,
                      "the bump must be driven by the animation, not static styles")
        self.assertNotIn("!important", rule,
                         "the old static !important styles are what made this "
                         "unreplayable; they belong in the keyframes now")
        # A fill-mode is REQUIRED, not cosmetic: without it the finished
        # animation is dropped from getAnimations(), so there is nothing left to
        # seek on the second reaction onward and the bump plays exactly once.
        self.assertRegex(rule, r"animation:[^;]*\bforwards\b",
                         "count-bump needs fill-mode:forwards so a finished "
                         "animation still exists in getAnimations() to be replayed")
        pop_rule = self._css_rule(css, ".emoji-btn.btn-popping")
        self.assertIsNotNone(pop_rule, ".emoji-btn.btn-popping rule not found")
        self.assertRegex(pop_rule, r"animation:[^;]*\bforwards\b",
                         "the button pop needs fill-mode:forwards for the same reason")
        # A filled animation outranks every normal author declaration, so a 100%
        # frame that restates `transform: scale(1)` would win over `.emoji-btn:hover`
        # and `:active` for the rest of the page's life — the buttons would lose
        # their hover lift and press feedback after the viewer's first reaction.
        # Measured in Chrome: computed transform stayed matrix(1,0,0,1,0,0) on
        # every reaction afterwards. The 100% frame must therefore declare no
        # transform at all, letting the cascade decide the resting state.
        keyframes = re.search(r"@keyframes\s+emoji-btn-pop\s*\{(.*?)\n\}", css, re.DOTALL)
        self.assertIsNotNone(keyframes, "the emoji-btn-pop keyframes were not found")
        final = re.search(r"100%\s*\{([^}]*)\}", keyframes.group(1))
        self.assertIsNotNone(final, "the pop keyframes have no 100% frame")
        self.assertNotIn("transform", final.group(1),
                         "the 100% frame must not declare a transform: a filled "
                         "animation outranks :hover/:active and would pin the "
                         "button to its resting transform permanently")
        # No removal timer should be left behind for the bump.
        self.assertNotIn("classList.remove('count-bump')", code,
                         "the bump ends at its natural state, so it needs no timer")


    def test_chat_notification_fires_only_for_new_messages(self):
        """A notification that replays history is worse than none: on every SSE
        (re)connect the server hands the host its whole 50-message backlog, and
        on the polling fallback path the whole 100-message window. Both arrive
        with isHistory=true, so both must be silent."""
        fn = self._js_function_body(self.app, "handleIncomingMessage")
        self.assertIsNotNone(fn, "handleIncomingMessage not found")
        self.assertIn("!isSelf && !isHistory", fn,
                      "a replayed or self-sent message must not raise a notification")
        self.assertIn("showChatNotification", fn,
                      "new messages must raise the on-screen notification")
        # The init payload is old backlog ONLY on a cold connect. After a native
        # auto-reconnect the server replays Last-Event-ID and sends exactly the
        # messages the client MISSED, so it must not blanket-mark them history.
        self.assertNotIn("data.history.forEach((m) => handleIncomingMessage(m, true));",
                         self.app,
                         "a reconnect replay is the messages this client missed, "
                         "not backlog; marking it history drops every message that "
                         "arrived during a blip")
        init_fn = self._js_function_body(self.app, "connectChatEvents")
        self.assertIn("hadWatermark", init_fn,
                      "the init replay must be classified by whether a watermark "
                      "already existed, not blanket-marked as history")
        self.assertLess(init_fn.index("const hadWatermark"), init_fn.index("data.history.forEach"),
                        "the watermark must be sampled before the batch is applied, "
                        "since applying it advances the variable")


    def test_chat_notification_is_host_only(self):
        """Viewers already have the log open in front of them; a card over the
        video for every viewer message is noise, not notification. isHost is
        only authoritative once the server's init event has been handled, which
        is why the check lives inside the receive path rather than at the top
        of the file."""
        fn = self._js_function_body(self.app, "handleIncomingMessage")
        self.assertIn("if (isHost)", fn,
                      "only the host should get an on-screen chat notification")


    def test_chat_notification_density_is_bounded(self):
        """Each card is a composited layer drawn over live video, on the same
        GPU budget as the decoder. A chatty room would otherwise stack one per
        message, so the stack is capped and a burst folds into a counter."""
        self.assertIn("MAX_CHAT_TOASTS", self.app,
                      "concurrent chat notification cards must be capped")
        self.assertIn("CHAT_TOAST_BURST_MS", self.app,
                      "a burst must be folded instead of stacking a card per message")
        fn = self._js_function_body(self.app, "showChatNotification")
        self.assertIsNotNone(fn, "showChatNotification not found")
        self.assertIn("liveChatToasts >= MAX_CHAT_TOASTS", fn,
                      "the cap must be enforced at the append site")
        # The counter is a real element, not a string that silently no-ops.
        self.assertIn('id="chat-toast-overflow"', read_text(HTML_PATH))


    def test_chat_notification_cards_leave_the_render_tree_when_idle(self):
        """Same rule as .action-feedback / .volume-toast: an over-video layer
        that is idle for the whole session between messages must be hidden
        with visibility, not only opacity, or it keeps a render surface alive
        above the video permanently."""
        css = self._strip_comments(self.css, "css")
        body = self._css_rule(css, ".chat-toast-layer")
        self.assertIsNotNone(body, ".chat-toast-layer rule not found")
        self.assertIn("visibility: hidden", body,
                      "the empty notification layer must be hidden with visibility")
        self.assertIn("pointer-events: none", body,
                      "an empty layer must not swallow clicks meant for the video")
        self.assertIn("visibility: visible", self._css_rule(css, ".chat-toast-layer.active"),
                      "the layer must become visible while it holds cards")


    def test_chat_notification_does_not_blur_the_video(self):
        """A backdrop-filter directly over the <video> forces a render surface
        and re-samples the video texture on every decoded frame."""
        css = self._strip_comments(self.css, "css")
        body = self._css_rule(css, ".chat-toast-layer")
        self.assertNotIn("backdrop-filter: blur", body,
                         "the notification layer is drawn over live video and must not blur it")
        card = self._css_rule(css, ".chat-toast")
        self.assertIsNotNone(card, ".chat-toast rule not found")
        self.assertNotIn("backdrop-filter: blur", card,
                         "a notification card is drawn over live video and must not blur it")


    def test_clicking_a_notification_does_not_toggle_playback(self):
        """The card is deliberately clickable (it jumps to the chat), so it sits
        inside .video-container — which has its own click/dblclick handlers that
        toggle play/pause and fullscreen. Without the ignore entry, answering a
        viewer would pause the broadcast. The wheel handler needs it too: a card
        sits under the pointer, so scrolling one changed the volume."""
        for handler in ("click", "dblclick", "wheel"):
            anchor = "videoContainer.addEventListener('" + handler + "'"
            start = self.app.find(anchor)
            self.assertGreater(start, 0, "videoContainer {} handler not found".format(handler))
            # The guard is a chain of closest() calls joined by ||, so the scan
            # has to span the whole `if` condition rather than stop at the
            # first ')' — that is the end of the FIRST clause, not the chain.
            window = self.app[start:start + 700]
            self.assertIn("'.chat-toast-layer'", window,
                          "the {} handler must ignore events on a chat notification "
                          "(clicking one would pause the stream; the wheel would "
                          "change the volume)".format(handler))


    def test_chat_notification_escapes_viewer_text(self):
        """Author and body are untrusted viewer input. A card built with
        innerHTML would be a stored-XSS sink on every viewer's screen."""
        code = self._js_function_body(self._strip_comments(self.app, "js"), "showChatNotification")
        self.assertIn("innerText", code,
                      "viewer-supplied text must be written with innerText")
        # Comments are stripped for BOTH halves: the function's own comment
        # explains WHY it avoids innerHTML, and it also contains the literal
        # word "innerText" — a naive check on unstripped source is satisfied by
        # the explanation of the fix rather than by the fix.
        self.assertNotIn("innerHTML", code,
                         "innerHTML on viewer text is an XSS sink")


    def test_polling_fallback_catch_up_is_not_treated_as_new(self):
        """A client whose EventSource failed falls back to polling. The FIRST
        poll sends since=0, and the server reads 0 as 'send everything'
        (server.js), so that response is the entire backlog rather than a
        delta. Marking it as new made the host raise a notification for every
        message already in the log — up to the 100-message cap — at exactly the
        moment the connection was already struggling."""
        fn = self._js_function_body(self.app, "startPollingFallback")
        self.assertIsNotNone(fn, "startPollingFallback not found")
        self.assertNotIn("handleIncomingMessage(m, false)", fn,
                         "the since=0 catch-up response is the whole backlog, "
                         "not new messages")
        self.assertIn("isCatchUp", fn,
                      "the first poll must be marked as a catch-up replay")
        self.assertIn("handleIncomingMessage(m, isCatchUp)", fn,
                      "the catch-up flag must actually reach the receive path")
        # The watermark must be sampled BEFORE the await. handleIncomingMessage
        # advances lastReceivedMessageId as the batch is applied, so a value
        # read afterwards could already have moved and misclassify a batch that
        # began at 0 as a delta.
        code = self._js_function_body(self._strip_comments(self.app, "js"),
                                      "startPollingFallback")
        sample = code.find("const since = lastReceivedMessageId")
        fetch = code.find("await fetch")
        self.assertGreater(sample, -1,
                           "the watermark must be captured into a local, not re-read later")
        self.assertGreater(fetch, -1, "no fetch found in the poll body")
        self.assertLess(sample, fetch,
                        "the watermark must be captured before the await, or a "
                        "batch that advanced it mid-apply reads as a delta")
        # The decision must use the SNAPSHOT, not the live variable. Sampling
        # early is pointless if the comparison still reads the mutable global
        # after handleIncomingMessage has advanced it.
        self.assertRegex(
            code, r"const isCatchUp = since === 0 && !chatStreamPrimed;",
            "isCatchUp must compare the pre-await snapshot; re-reading "
            "lastReceivedMessageId after the fetch restores the race this fix removed")
        # A since=0 poll is only a BACKLOG replay while nothing has ever been
        # received. Once the client is primed, a still-zero watermark just means
        # the log is empty, and the response is live traffic that must notify.
        self.assertIn("chatStreamPrimed = true;", self.app,
                      "the client must be marked primed once a baseline exists")
        init = self._js_function_body(self.app, "connectChatEvents")
        self.assertIn("chatStreamPrimed = true", init,
                      "the SSE init handler must mark the stream primed")
        # The polling path must be able to prime ITSELF. It is reachable with no
        # init handler at all: a throwing EventSource constructor returns before
        # the listener is attached, and a non-200 / wrong-MIME EventSource goes
        # to CLOSED without reconnecting. With the flag written only by init,
        # every polled message stayed classified as backlog and the host was
        # never notified again for the whole session.
        self.assertIn("chatStreamPrimed = true", fn,
                      "the poll body must prime the client, or the polling-only "
                      "path never notifies again after the first catch-up")
        # ...and the write must come AFTER the classification, or the very
        # first poll would stop being a catch-up. Compared on the FIRST
        # occurrence of each: the body legitimately contains one priming write,
        # and a last-occurrence search would sail straight past an illegally
        # EARLY one and still find the correct one further down.
        self.assertLess(fn.index("const isCatchUp"), fn.index("chatStreamPrimed = true"),
                        "priming must happen after the batch is classified, or the "
                        "first since=0 poll is no longer treated as a catch-up")
        # A cursor from before a restart is outside the new history window, so
        # the server returns retained messages instead of filtering them away.
        self.assertRegex(self.server, r"const replayable = Number\.isFinite\(sinceId\)",
                         "the server must decide replayability before it filters")
        self.assertRegex(
            self.server,
            r"replayable \? chatHistory\.filter\(\(m\) => m\.id > sinceId\) : chatHistory",
            "a since=0 poll is not replayable, so it must return the whole history")


    def test_chat_toast_layer_always_goes_idle(self):
        """The layer is pointer-events:auto while `active`, over the video. The
        folded '+N more' counter is the last thing holding it active, and
        nothing cleared it: one burst left a permanently visible, permanently
        clickable invisible box in the corner of the player's hit area, and the
        pill never went away. It needs its own expiry."""
        self.assertIn("scheduleChatOverflowRetire", self.app,
                      "the folded counter must retire on its own clock")
        fn = self._js_function_body(self.app, "scheduleChatOverflowRetire")
        self.assertIsNotNone(fn, "scheduleChatOverflowRetire not found")
        self.assertIn("chatToastOverflow = 0", fn,
                      "the expiry must actually zero the counter")
        self.assertIn("classList.remove('active')", fn,
                      "the layer must be released once the counter retires")
        # Folding must arm the timer, or the expiry above is unreachable.
        show = self._js_function_body(self.app, "showChatNotification")
        self.assertIn("scheduleChatOverflowRetire", show,
                      "every folded message must arm the counter's expiry")
        # Clicking through retires it too: the host is going to the log.
        # Scoped to the click handler, NOT the whole file: a bare
        # `assertIn("clearChatOverflow", self.app)` is satisfied by the function
        # DEFINITION, so deleting the only call site left that dead function
        # still passing — which is exactly the state the handler was once in.
        click = self.app.index("chatToastLayer.addEventListener('click'")
        self.assertGreater(click, -1, "the notification click handler is missing")
        handler = self.app[click:click + 700]
        self.assertIn("clearChatOverflow()", handler,
                      "acting on a notification must retire the folded counter; "
                      "a definition alone is dead code")
        self.assertIn("clearChatUnread()", handler,
                      "acting on a notification must retire the unread count")


    def test_chat_unread_badge_is_hidden_at_zero_and_cleared_on_read(self):
        """A '0' badge that never clears is worse than no badge: it trains the
        host to ignore the one thing the badge exists to signal."""
        render = self._js_function_body(self.app, "renderChatUnread")
        self.assertIsNotNone(render, "renderChatUnread not found")
        self.assertIn("chatUnreadBadge.hidden = true", render,
                      "a zero count must hide the badge rather than render '0'")
        self.assertIn("MAX_CHAT_UNREAD", self.app,
                      "the label must be capped so it cannot reflow the tab strip")
        tab = self._js_function_body(self.app, "activateSidebarTab")
        self.assertIn("clearChatUnread", tab,
                      "opening the chat by hand must retire the unread count")
        self.assertIn('.tab-unread-badge[hidden]', self.css,
                      "[hidden] must beat the badge's display, or '0' renders")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class StudioOverlayVisibilityChecks(unittest.TestCase):
    """Regression guards for the studio page's `hidden` overlays.

    The defect these pin is a CSS-cascade trap, not a logic error, so no amount
    of reading studio.js reveals it: every line of the publish path is correct
    and the page still cannot be used.

    The `hidden` attribute is honoured by a USER-AGENT-origin
    `[hidden] { display: none }` rule. Every author-origin declaration beats the
    user-agent origin regardless of specificity, so a class rule carrying its
    own `display` silently defeats the attribute for the life of the page.
    studio.html ships five elements with `hidden` whose class rules all set
    `display`:

        #studio-busy        .studio-busy         display: flex
        #studio-toast       .studio-toast        display: flex
        #studio-meters      .studio-meters       display: flex
        #source-info        .studio-source-info  display: flex
        #btn-stop           .studio-btn          display: inline-flex

    The visible symptom was that clicking "Start broadcasting" appeared to hang
    forever on a spinner reading "Starting broadcast…". In truth the broadcast
    never began: .studio-busy is `position: fixed; inset: 0; z-index: 70`, so on
    the very first paint it covered the entire viewport with its dimmed,
    blurred backdrop — and, being above everything, it swallowed every click,
    so the button underneath was never reachable in the first place. studio.js's
    `setBusy()` correctly assigns `busy.hidden`, and the assignment has no
    effect. That is why the console and the network log were both empty and the
    page looked permanently busy.

    This is the same defect class already fixed once on the VIEWER page, where
    the grouped `.player-loader, .player-offline-overlay, .unmute-overlay` rule
    sets display:flex for all three and style.css had to give .player-loader and
    .unmute-overlay an explicit `display: none` default (style.css:502). One
    attribute-selector rule fixes the whole class here.
    """

    def setUp(self):
        self.css = read_text(ROOT / "studio.css")
        self.html = read_text(ROOT / "studio.html")
        self.js = read_text(ROOT / "studio.js")

    @staticmethod
    def _strip_comments(text, kind):
        opener = r"(?:^|(?<=\s))[ \t]*/\*"
        if kind == "css":
            return re.sub(opener + r".*?\*/", "", text, flags=re.DOTALL | re.MULTILINE)
        without_block = re.sub(opener + r".*?\*/", "", text, flags=re.DOTALL | re.MULTILINE)
        return re.sub(r"(?m)^[ \t]*//.*$", "", without_block)

    @staticmethod
    def _css_rule(css, selector):
        match = re.search(r"(?m)^[ \t]*" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
        return match.group(1) if match else None

    def test_hidden_attribute_is_honoured_despite_author_display_rules(self):
        """The one rule that makes `hidden` work at all.

        `!important` is required and is not over-reach: it is the only way an
        attribute selector can win against the author-origin `display` on the
        five class rules below, since those are in the same origin and would
        otherwise be decided by source order alone.
        """
        css = self._strip_comments(self.css, "css")
        hidden = self._css_rule(css, "[hidden]")
        self.assertIsNotNone(
            hidden,
            "studio.css has no [hidden] rule, so the user-agent default is the "
            "only thing hiding these elements — and any author `display` beats it")
        self.assertRegex(
            hidden, r"display\s*:\s*none\s*!important",
            "the [hidden] rule must be `display: none !important`; a plain "
            "`display: none` loses to the class rules it has to override")

    def test_no_author_display_can_outrank_the_hidden_rule(self):
        """The cascade itself, not just the presence of the `[hidden]` rule.

        Checking that `[hidden]` exists is not enough, because it is only the
        winner while nothing outranks it. Two things can beat it, and both are
        ordinary edits somebody will eventually make to this stylesheet:

          - importance: a `display: ... !important` on a class rule. `[hidden]`
            and `.studio-busy` are both specificity (0,1,0) in the same origin,
            so between two `!important` declarations the LAST ONE IN SOURCE
            ORDER wins. `.studio-busy` sits far below the `[hidden]` rule, so
            adding `!important` to the class rule silently reinstates the
            original bug with the fix still in place.
          - specificity: a selector that outranks the attribute selector, or a
            selector list, either of which also defeats the single-class lookup
            the other tests in this class rely on.

        So this walks the stylesheet and fails if any author `display` declared
        after the `[hidden]` rule is marked `!important` for a selector that
        could match one of the elements the markup ships hidden. That is the
        exact shape of the regression that made this page unusable, and it is
        invisible to a test that only asserts the rule is present.
        """
        css = self._strip_comments(self.css, "css")

        hidden_at = css.find("[hidden]")
        self.assertGreater(hidden_at, 0, "the [hidden] rule is missing entirely")

        classes_in_use = set()
        for tag in re.findall(r"<[a-zA-Z][^>]*>", self.html):
            if not re.search(r"\shidden(?=[\s/>])", tag):
                continue
            for name in re.findall(r'\bclass="([^"]*)"', tag):
                classes_in_use.update(name.split())
        self.assertIn(
            "studio-busy", classes_in_use,
            "the busy overlay is no longer shipped hidden; if that is deliberate "
            "the whole start-busy contract needs revisiting, not a test update")

        offenders = []
        for match in re.compile(r"([^{}]+)\{([^}]*)\}").finditer(css):
            selector, body = match.group(1), match.group(2)
            if match.start() < hidden_at or "[hidden]" in selector:
                continue
            if not re.search(r"!\s*important", body):
                continue
            display = re.search(r"(?<![\w-])display\s*:\s*([a-z-]+)", body)
            if display is None or display.group(1) == "none":
                continue
            for class_name in sorted(classes_in_use):
                if re.search(r"(?<![\w-])\." + re.escape(class_name) + r"(?![\w-])",
                             selector):
                    offenders.append((selector.strip(), display.group(1), class_name))
                    break

        self.assertEqual(
            offenders, [],
            "an author `display: ... !important` after the [hidden] rule (source "
            "order wins at equal specificity) would repaint on first paint and "
            "brick the studio again: {0}".format(offenders))

    def test_every_hidden_element_is_still_reachable_by_the_class_lookup(self):
        """Close the hole a silent `continue` would leave.

        `_css_rule`, used throughout this class, matches a single class selector
        at the start of a line. Grouping selectors -- `.studio-busy,
        .studio-overlay { ... }` -- is the single most likely future edit to
        this stylesheet, and it would make that lookup return nothing at all.
        The other tests would then quietly stop examining the element instead
        of reporting anything, which is how a guard becomes decorative. So
        each element shipped hidden must still be resolvable, and the total
        must be accounted for rather than passed over.
        """
        css = self._strip_comments(self.css, "css")
        checked = 0
        for tag in re.findall(r"<[a-zA-Z][^>]*>", self.html):
            if not re.search(r"\shidden(?=[\s/>])", tag):
                continue
            id_match = re.search(r'\bid="([^"]+)"', tag)
            if not id_match:
                continue
            element_id = id_match.group(1)
            class_match = re.search(r'\bclass="([^"]*)"', tag)
            self.assertIsNotNone(
                class_match,
                "#{} ships `hidden` with no class attribute".format(element_id))
            classes = class_match.group(1).split()
            self.assertTrue(
                classes,
                "#{} ships `hidden` with an empty class attribute".format(element_id))
            for class_name in classes:
                if self._css_rule(css, "." + class_name) is None:
                    # Not necessarily wrong on its own -- a class may have no
                    # rule -- but it must be a decision rather than an accident
                    # of the lookup being unable to parse a grouped selector.
                    self.assertNotRegex(
                        css, r"(?m)^[ \t]*\." + re.escape(class_name) + r"\s*,",
                        "#{} uses .{}, which now appears in a GROUPED selector. "
                        "_css_rule matches only a single class selector, so this "
                        "element is no longer examined by any test in this class "
                        "-- split the rule or teach the helper selector lists".format(
                            element_id, class_name))
                checked += 1
        self.assertGreaterEqual(
            checked, 5,
            "expected the five elements studio.html ships hidden, but only {0} "
            "class pairings were reachable. If a markup change is intended, say "
            "so here rather than letting the coverage quietly shrink".format(checked))


    def test_busy_overlay_is_released_by_setbusy(self):
        """The overlay must actually be dismissible.

        Worth pinning separately because a fix that only hid the overlay on
        load would leave the studio permanently unusable in the other
        direction. setBusy(false) has to restore it, and the only mechanism it
        has is the same `hidden` attribute, so this keeps the UI contract and
        the stylesheet fix tied together.
        """
        self.assertIn("busy.hidden = !isBusy", self.js,
                      "setBusy() must drive the overlay through the `hidden` "
                      "attribute, which is what the [hidden] CSS rule honours")
        self.assertIn("setBusy(false)", self.js,
                      "nothing releases the busy overlay once the publish "
                      "succeeds, so the spinner would outlive the broadcast")

    def test_busy_overlay_cannot_swallow_the_whole_page(self):
        """Defence in depth for the one overlay that covers the viewport.

        The bug was silent precisely because a full-screen element above every
        control looks identical to a page that is still working. Were `hidden`
        ever defeated again, letting clicks pass through the idle state would
        keep the studio usable and degrade the failure to a cosmetic one.
        """
        css = self._strip_comments(self.css, "css")
        busy = self._css_rule(css, ".studio-busy")
        self.assertIsNotNone(busy, ".studio-busy rule not found")
        self.assertIn("position: fixed", busy)
        self.assertIn("inset: 0", busy,
                      "if the overlay ever stops covering the viewport this "
                      "test is guarding a different layout; re-check it")
        self.assertIn("pointer-events: none", busy,
                      "the full-screen busy overlay must not intercept clicks "
                      "while it is idle, or one CSS regression bricks the page")


if __name__ == "__main__":
    unittest.main(verbosity=2)
