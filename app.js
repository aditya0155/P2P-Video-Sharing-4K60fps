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
    const chatToastLayer = document.getElementById('chat-toast-layer');
    const chatUnreadBadge = document.getElementById('chat-unread-badge');
    
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
        // Resume must start from a clean live edge. A viewer who pauses mid catch-up
        // leaves `catchUpRate` cached above 1.0 while the element holds it too, and
        // superviseAdaptiveBuffer() returns early for the whole pause, so without
        // this the resume either takes a visible rate step or never commands the
        // return to 1.0x promptly. This is the reset the supervisor's own comment
        // claims exists.
        resetLiveEdgeCatchUp();
        // A resume is also the cheapest possible answer to a stale frame clock: the
        // freeze watchdog idles while paused, so on resume its first poll would
        // otherwise see a frameStaleness equal to the entire pause duration. For a
        // 4K stream waiting on a fresh keyframe that is routinely >6s, which armed
        // frozenSince and fired Stage 3 — a 2-4s black screen — on a session that
        // was merely resuming.
        lastFrameTime = performance.now();
        frozenSince = 0;
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
    let whepPostTimeout = null;          // Aborts a hung WHEP POST quickly instead of waiting for the 26s connect watchdog
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
    let connectTimeout = null;           // 26s connection watchdog timer
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
    let lastRetransmittedPackets = 0;   // RTX baseline (packetsReceived includes retransmits)
    let lastPacketsDiscarded = 0;       // Baseline for SFU-side drop detection
    let lastFramesDropped = 0;          // Baseline for frame-drop pressure detection
    let lastPlrPct = null;              // Picture-loss ratio over the last stats window (%)
    let lastRepairRatePct = null;       // Share of loss repaired by RTX in the last window (%)
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
    // A SEPARATE baseline for the decode-pressure denominator. It must never be
    // shared with lastJitterEmittedTotal: the playout-delay measurement divides a
    // jitterBufferDelay total by the emitted delta and therefore needs both
    // baselines to advance in lockstep, while the decode measurement is read
    // outside that block and needs its own clock. Sharing one of them
    // desynchronises the pair and inflates the measured delay by the number of
    // ticks they drifted apart.
    let lastJitterEmittedForDecode = 0;
    let lastAppliedTargetMs = null;     // Last target pushed to receivers (change detection)
    let lastAppliedTargetChangeAt = 0;  // performance.now() of the last applied change (dwell gate)
    let jitterFloorTick = 0;            // Stats ticks since the jitter floor was last allowed to decay
    const JITTER_FLOOR_DECAY_EVERY_TICKS = 5;
    let bufferNoticeState = '';         // 'raised' | '' (system-message dedupe)
    let renditionWaitPolls = 0;         // Consecutive polls waiting for a compatible rendition
    let renditionWaitWarned = false;    // AV1-only viewer notice dedupe per broadcast
    let accommodationTargetMs = 0;      // Buffer target raised to meet the measured delay
    let accommodationCalmTicks = 0;     // Consecutive drop-free stats ticks (gates the decay)
    // Live-edge catch-up state (see catchUpPlaybackRate / updateLiveEdgeCatchUp).
    let catchUpRate = 1;                // Last playbackRate this controller wrote
    let catchUpProbeAt = 0;             // performance.now() when the current catch-up engagement began
    let catchUpProbeDelayMs = null;     // Measured playout delay at that moment
    let catchUpProvenUseless = false;   // playbackRate did not drain the buffer on this device
    // Dwell between playbackRate writes. Every write resets the media pipeline's
    // A/V sync state (the file says so at updateLiveEdgeCatchUp), so a controller
    // that re-writes the rate every second is a 1 Hz self-inflicted re-sync. The
    // rate law itself has a symmetric 120ms dead band, and avgPlayoutDelayMs is a
    // windowed MEAN over emitted frames, so on any real link it crosses that band
    // back and forth between consecutive 1s windows: 119ms one tick, 121ms the
    // next. Simulated against the real law that is 1.00 -> 1.01 -> 1.00 -> 1.01
    // forever, with zero packet loss and zero dropped frames in the stats - the
    // exact "very short but continuous" symptom. The law stays symmetric (it is
    // unit-tested for ramp shape); the ASYMMETRY lives here, in the gate.
    let lastCatchUpWriteAt = 0;
    // Consecutive ticks the delay has been above the engage band. Only the ENGAGE
    // direction needs proving; a release is gated by the rate law's own dead band,
    // which already prevents it while the delay is genuinely over target.
    let catchUpAboveBandTicks = 0;
    // --- Presentation evenness (the "0% loss but not smooth" detector) -------
    // Every existing control input is a NETWORK or BUFFER quantity (loss, jitter,
    // measured playout delay, drops). None of them can see the thing a viewer
    // actually reports: frames arriving at the compositor at uneven intervals
    // while every one of those counters reads clean. rVFC already hands us the
    // wall-clock gap between presented frames; what was missing was any use of
    // it. See noteFramePresentation() and frameGapUnevenness().
    // A sliding window of recent presented-frame intervals. At 60fps, 90 samples
    // is ~1.5s of picture: long enough that one dropped frame is a rounding
    // error, short enough that a link which recovers stops looking uneven.
    let frameGapWindow = [];
    const FRAME_GAP_WINDOW = 90;
    let unevenStreakTicks = 0;         // Consecutive stats ticks with uneven presentation
    let unevenWidenApplied = false;    // One widen per session (never a repeating pulse)
    let unevenReleaseTicks = 0;        // Consecutive clean ticks before the floor steps down
    // The evenness widen, as a FLOOR on the base target. Deliberately not
    // `accommodationTargetMs`: that variable is owned and decayed by the
    // accommodation controller, so anything written there is drained away within
    // seconds. This one has a single writer (the evenness detector) and a single,
    // deliberately slow, decay of its own.
    let unevenFloorMs = 0;
    // The catch-up ceiling, shared by the rate law and the self-verification
    // below. The law takes it as a defaulted argument rather than reading this
    // binding directly, because js_checks.js extracts that function on its own;
    // `js_checks.js catchup-rate-drains-without-a-teardown` asserts the two
    // copies of the number are identical, so they cannot drift apart silently.
    const CATCHUP_MAX_RATE = 1.08;
    let jitterFloorEmaMs = 0;           // Network-jitter-proportional playout floor (see jitterBufferFloorMs)
    // --- Read-back of the target the UA actually applied -------------------
    // jitterBufferTarget is a hint, not a command, so the value WRITTEN is not
    // evidence of the value in force. jitterBufferTargetDelay is the
    // standardized cumulative measure of the granted target (same delta/delta
    // form as jitterBufferDelay), and jitterBufferMinimumDelay is the UA's own
    // floor, which jitterBufferTarget cannot push below. Until these were read,
    // a UA that silently clamped the request was indistinguishable from one that
    // honoured it, and the drop-gated accommodation would keep raising against a
    // target that never landed. Diagnostics only — they never feed the control
    // law, so a surprising reading cannot oscillate the buffer.
    let lastJitterTargetTotal = 0;      // Cumulative jitterBufferTargetDelay baseline (seconds)
    let lastJitterMinTotal = 0;         // Cumulative jitterBufferMinimumDelay baseline (seconds)
    let grantedTargetMs = null;         // Windowed target the UA is actually running (ms)
    let grantedTargetDeltaMs = null;    // granted - requested (ms); negative = UA holding less
    let uaMinTargetMs = null;           // Windowed jitterBufferMinimumDelay (the UA's own floor)
    // --- Audio side, previously unobserved entirely -----------------------
    // Every stats consumer in this file filtered on kind === 'video', so the
    // whole audio half of A/V sync was invisible: concealment (audible gaps),
    // insertedSamplesForDeceleration (the UA stretching audio to reach the
    // video target — the exact mechanism the code comments theorise about), and
    // the audio clock itself. The audio report arrives in the SAME getStats()
    // walk, so reading it is free.
    let audioStatsReport = null;        // Latest kind === 'audio' inbound-rtp report
    let lastAudioSamplesDuration = 0;   // Cumulative totalSamplesDuration baseline (seconds)
    let audioDriftWindowAt = 0;         // performance.now() at the last samplesDuration baseline
    let audioDriftPpm = null;           // Smoothed audio clock drift vs wall time (ppm)
    let audioConcealEvents = 0;         // Session total concealmentEvents (PLC runs = audible gaps)
    let audioStretchEvents = 0;         // Session total insertedSamplesForDeceleration/Acceleration runs
    // --- Presentation (rVFC) ----------------------------------------------
    // The only instruments for "the video speeds up / slows down" and for the
    // spec's frame-rate-scaled freeze threshold. `player.playbackRate` reads
    // 1.0 for a MediaStream and cannot see either.
    let lastMediaTimeSec = null;        // rVFC metadata.mediaTime of the previous presented frame
    let lastFramePresentAt = 0;         // performance.now() of the previous presented frame
    let playbackRate = null;            // Smoothed d(mediaTime)/d(wall) the element is running at
    let lastFrameGapMs = 0;             // Wall time since the previous presented frame
    let specFreezeMs = null;            // Spec freeze threshold at the current frame rate (ms)
    let abrBadSec = 0;                  // Consecutive seconds of measured network stress (rendition switching)
    let abrCalmSec = 0;                 // Consecutive calm seconds (rendition upgrade)
    let abrDowngradedForLink = false;   // ABR moved this viewer down (not decode pressure)
    let lastRenditionSwitchAt = -60000; // ABR switch cooldown anchor (performance.now ms)
    let renditionPathsItems = null;     // Latest /v3/paths/list snapshot while connected (ABR ladder)
    let renditionPollInterval = null;   // Slow paths poll that keeps the ladder fresh while connected
    let lastPresentedFrames = 0;        // rVFC metadata.presentedFrames accumulator (real render count)
    let lastPresentedFps = null;        // Presented-frames delta over the last stats tick
    let presentedFpsValid = false;      // True only while lastPresentedFps is a FRESH sample
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
    let lastFreezeCheckAt = 0;           // performance.now() of the previous watchdog poll
    // PEAK-HOLD of the stream's nominal frame rate, used as the freeze
    // watchdog's expectation. It must be something the DECODER cannot drag
    // down with it — deriving it from the decode counter made the stall test
    // vacuous. See the inboundSnapshot publish site and isDecoderStalled.
    let stallReferenceFps = null;
    // Staleness bound the watchdog ACTS on, derived from `stallReferenceFps`
    // (the peak-hold) rather than the live frame rate. Distinct from
    // `specFreezeMs`, which is the live-rate bound reported to diagnostics:
    // a collapsing decoder inflates the live bound past the very gap it caused,
    // so the watchdog needs a bound that does not move with the fault.
    let stallDetectMs = null;
    let frozenSince = 0;                  // When freeze was first detected (0 = not frozen)
    let isRecovering = false;             // Guard to prevent recovery storms
    let recoveryCount = 0;                // How many auto-recoveries we've done this session
    let healthyPlaybackSeconds = 0;      // Consecutive healthy playback seconds (resets recovery counter)
    // Watchdog timing. These are TWO different jobs and were one constant.
    //
    // FREEZE_THRESHOLD_MS is the FALLBACK staleness bound, used only when the
    // spec threshold cannot be computed (no measured frame rate yet) or when
    // rVFC is unavailable to keep the staleness reading fresh. The spec-derived
    // bound is ~167ms at 60fps — see specFreezeThresholdMs().
    //
    // FREEZE_CONFIRM_MS is how long a detected stall must persist before the
    // session is torn down. It stays generous on purpose: recovery costs 2-4s
    // of black, which is worse than the short freeze it would fix, so a
    // transient glitch must clear itself before the session is rebuilt.
    //
    // It must be a whole number of POLL intervals. The watchdog polls every
    // 1500ms, so ANY value in (0, 1500] behaves identically to 1500 — a
    // "1200ms" confirmation window reads as a deliberate safety margin while
    // actually confirming on the very next poll, one poll and nothing more.
    // 3000 is two consecutive confirming polls, which is the smallest value
    // that genuinely discriminates, and it still recovers a real freeze in
    // ~4.5s against the old 6.0s.
    const FREEZE_THRESHOLD_MS = 3000;     // Fallback staleness bound (no rVFC / no measured rate)
    const FREEZE_CONFIRM_MS = 3000;       // Sustained-stall confirmation (2 x the 1500ms poll)
    const MAX_RECOVERIES = 10;            // Allow up to 10 recoveries (with decay back to 0)
    let stallTimeout = null;
    let recoveryCooldownTimer = null;   // Stage-3 cooldown handle (must be cancellable)
    let snapshotMisses = 0;             // Consecutive freeze-watchdog polls with no usable snapshot
    let capNoticeShown = false;         // Rate-limit the MAX_RECOVERIES message
    // How many times the recovery budget may be re-armed after MAX_RECOVERIES.
    // Bounded on purpose: a broadcast this device genuinely cannot decode fails
    // identically every time, so an unbounded re-arm is an infinite loop of full
    // WHEP renewals, each a 2-4s black screen. Two re-armed cycles is enough to
    // distinguish "a transient that outlived the budget" from "this cannot work".
    let capCycles = 0;
    const MAX_CAP_RECOVERIES = 2;
    let statsSkippedTicks = 0;          // Stats ticks dropped to the in-flight guard (diagnostics)
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

    // Configure hardware codec preference if supported by browser.
    // `kind` selects the m-line's capability set, so the same ordering rule
    // governs video and audio rather than video having an opinion and audio
    // being left to whatever order the UA happened to enumerate.
    function configureCodecPreferences(transceiver, kind = 'video') {
        if (!('setCodecPreferences' in transceiver) || !('RTCRtpReceiver' in window) || !('getCapabilities' in RTCRtpReceiver)) {
            return;
        }
        try {
            const capabilities = RTCRtpReceiver.getCapabilities(kind);
            if (!capabilities || !capabilities.codecs) return;

            if (kind === 'audio') {
                // Opus first, and specifically the low-delay configuration. The
                // publisher side already encodes with `-application lowdelay`
                // (codec_bridge.js), and an Opus DTX/CELT mode mismatch shows
                // up as periodic concealment clicks on an otherwise clean link.
                // Everything else (G.711, telephone-EVS variants) is a
                // last-resort fallback, not a first choice.
                const prioritizedAudio = capabilities.codecs.slice().sort((a, b) => {
                    const score = (c) => {
                        const mime = (c.mimeType || '').toLowerCase();
                        if (mime.includes('opus')) return 100;
                        if (mime.includes('red')) return 90;      // audio RED, i.e. repair
                        if (mime.includes('ulpfec')) return 90;
                        return 10;
                    };
                    return score(b) - score(a);
                });
                transceiver.setCodecPreferences(prioritizedAudio);
                console.log("[WebRTC] Audio codec preferences set (Opus first).");
                return;
            }

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

    // The read-back half of the same measurement, and the loop's missing
    // feedback signal. `jitterBufferTarget` is a HINT, not a command: the spec
    // says the UA has a minimum and maximum target "reflecting what the user
    // agent is able or willing to provide", that this is "a target value" whose
    // "resulting change in delay can be gradually observed over time", and
    // that the change in delay is observed "gradually". A write is therefore
    // not a measurement of anything.
    //
    // The standardized read-back is `jitterBufferTargetDelay`, which the stats
    // spec defines in exactly the same terms as `jitterBufferDelay`: "This
    // value is increased by the target jitter buffer delay every time a sample
    // is emitted by the jitter buffer... To get the average target delay,
    // divide by jitterBufferEmittedCount." Same shape, same cumulative nature,
    // same windowed-delta formula. Chromium-only today; null elsewhere.
    //
    // Why this matters: without it the supervisor cannot tell a UA that honoured
    // a 350ms request from one that clamped it to 120ms. Both look identical
    // from here, and the drop-gated accommodation then keeps seeing "late
    // frames" caused by a target that never landed and keeps raising — the very
    // oscillation this controller was rewritten to eliminate. (Pure — tested.)
    function windowedGrantedTargetMs(targetTotal, emittedTotal, prevTargetTotal, prevEmittedTotal) {
        const emittedDelta = emittedTotal - prevEmittedTotal;
        if (prevEmittedTotal <= 0 || emittedDelta <= 0 || targetTotal < prevTargetTotal) return null;
        return ((targetTotal - prevTargetTotal) / emittedDelta) * 1000;
    }

    // `jitterBufferMinimumDelay` is the UA's own floor, and the stats spec is
    // explicit that it is measured "the same way as jitterBufferTargetDelay,
    // except that it is not affected by external mechanisms that increase the
    // jitter buffer target delay, such as jitterBufferTarget". It answers a
    // question this app could not previously ask: is the target being written
    // even reachable? A large negative gap (granted well below requested) means
    // the UA is holding less than was asked for and late frames are being
    // discarded for want of buffer; a large positive gap means it is holding
    // more, which is latency the viewer pays for and nobody was accounting for.
    //
    // Deliberately a PURE diagnostic that never feeds the control law, so a
    // surprising reading can never oscillate the buffer.
    function grantedTargetGapMs(grantedMs, requestedMs) {
        if (!Number.isFinite(grantedMs) || !Number.isFinite(requestedMs)) return null;
        if (grantedMs < 0 || requestedMs < 0) return null;
        const gap = grantedMs - requestedMs;
        if (gap > 4000) return 4000;
        if (gap < -4000) return -4000;
        return gap;
    }

    // The playout-target actuator's full legal range, from the WebRTC-PC
    // `jitterBufferTarget` setter: values outside [0, 4000] throw a RangeError.
    // Nothing here enforced that. The accommodation cap (2200) happens to sit
    // under 4000 today, so the limit has never actually been reached — but a
    // raise in that constant, or summing the base terms instead of max()ing
    // them, would throw on EVERY receiver write, and the catch in
    // applyPlayoutDelay turns that into a `false` that makes the supervisor
    // believe no receiver is controllable. The symptom would be silent: the HUD
    // keeps advertising a target the browser is not running. Clamp here so the
    // range is enforced by the code that owns the number, not by coincidence.
    const JITTER_TARGET_MAX_MS = 4000;
    const JITTER_TARGET_MIN_MS = 0;
    function clampJitterBufferTargetMs(ms) {
        if (!Number.isFinite(ms)) return null;
        if (ms > JITTER_TARGET_MAX_MS) return JITTER_TARGET_MAX_MS;
        if (ms < JITTER_TARGET_MIN_MS) return JITTER_TARGET_MIN_MS;
        return ms;
    }

    // Effective presented-media rate: the closest available instrument for the
    // symptom viewers report as "the video speeds up / slows down".
    //
    // `player.playbackRate` cannot see it: it reads 1.0 for a MediaStream.
    // The mechanism is real and lives in this app's own control path: per
    // WebRTC-PC, lowering `jitterBufferTarget` makes the UA reach the new
    // level by DISCARDING buffered frames, and a buffer surplus does not sit
    // still. rVFC's `metadata.mediaTime` is the media time of the frame
    // submitted to the compositor, so this is the rate of presented media per
    // unit wall time.
    //
    //   rate > 1  -> presenting faster than real time, i.e. spending surplus
    //   rate < 1  -> either starved, or a source that is itself dropping frames
    //
    // It is a PRESENTED-rate measure, not a playbackRate reading: rVFC fires per
    // frame sent to the compositor, so a source dropping frames lowers this
    // while the element still runs at 1.0x. That is why it is reported next to
    // the presented-frame count rather than acted on alone.
    //
    // Smoothed rather than instantaneous: one callback pair is one frame, and at
    // 24fps a single-pair ratio quantises to +/-2%. The EMA settles in roughly a
    // second and is immune to a single dropped callback. (Pure — tested.)
    const PLAYBACK_RATE_SMOOTHING = 0.15;
    function effectivePlaybackRate(mediaTimeSec, wallSec, prevRate) {
        if (!Number.isFinite(mediaTimeSec) || !Number.isFinite(wallSec)) return prevRate ?? null;
        if (wallSec <= 0) return prevRate ?? null;
        const rate = mediaTimeSec / wallSec;
        if (!Number.isFinite(rate) || rate <= 0) return prevRate ?? null;
        // A non-positive previous rate means "no rate established yet" rather
        // than a real measurement: a rate of 0 is unreachable (the guard above
        // refuses to produce one), and letting it seed the EMA would start the
        // average at 0 and make a healthy stream look like it is running slow.
        if (prevRate === null || prevRate === undefined
            || !Number.isFinite(prevRate) || prevRate <= 0) return rate;
        return prevRate * (1 - PLAYBACK_RATE_SMOOTHING) + rate * PLAYBACK_RATE_SMOOTHING;
    }

    // Audio clock drift, in parts per million, from the standardized audio
    // counters. `totalSamplesDuration` is defined by the stats spec as "the
    // total duration in seconds of all samples that have been received (and
    // thus counted by totalSamplesReceived)" — a RECEIVE-side measure of the
    // media taken in, not of what a speaker played out. Compared against wall
    // time, a stream whose audio clock is nominally right but actually 500ppm
    // fast walks 26ms per minute, and the browser then spends the session
    // micro-correcting it — heard as drift, seen as the picture jumping, while
    // every video stat reads clean. This is the one signal in the app that can
    // separate "audio has drifted relative to video" from "everything is
    // fine", and the app read no audio stats at all before this.
    //
    // Because it is receive-side, the sign absorbs any systematic offset in the
    // SOURCE's clock as well as the receiver's; either way it is the drift
    // signal, and it is only interpretable over a long window, which is why
    // callers gate and smooth it (see measureAudioStats).
    // (Pure — tested.)
    function audioClockDriftPpm(samplesDurationDeltaSec, wallSec) {
        if (!Number.isFinite(samplesDurationDeltaSec) || !Number.isFinite(wallSec)) return null;
        if (wallSec <= 0 || samplesDurationDeltaSec <= 0) return null;
        return ((samplesDurationDeltaSec - wallSec) / wallSec) * 1e6;
    }

    // True network loss, as opposed to the raw `dLost / (dRx + dLost)` ratio the
    // stats loop used to publish.
    //
    // Two spec facts make that ratio wrong in both directions:
    //   1. `packetsReceived` is defined to INCLUDE retransmissions, so a link
    //      that loses 20% of its packets and repairs 100% of them by RTX reads
    //      ~0% loss. RTX is negotiated and working, so the viewer is smooth and
    //      must NOT be told it is stressed.
    //   2. `packetsLost` is the count of packets the receiver never got, which
    //      already excludes repaired ones, so the ratio is not "loss", it is
    //      "unrecovered loss" — but the retransmission is double-counted in the
    //      denominator's favour.
    //
    // Meanwhile `packetsDiscarded` is the packet the JITTER BUFFER threw away
    // locally, and MediaMTX's reader queue overflow (documented in
    // _research/bwe.md: "a circular buffer that stores outgoing packets and
    // drops packets if full") shows up as a burst of loss that no amount of
    // receiver-side buffering can repair. Treating it separately lets the ABR
    // ladder tell "the link is thin" (loss, which a lower rendition fixes) from
    // "the buffer is too small" (discard, which a larger target fixes).
    //
    // Returns NET loss as a fraction of everything the link OFFERED, so the
    // number keeps the same physical meaning the ABR thresholds were tuned
    // against: "what fraction of the link did we fail to receive?"
    //
    // The denominator MUST include `dReceived`. An earlier version of this
    // function divided by `lost + discarded` alone, which measures "the share
    // of lost packets that RTX failed to repair" — a repair-rate, not a loss
    // rate — and it is off by one to two orders of magnitude at realistic
    // volumes. Measured at ~625 packets/s: 3 lost with 2 repaired reads 33.3%
    // under that denominator and 0.16% under this one. Since 33% is above the
    // 5% ABR threshold and the 2.5% stress threshold, a viewer on a link whose
    // picture is perfectly fine would be pinned to the 3000k rendition, held at
    // the 350ms buffer, and — because `abrCalm` needs loss < 2% for 20
    // CONSECUTIVE ticks and such a link never dips that low — never allowed to
    // upgrade back for the rest of the session. The whole point of netting out
    // retransmissions is to stop punishing a viewer for loss the transport
    // already repaired; dividing by the loss alone threw that away.
    //
    // `dReceived` is the received count for the window, which per spec
    // INCLUDES retransmissions — and that is exactly what makes the ratio
    // correct: repaired packets land in the numerator's absence and the
    // denominator, which is what "arrived" should mean.
    // (Pure — unit-tested in js_checks.js `network-loss-accounting`.)
    function networkLossPct(dLost, dRetransmitted, dDiscarded, dReceived) {
        const lost = Number.isFinite(dLost) ? Math.max(0, dLost) : 0;
        const retx = Number.isFinite(dRetransmitted) ? Math.max(0, dRetransmitted) : 0;
        // A retransmission can only repair a loss, never exceed it. Clamping
        // keeps a counter that resets/wraps on stream restart (RTX counts are
        // per-SSRC and drop to 0 when the source re-keys) from producing a
        // negative numerator and a nonsense negative loss percentage.
        const netLost = Math.max(0, lost - retx);
        const discarded = Number.isFinite(dDiscarded) ? Math.max(0, dDiscarded) : 0;
        const received = Number.isFinite(dReceived) ? Math.max(0, dReceived) : 0;
        // Everything the link put on the wire this window: what arrived, plus
        // what did not, plus what arrived and was then discarded locally. A
        // local discard is still a picture the viewer did not get, so it has to
        // be in the offered total even though it never appears in packetsLost.
        const offered = received + lost + discarded;
        if (offered <= 0) return 0;
        return Math.min(100, (netLost / offered) * 100);
    }

    // Picture-loss ratio — the standard broadcast QoE metric, and the one number
    // a viewer or broadcaster actually asks for ("how much of the stream actually
    // arrived?"). Every input was already being read into the stats loop
    // (`framesReceived` / `framesDecoded`); nothing combined them. Deliberately
    // measured as a RATE over a window rather than as a cumulative ratio, so a
    // mid-session source change or a decode restart does not permanently bias it.
    // (Pure — unit-tested in js_checks.js `picture-loss-ratio`.)
    function pictureLossRatioPct(dReceived, dDecoded) {
        const received = Number.isFinite(dReceived) ? Math.max(0, dReceived) : 0;
        const decoded = Number.isFinite(dDecoded) ? Math.max(0, dDecoded) : 0;
        if (received <= 0) return null;              // no frames: undefined, not 0%
        return Math.min(100, Math.max(0, ((received - decoded) / received) * 100));
    }

    // Is the decoder actually STALLED, as opposed to merely slow?
    //
    // The watchdog used to ask `decodedDelta === 0`, which is wrong twice over.
    //
    //  - It is an exact equality across a 1.5s poll of a 1s snapshot, so it can
    //    fire on a sub-poll sampling artefact during perfectly healthy playback:
    //    two consecutive 1s snapshots that happen to land inside the same 1.5s
    //    poll window legitimately report the same count. That is a 2-4s black
    //    screen for a stream that was never frozen.
    //  - It is blind in the other direction, which is the one that matters. A
    //    decoder that is decoding at 2fps while the stream is 60fps is a total
    //    slideshow — the worst possible viewer experience — and it reports
    //    `decodedDelta` of ~3 over the window, never 0. The viewer sees
    //    near-constant freezing, and the watchdog that exists to catch exactly
    //    that never fires.
    //
    // So: packets are arriving (bytesDelta proves the transport is alive) AND
    // the decoder is producing far fewer frames than the stream's own rate says
    // it should. The 25% floor tolerates a coarse poll: a healthy decoder
    // produces `fps * elapsed` frames in the window and cannot plausibly fall
    // below a quarter of that, while a wedged one produces a handful.
    //
    // `elapsedSec` is REQUIRED and is not optional sugar. The stats loop ticks
    // every 1s and this watchdog every 1.5s, so `decodedDelta` spans the
    // watchdog's window while `fps` is a per-second rate: comparing the two
    // without the span compares a 1.5-second count against a 1-second
    // expectation and flags a perfectly healthy 60fps stream (90 frames
    // delivered against an expectation of 15). The span has to be multiplied in
    // or the test is simply wrong.
    //
    // `fps` is the stream's own measured rate; passing null (rate not yet
    // established) falls back to requiring a hard zero, which is the one case
    // where "no baseline" cannot be evidence of a stall.
    // (Pure — unit-tested in js_checks.js `decoder-stall-detection`.)
    function isDecoderStalled(bytesDelta, decodedDelta, fps, elapsedSec, stallFraction = 0.25) {
        if (!(bytesDelta > 5000)) return false;          // transport is not alive
        if (!(decodedDelta >= 0)) return false;          // counter reset: no evidence
        if (decodedDelta === 0) return true;             // hard stop, rate or not
        if (!Number.isFinite(fps) || fps <= 0) return false; // no baseline to judge against
        if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return false;
        // Frames the decoder should have produced in THIS window at the stream's
        // own rate, floored at 1 so a sub-1fps nominal rate cannot demand less
        // than the single frame we already observed.
        const expectedMin = Math.max(1, fps * elapsedSec * stallFraction);
        return decodedDelta < expectedMin;
    }

    // The spec's definition of a video freeze, used to separate a REAL stall
    // from normal inter-frame variance. WebRTC-Stats defines a freeze as a
    // frame duration — the interval between two consecutively RENDERED frames
    // — that "is equal or exceeds Max(3 * avg_frame_duration_ms,
    // avg_frame_duration_ms + 150)". In the 10-120fps range a real broadcast
    // actually uses, the `+150` term dominates: the bound is 166.7ms at 60fps,
    // 183.3ms at 30fps and 191.7ms at 24fps, so it moves with the frame rate
    // and a single constant cannot express it. (The 3x term only takes over
    // below ~13.3fps.) The sub-cases are thresholds, not "three frames": at
    // 24fps the 191.7ms bound needs FOUR missed frames to be crossed
    // (3 x 41.7 = 125ms), and at 60fps the 166.7ms bound needs ten.
    //
    // Reported, not acted on. triggerFreezeRecovery() costs 2-4s of black,
    // which is far worse than the freeze it would "fix", so this feeds the HUD
    // and the buffer supervisor: a short freeze should widen the buffer, not
    // tear the session down. (Pure — tested.)
    function specFreezeThresholdMs(avgFrameMs) {
        if (!Number.isFinite(avgFrameMs) || avgFrameMs <= 0) return null;
        return Math.max(3 * avgFrameMs, avgFrameMs + 150);
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
    // Release granularity for the stress hold. NOTE: this is deliberately NOT
    // aligned to BUFFER_TARGET_BAND_MS. That band filters with a strict `<`, so a
    // 50ms step is exactly equal to it and is NOT filtered — the old comment here
    // claimed the two matched so that "a ramped release produces one real re-pace
    // per step instead of a burst of sub-band no-ops", which was never true. The
    // real bound on this controller is the 3000ms dwell in reapplyBufferTargets
    // plus the 2-tick release clock, not the band. The accommodation controller
    // above is where the quantum had to exceed the band, and it now uses 100ms.
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
    // 100ms steps). HOLD whenever Chrome sits at the granted target: the
    // measured delay always tracks the hint, so raising to meet the
    // measurement would chase its own tail and inflate EVERY session to the
    // cap within half a minute (the bug this gate fixes — verified live: a
    // 180ms target with Chrome's buffer equilibrated at ~1.2s produced 31%
    // dropped frames, but that needs a RAISE only while frames are actually
    // being discarded). DECAY one 100ms step per tick only after sustained
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
        // The raise step is 100ms, NOT 50ms, and that is load-bearing rather than
        // cosmetic. reapplyBufferTargets() refuses any change smaller than
        // BUFFER_TARGET_BAND_MS (50ms) — but the comparison is a strict `<`, so a
        // 50ms step is exactly equal to the band and therefore NEVER filtered.
        // The accommodation moved in 50ms quanta, so every single accommodation
        // step was a real, applied jitterBufferTarget write on BOTH receivers, and
        // `recentDropAt` is refreshed on every dropping tick, which made `urgent`
        // permanently true on any drop-prone link and collapsed the dwell from
        // 3000ms to 1200ms. Net effect on exactly the links that report
        // micro-stutter: a deliberate ~0.8 Hz re-pacing of the playout clock, where
        // each write makes the jitter buffer either HOLD frames (a visible stall)
        // or discard them (visible drops) to reach the new level. Two writes 100ms
        // apart are half as frequent, and each one is large enough to be a real
        // correction rather than noise.
        if (dropsNow && delayMs > granted + 150) {
            return Math.min(2200, Math.round((delayMs + 100) / 100) * 100);
        }
        if (!dropsNow && calmTicks >= 5 && prevMs > 0) {
            // Decay matches the raise quantum for the same reason, so the release
            // path cannot produce a stream of sub-band writes either.
            return Math.max(0, prevMs - 100);
        }
        return prevMs;
    }

    // Live-edge catch-up rate (pure — unit-tested in js_checks.js). THE most
    // effective anti-stutter move available to a receiver, and the one this
    // player did not have: when playout has drifted behind the live edge, play
    // the media element slightly FAST so the jitter buffer drains itself, then
    // ramp back to 1.0x. Every production low-latency player does this
    // (Twitch / YouTube Live / Meet), because the alternative — the only one
    // this file shipped — is to tear the whole WHEP session down and rebuild it
    // to get back to the live edge, which costs a 2-4s hard black screen for a
    // problem that is purely about accumulated latency.
    //
    // A 1.08x rate drains ~80ms of buffer per second, so a 1s drift is gone in
    // ~12s with no black frame and no renegotiation, versus an immediate
    // 2-4s blackout. At <=1.08x with the element's default pitch preservation
    // the speed-up is not perceptible; above ~1.15 it is.
    //
    // A step change to playbackRate is audible as a click in the audio, and a
    // rate derived from raw per-tick measurements would produce a step every
    // tick on a noisy link. The constants live INSIDE the function on purpose:
    // js_checks.js extracts and evaluates this function on its own, so a module
    // level binding would make the whole mechanism untestable.
    function catchUpPlaybackRate(delayMs, baseTargetMs, currentRate = 1, maxRate = 1.08) {
        const MAX_RATE = maxRate;     // above ~1.15 the speed-up becomes visible
        const DEAD_BAND_MS = 120;   // settle point: base + this is "caught up"
        const STEP = 0.01;          // quantum: 1% per tick in either direction
        const MIN_EXCESS_RATE = 0.05;
        if (delayMs === null || !Number.isFinite(delayMs) || delayMs < 0) return 1;
        const base = Number.isFinite(baseTargetMs) ? Math.max(0, baseTargetMs) : 0;
        const excess = delayMs - base;
        const prev = Number.isFinite(currentRate) ? Math.max(1, currentRate) : 1;
        // Inside the dead band: ramp DOWN to 1.0. Returning straight to 1.0
        // would be an audible jolt, and 1.0 is the resting state.
        if (excess <= DEAD_BAND_MS) {
            return prev <= 1 ? 1
                : Math.max(1, Math.round((prev - STEP) * 100) / 100);
        }
        // 1% of extra rate per 40ms of excess beyond the dead band, CLAMPED TO A
        // FLOOR of 5%. The floor is not cosmetic: a pure proportional law tends
        // to zero as the delay approaches the band, so the last stretch drains
        // at a few ms per second and the session creeps toward the target
        // without ever arriving. Simulated against this exact function, a
        // floorless curve sat at 1.01x from 330ms down to 180ms — 20ms/s, a
        // 15-second crawl to close 150ms, and formally never converging at all
        // because the next tick's excess is smaller again. 5% drains the dead
        // band in ~2.4s and always terminates.
        const wanted = 1 + Math.max(MIN_EXCESS_RATE, (excess - DEAD_BAND_MS) / 4000);
        const clamped = Math.min(MAX_RATE, Math.max(1, wanted));
        const quantized = Math.round(clamped / STEP) * STEP;
        // Rise is bounded by the same step, so one noisy reading cannot slam
        // the rate from 1.00 to 1.08 in a single tick.
        const stepped = Math.min(quantized, prev + STEP);
        return Math.max(1, Math.round(stepped * 100) / 100);
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
    // Decode-pressure state machine (pure - unit-tested). Each stats tick
    // compares decoded frames against received frames: a decoder falling
    // below 70% of the arrival rate accumulates lag seconds, a decoder above
    // 90% sheds one, and a low-rate window (under 15 frames) is unmeasurable
    // and decays - static screens and paused publishers must not look like
    // decode pressure.
    // The question this answers is "can the decoder render the frames it is
    // HANDED?", so BOTH sides of the ratio must come from the same population:
    //   delivered = decoded + discarded   (frames the decoder could have shown)
    //   emitted                        (frames the jitter buffer actually gave it)
    //
    // The denominator used to be `framesReceived`, which is a DIFFERENT
    // population: it counts every frame the transport delivered to the jitter
    // buffer, including the ones the buffer then dropped for being late. Those
    // frames were never offered to the decoder, so dividing by them charged
    // ordinary network jitter to the decoder. `framesDiscarded` cannot repair
    // that: it is NOT a member of RTCInboundRtpStreamStats (the W3C-sourced
    // IDL defines framesDropped, not framesDiscarded), so it reads undefined on
    // every browser and discardedDelta is always 0.
    //
    // Measured consequence, 60fps with 16% of frames arriving too late to be
    // emitted (packetsLost ~= 0, because the loss is jitter-buffer late-discard
    // rather than transport loss) and a decoder rendering 100% of what it is
    // given:
    //   t=1..8s  lag = 1,2,3,4,5,6,7,8  -> 8s: a FULL rendition switch fires
    //                                      (2-4s of black for that viewer)
    //   fixed    lag = 0 throughout      -> nothing fires
    // A decoder genuinely failing to keep up is still caught: decoded 30 of 50
    // emitted accumulates 1..8 and trips the same switch.
    function updateDecodeLag(lagSec, decodedDelta, emittedDelta, discardedDelta = 0) {
        if (emittedDelta < 15) return Math.max(0, lagSec - 1);
        if (decodedDelta < 0) return Math.min(30, lagSec + 1);
        const discarded = Number.isFinite(discardedDelta) ? Math.max(0, discardedDelta) : 0;
        const delivered = decodedDelta + discarded;
        if (delivered <= 0) return Math.min(30, lagSec + 1);
        const ratio = delivered / emittedDelta;
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
        // The presentation-evenness floor, when one was applied. It is a floor
        // and not a replacement: the accommodation above it still applies, and
        // the mode the viewer chose is still honoured when this is 0.
        if (unevenFloorMs > 0) target = Math.max(target, unevenFloorMs);
        return target;
    }

    // Effective playout/jitter-buffer target for right now. Accommodation
    // (drop-gated, see bufferAccommodationMs) sits on top of the base.
    function currentBufferTargetMs() {
        return Math.max(baseBufferTargetMs(), accommodationTargetMs);
    }

    // Whether audio is actually being rendered right now, which every audio-side
    // measurement depends on.
    //
    // Note what this is NOT gating on. `totalSamplesDuration` is receive-side, so
    // it keeps advancing while packets arrive even on a paused, never-unmuted
    // element — it is not an "is audio being pulled" signal, and treating it as
    // one would be wrong. What IS pull-dependent is the audio JITTER BUFFER and
    // its emitted/played-out counters, which stay frozen until the element
    // actually renders the track. Mixing the two in one measurement is what
    // produces a reading that looks like an enormous clock drift and is really
    // just "nothing has been played yet".
    //
    // Same class of guard the video controllers already apply via
    // document.hidden and player.paused.
    function audioIsPulled() {
        if (player.paused) return false;
        if (!audioStatsReport) return false;
        // Muted audio is not rendered either, and the element is muted by
        // default (autoplay policy). The WebAudio tap only exists after the
        // first successful play(), so its presence is the reliable signal that
        // the graph is actually consuming the track.
        if (player.muted && !audioSourceNode) return false;
        return true;
    }

    // Per-tick audio measurement. Everything here is cumulative-delta based,
    // for the same reason the video side is: these are session-long totals and
    // averaging them across a whole session hides exactly the fresh problems this
    // exists to catch.
    function measureAudioStats(report) {
        if (!report) return;
        audioStatsReport = report;
        if (!audioIsPulled()) return;

        // Audio clock drift. totalSamplesDuration accumulates the media time the
        // receiver has produced; wall time is what the listener is living in. A
        // few hundred ppm is inaudible per second but walks tens of milliseconds
        // per minute, and the browser then micro-corrects continuously, which
        // reads as "janky" rather than as desync.
        if (Number.isFinite(report.totalSamplesDuration)) {
            const total = report.totalSamplesDuration;
            if (lastAudioSamplesDuration > 0 && total > lastAudioSamplesDuration) {
                const wallSec = (performance.now() - audioDriftWindowAt) / 1000;
                const drift = audioClockDriftPpm(total - lastAudioSamplesDuration, wallSec);
                // A per-second window on a 1s tick is far too short to resolve
                // ppm-level skew, so the reading is smoothed hard and only the
                // long-run sign is meaningful.
                if (drift !== null) {
                    audioDriftPpm = audioDriftPpm === null
                        ? drift
                        : audioDriftPpm * 0.9 + drift * 0.1;
                }
            }
            lastAudioSamplesDuration = total;
            audioDriftWindowAt = performance.now();
        }

        // Session totals, for the diagnostic export and the HUD.
        audioConcealEvents = Number.isFinite(report.concealmentEvents) ? report.concealmentEvents : 0;
        const inserted = Number.isFinite(report.insertedSamplesForDeceleration) ? report.insertedSamplesForDeceleration : 0;
        const removed = Number.isFinite(report.removedSamplesForAcceleration) ? report.removedSamplesForAcceleration : 0;
        audioStretchEvents = inserted + removed;
    }

    // Read back what the UA actually did with the target that was written.
    // `jitterBufferTargetDelay` is defined by the stats spec in exactly the same
    // terms as `jitterBufferDelay` ("increased by the target jitter buffer delay
    // every time a sample is emitted... to get the average target delay,
    // divide by jitterBufferEmittedCount"), so the same windowed delta applies.
    // `jitterBufferMinimumDelay` is the UA's own floor and, per the same spec,
    // is "not affected by external mechanisms that increase the jitter buffer
    // target delay, such as jitterBufferTarget" — so it says what the UA will
    // do even if this app asks for nothing at all.
    //
    // This closes the loop that was missing entirely: before it, a UA that
    // clamped a 350ms request to 120ms and one that honoured it were
    // indistinguishable, and the drop-gated accommodation kept reacting to
    // "late frames" whose real cause was a target that never landed.
    function measureGrantedTarget(videoStats) {
        if (!videoStats) return;
        if (Number.isFinite(videoStats.jitterBufferTargetDelay)
            && Number.isFinite(videoStats.jitterBufferEmittedCount)) {
            const reading = windowedGrantedTargetMs(
                videoStats.jitterBufferTargetDelay,
                videoStats.jitterBufferEmittedCount,
                lastJitterTargetTotal,
                lastJitterEmittedTotal
            );
            if (reading !== null) {
                grantedTargetMs = reading;
                grantedTargetDeltaMs = grantedTargetGapMs(reading, currentBufferTargetMs());
            }
            lastJitterTargetTotal = videoStats.jitterBufferTargetDelay;
        }
        if (Number.isFinite(videoStats.jitterBufferMinimumDelay)
            && Number.isFinite(videoStats.jitterBufferEmittedCount)) {
            // Its OWN baseline: jitterBufferTargetDelay and
            // jitterBufferMinimumDelay are separate cumulative series, and
            // differencing one against the other's baseline yields a garbage
            // average that could be either enormous or negative.
            const reading = windowedGrantedTargetMs(
                videoStats.jitterBufferMinimumDelay,
                videoStats.jitterBufferEmittedCount,
                lastJitterMinTotal,
                lastJitterEmittedTotal
            );
            if (reading !== null) uaMinTargetMs = reading;
            lastJitterMinTotal = videoStats.jitterBufferMinimumDelay;
        }
    }

    // Apply the effective playout delay target to one receiver. Returns true
    // when a target was actually written, so callers can avoid latching a
    // change that never landed. `overrideMs` lets a receiver be given a
    // deliberately different target.
    function applyPlayoutDelay(receiver, kind, overrideMs) {
        if (!receiver) return false;
        // Enforce the setter's documented [0, 4000] range here rather than
        // trusting every upstream term to stay inside it. An out-of-range write
        // throws a RangeError, and the catch below would report it as "this
        // browser has no such API" — so a single future constant bump would
        // silently disable buffer control everywhere while the HUD kept
        // advertising a target that was never applied.
        //
        // `overrideMs` is honoured when supplied and still goes through the
        // same clamp: a manual-mode or seam-supplied target is just as capable
        // of escaping the range as the computed one.
        const requested = overrideMs === undefined ? currentBufferTargetMs() : overrideMs;
        const targetMs = clampJitterBufferTargetMs(requested);
        if (targetMs === null) return false;
        try {
            // `jitterBufferTarget` is the ONLY standardized playout-delay
            // control on RTCRtpReceiver (WebRTC-PC: `attribute
            // DOMHighResTimeStamp? jitterBufferTarget`, milliseconds, 0..4000),
            // and it is implemented in Blink and Gecko alike.
            //
            // There used to be a fallback here for `playoutDelayHint` /
            // targetMs / 1000. That property is not in the WebRTC-PC
            // Recommendation — which defines only `attribute
            // DOMHighResTimeStamp? jitterBufferTarget` on RTCRtpReceiver — and
            // not in MDN's RTCRtpReceiver member list; it appears in no W3C
            // WebRTC specification or extension. The branch could never be
            // taken, and its presence told a maintainer that non-Chromium
            // receivers were covered when they were not.
            if (!('jitterBufferTarget' in receiver)) return false;
            receiver.jitterBufferTarget = targetMs;
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
            // The emergency is for a raise that is genuinely needed NOW, not for a
            // link on which drops merely recur. `recentDropAt` is refreshed on every
            // single dropping tick, so on a drop-prone link `urgent` was permanently
            // true and the dwell was permanently 1200ms instead of 3000ms — which,
            // combined with a step size equal to the band, turned the dwell into
            // "write as fast as the accommodation moves" (~0.8 Hz forever). The
            // emergency now also requires the raise to be a REAL jump: a large
            // fraction of the target, not one 50/100ms increment. A cosmetic
            // single-step raise waits the full dwell.
            const largeEnough = (targetMs - lastAppliedTargetMs) >= Math.max(100, lastAppliedTargetMs * 0.25);
            const urgent = targetMs > lastAppliedTargetMs
                && largeEnough
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

    // Drive the media element's playbackRate to drain accumulated playout delay
    // instead of tearing the session down. Called once per stats tick from
    // superviseAdaptiveBuffer(), and it is deliberately the FIRST drift
    // response: the drift supervisor below still escalates to a real rejoin,
    // but only once catch-up has failed, so the 2-4s black screen becomes the
    // last resort instead of the only option.
    //
    // Returns true while catch-up is actively engaged, so the caller can hold
    // off on the teardown.
    function updateLiveEdgeCatchUp() {
        // Honour the same exclusions as the rest of the supervisor: a hidden
        // tab suspends presentation (the measurement is meaningless and the
        // rate would drain a buffer nobody is watching), and a paused viewer is
        // not drifting.
        if (!isConnected || document.hidden || player.paused) {
            catchUpProbeAt = 0;
            catchUpProbeDelayMs = null;
            return false;
        }
        // The internal catchUpRate and the element's actual rate can diverge:
        // every early return above leaves the cached value alone while the element
        // keeps whatever was last written, and catchUpPlaybackRate is then handed
        // the STALE cached value as its currentRate. Its rise limiter is
        // min(quantized, prev + STEP), so the ramp then climbs from a base the
        // element never held. Derive the rate from the element itself so the two
        // can never disagree, and re-baseline the probe on re-entry.
        if (Number.isFinite(player.playbackRate) && player.playbackRate > 0) {
            const elementRate = Math.round(player.playbackRate * 100) / 100;
            if (elementRate !== catchUpRate) catchUpRate = elementRate;
        } else if (catchUpRate > 1) {
            // No usable element reading while something is engaged: put both the
            // cache and the element back to rest rather than carrying a fast rate
            // across a gap in supervision.
            resetLiveEdgeCatchUp();
        }
        // A measuring/null reading must not move the rate. Rewriting
        // playbackRate resets the media pipeline's audio/video sync state, so
        // a controller that churns it is worse than one that does nothing.
        if (avgPlayoutDelayMs === null || !Number.isFinite(avgPlayoutDelayMs)) {
            catchUpProbeAt = 0;
            catchUpProbeDelayMs = null;
            return false;
        }
        // Only a FRESH reading. avgPlayoutDelayMs latches through a quiet
        // window (see the drift supervisor), so acting on a stale value would
        // speed the stream up on the strength of a measurement from a minute
        // ago.
        if (performance.now() - avgPlayoutDelayAt > 3000) {
            catchUpProbeAt = 0;
            catchUpProbeDelayMs = null;
            return false;
        }

        // THE SETPOINT MUST BE THE ONE THE RECEIVERS WERE ACTUALLY WRITTEN WITH.
        // reapplyBufferTargets() pushes currentBufferTargetMs() (app.js:1274) to
        // every receiver, and that is max(baseBufferTargetMs(), accommodationTargetMs).
        // This controller used to compute its excess against the BARE base, which
        // structurally excludes accommodation. So the moment the accommodation
        // engaged, Chrome settled at the accommodated target while this law saw a
        // permanently positive excess it could never close: it ran the element
        // continuously 3-8% fast (an A/V re-sync every tick) draining a buffer the
        // accommodation was deliberately holding open, and the drain produced the
        // late frames that re-triggered the accommodation. Two individually correct
        // controllers, two different definitions of "settled", a permanent fight
        // that no loss or drop counter can see.
        //
        // grantedTargetMs is folded in as well, for the same reason: Chrome's
        // measured jitterBufferDelay converges to whatever target it was actually
        // GRANTED (which the UA is free to run above what the app requested), so the
        // excess must be measured against that grant or it reads as a permanent
        // phantom the controller can never close — which pins the element at its
        // 1.08x cap for the whole session and, via the self-verification below,
        // degrades the mechanism into the hard-rejoin teardown it exists to avoid.
        // max() keeps whichever ceiling is in force: the app's current target, or the
        // higher target the UA is actually running.
        const targetMs = Math.max(currentBufferTargetMs(), grantedTargetMs || 0);
        const wanted = catchUpPlaybackRate(avgPlayoutDelayMs, targetMs, catchUpRate, CATCHUP_MAX_RATE);

        // ASYMMETRIC GATE + DWELL. See lastCatchUpWriteAt: the law's 120ms band is
        // symmetric and the delay is a windowed mean, so an un-gated write path
        // re-paces the element once per second forever on a marginal link.
        //
        // THE STREAK MUST BE COUNTED HERE, OUTSIDE the `wanted !== catchUpRate`
        // branch below. It was originally inside, and the unit test modelled the
        // corrected version, so the test passed while the shipped controller was
        // still broken — a test that certifies an algorithm the code does not
        // implement. The failure is specific and severe: the law ramps DOWN
        // whenever excess <= 120ms, so on a delay dithering either side of that
        // edge it asks to go down on some ticks and up on others. On a down tick
        // the branch runs and the streak is cleared to 0, so the following up
        // tick always restarts at 1 and can never reach the required 2. Running
        // the real extracted controller over the dither the test uses produced 59
        // writes in 120s and left the element at 1.01 — the 0.5 Hz rewrite this
        // gate exists to prevent, and a permanently fast picture besides.
        const excessMs = avgPlayoutDelayMs - targetMs;
        // A GENUINE DEAD GAP, not a single threshold.
        //
        // The law's own dead band is 120ms: below that it asks to come DOWN, above
        // it asks to ramp up. Engaging at exactly that same 120ms boundary means
        // the controller acts on the law's own indecision — `avgPlayoutDelayMs` is
        // a windowed mean over emitted frames and crosses any fixed line between
        // consecutive 1s windows, so a delay sitting at 119/121 makes the law ask
        // to go down and up on alternate ticks. Traced against the real law, a
        // gate that engages at 120 writes 59 times in 120s (0.5 Hz) and leaves the
        // element flipping between 1.00 and 1.01 forever; a gate with a 60ms
        // hysteresis on the reset behaves identically, because the problem is not
        // the reset, it is engaging on the boundary at all.
        //
        // So the engage threshold sits above the law's band and the clear
        // threshold at it. A delay oscillating at the law's own boundary now
        // produces zero writes and a resting 1.0x.
        //
        // HONEST LIMIT: the 120-180ms band is deliberately NOT treated. The law
        // would ramp it at ~1.5%, which drains ~15ms/s — nothing a viewer would
        // notice against a session whose entire point is that latency is not the
        // enemy — and engaging there buys far less than the re-pacing it risks.
        // Anything at or beyond 180ms of excess is treated, and a real drift (the
        // 1.5-3s a hidden tab leaves) clears it on the first tick.
        const ENGAGE_BAND_MS = 180;    // ramp up only above this much excess
        const ENGAGE_CLEAR_MS = 120;   // ...and only clear below this
        if (excessMs > ENGAGE_BAND_MS) {
            catchUpAboveBandTicks += 1;
        } else if (excessMs < ENGAGE_CLEAR_MS) {
            catchUpAboveBandTicks = 0;
        }
        if (wanted !== catchUpRate) {
            const engaged = wanted > catchUpRate;
            // Only an ENGAGE has to prove itself and pay the dwell. A release is
            // the safe direction and is already gated by the law's own dead band:
            // catchUpPlaybackRate only asks to come DOWN when excess <= 120ms, so
            // a genuinely-over-target delay can never produce one.
            //
            // A release STREAK was tried and had to be removed: it could strand
            // the element above 1.0x permanently. The law ramps down only while
            // the delay stays at or under 120ms of excess, and a delay dithering
            // across that edge (119 then 121 — exactly what a windowed mean does
            // on a real link) fails a "3 consecutive below" test on alternate
            // ticks, leaving a permanent 1%-fast picture, which is the very
            // low-level drift this mechanism exists to prevent.
            const streakOk = !engaged || catchUpAboveBandTicks >= 2;
            const dwellOk = !engaged || (performance.now() - lastCatchUpWriteAt) >= 2000;
            if (streakOk && dwellOk) {
                try {
                    player.playbackRate = wanted;
                    lastCatchUpWriteAt = performance.now();
                } catch (err) {
                    // Some engines refuse playbackRate on a MediaStream-backed
                    // element. Give up permanently rather than retrying every tick.
                    console.warn('[AdaptiveBuffer] playbackRate rejected; catch-up disabled:', err);
                    catchUpProvenUseless = true;
                    // The engine may still be holding whatever rate it had. Leaving
                    // an elevated rate on the element after disabling the controller
                    // is the same permanent-speed-up defect as the latch below, so
                    // the rest state is restored on this path too.
                    resetLiveEdgeCatchUp();
                    catchUpProvenUseless = true;   // reset() clears it; the verdict stands
                    return false;
                }
                catchUpRate = wanted;
            }
        }

        // SELF-VERIFICATION. Do not trust the rate blindly: prove it actually
        // drains the buffer. If the delay is still not falling once the rate is
        // SATURATED and has been for a while, the mechanism is not working here
        // (an engine that accepts the write and ignores it, or a link so
        // congested that 8% makes no difference) and continuing would leave the
        // viewer watching a permanently sped-up stream while the real problem
        // went untreated.
        //
        // The saturation precondition is what makes this safe. A first version
        // judged the drain at ANY rate and latched "useless" after 5s of a
        // delay that had merely stopped falling — and on a HEALTHY link a
        // jitter buffer that is refilling (arrivals momentarily above
        // consumption) does exactly that. Simulated against the real law: from
        // 400ms creeping to 472ms over 6 ticks at 1.05x, it declared a
        // perfectly working mechanism useless and disabled it for the session.
        // The rate can only reach the cap if the controller wanted it there, so
        // "saturated and still not draining" is evidence about the MECHANISM
        // rather than about a transient.
        const now = performance.now();
        if (catchUpRate >= CATCHUP_MAX_RATE) {
            if (!catchUpProbeAt) {
                // Mark the moment of saturation, but do NOT take the baseline yet:
                // this tick's write has only just been issued, so the delay measured
                // now still predates any response to it. Capturing it here meant the
                // drain was judged starting from a number the element had not yet
                // had a chance to move, which is how a working mechanism got
                // declared useless. The baseline is taken on the NEXT tick instead,
                // once at least one full stats window has elapsed under the cap.
                catchUpProbeAt = now;
                catchUpProbeDelayMs = null;
            } else if (catchUpProbeDelayMs === null) {
                catchUpProbeDelayMs = avgPlayoutDelayMs;
            } else if (now - catchUpProbeAt > 5000
                // PROPORTIONAL, not a flat 50ms. The baseline used to be captured on
                // the SAME tick the rate first saturated — immediately after the
                // write, before the element had any chance to respond to it — and
                // judged against a flat 50ms fall. A flat threshold is trivial at
                // large excess (1.08x drains ~80ms/s) and unreachable at small
                // excess, so the probe could declare a working mechanism useless
                // on a merely-noisy link. Ten percent of the baseline scales with
                // the size of the job.
                && avgPlayoutDelayMs > catchUpProbeDelayMs * 0.9) {
                catchUpProvenUseless = true;
                console.warn(`[AdaptiveBuffer] Catch-up saturated at ${catchUpRate}x and did not `
                    + `drain the buffer (${catchUpProbeDelayMs.toFixed(0)}ms -> `
                    + `${avgPlayoutDelayMs.toFixed(0)}ms); falling back to a hard rejoin.`);
                // CRITICAL: hand the element back its resting rate BEFORE the
                // controller goes quiet. Latching the verdict here used to leave
                // player.playbackRate at 1.08, because the supervisor gates the
                // controller on `!catchUpProvenUseless` — so from the next tick
                // updateLiveEdgeCatchUp() was never called again, and the only two
                // write sites for playbackRate in the whole file are inside it and
                // inside resetLiveEdgeCatchUp(). Nothing else could ever put it back.
                // The viewer was left watching a permanently 8%-fast picture for
                // the rest of the session, pitch-shifted, with every network
                // statistic reading perfectly clean.
                resetLiveEdgeCatchUp();
                catchUpProvenUseless = true;   // reset() clears the verdict; the verdict stands
            }
        } else {
            // Not saturated: the controller has not asked for everything it can
            // get, so the drain is still in progress and there is nothing to
            // judge. Clearing the probe restarts the window whenever the rate
            // later saturates, so a long slow ramp cannot be judged on a stale
            // baseline taken minutes ago.
            catchUpProbeAt = 0;
            catchUpProbeDelayMs = null;
        }
        return catchUpRate > 1;
    }

    // Presentation evenness (pure — unit-tested). The "0% loss but not smooth"
    // detector.
    //
    // Every other control input in this file is a NETWORK or BUFFER quantity:
    // packetsLost, jitter, framesDropped, the measured jitterBufferDelay. All of
    // them can read perfectly clean while the picture is visibly uneven, because
    // an uneven picture is a statement about the SPACING of presented frames, not
    // about how many were lost. That is the gap this closes.
    //
    // rVFC already reports the wall-clock instant of every presented frame, so the
    // inter-frame gap is directly observable for the first time. Two summaries of
    // that gap stream are enough:
    //   - the MEAN interval (what cadence the picture is actually running at), and
    //   - the MEAN ABSOLUTE DEVIATION from it (how uneven that cadence is).
    //
    // Only the second one is the signal. A perfectly steady 30fps stream has a mean
    // absolute deviation near zero; a 60fps stream hitching between 8ms and 40ms
    // gaps has a large one even though not one packet was lost. Normalising the
    // deviation by the mean interval makes the test cadence-independent, so a 30fps
    // viewer is not judged by a 60fps threshold.
    //
    // Returns the coefficient of variation of the inter-frame gap over a WINDOW
    // of recent samples: mean absolute deviation divided by the mean, or null
    // when there are too few samples to mean anything.
    //
    // A sliding WINDOW, not an exponential average. An EMA was tried first and is
    // far too insensitive to be useful here: because the mean chases the input,
    // the deviation it measures is the deviation of a TRACKED signal, and a
    // sustained 3:1 alternation (16ms/48ms frames, i.e. plainly uneven) scored
    // only 0.05 — an order of magnitude under the threshold, so the detector
    // could never fire on the exact pattern it exists to catch. Measured against
    // the window form, the same stream scores ~0.5.
    //
    // What separates cleanly, and is why the threshold can sit at 0.35:
    //   steady 16.7ms          -> ~0.00   (a healthy stream)
    //   +/-2.5ms wobble        -> ~0.10   (ordinary vsync jitter, must NOT fire)
    //   one 33->90ms outlier   -> ~0.03   (a single hitch is not "continuous")
    //   alternating 10/24ms    -> ~0.41   (continuously uneven: FIRES)
    //   alternating 16/48ms    -> ~0.50   (continuously uneven: FIRES)
    // The "one outlier" row is the important one for false positives: a single
    // dropped frame is a blip, and the reported symptom is explicitly CONTINUOUS.
    function frameGapUnevenness(gaps) {
        if (!Array.isArray(gaps) || gaps.length < 4) return null;
        let sum = 0;
        let count = 0;
        for (const gap of gaps) {
            if (typeof gap !== 'number' || !Number.isFinite(gap) || gap <= 0) continue;
            sum += gap;
            count += 1;
        }
        if (count < 4) return null;
        const mean = sum / count;
        if (!(mean > 0)) return null;
        let deviation = 0;
        let used = 0;
        for (const gap of gaps) {
            if (typeof gap !== 'number' || !Number.isFinite(gap) || gap <= 0) continue;
            deviation += Math.abs(gap - mean);
            used += 1;
        }
        if (used < 4) return null;
        const unevenness = (deviation / used) / mean;
        return Number.isFinite(unevenness) ? unevenness : null;
    }

    // Record one presented-frame interval. (Pure over the passed array so
    // js_checks.js can drive it without a DOM.) Returns the new window.
    //
    // A gap is admitted only if it is PLAUSIBLE FOR THE CADENCE ALREADY
    // ESTABLISHED, and a gap that arrives after a long run of steady frames is
    // treated as an outlier and does not enter the window at all. Without this,
    // mean-absolute-deviation is dominated by outlier MAGNITUDE and the detector
    // cannot tell "continuously uneven" from "one 700ms keyframe wait": measured
    // at 30fps, a single 700ms hitch produced a hot reading for three
    // consecutive supervisor samples, which is exactly the 3-tick streak, so one
    // GC pause or keyframe wait consumed the session's single one-shot widen and
    // denied a genuinely uneven stream its remedy. The 3x bound is generous
    // enough to admit any real cadence irregularity (the alternating patterns the
    // detector exists to catch are 2-3:1 within one sample) while rejecting
    // anything that is a stall rather than unevenness — the freeze watchdog owns
    // stalls, and there is a second bound for those below.
    //
    // The constants live INSIDE the function on purpose, matching
    // catchUpPlaybackRate: js_checks.js extracts and evaluates these on their own,
    // so a module-level binding would make the mechanism untestable.
    function noteFramePresentation(gapMs, window) {
        const WINDOW = 90;         // ~1.5s of picture at 60fps
        const MAX_STALL_MS = 1000; // the freeze watchdog's domain, not ours
        const OUTLIER_RATIO = 3;   // >3x the established mean is a stall, not jitter
        if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs <= 0) return window;
        if (gapMs >= MAX_STALL_MS) return window;
        if (window.length >= 8) {
            let sum = 0;
            for (const g of window) sum += g;
            const mean = sum / window.length;
            if (mean > 0 && gapMs > mean * OUTLIER_RATIO) return window;   // outlier
        }
        const next = window.concat(gapMs);
        return next.length > WINDOW ? next.slice(next.length - WINDOW) : next;
    }

    function resetPresentationEvenness() {
        frameGapWindow = [];
        unevenStreakTicks = 0;
        unevenReleaseTicks = 0;
    }
    // Return playbackRate to its resting value. A session that ends while
    // catching up would otherwise leave the NEXT session running fast, and the
    // viewer would be watching a subtly sped-up stream with no way to tell why.
    function resetLiveEdgeCatchUp() {
        catchUpRate = 1;
        catchUpProbeAt = 0;
        catchUpProbeDelayMs = null;
        catchUpProvenUseless = false;
        catchUpAboveBandTicks = 0;
        lastCatchUpWriteAt = 0;
        if (!player) return;
        if (player.playbackRate !== 1) {
            try { player.playbackRate = 1; } catch (e) { /* engine refused it anyway */ }
        }
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
        // Both thresholds are derived from ONE pair of constants so the calm
        // predicate can never again drift away from the stress predicate and
        // re-open a band where neither fires. The band is the whole bug: with
        // stress above 120ms and calm below 40ms, any link between them was
        // NEITHER, so `abrBadSec` froze below its 8s threshold (a struggling
        // viewer never stepped down) and `abrCalmSec` froze below its 20s
        // threshold (a viewer that HAD stepped down never came back). That is
        // the accumulator freeze the "no else" comment below was written to
        // prevent, reintroduced one level up in the predicates.
        const ABR_JITTER_STRESS_MS = 120;   // above this the link cannot carry full bitrate
        const ABR_JITTER_CALM_MS = 90;      // below this the link is comfortably clear of it
        const ABR_LOSS_STRESS_PCT = 5;
        const ABR_LOSS_CALM_PCT = 2;
        const abrStressed = (lastLossPct !== null && lastLossPct > ABR_LOSS_STRESS_PCT)
            || (lastNetJitterMs !== null && lastNetJitterMs > ABR_JITTER_STRESS_MS);
        // `abrCalm` is a strict RELAXATION of `abrStressed` in the dimension that
        // matters: the `!abrStressed` term guarantees the calm branch is
        // REACHABLE on every tick the stress branch is not. The 90-120ms span
        // is genuinely not a good link, so it is not counted as calm — but it
        // must not be counted as AMBIGUOUS either, because "ambiguous" that
        // holds BOTH counters still is the original bug in a narrower band: a
        // link pinned at 100ms would never accumulate the 20 calm seconds that
        // return it to full quality, so one downgrade would be permanent. The
        // jitter reading is a doubly-smoothed EWMA that hovers, so a link
        // sitting at 100ms is a link whose jitter is FALLING, not one stuck.
        //
        // So the ambiguous band advances the calm counter by a fraction rather
        // than not at all. It cannot upgrade as fast as a clean link, and it
        // cannot be terminal. `lastNetJitterMs` hovering just under the stress
        // bound earns slow progress, which is exactly the right weighting.
        const abrCalm = !abrStressed
            && (lastLossPct === null || lastLossPct < ABR_LOSS_CALM_PCT)
            && (lastNetJitterMs === null || lastNetJitterMs < ABR_JITTER_CALM_MS);
        // Between the calm and stress bounds: ambiguous, not calm, not stressed.
        // Counts at 1/4 rate so it still terminates.
        const abrAmbiguous = !abrStressed && !abrCalm
            && (lastLossPct === null || lastLossPct < ABR_LOSS_STRESS_PCT);
        if (abrStressed) {
            abrBadSec += 1;
            abrCalmSec = 0;
        } else if (abrCalm) {
            abrCalmSec += 1;
            abrBadSec = 0;
        } else if (abrAmbiguous) {
            // Fractional accumulation rather than a reset: a marginal link
            // drifts toward recovery instead of being pinned forever.
            //
            // The rate is deliberately LOW. At 0.25 the 20-second threshold is
            // reached in 80 ticks, which OUTLASTS the 60s switch cooldown — so
            // a link that hovers in the ambiguous band would upgrade to full
            // bitrate, stress again a minute later, and downgrade, trading a
            // 2-4s black screen every ~80s forever. 0.05 needs 400 ticks (~7
            // minutes) of sustained ambiguity, which is longer than any
            // plausible recovery but still terminates, so a link that genuinely
            // settles downward is never permanently stuck.
            abrCalmSec += 0.05;
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
                // Record WHY this viewer is leaving full quality, so the
                // decode-pressure loop below knows not to walk them back up it.
                abrDowngradedForLink = true;
                switchRendition('live-av1',
                    'Your connection is struggling with the full-quality stream — '
                    + 'switched to the lighter rendition to stop frame drops.');
                return;
            }
            // The accumulator is deliberately kept live even in the ambiguous
            // band (see the 0.05 credit above): zeroing it there is what made
            // the original 40-120ms band terminal. But "the counter reached 20"
            // is not by itself permission to climb — the ambiguous band can
            // reach it while the link is still measurably bad, and 3% real loss
            // is a congested link, not a recovering one. The loss guard is
            // therefore applied HERE, at the point of action, rather than by
            // freezing the counter: the accumulator keeps running (no freeze)
            // while the switch is refused for as long as loss stays above the
            // calm bound. The two axes are not symmetric — jitter is a smoothed
            // EWMA that hovers and trends down, loss is a level over a
            // completed window — so loss is the axis worth gating on.
            const lossAllowsUpgrade = lastLossPct === null
                || lastLossPct < ABR_LOSS_CALM_PCT;
            if (abrCalmSec >= 20 && lossAllowsUpgrade
                && activeStreamPath === 'live-av1'
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
                    // Back at full quality on a link that has held calm for 20s,
                    // so the decode-pressure guard must stand down again.
                    abrDowngradedForLink = false;
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
                //
                // UNLESS the ABR ladder is what put them here. This branch is
                // the "my decoder cannot keep up" response, but a viewer sitting
                // on live-av1 after a network-stress downgrade is here because
                // the LINK could not carry full bitrate, not because AV1 decode
                // is slow. Sending them back to `live` undoes the downgrade on a
                // link already measured as unable to carry it: 60s later the link
                // is stressed again, ABR steps down once more, and the pair
                // ping-pongs forever at two full 2-4s WHEP teardowns per minute.
                // Only let decode pressure move a viewer UP the ladder when
                // they got there by a decode decision rather than a network one.
                if (abrDowngradedForLink) {
                    hwPath = null;
                } else {
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
            }
            // F5: when there is genuinely NO safe target — a viewer already on
            // the bottom rung, a rescue rendition that is not ready yet, or the
            // ABR-guarded case above — `decodeLagSec` was left sitting at 30+
            // forever. It then re-evaluated the whole branch on every single
            // tick for the rest of the session, and the moment a rescue
            // rendition DID become ready it fired an unrequested switch to
            // something the viewer never asked for. Let it decay back toward
            // the threshold so re-arming always requires fresh evidence.
            if (!hwPath || hwPath === activeStreamPath) {
                decodeLagSec = Math.max(0, decodeLagSec - 1);
            } else {
                decodeLagSec = 0;
                switchRendition(hwPath,
                    "This device's decoder can't keep up with AV1 — switched to the hardware-decodable path for smooth playback.");
                return;
            }
        }

        // --- Live-edge catch-up: drain the drift in place, no teardown ---
        // Must run BEFORE the rejoin check below. Previously drift was answered
        // with exactly one thing — tear the WHEP session down and rebuild it —
        // so a viewer who fell 1-2s behind (an Alt-Tab, a bursty minute on a
        // hotspot) paid a 2-4s HARD BLACK SCREEN plus a full ICE + WHEP
        // renegotiation to recover a problem that is purely about accumulated
        // latency. Speeding the element up to 1.08x drains ~80ms of buffer per
        // second with no black frame, no renegotiation and no server load.
        // The rejoin below is retained as the escalation when this cannot keep
        // up, so the hard path still exists.
        const catchingUp = !catchUpProvenUseless && updateLiveEdgeCatchUp();

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
            // Catch-up gets first refusal. Escalating to a teardown while the
            // element is still draining would reintroduce exactly the black
            // screen catch-up exists to avoid, and it is strictly worse: the
            // teardown costs 2-4s to buy a reset the running session will
            // produce on its own within a few seconds. Only escalate once the
            // drain has stalled (catchUpProvenUseless), which is the genuine
            // "session is broken" case this branch was written for.
            if (!catchingUp) {
                rejoinDriftSec += 1;
            } else {
                rejoinDriftSec = 0;
            }
            if (!catchingUp && rejoinDriftSec >= 3) {
                rejoinDriftSec = 0;
                // A session that failed to drain is very likely running at an
                // elevated rate. Reset it BEFORE the teardown so the new
                // session does not inherit the old one's playbackRate.
                resetLiveEdgeCatchUp();
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
            // The release dwell must be cleared by the SAME event that re-arms the
            // stress response. It was not: `raiseReleaseTicks` was assigned in only
            // three places (declaration, increment, reset-on-step) and none of them
            // was here. So one calm tick set it to 1, a burst of stress ticks left
            // it at 1, and the very next calm tick pushed it to 2 and released
            // immediately. On a link whose jitter EMA hovers around this 55ms
            // threshold, the release cadence was set by blip ALIGNMENT rather than
            // by sustained calm — and every release is a real, downward
            // jitterBufferTarget write, which makes Chrome discard frames to reach
            // the new level (50ms is 1.5 frames at 30fps, 3 at 60fps). That is a
            // continuous low-amplitude frame-loss chirp: not a visible hitch, which
            // is exactly why it reads as "very short but continuous" and clears
            // every HUD diagnostic.
            raiseReleaseTicks = 0;
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

        // --- Presentation evenness: the one signal that can see "0% loss" ---
        // Everything above this line is driven by packet counts or buffer depth.
        // A viewer whose complaint is "very short but continuous" produces none of
        // those symptoms: no loss, no jitter spike, no drops, no drift. What is
        // actually wrong is the SPACING of presented frames — the compositor is
        // getting them at irregular intervals — and until now nothing in this file
        // measured it.
        //
        // The response is a buffer widen, NOT a teardown. That choice is
        // deliberate: an uneven cadence is a cushion problem, and a wider cushion
        // is the cheapest thing that can absorb it, while the staged recovery
        // costs 2-4s of hard black — strictly worse than the unevenness.
        //
        // One widen per session (unevenWidenApplied). A detector that can fire
        // repeatedly becomes a second oscillator, and this file has already been
        // bitten by exactly that shape twice (the stress-raise square wave and the
        // catch-up/probe fight). The window itself is sliding, so a link that
        // settles stops reading as uneven and the streak decays on its own.
        const presentationUnevenness = frameGapUnevenness(frameGapWindow);
        if (presentationUnevenness !== null) {
            // 0.35 is a coefficient of variation of the inter-frame interval.
            // Measured separation (see frameGapUnevenness): a steady stream ~0.00,
            // ordinary +/-2.5ms vsync wobble ~0.10, a single dropped frame ~0.03,
            // and a CONTINUOUSLY uneven stream 0.41-0.50. The threshold sits above
            // every "must not fire" case and below every "must fire" case.
            const UNEVEN_THRESHOLD = 0.35;
            const UNEVEN_STREAK = 3;
            if (!unevenWidenApplied && presentationUnevenness > UNEVEN_THRESHOLD) {
                unevenStreakTicks += 1;
                if (unevenStreakTicks >= UNEVEN_STREAK) {
                    // A DEDICATED floor, not `accommodationTargetMs`. That variable
                    // is owned by the accommodation controller, which is invoked
                    // unconditionally on every subsequent tick and DECAYS it by
                    // 100ms per 5 calm ticks — so a widen written there was
                    // drained away within ~10s (600 -> 0 in simulation) while the
                    // one-shot latch had already been consumed. The console
                    // promised a 600ms buffer the stream never got. This variable is
                    // not owned or decayed by the accommodation controller, so the
                    // widen survives; the only decay it has is the slow release
                    // below, which a manual latency-mode change also clears.
                    unevenFloorMs = Math.min(2200, Math.max(baseBufferTargetMs() + 200, 600));
                    if (unevenFloorMs > currentBufferTargetMs()) {
                        unevenWidenApplied = true;
                        console.log('[AdaptiveBuffer] Presentation is continuously uneven '
                            + `(gap cv ${presentationUnevenness.toFixed(2)}) with no loss, `
                            + `jitter spike or drops — widening the buffer to ${unevenFloorMs}ms.`);
                    }
                    unevenStreakTicks = 0;
                }
            } else {
                unevenStreakTicks = 0;
                // Slow release of the floor, so a one-off stall is not permanent.
                // The window is 1.5s of picture, so a link that has been even for
                // that long genuinely does not need the cushion; 100ms per release
                // tick (~100s to unwind a 600ms floor) keeps it below both the
                // re-pace thresholds, so the release costs a handful of normal
                // dwell-gated writes rather than adding any new ones.
                if (unevenWidenApplied && unevenFloorMs > 0) {
                    unevenReleaseTicks += 1;
                    if (unevenReleaseTicks >= 5) {
                        unevenReleaseTicks = 0;
                        unevenFloorMs = Math.max(0, unevenFloorMs - 100);
                        if (unevenFloorMs === 0) unevenWidenApplied = false;
                    }
                }
            }
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
        // What the browser is ACTUALLY running. `jitterBufferTarget` is a hint
        // with a UA-chosen minimum and maximum, so the number this app writes
        // is not evidence of the number in force. When the two differ by more
        // than the rounding threshold, showing both is the difference between
        // "the buffer controller is working" and "the controller has been
        // regulating against a fiction for the whole session".
        let granted = '';
        if (grantedTargetMs !== null && Math.abs(grantedTargetMs - targetMs) >= 50) {
            granted = ` → ${Math.round(grantedTargetMs)}`;
        }
        const state = stateOverride || (targetMs > config.ms ? 'boosted' : 'normal');
        if (state === 'boosted') {
            // The target absorbing more than the mode asks for is normal
            // accommodation (bursty arrivals), not a fault condition.
            hudBuffer.innerText = `${targetMs} ms${granted} (absorbing)${measured}`;
        } else {
            hudBuffer.innerText = `${targetMs} ms${granted}${measured}`;
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
                // The client cap must be LONGER than the server's own TURN-mint
                // budget, or the browser gives up on a request the server is
                // still legitimately serving. server.js mints Cloudflare
                // credentials with AbortSignal.timeout(4000), and it only mints
                // on a cache miss — the first viewer, or the first viewer after
                // the half-life renewal. At 2500ms the client aborted ~1.5s
                // before the server's own deadline, so a cold cache always lost:
                // the fetch threw AbortError, the catch below set the cache to
                // null, and the handshake proceeded with host candidates only.
                // For exactly the viewers who need the relay — remote/mobile
                // networks that cannot be punched through — that is the
                // difference between connecting and never connecting.
                //
                // 6s leaves real headroom over the 4s upstream while still
                // bounding the wait. It is the largest term in the connect
                // budget, which now accounts 6s ICE fetch + 6s gather + 10s
                // POST = 22s, so the watchdog cap moved 22s -> 26s. That is not
                // "the same margin" the old budget had — the previous one was
                // NEGATIVE (15s cap against a 15.5s stack, which is what made it
                // tear down slow viewers before they could finish); the new one
                // is a 4s margin.
                const timer = setTimeout(() => controller.abort(), 6000);
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
        // fetch (6s cap, which must exceed the server's own 4s TURN-mint
        // budget) + candidate gathering (6s cap, because the window
        // now waits for a ROUTABLE candidate so a network that blocks UDP STUN
        // is not cut off before its srflx or TURN candidate lands) + WHEP POST
        // (10s cap) = 22s, so the cap is 26s. Leaving this at 16s guaranteed
        // the watchdog fired BEFORE the attempt could possibly finish on a slow
        // link — the exact viewer this change was meant to help.
        // Real ICE failures still tear down immediately via the
        // connectionState 'failed' handler; this is only the no-state-change
        // backstop.
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = setTimeout(() => {
            if (isConnecting && !isConnected) {
                console.warn("[WebRTC] Connection attempt timed out after 26s without ICE handshake. Triggering disconnect recovery.");
                addSystemMessage("⚠️ Connection timed out. Re-attempting handshake...");
                handleDisconnected();
            }
        }, 26000);
        
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
            // watchdog's Stage 2 rebinds the element in place, and
            // switchRendition (the ABR path) calls cleanupConnection(true),
            // which deliberately leaves the old stream on screen. The old
            // first-track branch only replaced the stream when it was null, so
            // on the next connect the tracks were appended to the stale one.
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
            const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            configureCodecPreferences(videoTransceiver, 'video');
            // The audio m-line gets the same treatment. It used to be added and
            // then left entirely to the UA's enumeration order, in a function
            // whose whole purpose is deterministic ordering — an asymmetry that
            // read as an oversight and would let a browser that happens to list
            // a legacy codec first negotiate it.
            configureCodecPreferences(audioTransceiver, 'audio');

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
            // ATTEMPT-OWNED TIMER HANDLES.
            //
            // `gatherTimeout` is module-scoped so cleanupConnection() can cancel
            // this window, but that made it a shared slot that TWO attempts
            // write to. Every clearing path therefore has to prove the handle it
            // is clearing is still the one THIS attempt armed.
            //
            // Without that check the stale attempt wins. Teardown clears the
            // global, the replacement attempt arms its own cap, and then this
            // attempt's `finish()` — resumed by a routablePoll timer that
            // cleanupConnection does NOT clear, because it is a local of this
            // closure and not a module global — clears the NEW attempt's 6s cap
            // and nulls the global. Two things break at once for the live
            // attempt: the cap that bounds ICE gathering is gone, and
            // `pollRoutable` guards on "is the window still open", which it
            // reads from that same global — so the routable-candidate fast path
            // dies too, silently reverting to "gathering complete or forever"
            // on exactly the hard networks (STUN blocked, TURN slow) that
            // routine exists for. The attempt then hangs until the 26s connect
            // watchdog instead of the 6s it is supposed to be bound by.
            let gatherCap = null;      // this attempt's cap handle
            let gatherOpen = false;    // this attempt's window state
            await new Promise((resolve) => {
                let checkState;
                let routablePoll = null;
                let routableSettle = null;

                const finish = (why) => {
                    if (!gatherOpen) return;   // idempotent: finish can race itself
                    gatherOpen = false;
                    // Release the shared slot only while it still holds OUR
                    // handle. A newer attempt's cap must survive us.
                    if (gatherTimeout === gatherCap) gatherTimeout = null;
                    gatherCap = null;
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
                    // ATTEMPT-LOCAL window state. This used to read the module
                    // global `gatherTimeout`, which a superseded attempt's
                    // finish() can null out from under the live attempt — that
                    // silently killed this whole loop. See the note above.
                    if (routableSettle || !gatherOpen) return;
                    if (!hasRoutableCandidate()) {
                        routablePoll = setTimeout(pollRoutable, 100);
                        return;
                    }
                    routableSettle = setTimeout(() => finish('routable candidate'), 400);
                };

                pc.addEventListener('icegatheringstatechange', checkState);
                // ORDER MATTERS. The cap must be armed BEFORE the first
                // pollRoutable() call, and the window flag must be open before
                // either: pollRoutable()'s guard tests `gatherOpen` to know the
                // window is still open, so arming out of order made it return
                // immediately and never reschedule. The routable-candidate
                // logic would then be dead code and the window would silently
                // degrade to "gathering complete or 6s".
                gatherOpen = true;
                gatherCap = setTimeout(() => finish('6s cap reached'), 6000);
                gatherTimeout = gatherCap;
                pollRoutable();
            });
            // The window owns its cap; clear it only if this attempt is still
            // the one holding the shared slot. (finish() above normally already
            // did, but the promise can resolve via a path that left it armed.)
            if (gatherTimeout === gatherCap) {
                clearTimeout(gatherCap);
                gatherTimeout = null;
            }
            gatherCap = null;
            gatherOpen = false;
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

            // ATTEMPT-OWNED, exactly as the ICE-gather cap above.
            //
            // Both handles are module globals purely so cleanupConnection() can
            // cancel an in-flight attempt. That makes them a slot two attempts
            // write to, and this attempt's `finally` was the dangerous writer:
            // teardown clears the globals, the replacement attempt arms its own
            // controller and timer, and then THIS attempt's aborted fetch
            // rejects and its `finally` clears the NEW attempt's 10s POST bound
            // and nulls the global. The live attempt is then left with a WHEP
            // POST that no timeout can end and that teardown can no longer
            // cancel, so a stalled POST hangs until the 26s connect watchdog
            // instead of 10s — and the reason is invisible in the log, which
            // shows only the successful connect.
            const myAbortController = new AbortController();
            whepAbortController = myAbortController;
            // Bound the handshake round-trip: without this, a stalled POST would sit
            // until the 26s connect watchdog fired. Signaling is a local ~10ms exchange, so
            // 10s means something is genuinely broken and a fast retry helps sooner.
            // The callback aborts THIS attempt's controller, not whatever the
            // global happens to hold when it finally runs.
            const myPostTimeout = setTimeout(() => {
                console.warn("[WebRTC] WHEP POST exceeded 10s without a response. Aborting handshake.");
                try { myAbortController.abort(); } catch (e) { /* already aborted */ }
            }, 10000);
            whepPostTimeout = myPostTimeout;
            let response;
            try {
                response = await fetch(activeWhepUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/sdp'
                    },
                    body: finalOfferSdp,
                    signal: myAbortController.signal
                });
            } finally {
                // Clear only our own handle, and release the shared slots only
                // while they still hold it.
                clearTimeout(myPostTimeout);
                if (whepPostTimeout === myPostTimeout) whepPostTimeout = null;
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
            // 6s ICE-config fetch + 6s candidate wait + up to 10s WHEP POST =
            // 22s of a 26s budget, leaving 4s for the actual ICE
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
                // Do NOT simply clear isConnecting here. The 26s connectTimeout
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
            // A SUPERSEDED attempt must not tear down the session that replaced
            // it. Only the AbortError branch above had this guard, and it is not
            // the only way a torn-down attempt can fail: cleanupConnection()
            // calls `pc.close()` on the old connection while this attempt may
            // still be suspended on `createOffer()` / `setLocalDescription()`,
            // and those reject with InvalidStateError/OperationError
            // ("signalingState is 'closed'"), NOT AbortError. That lands here,
            // where the code unconditionally cleared isConnecting and ran
            // handleDisconnected() — which clears the LIVE attempt's 26s
            // connect watchdog, closes the LIVE attempt's peer connection,
            // paints the page OFFLINE and re-arms the status poll.
            //
            // So a stale attempt that failed after being superseded destroys a
            // perfectly healthy session, and the viewer's own log shows a clean
            // connect followed by an unexplained drop. Every teardown trigger
            // can produce it: an ABR rendition switch, the freeze watchdog's
            // Stage 3, the seam safety net, or the network-change handler — each
            // of which tears the in-flight attempt down mid-handshake.
            //
            // The identity check is the same one every other continuation in
            // this function uses; a superseded attempt's failure is simply not
            // news about the current session.
            if (superseded()) {
                console.warn("[WebRTC] A superseded session failed; leaving the current one alone.", error);
                return;
            }
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
        // The seam's own 12s safety net must be cancelled on EVERY path out of
        // teardown, not only the one that keeps the picture.
        //
        // The clear used to sit INSIDE the keepPicture branch below, which is
        // exactly backwards. Only switchRendition() uses keepPicture=true, and
        // that is the single call where nothing goes offline. The callers the
        // hazard was written for — handleDisconnected() and the freeze
        // watchdog's Stage 3 — both call this with keepPicture=false, so the
        // orphan stayed armed precisely when it is dangerous:
        //
        //   - a rendition switch whose replacement fails fast painted OFFLINE
        //     and then, 12s later, had the orphan fire and reconnect on its own,
        //     flipping the page offline -> connecting -> live with no user action;
        //   - on a healthy live session the orphan did `player.srcObject = null`
        //     (black screen, audio dead) and then called connectStream(), which
        //     no-ops because isConnected is still true — leaving a dead
        //     connection that neither watchdog can see;
        //   - it also forced `viewerPausedByChoice = false`, so a viewer who
        //     had deliberately paused got resumed, with audio, unprompted.
        //
        // The pending flag has to go with the timer, or the NEXT session's
        // first ontrack takes the seam branch and swaps in a stream on a
        // teardown that never asked for a switch.
        // teardown that never asked for a switch.
        if (switchSeamTimer) {
            clearTimeout(switchSeamTimer);
            switchSeamTimer = null;
        }
        switchSeamPending = false;
        if (keepPicture) {
            // Leave the element alone, so the last decoded frame stays on screen
            // until the replacement session's ontrack swaps in the new stream.
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
        // ORDER MATTERS. cleanupConnection() now clears the seam state
        // unconditionally (it must, or a hard teardown leaves a 12s orphan that
        // blacks the picture and reconnects behind the viewer's back), so the
        // flag has to be armed AFTER it, not before.
        //
        // It used to be set immediately above this call, which meant the very
        // next line cleared it again in the same synchronous block. Nothing
        // could observe it in between, so `switchSeamPending` was always false
        // by the time ontrack fired: the seam branch was skipped, control fell
        // through to the generic session-id branch, and — because that branch
        // does not cancel the safety net — the 12s timer armed below stayed
        // live and fired on EVERY successful switch, nulling srcObject and
        // forcing a reconnect. It "worked" only because the fallthrough branch
        // happens to rebuild the stream too.
        cleanupConnection(true);
        switchSeamPending = true;
        // Safety net for the seam: if the replacement handshake never yields a
        // track, the stale (now-ended) stream would otherwise stay on screen
        // indefinitely. 12s is far beyond the 10s WHEP cap, so this only fires
        // on a genuine failure, and it fails LOUDLY to a real reconnect.
        // Cancel any previous seam timer before arming a new one. Without this a
        // superseded 12s net stays live and fires against the *new* session,
        // blanking a perfectly healthy picture.
        if (switchSeamTimer) clearTimeout(switchSeamTimer);
        switchSeamTimer = setTimeout(() => {
            switchSeamTimer = null;
            switchSeamPending = false;
            console.warn("[ABR] Replacement rendition produced no track in 12s; forcing a hard reconnect.");
            if (player.srcObject) { player.pause(); player.srcObject = null; }
            // The connection flags MUST be cleared here. cleanupConnection only
            // releases resources; it never touches isConnected/isConnecting, and
            // handleConnected() set isConnected = true for the replacement
            // session. Leaving them set made the connectStream() below hit its
            // own duplicate guard and return without doing anything, so the net
            // did the exact opposite of recovering: it blanked the element,
            // nulled the peer connection, and left the page with no session, no
            // watchdog (its tick needs peerConnection AND !player.paused) and no
            // poll (which skips while isConnected) — a permanent black screen
            // that only a manual reload could clear. Clearing the flags first is
            // what makes this a reconnect instead of a self-wound-down session.
            isConnected = false;
            isConnecting = false;
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
                if (hiddenSpanDelayMs !== null) {
                    avgPlayoutDelayMs = hiddenSpanDelayMs;
                    // Stamped so updateLiveEdgeCatchUp() accepts it as a FRESH
                    // reading. It normally rides along on the next stats tick,
                    // but the catch-up decision is made here and immediately
                    // after this function returns, so without the stamp the one
                    // measurement that matters most — the hidden span itself —
                    // would be rejected as stale and the drift would go
                    // untreated until the loop caught up.
                    avgPlayoutDelayAt = performance.now();
                }
            }
            const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
            const capMs = Math.max(config.driftLimitMs + 1600, 3100);
            // A hidden tab is THE dominant source of drift on this project:
            // Chrome suspends presentation, packets keep arriving, and the
            // project's own live numbers put a normal Alt-Tab at 1.7-2.8s of
            // accumulated delay. This is precisely the case live-edge catch-up
            // exists for — the session is perfectly healthy, it is just behind,
            // and tearing it down to fix that costs a 2-4s black screen. Start
            // draining immediately; the running stats loop continues it.
            if (!catchUpProvenUseless) updateLiveEdgeCatchUp();
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
            // A hidden tab suspends presentation, so there is nothing to drain
            // and no measurement to drain it from. Leaving an elevated rate on
            // the element means the viewer's return begins at 1.0x of stale
            // intent with the probe state describing a measurement taken before
            // the hide — which is how the self-verification ends up declaring a
            // working mechanism useless.
            resetLiveEdgeCatchUp();
            // Same reason for the evenness estimate: a hidden tab suspends
            // presentation, so its frame gaps describe the suspension, not the link.
            if (typeof resetPresentationEvenness === 'function') resetPresentationEvenness();
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
    //   source H264  + any browser        -> live      (native; audio rescue applies
    //                                        only when the source is non-Opus)
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
        // Opus (or audio-less) H264 source: the NATIVE path already carries the
        // source codec at the source bitrate AND sound reaches WebRTC readers,
        // so it is strictly better than the bridge's 3000k AV1 re-encode. This
        // is the browser-publisher case (studio.js publishes H.264 + Opus over
        // WHIP), and `auto` must return 'live'.
        //
        // It used to return 'live-av1' here, which routed every AV1-capable
        // viewer OFF the full-quality source and onto a 3 Mbit transcode by
        // default, purely to save bandwidth nobody asked to save. That is the
        // "OBS looks great, the studio looks soft" report: the studio's
        // broadcast produced the only rung anyone could ever reach, and the
        // full-quality source was never played.
        //
        // The AAC (OBS/RTMP) case is unaffected — it returns above, on the
        // audio-rescue branch, where the native path genuinely is muted.
        //
        // Bandwidth adaptation is what the ABR supervisor is for: it moves a
        // viewer onto 'live-av1' after 8 sustained stressed seconds
        // (`abrBadSec >= 8`) and back after 20 calm ones. A viewer on a link
        // that cannot carry the source now degrades on evidence, and a viewer on
        // a healthy link keeps full quality. `preferTranscode` is still honoured
        // for callers that explicitly want the cheap rung.
        if (preference === 'preferTranscode') {
            return (av1Capable && av1Smooth !== false && ready('live-av1')) ? 'live-av1' : 'live';
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
        // Same reason: RTX/discard counters are per-SSRC and restart with the
        // source, so a stale baseline would make the first tick's delta a
        // multi-hundred-million packet "repair" and pin loss at a negative or
        // clamped-zero reading.
        lastRetransmittedPackets = 0;
        lastPacketsDiscarded = 0;
        lastFramesDropped = 0;
        lastPlrPct = null;
        lastRepairRatePct = null;
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
        lastJitterEmittedForDecode = 0;
        // Read-back and audio baselines are per-session for the same reason:
        // a cumulative counter carried over from the previous connection and
        // differenced against a zero baseline produces one enormous first-tick
        // reading, which for the audio clock would look like a huge drift.
        lastJitterTargetTotal = 0;
        lastJitterMinTotal = 0;
        grantedTargetMs = null;
        grantedTargetDeltaMs = null;
        uaMinTargetMs = null;
        audioStatsReport = null;
        lastAudioSamplesDuration = 0;
        audioDriftWindowAt = performance.now();
        audioDriftPpm = null;
        audioConcealEvents = 0;
        audioStretchEvents = 0;
        lastMediaTimeSec = null;
        lastFramePresentAt = 0;
        playbackRate = null;
        specFreezeMs = null;
        lastAppliedTargetMs = null;
        lastAppliedTargetChangeAt = 0;
        jitterFloorTick = 0;
        stage2AttemptedThisSession = false;
        returnDriftChecks = 0;
        recentDropAt = -Infinity;
        bufferNoticeState = '';
        accommodationTargetMs = 0;
        accommodationCalmTicks = 0;
        // A new session must start at 1.0x. playbackRate is a property of the
        // media ELEMENT, not of the peer connection, so it survives every
        // teardown in this file: without this reset a viewer whose previous
        // session ended while catching up would start the next one running fast
        // and see no reason why.
        resetLiveEdgeCatchUp();
        // The evenness estimate is per-session too. Carrying it across a teardown
        // would let the previous session's jitter decide the new session's buffer,
        // and `unevenWidenApplied` would still be true, so the new session could
        // never widen even if its own presentation genuinely was uneven. A hidden
        // tab suspends presentation, so its gaps are meaningless for the same
        // reason the playout delay is.
        // Guarded because js_checks.js extracts this function and runs it without
        // the module-level bindings.
        if (typeof resetPresentationEvenness === 'function') resetPresentationEvenness();
        unevenWidenApplied = false;
        unevenFloorMs = 0;
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
        // A fresh session is a fresh judgement: the new link has neither been
        // downgraded for network stress nor recovered from one, so the
        // decode-pressure guard must not inherit the previous session's verdict.
        abrDowngradedForLink = false;
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
        // A new session has presented nothing yet, so the previous session's
        // render rate must not be reported as this one's.
        lastPresentedFps = null;
        presentedFpsValid = false;
        lastRouteText = '--';
        lastRecoveryCounts = null;
        // Never let the previous session's counters be the watchdog's baseline.
        inboundSnapshot = null;
        statsSkippedTicks = 0;
        // The rolling bitrate curve belongs to the session that produced it. It
        // was never cleared here, so after a Stage-3 reconnect the sparkline — the
        // one number a viewer screenshots when reporting lag — painted a 60s
        // throughput history spanning two different peer connections, for a full
        // minute after every reconnect. The byte baseline below is deliberately
        // preserved, so clearing the history is what makes the two consistent.
        // Guarded because js_checks.js extracts this function and runs it without
        // the module-level bindings.
        if (typeof bitrateHistory !== 'undefined' && Array.isArray(bitrateHistory)) {
            bitrateHistory.fill(0);
        }
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
            // Capture the connection this tick is FOR. The interval callback is
            // async and setInterval does not wait for it, so a teardown can land
            // while getStats() is in flight. getStats() on a CLOSING
            // RTCPeerConnection resolves rather than rejecting in Chrome, so the
            // tick used to carry on and republish inboundSnapshot with a fresh
            // performance.now() stamp carrying the DEAD session's cumulative
            // counters — which stopTelemetry() had just nulled, and which the new
            // session's startFreezeWatchdog() had re-baselined to 0, so its first
            // poll computed a large negative decodedDelta and latched the dead
            // session's counters as the baseline. Nothing throws, so it was
            // invisible; it is a state-corruption window on every teardown path.
            const pc = peerConnection;
            if (!pc || pc.connectionState !== 'connected') return;

            // A slow getStats() (low-end receiver under decode load — the
            // exact viewer this session is trying to protect) must not let
            // the next 1s tick run while this one is mid-flight: overlapping
            // ticks both compute their deltas from the SAME baseline and
            // double-count one window of loss/jitter/drops into the ABR,
            // accommodation and Eco Mode state machines. Skipping a tick is
            // free; a spurious stress spike is not.
            if (statsTickInFlight) {
                // Counted, not silent. A persistently slow getStats() skips every
                // tick, which freezes avgPlayoutDelayAt (so catch-up bails), the
                // supervisor's counters, inboundSnapshot (so the freeze watchdog
                // bails) and reapplyBufferTargets() — the entire recovery stack
                // goes quiet at once, with nothing in the console or the HUD to
                // say so. That converts every other defect here from
                // "auto-recovered" into "permanent for the session" and makes the
                // result close to undiagnosable after the fact.
                statsSkippedTicks += 1;
                if (statsSkippedTicks === 30 || statsSkippedTicks === 120) {
                    console.warn(`[WebRTC] ${statsSkippedTicks} stats ticks skipped to a slow `
                        + 'getStats(); the buffer supervisor, catch-up and the freeze watchdog '
                        + 'are all starved while this persists.');
                }
                return;
            }
            statsTickInFlight = true;

            try {
                const stats = await pc.getStats();
                // The world may have moved on across that await. Bail rather than
                // publish a dead session's counters into a live one's state.
                if (pc !== peerConnection || pc.connectionState !== 'connected'
                    || !isConnected) {
                    statsTickInFlight = false;
                    return;
                }
                let videoStats = null;
                let audioStats = null;
                let candidatePairStats = null;

                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        videoStats = report;
                    }
                    // The audio report arrives in this same walk, so reading it is
                    // free. It used to be discarded on the floor: every consumer
                    // in this file filtered on kind === 'video', which left the
                    // entire audio half of A/V sync unobserved — concealment
                    // (audible gaps), the UA stretching audio to reach the video
                    // target, and the audio clock's own drift.
                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        audioStats = report;
                    }
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected || !candidatePairStats)) {
                        candidatePairStats = report;
                    }
                });

                measureAudioStats(audioStats);

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
                            // Only a sample actually taken THIS tick may drive the
                            // header. The `else` below leaves the previous value
                            // in place, so without this flag a latched reading
                            // would keep being reported as current.
                            presentedFpsValid = true;
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

                    // What the UA is ACTUALLY running, as opposed to what was
                    // requested. jitterBufferTarget is a hint with a UA-chosen
                    // min/max, so a silent clamp is currently invisible and the
                    // accommodation reacts to its consequences as if they were
                    // network stress.
                    measureGrantedTarget(videoStats);

                    const decoded = videoStats.framesDecoded || 0;
                    const dropped = videoStats.framesDropped || 0;
                    const received = videoStats.framesReceived || 0;
                    // The decoder's OWN drops. `framesDiscarded` is NOT a member of
                    // RTCInboundRtpStreamStats — verified against the W3C WebRTC-Stats
                    // CRD and the current editor's draft, where the string does not
                    // occur at all (the inbound dictionary defines framesReceived /
                    // framesDecoded / framesDropped and nothing by that name). The
                    // previous code read it anyway, so Number.isFinite(undefined) was
                    // false, discardedLevel was permanently 0, discardedDelta was
                    // permanently 0, and `delivered` collapsed back to decodedDelta —
                    // exactly the ratio the comment above says was removed. The
                    // consequence was not cosmetic: a link with sustained loss backs
                    // frames up in the jitter buffer faster than the decoder drains
                    // them, decodedDelta/receivedDelta sits under 0.85 for eight
                    // qualifying ticks, decodeLagSec reaches 8, and switchRendition()
                    // tears the session down — a 2-4s HARD BLACK SCREEN with the
                    // message "this device's decoder can't keep up", for a problem the
                    // buffers were already absorbing perfectly well.
                    //
                    // The spec-defined replacement is the frame DELTA the decoder had
                    // the opportunity to show but did not: frames the transport
                    // delivered, less the frames that actually left the jitter buffer
                    // into the decoder. The jitter buffer's emitted count is the exact
                    // boundary — a frame still sitting in the buffer has not been
                    // offered to the decoder and must not be charged to it — and
                    // unlike framesDiscarded it is a standardized cumulative counter
                    // this file already reads every tick.
                    //
                    // Chromium does expose a non-standard `framesDiscarded`, so it is
                    // still honoured when present; this only changes behaviour where
                    // it is absent, which is everywhere the spec is authoritative.
                    const hasDiscardedSignal = Number.isFinite(videoStats.framesDiscarded);
                    const discardedLevel = hasDiscardedSignal
                        ? videoStats.framesDiscarded : 0;
                    // Publish for the freeze watchdog (one getStats walk per
                    // second, shared) — see inboundSnapshot above.
                    //
                    // `fps` rides along so the watchdog can judge decode progress
                    // as a RATE against the stream's rate instead of testing
                    // `decodedDelta === 0` (see isDecoderStalled).
                    //
                    // It MUST be the stream's NOMINAL rate, not the current decode
                    // rate. A first attempt derived it from this same tick's
                    // `framesDecoded` delta, which made the test self-defeating:
                    // when a 60fps stream decodes at 2fps, the published rate
                    // collapses to 2, the expected minimum becomes
                    // 2 * 1.5 * 0.25 = 0.75 (floored to 1), and the 3 frames
                    // actually decoded comfortably clear it — so the test
                    // returned false for the exact slideshow it was written to
                    // catch, while passing a unit test that hand-fed it fps=60.
                    // The expectation has to come from something the decoder
                    // cannot drag down with it.
                    //
                    // `framesPerSecond` is the UA's view of the incoming frame
                    // rate and is the primary source. It is a short window too,
                    // so a PEAK HOLD over recent ticks is used as the reference:
                    // it rises immediately on a genuine rate change and decays
                    // slowly, so a transient decode collapse cannot redefine
                    // "normal" for the very window in which it must be detected.
                    const snapTime = performance.now();
                    const nominalFps = Number.isFinite(videoStats.framesPerSecond)
                        ? videoStats.framesPerSecond
                        : (currentFrameRate !== null && Number.isFinite(currentFrameRate)
                            ? currentFrameRate : null);
                    // A long, slow tail is the point: a decode stall lasts
                    // seconds, so the reference must not halve inside it.
                    if (nominalFps !== null && nominalFps > 0) {
                        stallReferenceFps = stallReferenceFps === null
                            ? nominalFps
                            : Math.max(nominalFps, stallReferenceFps * 0.98);
                    }
                    inboundSnapshot = {
                        decoded,
                        bytes: videoStats.bytesReceived || 0,
                        fps: stallReferenceFps,
                        at: snapTime
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

                    // Picture-loss ratio over this window. The standard broadcast
                    // QoE metric, and the answer to the only question a viewer or
                    // broadcaster actually asks about a rough stream: "how much
                    // of the picture never made it to the screen?". Both counters
                    // were already being read here for other reasons, so this
                    // costs nothing and turns two debug fields into one number
                    // that can be compared across sessions and against a target.
                    const dReceived = received - lastFramesReceived;
                    const dDecoded = decoded - lastFramesDecodedCount;
                    if (dReceived > 0) lastPlrPct = pictureLossRatioPct(dReceived, dDecoded);
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
                        // Exclude ticks the app is deliberately draining at above
                        // real time. The comment above promised this and there
                        // was no guard, so the promise was never kept: when
                        // updateLiveEdgeCatchUp() is running (catchUpRate > 1),
                        // the UA reaches the new, lower jitter-buffer target by
                        // ACCELERATING playout and by DISCARDING buffered frames
                        // — which is exactly what `framesDropped` counts. The
                        // app was therefore manufacturing the very frame-drop
                        // pressure this window is meant to detect, and a viewer
                        // who drifted behind the live edge for a few seconds
                        // would get a spurious "reduced decorative effects"
                        // notice and permanent CSS degradation for a session
                        // whose decoder was never under any pressure at all.
                        // The window is still pruned on a catch-up tick (below)
                        // so entries age out at the normal rate.
                        if (catchUpRate <= 1) {
                            dropWindow.push(Math.max(0, droppedDelta));
                        }
                        if (dropWindow.length > 3) dropWindow.shift();
                        if (dropWindow.reduce((sum, value) => sum + value, 0) >= 9) maybeAutoPerfMode();
                    }

                    // Interval packet loss feeds the adaptive buffer supervisor.
                    //
                    // The old reading was `dLost / (dRx + dLost)`, which is wrong
                    // in the one direction that matters most: `packetsReceived`
                    // is defined by the stats spec to INCLUDE retransmissions,
                    // so a link dropping 20% of its packets that RTX then repairs
                    // reads ~0% loss. RTX is negotiated and working, that viewer is
                    // genuinely smooth, and the ABR ladder must not tear its
                    // rendition down for a problem it does not have. Meanwhile a
                    // MediaMTX reader-queue overflow — a real, unrepairable drop —
                    // was invisible as a separate cause. networkLossPct() nets
                    // retransmissions out of the loss term and charges local
                    // jitter-buffer discards to the same denominator, so what the
                    // supervisor sees is the loss that actually reached the
                    // decoder. See networkLossPct() for the full derivation.
                    const rxNow = videoStats.packetsReceived || 0;
                    const lostNow = videoStats.packetsLost || 0;
                    const retxNow = Number.isFinite(videoStats.retransmittedPacketsReceived)
                        ? videoStats.retransmittedPacketsReceived : 0;
                    const discardNow = Number.isFinite(videoStats.packetsDiscarded)
                        ? videoStats.packetsDiscarded : 0;
                    const dLost = lostNow - lastPacketsLost;
                    const dRetx = retxNow - lastRetransmittedPackets;
                    const dDiscarded = discardNow - lastPacketsDiscarded;
                    // `dRx` is the denominator's received term. It must be the
                    // RAW delta, not a clamped one: it is a count of packets that
                    // actually arrived, and clamping it to 0 on a counter reset
                    // would silently make the whole window look like 100% loss.
                    // A negative delta (reset) is handled inside networkLossPct,
                    // which treats it as 0 rather than as negative volume.
                    const dRx = rxNow - lastPacketsReceived;
                    //
                    // The assignment is UNCONDITIONAL on purpose. Gating it on
                    // "did this window have any loss?" — the obvious-looking
                    // form — makes `lastLossPct` LATCH at its last non-zero
                    // reading forever, because a clean window is precisely the
                    // window that skips the write. The consumers treat it as a
                    // live per-tick level: the ABR calm predicate needs it below
                    // 2% to start counting calm seconds and eventually switch
                    // back to full quality, and the stress branch needs it below
                    // 2.5% to release the 350ms hold. A single lossy second
                    // would then pin the viewer to the 3000k rendition for the
                    // rest of the session on a link that had already recovered,
                    // and the stress raise would never release. A clean window
                    // is genuinely 0% loss, so it must write 0.
                    if (lastPacketsReceived > 0 || lastPacketsLost > 0) {
                        const lostDelta = Math.max(0, dLost);
                        const discardDelta = Math.max(0, dDiscarded);
                        lastLossPct = networkLossPct(lostDelta, dRetx, discardDelta, dRx);
                        // NACK effectiveness. `dRetx` is how much of the loss the
                        // retransmission path actually repaired in this window.
                        // Two failure modes look identical from `packetsLost`
                        // alone and are separated by this number:
                        //   - a low rate with high loss  => RTX is dead (no
                        //     retransmissions arriving), so the loss is real and
                        //     the only fix is a smaller rendition or more buffer;
                        //   - a high rate with high loss => retransmissions are
                        //     arriving but too late for playout, which is a
                        //     latency problem the buffer target fixes.
                        // Reported rather than acted on: the correct response
                        // differs per case and both are already covered by the
                        // existing loss/jitter controllers, so this is an
                        // observability fix, not a control change.
                        const retxDelta = Math.max(0, dRetx);
                        lastRepairRatePct = lostDelta > 0
                            ? Math.min(100, (retxDelta / lostDelta) * 100)
                            : null;
                    }
                    lastPacketsReceived = rxNow;
                    lastPacketsLost = lostNow;
                    lastRetransmittedPackets = retxNow;
                    lastPacketsDiscarded = discardNow;

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
                    // Hoisted out of the block below, and deliberately declared
                    // BEFORE the `if`: the decode-pressure calculation further down
                    // needs the same "frames that actually left the jitter buffer
                    // toward the decoder" quantity, and a block-scoped const cannot
                    // reach it. A frame still sitting in the buffer has not been
                    // offered to the decoder, so it must not be charged to it as
                    // decode pressure. 0 when the browser does not report the
                    // counter, which keeps the fallback inert rather than negative.
                    // `emittedDelta` — frames that actually LEFT the jitter buffer
                    // toward the decoder this tick.
                    //
                    // IT HAS ITS OWN BASELINE (`lastJitterEmittedForDecode`),
                    // deliberately not shared with `lastJitterEmittedTotal`.
                    // Sharing them looked harmless and was not:
                    // `windowedPlayoutDelayMs` divides the jitterBufferDelay total
                    // by the emitted delta, so those two MUST advance together.
                    // When the emitted baseline was advanced unconditionally (to
                    // feed the decode denominator below) while the delay baseline
                    // only advanced when both counters were finite, a single tick
                    // with a non-finite jitterBufferDelay left them desynchronised
                    // and the next reading divided an N-tick delay total by a
                    // 1-tick emitted delta — roughly N times the true delay. At
                    // N=15 that is 3200ms against a 3100ms rejoin cap, and it
                    // feeds `bufferAccommodationMs`, so one momentary stall could
                    // spike the target to the 2200ms cap in a single write. Two
                    // independent baselines, two independent measurements, no
                    // shared clock.
                    const emittedKnown = Number.isFinite(videoStats.jitterBufferEmittedCount);
                    const emittedDelta = emittedKnown
                        ? Math.max(0, videoStats.jitterBufferEmittedCount - lastJitterEmittedForDecode)
                        : 0;
                    if (emittedKnown) {
                        lastJitterEmittedForDecode = videoStats.jitterBufferEmittedCount;
                    }
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
                        // (The DECODE baseline was moved above this block; see emittedDelta.)
                        lastJitterDelayTotal = videoStats.jitterBufferDelay;
                        // Accommodation feeds off the measured delay but only
                        // RAISES while late frames are actually being
                        // discarded and the buffer has outgrown the base
                        // target. Sustained calm drains the extra latency back
                        // 100ms per tick.
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
                        // But it needs a MATERIALITY threshold, not a bare `>`.
                        // The two counters are not independent:
                        //   emitted = arrived - (late-discarded) - (buffer level)
                        // and the buffer level is a LEVEL, so its delta is the rate
                        // of change of that level. Any buffer that is filling,
                        // draining, or re-equilibrating - including settling toward
                        // this controller's OWN previous raise - produces
                        // arrived - emitted > 0 with no frame ever having been
                        // discarded. At 60fps a single 16.7ms frame is enough. With
                        // zero tolerance `dropsNow` was true on essentially every
                        // tick, which made the `!dropsNow && calmTicks >= 5` decay
                        // branch in bufferAccommodationMs() UNREACHABLE: the extra
                        // latency from one drop burst stayed pinned for the whole
                        // session and the HUD read "absorbing" forever.
                        // Requiring a real fraction of the window restores the
                        // intended meaning without going blind to genuine drops.
                        const arrivedDelta = videoStats.framesReceived - lastFramesReceived;
                        const lateFrameEvidence = Number.isFinite(arrivedDelta)
                            && emittedDelta > 0
                            && (arrivedDelta - emittedDelta) > Math.max(2, emittedDelta * 0.05);
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
                            // `lateFrameEvidence` counts frames that physically
                            // arrived but never left the jitter buffer. That is a
                            // STRONGER signal than `droppedDelta` — the decoder
                            // reported zero losses, so the decoder's own drop
                            // counter reads clean while the viewer watches frames
                            // disappear. The accommodation gate below already
                            // treats the two as equivalent (`droppedDelta > 0 ||
                            // lateFrameEvidence`), and reapplyBufferTargets()
                            // reads `recentDropAt` to decide whether a protective
                            // raise may skip the 3s dwell.
                            //
                            // Those two used to disagree: `recentDropAt` was set
                            // ONLY on `droppedDelta > 0`. So on a link where the
                            // loss is absorbed by the buffer rather than by the
                            // decoder — precisely the marginal case the
                            // accommodation exists for — the gate opened, the
                            // target was raised, and then the raise sat behind the
                            // full 3-second dwell anyway, because the one signal
                            // that would have shortened it was the one signal that
                            // never fired. The 1200ms emergency path was disabled
                            // exactly when it was needed.
                            if (droppedDelta > 0 || lateFrameEvidence) {
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
                    // What the viewer SEES is the presented-frame rate from
                    // requestVideoFrameCallback, not the decoder's output rate.
                    // `framesPerSecond` and `framesDecoded` are both derived from
                    // decode, and a frame can be decoded without ever reaching
                    // the screen — so on a stream that decodes 60 and presents
                    // 15, this used to read 60 and hide the exact fault it exists
                    // to reveal.
                    //
                    // Guarded on `presentedFpsValid` rather than on the value:
                    // `lastPresentedFps` is latched to 0 whenever playback stalls
                    // (paused, hidden tab, no new frames), and `??` only falls
                    // through on null/undefined, so 0 would be taken as an
                    // authoritative "0 fps" and the header would read 0 on every
                    // paused viewer. An explicit validity flag lets a genuinely
                    // fresh sample win and a stale or absent one fall back to the
                    // decode-derived number, which is the lesser evil.
                    currentFrameRate = presentedFpsValid ? lastPresentedFps : (reportedFps ?? measuredFps);
                    // The spec's freeze bound moves with the frame rate, so it
                    // has to be derived from the rate actually in force rather
                    // than from a constant that is only correct at one rate. In
                    // the 10-120fps range the `+150` term dominates, so the bound
                    // is 166.7ms at 60fps, 183.3ms at 30fps and 191.7ms at 24fps.
                    // A single constant is too tight at low frame rates (fires
                    // constantly) or too loose at high ones (misses real freezes).
                    // Reported only: the staged recovery costs 2-4s of black,
                    // which is worse than the freeze, so a short freeze should
                    // widen the buffer rather than tear the session down.
                    const rateForFreeze = reportedFps ?? measuredFps;
                    if (Number.isFinite(rateForFreeze) && rateForFreeze > 0) {
                        specFreezeMs = specFreezeThresholdMs(1000 / rateForFreeze);
                        // The bound the WATCHDOG acts on is derived from the
                        // peak-hold, not from the live reading. Sourcing it from
                        // `rateForFreeze` made the detector structurally blind to
                        // exactly the case the rate test exists to catch:
                        // `specFreezeThresholdMs(1000/R)` is by construction at
                        // least 3x the frame duration at rate R, so when decode
                        // collapses the bound inflates WITH the collapse and the
                        // observed gap never crosses it.
                        //
                        // Measured, for a sustained reduced decode rate:
                        //   2fps  -> gap 500ms vs bound 1500ms  (never stale)
                        //   5fps  -> gap 200ms vs bound  600ms  (never stale)
                        //  24fps  -> gap  42ms vs bound  192ms  (never stale)
                        //  60fps  -> gap  17ms vs bound  167ms  (never stale)
                        // So `isFrameStale` was false at EVERY rate, and since the
                        // watchdog ANDs it with the (correct) rate test, the rate
                        // test's verdict was discarded one line later and a 60fps
                        // stream decoding at 2fps played out indefinitely.
                        //
                        // `stallReferenceFps` is the high-water mark, so a genuine
                        // 60->24 source change decays toward the new rate over
                        // ~50 ticks while the delivered frame count is already at
                        // the new rate — the bound stays wide enough not to fire.
                        // `specFreezeMs` itself is left sourced from the live rate
                        // because the diagnostic report shows it beside
                        // `frameRate`, and the two must describe the same thing.
                        stallDetectMs = stallReferenceFps !== null
                            ? specFreezeThresholdMs(1000 / stallReferenceFps)
                            : specFreezeMs;
                    }

                    // Decode-pressure detection: packets arrive, packetsLost
                    // stays 0, yet decoded falls behind received — the viewer's
                    // decoder cannot sustain the stream (typically software
                    // AV1 at high resolution on a loaded machine). Sustained,
                    // it drives the supervisor's hardware-path switch.
                    //
                    // The emitted baseline for THIS measurement was already
                    // advanced above, where `emittedDelta` is computed. It must
                    // NOT share `lastJitterEmittedTotal` with the playout-delay
                    // measurement above, because that one divides a delay total
                    // by the emitted delta and needs both to advance in lockstep.

                    // The decoder's OWN drops, where the browser reports them.
                    // `framesDiscarded` is NOT a member of RTCInboundRtpStreamStats —
                    // verified against the W3C WebRTC-Stats CRD and the current
                    // editor's draft, where the string does not occur at all. The
                    // code read it anyway, so this was permanently 0 in every
                    // spec-conforming engine. Chromium does expose it as a
                    // non-standard extension, so it is still honoured where present;
                    // where it is absent the DENOMINATOR below changes instead, which
                    // is the half of the fix that actually works everywhere.
                    const discardedDelta = hasDiscardedSignal
                        ? Math.max(0, discardedLevel - lastFramesDiscarded)
                        : 0;
                    const receivedDelta = received - lastFramesReceived;
                    // The decoder's shortfall, spec-defined.
                    //
                    // `receivedDelta` counts every frame the transport handed to
                    // the JITTER BUFFER, and that includes frames still sitting in
                    // it. A frame that has not left the buffer has not been offered
                    // to the decoder, so it is not decoder pressure — and on a link
                    // with loss the buffer backs up, which made
                    // decodedDelta/receivedDelta sit under 0.85 for eight qualifying
                    // ticks and drove switchRendition() into a 2-4s hard teardown
                    // with "this device's decoder can't keep up", for a problem the
                    // buffers were absorbing perfectly well.
                    //
                    // The denominator must therefore be the frames that actually
                    // LEFT the buffer toward the decoder. `jitterBufferEmittedCount`
                    // is exactly that, and unlike `framesDiscarded` (which is NOT a
                    // member of RTCInboundRtpStreamStats — the string does not occur
                    // in the W3C CRD or the editor's draft at all, so relying on it
                    // alone left this term permanently 0 in every spec-conforming
                    // engine and the ratio degenerated to the wrong one) it is a
                    // standardized cumulative counter this file already reads.
                    //
                    // `emittedDelta` is 0 whenever the browser does not report the
                    // counter, and on the FIRST tick after a (re)start, because the
                    // baseline is then still 0. There is deliberately NO fallback to
                    // receivedDelta here: receivedDelta includes frames still sitting
                    // in the jitter buffer, so it is exactly the loss-sensitive
                    // denominator this change exists to remove, and falling back to it
                    // re-created the false teardown on precisely the first tick of
                    // every session. An unmeasurable window DECAYS instead, which is
                    // the same treatment every other unmeasurable window gets.
                    if (timeDiffSec > 0.5 && emittedKnown && emittedDelta >= 15) {
                        decodeLagSec = updateDecodeLag(
                            decodeLagSec, decodedDiff, emittedDelta, discardedDelta);
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
        lastPresentedFps = null;
        presentedFpsValid = false;
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
                // Playout target: requested vs actually granted. The gap is the
                // single most useful number in this report when a viewer says
                // "the buffer setting does nothing" — a large negative delta
                // means the UA clamped the request and every buffer decision
                // downstream was regulating against a fiction.
                playout: {
                    requestedTargetMs: clampJitterBufferTargetMs(currentBufferTargetMs()),
                    grantedTargetMs: grantedTargetMs === null ? 'not reported by this browser' : Math.round(grantedTargetMs),
                    grantedMinusRequestedMs: grantedTargetDeltaMs === null ? 'unavailable' : Math.round(grantedTargetDeltaMs),
                    uaMinimumTargetMs: uaMinTargetMs === null ? 'not reported' : Math.round(uaMinTargetMs),
                    measuredDelayMs: avgPlayoutDelayMs === null ? 'unavailable' : Math.round(avgPlayoutDelayMs)
                },
                // A/V and presentation. `playbackRate` stays 1.0 for a MediaStream,
                // so `effectiveRate` (d(mediaTime)/d(wall) from rVFC) is the only
                // instrument for "the video speeds up / slows down". A rate
                // persistently above 1 means the element is spending buffer
                // surplus, which is a visible hitch-then-jump.
                av: {
                    elementPlaybackRate: player.playbackRate,
                    effectiveRate: playbackRate === null ? 'unavailable' : Number(playbackRate.toFixed(4)),
                    audioClockDriftPpm: audioDriftPpm === null ? 'unavailable' : Math.round(audioDriftPpm),
                    audioConcealmentEvents: audioConcealEvents,
                    audioStretchedSamples: audioStretchEvents,
                    audioPulled: audioIsPulled()
                },
                freeze: {
                    // The spec's bound scales with the frame rate; a fixed
                    // constant is only right at 60fps. lastFrameGapMs is the
                    // wall time since the previous presented frame — the same
                    // quantity the bound is defined against — so putting them
                    // side by side is what makes a short freeze legible
                    // instead of a number with no context.
                    specFreezeThresholdMs: specFreezeMs === null ? 'unavailable' : Math.round(specFreezeMs),
                    lastFrameGapMs: lastFrameGapMs > 0 ? Math.round(lastFrameGapMs) : 'unavailable',
                    lastFrameGapExceedsSpecFreeze: (specFreezeMs !== null && lastFrameGapMs > specFreezeMs) ? true : false,
                    frameRate: currentFrameRate === null ? 'unavailable' : Number(currentFrameRate.toFixed(2)),
                    presentedFps: lastPresentedFps === null ? 'unavailable' : Number(lastPresentedFps.toFixed(2)),
                    // Presentation evenness. `frameGapCv` is the coefficient of
                    // variation of the inter-presented-frame interval: the ONLY
                    // figure in this report that can be non-zero on a session
                    // where loss, jitter, drops and drift are all clean, which is
                    // exactly the "not smooth but nothing is wrong" report. A
                    // `statsTicksSkipped` above zero is likewise the signature of
                    // a starved control loop.
                    frameGapMeanMs: frameGapWindow.length > 0
                        ? Number((frameGapWindow.reduce((a, b) => a + b, 0) / frameGapWindow.length).toFixed(2))
                        : 'unavailable',
                    frameGapCv: (() => {
                        const cv = frameGapUnevenness(frameGapWindow);
                        return cv === null ? 'unavailable' : Number(cv.toFixed(3));
                    })(),
                    unevenWidenApplied: unevenWidenApplied ? true : false,
                    unevenFloorMs: unevenFloorMs > 0 ? unevenFloorMs : 'not applied',
                    statsTicksSkipped: statsSkippedTicks,
                    catchUpRate: Number(catchUpRate.toFixed(2)),
                    catchUpProvenUseless: catchUpProvenUseless ? true : false,
                    recoveryCount,
                    snapshotMisses
                },
                // End-to-end quality, measured. `pictureLossPct` is the standard
                // broadcast metric (frames received but never decoded, as a
                // share of frames received) and is the single number that
                // answers "was this session actually smooth?". `netLossPct` is
                // the loss that reached the decoder AFTER retransmission, which
                // is what the ABR ladder acts on; `repairRatePct` says where
                // the packets went, separating "RTX is dead" from "RTX is too
                // late", which are otherwise indistinguishable here.
                quality: {
                    pictureLossPct: lastPlrPct === null ? 'unavailable' : Number(lastPlrPct.toFixed(2)),
                    netLossPct: lastLossPct === null ? 'unavailable' : Number(lastLossPct.toFixed(2)),
                    rtxRepairRatePct: lastRepairRatePct === null ? 'no loss in this window' : Number(lastRepairRatePct.toFixed(1))
                },
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
                // Cumulative count of frames submitted for composition. Much
                // closer to what the viewer saw than framesDecoded, though the
                // spec describes it as "submitted for composition", not as
                // frames actually seen.
                if (metadata && Number.isFinite(metadata.presentedFrames)) {
                    lastPresentedFrames = metadata.presentedFrames;
                }
                // metadata.mediaTime is the media presentation timestamp of the
                // frame submitted to the compositor, equal to its timestamp on
                // the currentTime timeline, so d(mediaTime)/d(wall) is the rate
                // of PRESENTED media per unit wall time.
                //
                // Read it as a presented-rate signal, not as "the playbackRate
                // the element is using": rVFC fires per frame sent to the
                // compositor, so a source that is itself dropping frames reports
                // a LOWER ratio while still running at exactly 1.0x. That is
                // still the useful reading — a rate persistently above 1 means
                // the element is spending buffer surplus, which is the visible
                // hitch-then-jump — but it is a presented-rate measure, and
                // presentedFrames alongside it is what separates the two causes.
                if (metadata && Number.isFinite(metadata.mediaTime)) {
                    if (lastMediaTimeSec !== null) {
                        const wallSec = (now - lastFramePresentAt) / 1000;
                        const mediaDelta = metadata.mediaTime - lastMediaTimeSec;
                        lastFrameGapMs = now - lastFramePresentAt;
                        // Fold the inter-frame gap into the evenness window. This
                        // is the only place in the file that can observe the
                        // SPACING of presented frames, and spacing is what "not
                        // smooth" actually means. Consumed by
                        // superviseAdaptiveBuffer() and reported to the HUD.
                        //
                        // Gaps at or beyond a second are a STALL, not unevenness,
                        // and the freeze watchdog owns those; including them here
                        // would let one freeze dominate the window for 90 frames.
                        if (lastFrameGapMs > 0 && lastFrameGapMs < 1000) {
                            frameGapWindow = noteFramePresentation(lastFrameGapMs, frameGapWindow);
                        }
                        // > 1 => the element is running FAST, spending surplus
                        // buffer; < 1 => starved. Both are reported, never acted
                        // on here: the correction is a buffer-target change, and
                        // the supervisor owns those.
                        if (mediaDelta > 0 && wallSec > 0) {
                            playbackRate = effectivePlaybackRate(mediaDelta, wallSec, playbackRate);
                        }
                    }
                    lastMediaTimeSec = metadata.mediaTime;
                    lastFramePresentAt = now;
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
        lastFreezeCheckAt = performance.now();
        lastFrameTime = performance.now();
        // A new session may publish at a completely different frame rate, so
        // the previous session's peak-hold must not become this one's bar.
        stallReferenceFps = null;
        stallDetectMs = null;

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
                // A stale snapshot means the producing loop is not running. That is
                // itself a fault, but reading a frozen reading as "bytes stopped"
                // would be a worse one. It used to be a bare `return`, silently,
                // forever: the comment at the overlap guard names the target device
                // as a low-end receiver where getStats() can take 1.5-3s, and with
                // the in-flight skip the effective publish interval then exceeds the
                // 3s bound, so the ~200 lines of staged recovery were inert on
                // exactly the hardware that needs them — an undiagnosable permanent
                // freeze. After a few consecutive misses, fall back to a
                // bytes-free staleness detector so a real freeze is still caught.
                snapshotMisses += 1;
                if (snapshotMisses >= 3) {
                    const staleMs = now - lastFrameTime;
                    if (staleMs > FREEZE_THRESHOLD_MS * 2 && player.readyState >= 2) {
                        console.warn(`[FreezeGuard] No stats snapshot for ${snapshotMisses} polls and `
                            + `no frame for ${Math.round(staleMs)}ms — recovering without stats.`);
                        if (frozenSince === 0) frozenSince = now;
                        else if (now - frozenSince > FREEZE_THRESHOLD_MS) {
                            frozenSince = 0;
                            triggerFreezeRecovery('no_snapshot_freeze');
                        }
                    }
                }
                return;
            }
            snapshotMisses = 0;
            const currentDecoded = snapshot.decoded;
            const currentBytes = snapshot.bytes;

            const decodedDelta = currentDecoded - lastDecodedFrames;
            const bytesDelta = currentBytes - lastBytesCount;
            lastDecodedFrames = currentDecoded;
            lastBytesCount = currentBytes;
            // The span `decodedDelta` actually covers. It is NOT the 1.5s poll
            // period: this loop can return early (paused, hidden, stale
            // snapshot) and still count that window against the previous
            // reading, so the real span is measured, not assumed. The rate test
            // needs it because `snapshot.fps` is a per-second rate while
            // `decodedDelta` is a count over this span — see isDecoderStalled.
            const elapsedSec = (now - lastFreezeCheckAt) / 1000;
            lastFreezeCheckAt = now;

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
                    // Give the cap budget back too. `capCycles` is the ceiling on how
                    // many times the recovery budget may be re-armed after
                    // MAX_RECOVERIES, and it deliberately does not reset on teardown
                    // (a page that cannot decode this broadcast cannot). It MUST
                    // reset once the stream has genuinely recovered, or two early
                    // cap hits — each of which is followed by a session that does
                    // decode — permanently disable the freeze watchdog for the rest
                    // of the page's life, which is the same dead-watchdog failure the
                    // cap branch was written to end.
                    if (capCycles > 0) {
                        console.log(`[FreezeGuard] Stream healthy. Restoring the recovery `
                            + `budget (was ${capCycles}/${MAX_CAP_RECOVERIES}).`);
                        capCycles = 0;
                        capNoticeShown = false;
                    }
                }
            }

            // Real Freeze Detection:
            // Frame is stale AND network packets ARE flowing (not just a static
            // screen), but decoder is stalled!
            //
            // The bound is the SPEC's freeze threshold for the stream's own
            // measured frame rate (~167ms at 60fps, ~192ms at 24fps), not the
            // 3s constant it used to use for both halves of the test. A fixed
            // 3000ms is 12-18x the point at which a viewer would already have
            // called this a freeze, and it was ALSO the confirmation window, so
            // the worst case was 3s to notice plus another 3s to believe it:
            // ~6s of black screen before recovery could even start, on a
            // problem the whole watchdog exists to shorten.
            //
            // Splitting the two is what makes this safe to tighten. DETECTION is
            // now spec-accurate and cheap; CONFIRMATION stays deliberately
            // conservative because triggerFreezeRecovery() costs 2-4s of black
            // and is strictly worse than the short freeze it would "fix" — so a
            // glitch has to persist for a full second across multiple polls
            // before the session is torn down. See specFreezeThresholdMs().
            //
            // The spec bound is only trusted while rVFC is actually running: it
            // is the callback that keeps `lastFrameTime` fresh, so in a browser
            // without requestVideoFrameCallback the staleness reading is pinned
            // at the session start and every threshold is crossed forever. That
            // is a false freeze on every single tick, so those browsers keep the
            // conservative bound and the decoder-rate test carries the decision.
            const hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
            // `stallDetectMs` (peak-hold derived) rather than `specFreezeMs`
            // (live-rate derived). See the publish site: a bound computed from
            // the current rate inflates as the decoder slows and can never be
            // crossed by the gap that slowing produced, which made the rate
            // test's verdict unreachable.
            const detectMs = (hasFrameCallback && stallDetectMs !== null)
                ? stallDetectMs
                : FREEZE_THRESHOLD_MS;
            const isFrameStale = frameStaleness > detectMs;
            const isActualDecoderStall = currentDecoded > 0
                && isDecoderStalled(bytesDelta, decodedDelta, snapshot.fps, elapsedSec);

            if (isFrameStale && isActualDecoderStall) {
                if (frozenSince === 0) {
                    frozenSince = now;
                    console.warn(`[FreezeGuard] Potential freeze detected. Staleness: ${Math.round(frameStaleness)}ms, bytesDelta: ${bytesDelta}, decodedDelta: ${decodedDelta}, fps: ${snapshot.fps === null ? '--' : snapshot.fps.toFixed(1)}.`);
                } else if (now - frozenSince >= FREEZE_CONFIRM_MS) {
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
        // Detach the element handlers too. They were assigned in
        // startFreezeWatchdog() and never removed, so they outlived every session.
        // Stage 3 calls cleanupConnection(), which does `player.srcObject = null`;
        // nulling srcObject fires `emptied` and can fire `waiting` in Blink, which
        // armed a fresh 4s stallTimeout against a session that was being torn
        // down. If it fired before `isConnected` was cleared, the guard passed and
        // triggerFreezeRecovery() ran on a half-torn-down session.
        player.onwaiting = null;
        player.onplaying = null;
        if (recoveryCooldownTimer) {
            clearTimeout(recoveryCooldownTimer);
            recoveryCooldownTimer = null;
        }
        snapshotMisses = 0;
        frozenSince = 0;
    }

    // Staged 3-Tier Auto-Recovery
    async function triggerFreezeRecovery(reason) {
        if (isRecovering) {
            console.log("[FreezeGuard] Recovery already in progress. Skipping.");
            return;
        }
        if (recoveryCount >= MAX_RECOVERIES) {
            // Do NOT sit here as a permanent no-op, and do NOT reconnect forever
            // either. `recoveryCount` only decays in the watchdog's own healthy
            // branch, which requires decodedDelta > 0 — and a freeze that all three
            // stages failed to clear has decodedDelta stuck at 0 by definition, so
            // the counter can never decay and the old `return` left the watchdog
            // dead for the whole page load: the interval kept calling a function
            // that returned immediately, the frozen picture never recovered, and
            // nothing in the console or the HUD said why.
            //
            // But a broadcast this device genuinely cannot decode fails the same
            // way every time, so an unbounded re-arm produces an endless loop of
            // 10 staged recoveries plus a hard reconnect, each one a full WHEP
            // renewal and a 2-4s black screen, forever. The cap therefore allows a
            // BOUNDED number of re-armed cycles and then stops for good, with a
            // message that says what actually happened. `capCycles` is the ceiling.
            if (capCycles >= MAX_CAP_RECOVERIES) {
                console.error('[FreezeGuard] Recovery budget exhausted after '
                    + `${capCycles} re-armed cycles. Stopping automatic recovery.`);
                // NOT gated on `capNoticeShown`. That flag is already true by the
                // time this runs — it was set during cycle 1 — so reusing it meant
                // the terminal notice was never posted, and the viewer was left
                // staring at a frozen picture holding a message that claimed a
                // reconnect was in progress. This is the one message that must
                // always get through.
                addSystemMessage('⚠️ This broadcast could not be played on this device '
                    + 'after repeated attempts. Try reloading, or another browser.');
                isRecovering = false;
                return;
            }
            capCycles += 1;
            console.error(`[FreezeGuard] Max recovery attempts (${MAX_RECOVERIES}) reached. `
                + `Re-arming with a hard reconnect (cycle ${capCycles}/${MAX_CAP_RECOVERIES}).`);
            recoveryCount = 0;
            healthyPlaybackSeconds = 0;
            if (!capNoticeShown) {
                capNoticeShown = true;
                addSystemMessage("⚠️ Video kept freezing — reconnecting the video pipeline. "
                    + 'If this repeats, reload the page or try another browser.');
            }
            isRecovering = true;
            frozenSince = 0;
            stopFreezeWatchdog();
            stopTelemetry();
            cleanupConnection();
            isConnected = false;
            isConnecting = false;
            updateUIState('connecting');
            try {
                await connectStream();
            } catch (err) {
                console.error('[FreezeGuard] Hard reconnect after recovery cap failed:', err);
                isRecovering = false;
                handleDisconnected();
                return;
            }
            if (recoveryCooldownTimer) clearTimeout(recoveryCooldownTimer);
            recoveryCooldownTimer = setTimeout(() => {
                recoveryCooldownTimer = null;
                isRecovering = false;
            }, 3000);
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

        // Store the handle. This timer used to be fire-and-forget: if this session
        // died and a new one was established inside the 3s window, the orphan
        // still fired and cleared `isRecovering` on the NEW session's guard,
        // admitting a second concurrent triggerFreezeRecovery() while
        // connectStream() was still in flight. Two recoveries interleaving on one
        // element is how a stall becomes a cascade.
        if (recoveryCooldownTimer) clearTimeout(recoveryCooldownTimer);
        recoveryCooldownTimer = setTimeout(() => {
            recoveryCooldownTimer = null;
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

        // Ignore clicks on controls or HUD overlays. .chat-toast-layer is in
        // this list because a notification is deliberately clickable (it jumps
        // to the chat): without this, clicking one would also fire the
        // play/pause toggle and the fullscreen handler underneath it.
        if (e.target.closest('.player-controls') || e.target.closest('.telemetry-hud') || e.target.closest('.unmute-overlay') || e.target.closest('.chat-toast-layer')) {
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
        if (e.target.closest('.player-controls') || e.target.closest('.telemetry-hud') || e.target.closest('.unmute-overlay') || e.target.closest('.chat-toast-layer')) return;
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
        // A notification card sits directly under the pointer — it is the one
        // overlay the host deliberately moves the mouse onto to read it — so
        // without this the wheel changed the volume by 5% per notch while
        // scrolling over the message. Same exclusion the click and dblclick
        // handlers use.
        if (e.target.closest('.chat-toast-layer')) return;
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
            // ...and the presentation-evenness floor, for the same reason. It feeds
            // baseBufferTargetMs() through Math.max, so leaving it set made a
            // one-off 3-second GPU stall permanently pin the target at 600ms: the
            // button would update its label and the HUD, reapplyBufferTargets would
            // write 600ms to both receivers, and ultra (80ms) and balanced (180ms)
            // became unreachable for the rest of the session. An explicit human
            // choice has to actually win, which is the entire point of the button.
            unevenFloorMs = 0;
            unevenWidenApplied = false;
            // ...and the release clock, or the re-armed floor's first decay lands
            // on the next tick instead of after 5, unwinding 600ms in ~2s rather
            // than ~25s and re-pacing the playout on the way down.
            unevenReleaseTicks = 0;
            bufferNoticeState = '';
            lastAppliedTargetMs = null;
            updateBufferHud(null);

            // Apply immediately to active receivers. An explicit user choice is
            // never gated by the churn limiter — but it does stamp the dwell
            // anchor, so the very next adaptive tick cannot immediately undo it.
            if (peerConnection) {
                let applied = 0;
                peerConnection.getReceivers().forEach(r => {
                    // Both kinds, same target — see reapplyBufferTargets(): a
                    // mode switch that moves only video leaves the audio
                    // receiver at the old depth until the next stats tick,
                    // which the element renders as a lip-sync jump.
                    if (r.track && applyPlayoutDelay(r, r.track.kind)) {
                        applied += 1;
                    }
                });
                // Honour the SAME latch rule reapplyBufferTargets() enforces:
                // latch the target only if a receiver actually accepted the
                // write. Discarding the return value and latching
                // unconditionally meant a UA without `jitterBufferTarget` on
                // RTCRtpReceiver (where applyPlayoutDelay() returns false for
                // every receiver) still recorded the target as granted. From
                // then on reapplyBufferTargets() short-circuits on
                // `targetMs === lastAppliedTargetMs` and NEVER retries, so the
                // manual latency control silently did nothing for the rest of
                // the session while the HUD advertised the new value and every
                // downstream decision regulated against a target that was never
                // written.
                if (applied > 0) {
                    lastAppliedTargetMs = currentBufferTargetMs();
                    lastAppliedTargetChangeAt = performance.now();
                } else {
                    console.warn('[AdaptiveBuffer] Latency mode changed but no receiver '
                        + 'accepted a playout target; this browser is not applying it.');
                }
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

    // Restart a CSS keyframe animation without forcing a synchronous layout.
    //
    // The classic `el.classList.remove(c); void el.offsetWidth;
    // el.classList.add(c)` idiom forces Blink to run UpdateStyleAndLayout right
    // there, in the middle of the frame, to make the re-add count as a fresh
    // animation. Reactions run this for EVERY reaction from EVERY viewer (the
    // server caps the aggregate at 25/s), and the count element's own bump
    // follows a textContent write that changes the element's intrinsic width
    // (`.emoji-count` has padding and min-width but no fixed width), so that
    // one dirtied a whole flex chain up to `.reaction-section`, which carries a
    // `backdrop-filter: blur(12px)` — a real relayout plus a re-blur of the
    // backdrop, on the same thread that decodes video. Three such barriers per
    // reaction is up to 75/s during a hype train, and they land exactly when the
    // decoder is closest to its limit.
    //
    // The Web Animations API needs no reflow to restart: cancelling the previous
    // animation and starting a new one is compositor-driven and self-cleaning,
    // so nothing is left to time out.
    function restartCssAnimation(el, className, animationName) {
        if (!el) return;
        // SEEK TO ZERO, do not cancel.
        //
        // Cancelling a CSS animation does NOT replay it: `cancel()` removes the
        // effect, and since the class stays applied, `classList.add` afterwards
        // is a no-op — the computed animation-name never changes, so the engine
        // never re-creates the animation. Verified in Chrome against this exact
        // stylesheet: the HEAD remove/reflow/add idiom animated on all 4
        // reactions, while cancel+add animated on the FIRST one only. Two
        // further traps make cancel impossible in principle here:
        //   - `.emoji-btn.btn-popping` uses `forwards`, so a FINISHED animation
        //     is still returned by getAnimations() and cancel() kills it dead;
        //   - `count-bump` (no fill-mode) is dropped from getAnimations()
        //     entirely once finished, so there is nothing to cancel.
        // Seeking to 0 restarts the existing animation in place, needs no
        // layout, and is a no-op only if nothing is currently running.
        if (el.getAnimations) {
            el.getAnimations().forEach((anim) => {
                if (anim.animationName === animationName) {
                    anim.currentTime = 0;
                    anim.play();
                }
            });
        }
        // The class must be present for the FIRST run, when getAnimations() has
        // nothing to seek yet.
        el.classList.add(className);
    }

    function triggerButtonPop(btn) {
        if (!btn) return;
        restartCssAnimation(btn, 'btn-popping', 'emoji-btn-pop');
        const countEl = btn.querySelector('.emoji-count');
        if (countEl) {
            restartCssAnimation(countEl, 'count-bump', 'count-bump');
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
        // Opening the chat by hand is what the unread badge is asking for, so
        // it retires here. Declared below the toast engine but hoisted as a
        // function declaration, so this runs fine on the initial tab setup too.
        if (showActivity && typeof clearChatUnread === 'function') clearChatUnread();
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
    // Set once the SSE `init` event has been handled. Distinguishes "no
    // watermark because nothing has ever arrived" (a since=0 poll is then the
    // whole backlog) from "no watermark because the log is empty" (a since=0
    // poll is then real new traffic).
    let chatStreamPrimed = false;
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

    // ── Incoming chat notification (host view) ──────────────────────────────
    // A viewer message used to exist ONLY inside the sidebar log. The host is
    // watching the video, frequently with the sidebar on the other tab or
    // scrolled away, so a message could arrive and go entirely unnoticed.
    // These cards put it on screen over the video, for a bounded window.
    //
    // Density is capped for the same reason MAX_FLYING_EMOJI exists: every
    // card is a composited layer drawn ON TOP of live video, competing with
    // the decoder for the same GPU budget on the same main thread. A busy
    // room would otherwise stack one layer per message. So a burst inside
    // CHAT_TOAST_BURST_MS collapses into a "+N more" counter instead of
    // growing the stack, and the cap keeps the on-screen layer count fixed
    // however the two limits interleave.
    const CHAT_TOAST_LIFETIME_MS = 7000;
    const CHAT_TOAST_EXIT_MS = 260;   // must match .chat-toast-out in CSS
    const CHAT_TOAST_BURST_MS = 1200; // messages this close fold into the counter
    const MAX_CHAT_TOASTS = 3;
    const MAX_CHAT_UNREAD = 99;

    let liveChatToasts = 0;
    let chatUnreadCount = 0;
    let lastChatToastAt = 0;
    let chatToastOverflow = 0;
    let chatOverflowTimer = null;
    const chatToastOverflowEl = document.getElementById('chat-toast-overflow');
    // liveChatToasts is the count of cards that exist in the DOM, including any
    // that are mid-exit. dismissChatToast() decrements it only when the card is
    // actually removed, so a card on its way out keeps counting against
    // MAX_CHAT_TOASTS — the cap therefore bounds LAYERS ON SCREEN, which is
    // what costs GPU time, not just cards queued for display.

    function renderChatUnread() {
        if (!chatUnreadBadge) return;
        if (chatUnreadCount <= 0) {
            chatUnreadBadge.hidden = true;
            chatUnreadBadge.innerText = '0';
            return;
        }
        // 99+ rather than an exact count: a runaway viewer must not be able to
        // grow this label wide enough to reflow the tab strip.
        chatUnreadBadge.innerText = chatUnreadCount > MAX_CHAT_UNREAD ? MAX_CHAT_UNREAD + '+' : String(chatUnreadCount);
        chatUnreadBadge.hidden = false;
    }

    function clearChatUnread() {
        if (chatUnreadCount === 0) return;
        chatUnreadCount = 0;
        renderChatUnread();
    }

    // Retire the burst counter. Without this the "+N more" pill survived every
    // card dismissal, and because dismissChatToast keeps the layer `active`
    // while the counter is non-zero, that pill pinned the layer visible AND
    // pointer-events:auto for the rest of the session — a dead strip in the
    // video's top-right corner that swallowed clicks meant for the player.
    // Called when the host engages with the chat, and on the pill's own timer.
    function clearChatOverflow() {
        if (chatOverflowTimer) {
            clearTimeout(chatOverflowTimer);
            chatOverflowTimer = null;
        }
        if (chatToastOverflow === 0) return;
        chatToastOverflow = 0;
        updateChatToastOverflow();
        if (liveChatToasts === 0 && chatToastLayer) {
            chatToastLayer.classList.remove('active');
        }
    }

    // The "+N more" pill has to retire on its own clock. It is the last thing
    // holding the layer `active`, and an active layer is pointer-events:auto
    // over the video — left set, it becomes a permanent invisible click-eater
    // in the corner of the player's hit area, and the pill itself never goes
    // away. Each new folded message pushes the deadline out, so a sustained
    // flood stays legible while it lasts and then cleans itself up.
    function scheduleChatOverflowRetire() {
        if (chatOverflowTimer) clearTimeout(chatOverflowTimer);
        chatOverflowTimer = setTimeout(() => {
            chatOverflowTimer = null;
            chatToastOverflow = 0;
            updateChatToastOverflow();
            if (liveChatToasts === 0) {
                chatToastLayer.classList.remove('active');
            }
        }, CHAT_TOAST_LIFETIME_MS);
    }

    function updateChatToastOverflow() {
        if (!chatToastOverflowEl) return;
        if (chatToastOverflow > 0) {
            chatToastOverflowEl.innerText = '+' + chatToastOverflow + ' more';
            chatToastOverflowEl.hidden = false;
        } else {
            chatToastOverflowEl.hidden = true;
            chatToastOverflowEl.innerText = '';
        }
    }

    function dismissChatToast(card) {
        if (!card || card.dataset.leaving === '1') return;
        card.dataset.leaving = '1';
        setTimeout(() => {
            if (card.parentNode) card.parentNode.removeChild(card);
            liveChatToasts = Math.max(0, liveChatToasts - 1);
            // The layer keeps `active` while the counter is showing, so a
            // folded burst never leaves an empty-but-visible layer behind.
            // The counter itself is retired by scheduleChatOverflowRetire() —
            // it must not be zeroed here, or a flood mid-flight would lose
            // its "+N more" the instant the last card happened to expire.
            if (liveChatToasts === 0 && chatToastOverflow === 0) {
                chatToastLayer.classList.remove('active');
            }
        }, CHAT_TOAST_EXIT_MS);
        card.classList.add('leaving');
    }

    function showChatNotification(author, text, badge) {
        if (!chatToastLayer) return;

        // The badge answers exactly one question: "is there chat you are not
        // looking at?". Live Chat is the DEFAULT tab and activateSidebarTab is
        // never called at init, so the host is watching the log render in front
        // of them — counting those messages left the badge climbing to 99+ for
        // the whole session, counting what was already on screen, and it never
        // cleared because the host never "opened" a tab that was already open.
        if (!tabChat || !tabChat.classList.contains('active')) {
            chatUnreadCount += 1;
            renderChatUnread();
        }

        const now = Date.now();
        const isBurst = (now - lastChatToastAt) < CHAT_TOAST_BURST_MS;
        lastChatToastAt = now;

        // Fold instead of stacking. Over-the-cap messages also land here, so a
        // sustained flood is bounded no matter how the two limits interleave.
        if (isBurst || liveChatToasts >= MAX_CHAT_TOASTS) {
            chatToastOverflow += 1;
            updateChatToastOverflow();
            scheduleChatOverflowRetire();
            chatToastLayer.classList.add('active');
            return;
        }

        const card = document.createElement('div');
        card.className = 'chat-toast';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-message chat-toast-icon';
        icon.setAttribute('aria-hidden', 'true');

        const content = document.createElement('div');
        content.className = 'chat-toast-content';

        const head = document.createElement('div');
        head.className = 'chat-toast-head';

        const authorSpan = document.createElement('span');
        authorSpan.className = 'chat-toast-author';
        // innerText, never innerHTML: author and body are untrusted viewer
        // input, exactly as in addMessage().
        authorSpan.innerText = author;

        if (badge) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'author-badge badge-' + String(badge).toLowerCase();
            badgeSpan.innerText = badge;
            authorSpan.appendChild(badgeSpan);
        }
        head.appendChild(authorSpan);

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'chat-toast-text';
        bodyDiv.innerText = text;

        content.appendChild(head);
        content.appendChild(bodyDiv);
        card.appendChild(icon);
        card.appendChild(content);

        chatToastLayer.appendChild(card);
        chatToastLayer.classList.add('active');
        liveChatToasts += 1;

        setTimeout(() => dismissChatToast(card), CHAT_TOAST_LIFETIME_MS);
    }

    // Clicking a notification is the point of putting it over the video: take
    // the host straight to the chat so they can answer. The unread count and
    // the folded counter both retire, because the host is now looking at the
    // log that holds every one of those messages.
    if (chatToastLayer) {
        chatToastLayer.addEventListener('click', () => {
            if (tabChat && !tabChat.classList.contains('active')) {
                tabChat.click();
            }
            clearChatUnread();
            clearChatOverflow();
            if (chatInput) setTimeout(() => chatInput.focus(), 50);
        });
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
            // Only a genuinely NEW message notifies, and only for the host:
            //  - isHistory is the replayed backlog (SSE init history, or the
            //    catch-up burst after a reconnect), which would otherwise fire
            //    a card for every message the host has already seen.
            //  - isSelf is the host's own message coming back through the echo.
            //  - isHost is authoritative from the server's init event, which
            //    is why this must come after that event has been handled.
            if (isHost) {
                showChatNotification(msg.author || 'Viewer', msg.text, msg.badge || 'USER');
                // The chime instead of the generic pop: this is the host's
                // "someone is talking to me" cue, and playSfx caps concurrent
                // voices, so firing both would only spend a second voice.
                playSfx('chime');
            } else {
                playSfx('pop');
            }
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
                    // This payload is NOT always old backlog. On a native
                    // EventSource auto-reconnect the browser resends
                    // Last-Event-ID, and the server answers with
                    // `chatHistory.filter(m => m.id > lastEventId)` — exactly
                    // the messages this client MISSED while the stream was
                    // down (server.js:506-507). Those are new to the host and
                    // must notify; marking them history swallowed every message
                    // that landed during a blip, which is exactly the window
                    // this feature exists to cover. A cold first connect has no
                    // watermark, so its window really is `slice(-50)` backlog
                    // and stays silent. Sample the watermark BEFORE the batch,
                    // since applying it advances the variable.
                    const hadWatermark = lastReceivedMessageId > 0;
                    data.history.forEach((m) => handleIncomingMessage(m, !hadWatermark));
                }
                // The stream is live from here. A poll that still sends since=0
                // afterwards is asking for messages that arrived AFTER an empty
                // init — genuinely new, not backlog.
                chatStreamPrimed = true;
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
                            const next = String(data.totalCount || (cur + 1));
                            // Only write when the number actually changes. Every
                            // reaction is broadcast with the same totalCount, so a
                            // busy room produces a long run of identical values —
                            // each of which used to dirty layout and then be
                            // forced through a synchronous reflow one line below.
                            if (countEl.innerText !== next) {
                                countEl.innerText = next;
                            }
                            restartCssAnimation(countEl, 'count-bump', 'count-bump');
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
            // Read the watermark BEFORE the await. It is mutated by
            // handleIncomingMessage as the batch is applied, so testing it after
            // the fetch resolved could read a value this very batch just
            // advanced — and a batch that began at 0 would then be classified
            // as a delta and notify for the whole backlog.
            const since = lastReceivedMessageId;
            try {
                const res = await fetch(window.location.origin + `/stream-api/chat/messages?since=${since}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.ok && Array.isArray(data.messages)) {
                        // The FIRST poll sends since=0, and the server treats 0 as
                        // "send everything" (server.js:585) rather than "send
                        // nothing new" — so this response is the whole backlog,
                        // not a delta. Passing isHistory=false made a client
                        // that fell back to polling raise a notification for
                        // every message it had already been shown, up to the
                        // 100-message cap, the moment the fallback engaged.
                        // A catch-up burst is still a replay of what the log
                        // already holds, so it must be marked as history.
                        // `since === 0` alone is not enough: while the log is
                        // empty the watermark stays 0, so keying only on that
                        // silently swallowed the first LIVE message after every
                        // fallback engagement until the watermark moved. The
                        // primed flag is what separates "never received
                        // anything, so this is backlog" from "init arrived with
                        // an empty log, so this is new traffic".
                        const isCatchUp = since === 0 && !chatStreamPrimed;
                        data.messages.forEach((m) => handleIncomingMessage(m, isCatchUp));
                        // Applying a since=0 response synchronises this client,
                        // so later polls are deltas whatever the watermark is.
                        // The SSE init handler cannot be relied on to prime this:
                        // a failed EventSource constructor returns BEFORE the
                        // init listener is ever attached, and an EventSource that
                        // gets a non-200 or a non-event-stream MIME type goes
                        // straight to CLOSED without reconnecting. In both cases
                        // polling is the only transport for the whole session,
                        // and with the flag stuck false every message was
                        // classified as backlog — the host got no notification
                        // at all. Written AFTER the classification above, so it
                        // cannot weaken the first-poll catch-up guard.
                        chatStreamPrimed = true;
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
