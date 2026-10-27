'use strict';

/* ==========================================================================
   studio_ingest.js — relay a browser WebCodecs broadcast into MediaMTX

   The browser cannot hand encoded frames to an RTCRtpSender (there is no
   injection API), which is why every previous browser path fell back to the
   browser's own WebRTC encoder. On this laptop that encoder picked VP8 and
   produced ~16 fps. This module takes WebRTC out of the publish path entirely:

     browser VideoEncoder (hardware H.264, Annex B)
        -> framed batched HTTP POSTs (video + PCM)
        -> two Windows named pipes
        -> bundled ffmpeg (-c:v copy, PCM -> Opus)
        -> RTSP publish to the same `live` path OBS uses

   Video is copied, never re-encoded, so the browser's hardware encoder is the
   only video encoder in the chain. That is what makes 60 fps possible.

   Why many small POSTs instead of one long request: Chromium refuses a
   ReadableStream request body over HTTP/1.1 (it fails with
   net::ERR_ALPN_NEGOTIATION_FAILED and only permits streamed uploads over
   HTTP/2 or HTTP/3). This host is plain Node `http`, so the browser sends the
   same framed byte stream as a sequence of finite batches instead. Each POST
   carries whole frames; the pump waits for the response before sending the
   next, which is the backpressure. Frame layout is deliberately trivial:

     [type: 1][length: uint32 BE][timestamp: uint64 BE µs][payload]

   type 1 = one Annex B access unit (what VideoEncoder emits per chunk)
   type 2 = interleaved s16le stereo 48 kHz PCM

   A batch boundary never splits a frame, but the parser still accepts any
   split so a proxy or a future transport cannot corrupt the stream.
   ========================================================================== */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO = 1;
const AUDIO = 2;
// type + length + media timestamp (µs). See studio_ingest_client.js.
const HEADER_BYTES = 13;

// A single encoded access unit at 4K is well under 4 MB; this is a sanity
// bound on a hostile length prefix, not a codec limit.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// The browser paces itself. This only stops a broken or hostile writer from
// growing the parse buffer without bound.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
// ffmpeg reads the video pipe continuously. If this much is queued, the relay
// is behind, and a frame is not worth an ever-growing latency: drop it and let
// the client's next keyframe repair the reference chain.
const VIDEO_HIGH_WATER = 4 * 1024 * 1024;
const AUDIO_HIGH_WATER = 1024 * 1024;
const MAX_PENDING_AUDIO = 2 * 1024 * 1024;
// Frames held waiting for their media time. A backlog this deep means the pipe
// is stalled; keeping it would only add latency once it recovers.
const VIDEO_QUEUE_LIMIT = 4 * 1024 * 1024;
// A frame this far past its due time is stale. Writing it anyway would
// compress several seconds of media into one wall-clock instant, which is the
// stutter this queue exists to prevent.
const VIDEO_LATE_DROP_US = 300000;
// ffmpeg stamps each raw H.264 access unit with the wall clock at read time
// (-use_wallclock_as_timestamps). When a late batch makes several frames due at
// once, writing them back-to-back can land two in the same clock tick, which
// the RTSP muxer reports as "Non-monotonic DTS" and nudges by one tick. A small
// floor between writes keeps the timestamps distinct; it is far below one frame
// interval, so it cannot pace a healthy stream.
const VIDEO_MIN_WRITE_GAP_MS = 2;

const SESSION_IDLE_MS = 20000;
const INGEST_STALL_MS = 30000;
const FAILED_SESSION_TTL_MS = 30000;

const DEFAULT_RTSP_URL = 'rtsp://127.0.0.1:8554/live';

function defaultFfmpegPath() {
    if (process.env.STUDIO_FFMPEG) return process.env.STUDIO_FFMPEG;
    const bundled = path.join(
        __dirname,
        'ffmpeg_win',
        'ffmpeg-n8.1-latest-win64-gpl-shared-8.1',
        'bin',
        'ffmpeg.exe'
    );
    return fs.existsSync(bundled) ? bundled : 'ffmpeg';
}

function clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

function even(value, min, max, fallback) {
    const rounded = clampInt(value, min, max, fallback);
    return rounded % 2 === 0 ? rounded : rounded - 1;
}

function normaliseConfig(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
        width: even(source.width, 160, 3840, 1920),
        height: even(source.height, 90, 2160, 1080),
        fps: clampInt(source.fps, 1, 120, 60),
        bitrate: clampInt(source.bitrate, 100000, 50000000, 6000000),
        audio: Boolean(source.audio),
        audioBitrate: clampInt(source.audioBitrate, 32000, 320000, 128000)
    };
}

function pipeName(id, suffix) {
    return `\\\\.\\pipe\\rydius_studio_${id}_${suffix}`;
}

// True when an Annex B access unit contains an IDR slice. The relay uses this
// only to clear the "ask the client for a keyframe" flag; getting it wrong
// costs an extra IDR, never correctness.
function containsIdr(payload) {
    for (let i = 0; i + 3 < payload.length; i += 1) {
        if (payload[i] !== 0 || payload[i + 1] !== 0) continue;
        let header = -1;
        if (payload[i + 2] === 1) {
            header = i + 3;
        } else if (payload[i + 2] === 0 && payload[i + 3] === 1) {
            header = i + 4;
        }
        if (header < 0 || header >= payload.length) continue;
        if ((payload[header] & 0x1f) === 5) return true;
    }
    return false;
}

function tokenMatches(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Pure release decision for one queued access unit. Kept separate from
// pumpVideo() so the three outcomes are testable without a pipe, a timer or a
// real ffmpeg: a frame whose media time is more than `lateDropUs` behind the
// wall clock is stale, a frame whose time has not arrived yet waits, and the
// rest are written immediately.
function pacingDecision(nowUs, dueUs, lateDropUs) {
    if (nowUs - dueUs > lateDropUs) return 'drop';
    if (dueUs > nowUs) return 'wait';
    return 'write';
}

// Pure: has the WHOLE queue fallen behind the wall clock?
//
// One late frame is a hiccup, and the per-frame drop in pumpVideo() handles it:
// the queue drains until the head carries a current timestamp. A queue whose
// head is already past the late threshold is a different state. Every frame in
// it is stale by construction, and dropping them one per timer turn cannot
// catch up, because the frames that are due are the ones already queued. The
// old code then asked for an IDR on every drop; the IDR was stale too, so the
// request re-armed forever. Measured live after a studio restart: 60 fps
// arriving, 65 fps dropped, needKeyframe stuck true, and the published path
// carried audio only for 26 minutes. The exit is to collapse the queue to its
// newest frame and re-anchor the media clock to now.
function videoNeedsResync(nowUs, mediaStartUs, firstPtsUs, headPtsUs, queuedFrames, lateUs) {
    if (mediaStartUs === null || queuedFrames < 2) return false;
    const dueUs = mediaStartUs + (headPtsUs - firstPtsUs);
    return nowUs - dueUs > lateUs;
}

function createStudioIngest(options = {}) {
    const sessions = new Map();
    let activeId = null;
    const ffmpegPath = options.ffmpegPath || defaultFfmpegPath();
    const rtspUrl = options.rtspUrl || process.env.STUDIO_RTSP_URL || DEFAULT_RTSP_URL;
    const log = options.log || ((line) => console.log(line));

    function statusJson(session) {
        const ffmpeg = session.ffmpeg;
        return {
            id: session.id,
            state: session.state,
            error: session.error || null,
            audio: session.config.audio,
            video: {
                width: session.config.width,
                height: session.config.height,
                fps: session.config.fps,
                bitrate: session.config.bitrate
            },
            startedAt: session.startedAt,
            uptimeMs: session.startedAt ? Date.now() - session.startedAt : 0,
            videoBytes: session.videoBytes,
            audioBytes: session.audioBytes,
            videoFrames: session.videoFrames,
            audioFrames: session.audioFrames,
            droppedVideo: session.droppedVideo,
            droppedAudio: session.droppedAudio,
            resyncs: session.resyncs,
            needKeyframe: session.needKeyframe,
            connected: {
                video: Boolean(session.videoSocket && !session.videoSocket.destroyed),
                audio: !session.config.audio
                    || Boolean(session.audioSocket && !session.audioSocket.destroyed)
            },
            ffmpeg: {
                pid: ffmpeg && ffmpeg.pid ? ffmpeg.pid : null,
                running: Boolean(ffmpeg && ffmpeg.exitCode === null && !ffmpeg.killed),
                code: ffmpeg ? ffmpeg.exitCode : null,
                stderr: session.stderrTail
            }
        };
    }

    function writeJson(res, status, body, headOnly) {
        if (!res || res.writableEnded || res.destroyed) return;
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Content-Length': Buffer.byteLength(payload)
        });
        res.end(headOnly ? undefined : payload);
    }

    function noteStderr(session, chunk) {
        const text = chunk.toString('utf8');
        session.stderrTail = (session.stderrTail + text).slice(-4096);
        if (options.echoStderr) process.stderr.write(text);
    }

    function clearTimers(session) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.stallTimer) clearInterval(session.stallTimer);
        if (session.killTimer) clearTimeout(session.killTimer);
        if (session.finalizeTimer) clearTimeout(session.finalizeTimer);
        if (session.reapTimer) clearTimeout(session.reapTimer);
        if (session.videoTimer) clearTimeout(session.videoTimer);
        session.idleTimer = null;
        session.stallTimer = null;
        session.killTimer = null;
        session.finalizeTimer = null;
        session.reapTimer = null;
        session.videoTimer = null;
    }

    function closePipeServer(server) {
        if (!server) return;
        try { server.close(); } catch (_) { /* already closed */ }
        for (const socket of server.__sockets || []) {
            try { socket.destroy(); } catch (_) { /* already gone */ }
        }
    }

    function reap(session) {
        clearTimers(session);
        closePipeServer(session.videoServer);
        closePipeServer(session.audioServer);
        session.videoSocket = null;
        session.audioSocket = null;
        if (sessions.get(session.id) === session) sessions.delete(session.id);
        if (activeId === session.id) activeId = null;
    }

    // The single teardown path, reachable from the ffmpeg 'exit' event, from
    // the post-stop kill timer, and (critically) from sessions that never got
    // an ffmpeg at all — a pipe-name collision or a missing binary fails before
    // there is any 'exit' event to listen for. Without this the failed entry
    // and its pipe servers would live until process exit.
    function finalizeSession(session) {
        if (session.finalized) return;
        session.finalized = true;
        clearTimers(session);
        closePipeServer(session.videoServer);
        closePipeServer(session.audioServer);
        session.videoSocket = null;
        session.audioSocket = null;
        if (session.state === 'failed') {
            // Keep the error readable for the client's next status poll; delete
            // it a bit later so a dead entry cannot accumulate.
            session.reapTimer = setTimeout(() => reap(session), FAILED_SESSION_TTL_MS);
            if (session.reapTimer.unref) session.reapTimer.unref();
        } else {
            reap(session);
        }
    }

    function killFfmpeg(session, signal) {
        const ffmpeg = session.ffmpeg;
        if (!ffmpeg || ffmpeg.exitCode !== null || ffmpeg.killed) return;
        try {
            // On Windows child.kill() is TerminateProcess; ffmpeg's own RTSP
            // teardown never gets a chance to run. That is still better than a
            // leaked publisher, and MediaMTX frees the path on disconnect.
            ffmpeg.kill(signal || 'SIGKILL');
        } catch (_) { /* already exited */ }
    }

    function finishSession(session, reason) {
        if (session.stopping) return;
        session.stopping = true;
        session.stopReason = reason;
        if (session.state !== 'failed') session.state = 'stopping';
        clearTimers(session);

        // Give ffmpeg EOF so its RTSP muxer can close the session politely.
        // Then kill it if it is still alive, because a stuck RTSP write would
        // otherwise hold this process's pipe servers forever.
        try { if (session.videoSocket) session.videoSocket.end(); } catch (_) { /* closed */ }
        try { if (session.audioSocket) session.audioSocket.end(); } catch (_) { /* closed */ }

        session.killTimer = setTimeout(() => {
            killFfmpeg(session, 'SIGKILL');
        }, 1500);
        if (session.killTimer.unref) session.killTimer.unref();

        // If ffmpeg exits, its 'exit' handler finalises first. If it never
        // spawned (or is wedged somewhere that even SIGKILL cannot reach), this
        // is the backstop that actually releases the pipe servers.
        session.finalizeTimer = setTimeout(() => finalizeSession(session), 3000);
        if (session.finalizeTimer.unref) session.finalizeTimer.unref();
    }

    function failSession(session, message) {
        if (session.state === 'failed') return;
        session.state = 'failed';
        session.error = message;
        log(`[StudioIngest] ${session.id} failed: ${message}`);
        finishSession(session, 'failed');
    }

    function flushAudioQueue(session) {
        const socket = session.audioSocket;
        if (!socket || socket.destroyed) return;
        while (session.pendingAudio.length && socket.writableLength < AUDIO_HIGH_WATER) {
            socket.write(session.pendingAudio.shift());
        }
    }

    function writeAudio(session, payload) {
        if (!session.config.audio) return;
        session.audioBytes += payload.length;
        session.audioFrames += 1;
        session.lastAudioAt = Date.now();
        const socket = session.audioSocket;
        if (!socket || socket.destroyed) {
            session.pendingAudio.push(payload);
            session.pendingAudioBytes += payload.length;
            while (session.pendingAudioBytes > MAX_PENDING_AUDIO && session.pendingAudio.length) {
                const dropped = session.pendingAudio.shift();
                session.pendingAudioBytes -= dropped.length;
                session.droppedAudio += 1;
            }
            return;
        }
        if (socket.writableLength > AUDIO_HIGH_WATER) {
            // Audio is tiny next to video, so a backlog here means the relay is
            // badly behind. Dropping whole 20 ms frames keeps the timeline
            // monotonic; queuing them would only add latency.
            session.droppedAudio += 1;
            return;
        }
        socket.write(payload);
        flushAudioQueue(session);
    }

    function scheduleVideoPump(session, delayMs) {
        session.videoTimer = setTimeout(() => {
            session.videoTimer = null;
            pumpVideo(session);
        }, Math.max(1, delayMs));
        if (session.videoTimer.unref) session.videoTimer.unref();
    }

    // Frames arrive in batches, so arrival time is not media time. Release
    // each one when its timestamp is due; ffmpeg's -use_wallclock_as_timestamps
    // then reads a wall clock that matches the encoder's timeline. Gaps in the
    // timestamps (a frame the client dropped) stay gaps, which is what keeps
    // audio and video aligned through a hiccup.
    function pumpVideo(session) {
        if (session.videoTimer) return;
        const socket = session.videoSocket;
        if (!socket || socket.destroyed) return;

        // Live-edge resync. See videoNeedsResync(): once the head of the queue
        // is stale, no amount of one-at-a-time dropping can catch up, and the
        // keyframe request only makes the backlog bigger. Drop everything but
        // the newest frame, re-anchor the clock to it, and let the next IDR
        // repair the reference chain.
        const resyncNowUs = Date.now() * 1000;
        if (session.videoQueue.length
            && videoNeedsResync(resyncNowUs, session.mediaStartUs, session.firstPtsUs,
                session.videoQueue[0].ptsUs, session.videoQueue.length, VIDEO_LATE_DROP_US)) {
            const headDueUs = session.mediaStartUs
                + (session.videoQueue[0].ptsUs - session.firstPtsUs);
            const behindMs = Math.round((resyncNowUs - headDueUs) / 1000);
            const staleCount = session.videoQueue.length - 1;
            while (session.videoQueue.length > 1) {
                const stale = session.videoQueue.shift();
                session.videoQueueBytes -= stale.payload.length;
            }
            session.droppedVideo += staleCount;
            session.mediaStartUs = resyncNowUs;
            session.firstPtsUs = session.videoQueue[0].ptsUs;
            session.needKeyframe = true;
            session.resyncs += 1;
            log(`[StudioIngest] Video queue was ${behindMs}ms behind the wall clock; `
                + `dropped ${staleCount} queued frames and re-anchored to the live edge.`);
        }

        while (session.videoQueue.length) {
            if (socket.writableLength > VIDEO_HIGH_WATER) {
                // The pipe is full. Retry rather than drop: the queue's
                // timestamps make the delay visible, and the late-drop below
                // stops it from becoming permanent latency.
                scheduleVideoPump(session, 5);
                return;
            }

            const item = session.videoQueue[0];
            const nowUs = Date.now() * 1000;
            if (session.mediaStartUs === null) {
                // Anchor the media timeline to the first frame that actually
                // reaches the pipe, not to session creation: ffmpeg may take a
                // moment to open its inputs.
                session.mediaStartUs = nowUs;
                session.firstPtsUs = item.ptsUs;
            }
            const dueUs = session.mediaStartUs + (item.ptsUs - session.firstPtsUs);

            const decision = pacingDecision(nowUs, dueUs, VIDEO_LATE_DROP_US);
            if (decision === 'drop') {
                // More than 300 ms stale: sending it now would put several
                // frames on one wall-clock instant. Drop it and ask for an IDR.
                session.videoQueue.shift();
                session.videoQueueBytes -= item.payload.length;
                session.droppedVideo += 1;
                session.needKeyframe = true;
                continue;
            }
            if (decision === 'wait') {
                scheduleVideoPump(session, Math.ceil((dueUs - nowUs) / 1000));
                return;
            }

            session.videoQueue.shift();
            session.videoQueueBytes -= item.payload.length;
            // Clearing on an IDR is what stops the client being asked for a
            // keyframe on every status poll after a single drop.
            if (session.needKeyframe && containsIdr(item.payload)) session.needKeyframe = false;
            socket.write(item.payload);

            // At most one frame per timer turn, with a floor between writes.
            // A late batch can make several frames due at once; writing them
            // back-to-back lets ffmpeg stamp two with the same wall-clock tick
            // and the RTSP muxer then reports non-monotonic DTS.
            if (session.videoQueue.length) {
                const next = session.videoQueue[0];
                const nextDueUs = session.mediaStartUs + (next.ptsUs - session.firstPtsUs);
                const afterUs = Date.now() * 1000;
                scheduleVideoPump(
                    session,
                    Math.max(VIDEO_MIN_WRITE_GAP_MS, Math.ceil((nextDueUs - afterUs) / 1000))
                );
            }
            return;
        }
    }

    function writeVideo(session, payload, ptsUs) {
        session.videoBytes += payload.length;
        session.videoFrames += 1;
        session.lastVideoAt = Date.now();

        // A client that omits timestamps must not collapse the stream onto one
        // instant. Falling back to the configured frame interval keeps the
        // relay usable with an older page during a rolling reload.
        const step = 1000000 / session.config.fps;
        const pts = Number.isFinite(ptsUs) && ptsUs > 0
            ? ptsUs
            : (session.lastPtsUs || 0) + step;
        session.lastPtsUs = pts;

        session.videoQueue.push({ payload, ptsUs: pts });
        session.videoQueueBytes += payload.length;
        while (session.videoQueueBytes > VIDEO_QUEUE_LIMIT && session.videoQueue.length > 1) {
            const dropped = session.videoQueue.shift();
            session.videoQueueBytes -= dropped.payload.length;
            session.droppedVideo += 1;
            session.needKeyframe = true;
        }
        pumpVideo(session);
    }

    function dispatchFrame(session, type, payload, ptsUs) {
        session.lastActivity = Date.now();
        if (type === VIDEO) {
            if (!payload.length) return;
            writeVideo(session, payload, ptsUs);
            return;
        }
        if (type === AUDIO) {
            // s16le stereo: one sample frame is 4 bytes.
            if (!payload.length || payload.length % 4 !== 0) return;
            writeAudio(session, payload);
        }
        // Unknown types are ignored on purpose: the client and this relay do
        // not have to be upgraded together.
    }

    // A session goes live when its first batch arrives. The stall timer starts
    // here rather than at session creation so a slow first encoded frame is not
    // mistaken for a dead stream.
    function markLive(session) {
        if (session.state !== 'starting') return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = null;
        session.state = 'live';
        session.startedAt = Date.now();
        session.lastActivity = session.startedAt;
        session.stallTimer = setInterval(() => {
            if (Date.now() - session.lastActivity > INGEST_STALL_MS) {
                failSession(session, 'The browser stopped sending data.');
            }
        }, 5000);
        if (session.stallTimer.unref) session.stallTimer.unref();
    }

    // One finite POST containing whole framed messages. Chromium refuses a
    // ReadableStream request body over HTTP/1.1, so the browser sends a batch
    // and waits for this response before composing the next one. That wait is
    // the transport's backpressure signal.
    function handleBatch(req, res, session, token) {
        if (!tokenMatches(session.token, token)) {
            writeJson(res, 403, { error: 'Invalid or missing session token.' });
            return;
        }
        if (session.state !== 'starting' && session.state !== 'live') {
            writeJson(res, 409, {
                error: session.error || `Session is ${session.state}.`,
                state: session.state
            });
            return;
        }
        markLive(session);
        session.lastActivity = Date.now();

        let pending = Buffer.alloc(0);
        let responded = false;
        let frames = 0;

        function reject(status, message) {
            if (responded) return;
            responded = true;
            writeJson(res, status, { error: message || session.error || 'The relay rejected this batch.' });
            // Keep draining. The client is waiting for this response, and
            // cutting the socket mid-upload only produces a vaguer error.
            req.resume();
        }

        req.on('data', (chunk) => {
            if (responded) return;
            session.lastActivity = Date.now();
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

            let offset = 0;
            while (pending.length - offset >= HEADER_BYTES) {
                const type = pending[offset];
                const length = pending.readUInt32BE(offset + 1);
                if (length > MAX_FRAME_BYTES) {
                    failSession(session, `Protocol error: frame length ${length} exceeds the limit.`);
                    reject(400, session.error);
                    return;
                }
                if (pending.length - offset < HEADER_BYTES + length) break;
                const ptsUs = Number(pending.readBigUInt64BE(offset + 5));
                const payload = pending.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
                dispatchFrame(session, type, payload, ptsUs);
                frames += 1;
                offset += HEADER_BYTES + length;
                if (session.state !== 'live') {
                    reject(409, session.error || `Session is ${session.state}.`);
                    return;
                }
            }

            if (offset >= pending.length) {
                pending = Buffer.alloc(0);
            } else if (offset > 0) {
                pending = pending.subarray(offset);
            }
            if (pending.length > MAX_BUFFERED_BYTES) {
                failSession(session, 'Protocol error: receive buffer overflow.');
                reject(400, session.error);
            }
        });

        req.on('end', () => {
            if (responded) return;
            if (pending.length) {
                reject(400, 'Protocol error: a batch ended in the middle of a frame.');
                return;
            }
            if (session.state !== 'live') {
                reject(409, session.error || `Session is ${session.state}.`);
                return;
            }
            responded = true;
            writeJson(res, 200, { ok: true, frames });
        });

        req.on('aborted', () => {
            responded = true;
        });
        req.on('error', () => {
            responded = true;
        });
    }

    function createSession(input) {
        const config = normaliseConfig(input);
        if (activeId) {
            const previous = sessions.get(activeId);
            if (previous && !previous.stopping) {
                finishSession(previous, 'replaced');
                // The old ffmpeg must be gone before the new one connects to
                // MediaMTX, or the two publishers race for the `live` path and
                // the loser can re-take it after the winner is live.
                killFfmpeg(previous, 'SIGKILL');
            }
        }

        const id = crypto.randomBytes(8).toString('hex');
        const token = crypto.randomBytes(24).toString('hex');
        const session = {
            id,
            token,
            config,
            state: 'starting',
            error: null,
            createdAt: Date.now(),
            startedAt: null,
            lastActivity: 0,
            lastVideoAt: 0,
            lastAudioAt: 0,
            videoBytes: 0,
            audioBytes: 0,
            videoFrames: 0,
            audioFrames: 0,
            droppedVideo: 0,
            droppedAudio: 0,
            resyncs: 0,
            needKeyframe: false,
            videoQueue: [],
            videoQueueBytes: 0,
            videoTimer: null,
            mediaStartUs: null,
            firstPtsUs: 0,
            lastPtsUs: 0,
            pendingAudio: [],
            pendingAudioBytes: 0,
            stderrTail: '',
            ffmpeg: null,
            videoServer: null,
            audioServer: null,
            videoSocket: null,
            audioSocket: null,
            stopping: false,
            finalized: false,
            stopReason: null
        };
        sessions.set(id, session);
        activeId = id;

        const videoPath = pipeName(id, 'v');
        const audioPath = pipeName(id, 'a');

        function attachPipeServer(sessionKey, onSocket) {
            const server = net.createServer((socket) => {
                if (session[`${sessionKey}Socket`]) {
                    // ffmpeg opens each input exactly once. A second client is
                    // either a stale reconnect or something that is not ffmpeg.
                    socket.destroy();
                    return;
                }
                session[`${sessionKey}Socket`] = socket;
                if (!server.__sockets) server.__sockets = new Set();
                server.__sockets.add(socket);
                socket.on('close', () => {
                    server.__sockets.delete(socket);
                    if (session[`${sessionKey}Socket`] === socket) {
                        session[`${sessionKey}Socket`] = null;
                    }
                });
                socket.on('error', () => { /* close follows */ });
                onSocket(socket);
            });
            server.on('error', (err) => {
                failSession(session, `Named pipe ${sessionKey} failed: ${err.message}`);
            });
            server.listen(sessionKey === 'video' ? videoPath : audioPath);
            return server;
        }

        session.videoServer = attachPipeServer('video', () => {
            // ffmpeg is now reading. Anything queued starts its media clock at
            // the first frame written, so the backlog does not arrive with
            // stale timestamps.
            pumpVideo(session);
        });
        if (config.audio) {
            session.audioServer = attachPipeServer('audio', () => {
                flushAudioQueue(session);
            });
        }

        const args = [
            '-hide_banner', '-loglevel', 'warning', '-nostdin',
            // The raw H.264 demuxer has no timestamps of its own. Assigning
            // each access unit the wall clock at read time is what keeps the
            // RTSP muxer's DTS monotonic while preserving real-time pacing.
            '-use_wallclock_as_timestamps', '1',
            '-f', 'h264', '-i', videoPath
        ];
        if (config.audio) {
            // Deliberately NOT wallclock-stamped: PCM timestamps come from the
            // sample count. Adding wallclock here produced non-monotonic DTS
            // and "Queue input is backward in time" from the RTSP muxer.
            args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', audioPath);
        }
        args.push('-map', '0:v:0');
        if (config.audio) {
            args.push(
                '-map', '1:a:0',
                '-c:a', 'libopus',
                '-b:a', String(config.audioBitrate),
                '-ar', '48000', '-ac', '2',
                '-application', 'lowdelay'
            );
        }
        args.push(
            '-c:v', 'copy',
            '-f', 'rtsp',
            '-rtsp_transport', 'tcp',
            rtspUrl
        );

        if (!fs.existsSync(ffmpegPath) && ffmpegPath !== 'ffmpeg') {
            failSession(session, `ffmpeg was not found at ${ffmpegPath}.`);
            return Promise.resolve(session);
        }

        let ffmpeg;
        try {
            ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (err) {
            failSession(session, `Could not start ffmpeg: ${err.message}`);
            return Promise.resolve(session);
        }
        session.ffmpeg = ffmpeg;
        ffmpeg.stderr.on('data', (chunk) => noteStderr(session, chunk));
        ffmpeg.on('error', (err) => {
            failSession(session, `ffmpeg could not run: ${err.message}`);
        });
        ffmpeg.on('exit', (code, signal) => {
            session.ffmpeg = ffmpeg;
            const tail = session.stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ');
            if (session.state === 'failed') {
                // already reported; just tear down
            } else if (session.stopping) {
                session.state = 'ended';
            } else if (code === 0) {
                session.state = 'ended';
            } else {
                session.state = 'failed';
                session.error = `ffmpeg exited (${code === null ? signal : code})${tail ? `: ${tail}` : ''}.`;
            }
            const finalError = session.error;
            finalizeSession(session);
            // A nonzero exit during a deliberate stop still deserves its stderr:
            // it is the difference between "the user stopped" and "the encoder
            // or muxer rejected the stream".
            const detail = finalError || (code !== 0 && tail ? `stderr: ${tail}` : '');
            log(`[StudioIngest] ${session.id} ffmpeg exited (${code === null ? signal : code})${detail ? ': ' + detail : ''}`);
        });

        session.idleTimer = setTimeout(() => {
            // markLive clears this timer when the first batch arrives, so
            // reaching it means the browser never sent anything.
            if (session.state === 'starting') finishSession(session, 'no-ingest');
        }, SESSION_IDLE_MS);
        if (session.idleTimer.unref) session.idleTimer.unref();

        // Give an immediately-bad spawn (missing DLL, bad argument) a moment
        // to fail so the HTTP response can say why instead of reporting 201
        // for an ffmpeg that is already gone.
        return new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                resolve(session);
            };
            if (ffmpeg.exitCode !== null) {
                setTimeout(done, 50);
                return;
            }
            const timer = setTimeout(done, 350);
            if (timer.unref) timer.unref();
            ffmpeg.once('spawn', () => {
                // Spawn success is not enough: ffmpeg validates the output URL
                // and codec options right after. The short wait below catches
                // the common immediate failures without delaying the UI.
                setTimeout(done, 250);
            });
        });
    }

    function sessionFromUrl(requestUrl) {
        const match = /^\/stream-api\/studio\/(session|ingest)\/([a-f0-9]+)\/?$/.exec(requestUrl.pathname);
        if (!match) return null;
        return { kind: match[1], id: match[2] };
    }

    function handle(req, res, requestUrl) {
        if (requestUrl.pathname === '/stream-api/studio/session') {
            if (req.method !== 'POST') {
                res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('405 Method Not Allowed');
                return true;
            }
            let body = '';
            let size = 0;
            let tooLarge = false;
            req.on('data', (chunk) => {
                if (tooLarge) return;
                size += chunk.length;
                if (size > 8192) {
                    tooLarge = true;
                    writeJson(res, 413, { error: 'Session request is too large.' });
                    req.resume();
                    return;
                }
                body += chunk.toString('utf8');
            });
            req.on('end', () => {
                if (tooLarge) return;
                let parsed = {};
                if (body.trim()) {
                    try {
                        parsed = JSON.parse(body);
                    } catch (_) {
                        writeJson(res, 400, { error: 'Invalid JSON.' });
                        return;
                    }
                }
                createSession(parsed).then((session) => {
                    if (session.state === 'failed') {
                        writeJson(res, 500, {
                            error: session.error || 'The relay could not start.',
                            id: session.id
                        });
                        return;
                    }
                    writeJson(res, 201, {
                        id: session.id,
                        token: session.token,
                        ingestUrl: `/stream-api/studio/ingest/${session.id}?token=${session.token}`,
                        statusUrl: `/stream-api/studio/session/${session.id}`,
                        stopUrl: `/stream-api/studio/session/${session.id}`,
                        audio: session.config.audio,
                        video: {
                            width: session.config.width,
                            height: session.config.height,
                            fps: session.config.fps,
                            bitrate: session.config.bitrate
                        }
                    });
                }).catch((err) => {
                    writeJson(res, 500, { error: err && err.message ? err.message : String(err) });
                });
            });
            req.on('error', () => { /* client vanished */ });
            return true;
        }

        const parsed = sessionFromUrl(requestUrl);
        if (!parsed) return false;
        const session = sessions.get(parsed.id);
        if (!session) {
            writeJson(res, 404, { error: 'No such studio ingest session.' });
            return true;
        }

        if (parsed.kind === 'ingest') {
            if (req.method !== 'POST') {
                writeJson(res, 405, { error: 'Use POST for the ingest stream.' });
                return true;
            }
            const token = requestUrl.searchParams.get('token') || '';
            handleBatch(req, res, session, token);
            return true;
        }

        // status / stop
        if (req.method === 'GET' || req.method === 'HEAD') {
            writeJson(res, 200, statusJson(session));
            return true;
        }
        if (req.method === 'DELETE') {
            const token = requestUrl.searchParams.get('token') || '';
            if (!tokenMatches(session.token, token)) {
                writeJson(res, 403, { error: 'Invalid or missing session token.' });
                return true;
            }
            const summary = statusJson(session);
            finishSession(session, 'client-stop');
            writeJson(res, 200, { ok: true, id: session.id, summary });
            return true;
        }
        writeJson(res, 405, { error: 'Use GET, HEAD or DELETE.' });
        return true;
    }

    function closeAll() {
        for (const session of sessions.values()) {
            finishSession(session, 'server-shutdown');
            // A parent process exiting does not kill its children on Windows,
            // and finishSession's kill is on a 1.5s timer. Shutdown wants it
            // now: an orphaned ffmpeg would keep publishing to MediaMTX.
            killFfmpeg(session, 'SIGKILL');
        }
    }

    // True while this relay still owns a session that is starting, live or
    // winding down. A failed/ended session does not count: its publisher is
    // gone, so a new start must not be mistaken for a takeover of our own.
    function hasActiveSession() {
        const session = sessions.get(activeId);
        return Boolean(session
            && session.state !== 'failed'
            && session.state !== 'ended');
    }

    return {
        handle,
        closeAll,
        hasActiveSession,
        getSession(id) {
            return sessions.get(id) || null;
        },
        stopSession(id, reason) {
            const session = sessions.get(id);
            if (!session) return false;
            finishSession(session, reason || 'stop');
            return true;
        },
        // Test seam: the manager's internals are not part of the HTTP API.
        _sessions: sessions,
        _config: { ffmpegPath, rtspUrl }
    };
}

module.exports = {
    createStudioIngest,
    normaliseConfig,
    containsIdr,
    pacingDecision,
    videoNeedsResync,
    pipeName,
    VIDEO,
    AUDIO,
    HEADER_BYTES,
    MAX_FRAME_BYTES
};
