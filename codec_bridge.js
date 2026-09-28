'use strict';

/*
 * codec_bridge.js — GPU companion-rendition bridge for Rydius Stream.
 *
 * Launched by MediaMTX as the `runOnAvailable` hook of path "live" (see
 * mediamtx.yml). It watches the source stream and publishes the complementary
 * codec rendition so every browser can play, while AV1-capable viewers get a
 * bandwidth-saving rendition:
 *
 *   source AV1  -> live-h264 (h264_nvenc, default 6000k) for legacy browsers
 *   source H264 -> live-av1  (av1_nvenc,  default 3000k) for AV1 browsers
 *
 * Audio rescue: MediaMTX cannot hand the AAC audio of an RTMP/SRT source to
 * WebRTC readers, so the native path plays video-only. Whenever the source
 * audio is not Opus, the same ffmpeg process emits a second output (H264
 * video copy / AV1 re-encode, both with Opus audio) so the player can route
 * every viewer — including legacy browsers — to a full-sound rendition.
 *
 * Verified against MediaMTX v1.21.1 + ffmpeg 8.0 on this machine:
 *   - RTMP cannot serve AV1 back out of MediaMTX, RTSP can -> read via RTSP.
 *   - Audio must end as Opus for WebRTC readers; AAC sources are re-encoded.
 *   - MediaMTX hard-kills hooks on Windows (no SIGINT reaches us), so ffmpeg
 *     is guarded by a PID file that `runOnUnavailable` cleans up (--cleanup),
 *     and ffmpeg itself exits when the RTSP input disappears.
 *
 * Receiver-lag notes (why every stage is tuned for latency):
 *   - The RTSP read rides TCP so loopback loss can never stall it.
 *   - Video decodes on NVDEC (h264_cuvid/av1_cuvid) when available, keeping
 *     the CPU free for OBS capture; a probe guards machines without it and
 *     two fast failures fall back to CPU decode automatically (remembered
 *     for 24h so later broadcasts start instantly on CPU).
 *   - NVENC runs tune=ull (ultra low latency: no lookahead) with a
 *     frame-rate-probed ~1s IDR GOP so joining viewers and PLI recovery
 *     lock on quickly, and -maxrate/-bufsize pin VBR to the target rate
 *     so keyframe bursts cannot overflow MediaMTX's reader queues.
 *
 * Usage:
 *   node codec_bridge.js            # normal mode (MediaMTX runOnAvailable)
 *   node codec_bridge.js --cleanup  # kill leftover ffmpeg (runOnUnavailable)
 *
 * Environment (defaults match mediamtx.yml):
 *   MTX_PATH, RTSP_PORT, BRIDGE_RTMP_PORT, BRIDGE_API_BASE,
 *   BRIDGE_H264_BITRATE, BRIDGE_AV1_BITRATE, BRIDGE_AUDIO_BITRATE, BRIDGE_FFMPEG,
 *   BRIDGE_GPU_DECODE (=0 disables NVDEC, defaults on when the decoder exists),
 *   BRIDGE_GOP (keyframes in FRAMES; skips the frame-rate probe),
 *   BRIDGE_FFPROBE (ffprobe binary for the frame-rate probe)
 */

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_PATH = process.env.MTX_PATH || 'live';
const RTSP_PORT = process.env.RTSP_PORT || '8554';
const RTMP_PORT = process.env.BRIDGE_RTMP_PORT || '1935';
const API_BASE = process.env.BRIDGE_API_BASE || 'http://127.0.0.1:8888';
const H264_BITRATE = process.env.BRIDGE_H264_BITRATE || '6000k';
const AV1_BITRATE = process.env.BRIDGE_AV1_BITRATE || '3000k';
const AUDIO_BITRATE = process.env.BRIDGE_AUDIO_BITRATE || '160k';
const BUNDLED_FFMPEG = path.join(__dirname,
    'ffmpeg_win', 'ffmpeg-n8.1-latest-win64-gpl-shared-8.1', 'bin', 'ffmpeg.exe');

// The bundled ffmpeg 8.1 build is preferred over the system PATH: its AV1 RTP
// depacketizer fixes fragmented-keyframe reassembly (ffmpeg commit d12791ef,
// absent from 8.0), which is what lets OBS WHIP AV1 sources sync on the RTSP
// leg — ffmpeg 8.0 loops forever on "Unexpected fragment continuation". An
// explicit BRIDGE_FFMPEG override wins; the system PATH is the last fallback.
function resolveFfmpegBinary() {
    if (process.env.BRIDGE_FFMPEG) {
        return process.env.BRIDGE_FFMPEG;
    }
    try {
        if (fs.existsSync(BUNDLED_FFMPEG)) {
            return BUNDLED_FFMPEG;
        }
    } catch (err) {
        /* stat failure falls through to PATH */
    }
    return 'ffmpeg';
}
const FFMPEG = resolveFfmpegBinary();

// Overridable so a test (or a second bridge) can use an isolated record instead
// of the shared per-user temp path, where two bridges would overwrite each other.
const PID_FILE = process.env.BRIDGE_PID_FILE
    ? path.resolve(process.env.BRIDGE_PID_FILE)
    : path.join(os.tmpdir(), 'rydius_codec_bridge.pid');
const VIDEO_CODECS = ['AV1', 'H264', 'H265', 'HEVC', 'VP8', 'VP9'];
const MAX_CONSECUTIVE_FFMPEG_FAILURES = 10;
// How long to wait before the give-up exit, so MediaMTX's runOnAvailableRestart
// cannot turn a 10-failure crash-loop into a hot loop that keeps kicking the
// publisher. See the exit site for the full reasoning.
const DEFAULT_GIVE_UP_BACKOFF_MS = 60000;
// Validated, because a typo silently DELETES the mitigation: an unvalidated
// Number('abc') is NaN, `await sleep(NaN)` fires on the next tick, and the only
// symptom is a log line reading "backing off NaNs".
const GIVE_UP_BACKOFF_MS = (() => {
    const raw = process.env.BRIDGE_GIVE_UP_BACKOFF_MS;
    if (raw === undefined || raw === '') return DEFAULT_GIVE_UP_BACKOFF_MS;
    const ms = Number(String(raw).trim());
    if (Number.isFinite(ms) && ms >= 0 && ms <= 3600000) return ms;
    logError(`BRIDGE_GIVE_UP_BACKOFF_MS='${raw}' is not 0-3600000ms; using ${DEFAULT_GIVE_UP_BACKOFF_MS}`);
    return DEFAULT_GIVE_UP_BACKOFF_MS;
})();
// Wall clock of the last run long enough (>=300s) to count as a real broadcast.
// A crash loop that never reaches that must eventually trip the breaker.
//
// It is seeded with the PROCESS START TIME, not 0. The give-up site treats a
// falsy value as "no healthy run yet" and substitutes Infinity:
//
//     const noHealthyRunFor = lastHealthyRunAt
//         ? Date.now() - lastHealthyRunAt
//         : Infinity;
//     if (failures >= MAX_CONSECUTIVE_FFMPEG_FAILURES
//         || noHealthyRunFor > 15 * 60 * 1000) { ...give up... }
//
// With a 0 seed, `Infinity > 900000` is true, so that second arm fired on the
// VERY FIRST ffmpeg exit and the bridge gave up after a single attempt. That
// made three things unreachable: the MAX_CONSECUTIVE_FFMPEG_FAILURES = 10 retry
// budget (it could never get past 1), the `gpuFastFailures >= 2` NVDEC -> CPU
// fallback (it needs two failures), and the 400ms/2s backoff ladder the exit
// site's own comment describes. Any single ffmpeg exit -- a stall-watchdog
// kill, an OBS reconnect, a transient RTSP error -- slept the full
// GIVE_UP_BACKOFF_MS and exited 1 with the renditions dead, instead of
// restarting. Seeding with the start time measures the 15 minutes from process
// start, which is what "no healthy run for 15 minutes" is supposed to mean.
const BRIDGE_STARTED_AT = Date.now();
let lastHealthyRunAt = BRIDGE_STARTED_AT;
// How long the bridge may go WITHOUT producing a run long enough to count as a
// real broadcast before the breaker trips on its own.
const NO_HEALTHY_RUN_LIMIT_MS = 15 * 60 * 1000;

/*
 * The circuit breaker, as ONE function so it can be executed by a test.
 *
 * Two independent reasons to stop: the consecutive-failure cap, or the bridge
 * crash-cycling without ever producing a genuinely long run (which the strike
 * counter cannot see, because a 35s crash cycle keeps clearing it).
 *
 * The `lastHealthyRunAt` argument is a WALL CLOCK, never a sentinel. It used to
 * be read as `lastHealthyRunAt ? now - lastHealthyRunAt : Infinity`, so seeding
 * it with 0 made the second arm true on the very first ffmpeg exit -- the
 * bridge gave up after ONE attempt and the MAX_CONSECUTIVE_FFMPEG_FAILURES = 10
 * budget, the `gpuFastFailures >= 2` NVDEC -> CPU fallback and the whole
 * 400ms/2s backoff ladder became unreachable. A falsy timestamp now simply
 * means "no run long enough has happened yet, so that arm is simply not
 * satisfied", and the elapsed window is measured from the bridge's own start.
 */
function shouldGiveUp(failures, lastHealthyRunAtStamp, now = Date.now()) {
    const sinceHealthyRun = lastHealthyRunAtStamp ? now - lastHealthyRunAtStamp : 0;
    return failures >= MAX_CONSECUTIVE_FFMPEG_FAILURES
        || sinceHealthyRun > NO_HEALTHY_RUN_LIMIT_MS;
}
// A transcoder that has produced no rendition video this long is hung — most
// commonly an OBS WHIP AV1 source whose fragmented keyframes never reassemble
// on the RTSP leg (verified live: the pre-keyframe drop loop never syncs).
// Kill and retry; after MAX failures the bridge gives up with a clear reason.
const RENDITION_START_TIMEOUT_MS = 20000;
// A transcoder that STOPPED producing output after video already flowed
// (hung NVENC session, dead RTSP leg that never errors) freezes every viewer
// of the rendition indefinitely — MediaMTX keeps the path online because the
// publisher connection is alive. ffmpeg prints ~2 progress lines per second
// while it processes; 15s of silence is a definitive stall, not a pause.
const RENDITION_STALL_TIMEOUT_MS = 15000;
const RENDITION_WATCHDOG_POLL_MS = 3000;
const TARGET_VIDEO_CODEC = { 'live-h264': 'H264', 'live-av1': 'AV1' };

function log(message) {
    console.log(`[codec_bridge] ${message}`);
}

function logError(message) {
    console.error(`[codec_bridge] ${message}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * decideBridge(tracks, env) -> rendition plan or null.
 *
 * `tracks` is the MediaMTX paths-API track list (["Opus","H264"] style).
 * Pure function — exercised directly by the test suite. The video arguments
 * are tuned for the receiver: tune=ull removes NVENC lookahead, B-frames stay
 * off (they break WebRTC decoders), and -forced-idr makes every 1s group
 * start on an IDR frame so new viewers and PLI recovery lock on fast.
 */
/*
 * resolveFfprobeBinary() / probeGopFrames() — real frame rate of the source.
 *
 * `-g` counts FRAMES, so a hard-coded 60 only spans one second at 60 fps:
 * a 30 fps broadcast would silently get 2-second keyframes (slower join and
 * PLI recovery for every viewer). The bridge probes the live RTSP source once
 * with ffprobe and derives the GOP from the measured rate; BRIDGE_GOP
 * overrides the probe, and every failure mode keeps the 60-frame default
 * (which is correct for the verified 60 fps host setup).
 */
function resolveFfprobeBinary() {
    if (process.env.BRIDGE_FFPROBE) return process.env.BRIDGE_FFPROBE;
    if (FFMPEG !== 'ffmpeg') {
        const sibling = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
        try {
            if (fs.existsSync(sibling)) return sibling;
        } catch (err) {
            /* fall through to PATH */
        }
    }
    return 'ffprobe';
}

// Keyframe interval is the single biggest lever on how long a viewer stares at
// a frozen picture after a lost keyframe: that wait is bounded by the GOP
// (uniformly distributed, so the expected wait is half the interval). Measured
// with the bundled ffmpeg — h264_nvenc -preset p4 -tune ull -b:v 6000k
// -maxrate 6000k -bufsize 6000k, 1920x1080@60, 12s of mandelbrot (worst case
// for I-frame size):
//
//   GOP   IDRs  max IDR   100ms peak   total
//   0.5s    24   82.7 KB   11.50 Mbps   9139 KB
//   1.0s    12   69.4 KB   10.61 Mbps   9136 KB
//   2.0s     6   59.4 KB   10.07 Mbps   9150 KB
//
// TOTAL BANDWIDTH IS FLAT across that range (within 0.15%): the rate
// controller pays for the extra IDRs out of P-frame quality, not out of the
// bitrate budget. So halving the interval buys half the worst-case freeze for
// ~8% more instantaneous peak and +19% max IDR (69 KB -> 83 KB, i.e. 12 extra
// 1200-byte RTP packets) — cheap against MediaMTX's 2048-packet reader queue.
// The previous 1s default spent twice the freeze time for a peak saving the
// link never needed. A 2s GOP is strictly worse for a viewer: it doubles the
// freeze for no total-bandwidth gain.
//
// Override with BRIDGE_GOP (frames, existing) or BRIDGE_GOP_SECONDS.
const DEFAULT_GOP_SECONDS = 0.5;

function gopSeconds() {
    const raw = process.env.BRIDGE_GOP_SECONDS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_GOP_SECONDS;
    }
    const seconds = Number(String(raw).trim());
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 10) return seconds;
    logError(`BRIDGE_GOP_SECONDS='${raw}' is not a duration in 0-10s; using ${DEFAULT_GOP_SECONDS}`);
    return DEFAULT_GOP_SECONDS;
}

/*
 * The GOP to use when the source frame rate is unknown.
 *
 * `-g` counts FRAMES, so the designed keyframe interval (DEFAULT_GOP_SECONDS,
 * 0.5s) can only be honoured once the real rate is known. This is the same
 * arithmetic probeGopFrames() already uses for its own last-resort fallback,
 * pulled out so the two cannot drift apart.
 *
 * It replaces a hard-coded '60' in the encoder arg arrays. 60 frames is 1.0s
 * at 60fps, 2.5s at 24fps and 5s at 12fps — two to ten times the designed
 * interval — and it contradicted DEFAULT_GOP_SECONDS silently, in exactly the
 * case where the probe could not answer. A viewer waiting up to 2.5s for the
 * next keyframe after a loss reads that as a freeze.
 */
function assumedGopFrames() {
    return String(Math.min(300, Math.max(1, Math.round(60 * gopSeconds()))));
}

function probeGopFrames() {
    if (process.env.BRIDGE_GOP) {
        const forced = String(process.env.BRIDGE_GOP).trim();
        // BOUNDED. `'0'` is a non-empty string and used to pass the
        // /^\d+$/ test, and an unbounded number passed too. `-g 0` is accepted
        // by ffmpeg and means "every frame is an IDR": measured with the
        // bundled encoder at 1080p60, -g 0 produced 5145 KB where -g 60
        // produced 3073 KB over the same 4s — a 67% SUSTAINED bitrate overrun
        // for the entire broadcast, on a link this project's own comments
        // describe as a saturated hotspot. `-g 999999999` is the opposite
        // failure: one keyframe at the start, and after that no viewer who
        // joins or drops a packet ever gets another.
        const n = Number(forced);
        if (Number.isInteger(n) && n >= 1 && n <= 300) return String(n);
        logError(`BRIDGE_GOP='${process.env.BRIDGE_GOP}' is not a frame count in 1-300; probing instead`);
    }
    const seconds = gopSeconds();
    try {
        const probe = spawnSync(resolveFfprobeBinary(), [
            '-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0',
            '-show_entries', 'stream=avg_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            `rtsp://127.0.0.1:${RTSP_PORT}/${SOURCE_PATH}`,
        ], { encoding: 'utf8', timeout: 4000 });
        const raw = String((probe.stdout || '').split(/\r?\n/)[0] || '').trim();
        const parsed = raw.match(/^(\d+)\/(\d+)$/);
        const fps = parsed ? Number(parsed[1]) / Number(parsed[2]) : Number(raw);
        if (Number.isFinite(fps) && fps >= 12 && fps <= 240) {
            // Clamp the product too: 240fps x the 10s ceiling is a 10s GOP, i.e.
            // a ten-second freeze on every keyframe loss.
            const gop = String(Math.min(300, Math.max(1, Math.round(fps * seconds))));
            log(`source reports ${raw} fps -> GOP ${gop} frames (~${seconds}s keyframes)`);
            return gop;
        }
        // There is exactly ONE call site for this probe and the track-fetch
        // retry loop never re-enters it, so "will retry" was a lie an operator
        // would rely on. Fall back to the DESIGNED interval at this host's
        // verified 60fps instead of reverting to the hard-coded 60 frames the
        // rework exists to remove — 60 frames is 1.0s at 60fps, twice the
        // 0.5s intent.
        const fallback = String(Math.min(300, Math.max(1, Math.round(60 * seconds))));
        logError(`unexpected frame rate '${raw}' from ffprobe; using GOP ${fallback} frames `
            + `(~${seconds}s at the assumed 60fps). This is NOT retried — the next broadcast will probe again.`);
        return fallback;
    } catch (err) {
        const fallback = String(Math.min(300, Math.max(1, Math.round(60 * seconds))));
        logError(`frame-rate probe failed: ${err.message}; using GOP ${fallback} frames `
            + `(~${seconds}s at the assumed 60fps). This is NOT retried.`);
        return fallback;
    }
}

function decideBridge(tracks, env = {}) {
    if (!Array.isArray(tracks)) return null;
    const upper = tracks
        .filter((t) => typeof t === 'string')
        .map((t) => t.toUpperCase());

    const hasVideo = upper.some((t) => VIDEO_CODECS.includes(t));
    if (!hasVideo) return null;

    const hasOpusAudio = upper.includes('OPUS');
    // Every non-video track MediaMTX reports is audio ('Opus', 'MPEG-4 Audio',
    // ...). RTMP/SRT ingest arrives as AAC, which MediaMTX cannot hand to
    // WebRTC readers — the native path then plays VIDEO-ONLY.
    const hasAudio = upper.some((t) => !VIDEO_CODECS.includes(t));
    const audioArgs = hasOpusAudio
        ? ['-c:a', 'copy']
        // aresample=async=1 drops or duplicates samples to hold the output
        // timeline to the input's. Without it a source audio clock running even
        // slightly fast makes the Opus output timestamps walk progressively ahead
        // of the video, and the browser's A/V sync layer then nudges
        // playbackRate continuously to pull them together — a permanent
        // micro-correction that reads as "janky" rather than as desync. It is
        // free when there is no drift, which is the normal case.
        //
        // DO NOT add `first_pts=0` here. first_pts forces the resampler's
        // output to begin at PTS 0, which does not "clean up" a timeline — it
        // DRAGS THE AUDIO TRACK ONTO THE VIDEO TRACK'S HEAD and erases the
        // source's A/V relationship. Measured with the bundled ffmpeg on a
        // source whose audio starts 279ms after its video (an ordinary OBS
        // audio-device offset):
        //
        //     source            audio PTS  279ms   (skew +279ms)
        //     async=1:first_pts=0   ->        0ms   (skew   -7ms)  BROKEN
        //     async=1                ->      294ms   (skew +294ms)  preserved
        //
        // So it inverts the sign and injects a permanent lip-sync error of its
        // own on every rendition — which viewers report as the video being
        // "janky" when it is purely an audio offset.
        : ['-c:a', 'libopus', '-b:a', env.audioBitrate || AUDIO_BITRATE,
            // WebRTC's Opus clock is 48000Hz by definition (RFC 7587
            // "audio/opus" is always 48000/2), so anything else is resampled
            // inside the encoder. Pinning it explicitly keeps the sample rate
            // the browser's jitter buffer and AudioContext both assume, and
            // `-ac 2` matches the stereo layout WebRTC negotiates.
            '-ar', '48000', '-ac', '2',
            // `lowdelay` is the right application for a live stream: the
            // default `audio` permits the encoder lookahead that the VIDEO
            // path deliberately refuses, which is audio latency the project
            // has explicitly traded away everywhere else. A 20ms frame is the
            // WebRTC convention and bounds the jitter buffer's granularity.
            '-application', 'lowdelay', '-frame_duration', '20',
            '-af', 'aresample=async=1'];

    if (upper.includes('AV1')) {
        // Source is AV1: legacy browsers need an H264 fallback.
        const h264Rate = env.h264Bitrate || H264_BITRATE;
        // `-g` counts FRAMES, so the designed 0.5s keyframe interval can only
        // be expressed as a frame count once the source's real rate is known.
        // The production caller always passes env.gopFrames from
        // probeGopFrames(); this is the value to use when it does not.
        //
        // It used to be a hard-coded '60', which silently contradicts
        // DEFAULT_GOP_SECONDS: 60 frames is 1.0s at 60fps, 2.5s at 24fps, and
        // 5s at 12fps — two to ten times the designed interval, with nothing
        // logged, exactly in the case where the probe could not answer. The
        // probe has bounded, logged fallbacks of its own and is exported, so
        // asking it is both honest and non-blocking here.
        const gop = env.gopFrames || assumedGopFrames();
        return {
            sourceCodec: 'AV1',
            target: 'live-h264',
            videoArgs: [
                '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'ull',
                // Adaptive quantization is OFF by default in ffmpeg's NVENC
                // wrapper (verified against the bundled n8.1:
                // `-spatial_aq <boolean> ... (default false)`), so bits were
                // being spread uniformly instead of by regional complexity. A/B
                // measured on the bundled encoder, 1920x1080@60 testsrc2 at
                // 6000k, 12s, -g 30 (worst case for I-frame size):
                //
                //   total  8804KB -> 8817KB  (+0.15%, flat)
                //   avg     6.01 -> 6.02 Mbps (the -b:v target still governs)
                //   100ms peak 8.96 -> 8.64 Mbps (LOWER)
                //   max IDR  36.8 -> 39.8 KB
                //
                // So it is bitrate-neutral, and the peak it slightly reduces is
                // the figure that matters: peaks overflow MediaMTX's per-reader
                // write queue on keyframes and freeze receivers. -aq-strength 8
                // is ffmpeg's own default for the scale (1 low - 15 aggressive).
                '-spatial-aq', '1', '-aq-strength', '8',
                '-b:v', h264Rate,
                // -maxrate/-bufsize pin a 1s VBV window to the target rate:
                // bare -b:v measured 2.4x-target 100ms bursts and +8% average
                // (bundled ffmpeg, testsrc2) — bursts overflow MediaMTX's
                // per-reader write queue on keyframes and freeze receivers.
                // VBR under the cap keeps its quality allocation; peaks are
                // hard-bounded (measured 1.4x, same as strict -rc cbr).
                '-maxrate', h264Rate,
                '-bufsize', h264Rate,
                // -g counts FRAMES, so the designed 0.5s interval is a frame
                // count that depends on the source rate. `gopFrames()` derives
                // it from a probe; this fallback previously hard-coded '60',
                // which is 1.0s at 60fps and 2.5s at 24fps — double to five
                // Probed frame count. The old `env.gopFrames || '60'` fallback
                // silently contradicted DEFAULT_GOP_SECONDS — 60 frames is
                // 1.0s at 60fps and 2.5s at 24fps — with nothing logged, in
                // exactly the case where the probe could not answer.
                '-bf', '0', '-g', gop, '-forced-idr', '1',
                // ffmpeg's default -fps_mode is 'auto', which per the ffmpeg
                // docs "chooses between cfr and vfr depending on muxer
                // capabilities" — so with a constant-rate-capable muxer it
                // silently resolves to cfr, whose documented behaviour is that
                // "frames will be duplicated and dropped to achieve exactly the
                // requested constant frame rate". Either branch rewrites the
                // frame timing, which manufactures exactly the frame-count
                // discontinuity this project exists to prevent: the browser's
                // jitter buffer sees a source that does not match its own
                // advertised frame rate. 'passthrough' passes each frame with
                // its demuxer timestamp to the muxer — no duplication, no
                // dropping, no timestamp rewriting — so a VFR source stays VFR
                // end to end.
                '-fps_mode', 'passthrough',
            ],
            audioArgs,
            // AV1 viewers playing the native path of an AAC source would get
            // no sound (MediaMTX serves the AAC track to nobody over WebRTC).
            // Publish an AV1 rendition with converted audio for them too.
            extraOutputs: hasAudio && !hasOpusAudio
                ? [{
                    target: 'live-av1',
                    videoArgs: buildAv1VideoArgs(env),
                    audioArgs,
                }]
                : undefined,
        };
    }

    // Source is H264/H265/VP9: AV1-capable browsers get the low-bitrate rendition.
    const sourceCodec = upper.includes('H264') ? 'H264'
        : (upper.includes('H265') || upper.includes('HEVC')) ? 'H265'
        : upper.includes('VP9') ? 'VP9'
        : 'VP8';
    const av1Rate = env.av1Bitrate || AV1_BITRATE;
    return {
        sourceCodec,
        target: 'live-av1',
        videoArgs: buildAv1VideoArgs(env, av1Rate),
        audioArgs,
        // Audio rescue: an H264 source with non-WebRTC audio (RTMP/SRT AAC)
        // leaves every viewer of the native path without sound. One extra
        // FLV output copies the video untouched (zero extra GPU) and
        // re-encodes audio to Opus, so the player can route EVERYONE to a
        // full-quality, full-audio rendition instead of the muted native path.
        extraOutputs: sourceCodec === 'H264' && hasAudio && !hasOpusAudio
            ? [{
                target: 'live-h264',
                videoArgs: ['-c:v', 'copy'],
                audioArgs,
            }]
            : undefined,
    };
}

// Shared AV1 encoder argument block (the live-av1 rendition in both the
// primary and the audio-rescue direction).
function buildAv1VideoArgs(env = {}, av1Rate = AV1_BITRATE) {
    return [
        '-c:v', 'av1_nvenc', '-preset', 'p4', '-tune', 'ull',
        // Same AQ block and the same measurement as the H264 branch above.
        '-spatial-aq', '1', '-aq-strength', '8',
        '-b:v', av1Rate,
        // Same burst cap as the H264 branch — see the comment there.
        '-maxrate', av1Rate,
        '-bufsize', av1Rate,
        // Probed frame count, not the old hard-coded 60-frame fallback — see
        // the H264 branch for why the fallback has to stay rate-aware.
        '-bf', '0', '-g', env.gopFrames || assumedGopFrames(), '-forced-idr', '1',
        // One output frame per input frame; see the H264 branch.
        '-fps_mode', 'passthrough',
    ];
}

// Every rendition path this plan publishes (primary + audio-rescue outputs).
function planTargets(plan) {
    return [plan.target, ...(plan.extraOutputs || []).map((out) => out.target)];
}

// NVDEC decoder per source codec. RTX 40-series covers all of these; the
// availability probe below decides whether they are actually usable.
const GPU_DECODERS = {
    AV1: 'av1_cuvid',
    H264: 'h264_cuvid',
    H265: 'hevc_cuvid',
    VP9: 'vp9_cuvid',
};

/*
 * pickDecoderArgs(sourceCodec, env) -> ffmpeg INPUT options for GPU decode.
 * Pure function — exercised directly by the test suite. `env.gpuDecoders` is
 * the probed list of decoder names this ffmpeg build ships; without it (and
 * without gpuDecode=0) the GPU decoder is assumed present, matching the
 * verified host machine.
 */
function pickDecoderArgs(sourceCodec, env = {}) {
    if (env.gpuDecode === '0') return [];
    const decoder = GPU_DECODERS[sourceCodec];
    if (!decoder) return [];
    if (Array.isArray(env.gpuDecoders) && !env.gpuDecoders.includes(decoder)) return [];
    return ['-c:v', decoder];
}

// Probes once per bridge process whether this ffmpeg build actually ships the
// NVDEC decoder the plan needs (a machine without NVIDIA GPUs must fall back
// to CPU decode instead of crash-looping ffmpeg).
let ffmpegDecoderList;
function probeGpuDecoder(sourceCodec) {
    const decoder = GPU_DECODERS[sourceCodec];
    if (!decoder) return null;
    if (ffmpegDecoderList === undefined) {
        try {
            const probe = spawnSync(FFMPEG, ['-hide_banner', '-decoders'], {
                encoding: 'utf8',
                timeout: 15000,
            });
            ffmpegDecoderList = probe.status === 0 ? String(probe.stdout || '') : '';
        } catch (err) {
            logError(`ffmpeg decoder probe failed: ${err.message}`);
            ffmpegDecoderList = '';
        }
    }
    return ffmpegDecoderList.includes(decoder) ? decoder : null;
}

function buildFfmpegArgs(plan, ports = {}, decodeArgs = []) {
    const rtspPort = ports.rtspPort || RTSP_PORT;
    const rtmpPort = ports.rtmpPort || RTMP_PORT;
    const args = [
        '-hide_banner', '-loglevel', 'warning',
        // RTSP rides TCP: loopback transport can never reorder or drop packets
        // the way UDP bursts can, and TCP needs no client-side reordering
        // buffer. (-fflags nobuffer / -flags low_delay were tested live and
        // made the RTSP client fail to start or join with broken DTS more
        // often than they saved latency — the transcode adds at most one
        // frame, so the demux buffer is not where receiver lag comes from.)
        '-rtsp_transport', 'tcp',
        ...(decodeArgs.length ? decodeArgs : []),
        '-i', `rtsp://127.0.0.1:${rtspPort}/${SOURCE_PATH}`,
    ];
    // One ffmpeg invocation serves every rendition of the plan: the primary
    // transcode plus any audio-rescue outputs. ffmpeg decodes the source
    // once; each output gets its own stream options, so the rescue output
    // (`-c:v copy`) costs no GPU at all.
    const outputs = [
        { videoArgs: plan.videoArgs, audioArgs: plan.audioArgs, target: plan.target },
        ...(plan.extraOutputs || []),
    ];
    for (const out of outputs) {
        args.push(
            '-map', '0:v:0', '-map', '0:a:0?',
            ...out.videoArgs,
            ...out.audioArgs,
            // Write packets as they arrive instead of letting the FLV muxer's
            // interleaving queue hold audio back while no video frame exists
            // yet. Without this, a publisher whose first keyframe takes longer
            // than MediaMTX's 10s publisher timeout (long OBS keyframe
            // interval) gets its whole publish killed and the bridge
            // retry-loops until the GOP happens to align — with interleaving
            // off, the rendition simply starts the moment the first keyframe
            // lands.
            '-max_interleave_delta', '0',
            '-f', 'flv',
            `rtmp://127.0.0.1:${rtmpPort}/${out.target}`,
        );
    }
    return args;
}

// GPU-decode failure memory: a codec whose NVDEC decoder crash-looped is
// recorded here for 24h so later broadcasts skip straight to CPU decode
// instead of repeating two crash cycles at every cold start. A successful
// long GPU run clears the entry, so a fixed ffmpeg/driver re-enables the GPU
// path automatically.
const GPU_DECODE_STATE_FILE = path.join(os.tmpdir(), 'rydius_bridge_gpu_decode_state.json');
const GPU_DECODE_BLOCK_MS = 24 * 60 * 60 * 1000;

function readGpuDecodeState() {
    try {
        return JSON.parse(fs.readFileSync(GPU_DECODE_STATE_FILE, 'utf8'));
    } catch (err) {
        return {};
    }
}

function gpuDecodeBlocked(decoder) {
    const state = readGpuDecodeState();
    const entry = state && state[decoder];
    return Boolean(entry && Number.isFinite(entry.failedAt)
        && Date.now() - entry.failedAt < GPU_DECODE_BLOCK_MS);
}

function rememberGpuDecodeFailure(decoder) {
    if (!decoder) return;
    const state = readGpuDecodeState();
    state[decoder] = { failedAt: Date.now() };
    try {
        fs.writeFileSync(GPU_DECODE_STATE_FILE, JSON.stringify(state), 'utf8');
    } catch (err) {
        logError(`could not write GPU decode state: ${err.message}`);
    }
}

function clearGpuDecodeFailure(decoder) {
    if (!decoder) return;
    const state = readGpuDecodeState();
    if (!state[decoder]) return;
    delete state[decoder];
    try {
        fs.writeFileSync(GPU_DECODE_STATE_FILE, JSON.stringify(state), 'utf8');
    } catch (err) {
        /* state stays blocked; not worth failing the bridge over */
    }
}

async function fetchSourceTracks() {
    const response = await fetch(`${API_BASE}/v3/paths/list`, {
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`control API answered ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data && data.items) ? data.items : [];
    const source = items.find((item) => item && item.name === SOURCE_PATH);
    if (!source) return null;
    const ready = source.ready === true || source.online === true;
    if (!ready) return null;
    if (Array.isArray(source.tracks) && source.tracks.length) return source.tracks;
    if (Array.isArray(source.tracks2)) {
        return source.tracks2
            .filter((t) => t && typeof t.codec === 'string')
            .map((t) => t.codec);
    }
    return null;
}

function writePidFile(pid, targets) {
    try {
        // createdAt is stamped just after spawn(), so the real ffmpeg process is
        // always OLDER than this value. cleanup() relies on that ordering to tell
        // our ffmpeg from an unrelated process that later inherited a recycled PID.
        // ownerPid records WHICH bridge wrote the record: every bridge instance
        // shares one path, so without it instance A's exit handler can unlink
        // the record instance B just wrote, and B's ffmpeg then survives cleanup
        // with an NVDEC session, an NVENC session, an RTSP reader and an RTMP
        // publisher still held (measured at 303 MB working set) — it only dies
        // when the NEXT broadcast's ffmpeg kicks it via overridePublisher.
        fs.writeFileSync(PID_FILE, JSON.stringify({
            pid, targets, createdAt: Date.now(), exe: path.basename(FFMPEG),
            ownerPid: process.pid,
        }), 'utf8');
    } catch (err) {
        logError(`could not write PID file: ${err.message}`);
    }
}

// Only unlink a record this process actually wrote. A record with no ownerPid
// is from an older build and is left alone deliberately: it may belong to a
// bridge that is still alive, and unlinking someone else's record is the exact
// failure this guards.
function clearPidFile() {
    try {
        const raw = fs.readFileSync(PID_FILE, 'utf8');
        let record = null;
        try { record = JSON.parse(raw); } catch (err) { record = null; }
        if (record && record.ownerPid && record.ownerPid !== process.pid) {
            return;   // another live bridge owns it
        }
        fs.unlinkSync(PID_FILE);
    } catch (err) {
        /* already gone */
    }
}

// True when the target path is ready AND carries its video codec — proof that
// real video (not just audio) is flowing through the transcoder.
async function renditionHasVideo(target) {
    const response = await fetch(`${API_BASE}/v3/paths/list`, {
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    const items = Array.isArray(data && data.items) ? data.items : [];
    const targetPath = items.find((item) => item && item.name === target);
    if (!targetPath || !(targetPath.ready === true || targetPath.online === true)) return false;
    const tracks = Array.isArray(targetPath.tracks) ? targetPath.tracks : [];
    const wanted = TARGET_VIDEO_CODEC[target];
    return !wanted || tracks.some((t) => typeof t === 'string' && t.toUpperCase() === wanted);
}

// Total bytes a path has INGESTED since it was created. This is the
// mid-broadcast stall watchdog's liveness signal, and it is the right one: a
// non-advancing value means no bytes are reaching the rendition AT ALL —
// precisely the condition that freezes every viewer of it. A live process
// proves nothing here: a hung NVENC session or a dead RTSP leg that never
// errors leaves ffmpeg running with its RTMP socket open, so the path stays
// `ready` while the picture stops.
//
// It MUST be bytesReceived, not bytesSent. In MediaMTX v1.21.1 `bytesSent` is
// EGRESS — bytes delivered to READERS — so with no viewer attached it sits at
// exactly 0 forever. Using it inverted the watchdog: on a healthy source with
// zero viewers it fired every 38.2s and rebuilt the transcoder, taking both
// rendition paths not-joinable for 4.24s per cycle (11.1% of wall-clock time,
// forever), and with a single viewer attached it never fired at all. Measured
// on a scratch MediaMTX: with 0 readers bytesReceived climbed 3.5MB -> 9.0MB
// over 8s while bytesSent stayed 0; attaching one reader made bytesSent
// advance at the full source rate.
async function renditionBytesIngested(target) {
    const response = await fetch(`${API_BASE}/v3/paths/list`, {
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = Array.isArray(data && data.items) ? data.items : [];
    const targetPath = items.find((item) => item && item.name === target);
    if (!targetPath) return null;
    const bytes = Number(targetPath.bytesReceived);
    return Number.isFinite(bytes) ? bytes : null;
}

/*
 * --cleanup mode: kill a leftover ffmpeg recorded in the PID file.
 *
 * The record carries every rendition target plus the moment the child was
 * spawned. Three conditions must hold before anything is killed, because the
 * command-line target match on its own is only a loose hint: the process must
 * carry a recorded target, (when the record has one) be the recorded
 * executable, and be OLDER than createdAt — which only our ffmpeg is, since a
 * PID that got recycled onto another process is always newer. There is
 * deliberately no age gate on the record itself: it is stamped once and never
 * refreshed, so a cut-off would disable this cleanup for every broadcast longer
 * than the cut-off while the record is unlinked either way.
 */
function cleanup() {
    let record = null;
    try {
        record = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    } catch (err) {
        return; /* no record: nothing to clean */
    }
    clearPidFile();
    if (!record || !Number.isInteger(record.pid)) return;
    // No age gate here. The record is stamped once, when ffmpeg starts, and never
    // refreshed, so a "stale record" cut-off silently disabled this cleanup for
    // every broadcast longer than the cut-off — and clearPidFile() above has
    // already unlinked the record either way, so nothing is left to retry with.
    // PID reuse cannot make this act on a stranger's process: the CommandLine
    // match below only proceeds when the PID is still this bridge's ffmpeg for one
    // of the recorded rendition targets, which is what actually guards against it.
    // Backwards compatibility with pid files written before multi-output plans.
    const targets = Array.isArray(record.targets) && record.targets.length
        ? record.targets
        : (record.target ? [record.target] : []);
    for (const target of targets) {
        try {
            // PID reuse is the only way this can hit a stranger's process, and it
            // is decided by process AGE, not by how old the record is: a record
            // written 30 minutes ago may name a PID that has since belonged to
            // something else entirely, while our own ffmpeg — spawned moments
            // after createdAt was stamped — is always older than it. A recycled
            // PID is therefore always NEWER than the record, so requiring
            // CreationDate <= createdAt rejects every reused PID and keeps every
            // real one. The 2s slack absorbs clock/formatting granularity between
            // spawn() and the stamp. The CommandLine target match and the
            // executable name are kept as corroboration: the target substring is
            // deliberately loose (it also matches an ffplay or a debug command
            // that merely mentions the path), so it must never stand alone.
            const createdIso = Number.isFinite(record.createdAt)
                ? new Date(record.createdAt).toISOString()
                : null;
            const notReused = createdIso
                ? `-and $p.CreationDate -and $p.CreationDate.ToUniversalTime() -le ([DateTime]::Parse('${createdIso}').ToUniversalTime().AddSeconds(2))`
                : '';
            const rightExe = record.exe ? ` -and $p.Name -like '${record.exe}'` : '';
            const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; `
                + `if ($p -and $p.CommandLine -like '*${target}*'${rightExe}${notReused}) `
                + `{ Stop-Process -Id ${record.pid} -Force }`;
            execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore', timeout: 15000 });
            log(`cleanup: ensured ffmpeg for ${target} (pid ${record.pid}) is stopped`);
        } catch (err) {
            logError(`cleanup failed for pid ${record.pid}: ${err.message}`);
        }
    }
}

function startFfmpeg(plan, decodeArgs = []) {
    const args = buildFfmpegArgs(plan, {}, decodeArgs);
    log(`starting: ${FFMPEG} ${args.join(' ')}`);
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // stderr is only for warnings/errors now. ffmpeg emits its "frame=" stats
    // line at AV_LOG_INFO, and the bridge deliberately runs at
    // -loglevel warning, so those lines NEVER appear — an earlier version of
    // this code treated their absence as "cannot judge liveness" and the
    // entire mid-broadcast stall watchdog was dead code (verified: -loglevel
    // warning produces 0 lines matching /frame=/, info produces them). Liveness
    // is judged from the control API's per-path byte counters instead, which is
    // stronger evidence anyway: it proves bytes are actually reaching the
    // published path, not merely that a process is alive.
    child._lastProgressAt = Date.now();
    child.stderr.on('data', (chunk) => {
        for (const rawLine of String(chunk).split(/[\r\n]+/)) {
            const line = rawLine.trim();
            if (!line) continue;
            log(`ffmpeg: ${line}`);
        }
    });
    writePidFile(child.pid, planTargets(plan));
    return child;
}

/*
 * Derive the NVDEC decode configuration for a plan: usable when this ffmpeg
 * build ships the decoder and it has not been recorded as crashing recently
 * (a machine without NVIDIA GPUs must fall back to CPU decode instead of
 * crash-looping ffmpeg). Re-run whenever the plan changes so a mid-broadcast
 * codec switch gets the right decoder, not the previous one's.
 */
function resolveDecodeArgs(plan) {
    const gpuDecoder = probeGpuDecoder(plan.sourceCodec);
    const gpuUsable = Boolean(gpuDecoder) && !gpuDecodeBlocked(gpuDecoder);
    const decodeArgs = pickDecoderArgs(plan.sourceCodec, {
        gpuDecode: process.env.BRIDGE_GPU_DECODE,
        gpuDecoders: gpuUsable ? [gpuDecoder] : [],
    });
    if (!decodeArgs.length) {
        log('decoding on CPU'
            + (gpuDecoder ? ` (${gpuDecoder} blocked by a recent failure)` : ' (NVDEC unavailable)'));
    } else {
        log(`decoding on NVDEC (${decodeArgs[1]})`);
    }
    return decodeArgs;
}

async function main() {
    if (process.argv.includes('--cleanup')) {
        cleanup();
        return;
    }

    let child = null;
    const stop = () => {
        log('stopping');
        if (child) {
            try { child.kill(); } catch (err) { /* already dead */ }
        }
        clearPidFile();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    /* Wait for the source to report its tracks (the hook fires the moment the
       path is available, so this normally succeeds on the first try). */
    let plan = null;
    let gopFrames = null;
    for (let attempt = 0; attempt < 10 && !plan; attempt++) {
        try {
            const tracks = await fetchSourceTracks();
            if (tracks) {
                // Probe the real frame rate once the source is up: -g counts
                // frames, so only the measured fps makes the GOP "one second"
                // (null from a failed probe lets the next attempt retry;
                // decideBridge falls back to the 60-frame default).
                if (!gopFrames) gopFrames = probeGopFrames();
                plan = decideBridge(tracks, { gopFrames });
            }
            if (!plan) log(`waiting for a ready source with video (attempt ${attempt + 1})`);
        } catch (err) {
            log(`control API not ready (attempt ${attempt + 1}): ${err.message}`);
        }
        if (!plan) await sleep(1000);
    }
    if (!plan) {
        logError(`giving up: source '${SOURCE_PATH}' never reported a decodable track list`);
        process.exit(1);
    }

    log(`source '${SOURCE_PATH}' -> ${planTargets(plan).join(' + ')}` +
        (plan.extraOutputs && plan.extraOutputs.length
            ? ` (extra outputs: ${plan.extraOutputs.map((o) => o.target).join(', ')} — audio rescue / second codec)`
            : ''));

    // GPU (NVDEC) decode when this ffmpeg build ships the decoder and it has
    // not been recorded as crashing recently; the CPU stays free for OBS
    // capture. Two very short runs with GPU decode enabled mean the decoder
    // itself is failing (unsupported bit depth/profile/crash) — remember that
    // for later broadcasts and drop to CPU decode for the rest of this one.
    let decodeArgs = resolveDecodeArgs(plan);

    let failures = 0;
    let gpuFastFailures = 0;
    let running = true;
    while (running) {
        const startedAt = Date.now();
        const planTargetList = planTargets(plan);
        child = startFfmpeg(plan, decodeArgs);

        // Rendition watchdog, two phases:
        //   1) STARTUP — until EVERY published target proves it carries
        //      video, poll the control API; a transcoder running without
        //      video for the full start timeout is hung (the RTSP leg never
        //      delivered a decodable keyframe) and is killed so the retry
        //      loop can try again.
        //   2) MID-BROADCAST STALL — once video has flowed, the published
        //      byte counters are the liveness signal: a hung NVENC session or
        //      a dead RTSP leg that never errors keeps the path `ready` while
        //      no further bytes land, freezing every rendition viewer. Two
        //      consecutive stalled samples are required, so one slow control-API
        //      read can never disconnect a healthy broadcast.
        //
        // The signal deliberately is NOT ffmpeg's stderr. ffmpeg emits its
        // "frame=" stats line at AV_LOG_INFO and the bridge runs at
        // -loglevel warning (verified: 0 such lines at warning, present at
        // info), so a stderr-based watchdog here could never fire at all.
        let renditionEverReady = false;
        let watchdogKilled = false;
        let lastBytesSeen = null;
        let stalledSamples = 0;
        const watchdog = setInterval(async () => {
            // Pin the child this tick is judging. `child` is a main()-scope binding
            // that the retry loop reassigns, and the startup check below awaits the
            // control API (up to 3s): without this capture, a tick already inside
            // that await resumes after clearInterval() and kills the NEXT
            // iteration's freshly spawned ffmpeg, which the loop then counts as a
            // fast failure (bogus 24h NVDEC block) and, ten times over, exits for
            // good.
            const judged = child;
            if (!judged || watchdogKilled) return;
            if (!renditionEverReady) {
                if (Date.now() - startedAt < RENDITION_START_TIMEOUT_MS) return;
                try {
                    const checks = await Promise.all(planTargetList.map((t) => renditionHasVideo(t)));
                    renditionEverReady = checks.every(Boolean);
                    if (renditionEverReady) {
                        // Start the stall baseline from real counters, so the
                        // first mid-broadcast comparison is not against null.
                        try {
                            const counts = await Promise.all(planTargetList.map((t) => renditionBytesIngested(t)));
                            lastBytesSeen = counts.map((n) => (Number.isFinite(n) ? n : 0));
                        } catch (err) { /* re-baseline on the next tick */ }
                        return;
                    }
                } catch (err) {
                    return; /* API hiccup: re-check on the next tick */
                }
                watchdogKilled = true;
                logError(`rendition '${planTargetList.join('+')}' produced no video within `
                    + `${Math.round(RENDITION_START_TIMEOUT_MS / 1000)}s — restarting the transcoder`);
                try { judged.kill(); } catch (err) { /* already dead */ }
                return;
            }
            let counts;
            try {
                counts = await Promise.all(planTargetList.map((t) => renditionBytesIngested(t)));
            } catch (err) {
                return; /* API hiccup: re-check on the next tick */
            }
            if (lastBytesSeen === null) {
                lastBytesSeen = counts.map((n) => (Number.isFinite(n) ? n : 0));
                return;
            }
            // UNKNOWN is not STALLED. A path that has disappeared from the
            // control API (MediaMTX restart, a re-created path) or a counter
            // that came back non-numeric returns null, and `Number.isFinite(null)`
            // is false — so an unknown reading contributed nothing to `advanced`
            // and was scored exactly like a frozen counter. This watchdog runs on
            // a box that also runs OBS, NVENC, MediaMTX, Node and a tunnel, and
            // each API read has a 3s timeout: five consecutive timeouts during
            // a GC pause or a config reload would kill a PERFECTLY HEALTHY
            // transcoder, which drops its RTMP publish and therefore tears down
            // every WHEP session on the path — a room-wide hard stop for a
            // broadcast that never stalled. Reset and wait instead.
            if (counts.some((n) => !Number.isFinite(n))) {
                stalledSamples = 0;
                return;
            }
            // A DECREASE is activity, not a stall: MediaMTX resets a path's
            // counter when a new publisher connects to it, and the bridge's own
            // restart does exactly that. Only an UNCHANGED value is evidence of
            // a stall, so compare for inequality rather than for growth.
            const advanced = counts.some((n, i) => n !== lastBytesSeen[i]);
            lastBytesSeen = counts.map((n) => (Number.isFinite(n) ? n : 0));
            if (advanced) {
                stalledSamples = 0;
                return;
            }
            stalledSamples += 1;
            // FIVE consecutive stalled samples are required: 15000 / 3000 = 5.
            // The comment beside this used to say "two", which is 2.5x faster
            // than the arithmetic allows. Worst-case detection latency is
            // therefore 15-18s (five polls plus up to one 3s API read).
            const stallSamplesNeeded = Math.ceil(RENDITION_STALL_TIMEOUT_MS / RENDITION_WATCHDOG_POLL_MS);
            if (stalledSamples < stallSamplesNeeded) return;
            watchdogKilled = true;
            logError(`rendition '${planTargetList.join('+')}' stopped publishing bytes for `
                + `${Math.round(RENDITION_STALL_TIMEOUT_MS / 1000)}s — restarting the transcoder`);
            try { judged.kill(); } catch (err) { /* already dead */ }
        }, RENDITION_WATCHDOG_POLL_MS);

        const exit = await new Promise((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
            child.once('error', (err) => resolve({ error: err }));
        });
        clearInterval(watchdog);
        clearPidFile();
        child = null;
        if (exit.error) {
            logError(`ffmpeg failed to start: ${exit.error.message}`);
            process.exit(1);
        }
        failures += 1;
        const runSeconds = (Date.now() - startedAt) / 1000;
        const attemptNo = failures;
        log(`ffmpeg exited (code=${exit.code} signal=${exit.signal}) after ${runSeconds.toFixed(1)}s, attempt ${attemptNo}`);

        // MAX_CONSECUTIVE_FFMPEG_FAILURES means CONSECUTIVE. Without this reset
        // the counter was cumulative for the whole broadcast, so ten unrelated
        // ffmpeg exits spread over hours — one per OBS auto-reconnect, one per
        // host stall — eventually tripped the cap and the process exit(1)s.
        // The rendition is then dead for the rest of the broadcast, and every
        // viewer of it sees a hard stop. A run that lasted long enough to have
        // produced a real broadcast proves the configuration works, so it must
        // clear the strike count.
        if (runSeconds >= 30) {
            failures = 0;
        }

        // Forgiveness and health are different things. The reset above only
        // means "this run lasted long enough to prove the config works", so it
        // clears the STRIKE count. It must NOT be the same test that decides
        // whether the bridge has been making progress, because a crash cycle
        // that lands in the 30-45s band (run 35s, exit, 2s sleep, respawn)
        // resets the counter every single iteration and the give-up cap below
        // can then never fire — an unbounded loop in which every cycle drops the
        // RTMP publisher, which closes EVERY WHEP session on the path, so the
        // whole room hard-stops and rejoins roughly every 37 seconds for the
        // entire broadcast. A real, long, uninterrupted run is the only proof
        // that deserves forgiveness at the circuit-breaker level.
        if (runSeconds >= 300) {
            lastHealthyRunAt = Date.now();
        }

        // A crash within the first 10s points at the decoder configuration,
        // not the source: record it, drop to CPU after the second occurrence,
        // and retry almost immediately instead of sleeping the full 2s.
        //
        // The counter must be cleared by a healthy run. It previously was not,
        // so `gpuFastFailures` accumulated for the whole broadcast: one 5s exit,
        // then two perfectly good hours, then an unrelated 5s exit tripped the
        // threshold and switched the rest of the broadcast to SOFTWARE decode —
        // 1080p60 decoded on the CPU while OBS captured on the same 14 cores,
        // which delays every packet to EVERY viewer rather than one. The run
        // counter above already treats >=30s as proof the configuration works;
        // this one has to agree.
        if (decodeArgs.length && runSeconds < 10) {
            gpuFastFailures += 1;
            if (gpuFastFailures >= 2) {
                logError('NVDEC decode failed twice in a row — falling back to CPU decode');
                rememberGpuDecodeFailure(decodeArgs[1]);
                decodeArgs = [];
            }
        } else if (decodeArgs.length && runSeconds >= 30) {
            gpuFastFailures = 0;
            clearGpuDecodeFailure(decodeArgs[1]);
        }
        if (runSeconds < 10) {
            await sleep(400);
        } else {
            await sleep(2000);
        }

        /* If the source is gone MediaMTX is about to stop this hook — exit
           instead of restarting into a dead stream. While the source is
           here, re-read its tracks: an OBS auto-reconnect replaces the
           publisher WITHOUT taking the path offline, so the hook is not
           re-run; if the streamer switched the encoder (H.264 <-> AV1) the
           old plan would decode the new feed with the wrong codec and
           crash-loop forever. Re-decide the plan instead. */
        let fetchedTracks = null;
        try {
            fetchedTracks = await fetchSourceTracks();
        } catch (err) {
            fetchedTracks = null;
        }
        if (!fetchedTracks) {
            log('source is no longer ready; exiting');
            break;
        }
        const freshPlan = decideBridge(fetchedTracks, { gopFrames });
        if (freshPlan && (freshPlan.sourceCodec !== plan.sourceCodec
            || freshPlan.target !== plan.target
            || JSON.stringify(planTargets(freshPlan)) !== JSON.stringify(planTargets(plan)))) {
            log(`source codec changed (${plan.sourceCodec} -> ${freshPlan.sourceCodec}); `
                + `re-planning renditions: ${planTargets(freshPlan).join(' + ')}`);
            // A plan change is NOT proof the configuration works, so it must not
            // clear the consecutive-failure budget. Resetting `failures` here
            // meant a source whose track list oscillated could restart the
            // transcoder forever without ever reaching the cap that would stop
            // it — and every restart drops the RTMP publisher, which closes
            // EVERY WHEP session on that path, so all viewers hard-stop, rejoin
            // and wait for a fresh IDR.
            //
            // A genuine codec change does deserve a clean slate, because the old
            // budget was spent on a different codec. Only the source VIDEO codec
            // is treated as authoritative for that; the set of rendition targets
            // can legitimately differ for a transient reason — an RTMP source
            // whose audio track briefly disappears makes decideBridge drop the
            // audio-rescue output, and adopting that permanently would leave
            // live-h264 unpublished for the REST OF THE BROADCAST, hard-stopping
            // every audio-rescue viewer, which is the entire reason that
            // rendition exists.
            if (freshPlan.sourceCodec !== plan.sourceCodec) {
                failures = 0;
                gpuFastFailures = 0;
            }
            plan = freshPlan;
            decodeArgs = resolveDecodeArgs(plan);
        }
        // Two independent reasons to stop. Either the consecutive-failure cap
        // tripped, or the bridge has been crash-cycling without ever producing
        // a genuinely long run — which the strike counter cannot see, because a
        // 35s crash cycle keeps clearing it.
        if (shouldGiveUp(failures, lastHealthyRunAt, Date.now())) {
            const noHealthyRunFor = lastHealthyRunAt
                ? Date.now() - lastHealthyRunAt
                : Infinity;
            logError(`giving up after ${failures} failed attempts`
                + (noHealthyRunFor === Infinity ? '' : ` (no healthy run for ${Math.round(noHealthyRunFor / 1000)}s)`));
            if (plan.sourceCodec === 'AV1') {
                logError(`known limitation: an OBS WHIP AV1 source whose keyframes never reassemble on `
                    + `the RTSP leg cannot be bridged — AV1-capable viewers still play the native `
                    + `'${SOURCE_PATH}' path; broadcast H.264 via WHIP to give every browser a rendition`);
            }
            // Back OFF before exiting. This hook runs under
            // runOnAvailableRestart, so an immediate exit(1) is re-run by
            // MediaMTX essentially at once: the 10-failure crash-loop takes
            // only 4-10s (400ms sleeps), and the replacement bridge then
            // publishes to live-av1, which — because overridePublisher is on —
            // KICKS whatever was publishing there. If an earlier instance had
            // just recovered, that healthy publisher is destroyed by its own
            // retry. A long pause turns a hot crash-loop into a slow, bounded
            // one that gives a real recovery a chance to hold.
            logError(`backing off ${Math.round(GIVE_UP_BACKOFF_MS / 1000)}s before exiting`);
            await sleep(GIVE_UP_BACKOFF_MS);
            process.exit(1);
        }
    }

    clearPidFile();
    process.exit(0);
}

module.exports = { decideBridge, buildFfmpegArgs, pickDecoderArgs, probeGopFrames, planTargets, shouldGiveUp, MAX_CONSECUTIVE_FFMPEG_FAILURES, NO_HEALTHY_RUN_LIMIT_MS, VIDEO_CODECS };

if (require.main === module) {
    main().catch((err) => {
        logError(`fatal: ${err && err.stack ? err.stack : err}`);
        clearPidFile();
        process.exit(1);
    });
}
