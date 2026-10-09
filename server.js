'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { URL } = require('url');
const { execFileSync } = require('child_process');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MEDIAMTX_HOST = '127.0.0.1';
// Overridable only so local checks can point the proxy at a stub upstream;
// production always uses MediaMTX's default signaling port 8889.
const MEDIAMTX_PORT = Number.parseInt(process.env.MEDIAMTX_PORT || '8889', 10);
// MediaMTX's control API (used by the player's status probe at /stream-api/v3/**)
// listens on a separate port from WebRTC signaling.
const MEDIAMTX_API_PORT = Number.parseInt(process.env.MEDIAMTX_API_PORT || '8888', 10);
const STATIC_DIR = __dirname;

// --- Which checkout is this process actually serving? ------------------------
// STATIC_DIR is __dirname, so every copy of the project serves ITS OWN files.
// This machine has ~20 sibling `Streaming'` worktrees plus a main checkout, and
// a linked worktree binds to the same ports: editing one and opening
// http://127.0.0.1:3000/streaming/ while a DIFFERENT worktree holds port 3000
// shows the wrong code with no error anywhere. Nothing looks broken - the page
// renders, chat works, the stream plays - it is simply not the code that was
// just edited, so every "my fix did nothing" conclusion drawn from that page is
// wrong. Verified on this machine: port 3000 was held by worktree 06893 while
// the edits were being made in 96c6b.
//
// The answer therefore has to be printed where the operator is already looking
// (the launcher window) and also exposed to the browser, which is where the
// "it did not change" observation actually comes from. Best-effort throughout:
// a non-git directory, a missing git, or a slow repo must never stop the host.
let checkoutDescription = null;
function describeCheckout() {
    // Memoised. This is called once per HTTP response to stamp a header, and
    // re-running it would spawn `git` TWICE PER REQUEST - a synchronous child
    // process on the same thread that serves video signaling. The values cannot
    // change while the process runs: the serving directory is __dirname and the
    // checked-out branch/SHA are fixed for its lifetime.
    if (checkoutDescription) return checkoutDescription;
    let branch = 'unknown';
    let sha = 'unknown';
    try {
        const run = (...gitArgs) => execFileSync('git', gitArgs, {
            cwd: STATIC_DIR,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        }).trim();
        branch = run('rev-parse', '--abbrev-ref', 'HEAD');
        sha = run('rev-parse', '--short', 'HEAD');
    } catch (_) {
        // Not a git checkout, or git is unavailable. The resolved path below is
        // still the authoritative answer, so leave the placeholders.
    }
    // A linked worktree has a .git FILE pointing at the real repo's
    // worktrees/<name> admin dir; the main checkout has a .git DIRECTORY. That
    // distinction is the whole reason two copies can silently fight over one
    // port, so surface it explicitly.
    let linkedWorktree = false;
    try {
        linkedWorktree = fs.statSync(path.join(STATIC_DIR, '.git')).isFile();
    } catch (_) { /* no .git at all */ }
    checkoutDescription = { dir: STATIC_DIR, branch, sha, linkedWorktree };
    return checkoutDescription;
}

// --- Which copy is running, for the browser side ----------------------------
// The banner above is what the operator sees in the launcher window. This is
// the same fact for the other place it is actually needed: a stale server from
// another worktree answers /stream-api/** perfectly happily, so any check run
// against localhost:3000 silently validates the OTHER checkout. Edits then
// appear to have no effect, or worse, appear to be verified when they were never
// exercised at all.
//
// Loopback-only. It reports a local filesystem path and the process id, which is
// operator-facing diagnostics and nothing more - publishing it would tell anyone
// who can reach the public tunnel the operator's username and directory layout.
// isDirectLocal() is the same test that gates the HOST chat badge, so the two
// agree on who counts as local.
const HOST_DIR = path.resolve(__dirname);
const HOST_STARTED_AT = new Date().toISOString();

function handleHostInfo(req, res) {
    if (!isDirectLocal(req)) {
        res.writeHead(403, setCorsHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL
        }));
        res.end(JSON.stringify({ error: 'Host diagnostics are local-only.' }));
        return;
    }
    const body = JSON.stringify({
        dir: describeCheckout().dir,
        branch: describeCheckout().branch,
        sha: describeCheckout().sha,
        pid: process.pid,
        startedAt: HOST_STARTED_AT
    });
    res.writeHead(200, setCorsHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CACHE_CONTROL,
        'Content-Length': Buffer.byteLength(body)
    }));
    res.end(body);
}
const CACHE_CONTROL = 'no-store, no-cache, must-revalidate, max-age=0';
// Static page assets are version-busted via ?v= in index.html, so browsers may
// keep them but must revalidate (ETag) before reuse. This turns every repeat
// page load into a ~200-byte 304 instead of a full re-download of app.js +
// style.css, without ever serving a stale file. Proxied signaling/API
// responses above and below keep CACHE_CONTROL (no-store): a stale path-state
// answer would make the player wrongly believe the stream is online or offline.
const STATIC_CACHE_CONTROL = 'no-cache, must-revalidate';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT must be a valid TCP port; received ${process.env.PORT}`);
}

if (!Number.isInteger(MEDIAMTX_PORT) || MEDIAMTX_PORT < 1 || MEDIAMTX_PORT > 65535) {
    throw new Error(`MEDIAMTX_PORT must be a valid TCP port; received ${process.env.MEDIAMTX_PORT}`);
}

if (!Number.isInteger(MEDIAMTX_API_PORT) || MEDIAMTX_API_PORT < 1 || MEDIAMTX_API_PORT > 65535) {
    throw new Error(`MEDIAMTX_API_PORT must be a valid TCP port; received ${process.env.MEDIAMTX_API_PORT}`);
}

// Cloudflare TURN relay (README: "Cloudflare Tunnel + TURN"). The API token
// stays on this server: browsers only ever see short-lived credentials minted
// at /stream-api/turn. When the key/token are unset (LAN or Tailscale-only
// hosting) the endpoint answers with an empty list, so ICE behaves exactly as
// it did before (interface host candidates, no external servers).
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_KEY_TOKEN = process.env.CF_TURN_KEY_TOKEN || '';
// Overridable only so local checks can point the mint call at a stub upstream.
const CF_TURN_API_BASE = process.env.CF_TURN_API_BASE || 'https://rtc.live.cloudflare.com';
const CF_TURN_TTL_SECONDS = Number.parseInt(process.env.CF_TURN_TTL_SECONDS || '3600', 10);

if (!Number.isInteger(CF_TURN_TTL_SECONDS) || CF_TURN_TTL_SECONDS < 60 || CF_TURN_TTL_SECONDS > 86400) {
    throw new Error(`CF_TURN_TTL_SECONDS must be an integer between 60 and 86400; received ${process.env.CF_TURN_TTL_SECONDS}`);
}

// Cloudflare's public STUN (no account or credentials needed): it gives every
// viewer a server-reflexive (public) candidate so it can hole-punch a direct
// path to this host — the primary remote-viewing path that needs no card.
// Verified reachable from this network (binding request answered with a public
// mapped address). It is the only STUN server allowed anywhere in this
// project; Google STUN was historically unreliable from here.
const CF_STUN_ENTRY = Object.freeze({ urls: ['stun:stun.cloudflare.com:3478'] });

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8'
};

// Pool TCP connections to MediaMTX instead of opening a fresh loopback
// connection per request. Every viewer generates a steady request flow
// (status probe every 5s, ICE config, WHEP handshakes) — reusing warm
// sockets removes the connect/teardown jitter from each of those round
// trips and keeps signaling latency flat as the room grows. maxSockets is
// left generous so a burst of simultaneous WHEP handshakes never queues.
const MEDIAMTX_AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });

// Connection-scoped headers that must never be relayed to an upstream (RFC 9110
// §7.6.1). Forwarding them creates conflicting message framing (a request
// smuggling surface against MediaMTX) and defeats the keep-alive pool above.
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

// RFC 9110 §7.6.1: any header NAMED in the request's Connection field is
// hop-by-hop for that message, and the list is attacker-controlled. Filtering
// only the fixed set above would still relay `Connection: X-Smuggled` together
// with `X-Smuggled`, which is the actual request-smuggling surface.
function connectionNominatedHeaders(headers) {
    const raw = headers.connection;
    if (typeof raw !== 'string') return new Set();
    return new Set(raw.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean));
}

const STATIC_FILES = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/streaming', 'index.html'],
    ['/streaming/', 'index.html'],
    ['/streaming/index.html', 'index.html'],
    // In-browser broadcaster (the "no OBS install" path). It publishes over
    // WHIP to the same `live` path OBS uses, so the two coexist: whichever
    // publisher is newest owns the path (mediamtx.yml sets overridePublisher),
    // and the studio warns before taking over rather than silently cutting the
    // other feed. Aliased the same way index.html is, because the tunnel and
    // Tailscale both rewrite to /streaming/**.
    ['/studio', 'studio.html'],
    ['/studio/', 'studio.html'],
    ['/studio/index.html', 'studio.html'],
    ['/streaming/studio', 'studio.html'],
    ['/streaming/studio/', 'studio.html'],
    ['/streaming/studio/index.html', 'studio.html'],
    // The earlier broadcaster remains available under its own routes; the
    // player-facing /studio URL above stays on the current studio page.
    ['/broadcast', 'broadcast.html'],
    ['/broadcast/', 'broadcast.html'],
    ['/broadcast/index.html', 'broadcast.html'],
    ['/streaming/broadcast', 'broadcast.html'],
    ['/streaming/broadcast/', 'broadcast.html'],
    ['/streaming/broadcast/index.html', 'broadcast.html'],
    ['/style.css', 'style.css'],
    ['/streaming/style.css', 'style.css'],
    ['/studio.css', 'studio.css'],
    ['/streaming/studio.css', 'studio.css'],
    ['/app.js', 'app.js'],
    ['/streaming/app.js', 'app.js'],
    ['/studio.js', 'studio.js'],
    ['/streaming/studio.js', 'studio.js'],
    ['/broadcast.js', 'broadcast.js'],
    ['/streaming/broadcast.js', 'broadcast.js'],
    // Loaded by the studio itself: the RTP encoded-transform worker and the
    // AudioWorklet PCM tap. Both are fetched by URL at runtime (new Worker()
    // and audioWorklet.addModule()), so they must be in the allowlist exactly
    // like any other page asset or they 404 and the studio cannot go live.
    ['/broadcast_worker.js', 'broadcast_worker.js'],
    ['/streaming/broadcast_worker.js', 'broadcast_worker.js'],
    ['/broadcast_audio_worklet.js', 'broadcast_audio_worklet.js'],
    ['/streaming/broadcast_audio_worklet.js', 'broadcast_audio_worklet.js'],
]);

// Writes the CORS headers onto a response, replacing any that are already there.
//
// The replacement is not optional. Node lower-cases every header name it reads
// off an upstream socket, so a proxied response arrives as
// `access-control-allow-origin` (lowercase) while these keys are written
// capitalised. Assigning `headers['Access-Control-Allow-Origin']` therefore
// ADDS a second, differently-cased key instead of overwriting the first, and
// res.writeHead emits both. A duplicated `Access-Control-Allow-Origin` makes a
// browser reject the whole response as a CORS failure — a bare "TypeError:
// Failed to fetch" in JS, with no clue which header caused it. It is currently
// latent only because the page and the API are same-origin (CORS is not
// enforced for same-origin requests), which is exactly the kind of thing that
// breaks the first time someone embeds the player from another host or moves
// the API behind a different origin.
function setCorsHeaders(headers) {
    // Delete every case variant of the four names we are about to set, so the
    // result is exactly one of each rather than a mixture of cases.
    for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'access-control-allow-origin'
            || lower === 'access-control-allow-methods'
            || lower === 'access-control-allow-headers'
            || lower === 'access-control-expose-headers') {
            delete headers[name];
        }
    }
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    // `If-Match` is required by the WHIP trickle-ICE PATCH and the session
    // DELETE. `Content-Type` has to stay here because `application/sdp` is not
    // a CORS-safelisted value, so the studio's WHIP POST preflights.
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, If-Match';
    // A WHIP publisher reads four headers off the 201: Location (the resource
    // to DELETE on teardown), plus ETag/ID/Link, which MediaMTX emits and a
    // browser cannot see unless they are named here. Only Location was exposed
    // before, which was enough for WHEP (the player only ever needed the
    // session URL) and not enough for WHIP.
    headers['Access-Control-Expose-Headers'] = 'Location, ETag, ID, Link, Accept-Post, Accept-Patch';
    return headers;
}

// MediaMTX's control API is unauthenticated by default, and the whole thing is
// published publicly through the Cloudflare Tunnel. Forwarding /stream-api/v3/**
// verbatim therefore handed the internet an unauthenticated remote-control
// surface for the media server: `PATCH /v3/config/global/set` to rewrite the
// configuration, `DELETE /v3/paths/list/live-h264/readystate` to kill the
// broadcast mid-stream, `GET /v3/config/global/get` to read back credentials.
//
// The player and the studio only ever need ONE endpoint: a read-only GET of the
// path list (app.js status probe + rendition poll, studio.js takeover check).
// Everything else is refused here, before the proxy is ever reached.
const ALLOWED_API_ROUTES = new Set(['/stream-api/v3/paths/list']);

function isAllowedControlApiRequest(pathname, method) {
    if (!ALLOWED_API_ROUTES.has(pathname)) return false;
    // Read-only. A GET/HEAD is the whole legitimate surface; PATCH/PUT/DELETE on
    // this path would be a write against the control plane.
    return method === 'GET' || method === 'HEAD';
}

function proxyToMediaMTX(req, res, requestUrl) {
    const targetPath = requestUrl.pathname.slice('/stream-api'.length) || '/';
    // MediaMTX splits its HTTP surfaces: the control API (status probes) listens on
    // MEDIAMTX_API_PORT, WebRTC/WHIP signaling on MEDIAMTX_PORT. Route by prefix so
    // /stream-api/v3/** reaches the API.
    const targetPort = requestUrl.pathname.startsWith('/stream-api/v3/') ? MEDIAMTX_API_PORT : MEDIAMTX_PORT;
    // Hop-by-hop headers (RFC 9110 §7.6.1) describe THIS connection and must not
    // be forwarded by an intermediary. Copying them all also breaks the thing
    // MEDIAMTX_AGENT exists for: a client `connection: close` would otherwise
    // travel upstream and tear down a pooled socket, forcing a fresh TCP
    // connection to MediaMTX on every proxied request.
    const headers = {};
    const nominated = connectionNominatedHeaders(req.headers);
    for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
        headers[name] = value;
    }
    headers.host = `${MEDIAMTX_HOST}:${targetPort}`;
    const proxyReq = http.request({
        host: MEDIAMTX_HOST,
        port: targetPort,
        path: `${targetPath}${requestUrl.search}`,
        method: req.method,
        headers,
        agent: MEDIAMTX_AGENT
    }, (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        // Never let browsers cache proxied signaling/API responses — a stale path-state
        // answer would make the player wrongly believe the stream is online or offline.
        responseHeaders['cache-control'] = CACHE_CONTROL;

        if (responseHeaders.location) {
            try {
                const upstreamOrigin = `http://${MEDIAMTX_HOST}:${targetPort}`;
                const location = new URL(responseHeaders.location, upstreamOrigin);
                if (location.origin === upstreamOrigin) {
                    responseHeaders.location = `/stream-api${location.pathname}${location.search}${location.hash}`;
                }
            } catch (error) {
                console.warn('[Proxy] Could not rewrite MediaMTX Location header:', error.message);
            }
        }

        res.writeHead(proxyRes.statusCode, setCorsHeaders(responseHeaders));
        // The upstream RESPONSE stream needs its own error handling, and the
        // proxyReq handler below cannot cover it. Once MediaMTX has sent
        // response headers the request side is already complete, so any later
        // failure (MediaMTX restarted or crashed mid-body, a proxy in front of
        // it reset the connection) is reported on `proxyRes` — and
        // `proxyRes.pipe(res)` does NOT forward errors to the destination.
        // With nothing listening, `res` was never ended and never destroyed:
        // the client's fetch() neither resolved nor rejected, so the player's
        // 5s status probe hung forever and its reconnect loop stalled on a
        // request that would never settle, while the ServerResponse, the
        // IncomingMessage and the client socket were retained for the lifetime
        // of the process — one permanent leak per interrupted request. The
        // 30s proxyReq.setTimeout does not help: the socket is already gone by
        // then, so the timer is cleared without ever firing.
        //
        // `aborted` is emitted alongside `error` for a truncated body on some
        // Node versions, so both are handled and the handler is idempotent.
        const abortUpstream = () => {
            if (res.destroyed || res.writableEnded) return;
            // Headers are already on the wire, so there is no status code left
            // to change: cutting the connection is the only honest signal, and
            // appending an error body would corrupt the partial payload.
            res.destroy();
        };
        proxyRes.on('error', abortUpstream);
        proxyRes.on('aborted', abortUpstream);
        // A clean upstream end is the normal path; pipe() calls res.end().
        proxyRes.pipe(res);

        // A response that dies AFTER its headers is reported on proxyRes, never
        // on proxyReq -- so the error handler below cannot see it, and pipe()
        // does not forward source errors to the destination. The client's
        // socket was therefore simply left open forever: measured against an
        // upstream that destroys the socket mid-body, the client saw no end,
        // no abort and no error in 40s, well past the 30s cap above, which only
        // arms while there is still no response and so never fires once the
        // body is in flight. A hung status probe is the one failure this
        // function's timeout exists to prevent: it freezes the player's
        // reconnect loop with no error to retry on. Cut the partial response so
        // the client fails fast, leaving recovery to its own retry.
        //
        // Idempotent by construction: res.destroy() sets res.destroyed
        // synchronously, so whichever of the three events fires first acts and
        // the rest fall through the guard. 'close' with an incomplete message
        // is the backstop for Node versions that emit neither of the others.
        const cutPartialResponse = (reason) => {
            if (res.writableEnded || res.destroyed) return;
            console.warn(`[Proxy] MediaMTX response from ${MEDIAMTX_HOST}:${targetPort} `
                + `ended early (${reason}); cutting the partial response.`);
            res.destroy();
        };
        proxyRes.on('aborted', () => cutPartialResponse('upstream aborted'));
        proxyRes.on('error', (error) => cutPartialResponse(error.code || error.message));
        proxyRes.on('close', () => {
            if (!proxyRes.complete) cutPartialResponse('upstream closed before the body completed');
        });
    });

    // Cap the wait on MediaMTX: a hung response would stall the player's status
    // probe indefinitely and freeze its reconnect loop. Normal WHEP handshakes
    // and API answers complete in well under a second (ICE gathering is capped
    // client-side at 3s), so 30s only binds on a genuinely stuck upstream.
    proxyReq.setTimeout(30000, () => {
        proxyReq.destroy(new Error('no response from MediaMTX within 30s'));
    });

    proxyReq.on('error', (error) => {
        // The viewer navigated away or aborted the probe; the socket is gone.
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
            // Upstream failed mid-stream: cut the partial response instead of
            // appending an error body to already-sent bytes (which would
            // corrupt the payload the client is downloading).
            res.destroy();
            return;
        }
        console.error(`[Proxy] MediaMTX at ${MEDIAMTX_HOST}:${targetPort} is unavailable:`, error.message);
        // setCorsHeaders matters here as much as on any other branch: without it
        // this 502 is an opaque CORS failure in the browser, so the one message
        // that actually tells the operator what to do is never seen.
        res.writeHead(502, setCorsHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL
        }));
        res.end(JSON.stringify({ error: 'MediaMTX is not running. Start the host with start_host.bat.' }));
    });

    // Forward client aborts upstream. Without this, a WHEP POST abandoned by a
    // closing tab still completes against MediaMTX and leaves a reader session
    // forwarding video to nobody, burning upload bandwidth until it times out.
    // On a normal completed response writableFinished is true and nothing is
    // destroyed, so pooled sockets are never touched.
    res.on('close', () => {
        if (!res.writableFinished && !proxyReq.destroyed) {
            proxyReq.destroy();
        }
    });

    req.pipe(proxyReq);
}

// --- Cloudflare TURN credential minting ------------------------------------
// One mint is shared by every viewer until half its TTL has elapsed, so
// a full room costs a single Cloudflare API call per hour, not one per viewer.
let turnMintCache = { iceServers: null, renewAt: 0, retryAt: 0 };

// Mints may include STUN entries and the alternate port-53 URL (blocked by
// browsers); only turn:/turns: URLs pass through here — the handler prepends
// the canonical Cloudflare STUN entry itself.
function turnOnlyIceServers(servers) {
    if (!Array.isArray(servers)) {
        return [];
    }
    return servers
        .map((entry) => {
            if (!entry) {
                return null;
            }
            const urls = Array.isArray(entry.urls) ? entry.urls : (entry.urls ? [entry.urls] : []);
            const kept = urls.filter((url) => typeof url === 'string'
                && (url.startsWith('turn:') || url.startsWith('turns:'))
                && !/:53(?:\?|$)/.test(url));
            return kept.length ? { ...entry, urls: kept } : null;
        })
        .filter(Boolean);
}

async function mintTurnIceServers() {
    if (!CF_TURN_KEY_ID || !CF_TURN_KEY_TOKEN) {
        return [];
    }
    const now = Date.now();
    if (turnMintCache.iceServers && now < turnMintCache.renewAt) {
        return turnMintCache.iceServers;
    }
    if (now < turnMintCache.retryAt) {
        return [];
    }
    try {
        const response = await fetch(
            `${CF_TURN_API_BASE}/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${CF_TURN_KEY_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ttl: CF_TURN_TTL_SECONDS }),
                signal: AbortSignal.timeout(4000)
            }
        );
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        turnMintCache.iceServers = turnOnlyIceServers(payload && payload.iceServers);
        // Renew at half-life instead of TTL-300s: under the old schedule a
        // mint served at the tail of its window carried only ~5 minutes of
        // validity, while viewers cache this answer for 10 minutes (app.js) —
        // so a reconnect could present Cloudflare with EXPIRED credentials,
        // which kills the TURN allocation (Cloudflare FAQ: allocations are
        // disconnected once their credentials expire). At TTL/2 every served
        // mint keeps at least TTL/2 of validity (default 30 min vs the 10 min
        // viewer cache), making an expired-credential reconnect impossible.
        // The bound is additionally clamped to the credential's own lifetime so
        // a SHORT TTL (Cloudflare's minimum is 60s) can never schedule renewal
        // at or past expiry, which would serve credentials that are already
        // dead and silently drop the TURN allocation.
        const ttlMs = CF_TURN_TTL_SECONDS * 1000;
        turnMintCache.renewAt = now + Math.max(1000, Math.min(ttlMs / 2, ttlMs - 5000));
        console.log(`[TURN] Minted relay credentials (${turnMintCache.iceServers.length} TURN entries).`);
    } catch (error) {
        // Any failure just means "host candidates only" for the next 30s; a
        // viewer on the LAN or in the tailnet never needs TURN to connect.
        console.error(`[TURN] Credential mint failed (${error.message}); serving host-candidate-only ICE.`);
        turnMintCache.retryAt = now + 30000;
    }
    return turnMintCache.iceServers || [];
}

function handleTurnCredentials(req, res) {
    mintTurnIceServers().then((turnEntries) => {
        // Cloudflare STUN is served unconditionally (free, cardless); TURN
        // entries are appended only when CF_TURN_KEY_* credentials exist.
        const iceServers = [CF_STUN_ENTRY, ...turnEntries];
        const body = JSON.stringify({ iceServers });
        res.writeHead(200, setCorsHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL,
            'Content-Length': Buffer.byteLength(body)
        }));
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(body);
    }).catch((error) => {
        console.error(`[TURN] Unexpected error while serving credentials: ${error.message}`);
        res.writeHead(502, setCorsHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
        res.end('502 TURN credentials unavailable');
    });
}

// --- Realtime Chat System --------------------------------------------------
const MAX_CHAT_HISTORY = 100;
const MAX_MESSAGE_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 30;
const chatHistory = [];
const chatSubscribers = new Set();
const reactionCounts = { heart: 0, fire: 0, clap: 0, laugh: 0, thumbs: 0 };
const chatRateLimits = new Map();
const reactionRateLimits = new Map();
// Hard ceiling on bytes an SSE subscriber may have buffered without reading.
// write()===false cannot detect this early enough on its own (the kernel
// socket buffer absorbs megabytes first), so the bytes are counted here.
const SSE_MAX_QUEUED_BYTES = 256 * 1024;
// Seed from wall time so a normal restart cannot reuse ids held by an open
// browser. This range remains exactly representable in JavaScript numbers.
let lastChatMessageId = Date.now() * 1000;

function isDirectLocal(req) {
    const ip = req.socket && req.socket.remoteAddress;
    const isLoopbackIp = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const hasProxyHeaders = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    return isLoopbackIp && !hasProxyHeaders;
}

// Client identity for rate limiting.
//
// `x-forwarded-for` is attacker-controlled: any client that reaches this server
// directly (LAN, Tailscale, or the tunnel's own origin) can set it to anything,
// and a unique value per request is a unique rate-limit key per request. The
// old `cf-connecting-ip || x-forwarded-for || socket` chain therefore allowed
// the per-IP reaction limit to be bypassed outright (verified: 60 reactions
// with 60 distinct X-Forwarded-For values produced 60× 200 and zero 429s), and
// also let one client fill the rate-limit map with one entry per spoofed string
// — each retained for the sweep interval against a 2s window.
//
// The forwarded headers are therefore only honored when this process is
// actually configured to sit behind the Cloudflare tunnel, which is the one
// deployment that rewrites them. Otherwise the real socket address is used:
// loopback for the tunnel, or the Tailscale/LAN address for a direct viewer.
// Behind the Cloudflare Tunnel, cloudflared connects over LOOPBACK, so
// req.socket.remoteAddress is 127.0.0.1 for EVERY remote viewer: keying the
// limit on the socket put the whole room in one bucket, and a single chatty
// viewer locked everyone else out of chat and reactions (verified: 8 messages
// from one client produced [200,200,200,200,200,429,429,429] for every viewer).
//
// cf-connecting-ip is the header Cloudflare overwrites on every proxied request,
// so its value cannot be chosen by the caller - but that guarantee comes from
// Cloudflare, not from this process, so it is honoured ONLY when the request
// actually arrived over loopback. server.listen() binds 127.0.0.1, so in the
// shipped deployment the only peers are cloudflared and local tools. The loopback
// test is what keeps that true if the bind address is ever widened to a LAN or
// Tailscale interface: a directly-connecting client could then forge the header,
// and it must not be believed. Trusting it unconditionally was measured to
// reopen the bypass under a different header name (12 spoofed values produced
// 12x200 and zero 429s).
//
// x-forwarded-for stays behind the explicit opt-in for the ordinary reason: any
// client that reaches this server directly can set it to anything, and a unique
// value per request is a unique rate-limit key per request.
const TRUST_FORWARDED_HEADERS = Boolean(
    process.env.CF_TUNNEL_HOST || process.env.TRUST_PROXY_HEADERS === '1'
);
function clientIpForRateLimit(req) {
    const remoteAddress = (req.socket && req.socket.remoteAddress) || '';
    const fromLoopback = remoteAddress === '127.0.0.1'
        || remoteAddress === '::1'
        || remoteAddress === '::ffff:127.0.0.1';
    // `cf-connecting-ip` is the one header Cloudflare itself overwrites on every
    // request arriving through the tunnel, so a client cannot forge it THERE.
    // Behind the tunnel it is also the only way to tell viewers apart at all:
    // this server binds 127.0.0.1, so cloudflared dials it over loopback and
    // every remote viewer would otherwise resolve to the same rate-limit key --
    // one chatty client locking every other viewer out of chat and reactions
    // (verified: 8 messages -> 200,200,200,200,200,429,429,429).
    //
    // TWO conditions are required before it is believed, and neither is
    // sufficient on its own:
    //
    //   TRUST_FORWARDED_HEADERS - the peer address cannot be the signal here.
    //     cloudflared, Tailscale serve and a local client all arrive on loopback
    //     and look identical, so trusting the header on that basis would let a
    //     tailnet or local client mint a fresh bucket per request -- exactly the
    //     bypass the old unguarded x-forwarded-for chain had. start_host.ps1 sets
    //     CF_TUNNEL_HOST only when it actually starts cloudflared, so the
    //     deployment that needs per-viewer limits is the one that enables them.
    //
    //   fromLoopback - that flag keys on CONFIGURATION, not on the connection.
    //     If the bind address is ever widened to a LAN or Tailscale interface, a
    //     directly-connecting client reaches the server and sets the header
    //     itself, and Cloudflare's guarantee does not extend to it. Measured
    //     under unconditional trust: 12 spoofed values produced 12x200 and zero
    //     429s.
    const cfIp = req.headers['cf-connecting-ip'];
    if (TRUST_FORWARDED_HEADERS && fromLoopback
        && typeof cfIp === 'string' && cfIp.trim()) {
        return cfIp.trim();
    }
    // x-forwarded-for stays behind the explicit opt-in for the ordinary reason:
    // any client that reaches this server directly can set it to anything, and a
    // unique value per request is a unique rate-limit key per request.
    if (TRUST_FORWARDED_HEADERS) {
        const xff = req.headers['x-forwarded-for'];
        if (typeof xff === 'string' && xff) {
            // First hop only: the rest of the chain is client-supplied.
            const first = xff.split(',')[0].trim();
            if (first) return first;
        }
    }
    return remoteAddress || 'unknown';
}

// Per-IP reaction limits are only half the story: aggregate rate is
// (per-viewer rate x viewer count), and every accepted reaction is broadcast to
// every viewer, where it becomes an animated layer over live video. A global
// ceiling bounds that aggregate no matter how many viewers there are, or
// how a client chooses to identify itself.
//
// SLIDING window, not a fixed one. The previous implementation reset a counter
// at each wall-clock second boundary, which permits a burst of up to 2x the
// cap across the boundary: 25 accepted reactions at t=999ms and 25 more at
// t=1001ms — 50 in a 2ms span. The cap exists precisely because that aggregate
// is composited as animation layers over live video on every screen in the
// room, so the overshoot lands at exactly the moment the cost is highest. A
// timestamp ring is used instead: every accepted reaction records its time, and
// the check discards anything older than one second, so the invariant is
// "never more than CAP accepted in any trailing 1s window".
const REACTION_GLOBAL_CAP_PER_SEC = 25;
const reactionGlobalStamps = [];

function broadcastChatEvent(eventType, data, eventId) {
    // The SSE id: line is what EventSource replays through Last-Event-ID on a
    // native auto-reconnect — the server already honors that header, so a
    // viewer that blips offline mid-broadcast receives exactly the messages
    // it missed instead of a generic history slice. Non-message events carry
    // no id (EventSource ignores them for replay bookkeeping).
    const payload = (eventId !== undefined ? `id: ${eventId}\n` : '')
        + `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const sub of chatSubscribers) {
        if (!sub.destroyed && !sub.writableEnded) {
            try {
                // Backpressure accounting, using the stream's OWN measure of
                // what is still queued.
                //
                // A hand-rolled running total is wrong here and was actively
                // harmful: `drain` only fires after a write() has previously
                // returned false, so a perfectly HEALTHY reader (every write
                // returns true, _slowWrites stays 0) never drains, never resets,
                // and the accumulator climbs forever — destroying every SSE
                // connection after ~1,300 events (~1.2h of a busy chat), for all
                // viewers at once, each one then auto-reconnecting through
                // EventSource. `writableLength` is Node's authoritative count of
                // bytes currently buffered; it falls back to 0 by itself as the
                // socket drains, so it measures exactly the quantity the guard
                // is supposed to be about.
                // `writableLength` is the stream's own count of what is still
                // queued; it falls back to 0 by itself as the socket drains, so
                // it measures exactly the quantity this guard is about. It is
                // checked BEFORE the lagging short-circuit, because a
                // subscriber that has already been marked lagging stops
                // receiving new writes but keeps draining at its own pace — and
                // the whole point of this check is to notice a subscriber that
                // never drains and free its memory. Ordering it after
                // `continue` made it unreachable for the only subscribers it
                // exists to catch.
                if (sub.writableLength > SSE_MAX_QUEUED_BYTES) {
                    console.warn('[Chat] Destroying an SSE subscriber still holding '
                        + `${sub.writableLength} bytes without reading.`);
                    sub.destroy();
                    continue;
                }
                if (sub._lagging) continue;
                const buffered = sub.write(payload);
                if (buffered) {
                    // Drained quickly enough: the kernel took it.
                    sub._slowWrites = 0;
                } else {
                    sub._slowWrites = (sub._slowWrites || 0) + 1;
                    if (sub._slowWrites > 4) {
                        // The consumer is not keeping up. Stop feeding it
                        // entirely; a chat message is not worth unbounded host
                        // memory, and a dead tab is destroyed by its own
                        // 'close' handler anyway.
                        if (!sub._lagging) {
                            sub._lagging = true;
                            sub._lagSince = Date.now();
                            console.warn('[Chat] SSE subscriber is not reading — pausing its event stream.');
                        }
                    }
                }
            } catch (err) {
                console.warn('[Chat] Failed to write event to subscriber:', err.message);
            }
        }
    }
}

// Connected-viewer count, derived from live SSE subscriptions (every page
// open holds one for its whole lifetime). Broadcast on every change so the
// header viewer counter updates in real time — until now the server only
// sent the count once in the init event and the UI kept a permanent "—".
function broadcastViewerCount() {
    broadcastChatEvent('viewers', { count: chatSubscribers.size });
}

// Sweep stale rate-limit entries: the map is keyed per client IP and each
// entry only matters for a 2s window, so without this it would grow with
// every distinct visitor for the lifetime of the process.
setInterval(() => {
    const cutoff = Date.now() - 2000;
    for (const [ip, stamps] of chatRateLimits) {
        const kept = stamps.filter((ts) => ts > cutoff);
        if (kept.length === 0) {
            chatRateLimits.delete(ip);
        } else if (kept.length !== stamps.length) {
            chatRateLimits.set(ip, kept);
        }
    }
    for (const [ip, stamps] of reactionRateLimits) {
        const kept = stamps.filter((ts) => ts > cutoff);
        if (kept.length === 0) {
            reactionRateLimits.delete(ip);
        } else if (kept.length !== stamps.length) {
            reactionRateLimits.set(ip, kept);
        }
    }
}, 60000).unref();

function readJsonBody(req, maxBytes = 16384) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks = [];
        req.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) {
                // Stop consuming but leave the socket alive: rejecting with a
                // typed error lets the caller answer 413 on a live response.
                // Destroying the request here (the old behavior) closed the
                // connection before any response was written, so the client
                // saw an opaque network error instead of the 413.
                settled = true;
                req.pause();
                const error = new Error(`Payload exceeds the ${maxBytes}-byte limit`);
                error.payloadTooLarge = true;
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                const bodyStr = Buffer.concat(chunks).toString('utf8');
                if (!bodyStr.trim()) {
                    resolve({});
                    return;
                }
                resolve(JSON.parse(bodyStr));
            } catch (err) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

function handleChat(req, res, requestUrl) {
    const subpath = requestUrl.pathname.slice('/stream-api/chat'.length);

    if (subpath === '/events' || subpath === '/events/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, setCorsHeaders({
                'Allow': 'GET, HEAD',
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': CACHE_CONTROL
            }));
            res.end('405 Method Not Allowed');
            return;
        }

        res.writeHead(200, setCorsHeaders({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }));

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const isHost = isDirectLocal(req);
        const lastEventId = Number.parseInt(req.headers['last-event-id'] || requestUrl.searchParams.get('lastId') || '0', 10);
        let initialHistory;
        // Replay is only meaningful for ids inside this process's retained
        // window. A reconnecting page can carry an id from a previous process;
        // when that id falls outside the window, send the retained messages
        // instead of filtering away everything until the counter catches up.
        const replayable = Number.isFinite(lastEventId)
            && lastEventId > 0
            && lastEventId <= lastChatMessageId
            && (!chatHistory.length || lastEventId >= chatHistory[0].id);
        if (replayable) {
            initialHistory = chatHistory.filter((m) => m.id > lastEventId);
        } else {
            initialHistory = chatHistory.slice(-50);
        }

        res.write(`event: init\ndata: ${JSON.stringify({
            isHost,
            history: initialHistory,
            reactionCounts,
            subscriberCount: chatSubscribers.size + 1
        })}\n\n`);

        chatSubscribers.add(res);
        broadcastViewerCount();

        // Dead-viewer detection. An SSE client never sends data, and writes
        // into a half-open socket (viewer's network dropped, tab crashed,
        // laptop slept — common on a hotspot setup) SUCCEED until TCP itself
        // gives up, which can take minutes. Until then the viewer count
        // over-reports and every event buffers into a subscriber nobody will
        // read. TCP keepalive probes the peer: the 15s comment writes below
        // elicit ACKs from live viewers (which reset the probe timer), while
        // a dead peer goes silent and errors the socket into the close
        // handler after ~30-40s — bounded, cross-platform, no protocol change.
        try {
            if (req.socket && !req.socket.destroyed) req.socket.setKeepAlive(true, 30000);
        } catch (_) { /* non-fatal: cleanup falls back to write failures */ }

        const keepAliveTimer = setInterval(() => {
            if (res.destroyed || res.writableEnded) {
                clearInterval(keepAliveTimer);
                chatSubscribers.delete(res);
                if (!res.writableEnded) broadcastViewerCount();
                return;
            }
            // Bounded recovery from a lag. broadcastChatEvent() stops writing to
            // a subscriber that is not keeping up, and only the browser's own
            // EventSource auto-reconnect can unstick a viewer whose socket never
            // drains. If it has been dark for over a minute, drop it so that
            // reconnect actually happens instead of the viewer sitting with a
            // silently frozen viewer count and no chat.
            if (res._lagging && Date.now() - (res._lagSince || 0) > 60000) {
                console.warn('[Chat] SSE subscriber never recovered — closing so the browser reconnects.');
                res.destroy();
                return;
            }
            res.write(':keepalive\n\n');
        }, 15000);
        // Do not let a live SSE connection hold the process open.
        keepAliveTimer.unref();

        // Recovery for a lagging subscriber: broadcastChatEvent() stops writing
        // to it once it falls behind, so nothing else would clear the flag on a
        // tab that is merely slow (a phone resuming from sleep, a tunnel
        // hiccup) rather than gone. 'drain' means the socket flushed
        // everything queued, so it is a healthy reader again.
        res.on('drain', () => {
            res._lagging = false;
            res._slowWrites = 0;
            res._lagSince = 0;
        });

        // res 'close' fires on some Node/OS combinations where req 'close'
        // is delayed for a streaming response; both paths are idempotent.
        const detachSubscriber = () => {
            clearInterval(keepAliveTimer);
            if (chatSubscribers.delete(res)) {
                broadcastViewerCount();
            }
        };
        req.on('close', detachSubscriber);
        res.on('close', detachSubscriber);
        return;
    }

    if (subpath === '/messages' || subpath === '/messages/') {
        if (req.method === 'GET' || req.method === 'HEAD') {
            const sinceId = Number.parseInt(requestUrl.searchParams.get('since') || '0', 10);
            // Same rule as SSE replay: a fallback poll can carry an id from a
            // previous process or outside the retained window. Return the
            // retained history rather than silently filtering out new messages.
            const replayable = Number.isFinite(sinceId)
                && sinceId > 0
                && sinceId <= lastChatMessageId
                && (!chatHistory.length || sinceId >= chatHistory[0].id);
            const messages = replayable ? chatHistory.filter((m) => m.id > sinceId) : chatHistory;
            const body = JSON.stringify({ ok: true, messages });
            res.writeHead(200, setCorsHeaders({
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': CACHE_CONTROL,
                'Content-Length': Buffer.byteLength(body)
            }));
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            res.end(body);
            return;
        }

        if (req.method === 'POST') {
            const clientIp = clientIpForRateLimit(req);
            const now = Date.now();
            const rateInfo = chatRateLimits.get(clientIp) || [];
            const recent = rateInfo.filter((ts) => now - ts < 2000);
            if (recent.length >= 5) {
                res.writeHead(429, setCorsHeaders({
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': CACHE_CONTROL
                }));
                res.end(JSON.stringify({ error: 'You are sending messages too quickly. Please wait a moment.' }));
                return;
            }
            // The slot is RESERVED synchronously, before the body is even read.
            // Charging it only after validation would leave the pre-check and
            // the charge decoupled by an await: N concurrent requests would all
            // read the same (empty) window, all pass, and all be accepted — the
            // cap would bound nothing. Reserving up front keeps the bound.
            //
            // A request that is then REJECTED is refunded below. Charging it up
            // front without a refund was the original defect: a request answered
            // 400 (malformed JSON, empty text, oversize body) had still consumed
            // quota, so a client could be silenced — and could itself throttle a
            // legitimate viewer — just by sending bad requests.
            recent.push(now);
            chatRateLimits.set(clientIp, recent);
            const reservedAt = now;
            const refund = () => {
                const stamps = chatRateLimits.get(clientIp);
                if (!stamps) return;
                const index = stamps.lastIndexOf(reservedAt);
                if (index !== -1) stamps.splice(index, 1);
                if (stamps.length === 0) chatRateLimits.delete(clientIp);
                else chatRateLimits.set(clientIp, stamps);
            };

            readJsonBody(req).then((data) => {
                const rawText = typeof data.text === 'string' ? data.text.trim() : '';
                if (!rawText) {
                    refund();
                    res.writeHead(400, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                    res.end(JSON.stringify({ error: 'Message text cannot be empty' }));
                    return;
                }
                if (rawText.length > MAX_MESSAGE_LENGTH) {
                    refund();
                    res.writeHead(400, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                    res.end(JSON.stringify({ error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` }));
                    return;
                }

                let author = typeof data.author === 'string' ? data.author.trim() : 'Viewer';
                if (!author) author = 'Viewer';
                if (author.length > MAX_AUTHOR_LENGTH) author = author.slice(0, MAX_AUTHOR_LENGTH);

                const isHost = isDirectLocal(req);
                let badge = 'USER';
                if (isHost && (data.badge === 'HOST' || author.toLowerCase() === 'host')) {
                    badge = 'HOST';
                } else if (data.badge === 'VIP') {
                    badge = 'VIP';
                }

                const message = {
                    id: ++lastChatMessageId,
                    author,
                    badge,
                    text: rawText,
                    time: new Date().toISOString(),
                    clientId: typeof data.clientId === 'string' ? data.clientId : null,
                    clientMsgId: typeof data.clientMsgId === 'string' ? data.clientMsgId : null
                };

                chatHistory.push(message);
                if (chatHistory.length > MAX_CHAT_HISTORY) {
                    chatHistory.shift();
                }

                // The id makes EventSource replay this exact message through
                // Last-Event-ID after a native reconnect (see broadcastChatEvent).
                broadcastChatEvent('message', message, message.id);

                const body = JSON.stringify({ ok: true, message });
                res.writeHead(200, setCorsHeaders({
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': CACHE_CONTROL,
                    'Content-Length': Buffer.byteLength(body)
                }));
                res.end(body);
            }).catch((err) => {
                refund();
                const status = err && err.payloadTooLarge ? 413 : 400;
                res.writeHead(status, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
            });
            return;
        }

        res.writeHead(405, setCorsHeaders({
            'Allow': 'GET, POST, HEAD',
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': CACHE_CONTROL
        }));
        res.end('405 Method Not Allowed');
        return;
    }

    if (subpath === '/reactions' || subpath === '/reactions/') {
        if (req.method === 'POST') {
            // Reactions are cheap but broadcast to every viewer; unbounded,
            // one rogue client floods every screen with emoji animations.
            const reactionIp = clientIpForRateLimit(req);
            const nowMs = Date.now();
            const reactionStamps = (reactionRateLimits.get(reactionIp) || []).filter((ts) => nowMs - ts < 2000);
            if (reactionStamps.length >= 10) {
                res.writeHead(429, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                res.end(JSON.stringify({ error: 'Too many reactions — slow down a little.' }));
                return;
            }
            // Global aggregate ceiling, checked before the stamp is recorded so
            // a throttled client is not also charged for the attempt. The
            // window is SLIDING: expired stamps are dropped on every check, so
            // the cap holds across a wall-clock second boundary instead of
            // resetting at it and letting 2x through.
            while (reactionGlobalStamps.length && nowMs - reactionGlobalStamps[0] >= 1000) {
                reactionGlobalStamps.shift();
            }
            if (reactionGlobalStamps.length >= REACTION_GLOBAL_CAP_PER_SEC) {
                res.writeHead(429, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                res.end(JSON.stringify({ error: 'Reactions are moving fast right now — try again in a moment.' }));
                return;
            }
            // Both budgets are RESERVED synchronously, before the body is read —
            // same reasoning as the chat handler. Charging only after validation
            // would decouple the check from the charge across an await, so N
            // concurrent reactions would all read the same window and all be
            // accepted, and the ceiling would bound nothing. A request that is
            // then answered 400 is REFUNDED, so a malformed body cannot spend
            // the viewer's budget or the room's on-screen compositing budget.
            reactionGlobalStamps.push(nowMs);
            reactionStamps.push(nowMs);
            reactionRateLimits.set(reactionIp, reactionStamps);
            const refundReaction = () => {
                const globalIndex = reactionGlobalStamps.lastIndexOf(nowMs);
                if (globalIndex !== -1) reactionGlobalStamps.splice(globalIndex, 1);
                const perIp = reactionRateLimits.get(reactionIp);
                if (perIp) {
                    const ipIndex = perIp.lastIndexOf(nowMs);
                    if (ipIndex !== -1) perIp.splice(ipIndex, 1);
                    if (perIp.length === 0) reactionRateLimits.delete(reactionIp);
                    else reactionRateLimits.set(reactionIp, perIp);
                }
            };

            readJsonBody(req).then((data) => {
                const emoji = typeof data.emoji === 'string' ? data.emoji.trim() : '';
                const validEmojis = ['heart', 'fire', 'clap', 'laugh', 'thumbs'];
                if (!validEmojis.includes(emoji)) {
                    refundReaction();
                    res.writeHead(400, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                    res.end(JSON.stringify({ error: 'Invalid emoji reaction' }));
                    return;
                }

                reactionCounts[emoji] = (reactionCounts[emoji] || 0) + 1;
                broadcastChatEvent('reaction', {
                    emoji,
                    clientId: typeof data.clientId === 'string' ? data.clientId : null,
                    totalCount: reactionCounts[emoji]
                });

                const body = JSON.stringify({ ok: true, count: reactionCounts[emoji] });
                res.writeHead(200, setCorsHeaders({
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': CACHE_CONTROL,
                    'Content-Length': Buffer.byteLength(body)
                }));
                res.end(body);
            }).catch((err) => {
                refundReaction();
                const status = err && err.payloadTooLarge ? 413 : 400;
                res.writeHead(status, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
            });
            return;
        }

        res.writeHead(405, setCorsHeaders({
            'Allow': 'POST',
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': CACHE_CONTROL
        }));
        res.end('405 Method Not Allowed');
        return;
    }

    if (subpath === '/identity' || subpath === '/identity/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, setCorsHeaders({
                'Allow': 'GET, HEAD',
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': CACHE_CONTROL
            }));
            res.end('405 Method Not Allowed');
            return;
        }
        const isHost = isDirectLocal(req);
        const body = JSON.stringify({ isHost });
        res.writeHead(200, setCorsHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL,
            'Content-Length': Buffer.byteLength(body)
        }));
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(body);
        return;
    }

    res.writeHead(404, setCorsHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
    res.end('404 Not Found');
}

const server = http.createServer((req, res) => {
    // A response can legitimately error after its request handler already
    // returned (a socket write racing the client's disconnect, a half-closed
    // SSE stream). Without a listener that 'error' event is unhandled and
    // would reach the process-level handlers; swallowing it here is the
    // correct per-connection fate — the socket is already gone.
    res.on('error', () => {});

    // Expose the serving checkout to the browser, not just the terminal. The
    // symptom of this whole class of bug is observed in the BROWSER ("my edit
    // did nothing"), so the answer has to be inspectable there: DevTools ->
    // Network -> any response -> Response Headers, or view-source. Cheap (the
    // description is memoised) and set before any writeHead, so it rides along
    // on static assets and proxied responses alike; an explicit header of the
    // same name elsewhere would still win.
    try {
        res.setHeader('X-Rydius-Served-From', describeCheckout().dir);
    } catch (_) { /* never let diagnostics break a response */ }

    let requestUrl;
    try {
        requestUrl = new URL(req.url, 'http://localhost');
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
    }

    if (requestUrl.pathname.startsWith('/stream-api/')) {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, setCorsHeaders({ 'Cache-Control': CACHE_CONTROL }));
            res.end();
            return;
        }
        if (requestUrl.pathname === '/stream-api/turn') {
            // Minted TURN credentials are served here instead of being proxied;
            // MediaMTX has no such route and would answer 404.
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, setCorsHeaders({
                    'Allow': 'GET, HEAD',
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': CACHE_CONTROL
                }));
                res.end('405 Method Not Allowed');
                return;
            }
            handleTurnCredentials(req, res);
            return;
        }
        if (requestUrl.pathname === '/stream-api/host-info') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, setCorsHeaders({
                    'Allow': 'GET, HEAD',
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': CACHE_CONTROL
                }));
                res.end('405 Method Not Allowed');
                return;
            }
            handleHostInfo(req, res);
            return;
        }
        if (requestUrl.pathname === '/stream-api/chat' || requestUrl.pathname.startsWith('/stream-api/chat/')) {
            handleChat(req, res, requestUrl);
            return;
        }
        // Everything else under /stream-api/v3/** is the MediaMTX control plane.
        // It is unauthenticated upstream and publicly reachable here, so only the
        // one read-only endpoint the player actually uses is allowed through.
        // Verified against the real binary before this guard existed:
        //   GET    /stream-api/v3/config/global/get       -> 200, dumped the config
        //   PATCH  /stream-api/v3/config/global/set       -> a config WRITE
        //   DELETE /stream-api/v3/paths/list/<p>/readystate -> kills the live stream
        // i.e. a one-request remote config rewrite, or a one-request kill of the
        // broadcast, from anyone on the internet - and because this process sets
        // CORS to *, from any page the streamer visits, with no preflight.
        if (requestUrl.pathname.startsWith('/stream-api/v3/')
            && !isAllowedControlApiRequest(requestUrl.pathname, req.method)) {
            res.writeHead(403, setCorsHeaders({
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': CACHE_CONTROL
            }));
            res.end('403 Forbidden: the MediaMTX control API is not exposed through this proxy.');
            return;
        }
        proxyToMediaMTX(req, res, requestUrl);
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('405 Method Not Allowed');
        return;
    }

    const fileName = STATIC_FILES.get(requestUrl.pathname);
    if (!fileName) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_CONTROL });
        res.end('404 Not Found');
        return;
    }

    const filePath = path.join(STATIC_DIR, fileName);
    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_CONTROL });
            res.end('404 Not Found');
            return;
        }

        // ETag revalidation: identical content answers 304 with no body, so
        // repeat viewers over Tailscale skip re-downloading the page assets.
        // Any edit changes size/mtime and therefore the ETag, so stale content
        // can never be served from cache.
        const etag = `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
        // RFC 9110 §13.1.2: If-None-Match is `*` or a comma-separated list, and
        // ANY member matching makes the precondition fail (=> 304). Comparing the
        // whole header to the etag only ever caught the exact-single-value form,
        // so a client sending `*` or a list re-downloaded the full asset every
        // time and the conditional-GET win was lost exactly where it mattered.
        const inm = req.headers['if-none-match'];
        const etagMatches = inm === '*'
            || (typeof inm === 'string' && inm.split(',').some((tag) => tag.trim() === etag));
        if (etagMatches) {
            res.writeHead(304, {
                'Cache-Control': STATIC_CACHE_CONTROL,
                'CDN-Cache-Control': 'no-store',
                'ETag': etag,
                // The 200 below is Vary'd on Accept-Encoding because the same
                // ETag is served both gzipped and identity. A shared cache that
                // revalidated on a 304 and merged headers without this could
                // hand a gzip body to a client that never advertised gzip —
                // a hard decode error, i.e. a player that silently never boots.
                'Vary': 'Accept-Encoding',
                'X-Content-Type-Options': 'nosniff'
            });
            res.end();
            return;
        }

        const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        // Compressible page assets ride gzip when the browser allows it:
        // app.js is ~170 KB raw and ~40 KB gzipped, which cuts the first page
        // load on the LAN/Tailscale paths roughly 4x (the Cloudflare tunnel
        // already compresses). 304 revalidation above is untouched — the ETag
        // identifies the uncompressed content on both paths. No store would
        // ever serve a body without this header, so no Vary poisoning risk.
        const gzippable = contentType.startsWith('text/') || contentType.startsWith('application/javascript');
        const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
        const headers = {
            'Content-Type': contentType,
            'Cache-Control': STATIC_CACHE_CONTROL,
            'CDN-Cache-Control': 'no-store',
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff'
        };
        if (gzippable && wantsGzip) {
            // Content-Length must go: the encoded size is only known after
            // streaming, and a stale value would truncate the body.
            headers['Content-Encoding'] = 'gzip';
            headers['Vary'] = 'Accept-Encoding';
            res.writeHead(200, headers);
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            pipeline(fs.createReadStream(filePath), zlib.createGzip({ level: 6 }), res, () => {});
            return;
        }
        headers['Content-Length'] = stats.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        // A read that fails mid-flight (the file was replaced or locked
        // between stat and open — normal on a Windows editor save) must not
        // reach the process-level handlers with a half-sent response: cut
        // the connection cleanly instead.
        const fileStream = fs.createReadStream(filePath);
        fileStream.on('error', (streamError) => {
            console.error(`[Static] Failed reading ${fileName}:`, streamError.message);
            res.destroy();
        });
        fileStream.pipe(res);
    });
});

// Ask whoever already owns the port which copy of this project they are, and say
// so plainly. Returns a promise the caller MUST await before exiting:
// process.exit() discards pending I/O, so an un-awaited lookup prints nothing
// and leaves the ambiguity exactly where it started. Bounded and best-effort -
// this runs on the failure path of a process about to exit, so it must never
// hang or throw. An incumbent that predates /stream-api/host-info, or is not a
// copy of this project at all, simply does not answer and the generic message
// stands.
function describePortHolder(port = PORT) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: '/stream-api/host-info',
            method: 'GET',
            agent: false
        }, (response) => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { raw += chunk; });
            response.on('end', () => {
                let info = null;
                try { info = JSON.parse(raw); } catch (err) { info = null; }
                if (info && typeof info.dir === 'string') {
                    const same = path.resolve(info.dir) === HOST_DIR;
                    console.error('  -> Port ' + port + ' is held by ' + (same
                        ? 'ANOTHER server.js from THIS directory'
                        : 'a server from a DIFFERENT copy of this project') + ':');
                    console.error('     holder: ' + info.dir + ' (pid ' + info.pid
                        + ', started ' + info.startedAt + ')');
                    console.error('     this:   ' + HOST_DIR);
                    if (!same) {
                        console.error('     It is serving the OTHER copy code, so a check against');
                        console.error('     http://127.0.0.1:' + port + '/ is NOT testing your edits.');
                    }
                }
                finish();
            });
        });
        request.on('error', () => finish());
        request.setTimeout(1500, () => { request.destroy(); finish(); });
        request.on('close', finish);
        request.end();
    });
}

// A second launcher (or any other process grabbing the port) must fail with
// a readable reason, not a raw EADDRINUSE stack trace in the launcher window.
server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other site server or set PORT to a free port before starting.`);
        // NAME the incumbent: with dozens of worktrees on one machine, "port 3000
        // is in use" is ambiguous in exactly the way that causes silent wrong
        // answers. Awaited, because process.exit() discards pending I/O.
        describePortHolder().then(() => process.exit(1), () => process.exit(1));
        return;
    }
    // Every OTHER error used to be fatal too, which contradicts the
    // long-lived-host policy stated at the uncaughtException handler below
    // ("a single stray failure would otherwise kill the whole process
    // mid-broadcast"). It is not only theoretical: an `http.Server` also
    // emits 'error' when libuv reports an ACCEPT-side failure — EMFILE /
    // ENFILE / ECONNABORTED on Windows, all routine under connection
    // pressure — and `process.exit()` is a deliberate call, so it bypasses
    // the uncaughtException net entirely. One accept failure from a burst of
    // viewer connections therefore killed the host instantly, dropping every
    // viewer's WHEP session, chat stream and status probe at once, when the
    // correct response was to log it and keep accepting: libuv has already
    // recovered by the time the event fires.
    //
    // Fatal errors that genuinely cannot be survived still exit: a listen
    // failure other than EADDRINUSE (EACCES on a reserved port, EADDRNOTAVAIL)
    // means nothing is ever going to be served.
    const fatal = ['EACCES', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN'];
    console.error('Rydius Stream host server error:', error);
    if (fatal.includes(error && error.code)) {
        console.error('This is a fatal listen failure; exiting so the launcher can report it.');
        process.exit(1);
    }
    console.error('Continuing to serve — the listening socket survived.');
});

// Long-lived-host resilience: a single stray rejected promise (a socket write
// racing a client disconnect, a half-closed SSE stream) would otherwise kill
// the whole process mid-broadcast — Node's default for unhandled rejections
// is exit. The per-request handlers above already contain the expected
// failure modes; these two are the last line of defense, so the stream and
// chat keep serving whatever happens. Logged loudly: anything reaching here
// is a bug that should be fixed, not suppressed silently.
process.on('unhandledRejection', (reason) => {
    console.error('[Resilience] Unhandled rejection (host kept alive):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Resilience] Uncaught exception (host kept alive):', err);
});

// Keep-alive must outlive the client's request cadence. Node's default
// keepAliveTimeout is 5 seconds, and the player polls stream status on a 5s
// interval and fetches the rendition ladder on the same period — so the pooled
// socket was being torn down in a race with the very next request. A WHEP
// handshake is a POST, and browsers do not reliably retry a failed POST on a
// reused socket: losing that race produced a failed handshake, a reconnect and
// a visible freeze on a perfectly healthy link. 65s is the conventional pairing
// with the 60s header timeout and leaves ample margin.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '127.0.0.1', () => {
    console.log('Rydius Stream host is running on this laptop.');
    // FIRST, because it is the fact that invalidates every other observation
    // made against this window: if you are not looking at the expected path,
    // nothing below it (and nothing on the page) reflects your edits.
    //
    // STATIC_DIR is __dirname, so this process serves whichever copy of
    // index.html/app.js it was launched from, and this repo has many sibling git
    // worktrees plus the main checkout. Every port in mediamtx.yml
    // (3000/8888/1935/8554/8889/8189) is FIXED, so a second instance fails to
    // bind rather than replacing the first -- the wrong copy keeps serving and
    // reports no error at all. The absolute path plus branch/SHA is therefore the
    // only way to tell, which is why it is printed before anything else.
    const checkout = describeCheckout();
    console.log(`Serving from: ${checkout.dir}`);
    console.log(`Checkout:     ${checkout.branch} @ ${checkout.sha}`
        + (checkout.linkedWorktree ? '  (git linked worktree)' : ''));
    if (checkout.linkedWorktree) {
        console.log('Note: this is a git LINKED WORKTREE. Sibling worktrees and the main '
            + 'checkout serve the same ports - if the page does not reflect your edits, '
            + 'another copy is holding the port. Compare the path above with your editor.');
    }
    console.log(`Local page:    http://127.0.0.1:${PORT}/streaming/`);
    console.log(`WebRTC signal: http://127.0.0.1:${MEDIAMTX_PORT} (proxied at /stream-api/**)`);
    console.log(`MediaMTX API:  http://127.0.0.1:${MEDIAMTX_API_PORT} (proxied at /stream-api/v3/**)`);
    if (CF_TURN_KEY_ID && CF_TURN_KEY_TOKEN) {
        console.log(`TURN relay: Cloudflare credentials minted at /stream-api/turn (TTL ${CF_TURN_TTL_SECONDS}s).`);
    } else {
        console.log('TURN relay: not configured — remote viewers use free Cloudflare STUN punch-through. Set CF_TURN_KEY_ID/CF_TURN_KEY_TOKEN to add a relay fallback.');
    }
    console.log('Remote viewers: share https://stream.rydius.in once setup_cloudflared.ps1 has been run (the Tailscale URL also still works).');
    console.log('Keep this window open while streaming.');
});
