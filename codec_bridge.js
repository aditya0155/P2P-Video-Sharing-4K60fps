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

const PID_FILE = path.join(os.tmpdir(), 'rydius_codec_bridge.pid');
const VIDEO_CODECS = ['AV1', 'H264', 'H265', 'HEVC', 'VP8', 'VP9'];
const MAX_CONSECUTIVE_FFMPEG_FAILURES = 10;
// A transcoder that has produced no rendition video this long is hung — most
// commonly an OBS WHIP AV1 source whose fragmented keyframes never reassemble
// on the RTSP leg (verified live: the pre-keyframe drop loop never syncs).
// Kill and retry; after MAX failures the bridge gives up with a clear reason.
const RENDITION_START_TIMEOUT_MS = 20000;
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

function probeGopFrames() {
    if (process.env.BRIDGE_GOP) {
        const forced = String(process.env.BRIDGE_GOP).trim();
        if (/^\d+$/.test(forced)) return forced;
        logError(`BRIDGE_GOP='${process.env.BRIDGE_GOP}' is not a frame count; probing instead`);
    }
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
            const gop = String(Math.round(fps));
            log(`source reports ${raw} fps -> GOP ${gop} frames (~1s keyframes)`);
            return gop;
        }
        logError(`unexpected frame rate '${raw}' from ffprobe; will retry or keep 60`);
    } catch (err) {
        logError(`frame-rate probe failed: ${err.message}; will retry or keep 60`);
    }
    return null;
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
        : ['-c:a', 'libopus', '-b:a', env.audioBitrate || AUDIO_BITRATE];

    if (upper.includes('AV1')) {
        // Source is AV1: legacy browsers need an H264 fallback.
        const h264Rate = env.h264Bitrate || H264_BITRATE;
        return {
            sourceCodec: 'AV1',
            target: 'live-h264',
            videoArgs: [
                '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'ull',
                '-b:v', h264Rate,
                // -maxrate/-bufsize pin a 1s VBV window to the target rate:
                // bare -b:v measured 2.4x-target 100ms bursts and +8% average
                // (bundled ffmpeg, testsrc2) — bursts overflow MediaMTX's
                // per-reader write queue on keyframes and freeze receivers.
                // VBR under the cap keeps its quality allocation; peaks are
                // hard-bounded (measured 1.4x, same as strict -rc cbr).
                '-maxrate', h264Rate,
                '-bufsize', h264Rate,
                '-bf', '0', '-g', env.gopFrames || '60', '-forced-idr', '1',
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
        '-b:v', av1Rate,
        // Same burst cap as the H264 branch — see the comment there.
        '-maxrate', av1Rate,
        '-bufsize', av1Rate,
        '-bf', '0', '-g', env.gopFrames || '60', '-forced-idr', '1',
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
        fs.writeFileSync(PID_FILE, JSON.stringify({ pid, targets, createdAt: Date.now() }), 'utf8');
    } catch (err) {
        logError(`could not write PID file: ${err.message}`);
    }
}

function clearPidFile() {
    try {
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

/*
 * --cleanup mode: kill a leftover ffmpeg recorded in the PID file.
 * The CommandLine check guards against PID reuse by an unrelated process;
 * the record carries every rendition target, and a command line matching
 * any of them proves the PID really is this bridge's ffmpeg.
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
    /* Stale records (older than 10 minutes) are never trusted. */
    if (Date.now() - (record.createdAt || 0) > 10 * 60 * 1000) return;
    // Backwards compatibility with pid files written before multi-output plans.
    const targets = Array.isArray(record.targets) && record.targets.length
        ? record.targets
        : (record.target ? [record.target] : []);
    for (const target of targets) {
        try {
            const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; ` +
                `if ($p -and $p.CommandLine -like '*${target}*') { Stop-Process -Id ${record.pid} -Force }`;
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
    child.stderr.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (line) log(`ffmpeg: ${line}`);
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

        // Rendition watchdog: until EVERY published target proves it carries
        // video, poll the control API; a transcoder running without video for
        // the full start timeout is hung (the RTSP leg never delivered a
        // decodable keyframe) and is killed so the retry loop can try again.
        // Once video has flowed, this instance is healthy and never checked
        // again.
        let renditionEverReady = false;
        let watchdogKilled = false;
        const watchdog = setInterval(async () => {
            if (!child || renditionEverReady || watchdogKilled) return;
            if (Date.now() - startedAt < RENDITION_START_TIMEOUT_MS) return;
            try {
                const checks = await Promise.all(planTargetList.map((t) => renditionHasVideo(t)));
                renditionEverReady = checks.every(Boolean);
                if (renditionEverReady) return;
            } catch (err) {
                return; /* API hiccup: re-check on the next tick */
            }
            watchdogKilled = true;
            logError(`rendition '${planTargetList.join('+')}' produced no video within `
                + `${Math.round(RENDITION_START_TIMEOUT_MS / 1000)}s — restarting the transcoder`);
            try { child.kill(); } catch (err) { /* already dead */ }
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
        log(`ffmpeg exited (code=${exit.code} signal=${exit.signal}) after ${runSeconds.toFixed(1)}s, attempt ${failures}`);

        // A crash within the first 10s points at the decoder configuration,
        // not the source: record it, drop to CPU after the second occurrence,
        // and retry almost immediately instead of sleeping the full 2s.
        if (decodeArgs.length && runSeconds < 10) {
            gpuFastFailures += 1;
            if (gpuFastFailures >= 2) {
                logError('NVDEC decode failed twice in a row — falling back to CPU decode');
                rememberGpuDecodeFailure(decodeArgs[1]);
                decodeArgs = [];
            }
        } else if (decodeArgs.length && runSeconds >= 30) {
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
            plan = freshPlan;
            decodeArgs = resolveDecodeArgs(plan);
            gpuFastFailures = 0;
            failures = 0;
        }
        if (failures >= MAX_CONSECUTIVE_FFMPEG_FAILURES) {
            logError(`giving up after ${failures} failed attempts`);
            if (plan.sourceCodec === 'AV1') {
                logError(`known limitation: an OBS WHIP AV1 source whose keyframes never reassemble on `
                    + `the RTSP leg cannot be bridged — AV1-capable viewers still play the native `
                    + `'${SOURCE_PATH}' path; broadcast H.264 via WHIP to give every browser a rendition`);
            }
            process.exit(1);
        }
    }

    clearPidFile();
    process.exit(0);
}

module.exports = { decideBridge, buildFfmpegArgs, pickDecoderArgs, probeGopFrames, planTargets, VIDEO_CODECS };

if (require.main === module) {
    main().catch((err) => {
        logError(`fatal: ${err && err.stack ? err.stack : err}`);
        clearPidFile();
        process.exit(1);
    });
}
