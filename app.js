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

    // Ask the media pipeline to preserve picture detail. The default is
    // 'balanced', which lets Chrome trade RESOLUTION away when it decides the
    // viewer is under resource pressure — for a live stream that is the worst
    // possible trade: the picture silently softens and stays soft, and the
    // ABR/buffer controllers cannot see it because nothing is "lost", the frames
    // are just smaller. 'maintain-resolution' keeps every decoded frame at full
    // size; if the device still cannot keep up, the honest failure (dropped
    // frames) is something the rest of this file can actually measure and act
    // on. Set once, before any MediaStream is attached.
    try {
        if (player && 'degradationPreference' in player) {
            player.degradationPreference = 'maintain-resolution';
        }
    } catch (err) {
        console.warn('[Player] Could not pin degradationPreference:', err);
    }

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
    let gatherTimeout = null;            // ICE-gather window timer; module-scoped so teardown can cancel it
    let switchSeamTimer = null;          // Safety net for a seamless rendition switch that never lands
    let switchSeamPending = false;       // A replacement session is expected to take over the element
    // Session identity for the media element's MediaStream. A <video> renders
    // its FIRST video track, so a stream carrying tracks from an older session
    // would keep presenting dead video while the new session decodes in the
    // background — reported as framesDecoded climbing with RESOLUTION "--".
    let currentSessionId = 0;            // Bumped every time a peer connection is created
    let elementStreamSessionId = -1;     // Which session built the stream currently on the element
    let viewerPausedByChoice = false;    // True when the viewer (not a controller) paused playback
    let activeStreamPath = 'live';       // Path chosen for this session: live, live-av1 or live-h264
    let isConnected = false;
    let isConnecting = false;
    let connectionStartTime = 0;
    let connectTimeout = null;           // 12s connection watchdog timer
    let statsInterval = null;
    let statsTickInFlight = false;      // Overlap guard: a slow getStats() must not double-count deltas
    let streamActiveCheckTimeout = null;
    let lastBytesReceived = 0;
    let lastFramesDecodedCount = 0;
    let lastFramesReceived = 0;         // framesReceived baseline (decode-pressure detection)
    let lastFramesDiscarded = 0;        // framesDiscarded baseline (decoder's own drops)
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

    // Latency & Jitter Buffer Modes: 'ultra' (80ms), 'balanced' (180ms),
    // 'smooth' (350ms), 'cinema' (1000ms).
    // 'cinema' is the default for a reason this project finally accepted: for
    // a movie broadcast, latency is explicitly welcome and playout EVENNESS is
    // the product. A thin base target makes the jitter buffer oscillate around
    // the fixed point instead of sitting above it: bursty arrivals overshoot
    // (measured live: a 180ms target drifting to 1.2s) and Chrome drains the
    // overshoot back at ~150ms/s of catch-up — an inaudible ~1% speed-up that
    // reads as "a few milliseconds fast" — while a gap in arrivals under-runs
    // the thin buffer and holds a frame — "a few milliseconds slow". Zero
    // packet loss, zero drops in the stats, and still not smooth, because the
    // clock itself is breathing. A 1s starting buffer sits decisively above
    // the whole arrival-delay distribution (the jitter floor caps at 600ms,
    // IDR-GOP bursts measure ~1.4x bitrate in 100ms windows), so the buffer
    // neither under-runs nor needs catch-up drain, and both failure modes
    // disappear together. The other modes remain one click away; a manual
    // choice still persists. The drift limits sit ~1s above each mode: past
    // that the session itself is stale and rejoins at the live edge.
    let currentLatencyMode = 'cinema';
    const LATENCY_MODES = {
        ultra: { label: 'Ultra-Low (80ms)', ms: 80, s: 0.08, icon: 'fa-bolt', driftLimitMs: 900 },
        balanced: { label: 'Balanced (180ms)', ms: 180, s: 0.18, icon: 'fa-gauge-high', driftLimitMs: 1000 },
        smooth: { label: 'Anti-Stutter (350ms)', ms: 350, s: 0.35, icon: 'fa-shield-halved', driftLimitMs: 1100 },
        cinema: { label: 'Cinema (1s)', ms: 1000, s: 1.0, icon: 'fa-film', driftLimitMs: 2000 }
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
    let raiseReleaseTicks = 0;         // Ticks since the stress raise last stepped down
    let rejoinDriftSec = 0;             // Consecutive seconds past the reconnection drift cap
    let adaptiveRaiseLevelMs = 0;      // Held 350ms floor while the link is stressed (0 = off)
    let lastNetJitterMs = null;         // Smoothed inbound network jitter (ms)
    let lastLossPct = null;             // Packet loss over the last stats interval (%)
    let avgPlayoutDelayMs = null;       // Windowed jitter-buffer delay (ms, where reported)
    let avgPlayoutDelayAt = 0;          // performance.now() of the last FRESH reading above
    let lastJitterDelayTotal = 0;       // Cumulative jitterBufferDelay baseline (seconds)
    let lastJitterEmittedTotal = 0;     // Cumulative jitterBufferEmittedCount baseline
    let lastAppliedTargetMs = null;     // Last target pushed to receivers (change detection)
    let lastAppliedTargetChangeAt = 0;  // performance.now() of the last applied change (dwell gate)
    let jitterFloorTick = 0;            // Stats ticks since the jitter floor was last allowed to decay
    const JITTER_FLOOR_DECAY_EVERY_TICKS = 5;
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
    let lastPresentedFramesAtTick = 0;  // presentedFrames baseline at the previous stats tick
    let lastPresentedTickAt = 0;        // Wall clock of the previous stats tick (the fps denominator)
    let lastRouteText = '--';           // Selected ICE route: direct / relay (TURN)
    let lastRecoveryCounts = null;      // { pli, nack } session totals for diagnostics
    let noMediaRejoinCount = 0;         // Connected-but-no-video rejoin attempts this session
    let iceErrorNoticed = false;        // One STUN/TURN candidate-error notice per connection
    let stage2AttemptedThisSession = false; // Freeze-recovery Stage 2 runs at most once per session
    // Latest inbound video counters, published by the 1s stats loop and read by
    // the freeze watchdog. getStats() walks the whole RTP graph and allocates a
    // fresh report set on every call, so the watchdog used to pay for a SECOND
    // full walk every 1.5s on top of the loop's 1s one — on the low-end devices
    // that most need the main thread. One walk per second is the budget; the
    // watchdog judges liveness from this snapshot instead. `at` is the
    // performance.now() of publication so a stale/skipped tick cannot be
    // mistaken for "no progress".
    let inboundSnapshot = null;         // { decoded, bytes, at }
    const INBOUND_SNAPSHOT_MAX_AGE_MS = 3000;

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
            // 'playback', not 'interactive'. This context only drives the
            // element's audio through a gain/analyser chain — there is no
            // round-trip processing that needs a small quantum. What the hint
            // actually selects is the size of the hardware output buffer the
            // audio thread renders into: 'interactive' requests the smallest
            // the platform allows (~10ms on Windows shared-mode WASAPI), where
            // any scheduling hiccup — GPU contention, a busy compositor, a
            // timer-resolution change — underruns the render quantum and
            // glitches. And because a media element with a live audio track
            // slaves its playback clock to audio output, an audio-render
            // hiccup does not stay an audio problem: the playout clock itself
            // stutters, which reads as video micro-jank with 0% packet loss.
            // 'playback' requests the larger buffer (~2x) and trades a few
            // milliseconds of added audio latency — irrelevant here — for an
            // output path that survives main-thread and GPU contention.
            audioCtx = new AudioContextClass({ latencyHint: 'playback' });
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            gainNode = audioCtx.createGain();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 64;

            gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
            gainNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
            // Recovery from a LATER suspension. Once createMediaElementSource
            // has been attached, the element's audio is rendered by this graph
            // — so if the context suspends afterwards (output device change, a
            // Bluetooth headset connecting, the browser's audio service
            // restarting) the viewer gets PERMANENT SILENCE: the video plays
            // normally, the mute button still reads "unmuted" and the meter
            // reads zero, and nothing in the app ever tries again, because
            // unlockAudio removes its own gesture listeners on the first
            // success and nothing else touches the context. A suspended context
            // does NOT stall or drift the video (the media element has its own
            // clock), so this was invisible in the video path and only
            // presented as mysteriously missing audio.
            audioCtx.onstatechange = () => {
                if (audioCtx && audioCtx.state === 'suspended' && !document.hidden) {
                    audioCtx.resume().catch(() => {});
                }
            };
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
                // RAMP, never step. setValueAtTime moves the gain inside one
                // render quantum (128 samples = 2.67ms at 48kHz), and a step in
                // gain on a non-zero waveform is a broadband discontinuity — an
                // audible click. Mute/unmute steps by a full 1.0 (0dBFS, the
                // loudest transient possible, at the moment the listener's ear
                // is adapted to the room), and the volume slider fires `input`
                // at the OS pointer rate, so dragging it produced 60-200 steps
                // per second of continuous crackle. 20ms is the right order of
                // magnitude: the ear integrates transients under ~10ms as clicks
                // and over ~30ms as fades.
                gainNode.gain.cancelScheduledValues(now);
                gainNode.gain.setValueAtTime(gainNode.gain.value, now);
                gainNode.gain.linearRampToValueAtTime(clamped, now + 0.02);
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

    // The level meter is decoration, but it used to run a requestAnimationFrame
    // loop at display rate that wrote `style.width` EVERY frame — and kept
    // re-arming even while muted, paused or disconnected, which is the default
    // state for most of a session. A `width` write invalidates layout, and rAF
    // callbacks are scheduled in the same frame update that presents the video,
    // so ~60 style recalcs + layouts per second were competing directly with
    // frame presentation for main-thread time on exactly the low-end receivers
    // this loop can least afford. It now:
    //   - samples the analyser at ~12 Hz (a level bar cannot show 60 Hz detail),
    //   - writes style only when the rounded value actually changes,
    //   - stops itself entirely when there is no audio to measure, and is
    //     re-armed by the same events that call startAudioMeter().
    const AUDIO_METER_INTERVAL_MS = 80;
    let audioMeterLastSampleAt = 0;
    let audioMeterLastPct = -1;
    // Drive the bar with a custom property that the stylesheet applies as
    // `transform: scaleX()`, not with `width`. `width` is a LAYOUT property: at
    // ~12Hz that is 12 relayouts of the meter subtree per second, on the
    // per-frame critical path of a page whose whole job is presenting video, and
    // the CSS `transition: width` then interpolated between them for another
    // ~6 relayouts/s. scaleX is compositor-only. The inline `width` in
    // index.html is cleared on first write so it cannot outrank the new
    // mechanism; until then the transform's fallback keeps the bar full-width
    // rather than invisible.
    function renderAudioMeter(percentage) {
        if (percentage === audioMeterLastPct) return;
        audioMeterLastPct = percentage;
        if (!hudAudioLevel) return;
        hudAudioLevel.style.removeProperty('width');
        hudAudioLevel.style.setProperty('--level', String(percentage / 100));
    }
    function stopAudioMeterLoop() {
        if (audioMeterAnimId) {
            cancelAnimationFrame(audioMeterAnimId);
            audioMeterAnimId = null;
        }
    }
    function startAudioMeter() {
        if (!analyserNode || !hudAudioLevel || !telemetryHud || telemetryHud.style.display !== 'block') return;
        if (audioMeterAnimId) return;   // already running; never stack loops
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        audioMeterLastSampleAt = 0;
        audioMeterLastPct = -1;

        const updateMeter = (now) => {
            if (!telemetryHud || telemetryHud.style.display !== 'block') {
                stopAudioMeterLoop();
                return;
            }
            if (!isConnected || player.paused || player.muted) {
                renderAudioMeter(0);
                stopAudioMeterLoop();   // idle: re-armed by mute/unmute + play/pause
                return;
            }
            if (now - audioMeterLastSampleAt >= AUDIO_METER_INTERVAL_MS) {
                audioMeterLastSampleAt = now;
                analyserNode.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                renderAudioMeter(Math.min(100, Math.round((average / 180) * 100)));
            }
            audioMeterAnimId = requestAnimationFrame(updateMeter);
        };
        audioMeterAnimId = requestAnimationFrame(updateMeter);
    }

    function stopAudioMeter() {
        stopAudioMeterLoop();
        audioMeterLastPct = -1;
        if (hudAudioLevel) hudAudioLevel.style.setProperty('--level', '0');
    }

    // Synthesize gentle sci-fi click & pop sound effects on the fly.
    // Every node pair is explicitly disconnected when it ends, and concurrent
    // voices are capped. Each effect is a fresh OscillatorNode -> GainNode pair
    // connected to the destination, i.e. a connected subgraph anchored on a
    // long-lived node — not the shape WebAudio's collector reclaims cheaply.
    // Measured: 200 calls created 400 nodes and disconnected 0. playSfx fires on
    // every local reaction click, every INCOMING reaction broadcast, every chat
    // send and every rendition switch, so during a hype train the churn is
    // continuous on the same main thread that is decoding video. Scheduling is
    // not the cost (0.013ms/call) — lifetime is.
    const MAX_SFX_VOICES = 6;
    let liveSfxVoices = 0;
    function playSfx(type = 'pop') {
        if (!soundEnabled || !audioCtx) return;
        if (liveSfxVoices >= MAX_SFX_VOICES) return;   // drop rather than pile up
        try {
            // Catches its rejection: the context is created outside a user
            // gesture, so resume() rejects on the ordinary autoplay path
            // (handleConnected plays a chime for viewers who never clicked).
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            const osc = audioCtx.createOscillator();
            const sfxGain = audioCtx.createGain();
            osc.connect(sfxGain);
            sfxGain.connect(audioCtx.destination);
            liveSfxVoices += 1;
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                liveSfxVoices = Math.max(0, liveSfxVoices - 1);
                try { osc.disconnect(); sfxGain.disconnect(); } catch (_) {}
            };
            osc.onended = release;

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
            liveSfxVoices = Math.max(0, liveSfxVoices - 1);
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
        // Scope the COLLECTION pass to the video section too. It used to sweep
        // the whole document, so a payload type that also appears in m=audio
        // was recorded as "already has feedback" and the video section silently
        // kept only what audio happened to declare. Reproduced with a colliding
        // fixture (video PT 111 also present in m=audio): the video section came
        // out with nack pli and goog-remb but NO nack — i.e. no retransmission
        // at all, so one lost packet discarded a frame until the next keyframe.
        // Chrome's own payload ranges do not collide today, so this is a latent
        // trap rather than a live defect, but the injection pass below is
        // already section-scoped and the collection must match it.
        (() => {
            let inVideo = false;
            for (const line of lines) {
                if (/^m=/.test(line)) {
                    inVideo = /^m=video/.test(line);
                    continue;
                }
                const match = line.match(/^a=rtcp-fb:(\d+)\s+(.+)$/);
                if (match && inVideo) presentFeedback.add(`${match[1]} ${match[2].trim()}`);
            }
        })();

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
                    // RTX/red/ulpfec/flexfec are REPAIR payloads, not media: they
                    // carry no picture of their own and belong immediately after
                    // the media payload type they serve (rtx's `apt=` parent).
                    // Scoring them with the catch-all 50 parked them below every
                    // media codec at the tail of the list, which is exactly where
                    // setCodecPreferences can detach rtx from its apt parent in
                    // the negotiated m-line. Retransmission is the cheapest loss
                    // recovery there is — losing it turns every isolated dropped
                    // packet into a discarded frame, and a lost keyframe into a
                    // full decode stall until the next IDR. Rank them alongside
                    // their primary and let the browser's order stand among
                    // equals (Array.sort is stable).
                    if (/(rtx|red|ulpfec|flexfec)/.test(mime)) return 100;
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
    //
    // allowDecay (pure) exists because the DECAY is what churns: walking the
    // floor down 25ms every tick means 24 consecutive target writes over 24
    // seconds after a single jitter spike, and every jitterBufferTarget write
    // re-paces Chrome's playout. Callers pass false between decay steps, so
    // the floor only ratchets up promptly and back down once every few ticks.
    // Raising is never gated: a bigger buffer is always the safe direction.
    // Floor held while the link is measurably stressed. Mid-way between
    // Balanced (180ms) and Smooth (350ms) would be tempting, but the point of a
    // stress hold is to sit decisively clear of the arrival-delay distribution,
    // so it uses the same value as the explicit Smooth mode.
    const ADAPTIVE_RAISE_MS = 350;
    // Release granularity for the stress hold. Matches the 50ms band that
    // reapplyBufferTargets uses to decide whether a change is worth writing at
    // all, so a ramped release produces one real re-pace per step instead of a
    // burst of sub-band no-ops.
    const ADAPTIVE_RAISE_STEP_MS = 50;
    function jitterBufferFloorMs(jitterMs, prevFloorMs = 0, allowDecay = true) {
        const candidate = (jitterMs === null || !Number.isFinite(jitterMs) || jitterMs <= 20)
            ? 0
            : Math.min(600, Math.round((jitterMs * 2.5 + 75) / 25) * 25);
        if (candidate >= prevFloorMs) return candidate;
        if (!allowDecay) return prevFloorMs;
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
        // Compare against what has ALREADY been granted, never against the bare
        // base. baseBufferTargetMs() deliberately EXCLUDES accommodationTargetMs
        // (it is the mode + stress raise + jitter floor), so using it here made
        // the threshold permanently satisfied the moment Chrome converged on the
        // granted target: `delay > base + 150` stayed true forever, so every
        // drop-tick re-granted `delay + 100` and walked the target straight to
        // the 2200ms cap in ~19 ticks. Each step is a jitterBufferTarget write
        // ABOVE the filled level, which makes Chrome hold frames — simulated
        // through the real band/dwell gates that was 11 applied raises and ~1.1s
        // of frozen picture in the first 20s of any session that drops a frame.
        // This is precisely the "inflate every session to the cap within half a
        // minute" failure the drop-gate was introduced to stop; the gate only
        // ever stopped it for the no-drops case. Comparing against `granted`
        // still lets a genuinely larger need through (700 measured against a
        // 450 grant clears 450+150), it just cannot climb against its own grant.
        const granted = Math.max(baseTargetMs, prevMs);
        if (dropsNow && delayMs > granted + 150) {
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
    // Decoder pressure. `receivedDelta` is framesReceived, which counts EVERY
    // frame the transport delivered to the jitter buffer — including frames
    // the decoder then dropped because it could not keep up. Charging those to
    // the decoder (as the ratio below used to) made every sustained packet-loss
    // burst look like a struggling decoder, which drives the 350ms buffer raise
    // and the ABR downgrade for a problem the jitter buffer already absorbs.
    // framesDiscarded is the net of frames dropped due to "needs resize" and
    // "decoder failure" — i.e. genuinely the decoder's own doing — so the ratio
    // is computed from frames the decoder actually had the opportunity to show:
    //   delivered = decoded + discarded
    // A ratio below 0.85 therefore means the decoder could not deliver 15% of
    // the frames it received, which is real decode pressure; a ratio at 0.9 with
    // the old code sat in the hold band forever and could never accumulate, so a
    // decoder stuck at 83% never triggered anything at all.
    function updateDecodeLag(lagSec, decodedDelta, receivedDelta, discardedDelta = 0) {
        if (receivedDelta < 15) return Math.max(0, lagSec - 1);
        if (decodedDelta < 0) return Math.min(30, lagSec + 1);
        const discarded = Number.isFinite(discardedDelta) ? Math.max(0, discardedDelta) : 0;
        const delivered = decodedDelta + discarded;
        if (delivered <= 0) return Math.min(30, lagSec + 1);
        const ratio = delivered / receivedDelta;
        if (ratio < 0.85) return Math.min(30, lagSec + 1);
        if (ratio >= 0.98) return Math.max(0, lagSec - 1);
        // Marginal band (0.85-0.98): keep the current reading rather than
        // pushing it either way, so a link sitting right at the edge does not
        // oscillate across the 5s ABR trigger.
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
        if (adaptiveRaiseLevelMs > 0) target = Math.max(target, adaptiveRaiseLevelMs);
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

    // Apply the effective playout delay target to one receiver. Returns true
    // when a target was actually written, so callers can avoid latching a
    // change that never landed. `overrideMs` lets a receiver be given a
    // deliberately different target.
    function applyPlayoutDelay(receiver, kind, overrideMs) {
        if (!receiver) return false;
        const targetMs = overrideMs === undefined ? currentBufferTargetMs() : overrideMs;
        try {
            if ('jitterBufferTarget' in receiver) {
                receiver.jitterBufferTarget = targetMs;
            } else if ('playoutDelayHint' in receiver) {
                receiver.playoutDelayHint = targetMs / 1000;
            } else {
                return false;
            }
            return true;
        } catch (err) {
            console.warn(`[WebRTC] Could not apply ${targetMs}ms playout target on ${kind} receiver:`, err);
            return false;
        }
    }

    // Push the current target to every receiver. Returns true when it changed.
    //
    // Rate-limited on purpose. Every jitterBufferTarget write re-paces Chrome's
    // playout: a raise above the currently-filled level makes the jitter buffer
    // HOLD frames (a visible stall), a lower target lets late frames be
    // discarded (visible drops). The state machines upstream of here move in
    // 25-50ms steps, and both the jitter floor and the accommodation used to
    // walk down one step EVERY tick — so a single jitter spike produced ~24
    // consecutive writes over 24 seconds, and a link hovering near a threshold
    // produced a permanent up/down churn. Read by a viewer that is "not quite
    // smooth but nothing is obviously wrong", which is the worst symptom to
    // diagnose. Two gates bound it:
    //   - a hysteresis band, so a sub-BUFFER_TARGET_BAND_MS change is noise;
    //   - a dwell, so two applied changes are never closer together than
    //     BUFFER_TARGET_DWELL_MS — EXCEPT a genuine emergency raise while
    //     frames are actually being dropped, which stays instant because a
    //     bigger buffer is always the safe direction. Latency is explicitly
    //     not a concern in this project, so the dwell is spent entirely on
    //     never re-pacing the decoder for a cosmetic change.
    const BUFFER_TARGET_BAND_MS = 50;
    const BUFFER_TARGET_DWELL_MS = 3000;
    const BUFFER_TARGET_EMERGENCY_DWELL_MS = 1200;
    // performance.now() of the last stats tick that saw a late frame discarded.
    // A raise requested while frames are ACTUALLY being dropped is the
    // anti-stutter path and skips the full dwell; a raise requested by a
    // drifting measurement with no drops is cosmetic and waits.
    let recentDropAt = -Infinity;
    function reapplyBufferTargets() {
        if (!peerConnection) return false;
        const targetMs = currentBufferTargetMs();
        if (lastAppliedTargetMs === null) {
            // First apply of a session: always grant it, no gate.
        } else {
            if (targetMs === lastAppliedTargetMs) return false;
            if (Math.abs(targetMs - lastAppliedTargetMs) < BUFFER_TARGET_BAND_MS) return false;
            const sinceLast = performance.now() - lastAppliedTargetChangeAt;
            const urgent = targetMs > lastAppliedTargetMs
                && performance.now() - recentDropAt < 3000;
            const dwell = urgent ? BUFFER_TARGET_EMERGENCY_DWELL_MS : BUFFER_TARGET_DWELL_MS;
            if (sinceLast < dwell) return false;
        }
        // BOTH receivers, with the SAME target.
        //
        // The two tracks play out of one <video> element, and Chrome honours
        // each receiver's buffer depth independently — measured on a live
        // session: audio left unwritten sat at ~933ms while targeted video sat
        // at ~271ms, a ~660ms constant lip-sync offset. The element keeps
        // video presentation on the audio clock, so ANY difference between the
        // two targets is lip-sync error, not a contained setting: a
        // 400ms-audio / 1000ms-video pair would show every frame 600ms after
        // its samples play. The old AUDIO_PLAYOUT_CAP_MS=400 protected ears in
        // the 180ms era; with Cinema (1000ms) as the default it *created* a
        // 600ms offset for every fresh viewer, and it skewed every
        // accommodated session (video 2200 / audio 400) by 1.8s under the
        // per-receiver depths Chrome actually implements. One synchronized
        // playout surface therefore gets one number, always. A raise is silent
        // buffering — NetEQ accumulates the difference and stretches only to
        // bridge an underrun — and every lower is already step-limited to
        // 50ms/tick by the state machines above, so the audio-side
        // acceleration drains in lockstep with the video drain. (A UA that
        // implements the spec's larger-of-the-two rule resolves the identical
        // writes to the same value either way.)
        const videoTargetMs = currentBufferTargetMs();
        let applied = 0;
        peerConnection.getReceivers().forEach(r => {
            if (r.track && (r.track.kind === 'video' || r.track.kind === 'audio')) {
                if (applyPlayoutDelay(r, r.track.kind, videoTargetMs)) applied += 1;
            }
        });
        // Latch only after a receiver actually accepted the write. Latching
        // first meant a mid-reconnect receiver list (or a throwing setter) left
        // the app believing it had granted a target it never did: it would never
        // retry, the HUD would advertise a buffer the browser is not running,
        // and every downstream decision would be regulating against a fiction.
        if (applied === 0) return false;
        lastAppliedTargetMs = targetMs;
        lastAppliedTargetChangeAt = performance.now();
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
        // A viewer who paused is not a viewer under stress. RTP keeps arriving
        // while paused, so loss and jitter keep looking "stressed" forever and
        // the controllers that can rebuild the session start acting on it —
        // 8 stressed seconds while paused fired a full rendition switch, and
        // `droppedDelta > 0 || lateFrameEvidence` is permanently true while
        // paused (packets arrive, nothing leaves the buffer), which walked
        // jitterBufferTarget up to the 2200ms cap in 50ms steps, ~44 writes
        // each re-pacing playout. The freeze watchdog, the stall guard and the
        // audio meter all already honour `player.paused`; these did not. State is
        // reset on the `play` event so resume starts from a clean, live edge.
        if (player.paused) return;
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
        }
        // No else, for the same reason as the stress/calm runs above: a
        // half-stressed link used to reset both counters on every ambiguous
        // tick, so abrBadSec could never reach 8 and a struggling viewer stayed
        // on the full-bitrate rendition 2-4x longer than intended (see the
        // tick-vs-second note on the accumulators).

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
            // The downgrade target DECODES AV1: a browser without AV1 support
            // (or with software-only decode) would land in an undecodable
            // session — strictly worse than the stutter it is escaping. Those
            // viewers keep the full-bitrate path; buffer accommodation and the
            // stress floor still protect them from the rough link.
            if (abrBadSec >= 8 && onFullBitratePath && !sourceIsAv1 && rendReady
                && browserSupportsAv1() && av1DecodeSmooth !== false) {
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
                    'preferNonTranscode',
                    browserSupportsH265()
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
                    // The native path carries the SOURCE codec: a browser
                    // without H265 receive support (chooseStreamPath routed
                    // it onto the AV1 rendition for exactly that reason)
                    // must not be "recovered" onto an undecodable stream —
                    // the same wrong-target trap the ABR downgrade guard
                    // closes. It keeps its current rendition instead.
                    const dpSourceIsH265 = dpTracksUpper.includes('H265') || dpTracksUpper.includes('HEVC');
                    hwPath = (dpSourceIsH265 && browserSupportsH265() === false) ? null : 'live';
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
        // Count only FRESH, PERSISTENT over-cap measurements.
        //   - `avgPlayoutDelayAt` guards freshness. avgPlayoutDelayMs is only
        //     overwritten when windowedPlayoutDelayMs returns non-null, so on a
        //     quiet window (publisher stall, decoder stall, a few seconds with
        //     no emitted frames) it LATCHES at whatever the last reading was.
        //   - Without the freshness test, "3 consecutive ticks" is satisfied by
        //     three ticks containing ZERO new measurements, and a single stale
        //     high reading from before a hidden-tab return is enough to force a
        //     full WHEP teardown. That is a 2-4s hard black screen on a session
        //     that was fine. A live measurement must be newer than the
        //     confirmation window itself.
        const driftReadingIsFresh = avgPlayoutDelayMs !== null
            && now - avgPlayoutDelayAt < 3000;
        if (driftReadingIsFresh && avgPlayoutDelayMs > rejoinCapMs
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
        // A LEVEL, not a countdown. This used to be a wall-clock stamp
        // (adaptiveRaiseUntil = now + 15000) that expired on schedule whether or
        // not the link had recovered. On a continuously marginal link — the
        // 20->160ms queue ramp plus ~3% loss case, simulated end to end
        // against the extracted real functions — that produced a perfect square
        // wave: 350ms for 15s, back to 180ms for 7s, 5 target steps per minute,
        // FOREVER, on a link that never once went calm. Every one of those
        // steps re-paces Chrome's playout (the spec has the UA reach a new
        // target by accel/decel, rendering frames twice or dropping them), so a
        // link that is merely noisy — not broken — produced a repeating
        // hitch-and-catch-up that reads as "quality pumping". The calm restore
        // could never help: it needs 20 CONSECUTIVE calm ticks, which that link
        // never produces.
        // Holding the raise as a level while the stress condition holds, and
        // releasing it only after sustained calm, makes the response a hold
        // instead of an oscillator.
        const stressed = (lastNetJitterMs !== null && lastNetJitterMs > 55)
            || (lastLossPct !== null && lastLossPct > 2.5);
        // There is deliberately no `calm` predicate any more. The release used
        // to require 20 consecutive calm seconds (jitter < 25ms AND loss <
        // 0.8%) per step, which is what latched the raise for minutes on a
        // mobile link; the release now keys off "not stressed" instead. The
        // dead variable is removed rather than left to invite the old rule back.

        if (stressed) {
            calmRunSec = 0;
            stressRunSec += 1;
            if (stressRunSec >= 3) {
                adaptiveRaiseLevelMs = ADAPTIVE_RAISE_MS;
                if (bufferNoticeState !== 'raised') {
                    bufferNoticeState = 'raised';
                    addSystemMessage('Network jitter detected — widening the playout buffer to keep video smooth.');
                }
            }
        } else if (adaptiveRaiseLevelMs > 0) {
            // RELEASE ON A CLOCK, NOT ON A QUIET STREAK.
            //
            // "Not stressed" is already the signal that the cushion is no longer
            // needed — demanding 20 CONSECUTIVE calm seconds (jitter < 25ms and
            // loss < 0.8%) before taking even one 25ms step meant a viewer on a
            // mobile link, whose jitter sits around the 55ms threshold and
            // essentially never sustains below 25ms for 20 straight seconds,
            // latched the raise. With 14 steps to unwind, that is up to ~4.7
            // MINUTES of an extra ~170ms of permanent latency — the source of
            // "receivers feel a small but continuous lag while the streamer, on
            // a direct local path, feels none".
            //
            // The level is still a HOLD rather than a countdown (a timestamp
            // expiry oscillated, which the previous round measured as a 15s/7s
            // square wave), and it still steps down rather than jumping, because
            // a downward jitterBufferTarget makes Chrome discard frames to reach
            // the new level. Only the release CONDITION is wrong, and this fixes
            // it: step down every 2 ticks (~2s) whenever the link is not
            // stressed, so 350ms unwinds in about half a minute instead of
            // minutes.
            stressRunSec = 0;
            calmRunSec += 1;
            raiseReleaseTicks += 1;
            if (raiseReleaseTicks >= 2) {
                raiseReleaseTicks = 0;
                adaptiveRaiseLevelMs = Math.max(0, adaptiveRaiseLevelMs - ADAPTIVE_RAISE_STEP_MS);
            }
            if (adaptiveRaiseLevelMs === 0) {
                calmRunSec = 0;
                if (bufferNoticeState === 'raised') {
                    bufferNoticeState = '';
                    addSystemMessage(`Network is stable again — back to the ${config.label} buffer.`);
                }
            }
        } else {
            stressRunSec = 0;
            calmRunSec += 1;
        }
        // Dead band handling. The `else` above covers a link that is neither
        // stressed nor released (nothing to release), so no separate reset is
        // needed here. What still matters is that an AMBIGUOUS tick never erases
        // a genuine state change: `stressed` zeroes calmRunSec, the release
        // branch zeroes stressRunSec, and the two are mutually exclusive, so
        // holding cannot leak or deadlock.
        // evidence.

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
        // Only an explicit ECO choice vetoes this. A stored '0' means the user
        // once tried the toggle and left it on "Turbo GPU" — that is not a
        // request to keep stuttering through a measured drop storm, and
        // treating it as a veto meant a single idle click permanently disabled
        // the relief on every future visit (the same veto also blocked the
        // low-core heuristic below). Eco Mode only fires after getStats shows
        // sustained real frame drops, and the toggle visibly flips, so the
        // viewer can always turn it back off.
        if (storedPerfChoice === '1') return;
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
        // Each connection gets one fresh STUN/TURN failure notice (see the
        // onicecandidateerror handler below).
        iceErrorNoticed = false;
        updateUIState('connecting');
        
        // Arm a connection-timeout watchdog to prevent an infinite connecting
        // spinner. The budget covers the worst legitimate stack: ICE-config
        // fetch (2.5s cap) + candidate gathering (6s cap, because the window
        // now waits for a ROUTABLE candidate so a network that blocks UDP STUN
        // is not cut off before its srflx or TURN candidate lands) + WHEP POST
        // (10s cap) = 18.5s, so the cap is 22s. Leaving this at 16s guaranteed
        // the watchdog fired BEFORE the attempt could possibly finish on a slow
        // link — the exact viewer this change was meant to help.
        // Real ICE failures still tear down immediately via the
        // connectionState 'failed' handler; this is only the no-state-change
        // backstop.
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = setTimeout(() => {
            if (isConnecting && !isConnected) {
                console.warn("[WebRTC] Connection attempt timed out after 16s without ICE handshake. Triggering disconnect recovery.");
                addSystemMessage("⚠️ Connection timed out. Re-attempting handshake...");
                handleDisconnected();
            }
        }, 22000);
        
        console.log("[WebRTC] Starting connection sequence...");
        
        try {
            const iceServers = await fetchIceServers();
            console.log("[WebRTC] Creating RTCPeerConnection (iceServers:", iceServers.length, ")...");
            peerConnection = new RTCPeerConnection({
                iceServers: iceServers,
                bundlePolicy: 'max-bundle'
            });
            // Every peer connection is a new SESSION. The media element's
            // MediaStream is tagged with the session that built it, because a
            // <video> renders its FIRST video track — so if a new session's
            // tracks are appended to a stream left over from an older one, the
            // element keeps presenting the dead track while the new session
            // decodes happily in the background. That is exactly the reported
            // symptom: framesDecoded climbing (the new session is fine),
            // PACKETS LOST 0, audio fine, and RESOLUTION "--" because
            // player.videoWidth is 0 for a track that produces nothing.
            //
            // It is reachable without any rendition switch at all: the freeze
            // watchdog's Stage 2 and every graceful ICE teardown call
            // cleanupConnection(true), which deliberately leaves the old stream
            // on screen. The old first-track branch only replaced the stream
            // when it was null, so on the next connect the tracks were appended
            // to the stale one.
            currentSessionId += 1;
            // GENERATION TOKEN. This function has an unavoidable ~3s await on ICE
            // gathering that cleanupConnection() cannot cancel, and it used to
            // read the MODULE global `peerConnection` at every step. A torn-down
            // attempt therefore kept running and then operated on whatever the
            // global pointed at by then — i.e. the NEXT attempt's connection.
            // Reproduced with the real extracted function: a stale continuation
            // woke 3.0s in and tore down a *healthy* 1.9s-old pc, and a second
            // WHEP POST went out carrying the new pc's SDP, leaving two MediaMTX
            // reader sessions for one viewer with `whepSessionUrl` overwritten so
            // the orphaned one could never be DELETEd. Binding the pc locally and
            // re-checking identity after every await makes a superseded attempt
            // a no-op instead of a saboteur.
            const pc = peerConnection;
            const superseded = () => peerConnection !== pc;

            console.log("[WebRTC] ICE config ready (iceServers:", peerConnection.getConfiguration().iceServers.length, "- host candidates, TURN relay when remote).");

            // Add receive-only transceivers
            const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            configureCodecPreferences(videoTransceiver);

            // Handle incoming track event robustly
            peerConnection.ontrack = (event) => {
                console.log("[WebRTC] Track received! Kind:", event.track.kind, "ID:", event.track.id, "Streams count:", event.streams.length);
                
                // BOTH kinds, same target — see reapplyBufferTargets(): the
                // element presents video on the audio clock, so the audio
                // receiver must move with video from the first frame or the
                // depth difference is lip-sync error until the first stats
                // tick catches up.
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

                // ABR seam: this track belongs to a REPLACEMENT session, and
                // `player.srcObject` still holds the previous (now ended) stream
                // that cleanupConnection(true) deliberately left on screen. The
                // add-track path below would append to it, and a video element
                // renders its FIRST video track — so the new picture would never
                // be shown. Swap in a fresh single-track stream instead. That is
                // the moment the frozen last frame becomes the live picture.
                if (switchSeamPending && event.track.kind === 'video') {
                    const replacement = new MediaStream();
                    // Every track this session has produced so far, NOT just this
                    // video one. A single-track stream is the bug this replaces:
                    // the audio track is very often delivered FIRST (ontrack for
                    // audio precedes video on a WHEP answer), so by the time the
                    // seam closes the audio track is already sitting in the
                    // previous, now-stale stream. Swapping in a video-only
                    // stream silently DROPPED the audio, and the viewer got a
                    // picture with no sound. It is order-dependent, which is why
                    // it presented as "sometimes video, sometimes music" rather
                    // than as a reliable fault. Taking the tracks off the peer
                    // connection (the same source Stage 2 uses) makes the result
                    // identical whichever track arrives first, and a track that
                    // has not arrived yet still appends through the branch below.
                    peerConnection.getReceivers().forEach(r => {
                        if (r.track) replacement.addTrack(r.track);
                    });
                    player.srcObject = replacement;
                    elementStreamSessionId = currentSessionId;
                    closeRenditionSeam();
                    console.log(`[ABR] Seam closed: ${replacement.getTracks().length} track(s) now on screen.`);
                } else if (elementStreamSessionId !== currentSessionId) {
                    // The element is holding a stream from an EARLIER session
                    // (a graceful teardown deliberately leaves the old picture in
                    // place). Appending this session's tracks to it would leave
                    // the dead first video track in charge of rendering, so build
                    // a fresh one from the current receivers instead. Tracks that
                    // have not arrived yet still append through the branch below.
                    const fresh = new MediaStream();
                    peerConnection.getReceivers().forEach(r => {
                        if (r.track) fresh.addTrack(r.track);
                    });
                    player.srcObject = fresh;
                    elementStreamSessionId = currentSessionId;
                    closeRenditionSeam();
                    console.log(`[WebRTC] Rebuilt player.srcObject for session ${currentSessionId} `
                        + `(${fresh.getTracks().length} track(s)); a stale stream was on the element.`);
                } else if (!player.srcObject || !(player.srcObject instanceof MediaStream)) {
                    // Initialize srcObject as a new MediaStream if it doesn't exist yet
                    player.srcObject = new MediaStream();
                    elementStreamSessionId = currentSessionId;
                    closeRenditionSeam();
                    console.log("[WebRTC] Initialized player.srcObject with a new MediaStream.");
                } else {
                    // Add the track to the player's MediaStream if not already present
                    const existingTracks = player.srcObject.getTracks();
                    if (!existingTracks.find(t => t.id === event.track.id)) {
                        player.srcObject.addTrack(event.track);
                        console.log(`[WebRTC] Added track (${event.track.kind}) to player.srcObject.`);
                    }
                }

                // Explicitly play the player with autoplay-protection fallback.
                // Two rules: never override a viewer who paused by choice, and
                // never let a rejection from a session that no longer exists
                // touch the CURRENT one — the old catch ran on the globals of a
                // dead session, so a teardown between play() and its resolution
                // left the NEXT session starting muted behind the unmute overlay.
                if (viewerPausedByChoice) {
                    console.log("[ABR] Replacement track received; leaving playback paused as the viewer left it.");
                    return;
                }
                player.play().then(() => {
                    console.log(`[WebRTC] Video playback running after adding ${event.track.kind} track.`);
                    initAudioContext();
                    connectPlayerToAudioNodes();
                }).catch(err => {
                    if (superseded()) {
                        console.warn("[WebRTC] play() rejected on a superseded session; not touching current state.", err);
                        return;
                    }
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

            // STUN/TURN failures surface only through this event — an ICE
            // 'failed' state hides the cause. A network that blocks UDP STUN
            // (hotel/corporate wifi) would otherwise loop connecting→offline
            // with no explanation; naming the unreachable server turns "the
            // stream is broken" into "this network blocks WebRTC, use the
            // Tailscale link". Fired per candidate-gathering attempt, so it
            // is reported once per connection.
            peerConnection.onicecandidateerror = (event) => {
                if (!event || !event.errorCode || iceErrorNoticed) return;
                iceErrorNoticed = true;
                const server = typeof event.url === 'string' && event.url ? event.url : 'the STUN/TURN server';
                console.warn(`[WebRTC] ICE candidate error ${event.errorCode} from ${server}: ${event.errorText || 'no detail'}`);
                addSystemMessage(`⚠️ Could not reach ${server} for WebRTC path discovery (error ${event.errorCode}). `
                    + 'Trying the remaining candidates — if nothing connects, this network blocks WebRTC and the Tailscale link is the fallback.');
            };

            // Create and set local SDP Offer
            console.log("[WebRTC] Creating SDP offer...");
            const offer = await pc.createOffer();
            if (superseded()) {
                console.log("[WebRTC] Offer abandoned: a newer connection superseded this one.");
                return;
            }
            console.log("[WebRTC] Setting local description...");
            await pc.setLocalDescription(offer);
            if (superseded()) {
                console.log("[WebRTC] setLocalDescription abandoned: a newer connection superseded this one.");
                return;
            }

            // Wait for ICE candidate gathering. MediaMTX WHEP is non-trickle (candidates must
            // ride inside the offer), so cutting gathering short can drop the browser's
            // srflx candidate and break receivers behind strict NAT. Early-exit on 'complete'
            // keeps typical startup fast; the cap only binds on very slow networks.
            //
            // The exit condition is "a ROUTABLE candidate exists", not "3s elapsed".
            // That distinction decides whether a hard network can ever connect. This
            // page never calls getUserMedia, so Chrome mDNS-obfuscates its host
            // candidates as `xxxx.local`; MediaMTX is Pion and resolves no mDNS, so an
            // offer carrying only those has literally nothing to connect to. A fixed
            // 3s deadline would POST that useless offer on exactly the network the
            // code elsewhere diagnoses as "blocks UDP STUN" — where gathering may
            // still be running and a `turns:` relay needs longer than 3s to allocate —
            // and every retry would repeat it identically. Waiting for a non-mDNS
            // candidate (or for gathering to complete) costs nothing on a normal link,
            // where a host candidate appears in single-digit milliseconds.
            const hasRoutableCandidate = () => {
                const sdp = pc.localDescription && (pc.localDescription.value || pc.localDescription.sdp);
                if (!sdp) return false;
                return sdp.split('\r\n').some((line) =>
                    line.startsWith('a=candidate:')
                    && !/ [0-9a-f]{8}-[0-9a-f-]+\.local \d+ /i.test(line));
            };
            console.log("[WebRTC] Waiting up to 6s for a routable ICE candidate...");
            await new Promise((resolve) => {
                let checkState;
                let routablePoll = null;
                let routableSettle = null;

                const finish = (why) => {
                    if (gatherTimeout) { clearTimeout(gatherTimeout); gatherTimeout = null; }
                    if (routablePoll) { clearTimeout(routablePoll); routablePoll = null; }
                    if (routableSettle) { clearTimeout(routableSettle); routableSettle = null; }
                    pc.removeEventListener('icegatheringstatechange', checkState);
                    console.log(`[WebRTC] Proceeding to send WHEP offer (${why}).`);
                    resolve();
                };

                checkState = () => {
                    if (superseded()) {
                        console.log("[WebRTC] ICE gather aborted: a newer connection superseded this one.");
                        finish('superseded');
                        return;
                    }
                    if (pc.iceGatheringState === 'complete') {
                        console.log("[WebRTC] Local ICE gathering completed inside promise check.");
                        finish('gathering complete');
                    }
                };

                // Settle briefly after the first routable candidate so a trickle
                // of follow-up candidates (srflx/relay) still lands in the offer.
                const pollRoutable = () => {
                    // A superseded session must RESOLVE, not just stop polling:
                    // cleanupConnection() clears the gather cap, so a bare return
                    // would leave this promise pending forever with the await in
                    // connectStream suspended indefinitely — a session that never
                    // posts WHEP, never errors and never times out. Resolve it
                    // through finish() so the caller runs its own stale check.
                    if (superseded()) { finish('superseded'); return; }
                    if (routableSettle || gatherTimeout === null) return;
                    if (!hasRoutableCandidate()) {
                        routablePoll = setTimeout(pollRoutable, 100);
                        return;
                    }
                    routableSettle = setTimeout(() => finish('routable candidate'), 400);
                };

                pc.addEventListener('icegatheringstatechange', checkState);
                // ORDER MATTERS. The cap must be armed BEFORE the first
                // pollRoutable() call: that function's guard tests
                // `gatherTimeout === null` to know the window is still open, so
                // priming the poll first made it return immediately and never
                // reschedule. The routable-candidate logic was therefore dead
                // code and this window silently degraded to "gathering complete
                // or 6s" — which is neither what it claims to do nor the 3s cap
                // it replaced.
                gatherTimeout = setTimeout(() => finish('6s cap reached'), 6000);
                pollRoutable();
            });
            if (gatherTimeout) { clearTimeout(gatherTimeout); gatherTimeout = null; }
            if (superseded()) {
                console.log("[WebRTC] Gather window exited but a newer connection took over; not sending WHEP.");
                return;
            }

            // Patch local SDP Offer with high bitrate limits
            const rawOfferSdp = pc.localDescription.value || pc.localDescription.sdp;
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

            // The POST is the longest await in this function. If the attempt was
            // torn down while it was in flight, the answer that comes back
            // belongs to a dead session: applying it (and recording its Location)
            // would overwrite the live attempt's whepSessionUrl and orphan a
            // MediaMTX reader this client can no longer DELETE.
            if (superseded()) {
                console.log("[WHEP POST] Answer discarded: a newer connection superseded this one.");
                // We just made a reader on the server, so release it rather than
                // leaking one per superseded attempt.
                try {
                    const staleLocation = response.headers.get('Location');
                    if (staleLocation) {
                        fetch(new URL(staleLocation, window.location.origin).href, { method: 'DELETE' })
                            .catch(() => {});
                    }
                } catch (e) { /* best-effort */ }
                return;
            }

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
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: answerSdp
            }));
            console.log("[WebRTC] Set remote description successfully! Waiting for media packets...");

            // Re-arm the connect watchdog to cover ICE ONLY, from the moment the
            // answer is applied. The original one is armed before signaling and
            // cleared in handleConnected, so it had to cover the whole sequence:
            // 2.5s ICE-config fetch + 3s candidate wait + up to 10s WHEP POST =
            // 15.5s of a 15s budget, leaving half a second for the actual ICE
            // connection. A remote or relayed viewer — exactly the audience the
            // tunnel serves — that would connect at 16s was torn down at 15s, and
            // every retry repeated it identically, so it could never play. LAN
            // viewers connect in ~50ms and never noticed, which is why this
            // survived so long.
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            connectTimeout = setTimeout(() => {
                if (isConnecting && !isConnected) {
                    console.warn("[WebRTC] No ICE connection 15s after the SDP answer.");
                    handleDisconnected();
                }
            }, 15000);
            
        } catch (error) {
            if (error && error.name === 'AbortError') {
                // Either a teardown already ran, or the WHEP POST outlived
                // whepPostTimeout (10s). A late answer must not be applied to the
                // next peer connection or resurrect a session that no longer
                // exists.
                console.log("[WebRTC] WHEP request aborted. Abandoning the attempt.");
                // Only tear down if this attempt is still the current one. An
                // abort that belongs to a SUPERSEDED session must not paint the
                // page offline behind the newer session's live picture, and must
                // not run cleanupConnection on its live peer connection.
                if (superseded()) {
                    console.log("[WebRTC] ...but this session was already superseded; leaving current state alone.");
                    return;
                }
                // Do NOT simply clear isConnecting here. The 16s connectTimeout
                // is gated on `isConnecting && !isConnected`, and only
                // handleDisconnected() re-arms the status poll — so clearing the
                // flag alone leaves a hung-POST attempt with no watchdog, no
                // cleanupConnection (the PeerConnection stays open, still
                // gathering and holding a UDP socket, and no WHEP DELETE is ever
                // sent) and no retry. Measured: after 60s the UI is still on
                // "connecting" with the PC open, 1 POST, 0 DELETEs and zero
                // pending timers — permanently stuck until a manual reload.
                // handleDisconnected clears both flags, runs the teardown, paints
                // offline and calls schedulePoll, and is idempotent when a
                // teardown already did the work.
                handleDisconnected();
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

    // The rendition seam is open from the moment switchRendition tears the old
    // session down until the element is actually showing the replacement. Any
    // ontrack that hands the element a stream belonging to the CURRENT session
    // closes it — not just the video track of the seam branch below. A WHEP
    // answer routinely delivers AUDIO first, and that first track is exactly
    // the one that rebuilds srcObject; the branch it takes sets
    // elementStreamSessionId without touching the flag, so the 12s watchdog
    // stayed armed and fired on a session that was already healthy — pausing
    // the element, nulling srcObject and calling connectStream() while
    // isConnected was still true, which refuses to start. That is the exact
    // failure the watchdog exists to prevent, caused by the watchdog.
    function closeRenditionSeam() {
        switchSeamPending = false;
        if (switchSeamTimer) {
            clearTimeout(switchSeamTimer);
            switchSeamTimer = null;
        }
    }

    // Gracefully clean up connection and send WHEP DELETE to server.
    // keepPicture=true is the ABR path: it releases every network resource but
    // deliberately leaves `player.srcObject` attached. The old MediaStream's
    // track is ended by the pc.close() below, so the element freezes on the
    // LAST DECODED FRAME instead of going black, until the new pc's ontrack
    // swaps in the new stream. Nulling srcObject here (the old behaviour) made
    // every rendition switch a guaranteed black screen: 2-4s of it per switch
    // against the project's own WHEP + keyframe figure, which is 120-240
    // dropped frames at 60fps. Simulated against the real thresholds that is
    // 21-30s of hard black per 10-minute session (3.5-5%) on any link that
    // alternates stressed/calm — i.e. every hotspot and every tailnet.
    function cleanupConnection(keepPicture = false) {
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
        // The ICE-gather window is the one await in connectStream() that the
        // abort controller above cannot reach. Leaving its timer live is what
        // kept a torn-down attempt resident for a further 3 seconds.
        if (gatherTimeout) {
            clearTimeout(gatherTimeout);
            gatherTimeout = null;
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
                // This one was the only handler missing from the teardown list.
                // It calls addSystemMessage, so a candidate error from a
                // gathering pass still in flight at teardown posted a chat
                // warning AFTER the offline banner, for a session that no longer
                // existed.
                peerConnection.onicecandidateerror = null;
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
        if (keepPicture) {
            // Leave the element alone. `clearSeamWatchdog()` in switchRendition
            // guarantees the stale stream cannot survive if the replacement
            // handshake never produces a track.
            //
            // The seam's own 12s safety net IS cancelled, though. It was the
            // only timer cleanupConnection did not know about, so an ICE failure
            // or grace expiry landing inside the 12s window after a switch tore
            // everything down, painted offline, and then — 12 seconds later —
            // had the orphan fire and reconnect on its own, flipping the page
            // offline -> connecting -> live by itself. It also has to clear the
            // pending flag, or the NEXT session's first ontrack would take the
            // seam branch and swap in a stream on a teardown that never asked
            // for a switch.
            if (switchSeamTimer) {
                clearTimeout(switchSeamTimer);
                switchSeamTimer = null;
            }
            switchSeamPending = false;
            return;
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
    //
    // This is the single choke point for EVERY path change — ABR steps, the
    // connected-but-black limbo rejoin, the drift rejoin and the decode-pressure
    // hardware-path hop all come through here — so its per-switch cost is paid
    // repeatedly on exactly the marginal links that need help most. It therefore
    // hands the old frame to the new session instead of destroying it, and it
    // honours a viewer who paused rather than silently resuming them.
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
        // A paused viewer is invisible to the controllers that can rebuild the
        // session (RTP keeps arriving while paused, so loss and jitter look
        // "stressed" forever), but a rebuild must not override their choice.
        const wasPaused = player.paused;
        viewerPausedByChoice = wasPaused;
        // ORDER MATTERS. `switchSeamPending` is armed AFTER cleanupConnection
        // returns, never before it. cleanupConnection(true) clears the flag as
        // part of its own teardown (a hard teardown that lands inside the seam
        // window must not leave the next session's first ontrack thinking it is
        // a replacement), so setting the flag first and then calling it meant
        // the callee undid the arm on the very next statement — synchronously,
        // with no await in between. The flag could therefore never be observed
        // true anywhere, the seam branch in ontrack was unreachable dead code,
        // and every rendition switch fell through to the generic "append to the
        // old stream" branch, which is precisely what the seam exists to
        // prevent: cleanupConnection(true) deliberately leaves the previous
        // (now ended) stream on screen so the picture is not lost mid-switch,
        // and a video element renders its FIRST video track. It happened to work
        // only because Chrome's selectVideoTracks skips ended tracks. It is also
        // why the audio-drop fix in ontrack had no effect — that code lives
        // inside the seam.
        cleanupConnection(true);
        // Safety net for the seam: if the replacement handshake never yields a
        // track, the stale (now-ended) stream would otherwise stay on screen
        // indefinitely. 12s is far beyond the 10s WHEP cap, so this only fires
        // on a genuine failure, and it fails LOUDLY to a real reconnect.
        switchSeamPending = true;
        switchSeamTimer = setTimeout(() => {
            switchSeamTimer = null;
            switchSeamPending = false;
            console.warn("[ABR] Replacement rendition produced no track in 12s; forcing a hard reconnect.");
            if (player.srcObject) { player.pause(); player.srcObject = null; }
            cleanupConnection();
            viewerPausedByChoice = false;
            // closeRenditionSeam() normally fires from ontrack the moment the
            // replacement track lands, so reaching this callback means the
            // handshake genuinely never produced one. It must still reset the
            // connection flags before reconnecting: connectStream() returns
            // immediately when isConnecting || isConnected, and a partially
            // completed attempt leaves isConnecting true — so the "recovery"
            // silently did nothing and the viewer was left on a torn-down
            // session with a null srcObject and no attempt in flight, which is
            // the permanent wedge this watchdog is supposed to prevent.
            isConnected = false;
            isConnecting = false;
            connectStream();
        }, 12000);
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
    let returnDriftChecks = 0;   // Consecutive over-cap hidden-span readings (see maybeRejoinOnReturn)
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
            const capMs = Math.max(config.driftLimitMs + 1600, 3100);
            // PERSISTENCE, exactly as the periodic supervisor requires. A single
            // windowed reading is not enough to justify tearing a working session
            // down: this measurement covers the whole hidden span, and the
            // project's own live numbers put a normal Alt-Tab at 1.7-2.8s —
            // within 300ms of the 3.1s trip point. One-shot here meant every
            // slightly-long tab switch could end in a hard 2-5s freeze, and the
            // 60s cooldown let it repeat. The in-loop path needs 3 consecutive
            // bad ticks; this path now needs the same, spread over successive
            // returns/checks, so a healthy session is never dropped for one
            // noisy reading.
            if (avgPlayoutDelayMs !== null && avgPlayoutDelayMs > capMs) {
                returnDriftChecks += 1;
            } else {
                returnDriftChecks = 0;
            }
            if (returnDriftChecks >= 3) {
                returnDriftChecks = 0;
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
            // The rendition-ladder poll is part of that promise: a hidden tab
            // needs no ABR ladder, and Chrome throttles the timer to ~1/min
            // anyway. startRenditionPathsPoll() re-arms with an immediate
            // fresh snapshot the moment the tab returns.
            if (renditionPollInterval) {
                clearInterval(renditionPollInterval);
                renditionPollInterval = null;
            }
            stopAudioMeter();
        } else {
            console.log("[App] Tab foregrounded. Resuming polling/telemetry...");
            lastFrameTime = performance.now();
            frozenSince = 0;
            if (isConnected) {
                beginStatsLoop();
                startRenditionPathsPoll();
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

    // True when this browser can decode HEVC/H265 inside a WebRTC peer
    // connection. Support is still rare (Safari 18+, flag-gated Chrome), and
    // MediaMTX happily answers a WHEP handshake with an H265 stream a browser
    // cannot decode — a black-screen session. Mirrors browserSupportsAv1.
    function browserSupportsH265() {
        try {
            if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return false;
            const caps = RTCRtpReceiver.getCapabilities('video');
            if (!caps || !Array.isArray(caps.codecs)) return false;
            return caps.codecs.some((c) => {
                if (!c || typeof c.mimeType !== 'string') return false;
                const mime = c.mimeType.toLowerCase();
                return mime.includes('h265') || mime.includes('hevc');
            });
        } catch (err) {
            console.warn('[Polling] H265 capability probe failed, assuming unsupported:', err);
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
    // h265Capable (probed by the caller via RTCRtpReceiver capabilities):
    // a browser WITHOUT H265 receive support must never be sent to the native
    // path of an H265 source — MediaMTX would answer the handshake with a
    // stream the decoder cannot touch (connected, black, forever). Such a
    // viewer rides the bridge's live-av1 rendition exactly like a legacy
    // browser on an AV1 source, waiting for it when it is still starting.
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
    function chooseStreamPath(items, av1Capable, av1Smooth = true, preference = 'auto', h265Capable = true) {
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
        // H265 source + a browser without H265 receive capability: the native
        // path is undecodable there, so route it to the AV1 rendition the
        // bridge publishes for H265 sources (it also carries the rescued
        // Opus audio of an RTMP/SRT broadcast), waiting when it is not up.
        const sourceIsH265 = upperTracks.includes('H265') || upperTracks.includes('HEVC');
        if (sourceIsH265 && h265Capable === false) {
            return ready('live-av1') ? 'live-av1' : null;
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
                    await probeAv1DecodeSmooth(),
                    'auto',
                    browserSupportsH265()
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
        lastFramesReceived = 0;
        lastFramesDiscarded = 0;
        decodeLagSec = 0;
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
        adaptiveRaiseLevelMs = 0;
        lastNetJitterMs = null;
        lastLossPct = null;
        avgPlayoutDelayMs = null;
        avgPlayoutDelayAt = 0;
        lastJitterDelayTotal = 0;
        lastJitterEmittedTotal = 0;
        lastAppliedTargetMs = null;
        lastAppliedTargetChangeAt = 0;
        jitterFloorTick = 0;
        stage2AttemptedThisSession = false;
        returnDriftChecks = 0;
        recentDropAt = -Infinity;
        bufferNoticeState = '';
        accommodationTargetMs = 0;
        accommodationCalmTicks = 0;
        // noMediaRejoinCount is deliberately NOT reset here. It used to be, and
        // that made the "connected-but-black" budget unreachable: the limiter
        // calls switchRendition(), which reconnects through this very function,
        // so the count could never exceed 1 — the cap of 3 and the
        // "broadcast may be incompatible" notice at the 4th attempt were dead
        // code, and a permanently black broadcast instead looped a full WHEP
        // teardown + reconnect + a user-visible message every ~11s, forever.
        // The budget is per-BROADCAST, not per-session: it is restored by the
        // `decoded > 0` branch in the stats loop, so a broadcast that works
        // (now or later) hands the budget back, which is exactly what the
        // original per-session reset was trying to achieve.
        jitterFloorEmaMs = 0;
        abrBadSec = 0;
        abrCalmSec = 0;
        // lastRenditionSwitchAt is deliberately NOT reset here. It is a rate limit
        // on switch ACTIONS, not a measurement baseline. switchRendition() and
        // maybeRejoinOnReturn() stamp it and then reconnect through this function
        // (handleConnected -> startTelemetry), so clearing it here reopened the
        // 60s cooldown on the very next stats tick: a link that stayed under
        // stress could switch renditions every ~8s (abrBadSec >= 8) instead of at
        // most once a minute — the exact reconnect storm the cooldown exists to
        // prevent. Fresh sessions are unaffected either way, because the anchor is
        // initialised to -60000 at declaration and an anchor from a long-gone
        // session is already older than the cooldown.
        renditionPathsItems = null;
        lastPresentedFrames = 0;
        lastPresentedFramesAtTick = 0;
        lastPresentedTickAt = 0;
        lastRouteText = '--';
        lastRecoveryCounts = null;
        // Never let the previous session's counters be the watchdog's baseline.
        inboundSnapshot = null;
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

            // A slow getStats() (low-end receiver under decode load — the
            // exact viewer this session is trying to protect) must not let
            // the next 1s tick run while this one is mid-flight: overlapping
            // ticks both compute their deltas from the SAME baseline and
            // double-count one window of loss/jitter/drops into the ABR,
            // accommodation and Eco Mode state machines. Skipping a tick is
            // free; a spurious stress spike is not.
            if (statsTickInFlight) return;
            statsTickInFlight = true;

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
                    // The decoder's OWN drops. This is a per-second gauge in the
                    // spec, not a cumulative counter, so it is read as a level and
                    // differenced against the previous level. Absent in browsers
                    // that do not implement it, hence the 0 fallback.
                    const discardedLevel = Number.isFinite(videoStats.framesDiscarded)
                        ? videoStats.framesDiscarded : 0;
                    // Publish for the freeze watchdog (one getStats walk per
                    // second, shared) — see inboundSnapshot above.
                    inboundSnapshot = {
                        decoded,
                        bytes: videoStats.bytesReceived || 0,
                        at: performance.now()
                    };
                    if (hudFrames) hudFrames.innerText = `${decoded} / ${dropped} (Recv:${received})`;

                    // Connected-but-black limbo: the WHEP handshake and ICE
                    // both succeeded yet no frame EVER decoded — the publisher
                    // vanished between the status probe and the handshake, or
                    // the offered codec cannot decode on this device. The
                    // freeze watchdog cannot fire here (it needs bytes to flow
                    // AND at least one decoded frame), so this state would sit
                    // black forever. Rejoin the session, capped so a genuinely
                    // broken broadcast cannot rejoin in an unbounded loop.
                    if (decoded === 0 && performance.now() - connectionStartTime > 10000) {
                        noMediaRejoinCount += 1;
                        if (noMediaRejoinCount <= 3) {
                            console.warn('[FreezeGuard] No video frame decoded 10s after connecting — rejoining the session.');
                            switchRendition(activeStreamPath,
                                'No video arrived on this session — rejoining at the live edge…');
                            return;
                        }
                        if (noMediaRejoinCount === 4) {
                            addSystemMessage('⚠️ Still no video after several rejoin attempts — this broadcast may be '
                                + 'incompatible with this browser. Try reloading the page or another browser.');
                        }
                    } else if (decoded > 0) {
                        noMediaRejoinCount = 0;
                    }

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
                    // This flag is read TWICE in one tick: once here to seed the
                    // rolling drop window, and again ~100 lines below to decide
                    // whether the accommodation controller may act. The first
                    // read cleared it, so the second was statically always
                    // false and the tab-return re-baseline never ran — the
                    // guard's own comment describes the exact damage it exists
                    // to prevent, and it was dead code. Capture the intent once
                    // and use it for both.
                    const rebaseThisTick = dropTickPending;
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
                            // The floor ratchets UP on any tick (a bigger buffer
                            // is always safe) but is only allowed to step back
                            // down every JITTER_FLOOR_DECAY_EVERY_TICKS ticks.
                            // Decaying 25ms every tick meant 24 consecutive
                            // jitterBufferTarget writes after one spike.
                            jitterFloorTick += 1;
                            jitterFloorEmaMs = jitterBufferFloorMs(
                                lastNetJitterMs,
                                jitterFloorEmaMs,
                                jitterFloorTick % JITTER_FLOOR_DECAY_EVERY_TICKS === 0
                            );
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
                        if (windowedDelayMs !== null) {
                            avgPlayoutDelayMs = windowedDelayMs;
                            // Stamped so the drift supervisor can tell a live
                            // reading from one that has been latched through a
                            // quiet window.
                            avgPlayoutDelayAt = performance.now();
                        }
                        const emittedDelta = videoStats.jitterBufferEmittedCount - lastJitterEmittedTotal;
                        lastJitterDelayTotal = videoStats.jitterBufferDelay;
                        lastJitterEmittedTotal = videoStats.jitterBufferEmittedCount;
                        // Accommodation feeds off the measured delay but only
                        // RAISES while late frames are actually being
                        // discarded and the buffer has outgrown the base
                        // target. Sustained calm drains the extra latency back
                        // 50ms per tick.
                        //
                        // The raise needs an INDEPENDENT late-frame signal.
                        // windowedPlayoutDelayMs is a mean over the frames that
                        // LEFT the jitter buffer, so late-discarded frames are
                        // excluded from both numerator and denominator — the
                        // mean is computed over exactly the frames that were
                        // not late, and systematically under-reports. Gating on
                        // it (plus a 150ms margin) made the anti-stutter path
                        // structurally unreachable: simulated end to end, a slow
                        // link discarding 13 frames in 60s peaked at 153ms
                        // against a 180+150ms requirement, and the target never
                        // moved once — the controller was blind to the exact
                        // condition it exists to catch. `emitted < received`
                        // counts frames that arrived but did not make it out of
                        // the buffer, which no mean can hide.
                        const lateFrameEvidence = Number.isFinite(videoStats.framesReceived)
                            && Number.isFinite(emittedDelta)
                            && (videoStats.framesReceived - lastFramesReceived) > emittedDelta;
                        // The first tick after a (re)start — including a tab
                        // return — spans the whole hidden span, so its drop and
                        // delay figures are not this window's. The stats loop is
                        // off while hidden, so using them would let every
                        // background-tab return snap the accommodation to
                        // ~2200ms (the code's own comment puts a hidden span at
                        // 1.7-2.8s) and leave it inert for the rest of the
                        // session. Re-baseline instead of acting.
                        if (rebaseThisTick) {
                            accommodationCalmTicks = 0;
                        } else {
                            if (droppedDelta > 0) {
                                // Marks the current window as one where late
                                // frames are genuinely being discarded, which is
                                // what lets reapplyBufferTargets() skip its dwell
                                // for the protective raise.
                                recentDropAt = performance.now();
                                accommodationCalmTicks = 0;
                            } else {
                                accommodationCalmTicks += 1;
                            }
                            accommodationTargetMs = bufferAccommodationMs(
                                avgPlayoutDelayMs, accommodationTargetMs,
                                baseBufferTargetMs(), droppedDelta > 0 || lateFrameEvidence,
                                accommodationCalmTicks);
                        }
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
                    const discardedDelta = Math.max(0, discardedLevel - lastFramesDiscarded);
                    if (timeDiffSec > 0.5 && receivedDelta >= 15) {
                        decodeLagSec = updateDecodeLag(decodeLagSec, decodedDiff, receivedDelta, discardedDelta);
                    } else if (timeDiffSec > 0.5) {
                        decodeLagSec = decayDecodeLag(decodeLagSec);
                    }
                    lastFramesReceived = received;
                    lastFramesDiscarded = discardedLevel;

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
            } finally {
                statsTickInFlight = false;
            }
        }, 1000);
    }

    function stopTelemetry() {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
        // The freeze watchdog reads this snapshot; a stopped loop must not leave
        // a live-looking one behind for it to keep comparing against.
        inboundSnapshot = null;
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
                iceCandidateError: iceErrorNoticed ? 'STUN/TURN unreachable this session (see console)' : 'none',
                noMediaRejoins: noMediaRejoinCount,
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
        freezeCheckInterval = setInterval(() => {
            // Skip all freeze detection while the user deliberately paused playback:
            // frames stop presenting and decode can suspend, which would read as a false stall.
            if (!isConnected || isRecovering || !peerConnection || player.paused || document.hidden) return;

            const now = performance.now();
            const frameStaleness = now - lastFrameTime;

            // Read the stats loop's snapshot instead of issuing a second
            // getStats() walk of its own. A snapshot older than the staleness
            // bound means the producing loop is not running, which is itself a
            // fault but not a decoder stall — re-baseline and try again rather
            // than reading a frozen reading as "bytes stopped".
            const snapshot = inboundSnapshot;
            if (!snapshot || now - snapshot.at > INBOUND_SNAPSHOT_MAX_AGE_MS) {
                return;
            }
            const currentDecoded = snapshot.decoded;
            const currentBytes = snapshot.bytes;

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
            // Time-bounded: on a session with no media the play() promise
            // stays pending forever (nothing will ever reach HAVE_FUTURE_DATA),
            // and awaiting it unconditionally would wedge recovery here with
            // isRecovering stuck true — disabling the watchdog for good.
            await Promise.race([
                player.play(),
                new Promise((resolve) => setTimeout(resolve, 1500))
            ]).catch(() => {});
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
        // Gated, and only ONCE per session. Reassigning srcObject is not a cheap
        // "flush": it tears down and rebuilds the whole media element pipeline
        // (readyState -> 0, decoder reset, new renderer), so it GUARANTEES a
        // multi-hundred-millisecond picture freeze and throws away the jitter
        // buffer that was carefully sized for this link. Run on every watchdog
        // trip (up to MAX_RECOVERIES) it turned a marginal link — the exact
        // link that trips the watchdog repeatedly — into visible stutter on top
        // of whatever it was already struggling with. It is worth attempting
        // only when the element has genuinely lost its media, and never twice.
        const canAttemptStage2 = !stage2AttemptedThisSession
            && peerConnection
            && peerConnection.connectionState === 'connected';
        if (canAttemptStage2) {
            try {
                stage2AttemptedThisSession = true;
                console.log("[FreezeGuard] Attempting Stage 2 decoder flush...");
                const videoReceivers = peerConnection.getReceivers().filter(r => r.track && r.track.kind === 'video');
                if (videoReceivers.length > 0) {
                    const freshStream = new MediaStream();
                    peerConnection.getReceivers().forEach(r => {
                        if (r.track) freshStream.addTrack(r.track);
                    });
                    player.srcObject = freshStream;
                    elementStreamSessionId = currentSessionId;
                    // Same invariant as the ontrack branches: the element is now
                    // showing THIS session, so a pending rendition seam is over.
                    // The freeze watchdog is stopped at the top of a switch, but
                    // a recovery queued beforehand can still land here, and
                    // leaving the 12s net armed would have it tear down a
                    // session that had just been successfully rebuilt.
                    closeRenditionSeam();
                    // Same bound as stage 1, and the flush now has to PROVE it
                    // restored playback — an unchecked return skipped stage 3
                    // (the only stage that can fix a broken session) whenever
                    // the rebind resolved without actually producing frames.
                    await Promise.race([
                        player.play(),
                        new Promise((resolve) => setTimeout(resolve, 1500))
                    ]).catch(() => {});
                    await new Promise(r => setTimeout(r, 150));
                    if (player.readyState >= 3 && !player.paused) {
                        lastFrameTime = performance.now();
                        isRecovering = false;
                        ensureVideoFrameCallback();
                        console.log("[FreezeGuard] Stage 2 decoder flush succeeded!");
                        return;
                    }
                    console.warn("[FreezeGuard] Stage 2 flush did not restore playback, proceeding to Stage 3.");
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

    // The level meter stops its own rAF loop when there is nothing to measure
    // (muted, paused, disconnected) instead of spinning at display rate. These
    // two events are every path back into a measurable state, so they re-arm it.
    player.addEventListener('volumechange', startAudioMeter);
    player.addEventListener('play', startAudioMeter);
    player.addEventListener('playing', startAudioMeter);

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
        // setMasterGain owns player.volume on both paths (it sets 1.0 once the
        // WebAudio graph is wired, so the element is only the multiplier
        // before that). Writing it here too fired TWO volumechange events per
        // wheel notch whose net effect was zero, and each fanned out to
        // syncUnmuteOverlay (a style write + setAttribute on the overlay
        // layered over the video) and to the audio meter — a burst of overlay
        // style writes inside the same task as video presentation.
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
            const modes = ['ultra', 'balanced', 'smooth', 'cinema'];
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
            adaptiveRaiseLevelMs = 0;
            accommodationTargetMs = 0;
            accommodationCalmTicks = 0;
            bufferNoticeState = '';
            lastAppliedTargetMs = null;
            updateBufferHud(null);

            // Apply immediately to active receivers. An explicit user choice is
            // never gated by the churn limiter — but it does stamp the dwell
            // anchor, so the very next adaptive tick cannot immediately undo it.
            if (peerConnection) {
                peerConnection.getReceivers().forEach(r => {
                    // Both kinds, same target — see reapplyBufferTargets(): a
                    // mode switch that moves only video leaves the audio
                    // receiver at the old depth until the next stats tick,
                    // which the element renders as a lip-sync jump.
                    if (r.track) {
                        applyPlayoutDelay(r, r.track.kind);
                    }
                });
                lastAppliedTargetMs = currentBufferTargetMs();
                lastAppliedTargetChangeAt = performance.now();
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

    // Single place that turns Eco Mode on or off, so the manual toggle, the
    // stored preference and the device heuristic can never disagree about the
    // resulting class/label/pressed state.
    function applyPerfMode(on) {
        if (!perfToggleBtn) return;
        document.body.classList.toggle('perf-mode', on);
        perfToggleBtn.classList.toggle('active', on);
        perfToggleBtn.setAttribute('aria-pressed', String(on));
        if (perfToggleLabel) perfToggleLabel.innerText = on ? 'Eco Mode' : 'Turbo GPU';
    }

    // Reduce decorative effects for a simpler, lower-motion display.
    if (perfToggleBtn) {
        perfToggleBtn.addEventListener('click', () => {
            const isPerf = !document.body.classList.contains('perf-mode');
            applyPerfMode(isPerf);
            // Persist the manual choice so the low-end auto heuristic never overrides it
            try { localStorage.setItem('rydius_perf_mode', isPerf ? '1' : '0'); } catch (e) {}
            addSystemMessage(isPerf ? "Eco Mode enabled (GPU optimized)" : "Turbo GPU enabled (Full visual fidelity)");
        });

        let storedPerfChoice = null;
        try { storedPerfChoice = localStorage.getItem('rydius_perf_mode'); } catch (e) {}

        if (storedPerfChoice === '1' || storedPerfChoice === '0') {
            // An EXPLICIT choice is restored verbatim, in both directions. The
            // stored-Eco case was never restored at all (the heuristic below
            // re-enabled it only on a <=4-core device), so a viewer who had let
            // Eco switch itself on paid full-price compositing from page load
            // until the first drop storm. The stored-Turbo case was worse: the
            // guard read `!== '1'`, so an explicit "Turbo GPU" was treated as
            // "no choice" and the heuristic below switched Eco back on, which is
            // the exact opposite of what this block's own comment promises.
            applyPerfMode(storedPerfChoice === '1');
        } else {
            // No stored choice: infer from what the device advertises.
            // `hardwareConcurrency <= 4` alone is a poor test for the viewers
            // this project actually has — a modern iPhone (A14 and later)
            // reports SIX cores, so every current iPhone sailed past it and ran
            // the full blur/blur/animated-noise stack while software-decoding
            // or hardware-decoding a 1080p60 stream. deviceMemory is a better
            // proxy for the phones that matter, and a coarse pointer is a decent
            // "this is a thermally-constrained handheld" signal.
            const cores = navigator.hardwareConcurrency || 8;
            const memoryGb = Number(navigator.deviceMemory) || 8; // spec clamps to 0.25-8
            const handheld = typeof matchMedia === 'function'
                && matchMedia('(pointer: coarse)').matches;
            const weakDevice = cores <= 4 || memoryGb <= 4 || (handheld && cores <= 6);
            if (weakDevice && !document.body.classList.contains('perf-mode')) {
                applyPerfMode(true);
                console.log(`[UI] Constrained device detected (${cores} cores, ${memoryGb}GB, `
                    + `coarse pointer: ${handheld}). Eco Mode auto-enabled before first paint cost.`);
            }
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
    //
    // The write is guarded because it targets the ROOT element's inline style,
    // and a root custom-property/style write is the broadest invalidation
    // Blink offers. This runs on every qualifying mousemove (>=25px of travel,
    // which a viewer moving a mouse generates many times per second), and
    // outside fullscreen `hide` is always false — so the value being written
    // was identical to the value already there, over and over. Skipping the
    // no-op write costs nothing and removes the question entirely.
    let lastCursorHidden = null;
    function applyCursorState() {
        const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const hide = inFs && !videoContainer.classList.contains('controls-active');
        if (lastCursorHidden === hide) return;
        lastCursorHidden = hide;
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
            // Never fade the bar out from UNDER a focused control. The idle state
            // is `visibility: hidden` (so the layer leaves the render tree instead
            // of compositing over live video every frame), and visibility:hidden
            // also unfocuses its descendants — so a bar that faded while the
            // volume slider held focus would silently throw keyboard focus back
            // to <body> mid-interaction. Tab still reveals the bar (the document
            // keydown handler re-arms it on any key), so this covers the case
            // after focus has already landed.
            if (videoContainer.contains(document.activeElement)) {
                resetControlsTimer('focus-held');
                return;
            }
            // In fullscreen NOTHING may block the fade: a stale focus or an
            // open HUD pinned the bar in earlier builds. windowed mode still
            // keeps it up while paused so the play button stays obvious.
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

    // A reaction spawns a composited, animated layer ON TOP of the live video.
    // Aggregate rate here is (per-viewer reaction rate x viewer count), so a
    // hype train could put 100+ drop-shadowed layers over the picture at once
    // — the single most reliable way to make good playback look bad. Cap the
    // live count; the button pop and counter still fire for every reaction, so
    // the social signal survives, only the overlay density is bounded.
    const MAX_FLYING_EMOJI = 8;
    let liveFlyingEmoji = 0;
    let videoContainerWidth = 0;
    function measureVideoContainer() {
        videoContainerWidth = videoContainer ? (videoContainer.clientWidth || 320) : 320;
    }
    if (videoContainer && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(measureVideoContainer).observe(videoContainer);
    } else if (videoContainer) {
        window.addEventListener('resize', measureVideoContainer);
    }
    measureVideoContainer();

    function spawnFloatingEmoji(emojiChar) {
        if (!videoContainer) return;
        // Forced layout: clientWidth after a DOM write costs a synchronous
        // reflow. The container only changes size on resize, so the width is
        // measured there instead of on every reaction.
        if (!videoContainerWidth) measureVideoContainer();
        // Counted rather than querySelectorAll'd: this runs on a broadcast that
        // can arrive many times a second, and a subtree query per spawn is both
        // a needless DOM walk and a reflow trigger.
        if (liveFlyingEmoji >= MAX_FLYING_EMOJI) return;
        const floating = document.createElement('div');
        floating.className = 'flying-emoji';
        floating.innerText = emojiChar;

        const width = videoContainerWidth;
        const randomX = Math.floor(Math.random() * Math.max(40, width - 80)) + 30;
        const swayX = (Math.random() * 60 - 30).toFixed(1) + 'px';
        const swayRot = (Math.random() * 24 - 12).toFixed(1) + 'deg';

        floating.style.left = `${randomX}px`;
        floating.style.setProperty('--sway-x', swayX);
        floating.style.setProperty('--sway-rot', swayRot);

        videoContainer.appendChild(floating);
        liveFlyingEmoji += 1;

        setTimeout(() => {
            liveFlyingEmoji = Math.max(0, liveFlyingEmoji - 1);
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
        // Prune here too, not only on the receive path. The sender's own echoed
        // message hits the early `return` above, so it never reaches the prune
        // there — a viewer sending alone grew this set 1:1 with their own
        // messages and the stated 500 cap never held.
        if (seenClientMsgIds.size > 500) {
            const oldest = seenClientMsgIds.values().next().value;
            seenClientMsgIds.delete(oldest);
        }

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

    // Autoscroll the log to the newest message. Reading scrollHeight immediately
    // after appendChild is a forced SYNCHRONOUS layout: the DOM has been
    // mutated and the next geometry read forces Blink to lay out the whole
    // sidebar right there, on the main thread, mid-frame. One per message means
    // a chat burst costs one full layout per message — and the reader is
    // decoding video on the same thread. Deferring the read to the next
    // animation frame lets a whole burst coalesce into ONE layout before the
    // next paint, which is what the browser would have done anyway. The log
    // already caps at 100 children, so the deferred read stays cheap.
    let chatScrollScheduled = false;
    function scheduleChatAutoscroll() {
        if (chatScrollScheduled) return;
        chatScrollScheduled = true;
        requestAnimationFrame(() => {
            chatScrollScheduled = false;
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

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
        scheduleChatAutoscroll();

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
        scheduleChatAutoscroll();

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
        // A session that was limping through the outage is torn down at once:
        // its ICE path belongs to a network that no longer exists, so waiting
        // out the 2.5s disconnected-grace cannot self-heal anything.
        if (isConnected && peerConnection && peerConnection.connectionState === 'disconnected') {
            if (disconnectGraceTimer) {
                clearTimeout(disconnectGraceTimer);
                disconnectGraceTimer = null;
            }
            handleDisconnected();
            return;
        }
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
