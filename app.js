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
    let whepPostTimeout = null;          // Aborts a hung WHEP POST quickly instead of waiting for the 12s watchdog
    let isConnected = false;
    let isConnecting = false;
    let connectionStartTime = 0;
    let connectTimeout = null;           // 12s connection watchdog timer
    let statsInterval = null;
    let streamActiveCheckTimeout = null;
    let lastBytesReceived = 0;
    let lastFramesDecodedCount = 0;
    let lastStatsTime = 0;
    let controlsHideTimeout = null;
    // Last pointer position that counted as real activity. A resting hand can
    // emit mousemove events without going anywhere; requiring travel from this
    // anchor keeps such jitter from re-arming the fade timer forever.
    let controlsAnchorX = null;
    let controlsAnchorY = null;
    const POINTER_ACTIVATE_PX = 8;
    let soundEnabled = true;
    let currentBitrateMbps = null;
    let currentFrameRate = null;

    // Latency & Jitter Buffer Modes: 'ultra' (80ms), 'balanced' (180ms), 'smooth' (350ms)
    let currentLatencyMode = 'smooth';
    const LATENCY_MODES = {
        ultra: { label: 'Ultra-Low (80ms)', ms: 80, s: 0.08, icon: 'fa-bolt' },
        balanced: { label: 'Balanced (180ms)', ms: 180, s: 0.18, icon: 'fa-gauge-high' },
        smooth: { label: 'Anti-Stutter (350ms)', ms: 350, s: 0.35, icon: 'fa-shield-halved' }
    };

    // === Adaptive Buffer Supervision (anti-stutter + anti-delay drift) ===
    // The LATENCY_MODES table above is what the user SELECTED; the state below
    // tracks what the network actually NEEDS right now and how far playout has
    // drifted from the live edge. superviseAdaptiveBuffer() runs every stats tick.
    let lastPacketsReceived = 0;        // RX baseline for interval loss calculation
    let lastPacketsLost = 0;            // Lost baseline for interval loss calculation
    let lastFramesDropped = 0;          // Baseline for frame-drop pressure detection
    let dropBurstSec = 0;               // Consecutive seconds with heavy frame drops
    let stressRunSec = 0;               // Consecutive seconds of jitter/loss stress
    let calmRunSec = 0;                 // Consecutive calm seconds (restores mode target)
    let catchUpDriftSec = 0;            // Consecutive seconds playout drifted past target
    let adaptiveRaiseUntil = 0;         // >now: hold a 350ms floor (rough network)
    let catchUpUntil = 0;               // >now: hold a minimal target to reach the live edge
    let lastNetJitterMs = null;         // Smoothed inbound network jitter (ms)
    let lastLossPct = null;             // Packet loss over the last stats interval (%)
    let avgPlayoutDelayMs = null;       // Measured jitter-buffer delay (ms, where reported)
    let lastAppliedTargetMs = null;     // Last target pushed to receivers (change detection)
    let bufferNoticeState = '';         // 'raised' | 'catchup' | '' (system-message dedupe)

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
                    connectPlayerToAudioNodes();
                }).catch(e => console.warn("[Audio] AudioContext resume error:", e));
            } else {
                connectPlayerToAudioNodes();
            }
            return;
        }
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            // 'interactive' keeps the WebAudio processing quantum small for minimal A/V path latency
            audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
            gainNode = audioCtx.createGain();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 64;

            gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
            gainNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
            console.log("[Audio] Web Audio context initialized successfully.");
            connectPlayerToAudioNodes();
        } catch (e) {
            console.warn("[Audio] Could not initialize Web Audio context:", e);
        }
    }

    function connectPlayerToAudioNodes() {
        if (!audioCtx) return;
        if (audioSourceNode) {
            // Reconnect path: the MediaElementSource survives across sessions,
            // but the HUD meter was stopped on disconnect — restart it so an
            // open telemetry HUD works again after an auto-recovery.
            startAudioMeter();
            return;
        }
        try {
            audioSourceNode = audioCtx.createMediaElementSource(player);
            audioSourceNode.connect(gainNode);
            console.log("[Audio] Connected player element to GainNode & AnalyserNode.");
            startAudioMeter();
        } catch (e) {
            console.warn("[Audio] Note on MediaElementSource:", e);
        }
    }

    function setMasterGain(volumeMultiplier) {
        const clamped = Math.min(1.0, Math.max(0, volumeMultiplier));
        // If Web Audio graph is active, delegate volume to GainNode to prevent quadratic attenuation
        if (audioSourceNode && gainNode && audioCtx && audioCtx.state !== 'closed') {
            try {
                player.volume = 1.0;
                gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
                gainNode.gain.linearRampToValueAtTime(clamped, audioCtx.currentTime + 0.05);
            } catch (e) {
                player.volume = clamped;
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

        // 1. Add 60 Mbps Application-Specific bandwidth right after the m=video line (valid media-level position)
        if (modified.includes('m=video')) {
            modified = modified.replace(/(m=video[^\r\n]*[\r\n]+)/, '$1b=AS:60000\r\n');
        }

        // 2. Ensure NACK retransmission, Google REMB and Transport-CC feedback exist for every
        //    H264 payload type. Lines are inserted directly after the rtpmap entry INSIDE the
        //    m=video section — appending them at the end of the SDP would attach them to the
        //    m=audio section, which is invalid and silently ignored by the answerer.
        const desiredFeedback = ['nack', 'nack pli', 'goog-remb', 'transport-cc'];
        const presentFeedback = new Set();
        const lines = modified.split('\r\n');
        lines.forEach(line => {
            const match = line.match(/^a=rtcp-fb:(\d+)\s+(.+)$/);
            if (match) presentFeedback.add(`${match[1]} ${match[2].trim()}`);
        });

        const rebuilt = [];
        let inVideoSection = false;
        const rtpmapRegex = /^a=rtpmap:(\d+)\s+H264\/90000/i;
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

    // Effective playout/jitter-buffer target for right now.
    // Priority: live-edge catch-up > adaptive stress raise > user-selected mode.
    function currentBufferTargetMs() {
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        if (performance.now() < catchUpUntil) return 0;
        let target = config.ms;
        if (performance.now() < adaptiveRaiseUntil) target = Math.max(target, 350);
        return target;
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
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        const now = performance.now();

        // --- Live-edge catch-up (in progress) ---
        if (catchUpUntil > now) {
            reapplyBufferTargets();
            updateBufferHud('catch-up');
            return;
        }
        if (bufferNoticeState === 'catchup') {
            bufferNoticeState = '';
            console.log("[AdaptiveBuffer] Catch-up complete. Restoring mode target.");
        }

        // --- Live-edge catch-up (trigger) ---
        const driftLimitMs = Math.max(config.ms + 400, 800);
        if (avgPlayoutDelayMs !== null && avgPlayoutDelayMs > driftLimitMs) {
            catchUpDriftSec += 1;
            if (catchUpDriftSec >= 4) {
                catchUpDriftSec = 0;
                catchUpUntil = now + 2500;
                if (bufferNoticeState !== 'catchup') {
                    bufferNoticeState = 'catchup';
                    addSystemMessage('Playback drifted behind the live edge — catching up…');
                }
                reapplyBufferTargets();
                updateBufferHud('catch-up');
                return;
            }
        } else {
            catchUpDriftSec = 0;
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

    // HUD text for the buffer target / adaptive state.
    function updateBufferHud(stateOverride) {
        if (!hudBuffer) return;
        const config = LATENCY_MODES[currentLatencyMode] || LATENCY_MODES.balanced;
        const targetMs = currentBufferTargetMs();
        const state = stateOverride || (targetMs > config.ms ? 'boosted' : 'normal');
        if (state === 'catch-up') {
            hudBuffer.innerText = 'catching up…';
        } else if (state === 'boosted') {
            hudBuffer.innerText = `${targetMs} ms (stabilizing)`;
        } else {
            hudBuffer.innerText = `${targetMs} ms`;
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
        dropBurstSec = -999; // don't re-enter this function's message path again
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
    // network and would only stall ICE gathering. Cached for 30 minutes so
    // reconnects renew the view without a round trip on every attempt.
    let cachedIceServers = null;
    let cachedIceServersAt = 0;

    async function fetchIceServers() {
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
            return servers;
        } catch (error) {
            console.warn("[WebRTC] ICE config unavailable (" + error + "); falling back to host candidates.");
            return [];
        } finally {
            clearTimeout(timer);
        }
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

        // Arm 12-second connection timeout watchdog to prevent infinite connecting spinner
        if (connectTimeout) clearTimeout(connectTimeout);
        connectTimeout = setTimeout(() => {
            if (isConnecting && !isConnected) {
                console.warn("[WebRTC] Connection attempt timed out after 12s without ICE handshake. Triggering disconnect recovery.");
                addSystemMessage("⚠️ Connection timed out. Re-attempting handshake...");
                handleDisconnected();
            }
        }, 12000);

        console.log("[WebRTC] Starting connection sequence...");

        try {
            if (cachedIceServers === null || Date.now() - cachedIceServersAt > 30 * 60 * 1000) {
                cachedIceServers = await fetchIceServers();
                cachedIceServersAt = Date.now();
            }
            console.log("[WebRTC] Creating RTCPeerConnection (iceServers:", cachedIceServers.length, ")...");
            peerConnection = new RTCPeerConnection({
                iceServers: cachedIceServers,
                bundlePolicy: 'max-bundle'
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
            console.log("[WHEP POST URL]:", whepUrl);

            whepAbortController = new AbortController();
            // Bound the handshake round-trip: without this, a stalled POST would sit
            // until the 12s watchdog fired. Signaling is a local ~10ms exchange, so
            // 10s means something is genuinely broken and a fast retry helps sooner.
            whepPostTimeout = setTimeout(() => {
                console.warn("[WebRTC] WHEP POST exceeded 10s without a response. Aborting handshake.");
                if (whepAbortController) whepAbortController.abort();
            }, 10000);
            let response;
            try {
                response = await fetch(whepUrl, {
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
                // Teardown already ran (12s watchdog, freeze recovery, or ICE
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
            addSystemMessage("Playback ended soon after connecting. Try H.264, then reduce the frame rate or bitrate. If you see decode errors, try setting B-frames to 0 in OBS.");
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
                console.log("[Polling] Stream is ONLINE (publisher active on path 'live'). Initiating WebRTC...");
                connectStream();
            } else {
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
        dropBurstSec = 0;
        stressRunSec = 0;
        calmRunSec = 0;
        catchUpDriftSec = 0;
        adaptiveRaiseUntil = 0;
        catchUpUntil = 0;
        lastNetJitterMs = null;
        lastLossPct = null;
        avgPlayoutDelayMs = null;
        lastAppliedTargetMs = null;
        bufferNoticeState = '';

        if (statsInterval) clearInterval(statsInterval);
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
                    if (hudVideoState) hudVideoState.innerText = `${playState} (RS:${player.readyState})`;
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
                    if (droppedDelta >= 3) dropBurstSec += 1;
                    else dropBurstSec = 0;
                    if (dropBurstSec >= 3) maybeAutoPerfMode();

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
                    }
                    if (hudJitter) {
                        hudJitter.innerText = lastNetJitterMs === null ? '-- ms' : `${Math.round(lastNetJitterMs)} ms`;
                    }

                    // Average time packets actually waited in the jitter buffer —
                    // the ground truth for "is playout drifting behind the live edge?".
                    if (Number.isFinite(videoStats.jitterBufferDelay)
                        && Number.isFinite(videoStats.jitterBufferEmittedCount)
                        && videoStats.jitterBufferEmittedCount > 0) {
                        avgPlayoutDelayMs = (videoStats.jitterBufferDelay / videoStats.jitterBufferEmittedCount) * 1000;
                    }

                    const now = performance.now();
                    const bytes = videoStats.bytesReceived || 0;
                    let currentMbps = 0;

                    const timeDiffSec = (now - lastStatsTime) / 1000;
                    const decodedDiff = decoded - lastFramesDecodedCount;
                    const measuredFps = timeDiffSec > 0 && decodedDiff >= 0 ? decodedDiff / timeDiffSec : null;
                    const reportedFps = Number.isFinite(videoStats.framesPerSecond) ? videoStats.framesPerSecond : null;
                    currentFrameRate = reportedFps ?? measuredFps;

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
            const onFrame = (now) => {
                lastFrameTime = now;
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
        player.muted = false;
        connectPlayerToAudioNodes();
        volumeSlider.value = 1;
        setMasterGain(1.0);
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

            // A manual mode selection overrides any adaptive raise / catch-up.
            adaptiveRaiseUntil = 0;
            catchUpUntil = 0;
            catchUpDriftSec = 0;
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

    // Controls Auto-Hide Management (fade after 2.5s of mouse inactivity)
    function resetControlsTimer() {
        videoContainer.classList.add('controls-active');
        if (controlsHideTimeout) clearTimeout(controlsHideTimeout);
        controlsHideTimeout = setTimeout(() => {
            const inFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
            const hudOpen = telemetryHud.style.display === 'block';
            const focusInside = videoContainer.contains(document.activeElement);
            // Playing always fades; paused fades only in fullscreen (windowed
            // keeps the bar so the play button stays obvious). An open
            // telemetry HUD or keyboard focus inside the player keeps the bar
            // up so nothing becomes unreachable.
            if ((!player.paused || inFullscreen) && !hudOpen && !focusInside) {
                videoContainer.classList.remove('controls-active');
                console.log('[Controls] faded out after 2.5s idle.');
            } else {
                console.warn('[Controls] fade skipped:', JSON.stringify({
                    paused: player.paused,
                    fullscreen: inFullscreen,
                    hudOpen,
                    focus: focusInside ? (document.activeElement.id || document.activeElement.tagName) : null
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
        resetControlsTimer();
    });
    // Touch/pointer users produce no mousemove: a tap must re-show the bar too,
    // otherwise fullscreen would hide it with no way to bring it back.
    videoContainer.addEventListener('pointerdown', resetControlsTimer);
    videoContainer.addEventListener('touchstart', resetControlsTimer, { passive: true });
    videoContainer.addEventListener('focusin', resetControlsTimer);
    videoContainer.addEventListener('focusout', (event) => {
        if (!videoContainer.contains(event.relatedTarget)) resetControlsTimer();
    });
    videoContainer.addEventListener('mouseleave', () => {
        if (!player.paused && telemetryHud.style.display !== 'block' && !videoContainer.contains(document.activeElement)) {
            videoContainer.classList.remove('controls-active');
        }
    });

    // Starting or pausing playback restarts the fade timer, so the bar clears
    // (or reappears) even when playback was toggled from the keyboard.
    player.addEventListener('play', resetControlsTimer);
    player.addEventListener('pause', resetControlsTimer);

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
       Interactive Reactions (Floating Emojis)
       ========================================================================== */

    const reactionEmojiMap = {
        heart: '❤️',
        fire: '🔥',
        clap: '👏',
        laugh: '😂',
        thumbs: '👍'
    };

    document.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            initAudioContext();
            const emojiType = btn.getAttribute('data-emoji');

            // Reactions are visual feedback on this device; there is no shared reaction service.
            if (reactionEmojiMap[emojiType]) spawnFloatingEmoji(reactionEmojiMap[emojiType]);
            const countEl = btn.querySelector('.emoji-count');
            if (countEl) {
                const current = parseInt(countEl.innerText || '0', 10);
                countEl.innerText = String(current + 1);
            }
            playSfx('pop');
        });
    });

    function spawnFloatingEmoji(emojiChar) {
        const floating = document.createElement('div');
        floating.className = 'flying-emoji';
        floating.innerText = emojiChar;

        const width = videoContainer.clientWidth;
        const randomX = Math.floor(Math.random() * (width - 60)) + 30;
        floating.style.left = `${randomX}px`;

        videoContainer.appendChild(floating);

        setTimeout(() => {
            floating.remove();
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

    // Send Message
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        initAudioContext();
        const text = chatInput.value.trim();
        if (!text) return;

        addMessage('You', text, true, 'NOTE');
        chatInput.value = '';
        playSfx('pop');
    });

    function addMessage(author, body, isSelf, badge = 'USER') {
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
        const now = new Date();
        timeSpan.innerText = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

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

    // Pause telemetry and polling when page is hidden (tab backgrounded)
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
                startTelemetry();
                startAudioMeter();
                ensureVideoFrameCallback();
            } else {
                pollStreamStatus();
            }
        }
    });

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

    /* ==========================================================================
       Startup — no access gate; the unlisted URL itself is the only credential
       ========================================================================== */

    function initApp() {
        console.log("[App] Launching telemetry and connection sequence...");
        addSystemMessage("Connecting to signaling server...");
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
