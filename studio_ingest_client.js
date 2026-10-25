'use strict';

/* ==========================================================================
   studio_ingest_client.js — the browser half of the studio ingest path

   Why this exists
   ---------------
   The old studio handed a MediaStream to RTCPeerConnection and let the browser
   pick an encoder. On this laptop that path topped out near 16 fps on every
   codec, while the same hardware H.264 encoder reached 170+ fps through
   WebCodecs. The browser's own WebRTC encoder was the ceiling, not the screen.

   This client takes WebRTC out of the publish path:

     <video> (screen capture) -> OffscreenCanvas -> VideoEncoder (H.264 Annex B)
        -> framed batched POSTs -> studio_ingest.js -> ffmpeg -c:v copy -> RTSP

   Video is never re-encoded: the bytes ffmpeg forwards are the bytes this
   encoder produced. Audio is the studio's mixed graph reduced to s16le by the
   AudioWorklet tap and encoded once by ffmpeg.

   Background tabs
   ---------------
   Chrome freezes/throttles a hidden tab hard enough that a 60 Hz JS loop runs
   at single-digit rates, regardless of whether the encoder is fast. There is
   no page-level opt-out. The one reliable exemption is a Document
   Picture-in-Picture window: while one is open the opener stays on a normal
   scheduling cadence even when its tab is hidden. The studio opens a small
   always-on-top "On Air" window for exactly that reason; if it is unavailable,
   the broadcast still works but only while the studio tab is visible.

   Wire format (must match studio_ingest.js)
   -----------------------------------------
     [type: 1][length: uint32 BE][timestamp: uint64 BE µs][payload]
     type 1 = one Annex B access unit, type 2 = s16le stereo 48 kHz PCM

   One HTTP request carries many whole frames. The browser cannot stream a
   request body over HTTP/1.1, so batching is the transport, not an
   optimisation; a batch never splits a frame.
   ========================================================================== */

(function (global) {
    'use strict';

    const VIDEO = 1;
    const AUDIO = 2;
    // type + length + media timestamp (microseconds). The timestamp is what
    // lets the relay write frames onto the pipe on their real timeline instead
    // of stamping a whole batch with one wall-clock instant.
    const HEADER_BYTES = 13;

    const AUDIO_RATE = 48000;
    const AUDIO_CHANNELS = 2;
    const AUDIO_FRAME_SAMPLES = 480;       // 10 ms, the Opus frame size
    const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS * 2;

    const KEYFRAME_INTERVAL_MS = 1000;
    // One queued chunk is already ~100 ms of latency at a keyframe. Dropping
    // video at 2 MB keeps the stream live rather than sliding further behind;
    // the encoder is asked for a new IDR so the decoder can recover.
    const VIDEO_QUEUE_LIMIT = 2 * 1024 * 1024;
    // Audio is ~192 KB/s. A backlog this large means the relay is not reading
    // at all, and continuing would only grow the delay.
    const QUEUE_HARD_LIMIT = 12 * 1024 * 1024;
    // Frames allowed to sit inside VideoEncoder before this tick is skipped.
    const ENCODER_QUEUE_LIMIT = 6;
    // One frame time of coalescing: a batch normally carries 1-2 video frames
    // and 1-2 audio frames, keeping the request rate near 30/s instead of 60/s
    // without adding a perceptible delay.
    const BATCH_DELAY_MS = 16;
    const BATCH_MAX_BYTES = 256 * 1024;
    // A localhost batch takes milliseconds. A request that has not answered in
    // this long is a dead relay, not congestion, and must not wedge the pump.
    const BATCH_TIMEOUT_MS = 8000;
    // Session creation spawns ffmpeg and binds two named pipes. It is local and
    // normally answers in well under a second; this bound exists so a wedged
    // host cannot leave the studio stuck on its busy overlay.
    const SESSION_TIMEOUT_MS = 15000;
    // Teardown must always finish. If the DELETE stalls, the upload socket is
    // already closed and the relay frees the session on its own.
    const STOP_TIMEOUT_MS = 5000;

    const WORKLET_URL = '/streaming/broadcast_audio_worklet.js';

    /* ----------------------------------------------------------------------
       Pure helpers (also exercised by js_checks.js)
       ---------------------------------------------------------------------- */

    function evenInt(value, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) return fallback;
        const rounded = Math.round(number);
        return rounded % 2 === 0 ? rounded : rounded - 1;
    }

    // "Match source" means the capture's own size, capped at 4K and made even
    // (H.264 4:2:0 cannot encode an odd width or height).
    function matchSourceDimensions(sourceWidth, sourceHeight, maxWidth, maxHeight) {
        const capW = maxWidth || 3840;
        const capH = maxHeight || 2160;
        let width = evenInt(sourceWidth, 1920);
        let height = evenInt(sourceHeight, 1080);
        const scale = Math.min(1, capW / width, capH / height);
        width = evenInt(width * scale, 1920);
        height = evenInt(height * scale, 1080);
        return { width, height };
    }

    // Fixed 16:9 presets, matching the resolution select on the page. 480p is
    // 854 wide because that is the conventional 16:9 value and stays even.
    function presetDimensions(presetHeight) {
        const height = evenInt(presetHeight, 0);
        if (!height) return null;
        const widths = { 2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854 };
        const width = widths[height] || evenInt(height * 16 / 9, 1920);
        return { width, height };
    }

    // H.264 level from Table A-1: MaxFS (macroblocks per frame) and MaxMBPS
    // (macroblocks per second). 1080p60 needs 4.2, 1440p60 needs 5.1, and
    // 2160p60 needs 5.2 — asking for a lower level makes isConfigSupported()
    // fail on hardware encoders even though the resolution itself is fine.
    function h264LevelIdc(width, height, fps) {
        const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
        const perSecond = macroblocks * fps;
        const levels = [
            [30, 1620, 40500],
            [31, 3600, 108000],
            [32, 5120, 216000],
            [40, 8192, 245760],
            [41, 8192, 245760],
            [42, 8704, 522240],
            [50, 22080, 589824],
            [51, 36864, 983040],
            [52, 36864, 2073600],
            [60, 139264, 4177920],
            [61, 139264, 8355840],
            [62, 139264, 16711680]
        ];
        for (const [idc, maxFrame, maxSecond] of levels) {
            if (macroblocks <= maxFrame && perSecond <= maxSecond) return idc;
        }
        return 62;
    }

    function h264CodecCandidates(width, height, fps) {
        const level = h264LevelIdc(width, height, fps).toString(16).toUpperCase().padStart(2, '0');
        // Constrained Baseline is what Chrome's hardware encoder actually
        // emitted in testing; Main/High are kept as fallbacks for GPUs that
        // refuse baseline at high levels.
        return Array.from(new Set([
            `avc1.42E0${level}`,
            `avc1.4D40${level}`,
            `avc1.6400${level}`,
            'avc1.42E02A',
            'avc1.42001E'
        ]));
    }

    function frameHeader(type, length, timestampUs) {
        const header = new Uint8Array(HEADER_BYTES);
        header[0] = type;
        header[1] = (length >>> 24) & 0xff;
        header[2] = (length >>> 16) & 0xff;
        header[3] = (length >>> 8) & 0xff;
        header[4] = length & 0xff;
        // Split rather than BigInt: media timestamps stay well below 2^53 µs,
        // and this runs on every frame.
        const stamp = Math.max(0, Math.floor(Number(timestampUs) || 0));
        const high = Math.floor(stamp / 0x100000000);
        const low = stamp >>> 0;
        header[5] = (high >>> 24) & 0xff;
        header[6] = (high >>> 16) & 0xff;
        header[7] = (high >>> 8) & 0xff;
        header[8] = high & 0xff;
        header[9] = (low >>> 24) & 0xff;
        header[10] = (low >>> 16) & 0xff;
        header[11] = (low >>> 8) & 0xff;
        header[12] = low & 0xff;
        return header;
    }

    function frameMessage(type, payload, timestampUs) {
        const length = payload.byteLength;
        const message = new Uint8Array(HEADER_BYTES + length);
        message.set(frameHeader(type, length, timestampUs), 0);
        message.set(payload, HEADER_BYTES);
        return message;
    }

    // Copies one EncodedVideoChunk into the wire format. Deliberately does not
    // close the chunk: EncodedVideoChunk has no close() method (only VideoFrame
    // does), so calling one threw on every frame and the broadcast produced
    // nothing. The encoder owns the chunk and releases it after this callback.
    function videoFrameMessage(chunk) {
        const length = chunk.byteLength;
        const framed = new Uint8Array(HEADER_BYTES + length);
        framed.set(frameHeader(VIDEO, length, chunk.timestamp), 0);
        chunk.copyTo(framed.subarray(HEADER_BYTES));
        return { framed, isKey: chunk.type === 'key' };
    }

    // Decides whether an incoming chunk fits. Video is sacrificial: a dropped
    // delta frame only costs one frame's motion as long as a keyframe follows.
    function backpressureDecision(kind, queuedBytes) {
        if (queuedBytes > QUEUE_HARD_LIMIT) return 'abort';
        if (kind === 'video' && queuedBytes > VIDEO_QUEUE_LIMIT) return 'drop';
        return 'accept';
    }

    function describeStartFailure(status, detail) {
        const body = (detail || '').trim();
        switch (status) {
            case 403:
                return body || 'Browser broadcasting only works on the host machine.';
            case 404:
                return 'The host does not expose the studio ingest routes. Restart start_host.bat.';
            case 409:
                return body || 'Another studio broadcast is already using the relay.';
            case 413:
                return 'The session request was too large. Reload the page and try again.';
            case 500:
                return body || 'The relay could not start ffmpeg on the host.';
            default:
                return body
                    ? `The relay refused the broadcast (${status}): ${body}`
                    : `The relay refused the broadcast (${status}).`;
        }
    }

    async function chooseEncoderConfig(options) {
        if (typeof global.VideoEncoder !== 'function') return null;
        const candidates = h264CodecCandidates(options.width, options.height, options.fps);
        const modes = options.cbr ? ['constant', 'variable'] : ['variable', 'constant'];
        const accelerations = ['prefer-hardware', 'no-preference'];

        for (const codec of candidates) {
            for (const bitrateMode of modes) {
                for (const hardwareAcceleration of accelerations) {
                    const config = {
                        codec,
                        width: options.width,
                        height: options.height,
                        bitrate: options.bitrate,
                        framerate: options.fps,
                        bitrateMode,
                        latencyMode: 'realtime',
                        hardwareAcceleration,
                        contentHint: options.contentHint || 'detail',
                        avc: { format: 'annexb' }
                    };
                    try {
                        const support = await global.VideoEncoder.isConfigSupported(config);
                        if (support && support.supported) {
                            return support.config || config;
                        }
                    } catch (err) {
                        // An unsupported codec string throws on some builds;
                        // trying the next candidate is the correct response.
                    }
                }
            }
        }
        return null;
    }

    /* ----------------------------------------------------------------------
       Upload queue

       A byte-accounted FIFO. The pump takes one item (waiting if necessary),
       gives the encoder a frame time to add a second, then drains whatever
       else is already queued up to a byte cap. Waiting for the POST response
       before taking the next batch is what gives real backpressure.
       ---------------------------------------------------------------------- */

    function createChunkQueue() {
        const items = [];
        const waiters = [];
        let bytes = 0;
        let closed = false;

        function wake() {
            const waiter = waiters.shift();
            if (waiter) waiter();
        }

        function takeNow() {
            if (!items.length) return null;
            const item = items.shift();
            bytes -= item.data.byteLength;
            return item;
        }

        return {
            push(item) {
                if (closed) return;
                items.push(item);
                bytes += item.data.byteLength;
                wake();
            },
            close() {
                closed = true;
                wake();
            },
            get bytes() {
                return bytes;
            },
            get length() {
                return items.length;
            },
            async shift() {
                while (!items.length) {
                    if (closed) return null;
                    await new Promise((resolve) => waiters.push(resolve));
                }
                return takeNow();
            },
            async takeBatch(maxBytes, delayMs) {
                const first = await this.shift();
                if (!first) return null;
                if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                const batch = [first];
                let size = first.data.byteLength;
                while (size < maxBytes) {
                    const item = takeNow();
                    if (!item) break;
                    batch.push(item);
                    size += item.data.byteLength;
                }
                return batch;
            },
            // Anything still queued after a stop is not worth uploading.
            clear() {
                items.length = 0;
                bytes = 0;
                wake();
            }
        };
    }

    /* ----------------------------------------------------------------------
       Publisher
       ---------------------------------------------------------------------- */

    class StudioPublisher {
        constructor(options) {
            const opts = options || {};
            this.video = opts.video;                 // playing <video> element
            this.width = evenInt(opts.width, 1920);
            this.height = evenInt(opts.height, 1080);
            this.fps = Math.min(120, Math.max(1, Math.round(opts.fps || 60)));
            this.bitrate = Math.min(50000000, Math.max(100000, Math.round(opts.bitrate || 6000000)));
            this.audioBitrate = Math.min(320000, Math.max(32000, Math.round(opts.audioBitrate || 128000)));
            this.cbr = opts.cbr !== false;
            this.contentHint = opts.contentHint === 'motion' ? 'motion' : 'detail';
            this.audioContext = opts.audioContext || null;
            this.audioInput = opts.audioInput || null;
            this.audioEnabled = Boolean(opts.audioContext && opts.audioInput);
            this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

            this.session = null;
            this.encoder = null;
            this.canvas = null;
            this.context2d = null;
            this.timer = null;
            this.statusTimer = null;
            this.audioNode = null;
            this.audioSink = null;

            this.queue = createChunkQueue();
            this.pumpAbort = null;
            this.pump = null;

            this.running = false;
            this.stopping = false;
            this.startedAt = 0;
            this.lastTickAt = 0;
            // Fractional frame credit. A Document-PiP window ticks timers at
            // ~62.75 Hz; encoding on every tick would push 62.75 fps into a
            // 60 fps stream. This accumulator spends one credit per encoded
            // frame so the wire rate matches the requested rate.
            this.frameBudget = 0;
            this.lastKeyAt = 0;
            this.forceKeyframe = false;
            this.frameIndex = 0;
            this.lastTimestampUs = 0;
            this.keyframes = 0;
            this.videoChunks = 0;
            this.audioChunks = 0;
            this.videoBytes = 0;
            this.audioBytes = 0;
            this.droppedVideo = 0;
            this.droppedAudio = 0;
            this.serverDropped = 0;
            this.audioOpen = false;
            this.lastStatus = null;
            this.statusFailures = 0;
            this.statusPolling = false;
            this.statsAt = 0;
            this.statsFrames = 0;
            this.statsBytes = 0;
            this.encoderConfig = null;
        }

        emit(type, detail) {
            try {
                this.onEvent(type, detail || {});
            } catch (err) {
                console.error('[StudioIngest] Event handler failed:', err);
            }
        }

        _enqueue(data, kind) {
            const decision = backpressureDecision(kind, this.queue.bytes);
            if (decision === 'abort') {
                this._fail('The upload is not keeping up with the encoder. Lower the bitrate or resolution and start again.');
                return false;
            }
            if (decision === 'drop') {
                if (kind === 'video') {
                    this.droppedVideo += 1;
                    // The chunk that was dropped is a reference frame for
                    // everything after it, so the next one must be an IDR.
                    this.forceKeyframe = true;
                } else {
                    this.droppedAudio += 1;
                }
                return false;
            }
            this.queue.push({ data, kind });
            return true;
        }

        _onChunk(chunk) {
            const { framed, isKey } = videoFrameMessage(chunk);
            const length = chunk.byteLength;

            this.videoChunks += 1;
            this.videoBytes += length;
            if (isKey) this.keyframes += 1;
            this._enqueue(framed, 'video');

            // Audio is deliberately held until the first video frame exists on
            // the wire. ffmpeg normalises each input's first timestamp to zero,
            // so starting the PCM earlier than the video would play audio
            // slightly ahead of the picture for the whole broadcast.
            if (!this.audioOpen) {
                this.audioOpen = true;
                this.emit('first-frame', {});
            }
        }

        _onEncoderError(err) {
            const message = (err && err.message) || String(err);
            this._fail(`The H.264 encoder failed: ${message}`);
        }

        _drawSource() {
            const video = this.video;
            const sourceWidth = video ? video.videoWidth : 0;
            const sourceHeight = video ? video.videoHeight : 0;
            if (!sourceWidth || !sourceHeight) return false;

            // Letterbox into the fixed output canvas. Sharing a window with a
            // different aspect ratio must not stretch it, and the black bars
            // are cheaper to encode than a resampled background.
            const scale = Math.min(this.width / sourceWidth, this.height / sourceHeight);
            const drawWidth = Math.max(2, Math.round(sourceWidth * scale));
            const drawHeight = Math.max(2, Math.round(sourceHeight * scale));
            const x = Math.floor((this.width - drawWidth) / 2);
            const y = Math.floor((this.height - drawHeight) / 2);

            const ctx = this.context2d;
            if (x !== 0 || y !== 0) {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.width, this.height);
            }
            try {
                ctx.drawImage(video, x, y, drawWidth, drawHeight);
            } catch (err) {
                // A frame can be unreadable for one tick while the capture
                // reconfigures (resolution change, monitor switch). The canvas
                // still holds the previous frame, which is the correct thing
                // to send until the source comes back.
                return false;
            }
            return true;
        }

        _tick() {
            if (!this.running) return;
            const now = performance.now();
            const interval = 1000 / this.fps;
            const elapsed = now - this.lastTickAt;
            // setInterval can fire a second callback immediately after a late
            // one. Encoding both would put two frames on the wire at the same
            // wall-clock instant, which ffmpeg turns into a visible stutter.
            if (elapsed < interval * 0.5) return;
            this.lastTickAt = now;

            // Credit is capped just above one frame so a tab that was frozen
            // for seconds resumes with at most one catch-up frame, not a burst
            // that blows through the bitrate for the next half second.
            this.frameBudget = Math.min(1.5, this.frameBudget + (elapsed / interval));
            if (this.frameBudget < 1) return;

            const encoder = this.encoder;
            if (!encoder || encoder.state !== 'configured') return;
            if (encoder.encodeQueueSize > ENCODER_QUEUE_LIMIT) {
                // The encoder is behind. Skipping a frame here does not break
                // the bitstream (nothing was encoded), it just drops a slot.
                // The credit is kept so the next free tick encodes immediately.
                return;
            }
            if (!this._drawSource()) return;
            this.frameBudget -= 1;

            const duration = Math.round(1000000 / this.fps);
            // Wall-clock media time, not frameIndex * duration. If a slot is
            // skipped because the encoder or the capture was behind, the next
            // frame's timestamp must jump by the real elapsed time. Compressing
            // it would make the relay's paced timeline run slower than the
            // clock and accumulate latency until it starts dropping frames.
            const timestamp = Math.max(
                this.lastTimestampUs + 1,
                Math.round((now - this.startedAt) * 1000) + 1
            );
            this.lastTimestampUs = timestamp;
            const frame = new global.VideoFrame(this.canvas, { timestamp, duration });
            const keyFrame = this.forceKeyframe
                || this.frameIndex === 0
                || (now - this.lastKeyAt) >= KEYFRAME_INTERVAL_MS;
            if (keyFrame) {
                this.forceKeyframe = false;
                this.lastKeyAt = now;
            }
            try {
                encoder.encode(frame, { keyFrame });
            } catch (err) {
                this._fail(`Could not encode a frame: ${(err && err.message) || err}`);
            } finally {
                frame.close();
            }
            this.frameIndex += 1;
        }

        // Sends batches until stopped. Each batch is a finite Blob: Chromium
        // cannot stream a request body over HTTP/1.1, and this host is plain
        // HTTP. Awaiting the response before composing the next batch is the
        // backpressure loop.
        async _pump() {
            while (this.running && this.session) {
                const batch = await this.queue.takeBatch(BATCH_MAX_BYTES, BATCH_DELAY_MS);
                if (!batch) return;

                const blob = new global.Blob(batch.map((item) => item.data));
                const abort = new AbortController();
                this.pumpAbort = abort;
                let timedOut = false;
                const timeout = setTimeout(() => {
                    timedOut = true;
                    try { abort.abort(); } catch (err) { /* already aborted */ }
                }, BATCH_TIMEOUT_MS);

                let response;
                try {
                    response = await fetch(this.session.ingestUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: blob,
                        cache: 'no-store',
                        signal: abort.signal
                    });
                } catch (err) {
                    if (!this.running || this.stopping) return;
                    this._fail(timedOut
                        ? 'The host stopped answering the upload. Is start_host.bat still running?'
                        : this._describeFetchFailure(err));
                    return;
                } finally {
                    clearTimeout(timeout);
                    if (this.pumpAbort === abort) this.pumpAbort = null;
                }

                let text = '';
                try { text = await response.text(); } catch (err) { /* connection died */ }
                if (!response.ok) {
                    let detail = text;
                    try { detail = JSON.parse(text).error || text; } catch (err) { /* plain text */ }
                    if (!this.running || this.stopping) return;
                    this._fail(describeStartFailure(response.status, detail));
                    return;
                }
            }
        }

        _describeFetchFailure(err) {
            if (err && err.name === 'AbortError') return 'The broadcast was cancelled.';
            if (err && err.name === 'TimeoutError') {
                return 'The host did not answer in time. Is start_host.bat still running?';
            }
            const message = (err && err.message) || String(err);
            if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
                return 'Could not reach the host server. Is start_host.bat still running?';
            }
            return `Could not upload the broadcast: ${message}`;
        }

        async _setupAudio() {
            if (!this.audioEnabled) return;
            const context = this.audioContext;
            if (!context.audioWorklet) throw new Error('This browser has no AudioWorklet support.');

            await context.audioWorklet.addModule(`${WORKLET_URL}?v=3`);
            let node = null;
            let sink = null;
            try {
                node = new global.AudioWorkletNode(context, 'studio-pcm-tap', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [AUDIO_CHANNELS],
                    processorOptions: {
                        frameSize: AUDIO_FRAME_SAMPLES,
                        channels: AUDIO_CHANNELS,
                        format: 's16le'
                    }
                });

                this.audioInput.connect(node);
                // The tap has to be part of a graph that reaches the
                // destination, or the audio thread never pulls it. A zero-gain
                // sink keeps it processing without sending the broadcast mix
                // to the speakers, which would feed the microphone back on
                // itself.
                sink = context.createGain();
                sink.gain.value = 0;
                node.connect(sink);
                sink.connect(context.destination);
            } catch (err) {
                // Nothing is retained on a partial setup, so a retry (or a
                // video-only broadcast) does not leave a live tap behind.
                if (node) {
                    try { this.audioInput.disconnect(node); } catch (_) { /* not connected */ }
                    try { node.disconnect(); } catch (_) { /* not connected */ }
                }
                if (sink) {
                    try { sink.disconnect(); } catch (_) { /* not connected */ }
                }
                throw err;
            }

            this.audioNode = node;
            this.audioSink = sink;

            node.port.onmessage = (event) => {
                const message = event.data;
                if (!message || message.format !== 's16le' || !message.buffer) return;
                if (!this.audioOpen || !this.running) return;
                const payload = new Uint8Array(message.buffer);
                if (payload.byteLength !== AUDIO_FRAME_BYTES) return;
                this.audioChunks += 1;
                this.audioBytes += payload.byteLength;
                // The PCM timestamp is advisory (ffmpeg derives audio time from
                // the sample count), but keeping the header uniform means the
                // relay never needs a special case.
                this._enqueue(frameMessage(AUDIO, payload, message.timestamp), 'audio');
            };
        }

        async _pollStatus() {
            if (!this.running || !this.session || (this.statusFailures > 0 && this.statusPolling)) return;
            this.statusPolling = true;
            try {
                const response = await fetch(this.session.statusUrl, { cache: 'no-store' });
                if (!response.ok) throw new Error(String(response.status));
                const status = await response.json();
                this.statusFailures = 0;
                this.lastStatus = status;
                if (status.needKeyframe) this.forceKeyframe = true;
                this.serverDropped = status.droppedVideo || 0;
                this.emit('status', status);
                if (status.state === 'failed') {
                    this._fail(status.error || 'The host relay reported a failure.');
                } else if (status.state === 'ended' || status.state === 'stopping') {
                    this._fail('The host relay closed the broadcast.');
                }
            } catch (err) {
                this.statusFailures += 1;
                if (this.statusFailures >= 3) {
                    this._fail('Lost contact with the host relay. Is start_host.bat still running?');
                }
            } finally {
                this.statusPolling = false;
            }
        }

        _fail(message) {
            if (this.stopping) return;
            this.stopping = true;
            this.running = false;
            clearInterval(this.timer);
            clearInterval(this.statusTimer);
            const session = this.session;
            this.emit('error', { message, session });
            // Free the server session promptly; the upload abort alone would
            // also do it, but only once the socket notices.
            if (session) {
                fetch(`${session.stopUrl}?token=${encodeURIComponent(session.token)}`, {
                    method: 'DELETE',
                    keepalive: true
                }).catch(() => {});
            }
            // closeLocal is deferred: _fail can be reached from inside the
            // encoder's own output callback, and closing an encoder from that
            // callback is not something the API promises to tolerate.
            setTimeout(() => this._closeLocal(), 0);
        }

        _closeLocal() {
            if (this.encoder && this.encoder.state !== 'closed') {
                try { this.encoder.close(); } catch (err) { /* already closed */ }
            }
            this.encoder = null;
            if (this.audioNode) {
                try { this.audioInput.disconnect(this.audioNode); } catch (err) { /* already gone */ }
                try { this.audioNode.disconnect(); } catch (err) { /* disconnected */ }
                try { this.audioNode.port.onmessage = null; } catch (err) { /* gone */ }
            }
            if (this.audioSink) {
                try { this.audioSink.disconnect(); } catch (err) { /* disconnected */ }
            }
            this.audioNode = null;
            this.audioSink = null;
            if (this.pumpAbort) {
                try { this.pumpAbort.abort(); } catch (err) { /* aborted */ }
                this.pumpAbort = null;
            }
            this.queue.clear();
            this.queue.close();
        }

        async start() {
            if (this.running) return;
            if (!global.VideoEncoder || !global.VideoFrame || !global.OffscreenCanvas) {
                throw new Error('This browser cannot encode video with WebCodecs. Use Chrome or Edge on the host machine.');
            }

            const config = await chooseEncoderConfig({
                width: this.width,
                height: this.height,
                fps: this.fps,
                bitrate: this.bitrate,
                cbr: this.cbr,
                contentHint: this.contentHint
            });
            if (!config) {
                throw new Error(`This machine cannot encode H.264 at ${this.width}×${this.height} and ${this.fps} fps. Try a lower resolution or frame rate.`);
            }
            this.encoderConfig = config;

            this.canvas = new global.OffscreenCanvas(this.width, this.height);
            this.context2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
            if (!this.context2d) {
                throw new Error('Could not create the video canvas.');
            }
            this.context2d.imageSmoothingEnabled = true;
            this.context2d.imageSmoothingQuality = 'medium';
            this.context2d.fillStyle = '#000';
            this.context2d.fillRect(0, 0, this.width, this.height);

            try {
                this.encoder = new global.VideoEncoder({
                    output: (chunk) => this._onChunk(chunk),
                    error: (err) => this._onEncoderError(err)
                });
                this.encoder.configure(config);
            } catch (err) {
                this._closeLocal();
                throw new Error(`Could not start the H.264 encoder: ${(err && err.message) || err}`);
            }

            // The audio tap is built BEFORE the relay session exists. The
            // session tells ffmpeg whether to open a PCM input, and an ffmpeg
            // waiting on a pipe that never receives a byte produces no output
            // at all. Deciding the flag first means a failed tap simply becomes
            // a video-only session instead of a dead broadcast.
            try {
                await this._setupAudio();
            } catch (err) {
                // Microphone-less video is a valid broadcast; announcing it is
                // the studio's job. Losing the audio graph must not kill video.
                console.warn('[StudioIngest] Audio tap unavailable, continuing video-only:', err);
                this.audioEnabled = false;
                this.emit('audio-unavailable', { message: (err && err.message) || String(err) });
            }

            let response;
            try {
                response = await fetch('/stream-api/studio/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    cache: 'no-store',
                    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
                    body: JSON.stringify({
                        width: this.width,
                        height: this.height,
                        fps: this.fps,
                        bitrate: this.bitrate,
                        audio: this.audioEnabled,
                        audioBitrate: this.audioBitrate
                    })
                });
            } catch (err) {
                this._closeLocal();
                throw new Error(this._describeFetchFailure(err));
            }
            if (!response.ok) {
                let detail = '';
                try { detail = await response.text(); } catch (err) { /* no body */ }
                this._closeLocal();
                throw new Error(describeStartFailure(response.status, detail));
            }
            this.session = await response.json();

            this.running = true;
            this.stopping = false;
            this.startedAt = performance.now();
            this.statsAt = this.startedAt;
            const interval = 1000 / this.fps;
            // Seed the tick clock one interval in the past so the immediate
            // _tick() below emits the first frame instead of waiting 16 ms.
            this.lastTickAt = this.startedAt - interval;
            this.frameBudget = 1;
            this.lastKeyAt = 0;
            this.frameIndex = 0;

            // Start the pump before the first frame so its queue has a
            // consumer already waiting when the encoder emits.
            this.pump = this._pump().catch((err) => {
                if (!this.stopping) this._fail(err.message || String(err));
            });
            this.timer = setInterval(() => this._tick(), interval);
            this._tick();
            this.statusTimer = setInterval(() => this._pollStatus(), 1000);
            this.emit('started', {
                width: this.width,
                height: this.height,
                fps: this.fps,
                bitrate: this.bitrate,
                audio: this.audioEnabled,
                config
            });
            // Resolves when the broadcast is RUNNING, not when it ends. The
            // pump promise lives on `this.pump`; returning it here made
            // `await publisher.start()` hang for the whole broadcast.
            return this;
        }

        async _stopSession() {
            const session = this.session;
            this.session = null;
            if (!session) return;
            if (this.pumpAbort) {
                try { this.pumpAbort.abort(); } catch (err) { /* aborted */ }
                this.pumpAbort = null;
            }
            this.queue.close();
            try {
                await fetch(`${session.stopUrl}?token=${encodeURIComponent(session.token)}`, {
                    method: 'DELETE',
                    keepalive: true
                });
            } catch (err) {
                // The session frees when the upload socket closes anyway.
            }
        }

        async stop(options) {
            const keepalive = Boolean(options && options.keepalive);
            if (this.stopping && !this.running) return;
            this.stopping = true;
            this.running = false;
            clearInterval(this.timer);
            clearInterval(this.statusTimer);
            this.timer = null;
            this.statusTimer = null;

            // Stop the pump and release any batch in flight. The DELETE below
            // is what tells the relay to close both pipe sockets, which is what
            // gives ffmpeg EOF and tears down the RTSP session.
            if (this.pumpAbort) {
                try { this.pumpAbort.abort(); } catch (err) { /* already aborted */ }
            }
            this.queue.close();

            const session = this.session;
            this.session = null;
            if (session) {
                const url = `${session.stopUrl}?token=${encodeURIComponent(session.token)}`;
                try {
                    // keepalive lets this survive the pagehide path, where the
                    // document is about to go away. The timeout keeps a stalled
                    // host from holding teardown open forever.
                    await fetch(url, {
                        method: 'DELETE',
                        keepalive,
                        signal: AbortSignal.timeout(STOP_TIMEOUT_MS)
                    });
                } catch (err) {
                    // The socket closing frees the session regardless.
                }
            }
            this._closeLocal();
            this.emit('stopped', {});
        }

        getStats() {
            const now = performance.now();
            const seconds = Math.max(0.001, (now - this.statsAt) / 1000);
            const frames = this.videoChunks - this.statsFrames;
            const bytes = this.videoBytes + this.audioBytes;
            const bytesDelta = bytes - this.statsBytes;
            this.statsAt = now;
            this.statsFrames = this.videoChunks;
            this.statsBytes = bytes;

            return {
                fps: frames / seconds,
                bitrate: (bytesDelta * 8) / seconds,
                width: this.width,
                height: this.height,
                targetFps: this.fps,
                videoChunks: this.videoChunks,
                audioChunks: this.audioChunks,
                keyframes: this.keyframes,
                droppedVideo: this.droppedVideo,
                droppedAudio: this.droppedAudio,
                serverDropped: this.serverDropped,
                queuedBytes: this.queue.bytes,
                queuedChunks: this.queue.length,
                encoderQueue: this.encoder ? this.encoder.encodeQueueSize : 0,
                config: this.encoderConfig,
                uptimeMs: this.startedAt ? now - this.startedAt : 0
            };
        }
    }

    function createPublisher(options) {
        return new StudioPublisher(options);
    }

    global.StudioIngest = {
        createPublisher,
        // Test seams for the pure protocol helpers.
        _pure: {
            evenInt,
            matchSourceDimensions,
            presetDimensions,
            h264LevelIdc,
            h264CodecCandidates,
            chooseEncoderConfig,
            frameHeader,
            frameMessage,
            videoFrameMessage,
            backpressureDecision,
            createChunkQueue
        }
    };
})(window);
