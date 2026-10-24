'use strict';

/*
 * broadcast_worker.js — RTP encoded-transform worker (NOT attached today).
 *
 * IMPORTANT: broadcast.js does not attach this worker. The WebCodecs publish
 * path is disabled by WEBCODECS_SENDER_INJECTION_SUPPORTED = false because no
 * shipping browser can inject WebCodecs output into an RTCRtpSender.
 *
 * The transform API does expose two streams per outbound track:
 *
 *   transformer.readable  the sender's OWN encoded output.
 *   transformer.writable  where frames for that same sender are written.
 *
 * What it does NOT do is accept arbitrary encoded media:
 *   - objects in the RTCRtpScriptTransform constructor's transfer list arrive
 *     in `transformer.options`, not as `transformer.readable`;
 *   - `transformer.writable` accepts only frames owned by the sender's own
 *     encoder. Writing a raw EncodedVideoChunk/Uint8Array was verified in
 *     Chrome 155 to throw "TypeError: Invalid frame";
 *   - EncodedVideoChunk is not structured-cloneable, so a MessagePort cannot
 *     carry it either.
 *
 * The identity pipe below is the only correct transform available today. It
 * lets the sender's own output through and applies backpressure, but it cannot
 * replace that output with WebCodecs chunks. A previous revision claimed the
 * transfer list was an injection path and that the built-in encoder output was
 * discarded in favour of it; both claims were false, and the resulting stream
 * was the blank track rather than the studio canvas.
 *
 * This file is intentionally dependency-free and side-effect-free apart from
 * installing the event handler, so it can be parsed by `node --check` in
 * run_tests.py like every other shipped script.
 */

function log(...args) {
    console.log('[broadcast-worker]', ...args);
}

self.onrtctransform = (event) => {
    const transformer = event.transformer;
    if (!transformer) return;
    const name = (transformer.options && transformer.options.name) || 'default';
    const { readable, writable } = transformer;
    if (!readable || !writable) {
        log('no streams for', name);
        return;
    }
    // Identity pass-through. Backpressure still propagates from Chrome's
    // packetizer to the sender's own encoder, which is the correct live-stream
    // behavior: drop rather than queue. It does NOT feed WebCodecs output into
    // the sender; see the header.
    readable.pipeTo(writable).then(
        () => log('transform for', name, 'closed cleanly'),
        (err) => log('transform for', name, 'ended:', err && err.message)
    );
};

