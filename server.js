'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
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

// Pool TCP connections to MediaMTX instead of opening a fresh loopback
// connection per request. Every viewer generates a steady request flow
// (status probe every 5s, ICE config, WHEP handshakes) — reusing warm
// sockets removes the connect/teardown jitter from each of those round
// trips and keeps signaling latency flat as the room grows. maxSockets is
// left generous so a burst of simultaneous WHEP handshakes never queues.
const MEDIAMTX_AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });

const STATIC_FILES = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/streaming', 'index.html'],
    ['/streaming/', 'index.html'],
    ['/streaming/index.html', 'index.html'],
    // The browser broadcaster ("Rydius Studio"). Served as its own page, not a
    // mode of index.html: it needs a different title, a different asset set and
    // no chat, and mixing them would make the player's own load path pay for
    // the studio's code. Every alias of the player is mirrored so the same
    // shareable URL works for both.
    ['/studio', 'broadcast.html'],
    ['/studio/', 'broadcast.html'],
    ['/studio/index.html', 'broadcast.html'],
    ['/streaming/studio', 'broadcast.html'],
    ['/streaming/studio/', 'broadcast.html'],
    ['/streaming/studio/index.html', 'broadcast.html'],
    ['/broadcast', 'broadcast.html'],
    ['/broadcast/', 'broadcast.html'],
    ['/streaming/broadcast', 'broadcast.html'],
    ['/style.css', 'style.css'],
    ['/streaming/style.css', 'style.css'],
    ['/app.js', 'app.js'],
    ['/streaming/app.js', 'app.js'],
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
        turnMintCache.renewAt = now + Math.max(60000, (CF_TURN_TTL_SECONDS / 2) * 1000);
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
let lastChatMessageId = 0;

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
const TRUST_FORWARDED_HEADERS = Boolean(
    process.env.CF_TUNNEL_HOST || process.env.TRUST_PROXY_HEADERS === '1'
);
function clientIpForRateLimit(req) {
    if (TRUST_FORWARDED_HEADERS) {
        const cfIp = req.headers['cf-connecting-ip'];
        if (typeof cfIp === 'string' && cfIp) return cfIp.trim();
        const xff = req.headers['x-forwarded-for'];
        if (typeof xff === 'string' && xff) {
            // First hop only: the rest of the chain is client-supplied.
            const first = xff.split(',')[0].trim();
            if (first) return first;
        }
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Per-IP reaction limits are only half the story: aggregate rate is
// (per-viewer rate x viewer count), and every accepted reaction is broadcast to
// every viewer, where it becomes an animated layer over live video. A global
// token bucket bounds that aggregate no matter how many viewers there are, or
// how a client chooses to identify itself.
const REACTION_GLOBAL_CAP_PER_SEC = 25;
let reactionGlobalWindowStart = Date.now();
let reactionGlobalCount = 0;

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
        if (lastEventId > 0) {
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
            const messages = sinceId > 0 ? chatHistory.filter((m) => m.id > sinceId) : chatHistory;
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
            recent.push(now);
            chatRateLimits.set(clientIp, recent);

            readJsonBody(req).then((data) => {
                const rawText = typeof data.text === 'string' ? data.text.trim() : '';
                if (!rawText) {
                    res.writeHead(400, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                    res.end(JSON.stringify({ error: 'Message text cannot be empty' }));
                    return;
                }
                if (rawText.length > MAX_MESSAGE_LENGTH) {
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
            // a throttled client is not also charged for the attempt.
            if (nowMs - reactionGlobalWindowStart >= 1000) {
                reactionGlobalWindowStart = nowMs;
                reactionGlobalCount = 0;
            }
            if (reactionGlobalCount >= REACTION_GLOBAL_CAP_PER_SEC) {
                res.writeHead(429, setCorsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL }));
                res.end(JSON.stringify({ error: 'Reactions are moving fast right now — try again in a moment.' }));
                return;
            }
            reactionGlobalCount += 1;
            reactionStamps.push(nowMs);
            reactionRateLimits.set(reactionIp, reactionStamps);

            readJsonBody(req).then((data) => {
                const emoji = typeof data.emoji === 'string' ? data.emoji.trim() : '';
                const validEmojis = ['heart', 'fire', 'clap', 'laugh', 'thumbs'];
                if (!validEmojis.includes(emoji)) {
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
        if (requestUrl.pathname === '/stream-api/chat' || requestUrl.pathname.startsWith('/stream-api/chat/')) {
            handleChat(req, res, requestUrl);
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

// A second launcher (or any other process grabbing the port) must fail with
// a readable reason, not a raw EADDRINUSE stack trace in the launcher window.
server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other site server or set PORT to a free port before starting.`);
        process.exit(1);
    }
    console.error('Rydius Stream host server error:', error);
    process.exit(1);
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
