'use strict';

/*
 * broadcast_worker.js — RTP encoded-transform worker for the browser broadcaster.
 *
 * This worker is the bridge between WebCodecs and the WebRTC packetizer. The
 * browser's RTCRtpScriptTransform hands us two streams per outbound track:
 *
 *   transformer.readable  the frames the sender is going to transmit.
 *   transformer.writable  where frames must be written to be transmitted.
 *
 * WHAT ACTUALLY FEEDS `readable`
 * ------------------------------
 * broadcast.js creates a TransformStream on the MAIN thread and transfers its
 * readable side into the RTCRtpScriptTransform constructor's third argument
 * (`transfer`). That is what makes this file three lines long, and it is the
 * only way to move encoded media into an RTCRtpSender.
 *
 * The obvious-looking alternative — pushing each EncodedVideoChunk over a
 * MessagePort with postMessage — CANNOT WORK. EncodedVideoChunk and
 * EncodedAudioChunk are not structured-cloneable; postMessage rejects them with
 * a DataCloneError before a single byte moves. The WebRTC Encoded Transform
 * spec's transfer argument exists precisely to move these objects without
 * cloning them.
 *
 * Consequently the sender's own built-in encoder output is never read here.
 * That is intentional, not an oversight: the tracks attached in broadcast.js
 * are blank capture tracks that exist only to give the sender a track, and
 * anything they produce is discarded by the browser in favour of the
 * transferred stream.
 *
 * A previous revision of this file drained `transformer.readable` to throw away
 * the built-in encoder's output. That was both unnecessary (see above) and
 * actively dangerous: the `rtctransform` event fires again every time a frame
 * is enqueued for processing, and each call did a fresh getReader() on a stream
 * that was already locked, throwing a TypeError and, in the worst case,
 * wedging the sender's pipeline. See broadcast.js `createBlankVideoTrack`,
 * which ran the blank track at 1 fps specifically to keep that path reachable.
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
    // pipeTo propagates backpressure from Chrome's packetizer back up to the
    // main-thread writer, which is what lets broadcast.js DROP a frame instead
    // of queueing it. Queueing is the wrong failure mode for live video: it
    // converts one dropped frame into unbounded latency that ends in a
    // multi-second freeze. On a slow uplink we lose frames, the picture keeps
    // moving, and the next keyframe repairs whatever was lost.
    readable.pipeTo(writable).then(
        () => log('transform for', name, 'closed cleanly'),
        (err) => log('transform for', name, 'ended:', err && err.message)
    );
};

