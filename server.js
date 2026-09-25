'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MEDIAMTX_HOST = '127.0.0.1';
// Overridable only so local checks can point the proxy at a stub upstream;
// production always uses MediaMTX's default signaling port 8889.
const MEDIAMTX_PORT = Number.parseInt(process.env.MEDIAMTX_PORT || '8889', 10);
// MediaMTX's control API (used by the player's status probe at /stream-api/v3/**)
// listens on a separate port from WebRTC signaling.
const MEDIAMTX_API_PORT = Number.parseInt(process.env.MEDIAMTX_API_PORT || '8888', 10);
const STATIC_DIR = __dirname;
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

const STATIC_FILES = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/streaming', 'index.html'],
    ['/streaming/', 'index.html'],
    ['/streaming/index.html', 'index.html'],
    ['/style.css', 'style.css'],
    ['/streaming/style.css', 'style.css'],
    ['/app.js', 'app.js'],
    ['/streaming/app.js', 'app.js']
]);

function setCorsHeaders(headers) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, If-Match';
    headers['Access-Control-Expose-Headers'] = 'Location';
    return headers;
}

function proxyToMediaMTX(req, res, requestUrl) {
    const targetPath = requestUrl.pathname.slice('/stream-api'.length) || '/';
    // MediaMTX splits its HTTP surfaces: the control API (status probes) listens on
    // MEDIAMTX_API_PORT, WebRTC/WHIP signaling on MEDIAMTX_PORT. Route by prefix so
    // /stream-api/v3/** reaches the API.
    const targetPort = requestUrl.pathname.startsWith('/stream-api/v3/') ? MEDIAMTX_API_PORT : MEDIAMTX_PORT;
    const headers = { ...req.headers, host: `${MEDIAMTX_HOST}:${targetPort}` };
    const proxyReq = http.request({
        host: MEDIAMTX_HOST,
        port: targetPort,
        path: `${targetPath}${requestUrl.search}`,
        method: req.method,
        headers
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
        proxyRes.pipe(res);
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
        res.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL
        });
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
// One mint is shared by every viewer until shortly before its TTL expires, so
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
        turnMintCache.renewAt = now + Math.max(60000, (CF_TURN_TTL_SECONDS - 300) * 1000);
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

const server = http.createServer((req, res) => {
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
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, {
                'Cache-Control': STATIC_CACHE_CONTROL,
                'ETag': etag,
                'X-Content-Type-Options': 'nosniff'
            });
            res.end();
            return;
        }

        res.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stats.size,
            'Cache-Control': STATIC_CACHE_CONTROL,
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('Rydius Stream host is running on this laptop.');
    console.log(`Local page:    http://127.0.0.1:${PORT}/streaming/`);
    console.log(`WebRTC signal: http://127.0.0.1:${MEDIAMTX_PORT} (proxied at /stream-api/**)`);
    console.log(`MediaMTX API:  http://127.0.0.1:${MEDIAMTX_API_PORT} (proxied at /stream-api/v3/**)`);
    if (CF_TURN_KEY_ID && CF_TURN_KEY_TOKEN) {
        console.log(`TURN relay: Cloudflare credentials minted at /stream-api/turn (TTL ${CF_TURN_TTL_SECONDS}s).`);
    } else {
        console.log('TURN relay: not configured — remote viewers use free Cloudflare STUN punch-through. Set CF_TURN_KEY_ID/CF_TURN_KEY_TOKEN to add a relay fallback.');
    }
    console.log('Remote viewers: connect to the same Tailscale network and use the HTTPS URL shown by tailscale serve status, with /streaming/ appended.');
    console.log('Keep this window open while streaming.');
});
