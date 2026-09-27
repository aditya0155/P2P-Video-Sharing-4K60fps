/* ==========================================================================
   Rydius Stream — WebRTC WHEP player and interface
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // Configuration
    const WHEP_PATH = '/stream-api/live/whep';
    const POLL_INTERVAL_MS = 5000;
    
    // DOM Elements - Core Player
    const player = document.getElementById('stream-player');
    const videoContainer = document.getElementById('video-container');
    const appContainer = document.getElementById('app-container');
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    const liveLabel = document.getElementById('live-label');
    const streamQuality = document.getElementById('stream-quality');
    const streamRtt = document.getElementById('stream-rtt');
    const streamCodec = document.querySelector('.stream-codec');
    
    // Overlays & Gestures
    const unmuteOverlay = document.getElementById('unmute-overlay');
    const unmuteBtn = document.getElementById('unmute-overlay-btn');
    const playerLoader = document.getElementById('player-loader');
    const offlineOverlay = document.getElementById('offline-overlay');
    const actionFeedback = document.getElementById('action-feedback');
    const volumeToast = document.getElementById('volume-toast');
    const volumeToastText = document.getElementById('volume-toast-text');
    
    // Controls
    const playerControls = document.getElementById('player-controls');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const muteBtn = document.getElementById('mute-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeValueBadge = document.getElementById('volume-value-badge');
    const latencyModeBtn = document.getElementById('latency-mode-btn');
    const pipBtn = document.getElementById('pip-btn');
    const theatreBtn = document.getElementById('theatre-btn');
    const statsBtn = document.getElementById('stats-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const perfToggleBtn = document.getElementById('perf-toggle-btn');
    const perfToggleLabel = document.getElementById('perf-toggle-label');
    
    // Telemetry HUD
    const telemetryHud = document.getElementById('telemetry-hud');
    const hudCloseBtn = document.getElementById('hud-close-btn');
    const hudLatency = document.getElementById('hud-latency');
    const hudIce = document.getElementById('hud-ice');
    const hudPacketsLost = document.getElementById('hud-packets-lost');
    const hudCodec = document.getElementById('hud-codec');
    const hudResolution = document.getElementById('hud-resolution');
    const hudFrames = document.getElementById('hud-frames');
    const hudVideoState = document.getElementById('hud-video-state');
    const hudBitrateCanvas = document.getElementById('hud-bitrate-canvas');
    const hudAudioLevel = document.getElementById('hud-audio-level');
    const hudCopyReportBtn = document.getElementById('hud-copy-report-btn');
    const hudJitter = document.getElementById('hud-jitter');
    const hudBuffer = document.getElementById('hud-buffer');
    const hudRoute = document.getElementById('hud-route');
    const viewerNum = document.getElementById('viewer-num');

    // Sidebar & Chat
    const tabChat = document.getElementById('tab-chat');
    const tabInfo = document.getElementById('tab-info');
    const contentChat = document.getElementById('content-chat');
    const contentInfo = document.getElementById('content-info');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const soundToggleBtn = document.getElementById('sound-toggle-btn');
    const streamUrl = document.getElementById('stream-url');
    const chatNickBtn = document.getElementById('chat-nick-btn');
    const chatNickDisplay = document.getElementById('chat-nick-display');
    const activityEmpty = document.getElementById('activity-empty');

    // Ingest Protocol Tabs
    const ingestTabWhip = document.getElementById('ingest-tab-whip');
    const ingestTabSrt = document.getElementById('ingest-tab-srt');
    const instructionsWhip = document.getElementById('instructions-whip');
    const instructionsSrt = document.getElementById('instructions-srt');
    const whipServerUrl = document.getElementById('whip-server-url');
    const srtServerUrl = document.getElementById('srt-server-url');

    if (streamUrl) {
        streamUrl.textContent = new URL('/streaming/', window.location.origin).href;
    }

    // Video Element Events & Play/Pause Button State Synchronization
    player.addEventListener('play', () => {
        console.log("[VideoEvent] play triggered. state: paused =", player.paused, "readyState =", player.readyState);
        if (playPauseBtn) {
            playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            playPauseBtn.setAttribute('aria-label', 'Pause');
        }
    });
    player.addEventListener('playing', () => {
        console.log("[VideoEvent] playing triggered (video is rendering!). resolution =", player.videoWidth, "x", player.videoHeight);
        if (playPauseBtn) {
            playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            playPauseBtn.setAttribute('aria-label', 'Pause');
        }
    });
    player.addEventListener('pause', () => {
        console.log("[VideoEvent] pause triggered");
        if (playPauseBtn) {
            playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
            playPauseBtn.setAttribute('aria-label', 'Play');
        }
    });
    player.addEventListener('waiting', () => console.log("[VideoEvent] waiting triggered (buffering)"));
    player.addEventListener('loadedmetadata', () => console.log("[VideoEvent] loadedmetadata triggered. Resolution:", player.videoWidth, "x", player.videoHeight, "readyState =", player.readyState));
    player.addEventListener('loadeddata', () => console.log("[VideoEvent] loadeddata triggered"));
    player.addEventListener('suspend', () => console.log("[VideoEvent] suspend triggered"));
    player.addEventListener('stalled', () => console.warn("[VideoEvent] stalled triggered (no media data)"));
    player.addEventListener('error', (e) => console.error("[VideoEvent] error triggered:", player.error ? `${player.error.code} - ${player.error.message}` : e));

    // Global State Variables
    let peerConnection = null;
    let whepSessionUrl = null;           // Location header URL for WHEP DELETE teardown
    let whepAbortController = null;      // Cancels an in-flight WHEP POST when the session is torn down
    let whepPostTimeout = null;          // Aborts a hung WHEP POST quickly instead of waiting for the 16s watchdog
    let activeStreamPath = 'live';       // Path chosen for this session: live, live-av1 or live-h264
    let isConnected = false;
    let isConnecting = false;
    let connectionStartTime = 0;
    let connectTimeout = null;           // 12s connection watchdog timer
    let statsInterval = null;
    let streamActiveCheckTimeout = null;
    let lastBytesReceived = 0;
    let lastFramesDecodedCount = 0;
    let lastFramesReceived = 0;         // framesReceived baseline (decode-pressure detection)
    let decodeLagSec = 0;               // Consecutive seconds decoded lags received (decode pressure)
    let lastStatsTime = 0;
    let controlsHideTimeout = null;
    // Last pointer position that counted as real activity. A resting hand
    // drifts and twitches without the user meaning to move the mouse; 25px of
    // travel from the anchor is required before the fade re-arms, which a
    // tremor never reaches but any deliberate gesture crosses instantly.
    let controlsAnchorX = null;
    let controlsAnchorY = null;
    const POINTER_ACTIVATE_PX = 25;
    let soundEnabled = true;
    let currentBitrateMbps = null;
    let currentFrameRate = null;

    // Latency & Jitter Buffer Modes: 'ultra' (80ms), 'balanced' (180ms), 'smooth' (350ms).
    // 'balanced' is the default: enough cushion for hotspot jitter while keeping a
    // fresh viewer 170ms closer to the live edge than 'smooth' would. The adaptive
    // supervisor still raises the target automatically whenever the network turns
    // rough (jitter floor up to 600ms), so smoothness is not traded away — only
    // the starting point moves closer to live. The drift limits sit ~1s above
    // each mode: Chrome's buffer grows past the fixed target on bursty hotspot
    // arrivals (measured live: 180ms target drifting to 1.2s), and the stepwise
    // catch-up drains it back at 150ms/s — smooth enough to run often.
    let currentLatencyMode = 'balanced';
    const LATENCY_MODES = {
        ultra: { label: 'Ultra-Low (80ms)', ms: 80, s: 0.08, icon: 'fa-bolt', driftLimitMs: 900 },
        balanced: { label: 'Balanced (180ms)', ms: 180, s: 0.18, icon: 'fa-gauge-high', driftLimitMs: 1000 },
        smooth: { label: 'Anti-Stutter (350ms)', ms: 350, s: 0.35, icon: 'fa-shield-halved', driftLimitMs: 1100 }
    };
    // A manual latency choice sticks across visits; unknown values fall back to the default.
    try {
        const savedLatencyMode = localStorage.getItem('rydius_latency_mode');
        if (savedLatencyMode && LATENCY_MODES[savedLatencyMode]) currentLatencyMode = savedLatencyMode;
    } catch (e) { /* storage unavailable: the default applies */ }

    // === Adaptive Buffer Supervision (anti-stutter + anti-delay drift) ===
    // The LATENCY_MODES table above is what the user SELECTED; the state below
    // tracks what the network actually NEEDS right now and how far playout has
    // drifted from the live edge. superviseAdaptiveBuffer() runs every stats tick.
    let lastPacketsReceived = 0;        // RX baseline for interval loss calculation
    let lastPacketsLost = 0;            // Lost baseline for interval loss calculation
    let lastFramesDropped = 0;          // Baseline for frame-drop pressure detection
    let dropWindow = [];                // rolling per-tick frame-drop counts (last 3 stats ticks)
    let dropTickPending = true;         // first tick after beginStatsLoop only re-baselines
    let stressRunSec = 0;               // Consecutive seconds of jitter/loss stress
    let calmRunSec = 0;                 // Consecutive calm seconds (restores mode target)
    let rejoinDriftSec = 0;             // Consecutive seconds past the reconnection drift cap
    let adaptiveRaiseUntil = 0;         // >now: hold a 350ms floor (rough network)
    let lastNetJitterMs = null;         // Smoothed inbound network jitter (ms)
    let lastLossPct = null;             // Packet loss over the last stats interval (%)
    let avgPlayoutDelayMs = null;       // Windowed jitter-buffer delay (ms, where reported)
    let lastJitterDelayTotal = 0;       // Cumulative jitterBufferDelay baseline (seconds)
    let lastJitterEmittedTotal = 0;     // Cumulative jitterBufferEmittedCount baseline
    let lastAppliedTargetMs = null;     // Last target pushed to receivers (change detection)
    let bufferNoticeState = '';         // 'raised' | '' (system-message dedupe)
    let renditionWaitPolls = 0;         // Consecutive polls waiting for a compatible rendition
    let renditionWaitWarned = false;    // AV1-only viewer notice dedupe per broadcast
    let accommodationTargetMs = 0;      // Buffer target raised to meet the measured delay
    let accommodationCalmTicks = 0;     // Consecutive drop-free stats ticks (gates the decay)
    let jitterFloorEmaMs = 0;           // Network-jitter-proportional playout floor (see jitterBufferFloorMs)
    let abrBadSec = 0;                  // Consecutive seconds of measured network stress (rendition switching)
    let abrCalmSec = 0;                 // Consecutive calm seconds (rendition upgrade)
    let lastRenditionSwitchAt = -60000; // ABR switch cooldown anchor (performance.now ms)
    let renditionPathsItems = null;     // Latest /v3/paths/list snapshot while connected (ABR ladder)
    let renditionPollInterval = null;   // Slow paths poll that keeps the ladder fresh while connected
    let lastPresentedFrames = 0;        // rVFC metadata.presentedFrames accumulator (real render count)
    let lastPresentedFps = null;        // Presented-frames delta over the last stats tick
    let lastRouteText = '--';           // Selected ICE route: direct / relay (TURN)
    let lastRecoveryCounts = null;      // { pli, nack } session totals for diagnostics

    // Bitrate History for Canvas Sparkline (Rolling 60 seconds)
    const bitrateHistory = new Array(60).fill(0);

    // Web Audio Context Subsystem (Volume Booster + Real-time Spectrum + SFX)
    let audioCtx = null;
    let gainNode = null;
    let analyserNode = null;
    let audioSourceNode = null;
    let audioMeterAnimId = null;

    // === Precision Freeze Watchdog State ===
    let lastFrameTime = 0;               // Timestamp of last video frame via rVFC
    let freezeWatchdogId = null;          // requestVideoFrameCallback handle
    let freezeCheckInterval = null;       // Interval timer for the watchdog poller
    let lastDecodedFrames = 0;            // Last framesDecoded value from getStats()
    let lastBytesCount = 0;              // Last bytesReceived value from getStats()
    let frozenSince = 0;                  // When freeze was first detected (0 = not frozen)
    let isRecovering = false;             // Guard to prevent recovery storms
    let recoveryCount = 0;                // How many auto-recoveries we've done this session
    let healthyPlaybackSeconds = 0;      // Consecutive healthy playback seconds (resets recovery counter)
    const FREEZE_THRESHOLD_MS = 3000;     // 3.0s without frame progression when network packets are flowing
    const MAX_RECOVERIES = 10;            // Allow up to 10 recoveries (with decay back to 0)
    let stallTimeout = null;
    let disconnectGraceTimer = null;      // Grace window before treating an ICE 'disconnected' blip as a real drop
    let reconnectAttempts = 0;            // Fast-reconnect backoff exponent (1s → 2s → 4s → 5s cap)
    let muteConfirmTimeout = null;        // Debounce window to confirm a muted track is really dead

    /* ==========================================================================
       Web Audio API System (Gain Booster, Meter & Synth SFX)
       ========================================================================== */

    function initAudioContext() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().then(() => {
                    console.log("[Audio] Suspended AudioContext resumed on user gesture.");
                }).catch(e => console.warn("[Audio] AudioContext resume error:", e));
            }
            return;
        }
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            // 'interactive' keeps the WebAudio processing quantum small for minimal A/V path latency
            audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            gainNode = audioCtx.createGain();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 64;

            gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
            gainNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
            console.log("[Audio] Web Audio context initialized successfully.");
        } catch (e) {
            console.warn("[Audio] Could not initialize Web Audio context:", e);
        }
    }

    function connectPlayerToAudioNodes() {
        if (!audioCtx) return;
        if (audioSourceNode) {
            startAudioMeter();
            return;
        }
        try {
            audioSourceNode = audioCtx.createMediaElementSource(player);
            audioSourceNode.connect(gainNode);
            // From this moment the GainNode owns the volume multiplier (see
            // setMasterGain): sync it to whatever the user had set while the
            // graph was not yet wired, and release the element volume.
            gainNode.gain.setValueAtTime(lastVolumeMultiplier, audioCtx.currentTime);
            player.volume = 1.0;
            console.log("[Audio] Connected player element to GainNode & AnalyserNode.");
            startAudioMeter();
        } catch (e) {
            console.warn("[Audio] Note on MediaElementSource:", e);
        }
    }

    // Master volume. The WebAudio graph taps the element AFTER its volume
    // property, so driving both controls attenuates twice (slider 50% played
    // at 25%). The multiplier therefore rides exactly one control: the GainNode
    // once the graph is wired, the element volume alone before that. The last
    // multiplier is remembered so the transition between the two paths is
    // seamless whenever connectPlayerToAudioNodes() wires the graph.
    let lastVolumeMultiplier = 1.0;
    function setMasterGain(volumeMultiplier) {
        const clamped = Math.min(1.0, Math.max(0, volumeMultiplier));
        lastVolumeMultiplier = clamped;
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        if (gainNode && audioCtx && audioCtx.state !== 'closed' && audioSourceNode) {
            try {
                const now = audioCtx.currentTime;
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(clamped, now);
                // Element volume must stay at 1 while the graph carries the
                // multiplier, or the two multiply together (50% → 25%).
                player.volume = 1.0;
            } catch (e) {
                // Ignore schedule errors
            }
        } else {
            player.volume = clamped;
        }
    }

    function startAudioMeter() {
        if (!analyserNode || !hudAudioLevel || !telemetryHud || telemetryHud.style.display !== 'block') return;
        if (audioMeterAnimId) cancelAnimationFrame(audioMeterAnimId);
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

        const updateMeter = () => {
            if (!telemetryHud || telemetryHud.style.display !== 'block') {
                stopAudioMeter();
                return;
            }
            if (!isConnected || player.paused || player.muted) {
                hudAudioLevel.style.width = '0%';
                audioMeterAnimId = requestAnimationFrame(updateMeter);
                return;
            }

            analyserNode.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            const percentage = Math.min(100, Math.round((average / 180) * 100));
            hudAudioLevel.style.width = `${percentage}%`;
            audioMeterAnimId = requestAnimationFrame(updateMeter);
        };
        audioMeterAnimId = requestAnimationFrame(updateMeter);
    }

    function stopAudioMeter() {
        if (audioMeterAnimId) {
            cancelAnimationFrame(audioMeterAnimId);
            audioMeterAnimId = null;
        }
        if (hudAudioLevel) hudAudioLevel.style.width = '0%';
    }

    // Synthesize gentle sci-fi click & pop sound effects on the fly
    function playSfx(type = 'pop') {
        if (!soundEnabled || !audioCtx) return;
        try {
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const osc = audioCtx.createOscillator();
            const sfxGain = audioCtx.createGain();
            osc.connect(sfxGain);
            sfxGain.connect(audioCtx.destination);

            const now = audioCtx.currentTime;
            if (type === 'pop') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(420, now);
                osc.frequency.exponentialRampToValueAtTime(840, now + 0.06);
                sfxGain.gain.setValueAtTime(0.08, now);
                sfxGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
                osc.start(now);
                osc.stop(now + 0.06);
            } else if (type === 'chime') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
                sfxGain.gain.setValueAtTime(0.06, now);
                sfxGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
                osc.start(now);
                osc.stop(now + 0.22);
            }
        } catch (e) {
            // Audio context locked or not permitted
        }
    }

    /* ==========================================================================
       SDP Tuning & Hardware Codec Preference
       ========================================================================== */

    // Advertise a 60 Mbps video ceiling and request common RTP feedback modes.
    function optimizeSdp(sdp) {
        let modified = sdp;

        // Strip any existing bandwidth limitations to avoid duplicates
        modified = modified.replace(/b=AS:[^\r\n]*[\r\n]+/g, '');
        modified = modified.replace(/b=TIAS:[^\r\n]*[\r\n]+/g, '');

        // 1. Add 60 Mbps Application-Specific bandwidth right after the m=video line (valid media-level position).
        //    The value 60000 is pinned by js_checks (sdp-bandwidth-ceiling) — raise both together if >60 Mbps ever matters.
        if (modified.includes('m=video')) {
            modified = modified.replace(/(m=video[^\r\n]*[\r\n]+)/, '$1b=AS:60000\r\n');
        }

        // 2. Ensure NACK retransmission, Google REMB and Transport-CC feedback exist for every
        //    VIDEO payload type — H264, AV1, VP8/VP9 and H265 all ride the 90000Hz clock, which
        //    audio codecs never use. Without NACK/PLI on the AV1 m-line a lost packet can never
        //    be retransmitted and a broken frame can never request a fresh keyframe, so the
        //    decoder discards until the next IDR — that reads as receiver frame drops. Lines are
        //    inserted directly after the rtpmap entry INSIDE the m=video section — appending them
        //    at the end of the SDP would attach them to the m=audio section, which is invalid and
        //    silently ignored by the answerer.
        const desiredFeedback = ['nack', 'nack pli', 'goog-remb', 'transport-cc'];
        const presentFeedback = new Set();
        const lines = modified.split('\r\n');
        lines.forEach(line => {
            const match = line.match(/^a=rtcp-fb:(\d+)\s+(.+)$/);
            if (match) presentFeedback.add(`${match[1]} ${match[2].trim()}`);
        });

        const rebuilt = [];
        let inVideoSection = false;
        // rtcp-fb is only valid on true media formats: red/ulpfec/rtx/flexfec
        // ride the same 90000Hz clock but must not receive feedback lines.
        const rtpmapRegex = /^a=rtpmap:(\d+)\s+(?!red\/|ulpfec\/|rtx\/|flexfec-03\/)\S+\/90000(?:\s|$)/i;
        for (const line of lines) {
            rebuilt.push(line);
            if (/^m=/.test(line)) {
                inVideoSection = /^m=video/.test(line);
                continue;
            }
            const match = line.match(rtpmapRegex);
            if (match && inVideoSection) {
                desiredFeedback.forEach(fb => {
                    if (!presentFeedback.has(`${match[1]} ${fb}`)) {
                        rebuilt.push(`a=rtcp-fb:${match[1]} ${fb}`);
                    }
                });
            }
        }
        return rebuilt.join('\r\n');
    }

    // Configure hardware codec preference if supported by browser
    function configureCodecPreferences(transceiver) {
        if (!('setCodecPreferences' in transceiver) || !('RTCRtpReceiver' in window) || !('getCapabilities' in RTCRtpReceiver)) {
            return;
        }
        try {
            const capabilities = RTCRtpReceiver.getCapabilities('video');
            if (!capabilities || !capabilities.codecs) return;

            // Prioritize H.264 High Profile (NVENC hardware decode), then HEVC, then AV1
            const prioritizedCodecs = capabilities.codecs.slice().sort((a, b) => {
                const getScore = (c) => {
                    const mime = c.mimeType.toLowerCase();
                    if (mime.includes('h264')) return 100;
                    if (mime.includes('h265') || mime.includes('hevc')) return 90;
                    if (mime.includes('av01') || mime.includes('av1')) return 80;
                    if (mime.includes('vp9')) return 70;
                    return 50;
                };
                return getScore(b) - getScore(a);
            });

            transceiver.setCodecPreferences(prioritizedCodecs);
            console.log("[WebRTC] Codec preferences set prioritizing hardware acceleration.");
        } catch (err) {
            console.warn("[WebRTC] Could not set codec preferences:", err);
        }
    }

    // Per-tick playout delay derived from cumulative getStats counters (pure —
    // unit-tested in js_checks.js). Chrome reports jitterBufferDelay and
    // jitterBufferEmittedCount as session-long cumulative totals, so dividing
    // one by the other yields an all-session average: after ten minutes of
    // steady playback a fresh multi-second slip behind the live edge moves
    // that average by almost nothing and the catch-up trigger never fires.
    // Deltas between ticks measure exactly the window that matters.
    function windowedPlayoutDelayMs(delayTotal, emittedTotal, prevDelayTotal, prevEmittedTotal) {
        const emittedDelta = emittedTotal - prevEmittedTotal;
        if (prevEmittedTotal <= 0 || emittedDelta <= 0 || delayTotal < prevDelayTotal) return null;
        return ((delayTotal - prevDelayTotal) / emittedDelta) * 1000;
    }

    // Network-jitter-proportional playout floor (pure — unit-tested). A fixed
    // 180ms target on a jitterful hotspot link makes every frame that arrives
    // ~200ms late get discarded by the jitter buffer — that IS the "frame
    // drops" a viewer sees. Latency was explicitly traded away in this
    // project, so the target grows with measured jitter (2.5x + 75ms of
    // headroom, capped at 600ms, 25ms steps to avoid churn) and decays one
    // step per second once the network calms down. Jitter at or below 20ms
    // needs no floor: the mode target and the browser's own buffering absorb
    // it, and Ultra mode stays meaningful on clean links.
    function jitterBufferFloorMs(jitterMs, prevFloorMs = 0) {
        const candidate = (jitterMs === null || !Number.isFinite(jitterMs) || jitterMs <= 20)
            ? 0
            : Math.min(600, Math.round((jitterMs * 2.5 + 75) / 25) * 25);
        if (candidate >= prevFloorMs) return candidate;
        return Math.max(candidate, prevFloorMs - 25);
    }

    // Buffer accommodation (pure — unit-tested). RAISE only on hard evidence
    // that the granted target is too small — Chrome discarded late frames
    // (dropsNow) AND its measured buffer outgrew the base target by a clear
    // margin — and grant what it needs (+100ms headroom, capped at 2200ms,
    // 50ms steps). HOLD whenever Chrome sits at the granted target: the
    // measured delay always tracks the hint, so raising to meet the
    // measurement would chase its own tail and inflate EVERY session to the
    // cap within half a minute (the bug this gate fixes — verified live: a
    // 180ms target with Chrome's buffer equilibrated at ~1.2s produced 31%
    // dropped frames, but that needs a RAISE only while frames are actually
    // being discarded). DECAY one 50ms step per tick only after sustained
    // drop-free seconds (calmTicks), draining the extra latency smoothly; a
    // fresh drop burst re-raises at once. A measuring/null delay holds.
    // This is the core of "latency is fine, drops are not": never fight the
    // buffer Chrome wants — accommodate it, and reconnect only past the cap.
    function bufferAccommodationMs(delayMs, prevMs, baseTargetMs, dropsNow, calmTicks) {
        if (delayMs === null || !Number.isFinite(delayMs) || delayMs < 0) return prevMs;
        if (dropsNow && delayMs > baseTargetMs + 150) {
            return Math.min(2200, Math.round((delayMs + 100) / 50) * 50);
        }
        if (!dropsNow && calmTicks >= 5 && prevMs > 0) {
            return Math.max(0, prevMs - 50);
        }
        return prevMs;
    }

    // Decode-pressure state machine (pure — unit-tested). Each stats tick
    // compares decoded frames against received frames: a decoder falling
    // below 70% of the arrival rate accumulates lag seconds, a decoder above
    // 90% sheds one, and a low-rate window (under 15 frames) is unmeasurable
    // and decays — static screens and paused publishers must not look like
    // decode pressure.
    function updateDecodeLag(lagSec, decodedDelta, receivedDelta) {
        if (receivedDelta < 15) return Math.max(0, lagSec - 1);
        if (decodedDelta < 0) return Math.min(30, lagSec + 1);
        const ratio = decodedDelta / receivedDelta;
        if (ratio < 0.7) return Math.min(30, lagSec + 1);
        if (ratio >= 0.9) return Math.max(0, lagSec - 1);
        return lagSec;
    }

    function decayDecodeLag(lagSec) {
        return Math.max(0, lagSec - 1);
    }

    // Base playout/jitter-buffer target before accommodation: what the user
    // selected plus what the measured network needs right now.
    function baseBufferTargetMs() {
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        let target = config.ms;
        if (performance.now() < adaptiveRaiseUntil) target = Math.max(target, 350);
        // The jitter floor sits above the mode and the stress raise: measured
        // network jitter is the ground truth for how late frames arrive, and
        // a target below it turns late frames into visible drops.
        target = Math.max(target, jitterFloorEmaMs);
        return target;
    }

    // Effective playout/jitter-buffer target for right now. Accommodation
    // (drop-gated, see bufferAccommodationMs) sits on top of the base.
    function currentBufferTargetMs() {
        return Math.max(baseBufferTargetMs(), accommodationTargetMs);
    }

    // Apply the effective playout delay target to one receiver.
    function applyPlayoutDelay(receiver, kind) {
        if (!receiver) return;
        const targetMs = currentBufferTargetMs();
        try {
            if ('jitterBufferTarget' in receiver) {
                receiver.jitterBufferTarget = targetMs;
            } else if ('playoutDelayHint' in receiver) {
                receiver.playoutDelayHint = targetMs / 1000;
            }
        } catch (err) {
            console.warn(`[WebRTC] Could not apply ${targetMs}ms playout target on ${kind} receiver:`, err);
        }
    }

    // Push the current target to every receiver. Returns true when it changed.
    function reapplyBufferTargets() {
        if (!peerConnection) return false;
        const targetMs = currentBufferTargetMs();
        if (targetMs === lastAppliedTargetMs) return false;
        lastAppliedTargetMs = targetMs;
        peerConnection.getReceivers().forEach(r => {
            applyPlayoutDelay(r, r.track ? r.track.kind : 'media');
        });
        console.log(`[AdaptiveBuffer] Playout target -> ${targetMs}ms` +
            ` (netJitter=${lastNetJitterMs === null ? '--' : lastNetJitterMs.toFixed(0)}ms` +
            ` loss=${lastLossPct === null ? '--' : lastLossPct.toFixed(1)}%` +
            ` playout=${avgPlayoutDelayMs === null ? '--' : avgPlayoutDelayMs.toFixed(0)}ms)`);
        return true;
    }

    // Called once per stats tick (1s) while connected. Two jobs:
    //  1) Anti-stutter: when sustained jitter/loss exceeds what the selected mode
    //     can absorb, hold a larger target (350ms floor) until the network stays
    //     calm again — dropped frames from an under-buffered receiver read as
    //     visible lag/stutter for the viewer.
    //  2) Anti-drift: when the browser's measured jitter-buffer delay grows far
    //     past the requested target, playout is silently lagging the live edge;
    //     hold a ~0ms target briefly so late frames are dropped and the picture
    //     snaps back to now instead of drifting seconds behind the host.
    function superviseAdaptiveBuffer() {
        if (!isConnected) return;
        // A hidden tab suspends video presentation, which inflates the measured
        // jitter-buffer delay into nonsense: every tick reads as multi-second
        // drift and the catch-up trigger (and its chat notice) fire in a loop.
        // Supervision resumes the moment the tab becomes visible again — the
        // freeze watchdog applies the same rule.
        if (document.hidden) return;
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        const now = performance.now();

        // --- Adaptive rendition switching (ABR) ---
        // Sustained stress = interval loss above 5% or jitter above 120ms: the
        // full-bitrate source no longer fits the link and frames get dropped.
        // The 3000k live-av1 rendition absorbs a weak link that the source
        // cannot. 8 stressed seconds switch, 20 calm seconds switch back, and
        // every switch waits out a 60s cooldown so a flapping link cannot
        // produce reconnect storms. Applies only to H264 sources with a ready
        // live-av1 rendition — AV1-source viewers already play the native path.
        const abrStressed = (lastLossPct !== null && lastLossPct > 5)
            || (lastNetJitterMs !== null && lastNetJitterMs > 120);
        const abrCalm = (lastLossPct === null || lastLossPct < 2)
            && (lastNetJitterMs === null || lastNetJitterMs < 40);
        if (abrStressed) {
            abrBadSec += 1;
            abrCalmSec = 0;
        } else if (abrCalm) {
            abrCalmSec += 1;
            abrBadSec = 0;
        } else {
            abrBadSec = 0;
            abrCalmSec = 0;
        }

        const abrCanSwitch = now - lastRenditionSwitchAt > 60000
            && Array.isArray(renditionPathsItems)
            && typeof RTCRtpReceiver !== 'undefined'
            && RTCRtpReceiver.getCapabilities;
        if (abrCanSwitch) {
            const ladderSource = renditionPathsItems.find((item) => item && item.name === 'live');
            const sourceTracks = ladderSource && Array.isArray(ladderSource.tracks) ? ladderSource.tracks : [];
            const sourceIsAv1 = sourceTracks.some((t) => typeof t === 'string' && t.toUpperCase() === 'AV1');
            const rendReady = renditionPathsItems.some((item) => item && item.name === 'live-av1'
                && (item.ready === true || item.online === true));
            // 'live-h264' is included because an audio-rescue viewer sits on it
            // (full source bitrate, no sound on the native path) — a weak link
            // must be able to step down to the 3000k rendition from there too.
            const onFullBitratePath = activeStreamPath === 'live' || activeStreamPath === 'live-h264';
            if (abrBadSec >= 8 && onFullBitratePath && !sourceIsAv1 && rendReady) {
                switchRendition('live-av1',
                    'Your connection is struggling with the full-quality stream — '
                    + 'switched to the lighter rendition to stop frame drops.');
                return;
            }
            if (abrCalmSec >= 20 && activeStreamPath === 'live-av1'
                && ladderSource && (ladderSource.ready === true || ladderSource.online === true)
                && !sourceIsAv1) {
                // The upgrade target is whatever the path matrix wants when the
                // low-bitrate rendition is not preferred — an audio-rescue
                // viewer returns to live-h264 (their only full-quality path
                // WITH sound), everyone else returns to the native path.
                const upgradeTarget = chooseStreamPath(
                    renditionPathsItems,
                    typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
                        ? true : false,
                    av1DecodeSmooth,
                    'preferNonTranscode'
                );
                if (upgradeTarget && upgradeTarget !== 'live-av1') {
                    switchRendition(upgradeTarget,
                        'Connection recovered — back to the full-quality rendition.');
                    return;
                }
            }
        }

        // --- Decode-pressure switching ---
        // packetsLost at 0 and frames arriving, yet decoded falls behind:
        // the receiver's decoder cannot sustain the stream (typically
        // software AV1 at high resolution on a loaded machine — buffer
        // accommodation cannot help a decoder that is simply too slow).
        // Move the viewer onto the hardware-decodable path: an AV1 source
        // rides live-h264 (H264 decodes in hardware on every GPU), and an
        // H264 source viewed through live-av1 returns to the native path.
        // Cooldown shared with ABR so the two loops cannot stampede.
        if (decodeLagSec >= 8 && now - lastRenditionSwitchAt > 60000 && !isConnecting
            && Array.isArray(renditionPathsItems)) {
            const dpSource = renditionPathsItems.find((item) => item && item.name === 'live');
            const dpTracks = dpSource && Array.isArray(dpSource.tracks) ? dpSource.tracks : [];
            const dpSourceIsAv1 = dpTracks.some((t) => typeof t === 'string' && t.toUpperCase() === 'AV1');
            let hwPath = null;
            if (dpSourceIsAv1 && activeStreamPath === 'live') {
                const h264Ready = renditionPathsItems.some((item) => item && item.name === 'live-h264'
                    && (item.ready === true || item.online === true));
                hwPath = h264Ready ? 'live-h264' : null;
            } else if (!dpSourceIsAv1 && activeStreamPath === 'live-av1') {
                // A viewer of a non-Opus (RTMP/SRT AAC) source must not be
                // "recovered" onto the muted native path: prefer the
                // audio-rescue video-copy rendition (full quality + sound)
                // when it is ready, and only fall back to 'live' when the
                // source audio already reaches WebRTC readers.
                const dpTracksUpper = dpTracks.map((t) => typeof t === 'string' ? t.toUpperCase() : '');
                const dpHasOpus = dpTracksUpper.includes('OPUS');
                const dpHasAudio = dpTracksUpper.some((t) => t && !['AV1', 'H264', 'H265', 'HEVC', 'VP8', 'VP9'].includes(t));
                if (dpHasOpus || !dpHasAudio) {
                    hwPath = 'live';
                } else {
                    const rescueReady = renditionPathsItems.some((item) => item && item.name === 'live-h264'
                        && (item.ready === true || item.online === true));
                    hwPath = rescueReady ? 'live-h264' : null;
                }
            }
            if (hwPath && hwPath !== activeStreamPath) {
                decodeLagSec = 0;
                switchRendition(hwPath,
                    "This device's decoder can't keep up with AV1 — switched to the hardware-decodable path for smooth playback.");
                return;
            }
        }

        // --- Drift beyond the accommodation cap -> clean reconnect ---
        // The buffer target accommodates the measured delay (see
        // bufferAccommodationMs), so a delay that STILL outgrows the cap
        // means the session itself is broken — e.g. a long hidden-tab span
        // froze presentation while packets piled up. Reconnect: a fresh WHEP
        // session resets the buffer and lands at the live edge in 2-4s.
        // The cap must sit ABOVE the worst legitimate accommodated target
        // (600ms jitter floor + 2200ms accommodation + margin) or a fully
        // accommodated rough link would rejoin in a loop; 3100ms guarantees
        // that on every mode. The switch cooldown bounds this to at most one
        // rejoin per minute.
        const rejoinCapMs = Math.max(config.driftLimitMs + 1600, 3100);
        if (avgPlayoutDelayMs !== null && avgPlayoutDelayMs > rejoinCapMs
            && !isConnecting && now - lastRenditionSwitchAt > 60000) {
            rejoinDriftSec += 1;
            if (rejoinDriftSec >= 3) {
                rejoinDriftSec = 0;
                switchRendition(activeStreamPath,
                    'Playback fell too far behind the live edge — rejoining at the live edge…');
                return;
            }
        } else {
            rejoinDriftSec = 0;
        }

        // --- Stress raise / calm restore ---
        const stressed = (lastNetJitterMs !== null && lastNetJitterMs > 55)
            || (lastLossPct !== null && lastLossPct > 2.5);
        const calm = (lastNetJitterMs === null || lastNetJitterMs < 25)
            && (lastLossPct === null || lastLossPct < 0.8);

        if (stressed) {
            calmRunSec = 0;
            stressRunSec += 1;
            if (stressRunSec >= 3 && now >= adaptiveRaiseUntil) {
                adaptiveRaiseUntil = now + 15000;
                if (bufferNoticeState !== 'raised') {
                    bufferNoticeState = 'raised';
                    addSystemMessage('Network jitter detected — widening the playout buffer to keep video smooth.');
                }
                reapplyBufferTargets();
            }
        } else if (calm) {
            stressRunSec = 0;
            calmRunSec += 1;
            if (calmRunSec >= 20 && (adaptiveRaiseUntil !== 0 || bufferNoticeState === 'raised')) {
                adaptiveRaiseUntil = 0;
                calmRunSec = 0;
                if (bufferNoticeState === 'raised') {
                    bufferNoticeState = '';
                    addSystemMessage(`Network is stable again — back to the ${config.label} buffer.`);
                }
                reapplyBufferTargets();
            }
        } else {
            stressRunSec = 0;
            calmRunSec = 0;
        }

        reapplyBufferTargets();
        updateBufferHud(null);
    }

    // HUD text for the buffer target / adaptive state. Shows the measured
    // windowed playout delay next to the target whenever the two diverge, so a
    // viewer (or a support session) can SEE receiver lag building instead of
    // only the intended target.
    function updateBufferHud(stateOverride) {
        if (!hudBuffer) return;
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        const targetMs = currentBufferTargetMs();
        const measured = (avgPlayoutDelayMs !== null && Math.abs(avgPlayoutDelayMs - targetMs) > 50)
            ? ` (live ${Math.round(avgPlayoutDelayMs)})`
            : '';
        const state = stateOverride || (targetMs > config.ms ? 'boosted' : 'normal');
        if (state === 'boosted') {
            // The target absorbing more than the mode asks for is normal
            // accommodation (bursty arrivals), not a fault condition.
            hudBuffer.innerText = `${targetMs} ms (absorbing)${measured}`;
        } else {
            hudBuffer.innerText = `${targetMs} ms${measured}`;
        }
    }

    // Strip decorative effects automatically when the receiver is measurably
    // dropping frames (sustained drop bursts seen in getStats). Blur animations
    // and the animated noise overlay compete with video decode/compositing for
    // GPU time on weaker receivers, which shows up as visible stutter. Never
    // overrides an explicit user choice (the same localStorage key the manual
    // toggle persists), and only ever fires once per page load.
    function maybeAutoPerfMode() {
        if (document.body.classList.contains('perf-mode')) return;
        let storedPerfChoice = null;
        try { storedPerfChoice = localStorage.getItem('rydius_perf_mode'); } catch (e) {}
        if (storedPerfChoice !== null) return;   // user decided before — respect it
        if (!perfToggleBtn) return;

        document.body.classList.add('perf-mode');
        perfToggleBtn.classList.add('active');
        perfToggleBtn.setAttribute('aria-pressed', 'true');
        if (perfToggleLabel) perfToggleLabel.innerText = 'Eco Mode';
        dropWindow = []; // the perf-mode class guard at the top makes later calls no-ops
        console.warn('[UI] Sustained frame drops detected — decorative effects reduced automatically.');
        addSystemMessage('Reduced decorative effects automatically to keep playback smooth.');
    }

    /* ==========================================================================
       Stream Connection Logic (WebRTC & WHEP)
       ========================================================================== */

    // ICE configuration comes from the local server at /stream-api/turn: it
    // always carries the free Cloudflare STUN entry (gives this viewer a public
    // reflexive candidate so it can hole-punch a direct path — no account or
    // card required) and, when configured server-side, short-lived Cloudflare
    // TURN relay credentials (the API token never leaves the server). Google
    // STUN is never included: it was historically unreachable from this
    // network and would only stall ICE gathering. Cached for 10 minutes so
    // reconnects skip the round trip without ever outliving the credentials:
    // server.js renews mints at TTL/2 (>= 30 minutes of validity at the
    // default 1h TTL), and Cloudflare disconnects TURN allocations whose
    // credentials have expired — a longer cache could hand a reconnecting
    // viewer dead credentials and drop the relay path entirely.
    let cachedIceServers = null;
    let cachedIceServersAt = 0;
    let iceFetchInFlight = null;

    // Shared fetch path: the cache is filled by the startup prefetch (see
    // prefetchIceServers) and by connectStream. Memoizing the in-flight
    // promise means a connect racing the prefetch reuses the same request
    // instead of double-fetching and discarding one result.
    async function fetchIceServers() {
        if (cachedIceServers !== null && Date.now() - cachedIceServersAt <= 10 * 60 * 1000) {
            return cachedIceServers;
        }
        if (!iceFetchInFlight) {
            iceFetchInFlight = (async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 2500);
                try {
                    const response = await fetch(window.location.origin + '/stream-api/turn', {
                        cache: 'no-store',
                        signal: controller.signal
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const config = await response.json();
                    const servers = allowedIceServers(config && config.iceServers);
                    console.log("[WebRTC] ICE config:", servers.length, "entries — Cloudflare STUN", servers.length > 1 ? "+ TURN relay." : "(TURN not configured).");
                    cachedIceServers = servers;
                    cachedIceServersAt = Date.now();
                    return servers;
                } catch (error) {
                    console.warn("[WebRTC] ICE config unavailable (" + error + "); falling back to host candidates.");
                    // A failed probe must not poison the cache for 10 minutes:
                    // the next connect retries against the server.
                    cachedIceServers = null;
                    cachedIceServersAt = 0;
                    return [];
                } finally {
                    clearTimeout(timer);
                    iceFetchInFlight = null;
                }
            })();
        }
        return iceFetchInFlight;
    }

    // Warm the ICE configuration while the first status poll is still in
    // flight, shaving one round trip (~100-300ms) off time-to-first-frame
    // whenever the stream turns out to be live.
    function prefetchIceServers() {
        fetchIceServers().catch(() => {});
    }

    // Defensive allow-list: TURN relay URLs plus the one verified Cloudflare
    // STUN server, minus the port-53 variant browsers block. Google STUN and
    // anything else never reach RTCPeerConnection — an unreachable STUN host
    // stalls ICE gathering for the full timeout without a usable candidate.
    function allowedIceServers(servers) {
        if (!Array.isArray(servers)) return [];
        return servers.filter((entry) => {
            if (!entry) return false;
            const urls = Array.isArray(entry.urls) ? entry.urls : (entry.urls ? [entry.urls] : []);
            const kept = urls.filter((url) => typeof url === 'string'
                && ((url.startsWith('turn:') || url.startsWith('turns:'))
                    || url.startsWith('stun:stun.cloudflare.com'))
                && !/:53(?:\?|$)/.test(url));
            if (kept.length) entry.urls = kept;
            return kept.length > 0;
        });
    }

    async function connectStream() {
        if (isConnecting || isConnected) {
            console.log("[WebRTC] Already connecting or connected. Aborting duplicate connect call.");
            return;
        }
        
        isConnecting = true;
        updateUIState('connecting');
        
        // Arm a 16-second connection timeout watchdog to prevent an infinite
        // connecting spinner. The budget covers the worst legitimate stack:
        // ICE-config fetch (2.5s cap) + candidate gathering (3s cap) + WHEP
        // POST (10s cap) = 15.5s. The old 12s watchdog could cut off a POST
        // that was still inside its own 10s window, wasting the attempt and
        // adding a reconnect stall — real ICE failures still tear down
        // immediately via the connectionState 'failed' handler; this is only
        // the no-state-change backstop.
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = setTimeout(() => {
            if (isConnecting && !isConnected) {
                console.warn("[WebRTC] Connection attempt timed out after 16s without ICE handshake. Triggering disconnect recovery.");
                addSystemMessage("⚠️ Connection timed out. Re-attempting handshake...");
                handleDisconnected();
            }
        }, 16000);
        
        console.log("[WebRTC] Starting connection sequence...");
        
        try {
            const iceServers = await fetchIceServers();
            console.log("[WebRTC] Creating RTCPeerConnection (iceServers:", iceServers.length, ")...");
            peerConnection = new RTCPeerConnection({
                iceServers: iceServers,
                bundlePolicy: 'max-bundle',
                // Pre-allocate a small candidate pool so the srflx gather of the
                // NEXT connection can start early — reconnects reach the WHEP
                // POST a few hundred milliseconds sooner on slow networks.
                iceCandidatePoolSize: 2
            });

            console.log("[WebRTC] ICE config ready (iceServers:", peerConnection.getConfiguration().iceServers.length, "- host candidates, TURN relay when remote).");

            // Add receive-only transceivers
            const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            configureCodecPreferences(videoTransceiver);

            // Handle incoming track event robustly
            peerConnection.ontrack = (event) => {
                console.log("[WebRTC] Track received! Kind:", event.track.kind, "ID:", event.track.id, "Streams count:", event.streams.length);
                
                applyPlayoutDelay(event.receiver, event.track.kind);

                // Track mute/unmute listeners for freeze guard.
                // A track 'mute' event also fires on brief publisher hiccups and short packet-loss
                // bursts, so confirm the track is still dead after 2s instead of tearing the
                // session down instantly — the decoder flush / re-handshake costs seconds of black screen.
                if (event.track.kind === 'video') {
                    event.track.onmute = () => {
                        console.warn("[FreezeGuard] Video track MUTED by remote/network. Confirming in 2s...");
                        if (muteConfirmTimeout) clearTimeout(muteConfirmTimeout);
                        muteConfirmTimeout = setTimeout(() => {
                            muteConfirmTimeout = null;
                            if (event.track.muted && isConnected) {
                                console.error("[FreezeGuard] Video track still muted after 2s. Triggering recovery...");
                                triggerFreezeRecovery('track_muted');
                            }
                        }, 2000);
                    };
                    event.track.onunmute = () => {
                        console.log("[FreezeGuard] Video track UNMUTED. Stream resumed.");
                        if (muteConfirmTimeout) {
                            clearTimeout(muteConfirmTimeout);
                            muteConfirmTimeout = null;
                        }
                    };
                    event.track.onended = () => {
                        console.warn("[FreezeGuard] Video track ENDED unexpectedly.");
                        if (muteConfirmTimeout) {
                            clearTimeout(muteConfirmTimeout);
                            muteConfirmTimeout = null;
                        }
                        if (isConnected) triggerFreezeRecovery('track_ended');
                    };
                }

                // Initialize srcObject as a new MediaStream if it doesn't exist yet
                if (!player.srcObject || !(player.srcObject instanceof MediaStream)) {
                    player.srcObject = new MediaStream();
                    console.log("[WebRTC] Initialized player.srcObject with a new MediaStream.");
                }
                
                // Add the track to the player's MediaStream if not already present
                const existingTracks = player.srcObject.getTracks();
                if (!existingTracks.find(t => t.id === event.track.id)) {
                    player.srcObject.addTrack(event.track);
                    console.log(`[WebRTC] Added track (${event.track.kind}) to player.srcObject.`);
                }
                
                // Explicitly play the player with autoplay-protection fallback
                player.play().then(() => {
                    console.log(`[WebRTC] Video playback running after adding ${event.track.kind} track.`);
                    initAudioContext();
                    connectPlayerToAudioNodes();
                }).catch(err => {
                    console.warn("[WebRTC] Playback play() promise blocked / pending user interaction:", err);
                    player.muted = true;
                    updateUIState(isConnected ? 'live' : 'connecting');
                    player.play().then(() => {
                        console.log("[WebRTC] Autoplay resolved in muted mode.");
                        if (unmuteOverlay) unmuteOverlay.style.display = 'flex';
                    }).catch(e => {
                        console.warn("[WebRTC] Autoplay fallback failed:", e);
                    });
                });
            };

            // Monitor connection state
            peerConnection.onconnectionstatechange = () => {
                const state = peerConnection.connectionState;
                console.log("[WebRTC] Connection state changed to:", state);
                hudIce.innerText = state;

                switch (state) {
                    case 'connected':
                        console.log("[WebRTC] Handshake successful! Media stream is connected.");
                        // Cancel any pending grace-period teardown if ICE self-healed in time
                        if (disconnectGraceTimer) {
                            clearTimeout(disconnectGraceTimer);
                            disconnectGraceTimer = null;
                            console.log("[WebRTC] Transient ICE blip self-healed. Session preserved without reconnect.");
                        }
                        handleConnected();
                        break;
                    case 'disconnected':
                        // Transient ICE drops (wifi roam, brief packet loss) usually recover within
                        // a couple of seconds by themselves. Tearing down immediately converts a
                        // 1-2s blip into a full 5s+ WHEP re-handshake, so give ICE a grace window.
                        if (!disconnectGraceTimer) {
                            console.warn("[WebRTC] ICE disconnected. Waiting 2500ms for self-recovery before teardown...");
                            disconnectGraceTimer = setTimeout(() => {
                                disconnectGraceTimer = null;
                                if (peerConnection && peerConnection.connectionState === 'disconnected') {
                                    console.warn("[WebRTC] Connection did not self-recover. Tearing down.");
                                    handleDisconnected();
                                }
                            }, 2500);
                        }
                        break;
                    case 'failed':
                        if (disconnectGraceTimer) {
                            clearTimeout(disconnectGraceTimer);
                            disconnectGraceTimer = null;
                        }
                        console.error("[WebRTC] Error: Connection failed.");
                        handleDisconnected();
                        break;
                    case 'closed':
                        console.log("[WebRTC] Connection closed.");
                        break;
                }
            };

            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log("[WebRTC] ICE Connection state changed to:", state);
                hudIce.innerText = state;
            };

            peerConnection.onicegatheringstatechange = () => {
                console.log("[WebRTC] ICE Gathering state changed to:", peerConnection.iceGatheringState);
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log("[WebRTC] Local candidate gathered:", event.candidate.candidate);
                } else {
                    console.log("[WebRTC] Local candidate gathering complete.");
                }
            };

            // Create and set local SDP Offer
            console.log("[WebRTC] Creating SDP offer...");
            const offer = await peerConnection.createOffer();
            console.log("[WebRTC] Setting local description...");
            await peerConnection.setLocalDescription(offer);

            // Wait for ICE candidate gathering. MediaMTX WHEP is non-trickle (candidates must
            // ride inside the offer), so cutting gathering short can drop the browser's
            // srflx candidate and break receivers behind strict NAT. Early-exit on 'complete'
            // keeps typical startup fast; the 3s cap only binds on very slow networks.
            console.log("[WebRTC] Waiting up to 3s for local ICE candidate gathering...");
            await new Promise((resolve) => {
                let checkState;
                let gatherTimeout;

                checkState = () => {
                    if (peerConnection && peerConnection.iceGatheringState === 'complete') {
                        console.log("[WebRTC] Local ICE gathering completed inside promise check.");
                        if (gatherTimeout) clearTimeout(gatherTimeout);
                        peerConnection.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                };

                if (peerConnection && peerConnection.iceGatheringState === 'complete') {
                    console.log("[WebRTC] Local ICE gathering already complete.");
                    resolve();
                } else {
                    peerConnection.addEventListener('icegatheringstatechange', checkState);
                    gatherTimeout = setTimeout(() => {
                        console.log("[WebRTC] ICE gathering window reached. Proceeding to send WHEP offer...");
                        if (peerConnection) {
                            peerConnection.removeEventListener('icegatheringstatechange', checkState);
                        }
                        resolve();
                    }, 3000);
                }
            });

            // Patch local SDP Offer with high bitrate limits
            const rawOfferSdp = peerConnection.localDescription.value || peerConnection.localDescription.sdp;
            const finalOfferSdp = optimizeSdp(rawOfferSdp);

            console.log("[WebRTC] Sending WHEP POST to signal gateway...");
            const whepUrl = window.location.origin + WHEP_PATH;
            const activeWhepUrl = activeStreamPath && activeStreamPath !== 'live'
                ? window.location.origin + `/stream-api/${activeStreamPath}/whep`
                : whepUrl;
            console.log("[WHEP POST URL]:", activeWhepUrl);

            whepAbortController = new AbortController();
            // Bound the handshake round-trip: without this, a stalled POST would sit
            // until the 16s watchdog fired. Signaling is a local ~10ms exchange, so
            // 10s means something is genuinely broken and a fast retry helps sooner.
            whepPostTimeout = setTimeout(() => {
                console.warn("[WebRTC] WHEP POST exceeded 10s without a response. Aborting handshake.");
                if (whepAbortController) whepAbortController.abort();
            }, 10000);
            let response;
            try {
                response = await fetch(activeWhepUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/sdp'
                    },
                    body: finalOfferSdp,
                    signal: whepAbortController.signal
                });
            } finally {
                if (whepPostTimeout) {
                    clearTimeout(whepPostTimeout);
                    whepPostTimeout = null;
                }
            }

            console.log("[WHEP POST Response Status]:", response.status, response.statusText);

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`WHEP signaling failed (Status ${response.status}): ${errText}`);
            }

            // Capture WHEP Location header for graceful session teardown
            const locationHeader = response.headers.get('Location');
            if (locationHeader) {
                whepSessionUrl = new URL(locationHeader, window.location.origin).href;
                console.log("[WebRTC] WHEP session resource URL recorded:", whepSessionUrl);
            } else {
                whepSessionUrl = null;
            }

            // Set remote SDP answer from MediaMTX
            const answerSdp = await response.text();
            console.log("[WebRTC] Received SDP answer from MediaMTX.");
            
            console.log("[WebRTC] Setting remote description...");
            await peerConnection.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: answerSdp
            }));
            console.log("[WebRTC] Set remote description successfully! Waiting for media packets...");
            
        } catch (error) {
            if (error && error.name === 'AbortError') {
                // Teardown already ran (16s watchdog, freeze recovery, or ICE
                // failure). A late answer must not be applied to the next peer
                // connection or resurrect a session that no longer exists.
                console.log("[WebRTC] WHEP request aborted during teardown. Ignoring stale answer.");
                return;
            }
            console.error("[WebRTC] Error in connection sequence:", error);
            isConnecting = false;
            handleDisconnected();
        }
    }

    function handleConnected() {
        if (isConnected) {
            console.log("[WebRTC] handleConnected() called while already connected. Ignoring duplicate.");
            return;
        }
        console.log("[WebRTC] handleConnected() called. Finalizing state...");
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        isConnected = true;
        isConnecting = false;
        connectionStartTime = performance.now();
        healthyPlaybackSeconds = 0;
        reconnectAttempts = 0; // Connected cleanly: the next drop restarts the 1s → 2s → 4s → 5s probe ladder
        updateUIState('live');
        
        if (player.srcObject) {
            console.log("[WebRTC] Connection established. Force playing video element...");
            player.play().then(() => {
                console.log("[WebRTC] Force play resolved successfully.");
                initAudioContext();
                connectPlayerToAudioNodes();
            }).catch(err => {
                console.warn("[WebRTC] Force play failed / blocked:", err);
                player.muted = true;
                updateUIState('live');
                player.play().then(() => {
                    console.log("[WebRTC] Force play resolved in muted fallback.");
                    if (unmuteOverlay) unmuteOverlay.style.display = 'flex';
                }).catch(e => {
                    console.warn("[WebRTC] Force play fallback blocked:", e);
                });
            });
        }
        
        startTelemetry();
        startFreezeWatchdog();
        startRenditionPathsPoll();
        playSfx('chime');
        addSystemMessage("Stream connected. Playback is using WebRTC.");
    }

    function handleDisconnected() {
        console.log("[WebRTC] Handling disconnection. Cleaning up...");
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (disconnectGraceTimer) {
            clearTimeout(disconnectGraceTimer);
            disconnectGraceTimer = null;
        }

        const duration = performance.now() - connectionStartTime;
        if (isConnected && duration < 5000) {
            console.warn("[WebRTC] Disconnection happened soon after connecting; the stream or network may be incompatible.");
            addSystemMessage("Playback ended soon after connecting. WebRTC cannot play H.264 streams with B-frames — in OBS set Max B-frames to 0 (required). If it persists, check bitrate and frame rate.");
        }

        isConnected = false;
        isConnecting = false;
        stopFreezeWatchdog();
        cleanupConnection();
        updateUIState('offline');
        stopTelemetry();
        stopAudioMeter();

        schedulePoll();
    }

    // Gracefully clean up connection and send WHEP DELETE to server
    function cleanupConnection() {
        console.log("[WebRTC] Cleaning up PeerConnection...");
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (disconnectGraceTimer) {
            clearTimeout(disconnectGraceTimer);
            disconnectGraceTimer = null;
        }
        if (muteConfirmTimeout) {
            clearTimeout(muteConfirmTimeout);
            muteConfirmTimeout = null;
        }

        // Cancel any in-flight WHEP POST first: a late SDP answer could
        // otherwise be applied to the *next* peer connection (breaking that
        // attempt), and a request that completes after teardown would leave a
        // reader session forwarding video to nobody.
        if (whepAbortController) {
            whepAbortController.abort();
            whepAbortController = null;
        }
        if (whepPostTimeout) {
            clearTimeout(whepPostTimeout);
            whepPostTimeout = null;
        }

        // Send WHEP DELETE to instantly free MediaMTX resources
        if (whepSessionUrl) {
            try {
                fetch(whepSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
                console.log("[WebRTC] Sent WHEP DELETE session teardown request.");
            } catch (e) {
                // Ignore
            }
            whepSessionUrl = null;
        }

        if (peerConnection) {
            try {
                peerConnection.ontrack = null;
                peerConnection.onconnectionstatechange = null;
                peerConnection.oniceconnectionstatechange = null;
                peerConnection.onicegatheringstatechange = null;
                peerConnection.onicecandidate = null;
                peerConnection.close();
            } catch (e) {
                console.warn("[WebRTC] Error closing peer connection:", e);
            }
            peerConnection = null;
        }
        if (renditionPollInterval) {
            clearInterval(renditionPollInterval);
            renditionPollInterval = null;
        }
        player.pause();
        player.srcObject = null;
    }

    // Teardown WHEP session on tab close, hide, or refresh
    function teardownSession() {
        if (whepSessionUrl) {
            try {
                fetch(whepSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
            } catch (e) {}
            whepSessionUrl = null;
        }
    }
    window.addEventListener('pagehide', teardownSession);
    window.addEventListener('beforeunload', teardownSession);

    // While connected, keep a slow snapshot of the rendition ladder so
    // adaptive switching can pick a target without a full disconnect/re-poll
    // cycle. 5s cadence — the ladder only changes when a broadcast starts,
    // stops, or the codec bridge flips state.
    function startRenditionPathsPoll() {
        if (renditionPollInterval) clearInterval(renditionPollInterval);
        const poll = async () => {
            try {
                const response = await fetch(window.location.origin + '/stream-api/v3/paths/list', { cache: 'no-store' });
                if (!response.ok) return;
                const data = await response.json();
                if (isConnected) renditionPathsItems = Array.isArray(data.items) ? data.items : null;
            } catch (err) {
                /* ladder refresh failed; the previous snapshot stays */
            }
        };
        renditionPollInterval = setInterval(poll, 5000);
        poll();
    }

    // Adaptive rendition switch (ABR): tear the current WHEP session down and
    // reconnect to a different rendition. A brief connecting paint is honest;
    // everything else (chat, volume, latency mode) carries over.
    async function switchRendition(pathName, message) {
        if (isConnecting || !isConnected) return;
        console.log(`[ABR] Switching rendition ${activeStreamPath} -> ${pathName}`);
        lastRenditionSwitchAt = performance.now();
        abrBadSec = 0;
        abrCalmSec = 0;
        activeStreamPath = pathName;
        addSystemMessage(message);
        playSfx('pop');
        stopFreezeWatchdog();
        stopTelemetry();
        cleanupConnection();
        isConnected = false;
        isConnecting = false;
        updateUIState('connecting');
        await new Promise(r => setTimeout(r, 200));
        await connectStream();
    }

    // Called when the tab becomes visible again: a hidden span suspends
    // presentation while packets keep arriving, and the measured playout
    // delay inflates (measured live: 1.7-2.8s). The periodic stats loop was
    // stopped while hidden, so the retained avgPlayoutDelayMs still holds
    // the pre-hide value — useless for this decision. One fresh getStats()
    // delta against the pre-hide baselines measures exactly the hidden span
    // (jitterBufferDelay/EmittedCount kept accumulating throughout), so the
    // stale-or-healthy verdict is immediate: past the rejoin cap the session
    // is re-established at the live edge at once, inside it the measurement
    // feeds the accommodation (no drops, slightly higher latency).
    let rejoinCheckInFlight = false;
    async function maybeRejoinOnReturn() {
        if (!isConnected || isConnecting || rejoinCheckInFlight || !peerConnection) return;
        rejoinCheckInFlight = true;
        try {
            const stats = await peerConnection.getStats();
            let videoStats = null;
            stats.forEach((report) => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;
            });
            if (videoStats
                && Number.isFinite(videoStats.jitterBufferDelay)
                && Number.isFinite(videoStats.jitterBufferEmittedCount)) {
                const hiddenSpanDelayMs = windowedPlayoutDelayMs(
                    videoStats.jitterBufferDelay,
                    videoStats.jitterBufferEmittedCount,
                    lastJitterDelayTotal,
                    lastJitterEmittedTotal
                );
                if (hiddenSpanDelayMs !== null) avgPlayoutDelayMs = hiddenSpanDelayMs;
            }
            const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
            if (avgPlayoutDelayMs !== null
                && avgPlayoutDelayMs > Math.max(config.driftLimitMs + 1600, 3100)) {
                lastRenditionSwitchAt = performance.now();
                rejoinDriftSec = 0;
                switchRendition(activeStreamPath,
                    'Playback fell too far behind the live edge — rejoining at the live edge…');
            }
        } catch (err) {
            // Stats unavailable: the supervisor's periodic 3-tick check still
            // covers the stale-session case once the loop is running again.
            console.warn('[AdaptiveBuffer] Hidden-span delay check failed:', err);
        } finally {
            rejoinCheckInFlight = false;
        }
    }

    // Chrome suspends video presentation in hidden tabs while packets keep
    // arriving, which inflates the jitter buffer; on return, hand the inflated
    // delay to maybeRejoinOnReturn (rejoin if stale, accommodate otherwise).
    // Suspend telemetry and polling while the page is hidden (tab
    // backgrounded); on return, resume with measurement baselines intact and
    // hand any hidden-span drift to maybeRejoinOnReturn.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log("[App] Tab backgrounded. Suspending stats and polling intervals to save resources...");
            if (statsInterval) {
                clearInterval(statsInterval);
                statsInterval = null;
            }
            if (streamActiveCheckTimeout) {
                clearTimeout(streamActiveCheckTimeout);
                streamActiveCheckTimeout = null;
            }
            stopAudioMeter();
        } else {
            console.log("[App] Tab foregrounded. Resuming polling/telemetry...");
            lastFrameTime = performance.now();
            frozenSince = 0;
            if (isConnected) {
                beginStatsLoop();
                startAudioMeter();
                ensureVideoFrameCallback();
                maybeRejoinOnReturn();
            } else {
                pollStreamStatus();
            }
        }
    });

    // True when this browser can decode AV1 inside WebRTC. Uses the REAL
    // RTCRtpReceiver capabilities (not canPlayType), because a browser may
    // decode AV1 in <video> but not in a peer connection. Returns false
    // outside browsers and on any error so polling never breaks.
    function browserSupportsAv1() {
        try {
            if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return false;
            const caps = RTCRtpReceiver.getCapabilities('video');
            if (!caps || !Array.isArray(caps.codecs)) return false;
            return caps.codecs.some((c) => {
                if (!c || typeof c.mimeType !== 'string') return false;
                // mimeType looks like "video/AV1" or "video/av01"; lowercase
                // first, same convention as configureCodecPreferences above.
                const mime = c.mimeType.toLowerCase();
                return mime.includes('av01') || mime.includes('av1');
            });
        } catch (err) {
            console.warn('[Polling] AV1 capability probe failed, assuming unsupported:', err);
            return false;
        }
    }

    // True when this browser decodes AV1 SMOOTHLY. Capability lists also
    // contain software decoders: a machine without AV1 hardware "supports"
    // AV1 yet drops frames at high resolution/framerate, which reads as lag
    // for the viewer. navigator.mediaCapabilities.decodingInfo (type
    // "webrtc") answers whether the decode is smooth and hardware-backed for
    // this device. Probed once per session at 1080p60 — a conservative
    // stand-in for the real stream geometry, which is unknown before
    // connecting. Returns null when the API is unavailable so callers keep
    // the capability-list-only behavior.
    let av1DecodeSmooth = null;
    let av1DecodeProbed = false;
    async function probeAv1DecodeSmooth() {
        if (av1DecodeProbed) return av1DecodeSmooth;
        av1DecodeProbed = true;
        try {
            if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return null;
            const result = await navigator.mediaCapabilities.decodingInfo({
                type: 'webrtc',
                video: {
                    contentType: 'video/AV1; profile="0"; level=13; tier=0;',
                    width: 1920,
                    height: 1080,
                    bitrate: 20000000,
                    framerate: 60
                }
            });
            av1DecodeSmooth = Boolean(result.supported && result.smooth);
            console.log(`[WebRTC] AV1 decode probe: supported=${result.supported} `
                + `smooth=${result.smooth} powerEfficient=${result.powerEfficient}`);
        } catch (err) {
            console.warn('[WebRTC] AV1 decode probe unavailable; relying on capability list.', err);
            av1DecodeSmooth = null;
        }
        return av1DecodeSmooth;
    }

    // Pick the stream path this browser should play, from a MediaMTX
    // /v3/paths/list response. Pure function (unit-tested in js_checks.js).
    //
    //   source AV1   + AV1 browser        -> live      (native, no transcode)
    //   source AV1   + legacy browser     -> live-h264 if ready, else null (wait)
    //   source H264  + AV1 browser        -> live-av1 if ready AND AV1 decodes
    //                                        smoothly on this device, else live
    //   source H264  + legacy browser     -> live
    //
    // Audio rescue: MediaMTX serves the AAC audio of an RTMP/SRT source to
    // nobody over WebRTC, so the native path plays VIDEO-ONLY for viewers of
    // such a broadcast. When the source audio is not Opus and the bridge's
    // renditions are ready, viewers prefer a sound-carrying rendition (sound
    // beats a muted native path):
    //
    //   source H264 (AAC) + AV1-smooth browser -> live-av1 (3000k + sound)
    //   source H264 (AAC) + any other browser  -> live-h264 (full-bitrate copy + sound)
    //   source AV1  (AAC) + AV1-smooth browser -> live-av1 (encode + sound)
    //   source AV1  (AAC) + any other browser  -> live-h264 if ready, else null
    //
    // 'preferNonTranscode' (the calm-ABR upgrade) restores the full-quality
    // rendition instead: live-h264 for AAC sources, the native path otherwise.
    //
    // av1Smooth comes from the Media Capabilities probe (null = unknown, keep
    // the capability-list behavior): a browser that merely supports AV1 in
    // software would drop frames at high resolution — those viewers stay on
    // the hardware-decodable H264 path.
    //
    // preference drives adaptive rendition switching (ABR): 'preferTranscode'
    // moves a stressed viewer onto the low-bitrate rendition, 'preferNonTrans-
    // code' moves a recovered viewer back to the source; 'auto' (default) is
    // the plain quality-first matrix.
    //
    // Returns a path name, or null when the source is up but no compatible
    // rendition exists yet (codec_bridge.js is still starting).
    function chooseStreamPath(items, av1Capable, av1Smooth = true, preference = 'auto') {
        if (!Array.isArray(items)) return null;
        const source = items.find((item) => item && item.name === 'live');
        if (!source || !(source.ready === true || source.online === true)) return null;
        const tracks = Array.isArray(source.tracks) ? source.tracks : [];
        const upperTracks = tracks
            .filter((t) => typeof t === 'string')
            .map((t) => t.toUpperCase());
        const sourceIsAv1 = upperTracks.includes('AV1');
        const hasOpusAudio = upperTracks.includes('OPUS');
        // Every non-video track MediaMTX reports is audio ('Opus',
        // 'MPEG-4 Audio', ...), mirroring codec_bridge.js's rule.
        const hasAudio = upperTracks.some((t) => !['AV1', 'H264', 'H265', 'HEVC', 'VP8', 'VP9'].includes(t));
        const hasVideo = upperTracks.some((t) => ['AV1', 'H264', 'H265', 'HEVC', 'VP8', 'VP9'].includes(t));
        const ready = (name) => {
            const pathItem = items.find((item) => item && item.name === name);
            return Boolean(pathItem && (pathItem.ready === true || pathItem.online === true));
        };
        if (sourceIsAv1) {
            // A browser whose Media Capabilities probe said AV1 does not decode
            // smoothly would stutter on the native AV1 path at high resolution —
            // send it to the H264 rendition (or wait for it) exactly like a
            // legacy browser. An unknown probe (null) keeps native AV1.
            if (av1Capable && av1Smooth !== false) {
                if (hasOpusAudio || !hasAudio) return 'live';
                // Non-Opus (RTMP/SRT AAC) source: the native path plays
                // VIDEO-ONLY, so prefer the bridge's live-av1 rendition
                // (encode + Opus audio, half the bitrate) and fall back to
                // the live-h264 rescue copy; wait when neither is ready
                // rather than connecting to a muted picture.
                if (preference !== 'preferNonTranscode' && ready('live-av1')) {
                    return 'live-av1';
                }
                return ready('live-h264') ? 'live-h264' : null;
            }
            return ready('live-h264') ? 'live-h264' : null;
        }
        // H264 (or other WebRTC-playable) source: when its audio cannot reach
        // WebRTC readers, the audio-rescue rendition is the only path with
        // sound for everyone — full-bitrate video copy, near-zero cost. An
        // audio-only source (no video track) can never have a rendition; the
        // native path plays it fine, so the rescue logic must not apply.
        if (!hasOpusAudio && hasAudio && hasVideo) {
            if (av1Capable && av1Smooth !== false && ready('live-av1') && preference !== 'preferNonTranscode') {
                return 'live-av1';
            }
            return ready('live-h264') ? 'live-h264' : null;
        }
        if (av1Capable && av1Smooth !== false && ready('live-av1')) {
            if (preference === 'preferTranscode') return 'live-av1';
            if (preference === 'preferNonTranscode') return 'live';
            return 'live-av1';
        }
        return 'live';
    }

    // Direct Status Polling
    async function pollStreamStatus() {
        if (isConnected || isConnecting) {
            console.log("[Polling] Skip poll: connection in progress or active.");
            return;
        }

        // Probe the MediaMTX control API for the real publisher state of path "live".
        // An OPTIONS probe on the WHEP endpoint cannot detect offline status: MediaMTX
        // (and this proxy) answer CORS preflight with 204 whether or not a stream exists
        // (verified against MediaMTX v1.21.1), which previously triggered a full WebRTC
        // connect attempt on every single poll.
        const checkUrl = window.location.origin + '/stream-api/v3/paths/list';
        console.log("[Polling] Checking stream status via MediaMTX API:", checkUrl);
        
        try {
            const response = await fetch(checkUrl, { cache: 'no-store' });
            console.log("[Polling] Stream status response code:", response.status);

            if (!response.ok) {
                // 502/404 here means MediaMTX itself is unreachable (or the API moved).
                // Treat the stream as offline instead of starting a doomed connect.
                throw new Error(`unexpected status ${response.status}`);
            }

            const data = await response.json();

            // A concurrent probe (tab resume / 'online' event) may have started a
            // connection while this response was in flight. Acting on the stale
            // answer would paint OFFLINE over a live session and, because the
            // connection owns the polling schedule from here, could leave the
            // header stuck until the next real disconnect.
            if (isConnected || isConnecting) {
                console.log("[Polling] Stale probe arrived after a connection started. Discarding it.");
                return;
            }

            const livePath = Array.isArray(data.items)
                ? data.items.find((item) => item && item.name === 'live')
                : null;
            const isLive = Boolean(livePath && (livePath.ready === true || livePath.online === true));

            if (isLive) {
                const chosenPath = chooseStreamPath(
                    data.items,
                    browserSupportsAv1(),
                    await probeAv1DecodeSmooth()
                );
                if (chosenPath) {
                    activeStreamPath = chosenPath;
                    renditionWaitPolls = 0;
                    renditionWaitWarned = false;
                    console.log(`[Polling] Stream is ONLINE (path '${chosenPath}'). Initiating WebRTC...`);
                    connectStream();
                } else {
                    // Source is live but the compatible rendition (e.g. live-h264
                    // for a non-AV1 browser on an AV1 source) is not ready yet —
                    // codec_bridge.js typically needs 2-4s. Keep the connecting
                    // state and poll again instead of falsely painting offline.
                    renditionWaitPolls += 1;
                    if (renditionWaitPolls >= 8 && !renditionWaitWarned) {
                        renditionWaitWarned = true;
                        console.warn('[Polling] No compatible rendition after sustained waiting — AV1-only broadcast?');
                        addSystemMessage('This broadcast looks AV1-only and this browser cannot decode AV1. '
                            + 'Ask the host to broadcast H.264 via WHIP so every browser gets a rendition.');
                    }
                    console.log("[Polling] Source is live, waiting for a compatible rendition from codec_bridge.js...");
                    updateUIState('connecting');
                    schedulePoll();
                }
            } else {
                renditionWaitPolls = 0;
                renditionWaitWarned = false;
                console.log("[Polling] Stream is OFFLINE (no publisher on path 'live').");
                updateUIState('offline');
                schedulePoll();
            }
        } catch (e) {
            console.error("[Polling] Error checking status (MediaMTX down / network issue):", e.message);
            // Same stale-probe guard as the success path: an active connection
            // must never be overwritten with an offline paint, and it already
            // owns the poll schedule (the reconnect loop restarts on disconnect).
            if (isConnected || isConnecting) return;
            updateUIState('offline');
            schedulePoll();
        }
    }

    function schedulePoll() {
        if (streamActiveCheckTimeout) clearTimeout(streamActiveCheckTimeout);
        // After an unexpected mid-stream drop, probe quickly (1s → 2s → 4s) instead of always
        // waiting the full 5s, so receivers rejoin the live edge as fast as possible.
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), POLL_INTERVAL_MS);
        reconnectAttempts = Math.min(reconnectAttempts + 1, 3);
        streamActiveCheckTimeout = setTimeout(pollStreamStatus, delay);
        console.log(`[Polling] Scheduled status check in ${Math.round(delay / 1000)}s.`);
    }

    /* ==========================================================================
       UI States Management
       ========================================================================== */

    function updateUIState(state) {
        statusBadge.className = `status-badge ${state}`;
        statusText.innerText = state.toUpperCase();
        renderStreamSummary(state);
        playerLoader.setAttribute('aria-hidden', String(state !== 'connecting'));
        offlineOverlay.setAttribute('aria-hidden', String(state !== 'offline'));

        if (state === 'live') {
            playerLoader.style.display = 'none';
            offlineOverlay.style.display = 'none';
            if (player.muted) {
                unmuteOverlay.style.display = 'flex';
                unmuteOverlay.setAttribute('aria-hidden', 'false');
            } else {
                unmuteOverlay.style.display = 'none';
                unmuteOverlay.setAttribute('aria-hidden', 'true');
            }
        } else if (state === 'connecting') {
            playerLoader.style.display = 'flex';
            offlineOverlay.style.display = 'none';
            unmuteOverlay.style.display = 'none';
            unmuteOverlay.setAttribute('aria-hidden', 'true');
        } else { // offline
            playerLoader.style.display = 'none';
            offlineOverlay.style.display = 'flex';
            unmuteOverlay.style.display = 'none';
            unmuteOverlay.setAttribute('aria-hidden', 'true');
        }
    }

    function renderStreamSummary(state) {
        const isLive = state === 'live' && isConnected;
        if (liveLabel) liveLabel.hidden = !isLive;

        if (!isLive) {
            const waitingText = state === 'connecting' ? 'Connecting to stream…' : 'Waiting for stream';
            if (streamCodec) streamCodec.textContent = waitingText;
            if (streamQuality) streamQuality.textContent = state === 'connecting' ? 'Waiting for video' : 'Set by the broadcaster';
            if (streamRtt) streamRtt.textContent = state === 'connecting' ? 'Checking connection' : 'Not connected';
            return;
        }

        const resolution = player.videoWidth && player.videoHeight
            ? `${player.videoWidth}×${player.videoHeight}`
            : null;
        const frameRate = Number.isFinite(currentFrameRate) ? `${Math.round(currentFrameRate)} fps` : null;
        const bitrate = Number.isFinite(currentBitrateMbps) ? `${currentBitrateMbps.toFixed(1)} Mbps` : null;
        const summary = [resolution, frameRate, bitrate].filter(Boolean);

        if (streamCodec) streamCodec.textContent = summary.length ? summary.join(' · ') : 'Live · collecting stream data';
        if (streamQuality) {
            const quality = [resolution, frameRate].filter(Boolean);
            streamQuality.textContent = quality.length ? quality.join(' · ') : 'Measuring stream quality';
        }
    }

    /* ==========================================================================
       Telemetry HUD, Bitrate Sparkline Canvas & Statistics
       ========================================================================== */

    function drawBitrateSparkline() {
        if (!hudBitrateCanvas || !telemetryHud || telemetryHud.style.display !== 'block') return;
        const ctx = hudBitrateCanvas.getContext('2d');
        if (!ctx) return;

        const w = hudBitrateCanvas.width;
        const h = hudBitrateCanvas.height;
        ctx.clearRect(0, 0, w, h);

        const maxBitrate = Math.max(10, ...bitrateHistory) * 1.15;
        const step = w / (bitrateHistory.length - 1);

        // Gradient area
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(34, 211, 238, 0.45)');
        gradient.addColorStop(1, 'rgba(34, 211, 238, 0.02)');

        ctx.beginPath();
        bitrateHistory.forEach((val, i) => {
            const x = i * step;
            const y = h - (val / maxBitrate) * (h - 6) - 3;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });

        // Fill path
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Stroke line
        ctx.beginPath();
        bitrateHistory.forEach((val, i) => {
            const x = i * step;
            const y = h - (val / maxBitrate) * (h - 6) - 3;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(34, 211, 238, 0.6)';
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    function startTelemetry() {
        lastBytesReceived = 0;
        lastFramesDecodedCount = 0;
        lastStatsTime = performance.now();

        // Fresh session → fresh supervision baselines (measurements from a
        // previous connection must never influence the new one).
        lastPacketsReceived = 0;
        lastPacketsLost = 0;
        lastFramesDropped = 0;
        dropWindow = [];
        dropTickPending = true;
        decodeLagSec = 0;
        lastFramesReceived = 0;
        stressRunSec = 0;
        calmRunSec = 0;
        rejoinDriftSec = 0;
        adaptiveRaiseUntil = 0;
        lastNetJitterMs = null;
        lastLossPct = null;
        avgPlayoutDelayMs = null;
        lastJitterDelayTotal = 0;
        lastJitterEmittedTotal = 0;
        lastAppliedTargetMs = null;
        bufferNoticeState = '';
        accommodationTargetMs = 0;
        accommodationCalmTicks = 0;
        jitterFloorEmaMs = 0;
        abrBadSec = 0;
        abrCalmSec = 0;
        lastRenditionSwitchAt = -60000;
        renditionPathsItems = null;
        lastPresentedFrames = 0;
        lastPresentedFramesAtTick = 0;
        lastPresentedTickAt = 0;
        lastRouteText = '--';
        lastRecoveryCounts = null;
        if (hudRoute) hudRoute.innerText = '--';

        beginStatsLoop();
    }

    // (Re)arm the 1s stats tick without touching the measurement baselines.
    // startTelemetry() zeroes them for a fresh session; this path is also used
    // when a backgrounded tab returns, where keeping the pre-hide baselines is
    // what makes the first tick after resume a true average over the hidden
    // span — zeroed baselines against session-long byte/frame counters would
    // instead print one garbage multi-Gbps bitrate spike and pollute the
    // sparkline.
    function beginStatsLoop() {
        if (statsInterval) clearInterval(statsInterval);
        // Drop-window state is per loop run: the first tick after a fresh
        // connect OR a tab resume must re-baseline only (its delta would span
        // the whole hidden period) and never count toward Eco Mode.
        dropWindow = [];
        dropTickPending = true;
        statsInterval = setInterval(async () => {
            if (!peerConnection || peerConnection.connectionState !== 'connected') return;

            try {
                const stats = await peerConnection.getStats();
                let videoStats = null;
                let candidatePairStats = null;

                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        videoStats = report;
                    }
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected || !candidatePairStats)) {
                        candidatePairStats = report;
                    }
                });

                if (player) {
                    const playState = player.paused ? "Paused" : "Playing";
                    // Presentation rate from rVFC's compositor counter: a high
                    // decode rate with a low render rate is the signature of
                    // GPU/compositor starvation on the viewer side.
                    const nowTick = performance.now();
                    let stateText = `RS:${player.readyState}`;
                    if (lastPresentedFrames > 0 && lastPresentedTickAt > 0) {
                        const presentedDt = (nowTick - lastPresentedTickAt) / 1000;
                        if (presentedDt > 0.5) {
                            lastPresentedFps = Math.max(0,
                                (lastPresentedFrames - lastPresentedFramesAtTick) / presentedDt);
                            stateText = `${lastPresentedFps.toFixed(1)} fps rendered`;
                        }
                    }
                    lastPresentedFramesAtTick = lastPresentedFrames;
                    lastPresentedTickAt = nowTick;
                    if (hudVideoState) hudVideoState.innerText = `${playState} · ${stateText}`;
                    if (hudResolution) hudResolution.innerText = player.videoWidth > 0 ? `${player.videoWidth}x${player.videoHeight}` : "--";
                }

                if (videoStats) {
                    if (videoStats.codecId) {
                        const codecReport = stats.get(videoStats.codecId);
                        if (codecReport && codecReport.mimeType) {
                            hudCodec.innerText = codecReport.mimeType.replace('video/', '');
                        }
                    }

                    hudPacketsLost.innerText = videoStats.packetsLost || 0;
                    if (videoStats.packetsLost > 0) {
                        hudPacketsLost.className = "hud-value text-warning";
                    } else {
                        hudPacketsLost.className = "hud-value";
                    }

                    // Session recovery totals for the diagnostic export: NACK
                    // (retransmit) and PLI (keyframe request) counts show how
                    // hard the link fought to keep the picture — a rising PLI
                    // count is the signature of recurring keyframe loss.
                    if (Number.isFinite(videoStats.pliCount) || Number.isFinite(videoStats.nackCount)) {
                        lastRecoveryCounts = {
                            pli: videoStats.pliCount || 0,
                            nack: videoStats.nackCount || 0
                        };
                    }

                    const decoded = videoStats.framesDecoded || 0;
                    const dropped = videoStats.framesDropped || 0;
                    const received = videoStats.framesReceived || 0;
                    if (hudFrames) hudFrames.innerText = `${decoded} / ${dropped} (Recv:${received})`;

                    // Sustained frame-drop pressure means decode/render is losing to
                    // everything else on the GPU; maybeAutoPerfMode() strips the
                    // decorative effects once so the video wins (unless the user
                    // already made an explicit choice).
                    const droppedDelta = dropped - lastFramesDropped;
                    lastFramesDropped = dropped;
                    // Rolling 3-tick window replaces the old strictly-consecutive
                    // counter (>=3 drops on 3 back-to-back ticks), which never
                    // fired for keyframe-periodic bursts — drops once per GOP
                    // arrive on alternating ticks exactly at high bitrate. Any
                    // >=9-drop pattern within 3 seconds now enables Eco Mode.
                    // The first tick after a (re)start only re-baselines, and
                    // ticks inside a live-edge catch-up count zero: those are
                    // the supervisor's intentional late-frame discards, not
                    // decode pressure.
                    if (dropTickPending) {
                        dropTickPending = false;
                    } else {
                        dropWindow.push(Math.max(0, droppedDelta));
                        if (dropWindow.length > 3) dropWindow.shift();
                        if (dropWindow.reduce((sum, value) => sum + value, 0) >= 9) maybeAutoPerfMode();
                    }

                    // Interval packet loss feeds the adaptive buffer supervisor.
                    const rxNow = videoStats.packetsReceived || 0;
                    const lostNow = videoStats.packetsLost || 0;
                    const dRx = rxNow - lastPacketsReceived;
                    const dLost = lostNow - lastPacketsLost;
                    if (lastPacketsReceived > 0 && (dRx + dLost) > 0) {
                        lastLossPct = Math.max(0, (dLost / (dRx + dLost)) * 100);
                    }
                    lastPacketsReceived = rxNow;
                    lastPacketsLost = lostNow;

                    // Smoothed inbound network jitter (stats report it in seconds).
                    if (Number.isFinite(videoStats.jitter)) {
                        const jitterMsNow = videoStats.jitter * 1000;
                        lastNetJitterMs = lastNetJitterMs === null
                            ? jitterMsNow
                            : lastNetJitterMs * 0.7 + jitterMsNow * 0.3;
                        // Only trust the jitter estimate while frames are
                        // actually flowing: connection-setup and stall windows
                        // produce wild estimates that would pin the floor at
                        // its cap for half a minute of stepwise decay.
                        if (decoded > lastFramesDecodedCount) {
                            jitterFloorEmaMs = jitterBufferFloorMs(lastNetJitterMs, jitterFloorEmaMs);
                        }
                    }
                    if (hudJitter) {
                        hudJitter.innerText = lastNetJitterMs === null ? '-- ms' : `${Math.round(lastNetJitterMs)} ms`;
                    }

                    // Windowed time packets actually waited in the jitter buffer —
                    // the ground truth for "is playout drifting behind the live
                    // edge?". Cumulative totals are kept as baselines so the
                    // next tick measures only its own window (see
                    // windowedPlayoutDelayMs for why the session average is
                    // useless for drift detection).
                    if (Number.isFinite(videoStats.jitterBufferDelay)
                        && Number.isFinite(videoStats.jitterBufferEmittedCount)) {
                        const windowedDelayMs = windowedPlayoutDelayMs(
                            videoStats.jitterBufferDelay,
                            videoStats.jitterBufferEmittedCount,
                            lastJitterDelayTotal,
                            lastJitterEmittedTotal
                        );
                        if (windowedDelayMs !== null) avgPlayoutDelayMs = windowedDelayMs;
                        lastJitterDelayTotal = videoStats.jitterBufferDelay;
                        lastJitterEmittedTotal = videoStats.jitterBufferEmittedCount;
                        // Accommodation feeds off the measured delay but only
                        // RAISES while late frames are actually being
                        // discarded (droppedDelta > 0) and the buffer has
                        // outgrown the base target — the measured delay
                        // otherwise just tracks the hint, and chasing it
                        // inflated every session to the cap. Sustained calm
                        // drains the extra latency back 50ms per tick.
                        if (droppedDelta > 0) {
                            accommodationCalmTicks = 0;
                        } else {
                            accommodationCalmTicks += 1;
                        }
                        accommodationTargetMs = bufferAccommodationMs(
                            avgPlayoutDelayMs, accommodationTargetMs,
                            baseBufferTargetMs(), droppedDelta > 0, accommodationCalmTicks);
                    }

                    const now = performance.now();
                    const bytes = videoStats.bytesReceived || 0;
                    let currentMbps = 0;

                    const timeDiffSec = (now - lastStatsTime) / 1000;
                    const decodedDiff = decoded - lastFramesDecodedCount;
                    const measuredFps = timeDiffSec > 0 && decodedDiff >= 0 ? decodedDiff / timeDiffSec : null;
                    const reportedFps = Number.isFinite(videoStats.framesPerSecond) ? videoStats.framesPerSecond : null;
                    currentFrameRate = reportedFps ?? measuredFps;

                    // Decode-pressure detection: packets arrive, packetsLost
                    // stays 0, yet decoded falls behind received — the viewer's
                    // decoder cannot sustain the stream (typically software
                    // AV1 at high resolution on a loaded machine). Sustained,
                    // it drives the supervisor's hardware-path switch.
                    const receivedDelta = received - lastFramesReceived;
                    if (timeDiffSec > 0.5 && receivedDelta >= 15) {
                        decodeLagSec = updateDecodeLag(decodeLagSec, decodedDiff, receivedDelta);
                    } else if (timeDiffSec > 0.5) {
                        decodeLagSec = decayDecodeLag(decodeLagSec);
                    }
                    lastFramesReceived = received;

                    if (lastStatsTime > 0 && timeDiffSec > 0 && bytes >= lastBytesReceived) {
                        currentMbps = Number((((bytes - lastBytesReceived) * 8) / timeDiffSec / 1_000_000).toFixed(1));
                        currentBitrateMbps = currentMbps;
                    }
                    renderStreamSummary('live');
                    lastBytesReceived = bytes;
                    lastFramesDecodedCount = decoded;
                    lastStatsTime = now;

                    // Push into rolling bitrate history and draw sparkline
                    bitrateHistory.shift();
                    bitrateHistory.push(currentMbps);
                    drawBitrateSparkline();
                }

                if (candidatePairStats && Number.isFinite(candidatePairStats.currentRoundTripTime)) {
                    const rttMs = Math.round(candidatePairStats.currentRoundTripTime * 1000);
                    hudLatency.innerText = `${rttMs} ms`;
                    if (streamRtt) streamRtt.textContent = `${rttMs} ms`;
                } else {
                    hudLatency.innerText = "-- ms";
                    if (streamRtt) streamRtt.textContent = 'Measuring connection';
                }

                // Route display: resolve the selected pair's candidate types so
                // the HUD (and the diagnostic export) shows whether media flows
                // DIRECT (host/srflx — hole punch worked) or through the TURN
                // RELAY (strict NAT fallback). This is the first thing to check
                // when a remote viewer reports stutter: a relayed path with
                // rising RTT explains almost every "it's laggy" report.
                if (candidatePairStats) {
                    const local = candidatePairStats.localId ? stats.get(candidatePairStats.localId) : null;
                    const remote = candidatePairStats.remoteId ? stats.get(candidatePairStats.remoteId) : null;
                    const types = [local && local.candidateType, remote && remote.candidateType];
                    lastRouteText = types.includes('relay')
                        ? 'relay (TURN)'
                        : (types.includes('srflx') || types.includes('prflx') ? 'direct (punched)' : 'direct (local)');
                    if (hudRoute) hudRoute.innerText = lastRouteText;
                } else if (hudRoute) {
                    hudRoute.innerText = '--';
                    lastRouteText = '--';
                }

                // Anti-stutter / live-edge supervision runs once per stats tick.
                superviseAdaptiveBuffer();

            } catch (err) {
                console.error("[WebRTC] Error reading WebRTC stats:", err);
            }
        }, 1000);
    }

    function stopTelemetry() {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
        currentBitrateMbps = null;
        currentFrameRate = null;
        renderStreamSummary('offline');
    }

    // Export Diagnostic Report to Clipboard
    if (hudCopyReportBtn) {
        hudCopyReportBtn.addEventListener('click', async () => {
            const report = {
                timestamp: new Date().toISOString(),
                connectionState: peerConnection ? peerConnection.connectionState : 'null',
                iceConnectionState: peerConnection ? peerConnection.iceConnectionState : 'null',
                iceRoute: lastRouteText,
                recovery: lastRecoveryCounts,
                renditionPath: activeStreamPath,
                player: {
                    paused: player.paused,
                    muted: player.muted,
                    volume: player.volume,
                    readyState: player.readyState,
                    currentTime: player.currentTime,
                    resolution: `${player.videoWidth}x${player.videoHeight}`
                },
                latencyMode: currentLatencyMode,
                bitrateHistory: bitrateHistory.slice(-10)
            };
            const jsonText = JSON.stringify(report, null, 2);
            try {
                await navigator.clipboard.writeText(jsonText);
                addSystemMessage("Diagnostic report copied to clipboard!");
                hudCopyReportBtn.innerHTML = '<i class="fa-solid fa-check"></i> Report Copied!';
                setTimeout(() => {
                    hudCopyReportBtn.innerHTML = '<i class="fa-solid fa-clipboard-check"></i> Copy Diagnostic Report';
                }, 1500);
            } catch (e) {
                console.error("[UI] Failed to copy diagnostic report:", e);
            }
        });
    }

    /* ==========================================================================
       Staged Freeze Detection Watchdog & Auto-Recovery (Zero False Positives)
       ========================================================================== */

    function ensureVideoFrameCallback() {
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype && !freezeWatchdogId && isConnected) {
            const onFrame = (now, metadata) => {
                lastFrameTime = now;
                // Cumulative presentation counter from the compositor — the
                // real "frames the viewer actually saw" number (decode ≠ render).
                if (metadata && Number.isFinite(metadata.presentedFrames)) {
                    lastPresentedFrames = metadata.presentedFrames;
                }
                frozenSince = 0;
                if (isConnected) {
                    freezeWatchdogId = player.requestVideoFrameCallback(onFrame);
                } else {
                    freezeWatchdogId = null;
                }
            };
            freezeWatchdogId = player.requestVideoFrameCallback(onFrame);
        }
    }

    function startFreezeWatchdog() {
        console.log("[FreezeGuard] Starting freeze watchdog...");
        frozenSince = 0;
        isRecovering = false;
        lastDecodedFrames = 0;
        lastBytesCount = 0;
        lastFrameTime = performance.now();

        ensureVideoFrameCallback();

        if (freezeCheckInterval) clearInterval(freezeCheckInterval);
        freezeCheckInterval = setInterval(async () => {
            // Skip all freeze detection while the user deliberately paused playback:
            // frames stop presenting and decode can suspend, which would read as a false stall.
            if (!isConnected || isRecovering || !peerConnection || player.paused || document.hidden) return;

            const now = performance.now();
            const frameStaleness = now - lastFrameTime;

            let currentDecoded = 0;
            let currentBytes = 0;
            try {
                const stats = await peerConnection.getStats();
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        currentDecoded = report.framesDecoded || 0;
                        currentBytes = report.bytesReceived || 0;
                    }
                });
            } catch (e) {
                return;
            }

            const decodedDelta = currentDecoded - lastDecodedFrames;
            const bytesDelta = currentBytes - lastBytesCount;
            lastDecodedFrames = currentDecoded;
            lastBytesCount = currentBytes;

            // Health counter recovery decay
            if (decodedDelta > 0) {
                healthyPlaybackSeconds += 1.5;
                if (healthyPlaybackSeconds > 15 && recoveryCount > 0) {
                    recoveryCount = Math.max(0, recoveryCount - 1);
                    healthyPlaybackSeconds = 0;
                    console.log("[FreezeGuard] Stream healthy. Decremented recovery count to:", recoveryCount);
                }
                if (healthyPlaybackSeconds > 15) {
                    reconnectAttempts = 0; // Stable session: future drops get fast 1s first-retry again
                    healthyPlaybackSeconds = 0;
                }
            }

            // Real Freeze Detection:
            // Frame is stale AND network packets ARE flowing (not just a static screen), but decoder is stalled!
            const isFrameStale = frameStaleness > FREEZE_THRESHOLD_MS;
            const isActualDecoderStall = bytesDelta > 5000 && decodedDelta === 0 && currentDecoded > 0;

            if (isFrameStale && isActualDecoderStall) {
                if (frozenSince === 0) {
                    frozenSince = now;
                    console.warn(`[FreezeGuard] Potential freeze detected. Staleness: ${Math.round(frameStaleness)}ms, bytesDelta: ${bytesDelta}.`);
                } else if (now - frozenSince > FREEZE_THRESHOLD_MS) {
                    console.error(`[FreezeGuard] CONFIRMED FREEZE for ${Math.round(now - frozenSince)}ms. Triggering staged recovery...`);
                    triggerFreezeRecovery('decoder_stall');
                }
            } else {
                if (frozenSince > 0) {
                    console.log("[FreezeGuard] Stream recovered naturally. Clearing freeze state.");
                    frozenSince = 0;
                }
            }
        }, 1500);

        player.onwaiting = () => {
            console.warn("[FreezeGuard] player.onwaiting fired (buffering).");
            if (stallTimeout) clearTimeout(stallTimeout);
            stallTimeout = setTimeout(() => {
                if (isConnected && !isRecovering && !player.paused && player.readyState < 3 && !document.hidden) {
                    console.error("[FreezeGuard] Player stuck in waiting/buffering for 4s. Triggering recovery.");
                    triggerFreezeRecovery('player_stalled');
                }
            }, 4000);
        };

        player.onplaying = () => {
            if (stallTimeout) {
                clearTimeout(stallTimeout);
                stallTimeout = null;
            }
            console.log("[FreezeGuard] player.onplaying — playback active.");
        };
    }

    function stopFreezeWatchdog() {
        console.log("[FreezeGuard] Stopping freeze watchdog.");
        if (freezeWatchdogId && 'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
            player.cancelVideoFrameCallback(freezeWatchdogId);
        }
        freezeWatchdogId = null;
        if (freezeCheckInterval) {
            clearInterval(freezeCheckInterval);
            freezeCheckInterval = null;
        }
        if (stallTimeout) {
            clearTimeout(stallTimeout);
            stallTimeout = null;
        }
        frozenSince = 0;
    }

    // Staged 3-Tier Auto-Recovery
    async function triggerFreezeRecovery(reason) {
        if (isRecovering) {
            console.log("[FreezeGuard] Recovery already in progress. Skipping.");
            return;
        }
        if (recoveryCount >= MAX_RECOVERIES) {
            console.error(`[FreezeGuard] Max recovery attempts (${MAX_RECOVERIES}) reached. Manual reload required.`);
            addSystemMessage("⚠️ Video freeze encountered. Please click Play or reload the page to refresh.");
            return;
        }

        isRecovering = true;
        recoveryCount++;
        frozenSince = 0;

        console.warn(`[FreezeGuard] === AUTO-RECOVERY #${recoveryCount} === Reason: ${reason}`);

        // STAGE 1: Playout Kick (try playing element directly)
        try {
            await player.play();
            lastFrameTime = performance.now();
            await new Promise(r => setTimeout(r, 150));
            if (player.readyState >= 3 && !player.paused) {
                console.log("[FreezeGuard] Stage 1 playout nudge resolved the pause!");
                isRecovering = false;
                ensureVideoFrameCallback();
                return;
            }
        } catch (e) {
            // Proceed to stage 2
        }

        // STAGE 2: Decoder Flush (re-bind tracks without breaking WHEP session)
        if (peerConnection && peerConnection.connectionState === 'connected') {
            try {
                console.log("[FreezeGuard] Attempting Stage 2 decoder flush...");
                const videoReceivers = peerConnection.getReceivers().filter(r => r.track && r.track.kind === 'video');
                if (videoReceivers.length > 0) {
                    const freshStream = new MediaStream();
                    peerConnection.getReceivers().forEach(r => {
                        if (r.track) freshStream.addTrack(r.track);
                    });
                    player.srcObject = freshStream;
                    await player.play();
                    lastFrameTime = performance.now();
                    isRecovering = false;
                    ensureVideoFrameCallback();
                    console.log("[FreezeGuard] Stage 2 decoder flush succeeded!");
                    return;
                }
            } catch (e) {
                console.warn("[FreezeGuard] Stage 2 flush did not resolve, proceeding to Stage 3:", e);
            }
        }

        // STAGE 3: Full WHEP Session Renewal
        addSystemMessage(`🔄 Auto-reconnecting video pipeline... (${recoveryCount}/${MAX_RECOVERIES})`);
        updateUIState('connecting');
        stopFreezeWatchdog();
        stopTelemetry();

        cleanupConnection();
        await new Promise(r => setTimeout(r, 200));

        isConnected = false;
        isConnecting = false;

        try {
            await connectStream();
        } catch (err) {
            console.error("[FreezeGuard] Recovery reconnection failed:", err);
            isRecovering = false;
            handleDisconnected();
            return;
        }

        setTimeout(() => {
            isRecovering = false;
            console.log("[FreezeGuard] Recovery cooldown complete. Watchdog active.");
        }, 3000);
    }

    /* ==========================================================================
       Player Controls, Gestures & Keyboard Shortcuts
       ========================================================================= */

    function flashActionFeedback(iconClass) {
        if (!actionFeedback) return;
        actionFeedback.innerHTML = `<i class="${iconClass}"></i>`;
        actionFeedback.classList.remove('active');
        void actionFeedback.offsetWidth; // Trigger reflow
        actionFeedback.classList.add('active');
    }

    function showVolumeToast(percent) {
        if (!volumeToast || !volumeToastText) return;
        volumeToastText.innerText = `${percent}%`;
        volumeToast.classList.remove('active');
        void volumeToast.offsetWidth;
        volumeToast.classList.add('active');
    }

    function unmutePlayer() {
        initAudioContext();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        player.muted = false;
        player.volume = 1.0;
        volumeSlider.value = 1;
        setMasterGain(1.0);
        if (player.paused) {
            player.play().catch(e => console.warn("[WebRTC] Play resume error on unmute:", e));
        }
        muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
        muteBtn.setAttribute('aria-pressed', 'false');
        if (volumeValueBadge) volumeValueBadge.innerText = '100%';
        unmuteOverlay.style.display = 'none';
        unmuteOverlay.setAttribute('aria-hidden', 'true');
        flashActionFeedback('fa-solid fa-volume-high');
        showVolumeToast(100);
    }

    unmuteBtn.addEventListener('click', unmutePlayer);

    // Keep the unmute prompt in sync with the element's mute state. Muting or
    // unmuting through the mute button, volume slider, wheel or arrow keys never
    // runs updateUIState(), so without this listener the "click to unmute"
    // prompt would stay on screen while audio is already playing (and vice
    // versa: muting during a live session must bring the prompt back).
    function syncUnmuteOverlay() {
        if (!unmuteOverlay) return;
        const show = player.muted && statusBadge.classList.contains('live');
        unmuteOverlay.style.display = show ? 'flex' : 'none';
        unmuteOverlay.setAttribute('aria-hidden', String(!show));
    }
    // Every programmatic and user-driven mute/volume change fires volumechange
    // on the media element, which covers all of those entry points at once.
    player.addEventListener('volumechange', syncUnmuteOverlay);

    function togglePlayPause() {
        initAudioContext();
        if (player.paused) {
            player.play().then(() => {
                flashActionFeedback('fa-solid fa-play');
            }).catch(e => console.warn("[WebRTC] Play promise rejected:", e));
        } else {
            player.pause();
            flashActionFeedback('fa-solid fa-pause');
        }
    }

    playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlayPause();
    });

    let clickDebounceTimeout = null;

    // Tap/Click on video container toggles Play/Pause or unmutes (debounced to avoid conflict with dblclick)
    videoContainer.addEventListener('click', (e) => {
        initAudioContext();

        // Ignore clicks on controls or HUD overlays
        if (e.target.closest('.player-controls') || e.target.closest('.telemetry-hud') || e.target.closest('.unmute-overlay')) {
            return;
        }

        if (clickDebounceTimeout) {
            clearTimeout(clickDebounceTimeout);
            clickDebounceTimeout = null;
            return; // Double-click detected
        }

        clickDebounceTimeout = setTimeout(() => {
            clickDebounceTimeout = null;
            if (player.muted) {
                unmutePlayer();
            } else {
                togglePlayPause();
            }
        }, 220);
    });

    // Double-click on video toggles fullscreen cleanly without stutter
    videoContainer.addEventListener('dblclick', (e) => {
        if (e.target.closest('.player-controls') || e.target.closest('.telemetry-hud') || e.target.closest('.unmute-overlay')) return;
        if (clickDebounceTimeout) {
            clearTimeout(clickDebounceTimeout);
            clickDebounceTimeout = null;
        }
        toggleFullscreen();
    });

    // Mute/Unmute toggle
    function toggleMute() {
        initAudioContext();
        if (player.muted) {
            player.muted = false;
            volumeSlider.value = 0.8;
            setMasterGain(0.8);
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
            muteBtn.setAttribute('aria-pressed', 'false');
            if (volumeValueBadge) volumeValueBadge.innerText = '80%';
            showVolumeToast(80);
        } else {
            player.muted = true;
            volumeSlider.value = 0;
            setMasterGain(0);
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            muteBtn.setAttribute('aria-pressed', 'true');
            if (volumeValueBadge) volumeValueBadge.innerText = '0%';
            showVolumeToast(0);
        }
    }

    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMute();
    });

    // Volume Slider
    volumeSlider.addEventListener('input', (e) => {
        initAudioContext();
        const val = parseFloat(e.target.value);
        setMasterGain(val);
        const percent = Math.round(val * 100);
        if (volumeValueBadge) volumeValueBadge.innerText = `${percent}%`;

        if (val === 0) {
            player.muted = true;
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            muteBtn.setAttribute('aria-pressed', 'true');
        } else {
            player.muted = false;
            muteBtn.setAttribute('aria-pressed', 'false');
            if (val < 0.4) {
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-low"></i>';
            } else {
                muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
            }
        }
    });

    // Volume Adjustment via Wheel over player
    videoContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        initAudioContext();
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        let newVol = Math.min(1, Math.max(0, parseFloat(volumeSlider.value) + delta));
        newVol = Math.round(newVol * 20) / 20; // 5% step snap
        volumeSlider.value = newVol;
        player.volume = newVol;
        setMasterGain(newVol);
        player.muted = (newVol === 0);

        const percent = Math.round(newVol * 100);
        if (volumeValueBadge) volumeValueBadge.innerText = `${percent}%`;
        showVolumeToast(percent);

        if (newVol === 0) {
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
            muteBtn.setAttribute('aria-pressed', 'true');
        } else if (newVol < 0.4) {
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-low"></i>';
            muteBtn.setAttribute('aria-pressed', 'false');
        } else {
            muteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
            muteBtn.setAttribute('aria-pressed', 'false');
        }
    }, { passive: false });

    // Latency Mode Selector Toggle
    if (latencyModeBtn) {
        latencyModeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const modes = ['ultra', 'balanced', 'smooth'];
            const nextIdx = (modes.indexOf(currentLatencyMode) + 1) % modes.length;
            currentLatencyMode = modes[nextIdx];
            const cfg = LATENCY_MODES[currentLatencyMode];

            latencyModeBtn.title = `Latency Buffer: ${cfg.label}`;
            latencyModeBtn.innerHTML = `<i class="fa-solid ${cfg.icon}"></i>`;
            addSystemMessage(`Latency mode switched to: ${cfg.label}`);
            // Remember the explicit choice so the next visit starts here and the
            // low-core auto heuristic can never override a human decision.
            try { localStorage.setItem('rydius_latency_mode', currentLatencyMode); } catch (err) {}

            // A manual mode selection resets the adaptive raise and the
            // accommodation, then the button's own target applies at once.
            adaptiveRaiseUntil = 0;
            accommodationTargetMs = 0;
            accommodationCalmTicks = 0;
            bufferNoticeState = '';
            lastAppliedTargetMs = null;
            updateBufferHud(null);

            // Apply immediately to active receivers
            if (peerConnection) {
                peerConnection.getReceivers().forEach(r => {
                    applyPlayoutDelay(r, r.track ? r.track.kind : 'media');
                });
                lastAppliedTargetMs = currentBufferTargetMs();
            }
        });

        // Paint the loaded/persisted mode onto the button once at startup so it
        // never shows the HTML default icon when the visitor chose another mode.
        const bootLatencyCfg = LATENCY_MODES[currentLatencyMode];
        latencyModeBtn.title = `Latency Buffer: ${bootLatencyCfg.label}`;
        latencyModeBtn.innerHTML = `<i class="fa-solid ${bootLatencyCfg.icon}"></i>`;
    }

    // Picture in Picture Toggle (Cross-Browser including Safari iOS)
    function togglePiP() {
        if (document.pictureInPictureElement) {
            if (document.exitPictureInPicture) {
                document.exitPictureInPicture().catch(e => console.warn("[UI] Exit PiP error:", e));
            }
        } else if (player.requestPictureInPicture) {
            player.requestPictureInPicture().catch(e => console.warn("[UI] PiP error:", e));
        } else if (player.webkitSetPresentationMode) {
            const currentMode = player.webkitPresentationMode;
            player.webkitSetPresentationMode(currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        }
    }

    if (pipBtn) {
        pipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePiP();
        });
    }

    // Theatre Mode Toggle
    function toggleTheatre() {
        if (!appContainer) return;
        appContainer.classList.toggle('theatre-mode');
        const isTheatre = appContainer.classList.contains('theatre-mode');
        if (theatreBtn) {
            theatreBtn.classList.toggle('active', isTheatre);
            theatreBtn.setAttribute('aria-pressed', String(isTheatre));
            theatreBtn.title = isTheatre ? "Standard Mode (T)" : "Theatre Mode (T)";
        }
    }

    if (theatreBtn) {
        theatreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTheatre();
        });
    }

    // Fullscreen Toggle (Cross-Browser including iPhone Safari)
    function toggleFullscreen() {
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (!isFs) {
            if (videoContainer.requestFullscreen) {
                videoContainer.requestFullscreen().catch(err => {
                    console.error(`[UI] Error attempting to enable fullscreen: ${err.message}`);
                });
            } else if (videoContainer.webkitRequestFullscreen) {
                videoContainer.webkitRequestFullscreen();
            } else if (player.webkitEnterFullscreen) {
                player.webkitEnterFullscreen();
            }
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-minimize"></i>';
            fullscreenBtn.setAttribute('aria-pressed', 'true');
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(err => {
                    console.error(`[UI] Error attempting to exit fullscreen: ${err.message}`);
                });
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            fullscreenBtn.setAttribute('aria-pressed', 'false');
        }
    }

    fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen();
    });

    const onFullscreenChange = () => {
        const isFs = document.fullscreenElement || document.webkitFullscreenElement;
        if (!isFs) {
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            fullscreenBtn.setAttribute('aria-pressed', 'false');
        } else {
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-minimize"></i>';
            fullscreenBtn.setAttribute('aria-pressed', 'true');
        }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    // Entering/leaving fullscreen must (re)arm the fade timer: with no mouse
    // attached there may be no pointer event to arm it, and the bar would
    // otherwise keep whatever visibility state it had from before.
    document.addEventListener('fullscreenchange', () => resetControlsTimer('fullscreenchange'));
    document.addEventListener('webkitfullscreenchange', () => resetControlsTimer('fullscreenchange'));
    // Window focus churn (Alt+Tab away and back) re-arms the check too, so the
    // guards are re-evaluated whenever the user returns to this window.
    window.addEventListener('blur', () => resetControlsTimer('window-blur'));
    window.addEventListener('focus', () => resetControlsTimer('window-focus'));

    // Telemetry HUD Toggle
    statsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const show = telemetryHud.style.display === 'block';
        telemetryHud.style.display = show ? 'none' : 'block';
        telemetryHud.setAttribute('aria-hidden', String(show));
        statsBtn.classList.toggle('active', !show);
        statsBtn.setAttribute('aria-pressed', String(!show));
        if (!show) {
            drawBitrateSparkline();
            startAudioMeter();
        } else {
            stopAudioMeter();
        }
    });

    hudCloseBtn.addEventListener('click', () => {
        telemetryHud.style.display = 'none';
        telemetryHud.setAttribute('aria-hidden', 'true');
        statsBtn.classList.remove('active');
        statsBtn.setAttribute('aria-pressed', 'false');
        stopAudioMeter();
    });

    // Reduce decorative effects for a simpler, lower-motion display.
    if (perfToggleBtn) {
        perfToggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('perf-mode');
            const isPerf = document.body.classList.contains('perf-mode');
            perfToggleBtn.classList.toggle('active', isPerf);
            perfToggleBtn.setAttribute('aria-pressed', String(isPerf));
            if (perfToggleLabel) {
                perfToggleLabel.innerText = isPerf ? 'Eco Mode' : 'Turbo GPU';
            }
            // Persist the manual choice so the low-end auto heuristic never overrides it
            try { localStorage.setItem('rydius_perf_mode', isPerf ? '1' : '0'); } catch (e) {}
            addSystemMessage(isPerf ? "Eco Mode enabled (GPU optimized)" : "Turbo GPU enabled (Full visual fidelity)");
        });

        // Auto-enable perf mode on low-core devices unless the user has made a manual choice:
        // blurred ambient orbs + animated noise steal GPU from 4K60 decode and cause dropped frames.
        let storedPerfChoice = null;
        try { storedPerfChoice = localStorage.getItem('rydius_perf_mode'); } catch (e) {}
        const cpuCores = navigator.hardwareConcurrency || 8;
        if (storedPerfChoice === null && cpuCores <= 4 && !document.body.classList.contains('perf-mode')) {
            document.body.classList.add('perf-mode');
            perfToggleBtn.classList.add('active');
            perfToggleBtn.setAttribute('aria-pressed', 'true');
            if (perfToggleLabel) perfToggleLabel.innerText = 'Eco Mode';
            console.log(`[UI] Low-end device detected (${cpuCores} CPU cores). Performance mode auto-enabled.`);
        }
    }

    // Controls Auto-Hide Management (fade after 2.5s of human inactivity).
    // Only genuine input re-shows the bar: media lifecycle events (play/pause
    // storms from a hiccuping stream) and focus flicker must never cancel a
    // pending fade, or the bar stays up forever while the viewer sits still —
    // exactly the bug seen in the field, where only Alt+Tab (which froze the
    // event storm) ever let the timer fire.
    let controlsArmedAt = 0;
    let controlsArmStreak = 0;

    // Cursor hiding enforced from JS too: an inline !important on <html>
    // cannot lose to any stylesheet cascade. The pure-CSS rule reported
    // cursor=pointer at getComputedStyle despite being the highest-priority
    // rule in the file, so the cursor state must not depend on :fullscreen
    // matching — this toggle covers it unconditionally.
    function applyCursorState() {
        const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const hide = inFs && !videoContainer.classList.contains('controls-active');
        document.documentElement.style.setProperty('cursor', hide ? 'none' : '', 'important');
    }

    function resetControlsTimer(source = 'unknown') {
        videoContainer.classList.add('controls-active');
        applyCursorState();
        if (controlsHideTimeout) {
            const lived = Date.now() - controlsArmedAt;
            controlsArmStreak += 1;
            // Late or endless cancellations mean some input source keeps
            // firing while the user believes they are idle — name it.
            if (lived > 1200 || controlsArmStreak >= 8) {
                console.warn(`[Controls] fade cancelled by ${source} (streak ${controlsArmStreak}, lived ${lived}ms)`);
            }
            clearTimeout(controlsHideTimeout);
        } else {
            controlsArmStreak = 0;
        }
        controlsArmedAt = Date.now();
        controlsHideTimeout = setTimeout(() => {
            controlsHideTimeout = null;
            controlsArmStreak = 0;
            const inFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
            // In fullscreen NOTHING may block the fade: a stale focus or an
            // open HUD pinned the bar in earlier builds. Keyboard access
            // survives because every keypress re-shows the bar for another
            // 2.5 s; windowed mode still keeps it up while paused so the play
            // button stays obvious. hud/focus are logged as diagnostics only.
            if (!player.paused || inFullscreen) {
                videoContainer.classList.remove('controls-active');
                applyCursorState();
                // Log the CSS verdict too: cursor=none proves the fullscreen
                // cursor rule matched; anything else means either we are not
                // actually in API fullscreen (fullscreen=false) or some rule
                // overrides it (cursor=pointer) — one line settles all three.
                const cursorNow = getComputedStyle(videoContainer).cursor;
                console.log(`[Controls] faded out (fullscreen=${inFullscreen}, paused=${player.paused}, cursor=${cursorNow})`);
            } else {
                console.warn('[Controls] fade skipped:', JSON.stringify({
                    paused: player.paused,
                    fullscreen: inFullscreen,
                    hudOpen: telemetryHud.style.display === 'block',
                    focus: videoContainer.contains(document.activeElement)
                        ? (document.activeElement.id || document.activeElement.tagName)
                        : null
                }));
            }
        }, 2500);
    }

    videoContainer.addEventListener('mousemove', (event) => {
        // Jitter filter: the pointer must travel at least POINTER_ACTIVATE_PX
        // from the last position that counted before the bar (re)shows —
        // otherwise tiny twitches from a resting hand would keep it up
        // forever. The anchor advances only on qualifying moves, so slow
        // continuous dragging still keeps the bar visible as usual.
        if (controlsAnchorX !== null
            && Math.hypot(event.clientX - controlsAnchorX, event.clientY - controlsAnchorY) < POINTER_ACTIVATE_PX) {
            return;
        }
        controlsAnchorX = event.clientX;
        controlsAnchorY = event.clientY;
        resetControlsTimer('mousemove');
    });
    // Touch/pointer users produce no mousemove: a tap must re-show the bar too,
    // otherwise fullscreen would hide it with no way to bring it back.
    videoContainer.addEventListener('pointerdown', () => resetControlsTimer('pointerdown'));
    videoContainer.addEventListener('touchstart', () => resetControlsTimer('touchstart'), { passive: true });
    videoContainer.addEventListener('mouseleave', () => {
        if (!player.paused && telemetryHud.style.display !== 'block' && !videoContainer.contains(document.activeElement)) {
            videoContainer.classList.remove('controls-active');
            applyCursorState();
        }
    });

    // NOTE: play/pause lifecycle events deliberately do NOT re-arm the fade —
    // a hiccuping stream fires them in storms, which kept the bar up forever
    // while the viewer sat still. User-initiated play/pause always arrives
    // via a click or keypress, which re-arm on their own.

    // A pointer click anywhere in the player (fullscreen button, unmute
    // overlay, volume slider, ...) leaves focus on that element, and the hide
    // guard would then pin the controls open forever. Release focus after
    // pointer clicks only — keyboard activation fires with detail 0 and keeps
    // focus, so tab navigation stays accessible.
    videoContainer.addEventListener('click', (event) => {
        if (event.detail === 0) return;
        if (videoContainer.contains(document.activeElement)) {
            document.activeElement.blur();
        }
    });

    // Comprehensive Keyboard Shortcuts (YouTube / Twitch standard)
    document.addEventListener('keydown', (e) => {
        // OS auto-repeat of a held (or stuck) key fires ~30 times/second and
        // must never count as activity — it would re-arm the fade forever.
        if (e.repeat) return;
        // Any key press is activity: re-show the controls so keyboard-only
        // users (or a machine with no mouse attached) can always bring the
        // bar back before it fades again.
        resetControlsTimer('keydown');
        // Do not intercept if browser modifier shortcuts are held (e.g. Ctrl+T, Ctrl+F, Alt+Tab, Cmd+P)
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // Leave native editing and control-key behavior alone.
        if (e.target.isContentEditable || e.target.closest('input, textarea, select, button, a, [role="textbox"]')) return;

        switch (e.key.toLowerCase()) {
            case ' ':
            case 'k':
                e.preventDefault();
                togglePlayPause();
                break;
            case 'm':
                e.preventDefault();
                toggleMute();
                break;
            case 'f':
                e.preventDefault();
                toggleFullscreen();
                break;
            case 't':
                e.preventDefault();
                toggleTheatre();
                break;
            case 'p':
                e.preventDefault();
                togglePiP();
                break;
            case 's':
                e.preventDefault();
                statsBtn.click();
                break;
            case 'arrowup':
                e.preventDefault();
                {
                    const newVol = Math.min(1, parseFloat(volumeSlider.value) + 0.05);
                    volumeSlider.value = newVol;
                    setMasterGain(newVol);
                    player.muted = false;
                    muteBtn.setAttribute('aria-pressed', 'false');
                    muteBtn.innerHTML = newVol < 0.4 ? '<i class="fa-solid fa-volume-low"></i>' : '<i class="fa-solid fa-volume-high"></i>';
                    const pct = Math.round(newVol * 100);
                    if (volumeValueBadge) volumeValueBadge.innerText = `${pct}%`;
                    showVolumeToast(pct);
                }
                break;
            case 'arrowdown':
                e.preventDefault();
                {
                    const newVol = Math.max(0, parseFloat(volumeSlider.value) - 0.05);
                    volumeSlider.value = newVol;
                    setMasterGain(newVol);
                    player.muted = (newVol === 0);
                    muteBtn.setAttribute('aria-pressed', String(newVol === 0));
                    muteBtn.innerHTML = newVol === 0 ? '<i class="fa-solid fa-volume-xmark"></i>' : (newVol < 0.4 ? '<i class="fa-solid fa-volume-low"></i>' : '<i class="fa-solid fa-volume-high"></i>');
                    const pct = Math.round(newVol * 100);
                    if (volumeValueBadge) volumeValueBadge.innerText = `${pct}%`;
                    showVolumeToast(pct);
                }
                break;
            case 'c':
                e.preventDefault();
                if (tabChat && !tabChat.classList.contains('active')) {
                    tabChat.click();
                }
                if (chatInput) {
                    setTimeout(() => chatInput.focus(), 50);
                }
                break;
        }
    });

    /* ==========================================================================
       Interactive Reactions (Floating Emojis & Button Bursts)
       ========================================================================== */

    const myClientId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

    const reactionEmojiMap = {
        heart: '❤️',
        fire: '🔥',
        clap: '👏',
        laugh: '😂',
        thumbs: '👍'
    };

    function spawnButtonBurst(btn, emojiChar) {
        if (!btn) return;
        const createOne = (extraDelay = 0) => {
            const burst = document.createElement('div');
            burst.className = 'btn-burst-emoji';
            burst.innerText = emojiChar;
            const driftX = (Math.random() * 64 - 32).toFixed(1) + 'px';
            const rot = (Math.random() * 32 - 16).toFixed(1) + 'deg';
            burst.style.setProperty('--burst-drift-x', driftX);
            burst.style.setProperty('--burst-rot', rot);
            if (extraDelay > 0) {
                burst.style.animationDelay = `${extraDelay}ms`;
            }
            btn.appendChild(burst);
            setTimeout(() => {
                if (burst.parentNode) burst.remove();
            }, 1900 + extraDelay);
        };

        createOne(0);
        setTimeout(() => createOne(0), 85);
    }

    function triggerButtonPop(btn) {
        if (!btn) return;
        btn.classList.remove('btn-popping');
        void btn.offsetWidth;
        btn.classList.add('btn-popping');
        const countEl = btn.querySelector('.emoji-count');
        if (countEl) {
            countEl.classList.remove('count-bump');
            void countEl.offsetWidth;
            countEl.classList.add('count-bump');
            setTimeout(() => countEl.classList.remove('count-bump'), 320);
        }
    }

    document.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            initAudioContext();
            const emojiType = btn.getAttribute('data-emoji');
            const emojiChar = reactionEmojiMap[emojiType];
            if (!emojiChar) return;
            
            // 1. Tactile button bounce & burst particle right from the button
            triggerButtonPop(btn);
            spawnButtonBurst(btn, emojiChar);

            // 2. Floating emoji floating up across the video player
            spawnFloatingEmoji(emojiChar);

            // 3. Immediate local count increment
            const countEl = btn.querySelector('.emoji-count');
            if (countEl) {
                const current = parseInt(countEl.innerText || '0', 10);
                countEl.innerText = String(current + 1);
            }

            // 4. Subtle mobile haptic feedback if supported
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate(15); } catch (_) {}
            }

            // 5. Sound effect
            playSfx('pop');

            // 6. Broadcast to all other viewers via server SSE
            fetch(window.location.origin + '/stream-api/chat/reactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji: emojiType, clientId: myClientId })
            }).catch(() => {});
        });
    });

    function spawnFloatingEmoji(emojiChar) {
        if (!videoContainer) return;
        const floating = document.createElement('div');
        floating.className = 'flying-emoji';
        floating.innerText = emojiChar;
        
        const width = videoContainer.clientWidth || 320;
        const randomX = Math.floor(Math.random() * Math.max(40, width - 80)) + 30;
        const swayX = (Math.random() * 60 - 30).toFixed(1) + 'px';
        const swayRot = (Math.random() * 24 - 12).toFixed(1) + 'deg';
        
        floating.style.left = `${randomX}px`;
        floating.style.setProperty('--sway-x', swayX);
        floating.style.setProperty('--sway-rot', swayRot);
        
        videoContainer.appendChild(floating);
        
        setTimeout(() => {
            if (floating.parentNode) {
                floating.remove();
            }
        }, 2200);
    }

    /* ==========================================================================
       Chat & Sidebar Management
       ========================================================================== */

    const tabIndicator = document.querySelector('.tab-indicator');

    function activateSidebarTab(tab) {
        const showActivity = tab === tabChat;
        tabChat.classList.toggle('active', showActivity);
        tabInfo.classList.toggle('active', !showActivity);
        tabChat.setAttribute('aria-selected', String(showActivity));
        tabInfo.setAttribute('aria-selected', String(!showActivity));
        tabChat.tabIndex = showActivity ? 0 : -1;
        tabInfo.tabIndex = showActivity ? -1 : 0;
        contentChat.classList.toggle('active', showActivity);
        contentInfo.classList.toggle('active', !showActivity);
        contentChat.setAttribute('aria-hidden', String(!showActivity));
        contentInfo.setAttribute('aria-hidden', String(showActivity));
        if (tabIndicator) tabIndicator.style.transform = showActivity ? 'translate3d(0%, 0, 0)' : 'translate3d(100%, 0, 0)';
    }

    tabChat.addEventListener('click', () => activateSidebarTab(tabChat));
    tabInfo.addEventListener('click', () => activateSidebarTab(tabInfo));
    [tabChat, tabInfo].forEach((tab) => {
        tab.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nextTab = event.key === 'Home' || event.key === 'ArrowLeft' ? tabChat : tabInfo;
            activateSidebarTab(nextTab);
            nextTab.focus();
        });
    });

    if (ingestTabWhip && ingestTabSrt) {
        ingestTabWhip.addEventListener('click', () => {
            ingestTabWhip.classList.add('active');
            ingestTabSrt.classList.remove('active');
            instructionsWhip.classList.add('active');
            instructionsSrt.classList.remove('active');
        });

        ingestTabSrt.addEventListener('click', () => {
            ingestTabSrt.classList.add('active');
            ingestTabWhip.classList.remove('active');
            instructionsSrt.classList.add('active');
            instructionsWhip.classList.remove('active');
        });
    }

    // Toggle Audio Feedback
    if (soundToggleBtn) {
        soundToggleBtn.addEventListener('click', () => {
            initAudioContext();
            soundEnabled = !soundEnabled;
            soundToggleBtn.classList.toggle('active', soundEnabled);
            soundToggleBtn.setAttribute('aria-pressed', String(soundEnabled));
            soundToggleBtn.innerHTML = soundEnabled ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-xmark"></i>';
            addSystemMessage(soundEnabled ? "Interface sounds enabled" : "Interface sounds muted");
        });
    }

    // Copy to Clipboard Utility
    document.querySelectorAll('.copyable-text').forEach(elem => {
        elem.addEventListener('click', async () => {
            const textToCopy = elem.innerText.trim();
            try {
                await navigator.clipboard.writeText(textToCopy);
                const originalBg = elem.style.backgroundColor;
                const originalColor = elem.style.color;
                
                elem.style.backgroundColor = 'var(--cyan-dim)';
                elem.style.color = 'var(--cyan)';
                
                addSystemMessage(`Copied to clipboard: "${textToCopy.substring(0, 30)}${textToCopy.length > 30 ? '...' : ''}"`);
                
                setTimeout(() => {
                    elem.style.backgroundColor = originalBg;
                    elem.style.color = originalColor;
                }, 1000);
            } catch (err) {
                console.error("[UI] Clipboard copy failed:", err);
            }
        });
    });

    // Realtime Live Chat State
    let isHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    let userNick = isHost ? 'Host' : 'Viewer';
    let userBadge = isHost ? 'HOST' : 'USER';
    let hasCustomNick = false;

    try {
        const savedNick = localStorage.getItem('rydius_stream_nick');
        if (savedNick && savedNick.trim()) {
            userNick = savedNick.trim();
            hasCustomNick = true;
        } else if (!isHost) {
            userNick = 'Viewer ' + Math.floor(100 + Math.random() * 900);
        }
    } catch (_) {}

    function updateNickDisplay() {
        if (chatNickDisplay) {
            chatNickDisplay.textContent = userNick;
        }
    }
    updateNickDisplay();

    if (chatNickBtn) {
        chatNickBtn.addEventListener('click', () => {
            const promptMsg = isHost ? 'Enter your host display name:' : 'Enter your chat nickname:';
            const entered = window.prompt(promptMsg, userNick);
            if (entered !== null) {
                const clean = entered.trim();
                if (clean.length > 0 && clean.length <= 25) {
                    userNick = clean;
                    hasCustomNick = true;
                    try {
                        localStorage.setItem('rydius_stream_nick', userNick);
                    } catch (_) {}
                    updateNickDisplay();
                    addSystemMessage(`Nickname updated to "${userNick}"`);
                } else if (clean.length > 25) {
                    addSystemMessage('Nickname must be 25 characters or fewer.');
                }
            }
        });
    }

    const seenMessageIds = new Set();
    const seenClientMsgIds = new Set();
    let lastReceivedMessageId = 0;
    let chatSource = null;
    let fallbackPollTimer = null;

    function handleSlashCommand(cmdStr) {
        const parts = cmdStr.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ').trim();

        if (cmd === '/nick' || cmd === '/name') {
            if (!arg) {
                addSystemMessage('Usage: /nick <new_name>');
                return;
            }
            if (arg.length > 25) {
                addSystemMessage('Nickname must be 25 characters or fewer.');
                return;
            }
            userNick = arg;
            hasCustomNick = true;
            try {
                localStorage.setItem('rydius_stream_nick', userNick);
            } catch (_) {}
            updateNickDisplay();
            addSystemMessage(`Nickname updated to "${userNick}"`);
            playSfx('pop');
        } else if (cmd === '/clear') {
            chatMessages.innerHTML = '';
            addSystemMessage('Chat cleared locally.');
        } else if (cmd === '/help') {
            addSystemMessage('Commands: /nick <name>, /clear');
        } else {
            addSystemMessage(`Unknown command: ${cmd}. Type /help for commands.`);
        }
    }

    // Connected-viewer count. The server tracks one SSE subscription per open
    // page and broadcasts a `viewers` event on every join/leave; until now the
    // header counter kept a permanent "—" because nothing listened for it.
    function updateViewerCount(count) {
        if (!viewerNum || !Number.isFinite(count) || count < 1) return;
        viewerNum.innerText = String(count);
        viewerNum.setAttribute('aria-label', `${count} viewer${count === 1 ? '' : 's'} connected`);
    }

    function handleIncomingMessage(msg, isHistory = false) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.id) {
            if (seenMessageIds.has(msg.id)) return;
            seenMessageIds.add(msg.id);
            if (msg.id > lastReceivedMessageId) {
                lastReceivedMessageId = msg.id;
            }
            // Long sessions grow this set without bound; 500 ids cover far
            // beyond the server's 100-message history window, so dropping the
            // oldest entries can never resurrect a delivered message.
            if (seenMessageIds.size > 500) {
                const oldest = seenMessageIds.values().next().value;
                seenMessageIds.delete(oldest);
            }
        }
        if (msg.clientMsgId && seenClientMsgIds.has(msg.clientMsgId)) {
            return;
        }
        if (msg.clientMsgId) {
            seenClientMsgIds.add(msg.clientMsgId);
            if (seenClientMsgIds.size > 500) {
                const oldest = seenClientMsgIds.values().next().value;
                seenClientMsgIds.delete(oldest);
            }
        }

        if (activityEmpty) {
            activityEmpty.style.display = 'none';
        }

        const isSelf = Boolean(msg.clientId && msg.clientId === myClientId);
        addMessage(msg.author || 'Viewer', msg.text, isSelf, msg.badge || 'USER', msg.time);

        if (!isSelf && !isHistory) {
            playSfx('pop');
        }
    }

    function connectChatEvents() {
        if (chatSource) {
            chatSource.close();
            chatSource = null;
        }

        const url = window.location.origin + '/stream-api/chat/events' + (lastReceivedMessageId > 0 ? `?lastId=${lastReceivedMessageId}` : '');
        try {
            chatSource = new EventSource(url);
        } catch (e) {
            console.warn('[Chat] EventSource failed, using fallback polling:', e);
            startPollingFallback();
            return;
        }

        chatSource.addEventListener('init', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.isHost) {
                    isHost = true;
                    userBadge = 'HOST';
                    if (!hasCustomNick) {
                        userNick = 'Host';
                        updateNickDisplay();
                    }
                }
                if (Array.isArray(data.history)) {
                    data.history.forEach((m) => handleIncomingMessage(m, true));
                }
                if (data.reactionCounts) {
                    for (const [emojiKey, count] of Object.entries(data.reactionCounts)) {
                        const countEl = document.getElementById(`count-${emojiKey}`);
                        if (countEl && count > 0) {
                            countEl.innerText = String(count);
                        }
                    }
                }
                // Live viewer count: server sends it on connect (and on every
                // join/leave below) — self count included, so at least 1.
                if (data.subscriberCount) {
                    updateViewerCount(data.subscriberCount);
                }
                if (fallbackPollTimer) {
                    clearInterval(fallbackPollTimer);
                    fallbackPollTimer = null;
                }
            } catch (err) {
                console.warn('[Chat] Failed to parse init event:', err);
            }
        });

        // Real-time viewer counter updates broadcast by server.js whenever a
        // page opens or closes its SSE subscription.
        chatSource.addEventListener('viewers', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateViewerCount(data.count);
            } catch (_) {}
        });

        chatSource.addEventListener('message', (e) => {
            try {
                const msg = JSON.parse(e.data);
                handleIncomingMessage(msg, false);
            } catch (err) {
                console.warn('[Chat] Failed to parse message event:', err);
            }
        });

        chatSource.addEventListener('reaction', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.emoji && reactionEmojiMap[data.emoji]) {
                    if (data.clientId !== myClientId) {
                        const emojiChar = reactionEmojiMap[data.emoji];
                        spawnFloatingEmoji(emojiChar);
                        const targetBtn = document.querySelector(`.emoji-btn[data-emoji="${data.emoji}"]`);
                        if (targetBtn) {
                            triggerButtonPop(targetBtn);
                            spawnButtonBurst(targetBtn, emojiChar);
                        }
                        const countEl = document.getElementById(`count-${data.emoji}`);
                        if (countEl) {
                            const cur = parseInt(countEl.innerText || '0', 10);
                            countEl.innerText = String(data.totalCount || (cur + 1));
                            countEl.classList.remove('count-bump');
                            void countEl.offsetWidth;
                            countEl.classList.add('count-bump');
                            setTimeout(() => countEl.classList.remove('count-bump'), 320);
                        }
                        playSfx('pop');
                    }
                }
            } catch (_) {}
        });

        chatSource.addEventListener('error', () => {
            startPollingFallback();
        });
    }

    function startPollingFallback() {
        if (fallbackPollTimer) return;
        fallbackPollTimer = setInterval(async () => {
            try {
                const res = await fetch(window.location.origin + `/stream-api/chat/messages?since=${lastReceivedMessageId}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.ok && Array.isArray(data.messages)) {
                        data.messages.forEach((m) => handleIncomingMessage(m, false));
                    }
                }
            } catch (_) {}
        }, 3000);
    }

    connectChatEvents();

    // Send Message
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        initAudioContext();
        const text = chatInput.value.trim();
        if (!text) return;

        if (text.startsWith('/')) {
            handleSlashCommand(text);
            chatInput.value = '';
            return;
        }

        const clientMsgId = 'm_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        seenClientMsgIds.add(clientMsgId);

        if (activityEmpty) {
            activityEmpty.style.display = 'none';
        }

        addMessage(userNick, text, true, userBadge);
        chatInput.value = '';
        playSfx('pop');

        try {
            const resp = await fetch(window.location.origin + '/stream-api/chat/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    author: userNick,
                    badge: userBadge,
                    clientId: myClientId,
                    clientMsgId
                })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                addSystemMessage(err.error || `Failed to deliver message (${resp.status})`);
            }
        } catch (err) {
            console.error('[Chat] Failed to send message:', err);
            addSystemMessage('Network error: message may not have been delivered.');
        }
    });

    function addMessage(author, body, isSelf, badge = 'USER', timeStr = null) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg ${isSelf ? 'self' : ''}`;

        const headerDiv = document.createElement('div');
        headerDiv.className = 'msg-header';
        
        const authorSpan = document.createElement('span');
        authorSpan.className = 'msg-author';
        authorSpan.innerText = author;

        if (badge) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = `author-badge badge-${badge.toLowerCase()}`;
            badgeSpan.innerText = badge;
            authorSpan.appendChild(badgeSpan);
        }

        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        const dateObj = timeStr ? new Date(timeStr) : new Date();
        const hours = isNaN(dateObj.getTime()) ? '00' : dateObj.getHours().toString().padStart(2, '0');
        const mins = isNaN(dateObj.getTime()) ? '00' : dateObj.getMinutes().toString().padStart(2, '0');
        timeSpan.innerText = `${hours}:${mins}`;

        headerDiv.appendChild(authorSpan);
        headerDiv.appendChild(timeSpan);

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'msg-body';
        bodyDiv.innerText = body;

        msgDiv.appendChild(headerDiv);
        msgDiv.appendChild(bodyDiv);

        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Prune older chat messages to prevent unbounded DOM memory growth
        while (chatMessages.children.length > 100) {
            chatMessages.removeChild(chatMessages.firstChild);
        }
    }

    function addSystemMessage(text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg system';
        
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'msg-body';
        bodyDiv.innerText = text;
        
        msgDiv.appendChild(bodyDiv);
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Prune older messages to prevent unbounded DOM memory growth
        while (chatMessages.children.length > 100) {
            chatMessages.removeChild(chatMessages.firstChild);
        }
    }

    // Reconnect immediately when the browser reports the network came back (wifi drop, airplane mode toggle)
    window.addEventListener('online', () => {
        console.log("[Network] Browser reports connectivity restored. Probing stream immediately.");
        addSystemMessage("Network restored. Reconnecting...");
        reconnectAttempts = 0;
        if (!isConnected && !isConnecting) {
            if (streamActiveCheckTimeout) {
                clearTimeout(streamActiveCheckTimeout);
                streamActiveCheckTimeout = null;
            }
            pollStreamStatus();
        }
    });

    window.addEventListener('offline', () => {
        console.warn("[Network] Browser reports connectivity lost.");
        addSystemMessage("Network connection lost. Waiting to reconnect...");
        if (streamActiveCheckTimeout) {
            clearTimeout(streamActiveCheckTimeout);
            streamActiveCheckTimeout = null;
        }
    });

    // Network interface switch (wifi -> hotspot, hotspot band change, ...):
    // without this handler the session limps until ICE itself notices (2.5s
    // grace + failure detection), leaving seconds of frozen video. The
    // NetworkInformation 'change' event also fires for mere bandwidth
    // estimate updates, so only an actual interface TYPE change acts — and a
    // connected session is torn down through the normal disconnect path,
    // which lands on the fast 1s reconnect ladder immediately.
    let lastNetworkType = null;
    if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
        lastNetworkType = navigator.connection.type || null;
        navigator.connection.addEventListener('change', () => {
            const newType = navigator.connection.type || null;
            const typeChanged = lastNetworkType !== newType;
            lastNetworkType = newType;
            if (!typeChanged) return;
            console.log("[Network] Interface type changed to", newType, "- re-establishing the session promptly.");
            if (isConnected) {
                handleDisconnected();
            } else if (!isConnecting) {
                if (streamActiveCheckTimeout) {
                    clearTimeout(streamActiveCheckTimeout);
                    streamActiveCheckTimeout = null;
                }
                pollStreamStatus();
            }
        });
    }

    /* ==========================================================================
       Startup — no access gate; the unlisted URL itself is the only credential
       ========================================================================== */

    function initApp() {
        console.log("[App] Launching telemetry and connection sequence...");
        addSystemMessage("Connecting to signaling server...");
        // Warm the ICE config in parallel with the first status poll so a
        // live stream's first handshake skips one round trip.
        prefetchIceServers();
        pollStreamStatus();
    }

    // No authentication: the player starts immediately on page load.
    initApp();

    // Unconditional AudioContext unlock on user gesture anywhere on screen
    const unlockAudio = () => {
        initAudioContext();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log("[Audio] AudioContext unlocked via user interaction.");
                window.removeEventListener('pointerdown', unlockAudio);
                window.removeEventListener('keydown', unlockAudio);
            }).catch(() => {});
        } else if (audioCtx && audioCtx.state === 'running') {
            window.removeEventListener('pointerdown', unlockAudio);
            window.removeEventListener('keydown', unlockAudio);
        }
    };
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
});
