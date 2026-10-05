'use strict';

/*
 * broadcast_audio_worklet.js — fixed-size PCM tap for the studio audio mixer.
 *
 * AudioEncoder needs AudioData objects of an exact, constant frame size
 * (Opus: 480 samples at 48 kHz = 10 ms, or 960 = 20 ms). A MediaStreamTrack
 * cannot promise that: its read() yields chunks of whatever size the pipeline
 * happened to produce, which for a live graph varies with scheduling. Handing
 * those straight to AudioEncoder throws, and padding them to size would
 * introduce a variable, audible delay.
 *
 * An AudioWorklet is the only source that gives a sample-accurate, fixed-size
 * tap. The processor accumulates the browser's fixed 128-frame render quanta
 * into whole output frames and posts each one, transferring its buffer so no
 * copy is made per 10 ms.
 *
 * Shipped as a real static file (served from the same allowlist as app.js)
 * rather than a Blob URL: addModule() needs a fetchable URL anyway, and a real
 * file is parseable by `node --check` in run_tests.py, so a syntax error here
 * fails the test suite instead of failing silently in the browser.
 */

class StudioPcmTap extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.frameSize = opts.frameSize || 480;
        this.channels = Math.max(1, opts.channels || 2);
        // One interleaved-free planar buffer per channel, grown as needed.
        this.buffers = [];
        for (let c = 0; c < this.channels; c += 1) {
            this.buffers.push(new Float32Array(this.frameSize));
        }
        this.filled = 0;
    }

    process(inputs) {
        const input = inputs[0];
        // `[[]]` — one channel slot present but carrying nothing — is just as
        // dead as no input at all. Without this the length below is 0, the
        // copy loop never runs, `filled` never advances, and the encoder's
        // clock stalls for the rest of the session: audio simply stops, with
        // no error anywhere.
        const length = input && input.length && input[0] ? input[0].length : 0;
        if (!input || input.length === 0 || length === 0) {
            // No source this render quantum. Emit a completed frame anyway so
            // the encoder's clock never stalls: a gap in AudioData timestamps
            // makes the receiver's jitter buffer grow, which is audible as
            // drift.
            this.padAndEmit(length || this.quantumSize());
            return true;
        }

        let offset = 0;
        while (offset < length) {
            const room = this.frameSize - this.filled;
            // Math.max(1, ...) guarantees forward progress even if `filled` were
            // ever to reach frameSize (which would make room 0 and take 0). A
            // zero-length step would spin this loop forever on the real-time
            // thread — a 100% CPU hang with no recovery.
            const take = Math.max(1, Math.min(room, length - offset));
            for (let c = 0; c < this.channels; c += 1) {
                // A mono source feeding a stereo tap is duplicated, not
                // dropped: the encoder is configured for 2 channels and a
                // missing right channel plays as a hard-panned mono.
                const source = input[Math.min(c, input.length - 1)];
                const dest = this.buffers[c];
                if (!source) {
                    // Explicitly zero rather than skipping. Skipping would leave
                    // the previous frame's samples here, which is a silent
                    // wrong-audio path if it is ever reached.
                    dest.fill(0, this.filled, this.filled + take);
                    continue;
                }
                for (let i = 0; i < take; i += 1) {
                    dest[this.filled + i] = source[offset + i];
                }
            }
            this.filled += take;
            offset += take;
            if (this.filled >= this.frameSize) {
                this.filled = this.frameSize;
                this.emit();
            }
        }
        return true;
    }

    // The browser's render quantum: 128 samples in every shipping browser, but
    // it is a property of the context, not a constant, so the silence path
    // accounts for whatever the same loop above would have consumed.
    quantumSize() {
        return 128;
    }

    // Complete the in-progress frame with silence, at the SAME rate as real
    // audio.
    //
    // This must go through the same accumulator as the real-audio path. An
    // earlier version zeroed the whole buffer and emitted unconditionally once
    // per render quantum, which emitted a full 480-sample (10 ms) frame every
    // 128 samples (2.67 ms) — 3.75x the wall-clock rate. The receiver was then
    // handed 10 ms of audio per 2.67 ms of timestamp, so playback ran fast,
    // underran, and drifted ~730 ms against video every second of broadcast.
    //
    // Advancing `filled` by the quantum length keeps the frame rate identical to
    // the real-audio path, so a broadcast that starts or stops producing sound
    // keeps the same timeline instead of silently rescaling it.
    padAndEmit(quantum) {
        let remaining = Math.max(1, quantum);
        while (remaining > 0) {
            const room = this.frameSize - this.filled;
            const take = Math.max(1, Math.min(room, remaining));
            for (let c = 0; c < this.channels; c += 1) {
                // Only the REMAINDER is zeroed. Zeroing the whole buffer would
                // discard real samples already accumulated for this frame.
                this.buffers[c].fill(0, this.filled, this.filled + take);
            }
            this.filled += take;
            remaining -= take;
            if (this.filled >= this.frameSize) {
                this.filled = this.frameSize;
                this.emit();
            }
        }
    }

    emit() {
        // currentTime is in seconds and advances one render quantum at a time, so
        // it is the authoritative clock for the frame being emitted. It labels
        // the START of the quantum just rendered, so the frame is labelled
        // ~7 ms ahead of its first sample — a constant offset, and a monotonic
        // one, which is what the receiver's jitter buffer needs.
        const timestamp = Math.round(currentTime * 1000000);
        const transfers = [];
        const payload = { timestamp, channels: [] };
        const snapshots = [];
        for (let c = 0; c < this.channels; c += 1) {
            const copy = this.buffers[c].slice(0);
            snapshots.push(copy);
            transfers.push(copy.buffer);
        }
        // The accumulator is reset BEFORE the post. If postMessage threw while
        // `filled` was still frameSize, the next process() would compute a room
        // of 0 and loop forever on the real-time thread.
        this.filled = 0;
        // A failed post is swallowed deliberately. Letting it propagate out of
        // process() tears down the audio thread for the whole context, and the
        // only thing lost is one 10 ms frame — which the next frame replaces.
        // The accumulator is already reset, so the processor simply continues.
        try {
            this.port.postMessage({ timestamp, channels: snapshots }, transfers);
        } catch (err) {
            // Intentionally ignored; see above.
        }
    }
}

registerProcessor('studio-pcm-tap', StudioPcmTap);
