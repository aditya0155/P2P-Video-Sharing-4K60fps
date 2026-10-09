'use strict';

/* ==========================================================================
   Rydius Studio — browser screen-share broadcaster

   Publishes a screen / window / camera to the SAME MediaMTX path ("live") the
   existing OBS workflow uses, over WHIP, so viewers and codec_bridge.js cannot
   tell the two apart. OBS support is untouched: this is a second way in, not a
   replacement.

   --------------------------------------------------------------------------
   Why there are two engines
   --------------------------------------------------------------------------
   NATIVE  getDisplayMedia -> addTrack -> WHIP. The browser's own encoder does
          the work. Works on every browser that can do WHIP at all, and the
          browser handles the packetizer, congestion control, RTX and keyframe
          requests. Bitrate/framerate/resolution are set through
          RTCRtpSender.setParameters(). Limitation: the codec must be one the
          browser offers, and there is no control over the keyframe interval.

   WEBCODECS  getDisplayMedia -> canvas -> VideoEncoder -> RTCRtpScriptTransform
          -> WHIP. Real OBS-style control: exact codec string, bitrate, framerate,
          resolution, keyframe interval and hardware-acceleration preference.
          Requires RTCRtpScriptTransform (Chrome/Edge 124+) and WebCodecs.

   "auto" picks WEBCODECS when it is fully available AND the requested codec is
   one WebCodecs can actually produce, else NATIVE. The resolved engine is always
   displayed, and the reason is logged, so a fallback is never silent.

   --------------------------------------------------------------------------
   Composition
   --------------------------------------------------------------------------
   Everything is composited onto a canvas first, in both engines. That is what
   makes the OBS-style scenes (screen, screen + camera PiP, camera only) work
   identically no matter which encoder is downstream, and it means the encoder
   always receives a track of exactly the requested resolution.

   The canvas is drawn on a self-correcting timer rather than rAF alone: a
   backgrounded tab throttles rAF to ~1 Hz, which would silently turn a live
   broadcast into a slideshow while the UI still claimed to be live. A watchdog
   notices a starved tick and says so in the log.

   --------------------------------------------------------------------------
   Teardown
   --------------------------------------------------------------------------
   Every exit path (Stop button, browser "Stop sharing" bar, track ended,
   pagehide, ICE failure) runs through stopBroadcast(), which DELETEs the WHIP
   resource so MediaMTX frees the publisher immediately instead of waiting out
   readTimeout.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

    const WHIP_PATH = '/stream-api/live/whip';
    const SETTINGS_KEY = 'rydius.studio.settings.v1';
    const MAX_LOG_LINES = 60;
    // WHIP is non-trickle, so every candidate must be in the offer. Bound the
    // wait the same way the player does: exit on a ROUTABLE candidate, or when
    // gathering completes, or at this cap. See awaitRoutableCandidate().
    const ICE_GATHER_CAP_MS = 6000;
    const ICE_SETTLE_MS = 400;
    // The WHIP POST budget, and it is deliberately far larger than the player's
    // WHEP figure.
    //
    // MediaMTX does not write the 201 until ICE AND DTLS have completed, so a
    // legitimate publish can take ~12s on this host: webrtcSTUNGatherTimeout
    // (2s) is nested inside webrtcHandshakeTimeout (10s), and a first publish
    // also pays DTLS setup. The viewer's 10s abort is right for WHEP — it is
    // attaching to an already-live source — but reusing it here aborted
    // handshakes that were about to succeed, so "could not start publishing"
    // appeared on exactly the slow uplink the feature exists to serve. 25s
    // leaves headroom over the ~12s real case while still bounding a stuck one.
    const WHIP_POST_TIMEOUT_MS = 25000;
    // How long a transient ICE 'disconnected' is tolerated before the publish
    // is abandoned. Comfortably longer than the path blips this host actually
    // sees (a phone hotspot reassociating) and shorter than the time a viewer
    // would sit wondering whether the stream is coming back.
    const DISCONNECT_GRACE_MS = 8000;
    // The outer backstop for the whole publish handshake: ICE config fetch +
    // gather (capped at ICE_GATHER_CAP_MS) + the WHIP POST + applying the
    // answer. It must comfortably exceed the POST budget or it aborts a
    // handshake it is supposed to be watching — which is exactly what a 30s
    // watchdog did against a 25s POST. 75s bounds a genuinely stuck start
    // without ever racing the steps it is watching.
    const PUBLISH_WATCHDOG_MS = 75000;

    const el = {};
    const IDS = [
        'studio-canvas', 'studio-preview-placeholder', 'studio-preview-badge',
        'studio-scene-group', 'studio-screen-name', 'studio-screen-meta',
        'studio-camera-meta', 'studio-mic-meta', 'btn-pick-screen',
        'btn-toggle-camera', 'btn-toggle-mic', 'mix-system', 'mix-system-value',
        'mix-mic', 'mix-mic-value', 'studio-master-fill', 'set-engine',
        'engine-hint', 'set-codec', 'set-resolution', 'set-framerate',
        'set-bitrate', 'bitrate-readout', 'bitrate-presets', 'set-gop',
        'set-audio-bitrate', 'set-mouse-cursor', 'btn-go-live',
        'btn-go-live-label', 'btn-stop', 'tele-bitrate', 'tele-fps',
        'tele-resolution', 'tele-rtt', 'tele-dropped', 'tele-queue', 'tele-note',
        'tele-audio-dropped',
        'studio-log', 'studio-status-badge', 'studio-status-text',
    ];
    IDS.forEach((id) => { el[id] = document.getElementById(id); });

    const ctx = el['studio-canvas'].getContext('2d', { alpha: false });

    /* ======================================================================
       Pure helpers — no DOM, no WebRTC. These are the functions js_checks.js
       extracts and unit-tests, so the arithmetic that decides codec strings,
       bitrate budgets and SDP is verified without a browser.
       ====================================================================== */
    // H.264 level selection, from the resolution/frame rate actually requested.
    //
    // The level is a DECLARATION in the SDP, not a limit the browser enforces,
    // so a wrong value is a real interoperability bug: a receiver that trusts
    // profile-level-id will refuse to decode a stream that exceeds it, and the
    // symptom is a viewer that connects and then shows nothing.
    //
    // Thresholds are MaxFS (total macroblocks per frame) and MaxMBPS
    // (macroblocks/second). Macroblocks are 16x16, so a 1920x1080 frame is
    // 120*68 = 8160 MB.
    const H264_LEVEL_TABLE = [
        { idc: 0x1e, fs: 1620, mbps: 40500 },    // 3.0
        { idc: 0x1f, fs: 3600, mbps: 108000 },   // 3.1
        { idc: 0x20, fs: 3960, mbps: 216000 },   // 3.2
        { idc: 0x28, fs: 8192, mbps: 245760 },   // 4.0
        { idc: 0x29, fs: 8192, mbps: 245760 },   // 4.1
        { idc: 0x2a, fs: 8704, mbps: 522240 },   // 4.2
        { idc: 0x32, fs: 22080, mbps: 589824 },  // 5.0
        { idc: 0x33, fs: 36864, mbps: 983040 },  // 5.1
        { idc: 0x34, fs: 36864, mbps: 2073600 }, // 5.2
    ];

    function macroblocksFor(width, height) {
        return Math.ceil(width / 16) * Math.ceil(height / 16);
    }

    function h264LevelIdcFor(width, height, framerate) {
        const mb = macroblocksFor(width, height);
        const mbps = mb * Math.max(1, framerate);
        for (const level of H264_LEVEL_TABLE) {
            if (mb <= level.fs && mbps <= level.mbps) return level.idc;
        }
        return H264_LEVEL_TABLE[H264_LEVEL_TABLE.length - 1].idc;
    }

    // Constrained baseline (profile_idc 0x42) with constraint_set1..3 is 0xE0
    // in the constraint byte -> "42e0". Baseline is the profile MediaMTX's own
    // docs recommend for browser publishing, and the one that cannot produce
    // B-frames, which is the hard WebRTC incompatibility every browser shares.
    function h264CodecString(width, height, framerate) {
        const level = h264LevelIdcFor(width, height, framerate);
        return 'avc1.42e0' + level.toString(16).padStart(2, '0');
    }

    // avc1.42e02a -> 42e02a. Lowercase hex, no 0x, exactly 6 digits (RFC 6184).
    function profileLevelIdFromCodec(codec) {
        const parts = String(codec).split('.');
        return (parts[1] || '').toLowerCase();
    }

    // AV1 level 2.0 = 0, 3.0 = 4, 4.0 = 8, 4.1 = 9, 5.0 = 16, 5.1 = 17,
    // 5.2 = 18, 6.0 = 20. Two digits, 'M' is tier 0 (Main), '08' is 8-bit.
    // Thresholds are luma samples/second, so the declared level is never
    // under-stated for the resolution and frame rate actually being sent.
    function av1CodecString(width, height, framerate) {
        const pps = width * height * Math.max(1, framerate);
        let level;
        if (pps > 2359296 * 60) level = 20;      // 6.0
        else if (pps > 1179648 * 60) level = 18; // 5.2
        else if (pps > 1179648 * 30) level = 17; // 5.1
        else if (pps > 1179648 * 15) level = 16; // 5.0
        else if (pps > 589824 * 30) level = 9;   // 4.1
        else if (pps > 589824 * 15) level = 8;   // 4.0
        else if (pps > 147456 * 30) level = 4;   // 3.0
        else level = 0;                          // 2.0
        return 'av01.0.' + String(level).padStart(2, '0') + 'M.08';
    }

    // VP9 profile 0; levels are 2.0..5.1 encoded as 10..51 in the codec string.
    function vp9CodecString(width, height, framerate) {
        const mbps = macroblocksFor(width, height) * Math.max(1, framerate);
        let level;
        if (mbps > 2073600 * 4) level = 51;
        else if (mbps > 2073600) level = 50;
        else if (mbps > 983040) level = 41;
        else if (mbps > 522240) level = 40;
        else if (mbps > 245760) level = 31;
        else level = 30;
        return 'vp09.00.' + level + '.08';
    }

    // One place that decides which codec string a family means, so the SDP
    // munger and the WebCodecs encoder can never disagree about the profile.
    function codecStringFor(family, width, height, framerate) {
        switch (family) {
            case 'av1': return av1CodecString(width, height, framerate);
            case 'vp9': return vp9CodecString(width, height, framerate);
            case 'vp8': return 'vp8';
            case 'h264':
            default: return h264CodecString(width, height, framerate);
        }
    }

    // Even and macroblock-aligned. Chrome's software H.264 encoder rejects odd
    // dimensions outright, and an odd height also breaks the RTP packetizer's
    // assumption of 16-pixel macroblocks.
    function evenDimensionsFor(width, height) {
        const even = (n) => Math.max(16, Math.floor(n / 2) * 2);
        return { width: even(width), height: even(height) };
    }

    // Bits per pixel per frame, scaled by resolution and frame rate. Text and
    // UI need far less than motion; the slider is a suggestion the user can
    // override directly. Clamped to 250 kbps .. 20 Mbps, which is the band this
    // uplink can actually carry.
    function suggestedBitrateBps(width, height, framerate, family) {
        const density = { h264: 0.11, av1: 0.065, vp9: 0.09, vp8: 0.115 }[family] || 0.11;
        const raw = width * height * Math.max(1, framerate) * density;
        return Math.round(Math.min(20000000, Math.max(250000, raw)) / 1000) * 1000;
    }
    /* ---- SDP preparation for a PUBLISHING offer -------------------------
       The player's optimizeSdp() cannot be reused as-is: it injects b=AS into
       the video section, which on a recvonly offer declares how much the browser
       is willing to RECEIVE. On a sendonly publishing offer that same line is a
       promise about what we are about to send, so the publishing munger is its
       own function.

       It does the two things that actually matter for a WHIP publisher:

         1. Rewrites profile-level-id on every H.264 payload type to the profile
            the WebCodecs encoder is really producing. Chrome builds the SDP from
            the transceiver's codec list, which knows nothing about a WebCodecs
            encoder, so without this the offer can advertise a profile the
            bitstream does not contain.
         2. Guarantees packetization-mode=1, which is what matches the
            AVCC/length-prefixed output WebCodecs produces with
            avc: {format: 'avc'}. Announcing mode 0 while sending length-prefixed
            NAL units is a silent corruption that decodes as noise.

       Both are done in ONE pass over a copy of the section, and the rewritten
       fmtp lines are emitted directly after their rtpmap. The old implementation
       ran a second regex over the whole document to strip the original fmtp,
       which could match a line belonging to a different payload type. Emitting
       in one pass makes that impossible by construction: a payload type's fmtp
       is only ever produced beside its own rtpmap.
    */
    function optimizePublishSdp(sdp, options) {
        const opts = options || {};
        const wantH264 = typeof opts.h264ProfileLevelId === 'string'
            && /^[0-9a-f]{6}$/i.test(opts.h264ProfileLevelId);
        // The SDP name of the single codec family we are willing to negotiate,
        // or null to leave the offer's codec list alone (the native engine,
        // where the browser picks).
        const only = typeof opts.onlyCodecName === 'string' && opts.onlyCodecName
            ? opts.onlyCodecName.toUpperCase()
            : null;

        const source = String(sdp).split('\r\n');

        // Pass 1: which video payload types survive.
        //
        // PRUNING IS WHAT MAKES THE CODEC SELECTOR REAL. Merely re-ordering the
        // offer is not enough: MediaMTX's answerer (Pion) picks the first codec
        // in the offer that it supports, and Chrome's offer lists H264, VP8,
        // VP9 and AV1 together. Selecting "AV1" in the UI while an H.264 fmtp
        // is still present means the negotiated codec is whatever the answerer
        // happens to prefer, not what the host chose — the picture looks live
        // and is quietly the wrong codec, and the bridge then builds renditions
        // for the wrong source.
        //
        // Repair payloads survive too: rtx is referenced by `apt=<pt>`, so it is
        // kept exactly when the media payload it repairs is kept, and dropped
        // with it. Losing rtx while keeping the media codec is legal but throws
        // away the cheapest loss recovery there is.
        const keptVideoPts = new Set();
        if (only) {
            const nameByPt = new Map();
            const aptByPt = new Map();
            for (const line of source) {
                // Two INDEPENDENT scans. They were originally nested — the apt
                // match sat inside the rtpmap branch behind a `continue` — but
                // `apt=` lives on the a=fmtp: line, which never matches the
                // rtpmap pattern. So every rtx was recorded as having no apt
                // and silently pruned, and the offer that went out had no
                // retransmission stream at all.
                const rtp = line.match(/^a=rtpmap:(\d+)\s+([^\s/]+)\//i);
                if (rtp) nameByPt.set(rtp[1], rtp[2].toUpperCase());
                const apt = line.match(/^a=fmtp:(\d+)\s+.*\bapt=(\d+)/i);
                if (apt) aptByPt.set(apt[1], apt[2]);
            }
            for (const [pt, name] of nameByPt) {
                if (name === only) keptVideoPts.add(pt);
            }
            for (const [pt, apt] of aptByPt) {
                if (keptVideoPts.has(apt) && nameByPt.get(pt) === 'RTX') {
                    keptVideoPts.add(pt);
                }
            }
        }

        const out = [];
        let inVideo = false;
        // Payload types in the video section whose fmtp we have already emitted
        // ourselves, so the browser's own fmtp for them is skipped, not doubled.
        const rewritten = new Set();

        for (const line of source) {
            if (/^m=/.test(line)) {
                inVideo = /^m=video/.test(line);
                if (inVideo && only) {
                    // Rebuild the payload list to match what survives. A
                    // dropped pt left in the m= line is a malformed offer that
                    // some answerers reject outright.
                    const listed = line.match(/^m=video\s+\S+\s+\S+\s+([0-9 ]+)$/);
                    if (listed) {
                        const kept = listed[1].trim().split(/\s+/)
                            .filter((pt) => keptVideoPts.has(pt));
                        out.push('m=video 9 UDP/TLS/RTP/SAVPF ' + (kept.length ? kept.join(' ') : '0'));
                        continue;
                    }
                }
                out.push(line);
                continue;
            }
            if (!inVideo) {
                out.push(line);
                continue;
            }
            if (only) {
                // Drop every attribute that names a payload type we removed.
                const scoped = line.match(/^a=(rtpmap|fmtp|rtcp-fb|ssrc|ssrc-group):(\d+)\b/i);
                if (scoped && !keptVideoPts.has(scoped[2])) {
                    continue;
                }
            }

            const h264 = line.match(/^a=rtpmap:(\d+)\s+H264\/90000\s*$/i);
            if (h264) {
                const pt = h264[1];
                out.push(line);
                if (wantH264) {
                    out.push('a=fmtp:' + pt
                        + ' level-asymmetry-allowed=1'
                        + ';packetization-mode=1'
                        + ';profile-level-id=' + opts.h264ProfileLevelId);
                    rewritten.add(pt);
                }
                continue;
            }

            // Drop the browser's own fmtp for any H.264 payload type we rewrote.
            const fmtp = line.match(/^a=fmtp:(\d+)\s/i);
            if (wantH264 && fmtp && rewritten.has(fmtp[1])) {
                continue;
            }
            out.push(line);
        }

        return out.join('\r\n');
    }

    // The SDP codec name (the token in `a=rtpmap:<pt> <name>/90000`) for each
    // selectable codec id. This is the token `optimizePublishSdp` matches on
    // when pruning the offer, so it must be the SDP spelling and NOT the
    // WebCodecs spelling: Chrome writes "VP8"/"VP9" where WebCodecs says
    // "vp8"/"vp09.00.10.08", and pruning on the wrong token would silently keep
    // every payload type and the codec selector would do nothing.
    function sdpCodecNameFor(codecId) {
        switch (codecId) {
            case 'h264': return 'H264';
            case 'av1': return 'AV1';
            case 'vp9': return 'VP9';
            case 'vp8': return 'VP8';
            default: return null;
        }
    }

    // Which codec family the answer actually negotiated, read back out of the
    // SDP answer's video section. Used to tell the host the truth when the
    // answerer picked something other than what was asked for, instead of
    // showing a confident "live" for a stream that is not what they selected.
    function negotiatedVideoCodec(answerSdp) {
        const lines = String(answerSdp || '').split('\r\n');
        let inVideo = false;
        for (const line of lines) {
            if (/^m=/.test(line)) {
                if (inVideo) break;
                inVideo = /^m=video/.test(line);
                continue;
            }
            if (!inVideo) continue;
            const rtp = line.match(/^a=rtpmap:\d+\s+([^\s/]+)\//i);
            if (!rtp) continue;
            const name = rtp[1].toUpperCase();
            // Skip repair payloads; they are never the negotiated media codec.
            if (name === 'RTX' || name === 'RED' || name === 'ULPFEC' || name === 'FLEXFEC-03') {
                continue;
            }
            return name;
        }
        return null;
    }

    // Does the local description carry a candidate a remote peer can actually
    // dial? Chrome mDNS-obfuscates host candidates as <uuid>.local whenever the
    // page holds no camera/mic permission. MediaMTX is Pion and resolves no
    // mDNS, so an offer carrying only those has nothing to connect to and the
    // session would connect and then never carry media. The studio calls
    // getUserMedia for the mic, which normally suppresses obfuscation, but the
    // screen-only path (mic off) can still be obfuscated, so the check is
    // enforced rather than assumed.
    function hasRoutableCandidate(sdp) {
        if (!sdp) return false;
        return String(sdp).split('\r\n').some((line) =>
            line.startsWith('a=candidate:')
            && !/ [0-9a-f]{8}-[0-9a-f-]+\.local \d+ /i.test(line));
    }
    /* ======================================================================
       Capability detection and settings
       ====================================================================== */

    const supports = {
        videoEncoder: typeof window.VideoEncoder === 'function',
        audioEncoder: typeof window.AudioEncoder === 'function',
        scriptTransform: typeof window.RTCRtpScriptTransform === 'function',
        audioWorklet: !!(window.AudioContext && window.AudioContext.prototype.audioWorklet),
        displayMedia: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'),
    };
    // The WebCodecs engine needs all three of these, because it feeds both a
    // video and an audio track through the same injected-writer path. Video-only
    // would work without AudioEncoder, but a silent studio is a worse experience
    // than a fallback that carries system audio, so the engine is all-or-nothing.
    supports.fullWebCodecs = supports.videoEncoder
        && supports.audioEncoder
        && supports.scriptTransform;

    const settings = {
        engine: 'auto',
        codec: 'h264',
        width: 1920,
        height: 1080,
        framerate: 30,
        bitrateKbps: 4500,
        gopSeconds: 1,
        audioBitrate: 128000,
        showCursor: true,
        scene: 'screen',
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            Object.keys(settings).forEach((key) => {
                if (saved[key] !== undefined && typeof saved[key] === typeof settings[key]) {
                    settings[key] = saved[key];
                }
            });
        } catch (err) {
            // Private-mode / disabled storage: defaults are already correct.
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (err) {
            /* non-fatal */
        }
    }

    function resolutionFromValue(value) {
        const parts = String(value).split('x').map((n) => parseInt(n, 10));
        if (parts.length !== 2 || !parts[0] || !parts[1]) return { width: 1920, height: 1080 };
        return evenDimensionsFor(parts[0], parts[1]);
    }

    // Which engine will actually run. Reported in the UI so a downgrade is
    // never silent — the single most confusing failure otherwise is choosing
    // "WebCodecs" and quietly getting something else.
    function resolveEngine() {
        const wanted = el['set-engine'].value || settings.engine;
        if (wanted === 'native') return { engine: 'native', reason: 'Selected manually.' };
        if (wanted === 'webcodecs') {
            if (!supports.fullWebCodecs) {
                return {
                    engine: 'native',
                    reason: 'WebCodecs publishing needs Chrome/Edge 124+ (WebCodecs + AudioEncoder + '
                        + 'RTCRtpScriptTransform). Falling back to the native encoder.',
                };
            }
            return { engine: 'webcodecs', reason: 'WebCodecs engine (exact bitrate, keyframe and codec control).' };
        }
        if (!supports.fullWebCodecs) {
            return {
                engine: 'native',
                reason: 'This browser cannot inject WebCodecs frames, so the native encoder is used. '
                    + 'Bitrate, frame rate and resolution still apply.',
            };
        }
        return { engine: 'webcodecs', reason: 'WebCodecs engine available.' };
    }

    // The native engine cannot choose a codec string; it can only ask the
    // browser to prefer one. This is the ranking, and it deliberately matches
    // the player's (app.js configureCodecPreferences) so the codec the studio
    // prefers is the codec the player prefers to decode.
    function nativeCodecScore(mimeType) {
        const mime = String(mimeType).toLowerCase();
        if (/(rtx|red|ulpfec|flexfec)/.test(mime)) return 100;
        if (mime.includes('h264')) return 100;
        if (mime.includes('av01')) return 80;
        if (mime.includes('vp9')) return 70;
        if (mime.includes('vp8')) return 60;
        return 50;
    }

    function prioritiseNativeCodec(transceiver, family) {
        if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return false;
        if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
            return false;
        }
        try {
            const capabilities = RTCRtpSender.getCapabilities('video');
            if (!capabilities || !capabilities.codecs) return false;
            const weight = (mime) => {
                const m = String(mime).toLowerCase();
                if (/(rtx|red|ulpfec|flexfec)/.test(m)) return 1000;
                // The requested family must outrank everything else that is not
                // a repair payload, or the browser will quietly pick its own.
                if (family === 'h264' && m.includes('h264')) return 900;
                if (family === 'av1' && (m.includes('av01'))) return 900;
                if (family === 'vp9' && m.includes('vp9')) return 900;
                if (family === 'vp8' && m.includes('vp8')) return 900;
                return 10;
            };
            const ordered = capabilities.codecs.slice().sort((a, b) => weight(b.mimeType) - weight(a.mimeType));
            transceiver.setCodecPreferences(ordered);
            return true;
        } catch (err) {
            return false;
        }
    }
    /* ======================================================================
       State
       ====================================================================== */

    const state = {
        scene: 'screen',
        screenStream: null,
        cameraStream: null,
        micStream: null,
        screenVideo: null,
        cameraVideo: null,
        canvasStream: null,
        audioContext: null,
        audioDest: null,
        // Live publish session
        state: 'idle',          // idle | preparing | live | error
        engine: 'native',
        peerConnection: null,
        whipSessionUrl: null,
        whipAbortController: null,
        publishWatchdog: null,
        videoSender: null,
        audioSender: null,
        statsTimer: null,
        // WebCodecs
        videoEncoder: null,
        audioEncoder: null,
        transformWorker: null,
        videoWriter: null,
        audioWriter: null,
        audioWorkletNode: null,
        // Counters
        framesEncoded: 0,
        // Frames the packetizer refused because it was still busy with the
        // previous one. Tracked separately for video and audio: a video drop is
        // a visible glitch, an audio drop is a click, and the studio reports
        // them with different thresholds.
        framesDropped: 0,
        audioFramesDropped: 0,
        statsTickInFlight: false,
        lastStats: null,
        sessionToken: 0,
        // The AudioContext clock value used for the most recent video frame.
        // Held so two frames captured inside the same 128-sample render quantum
        // cannot share or reverse a timestamp. See mediaTimestampUs().
        lastMediaClockSeconds: 0,
        // Wall-clock deadline for the transient "disconnected" grace window.
        // See the connectionstatechange handler.
        disconnectGraceUntil: 0,
    };

    function log(message, kind) {
        const line = document.createElement('div');
        line.className = 'studio-log-line' + (kind ? ' studio-log-' + kind : '');
        const time = new Date();
        const stamp = String(time.getHours()).padStart(2, '0')
            + ':' + String(time.getMinutes()).padStart(2, '0')
            + ':' + String(time.getSeconds()).padStart(2, '0');
        line.textContent = stamp + '  ' + message;
        el['studio-log'].appendChild(line);
        while (el['studio-log'].childElementCount > MAX_LOG_LINES) {
            el['studio-log'].removeChild(el['studio-log'].firstElementChild);
        }
        el['studio-log'].scrollTop = el['studio-log'].scrollHeight;
    }

    function setUiState(next, detail) {
        state.state = next;
        const badge = el['studio-status-badge'];
        badge.classList.remove('offline', 'live', 'connecting', 'error');
        const labels = {
            idle: 'IDLE', preparing: 'CONNECTING', live: 'LIVE', error: 'ERROR',
        };
        badge.classList.add(next === 'idle' ? 'offline' : next);
        el['studio-status-text'].textContent = labels[next] || String(next).toUpperCase();
        el['btn-stop'].disabled = next !== 'live' && next !== 'preparing';
        el['btn-go-live'].disabled = next === 'live' || next === 'preparing';
        if (next === 'idle') {
            el['btn-go-live-label'].textContent = 'Go live';
        } else if (next === 'preparing') {
            el['btn-go-live-label'].textContent = 'Starting...';
        }
        if (detail) el['tele-note'].textContent = detail;
    }
    /* ======================================================================
       Capture: screen, camera, microphone
       ====================================================================== */

    function stopStream(stream) {
        if (!stream) return;
        stream.getTracks().forEach((track) => {
            try { track.stop(); } catch (err) { /* already stopped */ }
        });
    }

    function releaseVideoElement(video) {
        if (!video) return;
        try {
            video.pause();
            video.srcObject = null;
        } catch (err) { /* teardown race */ }
    }

    // displaySurface cannot be REQUESTED, only hinted at via the top-level
    // video.displaySurface constraint; the browser always shows its own picker
    // and may ignore the hint entirely. The whole UI therefore stays useful on
    // Safari, which honours none of these hints: the user picks a tab, window
    // or screen in the browser's own dialog, exactly as they would in OBS's
    // "Display Capture" source.
    async function pickScreenSource() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            log('This browser cannot capture the screen. Use Chrome or Edge.', 'error');
            return null;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: { ideal: 60 },
                    // The cursor is a capture-time setting: when off, Chrome
                    // omits the pointer from the captured frames entirely, which
                    // is both cheaper to encode and less distracting for slides.
                    cursor: settings.showCursor ? 'always' : 'never',
                },
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                systemAudio: 'include',
                selfBrowserSurface: 'exclude',
                surfaceSwitching: 'include',
                monitorTypeSurfaces: 'include',
                preferCurrentTab: false,
            });
        } catch (err) {
            // AbortError is the user closing the picker; that is not an error.
            if (err && err.name === 'AbortError') {
                log('Screen picker dismissed.');
            } else {
                log('Could not start screen capture: ' + (err && err.message ? err.message : err), 'error');
            }
            return null;
        }

        stopStream(state.screenStream);
        state.screenStream = stream;

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            const info = videoTrack.getSettings ? videoTrack.getSettings() : {};
            el['studio-screen-name'].textContent = describeSurface(info.displaySurface || 'unknown');
            el['studio-screen-meta'].textContent =
                (info.width || '?') + 'x' + (info.height || '?')
                + ' source, captured at ' + (info.frameRate || '?') + ' fps';

            // The browser's own "Stop sharing" bar ends the track without any
            // JS call. Without this listener the studio would keep publishing a
            // frozen last frame while claiming to be LIVE.
            videoTrack.addEventListener('ended', () => {
                log('Screen sharing was stopped by the browser.', 'warn');
                stopBroadcast('Screen sharing ended.');
            });
        }

        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            el['mix-system'].disabled = false;
            el['mix-system-value'].textContent = 'on';
            log('System audio is available for this source.');
        } else {
            el['mix-system'].disabled = true;
            el['mix-system-value'].textContent = 'none';
            log('No system audio on this source (tick "Share audio" in the picker for sound).');
        }

        state.screenVideo = attachVideoElement(videoTrack);
        el['studio-preview-placeholder'].style.display = 'none';
        startCompositor();
        return stream;
    }

    function describeSurface(surface) {
        if (surface === 'window') return 'Application window';
        if (surface === 'browser') return 'Browser tab';
        if (surface === 'monitor') return 'Entire screen';
        return 'Screen source';
    }

    function attachVideoElement(track) {
        if (!track) return null;
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = new MediaStream([track]);
        const started = video.play();
        if (started && typeof started.catch === 'function') {
            started.catch(() => { /* autoplay of a muted element is allowed */ });
        }
        return video;
    }
    async function toggleCamera() {
        if (state.cameraStream) {
            stopStream(state.cameraStream);
            releaseVideoElement(state.cameraVideo);
            state.cameraStream = null;
            state.cameraVideo = null;
            el['studio-camera-meta'].textContent = 'Off';
            el['btn-toggle-camera'].textContent = 'Enable';
            log('Camera disabled.');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
                audio: false,
            });
            state.cameraStream = stream;
            state.cameraVideo = attachVideoElement(stream.getVideoTracks()[0]);
            el['studio-camera-meta'].textContent = 'On (PiP)';
            el['btn-toggle-camera'].textContent = 'Disable';
            log('Camera enabled.');
            // Camera-only needs a camera; fall back rather than publishing black.
            if (state.scene === 'camera') setScene('pip');
        } catch (err) {
            log('Could not open the camera: ' + (err && err.message ? err.message : err), 'error');
        }
    }

    async function toggleMic() {
        if (state.micStream) {
            stopStream(state.micStream);
            state.micStream = null;
            el['studio-mic-meta'].textContent = 'Off';
            el['btn-toggle-mic'].textContent = 'Enable';
            el['mix-mic'].disabled = true;
            el['mix-mic-value'].textContent = '--';
            log('Microphone disabled.');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                    // Echo cancellation is ON deliberately: mixing a mic with
                    // system audio means the mic sits in the same room as the
                    // speakers, and without AEC the mic hears the mix and
                    // produces a feedback loop in every viewer.
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 2,
                },
            });
            state.micStream = stream;
            el['studio-mic-meta'].textContent = 'On';
            el['btn-toggle-mic'].textContent = 'Disable';
            el['mix-mic'].disabled = false;
            el['mix-mic-value'].textContent = 'on';
            log('Microphone enabled.');
        } catch (err) {
            log('Could not open the microphone: ' + (err && err.message ? err.message : err), 'error');
        }
    }

    function setScene(scene) {
        state.scene = scene;
        settings.scene = scene;
        saveSettings();
        const buttons = el['studio-scene-group'].querySelectorAll('.studio-seg');
        buttons.forEach((button) => {
            button.classList.toggle('active', button.dataset.scene === scene);
        });
        if (scene === 'camera' && !state.cameraStream) {
            log('Camera-only needs a camera source; enable the camera first.', 'warn');
        }
        startCompositor();
    }
    /* ======================================================================
       Compositor
       ---------------------------------------------------------------------
       Both engines publish a canvas capture, so the scene logic is shared and
       the encoder always sees exactly the requested output resolution.
    */
    let compositorTimer = null;
    let lastDrawAt = 0;
    let lastFrameWarnedAt = 0;

    function applyOutputResolution() {
        const size = evenDimensionsFor(settings.width, settings.height);
        if (el['studio-canvas'].width !== size.width || el['studio-canvas'].height !== size.height) {
            el['studio-canvas'].width = size.width;
            el['studio-canvas'].height = size.height;
        }
        el['studio-preview-badge'].textContent =
            size.width + 'x' + size.height + ' \u00b7 ' + settings.framerate + ' fps';
        return size;
    }

    // "contain" letterboxes the source instead of cropping it. Cropping a
    // window share silently cuts off the part of the window the presenter is
    // pointing at, which is the single most common way a screen share becomes
    // useless, so the default preserves the whole frame.
    function drawContained(ctx2d, source, boxWidth, boxHeight) {
        const sw = source.videoWidth || source.width;
        const sh = source.videoHeight || source.height;
        if (!sw || !sh) return false;
        const scale = Math.min(boxWidth / sw, boxHeight / sh);
        const dw = Math.round(sw * scale);
        const dh = Math.round(sh * scale);
        const dx = Math.round((boxWidth - dw) / 2);
        const dy = Math.round((boxHeight - dh) / 2);
        ctx2d.fillStyle = '#000000';
        ctx2d.fillRect(0, 0, boxWidth, boxHeight);
        ctx2d.drawImage(source, dx, dy, dw, dh);
        return true;
    }

    function drawFrame() {
        const canvas = el['studio-canvas'];
        const width = canvas.width;
        const height = canvas.height;
        const now = performance.now();
        const gap = now - lastDrawAt;
        lastDrawAt = now;

        // A hidden tab throttles timers to ~1 Hz. The UI would still read LIVE
        // while the picture effectively froze, so the starvation is surfaced
        // instead of hidden. Throttled to one warning a minute.
        if (compositorTimer && gap > Math.max(1000, 1000 / settings.framerate) * 3
            && now - lastFrameWarnedAt > 60000) {
            lastFrameWarnedAt = now;
            log('Compositor is being throttled (tab in the background?). '
                + 'Playback to viewers will stutter until this tab is visible.', 'warn');
        }

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        const screen = state.screenVideo;
        const camera = state.cameraVideo;
        const hasScreen = screen && screen.readyState >= 2 && (screen.videoWidth || 0) > 0;
        const hasCamera = camera && camera.readyState >= 2 && (camera.videoWidth || 0) > 0;

        if (state.scene === 'camera' && hasCamera) {
            drawContained(ctx, camera, width, height);
            return;
        }
        if (!hasScreen) {
            if (hasCamera) drawContained(ctx, camera, width, height);
            return;
        }

        if (state.scene === 'pip' && hasCamera) {
            // Screen fills the frame; the camera is inset bottom-right at 22%
            // of the shorter edge, with a margin, so it never covers the
            // presenter's own pointer area.
            drawContained(ctx, screen, width, height);
            const pipSize = Math.round(Math.min(width, height) * 0.22);
            const margin = Math.round(pipSize * 0.12);
            const pipX = width - pipSize - margin;
            const pipY = height - pipSize - margin;
            ctx.save();
            ctx.beginPath();
            // Rounded window, mirroring the preview badge style.
            const radius = Math.round(pipSize * 0.08);
            ctx.moveTo(pipX + radius, pipY);
            ctx.arcTo(pipX + pipSize, pipY, pipX + pipSize, pipY + pipSize, radius);
            ctx.arcTo(pipX + pipSize, pipY + pipSize, pipX, pipY + pipSize, radius);
            ctx.arcTo(pipX, pipY + pipSize, pipX, pipY, radius);
            ctx.arcTo(pipX, pipY, pipX + pipSize, pipY, radius);
            ctx.closePath();
            ctx.clip();
            drawContained(ctx, camera, pipSize, pipSize);
            ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = Math.max(2, Math.round(pipSize * 0.012));
            ctx.stroke();
            return;
        }

        drawContained(ctx, screen, width, height);
    }

    // A self-correcting interval timer rather than rAF: rAF stops entirely in a
    // hidden tab, which would freeze the broadcast, and setInterval keeps a
    // steady cadence that does not depend on paint scheduling. The interval is
    // half the frame period and the draw is skipped when the frame is not due
    // yet, which smooths out timer jitter without halving the output rate.
    function startCompositor() {
        if (compositorTimer) clearInterval(compositorTimer);
        applyOutputResolution();
        const tickMs = Math.max(4, Math.round(500 / settings.framerate));
        lastDrawAt = performance.now();
        compositorTimer = setInterval(() => {
            const now = performance.now();
            if (now - lastDrawAt < 1000 / settings.framerate - 1) return;
            drawFrame();
        }, tickMs);
    }
    /* ======================================================================
       Audio mixer
       ---------------------------------------------------------------------
       System audio and the mic are summed in WebAudio so both faders act on
       the mix. The sum is then either captured natively (MediaStreamAudio
       DestinationNode, for the native engine) or tapped sample-accurately by
       the AudioWorklet (for the WebCodecs engine).
    */
    const OPUS_FRAME_SAMPLES = 480;   // 10 ms at 48 kHz
    const OPUS_SAMPLE_RATE = 48000;

    async function buildAudioGraph() {
        // An ended destination track means the mix output is dead. This should
        // be unreachable — nothing stops that track any more — but the failure
        // it causes is silent and permanent (a broadcast with the UI showing
        // the mic as On and no sound reaching viewers), so it is detected
        // rather than trusted. Rebuilding costs one MediaStreamDestination.
        if (state.audioDest) {
            const live = state.audioDest.stream.getAudioTracks()
                .some((t) => t && t.readyState === 'live');
            if (state.audioDest.stream.getAudioTracks().length && !live) {
                log('The audio mix output had ended; rebuilding it.', 'warn');
                state.audioDest = null;
            }
        }
        if (state.audioContext) return state.audioContext;
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) {
            log('WebAudio is unavailable; this browser cannot mix audio.', 'error');
            return null;
        }
        // 48 kHz is required: Opus in WebRTC is defined at 48 kHz, and a
        // context running at 44100 would have to be resampled by the encoder.
        const context = new AudioCtor({ sampleRate: OPUS_SAMPLE_RATE });
        state.audioDest = context.createMediaStreamDestination();
        state.audioContext = context;
        return context;
    }

    // (Re)connect the live sources into the destination. Called on every start
    // and whenever a source is added or removed, so faders apply to whatever is
    // currently connected without rebuilding the graph.
    async function connectAudioSources() {
        const context = state.audioContext;
        if (!context) return;

        // Tear down previous per-source nodes so repeated starts do not stack
        // gain nodes (which would multiply the volume on every Go live).
        if (state.audioNodes) {
            state.audioNodes.forEach((node) => {
                try { node.disconnect(); } catch (err) { /* already gone */ }
            });
        }
        state.audioNodes = [];

        const systemTrack = state.screenStream ? state.screenStream.getAudioTracks()[0] : null;
        const micTrack = state.micStream ? state.micStream.getAudioTracks()[0] : null;

        const add = (track, faderEl) => {
            if (!track) return;
            const source = context.createMediaStreamSource(new MediaStream([track]));
            const gain = context.createGain();
            // Faders run 0..150%, so 100 maps to unity gain.
            gain.gain.value = (parseInt(faderEl.value, 10) || 0) / 100;
            source.connect(gain);
            gain.connect(state.audioDest);
            state.audioNodes.push(source, gain);
        };
        add(systemTrack, el['mix-system']);
        add(micTrack, el['mix-mic']);
    }

    function audioSourceCount() {
        const system = state.screenStream && state.screenStream.getAudioTracks().length ? 1 : 0;
        const mic = state.micStream && state.micStream.getAudioTracks().length ? 1 : 0;
        return system + mic;
    }

    // Sample-accurate tap for the WebCodecs engine. Returns a node whose
    // port emits {timestamp, channels:[Float32Array]} every 10 ms.
    async function attachPcmTap() {
        const context = state.audioContext;
        if (!context || !supports.audioWorklet) return null;
        if (state.audioWorkletNode) return state.audioWorkletNode;

        try {
            await context.audioWorklet.addModule('/streaming/broadcast_audio_worklet.js');
        } catch (err) {
            log('Could not load the audio tap: ' + (err && err.message ? err.message : err), 'error');
            return null;
        }

        const node = new AudioWorkletNode(context, 'studio-pcm-tap', {
            numberOfInputs: 1,
            // The tap READS the mix; it produces no audio of its own. It
            // delivers samples to the encoder through its MessagePort, not
            // through the audio graph, so it has no output.
            numberOfOutputs: 0,
            processorOptions: {
                frameSize: OPUS_FRAME_SAMPLES,
                channels: 2,
            },
        });
        // The direction matters and was previously reversed: the tap has NO
        // outputs, so `node.connect(state.audioDest)` connects nothing (and
        // with zero outputs it cannot at all). Nothing was ever connected TO
        // the node, so `inputs[0]` in the worklet was permanently empty, the
        // processor took its silence branch on every render quantum, and the
        // WebCodecs engine published a stream that was LIVE BUT MUTED — with
        // the UI showing audio levels moving from the very same mix, because
        // the meters read the pre-tap graph.
        //
        // The mix destination feeds the tap; the tap sends encoded audio to the
        // sender. The same destination still drives the MediaStream the native
        // engine captures, so this is additive, not a rewire.
        state.audioDest.connect(node);
        node.port.onmessage = (event) => onPcmFrames(event.data);
        state.audioWorkletNode = node;
        return node;
    }
    /* ======================================================================
       WebCodecs engine
       ====================================================================== */

    function videoEncoderConfig() {
        const size = evenDimensionsFor(settings.width, settings.height);
        const codec = codecStringFor(settings.codec, size.width, size.height, settings.framerate);
        const config = {
            codec,
            width: size.width,
            height: size.height,
            bitrate: settings.bitrateKbps * 1000,
            framerate: settings.framerate,
            // 'realtime' disables lookahead and frame reordering, which is what
            // a live stream needs. The default 'quality' mode buffers frames to
            // improve compression, which adds hundreds of milliseconds of
            // latency and can hold B-frames — the one thing WebRTC cannot carry.
            latencyMode: 'realtime',
        };
        if (settings.codec === 'h264') {
            // 'avc' is AVCC/length-prefixed NAL units, which is exactly what
            // packetization-mode=1 expects. 'annexb' would need mode 0 and is
            // not what Chrome's RTP packetizer consumes.
            config.avc = { format: 'avc' };
        }
        return config;
    }

    async function createVideoEncoder() {
        const config = videoEncoderConfig();
        // isConfigSupported is the authority on what this machine can encode.
        // Probing first means an unsupported combination (a 4K AV1 level the
        // hardware cannot reach, a profile the software encoder refuses) fails
        // with a clear message instead of a black stream.
        let support = { supported: false };
        try {
            support = await VideoEncoder.isConfigSupported(config);
        } catch (err) {
            log('Encoder probe failed: ' + (err && err.message ? err.message : err), 'error');
            return null;
        }
        if (!support || !support.supported) {
            log('This browser cannot encode ' + config.codec + ' at '
                + config.width + 'x' + config.height + '.', 'error');
            return null;
        }
        if (support.config && support.config.codec) {
            // Chrome may return a normalised config; use what it will really do.
            config.codec = support.config.codec;
        }

        const encoder = new VideoEncoder({
            output: (chunk) => onEncodedVideo(chunk),
            error: (err) => log('Video encoder error: ' + (err && err.message ? err.message : err), 'error'),
        });
        encoder.configure(config);
        state.videoEncoder = encoder;
        log('WebCodecs video encoder ready: ' + config.codec
            + ' ' + config.width + 'x' + config.height + '@' + config.framerate
            + ' ' + Math.round(config.bitrate / 1000) + ' kbps');
        return encoder;
    }

    // Feed the encoder on a fixed schedule. The canvas is captured as a
    // VideoFrame, which must be closed after every encode or the GPU stalls
    // within seconds — an unclosed frame holds a buffer that is never released.
    let encodeTimer = null;
    let lastKeyframeAt = 0;
    let nextEncodeAt = 0;
    // VideoFrame construction failures, and when the last one was logged. A
    // failure here stalls the picture entirely, so it is counted and surfaced
    // rather than swallowed. See encodeOnce.
    let videoFrameFailures = 0;
    let lastFrameFailureLoggedAt = 0;
    let disconnectGraceTimer = null;

    // ONE CLOCK FOR BOTH TRACKS.
    //
    // The previous revision stamped video frames with performance.now() and
    // audio frames with the AudioContext's currentTime. Those are different
    // clocks with different origins AND different crystals, so the offset
    // between the two tracks is arbitrary and drifts slowly over a long
    // broadcast — the classic "the presenter's voice arrives a second after
    // their mouth moves" report, which gets blamed on the network.
    //
    // The AudioContext clock is the right master here: the worklet already
    // derives audio timestamps from it, and it is a real-time sample clock
    // rather than a monotonic counter. Using it for video too puts both tracks
    // on one timeline with zero relative drift by construction.
    //
    // performance.now() is the fallback for a video-only broadcast, where there
    // is no audio timeline to agree with.
    function mediaTimestampUs() {
        const context = state.audioContext;
        if (context && context.state === 'running') {
            const t = context.currentTime;
            if (typeof t === 'number' && isFinite(t) && t > 0) {
                // The held value is validated rather than trusted. A NaN or
                // undefined here propagates straight into
                // `new VideoFrame(canvas, { timestamp })`, which throws, and
                // because the throw is caught per-frame the symptom is not an
                // error at all — it is a broadcast that silently stops
                // producing frames while still reporting "live".
                const held = state.lastMediaClockSeconds;
                const base = (typeof held === 'number' && isFinite(held) && held > 0) ? held : 0;
                if (t > base) {
                    state.lastMediaClockSeconds = t;
                    return Math.round(t * 1000000);
                }
                return Math.round(base * 1000000);
            }
        }
        return Math.round(performance.now() * 1000);
    }

    function encodeOnce(gopMs, forceKeyRef) {
        const encoder = state.videoEncoder;
        if (!encoder || encoder.state !== 'configured') return;
        // A bounded queue is correct for live video: if encoding cannot keep
        // up, dropping the newest frame keeps latency flat and the next
        // keyframe repairs the picture. Letting the queue grow instead turns
        // a slow encoder into unbounded delay.
        if (encoder.encodeQueueSize > 3) {
            state.framesDropped += 1;
            return;
        }
        const now = performance.now();
        let forceKey = forceKeyRef.value;
        if (now - lastKeyframeAt >= gopMs) {
            forceKey = true;
        }
        const canvas = el['studio-canvas'];
        let frame;
        try {
            frame = new VideoFrame(canvas, { timestamp: mediaTimestampUs() });
        } catch (err) {
            // A swallowed VideoFrame failure is NOT a no-op: no frame is
            // encoded, so the broadcast freezes while the UI still reads LIVE.
            // It is counted and surfaced instead, rate-limited to one log line
            // a minute so a persistent failure does not flood the log.
            videoFrameFailures += 1;
            const nowMs = performance.now();
            if (nowMs - lastFrameFailureLoggedAt > 60000) {
                lastFrameFailureLoggedAt = nowMs;
                log('Could not build a video frame from the canvas: '
                    + (err && err.message ? err.message : err)
                    + ' (' + videoFrameFailures + ' total) — playback to viewers is '
                    + 'stalled until this clears.', 'error');
            }
            return;
        }
        try {
            encoder.encode(frame, { keyFrame: forceKey });
            if (forceKey) {
                forceKeyRef.value = false;
                lastKeyframeAt = now;
            }
        } catch (err) {
            /* encoder closed mid-tick */
        } finally {
            frame.close();
        }
    }

    function startVideoEncodeLoop() {
        stopVideoEncodeLoop();
        const periodMs = 1000 / Math.max(1, settings.framerate);
        const gopMs = Math.max(1, settings.gopSeconds) * 1000;
        lastKeyframeAt = 0;
        // The first frame MUST be a keyframe: a viewer joining before the first
        // IDR sees nothing until the next one, which at a 4 s GOP is a 4 s
        // black screen. codec_bridge.js and every viewer hit this.
        const forceKeyRef = { value: true };

        // A self-correcting setTimeout chain, NOT setInterval.
        //
        // The previous version used setInterval(periodMs / 2) and relied on the
        // interval period alone to set the frame rate, which did not work: the
        // callback encoded on EVERY tick, so a 30 fps setting produced ~59
        // frames per second. That silently doubled the bitrate actually needed
        // (so the bitrate slider lied), doubled the encoder's GPU load, and
        // pushed the bridge's renditions over their targets. `framerate` in the
        // VideoEncoder config is a rate-control hint, not a gate — it does not
        // stop the caller submitting frames faster than requested.
        //
        // The next deadline is advanced from the PREVIOUS deadline rather than
        // from "now", so a late tick does not permanently shift the cadence and
        // quietly lower the real frame rate.
        const tick = () => {
            const now = performance.now();
            encodeOnce(gopMs, forceKeyRef);

            nextEncodeAt += periodMs;
            // If we fell more than a whole period behind (a long GC pause, a
            // backgrounded tab), re-anchor instead of firing a burst of
            // catch-up frames that would all land at once.
            if (nextEncodeAt < now - periodMs) {
                nextEncodeAt = now;
            }
            const delay = Math.max(0, Math.min(periodMs, nextEncodeAt - performance.now()));
            encodeTimer = setTimeout(tick, delay);
        };

        nextEncodeAt = performance.now();
        encodeTimer = setTimeout(tick, 0);
    }

    function stopVideoEncodeLoop() {
        if (encodeTimer) {
            clearTimeout(encodeTimer);
            encodeTimer = null;
        }
    }

    function onEncodedVideo(chunk) {
        state.framesEncoded += 1;
        if (!submitChunk(state.videoWriter, chunk)) {
            state.framesDropped += 1;
        }
    }
    // ---- WebCodecs audio --------------------------------------------------
    function audioEncoderConfig() {
        return {
            codec: 'opus',
            sampleRate: OPUS_SAMPLE_RATE,
            numberOfChannels: 2,
            bitrate: settings.audioBitrate,
        };
    }

    async function createAudioEncoder() {
        let support = { supported: false };
        try {
            support = await AudioEncoder.isConfigSupported(audioEncoderConfig());
        } catch (err) {
            return null;
        }
        if (!support || !support.supported) return null;

        const encoder = new AudioEncoder({
            output: (chunk) => onEncodedAudio(chunk),
            error: (err) => log('Audio encoder error: ' + (err && err.message ? err.message : err), 'error'),
        });
        encoder.configure(audioEncoderConfig());
        state.audioEncoder = encoder;
        return encoder;
    }

    // Convert the worklet's per-channel float frames into an AudioData and
    // encode. Packed interleaved 'f32' is used rather than 'f32-planar': Opus in
    // WebRTC is stereo, and the interleave loop below runs on 480 samples every
    // 10 ms, which is far cheaper than the resampling or a second copy the
    // planar path would need.
    function onPcmFrames(payload) {
        const encoder = state.audioEncoder;
        if (!payload || !encoder || encoder.state !== 'configured') return;
        // Bounded encoder queue, exactly as the video path has. A stalled main
        // thread (a long GC pause, a backgrounded tab) would otherwise let this
        // queue — and the worklet's port queue feeding it — grow without limit:
        // unbounded memory plus unbounded A/V lag, which is precisely the
        // failure mode the video-side check exists to prevent. The audio
        // threshold is looser because 10 ms frames accumulate faster than video.
        if (typeof encoder.encodeQueueSize === 'number' && encoder.encodeQueueSize > 8) {
            state.audioFramesDropped += 1;
            return;
        }
        // Backpressure from the packetizer is handled in onEncodedAudio, where
        // the chunk actually exists. Gating here as well would latch the flag
        // before any chunk had been produced and silently drop every frame.
        const channels = payload.channels;
        if (!channels || channels.length === 0) return;
        const numberOfFrames = channels[0].length;
        const numberOfChannels = channels.length;
        const interleaved = new Float32Array(numberOfFrames * numberOfChannels);
        for (let c = 0; c < numberOfChannels; c += 1) {
            interleaved.set(channels[c], c * numberOfFrames);
        }
        let audioData;
        try {
            audioData = new AudioData({
                format: 'f32',
                sampleRate: OPUS_SAMPLE_RATE,
                numberOfFrames,
                numberOfChannels,
                timestamp: payload.timestamp,
                data: interleaved,
            });
        } catch (err) {
            return;
        }
        try {
            encoder.encode(audioData);
        } catch (err) {
            /* encoder closed mid-frame */
        } finally {
            audioData.close();
        }
    }

    function onEncodedAudio(chunk) {
        // A dropped 10 ms audio frame is a tiny click; a QUEUED one lets audio
        // drift permanently out of sync with video, which is far worse. So the
        // same drop-don't-queue rule as video applies here.
        if (!submitChunk(state.audioWriter, chunk)) {
            state.audioFramesDropped += 1;
        }
    }

    // ---- Transform worker -------------------------------------------------
    function ensureTransformWorker() {
        if (state.transformWorker) return state.transformWorker;
        // Classic worker: the encoded transform runs in it and no DOM is
        // needed. The acks the old MessagePort design relied on are gone — the
        // TransformStream's own backpressure replaces them.
        const worker = new Worker('/streaming/broadcast_worker.js');
        state.transformWorker = worker;
        return worker;
    }

    // A sender needs a real MediaStreamTrack to exist. The stream we publish
    // is WebCodecs output, so the track attached here is a BLANK canvas
    // capture: it satisfies the sender, and because broadcast.js transfers its
    // own TransformStream into the RTCRtpScriptTransform, anything the built-in
    // encoder produces for it is discarded by the browser in favour of ours.
    //
    // The capture rate is 0, not 1. A previous revision used 1 fps, which
    // reliably produced one real frame per second from this track — feeding
    // the `rtctransform` event, and turning the worker's (since-removed)
    // stream-drain into a crash on a locked ReadableStream within a second of
    // going live. At 0 fps this track contributes no frames at all, which is
    // the entire point of it: it is a placeholder, not a source.
    function createBlankVideoTrack(width, height) {
        const scratch = document.createElement('canvas');
        scratch.width = width;
        scratch.height = height;
        const scratchCtx = scratch.getContext('2d');
        scratchCtx.fillStyle = '#000000';
        scratchCtx.fillRect(0, 0, width, height);
        const stream = scratch.captureStream(0);
        const track = stream.getVideoTracks()[0];
        // Keep the canvas alive for as long as the track is: a canvas whose
        // backing store has been garbage collected is a classic source of
        // "the video sender silently produces nothing".
        track.blankCanvas = scratch;
        return track;
    }

    // A silent placeholder audio track, for the same reason. The oscillator is
    // stopped and the nodes released in releaseBlankTracks(); leaving them
    // running leaked an oscillator, a gain node and a MediaStreamDestination
    // per publish attempt, which adds up fast on a machine that is also
    // running OBS, the codec bridge and MediaMTX.
    function createBlankAudioTrack() {
        const context = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        const track = destination.stream.getAudioTracks()[0];
        if (track) {
            track.blankNodes = { oscillator, destination, context };
        }
        return track;
    }

    // Stop and release every PLACEHOLDER track created above. Called from the
    // teardown path; safe to call repeatedly.
    //
    // The isBlank guard is load-bearing, not defensive tidiness. This runs over
    // BOTH engines, and in the NATIVE engine `state.audioSender.track` is the
    // REAL mix output — `state.audioDest.stream`'s only audio track, which is
    // shared and deliberately kept alive across sessions. Calling stop() on it
    // sets readyState='ended' while leaving it in the stream, and since
    // buildAudioGraph() early-returns for the life of the page and
    // state.audioDest is never rebuilt, the SECOND Go live would addTransceiver
    // an ended track: a permanently silent broadcast, with the UI still showing
    // the mic as On and a moving fader, and nothing logged. So only tracks this
    // module created as placeholders are stopped here.
    function releaseBlankTracks() {
        [state.videoSender, state.audioSender].forEach((sender) => {
            const track = sender && sender.track;
            if (!track) return;
            const isBlank = !!(track.blankNodes || track.blankCanvas);
            if (track.blankNodes) {
                try { track.blankNodes.oscillator.stop(); } catch (err) { /* already stopped */ }
                try { track.blankNodes.destination.disconnect(); } catch (err) { /* gone */ }
                track.blankNodes = null;
            }
            if (track.blankCanvas) {
                track.blankCanvas = null;
            }
            if (isBlank) {
                try { track.stop(); } catch (err) { /* already stopped */ }
            }
        });
    }

    function attachTransform(sender, name) {
        const worker = ensureTransformWorker();

        // EncodedVideoChunk / EncodedAudioChunk are NOT structured-cloneable,
        // so they cannot travel over a MessagePort: postMessage rejects them
        // with a DataCloneError before any bytes move. The only way to hand
        // encoded media to an RTCRtpSender is the transfer argument of the
        // RTCRtpScriptTransform constructor.
        //
        // So a TransformStream is created HERE, on the main thread. Its
        // readable side is transferred into the transform, which means the
        // worker receives it as `event.transformer.readable` and can pipe it
        // straight into Chrome's packetizer. We keep the writable side and
        // write chunks to it from the encoder output callbacks.
        const transport = new TransformStream();

        sender.transform = new RTCRtpScriptTransform(worker, { name }, [transport.readable]);

        const writer = transport.writable.getWriter();
        if (name === 'video') state.videoWriter = writer;
        else state.audioWriter = writer;
    }

    // Push one encoded chunk toward the packetizer, applying live-stream
    // backpressure.
    //
    // `desiredSize <= 0` means the previous chunk has not been consumed yet.
    // The correct response is to DROP this frame, not to queue it: a live
    // screen share that queues turns a momentary uplink shortfall into
    // unbounded latency, and by the time the backlog drains the picture is
    // seconds behind. Dropping keeps latency flat and the next keyframe
    // repairs the gap.
    function submitChunk(writer, chunk) {
        if (!writer) return false;
        if (typeof writer.desiredSize === 'number' && writer.desiredSize <= 0) {
            return false;
        }
        try {
            // Deliberately not awaited: the returned promise settles when the
            // stream has room again, which is what desiredSize above already
            // reports. Attaching a catch keeps a mid-teardown stream error from
            // becoming an unhandled rejection.
            const pending = writer.write(chunk);
            if (pending && typeof pending.catch === 'function') {
                pending.catch(() => {});
            }
            return true;
        } catch (err) {
            return false;
        }
    }
    /* ======================================================================
       WHIP publishing
       ====================================================================== */

    async function fetchIceServers() {
        // Same endpoint the player uses, so a broadcaster on the host machine
        // gets the same Cloudflare STUN plus any configured TURN relay. The
        // answer is never cached here: publishing happens once per session and
        // a stale relay credential would silently fail the handshake.
        try {
            const response = await fetch('/stream-api/turn', { cache: 'no-store' });
            if (!response.ok) return [];
            const data = await response.json();
            const servers = Array.isArray(data.iceServers) ? data.iceServers : [];
            // The server always injects the STUN entry; keep only what it
            // returned so the browser never invents its own STUN.
            return servers.filter((entry) => entry && entry.urls);
        } catch (err) {
            return [];
        }
    }

    // Wait until the local description carries a candidate a remote peer can
    // dial, or gathering finishes, or the cap expires. WHIP is non-trickle, so
    // whatever candidates exist at POST time are the only ones the server gets.
    function awaitRoutableCandidate(pc, token) {
        return new Promise((resolve) => {
            let settled = false;
            let pollTimer = null;
            let settleTimer = null;
            let capTimer = null;

            const finish = (why) => {
                if (settled) return;
                settled = true;
                if (pollTimer) clearTimeout(pollTimer);
                if (settleTimer) clearTimeout(settleTimer);
                if (capTimer) clearTimeout(capTimer);
                pc.removeEventListener('icegatheringstatechange', onState);
                if (why !== 'routable candidate') {
                    log('ICE gathering ended (' + why + ').');
                }
                resolve();
            };
            const onState = () => {
                if (token !== state.sessionToken) { finish('superseded'); return; }
                if (pc.iceGatheringState === 'complete') finish('gathering complete');
            };
            const poll = () => {
                if (settled) return;
                if (token !== state.sessionToken) { finish('superseded'); return; }
                const sdp = pc.localDescription && (pc.localDescription.value || pc.localDescription.sdp);
                if (hasRoutableCandidate(sdp)) {
                    // Settle briefly so a srflx/relay candidate that lands
                    // right after the host candidate still rides in the offer.
                    settleTimer = setTimeout(() => finish('routable candidate'), ICE_SETTLE_MS);
                    return;
                }
                pollTimer = setTimeout(poll, 100);
            };

            pc.addEventListener('icegatheringstatechange', onState);
            // The cap must be armed before the first poll: poll() would
            // otherwise reschedule against a cap that does not exist yet.
            capTimer = setTimeout(() => finish('gather cap reached'), ICE_GATHER_CAP_MS);
            poll();
        });
    }

    // Apply bitrate / frame rate / resolution to a native-engine sender.
    // setParameters is the only runtime control the browser exposes, and it is
    // the difference between the native engine being "works at all" and
    // matching the WebCodecs engine for the settings a user can actually pick.
    async function applyNativeSenderParams(sender, width, height) {
        if (!sender || typeof sender.getParameters !== 'function') return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = settings.bitrateKbps * 1000;
            params.encodings[0].maxFramerate = settings.framerate;
            // The canvas already produces the requested size, so the downscale
            // factor is 1 and only matters if the browser upscaled the track.
            const sourceHeight = sender.track && sender.track.getSettings
                ? (sender.track.getSettings().height || height)
                : height;
            const scale = sourceHeight / height;
            params.encodings[0].scaleResolutionDownBy = scale > 1 ? scale : 1;
            await sender.setParameters(params);
            log('Native encoder: ' + Math.round(settings.bitrateKbps) + ' kbps, '
                + settings.framerate + ' fps, downscale x'
                + params.encodings[0].scaleResolutionDownBy.toFixed(2) + '.');
        } catch (err) {
            // Safari rejects several of these. The stream still publishes, just
            // without the requested shaping, so this is a warning, not a failure.
            log('Could not apply encoder settings: ' + (err && err.message ? err.message : err), 'warn');
        }
    }

    async function startBroadcast() {
        if (state.state === 'live' || state.state === 'preparing') return;

        if (!state.screenStream && !state.cameraStream) {
            log('Choose a screen, window or tab first (or enable the camera).', 'error');
            return;
        }
        // Camera-only with no camera would publish a black canvas that looks
        // live; refuse rather than broadcast nothing.
        if (state.scene === 'camera' && !state.cameraStream) {
            log('Camera-only scene needs a camera source. Enable the camera or pick the Screen scene.', 'error');
            return;
        }

        const resolved = resolveEngine();
        state.engine = resolved.engine;
        el['engine-hint'].textContent = resolved.reason;
        log('Engine: ' + resolved.engine + '. ' + resolved.reason);

        state.sessionToken += 1;
        const token = state.sessionToken;
        setUiState('preparing', 'Starting...');

        // The publish watchdog. Every await below (audio graph, ICE config
        // fetch, candidate gathering, the WHIP POST, setRemoteDescription) can
        // in principle never settle — a fetch that never resolves, a
        // setRemoteDescription that hangs on a malformed answer. Without a
        // backstop the studio sits on "Starting..." forever with a PeerConnection
        // open, a WHIP POST outstanding and no way back except a page reload,
        // and the host's conclusion is that the feature is broken.
        //
        // Cleared the moment the connection reports 'connected'; also cleared
        // by the sessionToken bump in stopBroadcast, so a stale timer can never
        // tear down a LATER session.
        const watchdog = setTimeout(() => {
            if (token !== state.sessionToken) return;
            log('Publishing did not come up within '
                + Math.round(PUBLISH_WATCHDOG_MS / 1000) + 's.', 'error');
            stopBroadcast('Publishing timed out during setup.');
        }, PUBLISH_WATCHDOG_MS);
        state.publishWatchdog = watchdog;

        state.framesEncoded = 0;
        state.framesDropped = 0;
        state.audioFramesDropped = 0;
        // A fresh media timeline per session. Carrying the previous session's
        // clock forward would make the first video frame of the new broadcast
        // look like a huge forward jump to the RTP timestamp mapper.
        state.lastMediaClockSeconds = 0;
        state.disconnectGraceUntil = 0;
        applyOutputResolution();
        startCompositor();

        // The audio graph is built for both engines: native captures its
        // MediaStreamDestination track, WebCodecs taps it through the worklet.
        await buildAudioGraph();
        if (state.audioContext && state.audioContext.state === 'suspended') {
            try { await state.audioContext.resume(); } catch (err) { /* resumed by gesture */ }
        }
        await connectAudioSources();

        const size = evenDimensionsFor(settings.width, settings.height);
        const canvas = el['studio-canvas'];
        state.canvasStream = canvas.captureStream(settings.framerate);

        const iceServers = await fetchIceServers();
        if (token !== state.sessionToken) return;
        const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
        state.peerConnection = pc;

        pc.onconnectionstatechange = () => {
            if (token !== state.sessionToken) return;
            if (pc.connectionState === 'connected') {
                state.disconnectGraceUntil = 0;
                if (state.publishWatchdog) {
                    clearTimeout(state.publishWatchdog);
                    state.publishWatchdog = null;
                }
                setUiState('live', 'Publishing to the live path.');
                log('Live on WHIP. Viewers are being served now.');
                return;
            }
            if (pc.connectionState === 'disconnected') {
                // 'disconnected' is explicitly allowed to be TRANSIENT. A phone
                // hotspot changing bars, a Wi-Fi roam or a 200 ms path blip all
                // produce it, and ICE recovers on its own within a second or
                // two. The previous revision called stopBroadcast() here
                // immediately, so any momentary blip ended a live broadcast and
                // made the host click Go live again — strictly worse than OBS,
                // which rides out the same blip and keeps publishing.
                //
                // So: warn, and only give up if the link has not recovered
                // within the grace window. 'failed' is terminal by definition
                // and still stops at once.
                if (Date.now() < state.disconnectGraceUntil) return;
                state.disconnectGraceUntil = Date.now() + DISCONNECT_GRACE_MS;
                setUiState('preparing', 'Connection interrupted — reconnecting...');
                log('Publishing connection dropped. Waiting up to '
                    + Math.round(DISCONNECT_GRACE_MS / 1000)
                    + 's for it to recover before giving up.', 'warn');
                disconnectGraceTimer = setTimeout(() => {
                    disconnectGraceTimer = null;
                    if (token !== state.sessionToken) return;
                    if (pc.connectionState !== 'disconnected') return;
                    stopBroadcast('The publishing connection did not recover.');
                }, DISCONNECT_GRACE_MS);
                return;
            }
            if (pc.connectionState === 'failed') {
                log('Publishing connection failed.', 'error');
                stopBroadcast('The publishing connection failed.');
            }
        };

        try {
            if (state.engine === 'webcodecs') {
                await setupWebCodecsTracks(pc, size, token);
            } else {
                setupNativeTracks(pc, size);
            }
            if (token !== state.sessionToken) return;
            await completeWhipHandshake(pc, token, size);
        } catch (error) {
            if (token !== state.sessionToken) return;
            log('Could not start publishing: ' + (error && error.message ? error.message : error), 'error');
            stopBroadcast('Start failed.');
        }
    }
    /* ---- Track setup: native engine -------------------------------------
       The canvas capture is published directly and the browser encodes it.
       The composite audio destination is added alongside so system audio and
       the mic reach viewers mixed, as one Opus track.
    */
    function setupNativeTracks(pc, size) {
        const videoTrack = state.canvasStream.getVideoTracks()[0];
        const videoTransceiver = pc.addTransceiver(videoTrack, {
            direction: 'sendonly',
            sendEncodings: [{ maxBitrate: settings.bitrateKbps * 1000, maxFramerate: settings.framerate }],
        });
        state.videoSender = videoTransceiver.sender;
        if (!prioritiseNativeCodec(videoTransceiver, settings.codec)) {
            log('This browser cannot rank codecs; it will choose one itself.', 'warn');
        }
        applyNativeSenderParams(videoTransceiver.sender, size.width, size.height);

        const audioTracks = state.audioDest ? state.audioDest.stream.getAudioTracks() : [];
        if (audioTracks.length && audioSourceCount() > 0) {
            const audioTransceiver = pc.addTransceiver(audioTracks[0], {
                direction: 'sendonly',
                sendEncodings: [{ maxBitrate: settings.audioBitrate }],
            });
            state.audioSender = audioTransceiver.sender;
        } else {
            log('No audio sources selected; publishing video only.', 'warn');
        }
    }

    /* ---- Track setup: WebCodecs engine ----------------------------------
       Blank tracks create the senders; the transform worker replaces their
       encoded output with our WebCodecs chunks. The transforms are attached
       after addTransceiver but before the first encoded frame, so no frame is
       lost to the race the MDN example warns about.
    */
    async function setupWebCodecsTracks(pc, size, token) {
        const encoder = await createVideoEncoder();
        if (!encoder) {
            throw new Error('This browser cannot encode the selected codec at this resolution.');
        }

        const blankVideo = createBlankVideoTrack(size.width, size.height);
        const videoTransceiver = pc.addTransceiver(blankVideo, { direction: 'sendonly' });
        prioritiseNativeCodec(videoTransceiver, settings.codec);
        state.videoSender = videoTransceiver.sender;
        attachTransform(videoTransceiver.sender, 'video');

        if (audioSourceCount() > 0) {
            const tap = await attachPcmTap();
            const audioEncoder = await createAudioEncoder();
            if (!tap || !audioEncoder) {
                // Video-only is still a working broadcast; silence is not a
                // failure of the video path, so degrade instead of aborting.
                log('Audio encoding unavailable here; publishing video only.', 'warn');
            } else {
                const blankAudio = createBlankAudioTrack();
                const audioTransceiver = pc.addTransceiver(blankAudio, { direction: 'sendonly' });
                state.audioSender = audioTransceiver.sender;
                attachTransform(audioTransceiver.sender, 'audio');
            }
        } else {
            log('No audio sources selected; publishing video only.', 'warn');
        }

        if (token !== state.sessionToken) return;
        startVideoEncodeLoop();
    }
    /* ---- WHIP handshake --------------------------------------------------
       RFC 9725: POST the offer as application/sdp, take the answer from a 201,
       keep the Location header for the DELETE that ends the session. WHIP has
       no trickle ICE here, so gathering must have finished first.
    */
    async function completeWhipHandshake(pc, token, size) {
        const offer = await pc.createOffer();
        if (token !== state.sessionToken) return;
        await pc.setLocalDescription(offer);
        if (token !== state.sessionToken) return;

        await awaitRoutableCandidate(pc, token);
        if (token !== state.sessionToken) return;

        const raw = pc.localDescription.value || pc.localDescription.sdp;
        // Only claim an H.264 profile in the WebCodecs engine, where we know
        // exactly what the encoder emits. In the native engine the browser
        // picks the codec, so restating a profile would be a lie — and
        // pruning is skipped there too, because pruning the offer to one
        // family while the sender is free to pick any of them is how you get
        // a negotiation failure rather than a graceful fallback.
        const webCodecs = state.engine === 'webcodecs';
        const munged = optimizePublishSdp(raw, {
            onlyCodecName: webCodecs ? sdpCodecNameFor(settings.codec) : null,
            h264ProfileLevelId: (webCodecs && settings.codec === 'h264')
                ? profileLevelIdFromCodec(codecStringFor('h264', size.width, size.height, settings.framerate))
                : null,
        });

        state.whipAbortController = new AbortController();
        const postTimeout = setTimeout(() => {
            if (state.whipAbortController) state.whipAbortController.abort();
        }, WHIP_POST_TIMEOUT_MS);

        let response;
        try {
            response = await fetch(WHIP_PATH, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: munged,
                signal: state.whipAbortController.signal,
            });
        } finally {
            clearTimeout(postTimeout);
        }
        if (token !== state.sessionToken) return;

        if (!response.ok) {
            let detail = 'HTTP ' + response.status;
            try {
                const body = await response.json();
                if (body && body.error) detail = body.error;
            } catch (err) { /* non-JSON error body */ }
            throw new Error('MediaMTX rejected the WHIP offer (' + detail + ').');
        }

        // The Location header is the session resource; the DELETE at teardown
        // frees the publisher immediately instead of waiting for readTimeout.
        const location = response.headers.get('Location');
        if (location) {
            state.whipSessionUrl = new URL(location, window.location.origin).toString();
        } else {
            log('No Location header from MediaMTX; the session cannot be released early.', 'warn');
        }

        const answerSdp = await response.text();
        if (token !== state.sessionToken) {
            // A late answer for a session that no longer exists still has to
            // release its server-side resource, or MediaMTX keeps publishing to
            // nobody until the read timeout expires.
            if (state.whipSessionUrl) {
                fetch(state.whipSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
                state.whipSessionUrl = null;
            }
            return;
        }
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        if (token !== state.sessionToken) return;

        // Tell the host the truth if the answerer negotiated something other
        // than what was asked for. In the WebCodecs engine the offer is pruned
        // to a single family, so a mismatch here means MediaMTX refused it and
        // substituted a different codec — the picture would still be live, but
        // the bridge would build renditions for the wrong source and the
        // bitrate budget would belong to another codec. Silently accepting that
        // is how a "I picked AV1" broadcast ends up as H.264 with no indication
        // anything went wrong.
        const asked = sdpCodecNameFor(settings.codec);
        const got = negotiatedVideoCodec(answerSdp);
        if (webCodecs && asked && got && got !== asked) {
            log('Requested ' + asked + ' but the server negotiated ' + got
                + '. The stream is live, but it is not the codec you selected.', 'warn');
        }

        startStatsLoop(token);
    }
    /* ======================================================================
       Telemetry
       ====================================================================== */

    function startStatsLoop(token) {
        stopStatsLoop();
        state.lastStats = null;
        state.statsTimer = setInterval(() => collectStats(token), 1000);
    }

    function stopStatsLoop() {
        if (state.statsTimer) {
            clearInterval(state.statsTimer);
            state.statsTimer = null;
        }
    }

    async function collectStats(token) {
        const pc = state.peerConnection;
        // Overlap guard: getStats on a slow uplink can take longer than the 1 s
        // tick, and two overlapping reads would each compute a bitrate against
        // the same previous baseline, reporting double the real rate.
        if (!pc || token !== state.sessionToken || state.statsTickInFlight) return;
        state.statsTickInFlight = true;
        let report;
        try {
            report = await pc.getStats();
        } catch (err) {
            state.statsTickInFlight = false;
            return;
        }
        if (token !== state.sessionToken) {
            state.statsTickInFlight = false;
            return;
        }

        let bytesSent = 0;
        let framesSent = 0;
        let framesEncodedStat = 0;
        let rttMs = null;
        let resolution = '';

        report.forEach((entry) => {
            if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
                bytesSent += entry.bytesSent || 0;
                framesSent += entry.framesSent || 0;
                framesEncodedStat += entry.framesEncoded || 0;
                if (entry.frameWidth && entry.frameHeight) {
                    resolution = entry.frameWidth + 'x' + entry.frameHeight;
                }
            }
            if (entry.type === 'candidate-pair' && entry.state === 'succeeded'
                && typeof entry.currentRoundTripTime === 'number') {
                rttMs = entry.currentRoundTripTime * 1000;
            }
        });

        const previous = state.lastStats;
        const now = Date.now();
        if (previous && now > previous.at) {
            const seconds = (now - previous.at) / 1000;
            const kbps = ((bytesSent - previous.bytesSent) * 8) / seconds / 1000;
            el['tele-bitrate'].textContent = kbps.toFixed(0) + ' kbps';
            const delta = framesSent - previous.framesSent;
            el['tele-fps'].textContent = (delta / seconds).toFixed(1) + ' fps';
        }
        el['tele-resolution'].textContent = resolution || sizeLabel();
        el['tele-rtt'].textContent = rttMs === null ? '--' : rttMs.toFixed(0) + ' ms';
        el['tele-dropped'].textContent = String(state.framesDropped);
        el['tele-audio-dropped'].textContent = String(state.audioFramesDropped);
        el['tele-queue'].textContent = state.videoEncoder
            ? String(state.videoEncoder.encodeQueueSize)
            : 'n/a';

        state.lastStats = { at: now, bytesSent, framesSent, framesEncodedStat };
        state.statsTickInFlight = false;
    }

    function sizeLabel() {
        const size = evenDimensionsFor(settings.width, settings.height);
        return size.width + 'x' + size.height;
    }
    /* ======================================================================
       Teardown
       ---------------------------------------------------------------------
       One idempotent path for every exit. Order matters: bump the token FIRST so
       any in-flight await from a superseded start aborts itself, then release
       the server-side WHIP resource, then the local media.
    */
    function stopBroadcast(reason) {
        const wasLive = state.state === 'live' || state.state === 'preparing';
        // Invalidate every pending continuation immediately.
        state.sessionToken += 1;

        stopStatsLoop();
        stopVideoEncodeLoop();

        if (state.publishWatchdog) {
            clearTimeout(state.publishWatchdog);
            state.publishWatchdog = null;
        }
        if (disconnectGraceTimer) {
            clearTimeout(disconnectGraceTimer);
            disconnectGraceTimer = null;
        }
        if (state.whipAbortController) {
            state.whipAbortController.abort();
            state.whipAbortController = null;
        }

        // Release the publisher session on the server. keepalive lets this
        // survive the pagehide that triggered it.
        if (state.whipSessionUrl) {
            try {
                fetch(state.whipSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
            } catch (err) { /* best effort */ }
            state.whipSessionUrl = null;
        }

        if (state.peerConnection) {
            try {
                state.peerConnection.onconnectionstatechange = null;
                state.peerConnection.close();
            } catch (err) { /* already closed */ }
            state.peerConnection = null;
        }
        releaseBlankTracks();
        state.videoSender = null;
        state.audioSender = null;

        if (state.videoEncoder) {
            try { state.videoEncoder.close(); } catch (err) { /* already closed */ }
            state.videoEncoder = null;
        }
        if (state.audioEncoder) {
            try { state.audioEncoder.close(); } catch (err) { /* already closed */ }
            state.audioEncoder = null;
        }
        if (state.audioWorkletNode) {
            // The tap is wired as audioDest -> node, and the node has no
            // outputs, so `node.disconnect()` cannot sever it: it disconnects
            // OUTPUTS, of which there are none. The source side must be
            // disconnected explicitly, and each call is guarded on its own
            // because a zero-output disconnect may throw.
            try {
                state.audioDest.disconnect(state.audioWorkletNode);
            } catch (err) { /* already gone */ }
            try {
                state.audioWorkletNode.port.onmessage = null;
            } catch (err) { /* already gone */ }
            try {
                state.audioWorkletNode.disconnect();
            } catch (err) { /* already gone */ }
            state.audioWorkletNode = null;
        }
        if (state.transformWorker) {
            try { state.transformWorker.terminate(); } catch (err) { /* already gone */ }
            state.transformWorker = null;
        }
        // Release the TransformStream writers. Aborting rather than just
        // dropping the reference closes the stream, which ends the worker's
        // pipeTo cleanly instead of leaving it parked on a read that will
        // never complete.
        [state.videoWriter, state.audioWriter].forEach((writer) => {
            if (!writer) return;
            try {
                writer.abort().catch(() => {});
            } catch (err) { /* already closed */ }
        });
        state.videoWriter = null;
        state.audioWriter = null;

        stopStream(state.canvasStream);
        state.canvasStream = null;

        if (state.audioContext) {
            // The context and destination are kept alive across sessions so a
            // second Go live does not need a fresh user gesture to resume.
            // The per-source nodes are dropped so gains do not stack.
            if (state.audioNodes) {
                state.audioNodes.forEach((node) => {
                    try { node.disconnect(); } catch (err) { /* already gone */ }
                });
                state.audioNodes = [];
            }
        }

        if (wasLive) {
            log('Broadcast stopped. ' + (reason || ''), 'warn');
        }
        setUiState('idle', reason || 'Idle.');
        el['tele-bitrate'].textContent = '--';
        el['tele-fps'].textContent = '--';
        el['tele-rtt'].textContent = '--';
        el['tele-dropped'].textContent = '0';
        el['tele-audio-dropped'].textContent = '0';
    }

    // pagehide fires on tab close AND on bfcache navigation; beforeunload is
    // the belt-and-braces. Without these, a closed studio tab leaves MediaMTX
    // publishing a dead publisher until readTimeout, and because the path has
    // overridePublisher the next real broadcaster (OBS included) is fought for
    // that window.
    function handlePageExit() {
        stopBroadcast('Tab closed.');
    }
    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);
    /* ======================================================================
       UI wiring
       ====================================================================== */

    function readSettingsFromUi() {
        settings.engine = el['set-engine'].value;
        settings.codec = el['set-codec'].value;
        const size = resolutionFromValue(el['set-resolution'].value);
        settings.width = size.width;
        settings.height = size.height;
        settings.framerate = parseInt(el['set-framerate'].value, 10) || 30;
        settings.bitrateKbps = parseInt(el['set-bitrate'].value, 10) || 4500;
        settings.gopSeconds = parseInt(el['set-gop'].value, 10) || 1;
        settings.audioBitrate = parseInt(el['set-audio-bitrate'].value, 10) || 128000;
        settings.showCursor = el['set-mouse-cursor'].checked;
        el['bitrate-readout'].textContent = Math.round(settings.bitrateKbps) + ' kbps';
    }

    function applySettingsToUi() {
        el['set-engine'].value = settings.engine;
        el['set-codec'].value = settings.codec;
        el['set-resolution'].value = settings.width + 'x' + settings.height;
        el['set-framerate'].value = String(settings.framerate);
        el['set-bitrate'].value = String(settings.bitrateKbps);
        el['set-gop'].value = String(settings.gopSeconds);
        el['set-audio-bitrate'].value = String(settings.audioBitrate);
        el['set-mouse-cursor'].checked = settings.showCursor;
        el['bitrate-readout'].textContent = Math.round(settings.bitrateKbps) + ' kbps';
    }

    // A resolution or codec change while live would need a renegotiation, which
    // this page deliberately does not do mid-broadcast: a re-created track makes
    // codec_bridge.js restart its ffmpeg, which drops the RTMP/RTSP publisher leg
    // and closes every viewer's WHEP session. So the change is applied on the
    // next Go live and clearly said so, rather than silently doing nothing.
    function onSettingChanged(liveToo) {
        readSettingsFromUi();
        saveSettings();
        if (liveToo) {
            log('Encoder settings apply on the next Go live (changing them mid-broadcast '
                + 'would restart the codec bridge and drop every viewer).', 'warn');
            return;
        }
        applyOutputResolution();
        startCompositor();
        el['engine-hint'].textContent = resolveEngine().reason;
    }

    function suggestBitrate() {
        readSettingsFromUi();
        const suggestion = suggestedBitrateBps(settings.width, settings.height, settings.framerate, settings.codec);
        settings.bitrateKbps = Math.round(suggestion / 1000);
        el['set-bitrate'].value = String(settings.bitrateKbps);
        el['bitrate-readout'].textContent = settings.bitrateKbps + ' kbps (suggested)';
        saveSettings();
    }

    function initStudio() {
        loadSettings();
        applySettingsToUi();
        applyOutputResolution();

        const live = () => state.state === 'live' || state.state === 'preparing';

        el['btn-pick-screen'].addEventListener('click', () => { pickScreenSource(); });
        el['btn-toggle-camera'].addEventListener('click', () => { toggleCamera(); });
        el['btn-toggle-mic'].addEventListener('click', () => { toggleMic(); });

        el['studio-scene-group'].addEventListener('click', (event) => {
            const button = event.target.closest('.studio-seg');
            if (button && button.dataset.scene) setScene(button.dataset.scene);
        });

        el['btn-go-live'].addEventListener('click', () => { startBroadcast(); });
        el['btn-stop'].addEventListener('click', () => stopBroadcast('Stopped by you.'));

        el['mix-system'].addEventListener('input', (event) => {
            const value = event.target.value;
            el['mix-system-value'].textContent = value + '%';
            applyFader('system', value);
        });
        el['mix-mic'].addEventListener('input', (event) => {
            const value = event.target.value;
            el['mix-mic-value'].textContent = value + '%';
            applyFader('mic', value);
        });

        ['set-engine', 'set-codec', 'set-resolution', 'set-framerate',
            'set-gop', 'set-audio-bitrate', 'set-mouse-cursor'].forEach((key) => {
            el[key].addEventListener('change', () => onSettingChanged(live()));
        });
        el['set-bitrate'].addEventListener('input', () => onSettingChanged(live()));
        el['bitrate-presets'].addEventListener('click', (event) => {
            const chip = event.target.closest('.studio-chip');
            if (!chip) return;
            el['set-bitrate'].value = String(parseInt(chip.dataset.mbps, 10) * 1000);
            onSettingChanged(live());
        });

        // Report the resolved engine immediately, so the page explains itself
        // before anything is captured.
        el['engine-hint'].textContent = resolveEngine().reason;
        setUiState('idle', 'Pick a source, then press Go live.');
        if (!supports.displayMedia) {
            log('This browser cannot capture the screen (getDisplayMedia is missing). '
                + 'Chrome, Edge or a Chromium-based browser is required.', 'error');
        }
        log('Studio ready. Publishing to the same "live" path as OBS.');
    }

    // Fader changes must take effect live, so they bypass the next-Go-live rule
    // that governs encoder settings.
    function applyFader(which, value) {
        if (!state.audioContext || !state.audioNodes) return;
        const index = which === 'system' ? 0 : 1;
        const gain = state.audioNodes[index * 2 + 1];
        if (gain && gain.gain) {
            gain.gain.value = (parseInt(value, 10) || 0) / 100;
        }
    }

    initStudio();
});
