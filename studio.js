/* ==========================================================================
   Rydius Studio — in-browser broadcaster (WebCodecs -> local relay -> RTSP)
   ==========================================================================
   This is the "no OBS install" path. It captures a screen, window or tab with
   getDisplayMedia, mixes a microphone with the captured system/tab audio, and
   publishes the SAME `live` path OBS uses.

   Why this no longer uses WebRTC
   ------------------------------
   The previous version handed the capture track to RTCPeerConnection and let
   the browser's own encoder produce the RTP. On this laptop that path topped
   out near 16 fps on every codec, while the same GPU's H.264 encoder reached
   170+ fps through WebCodecs. The ceiling was the WebRTC encoder, not the
   screen. The page now encodes H.264 itself, posts the encoded access units to
   studio_ingest.js, and a local ffmpeg copies the video (no re-encode) into
   MediaMTX over RTSP. OBS keeps publishing over WHIP exactly as before.

   The pieces:
     studio_ingest_client.js  capture -> OffscreenCanvas -> VideoEncoder
                              -> framed batched POSTs -> status polling
     studio_ingest.js         named pipes -> ffmpeg -c:v copy + PCM -> Opus
                              -> rtsp://127.0.0.1:8554/live

   Background tabs
   ---------------
   Chrome throttles a hidden tab hard enough that a 60 Hz loop runs at
   single-digit rates. The one reliable exemption is a Document
   Picture-in-Picture window: while one is open the opener keeps a normal
   scheduling cadence even when its tab is hidden. Start therefore opens a
   small always-on-top "On Air" window in the same user gesture as the click.
   If the browser has no Document PiP, broadcasting still works, but only while
   this tab stays visible.

   This page is deliberately host-only. The relay spawns ffmpeg and binds named
   pipes on the machine serving the page; /stream-api/host-info is what tells
   the page whether it is on that machine.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // --- Configuration ----------------------------------------------------

    const STREAM_PATH = 'live';
    const MEDIAMTX_API_PATH = '/stream-api/v3/paths/list';
    const HOST_INFO_PATH = '/stream-api/host-info';

    const HOST_INFO_TIMEOUT_MS = 4000;
    const PATH_PROBE_TIMEOUT_MS = 5000;
    const STATS_INTERVAL_MS = 1000;

    // Requested as `ideal`, never `exact`: a display track cannot be forced to
    // an exact size, and `min`/`exact` throw a TypeError inside
    // getDisplayMedia even though they are legal in applyConstraints.
    const RESOLUTION_MAP = {
        2160: { width: 3840, height: 2160 },
        1440: { width: 2560, height: 1440 },
        1080: { width: 1920, height: 1080 },
        720: { width: 1280, height: 720 },
        480: { width: 854, height: 480 }
    };

    const DEFAULT_NOTICE = {
        title: 'Hardware H.264, encoded once',
        body: 'This page captures the screen, encodes it with the GPU, and hands the encoded frames '
            + 'to a local relay that publishes to the same <code>live</code> path OBS uses. No second '
            + 'encode and no WebRTC ceiling. It runs <b>only on the host laptop</b>.',
        foot: 'Defaults match the OBS profile: 1920&times;1080, 24 fps, CBR 4 Mbps, 1 s keyframes. '
            + 'Keep the small <b>On Air</b> window open while you broadcast &mdash; Chrome throttles '
            + 'hidden tabs, and that window keeps the encoder at full speed when you switch away.',
        icon: 'fa-bolt',
        kind: 'info'
    };

    const HOST_ONLY_NOTICE = {
        title: 'Browser broadcasting is host-only',
        body: 'This page starts a local encoder and relay, so it only works on the laptop that runs '
            + 'the stream. Open <code>http://127.0.0.1:3000/streaming/studio</code> on that machine.',
        foot: 'To publish, run OBS on that laptop &mdash; its RTMP and WHIP ingest are unchanged. '
            + 'Remote viewers should use the watch page.',
        icon: 'fa-lock',
        kind: 'error'
    };

    // --- DOM elements -----------------------------------------------------

    const shell = document.getElementById('studio-shell');
    const preview = document.getElementById('studio-preview');
    const previewEmpty = document.getElementById('preview-empty');
    const statusBadge = document.getElementById('studio-status');
    const statusText = document.getElementById('studio-status-text');

    const startBtn = document.getElementById('btn-start');
    const stopBtn = document.getElementById('btn-stop');
    const transportNote = document.getElementById('transport-note');
    const pickSourceBtn = document.getElementById('btn-pick-source');

    const modeButtons = Array.from(document.querySelectorAll('.studio-seg'));
    const sourceInfo = document.getElementById('source-info');
    const sourceInfoIcon = document.getElementById('source-info-icon');
    const sourceInfoText = document.getElementById('source-info-text');

    const micCheckbox = document.getElementById('chk-mic');
    const micGain = document.getElementById('mic-gain');
    const micGainValue = document.getElementById('mic-gain-value');
    const micGainRow = document.getElementById('mic-gain-row');
    const systemAudioCheckbox = document.getElementById('chk-system-audio');
    const systemGain = document.getElementById('system-gain');
    const systemGainValue = document.getElementById('system-gain-value');
    const systemGainRow = document.getElementById('system-gain-row');
    const outgoingLevel = document.getElementById('outgoing-level');
    const audioHint = document.getElementById('audio-hint');

    const resolutionSelect = document.getElementById('sel-resolution');
    const framerateSelect = document.getElementById('sel-framerate');
    const bitrateSlider = document.getElementById('rng-bitrate');
    const bitrateValue = document.getElementById('bitrate-value');
    const audioBitrateSelect = document.getElementById('sel-audio-bitrate');
    const cbrCheckbox = document.getElementById('chk-cbr');
    const contentHintSelect = document.getElementById('sel-content-hint');
    const encoderHint = document.getElementById('encoder-hint');

    const noticeEl = document.getElementById('studio-notice');
    const noticeTitle = document.getElementById('studio-notice-title');
    const noticeBody = document.getElementById('studio-notice-body');
    const noticeFoot = document.getElementById('studio-notice-foot');
    const noticeIcon = document.getElementById('studio-notice-icon');

    const meters = document.getElementById('studio-meters');
    const meterBitrate = document.getElementById('meter-bitrate');
    const meterFps = document.getElementById('meter-fps');
    const meterResolution = document.getElementById('meter-resolution');
    const meterCodec = document.getElementById('meter-codec');
    const meterDropped = document.getElementById('meter-dropped');
    const meterKeyframes = document.getElementById('meter-keyframes');

    const toast = document.getElementById('studio-toast');
    const toastText = document.getElementById('studio-toast-text');
    const toastIcon = document.getElementById('toast-icon');
    const toastClose = document.getElementById('toast-close');
    const busy = document.getElementById('studio-busy');
    const busyText = document.getElementById('studio-busy-text');

    // --- Mutable state ----------------------------------------------------

    let displayStream = null;
    let micStream = null;

    let audioContext = null;
    let micSourceNode = null;
    let displayAudioSourceNode = null;
    let micGainNode = null;
    let displayGainNode = null;
    let masterGainNode = null;
    let meterSink = null;
    let outgoingAnalyser = null;
    let levelRafId = null;
    let levelData = null;

    let publisher = null;
    let statsTimer = null;

    let selectedMode = 'monitor';
    let toastTimer = null;

    let isPublishing = false;
    // Covers the window before the publisher exists: the mic prompt and the
    // session POST are both async, and a second click during either would
    // start a second encoder.
    let isStarting = false;
    let isTearingDown = false;
    // Set when this browser cannot capture or encode at all. It is separate
    // from hostAllowed because a remote visitor should still see the
    // host-only notice, not an unsupported-browser one.
    let unsupported = false;

    // null = still checking, true = host, false = remote/unknown. Start stays
    // disabled until this is true.
    let hostAllowed = null;

    let audioIsSilent = false;
    let audioTapFailed = false;

    // Document Picture-in-Picture state. The window is opened in the Start
    // click's user gesture; it is what keeps the opener unthrottled.
    let onAirWindow = null;
    let pipSource = null;
    let pipFps = null;
    let pipTime = null;
    let pipStopBtn = null;
    let pipWarned = false;

    // ==========================================================================
    // Small UI helpers
    // ==========================================================================

    function setStatus(state, label) {
        if (statusBadge) statusBadge.setAttribute('data-state', state);
        if (statusText) statusText.textContent = label;
    }

    function showToast(message, kind) {
        if (!toast) return;
        if (toastText) toastText.textContent = message;
        toast.hidden = false;
        toast.classList.toggle('is-error', kind === 'error');
        toast.classList.toggle('is-warning', kind === 'warning');
        if (toastIcon) {
            const icon = kind === 'error'
                ? 'fa-circle-exclamation'
                : (kind === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info');
            toastIcon.className = `fa-solid ${icon}`;
        }
        // Warnings persist until dismissed. A "another publisher is live"
        // warning must not vanish while the user is still deciding.
        if (toastTimer) clearTimeout(toastTimer);
        if (kind !== 'warning') {
            toastTimer = setTimeout(() => {
                if (toast) toast.hidden = true;
            }, 6000);
        }
    }

    function setBusy(isBusy, message) {
        if (!busy) return;
        busy.hidden = !isBusy;
        busy.setAttribute('aria-hidden', String(!isBusy));
        if (message && busyText) busyText.textContent = message;
    }

    function setNotice(notice) {
        if (!noticeEl) return;
        noticeEl.classList.toggle('is-info', notice.kind === 'info');
        noticeEl.classList.toggle('is-error', notice.kind === 'error');
        if (noticeTitle) noticeTitle.textContent = notice.title;
        if (noticeBody) noticeBody.innerHTML = notice.body;
        if (noticeFoot) noticeFoot.innerHTML = notice.foot;
        if (noticeIcon) noticeIcon.className = `fa-solid ${notice.icon}`;
    }

    // Paints the filled portion of a range input. WebKit has no
    // ::-moz-range-track equivalent, so the fill has to be a CSS custom
    // property on the element.
    function paintSlider(slider) {
        if (!slider) return;
        const min = Number(slider.min || 0);
        const max = Number(slider.max || 100);
        const value = Number(slider.value);
        const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
        slider.style.setProperty('--studio-fill', `${pct}%`);
    }

    function formatBitrate(bitsPerSecond) {
        if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '0 kbps';
        const kbps = bitsPerSecond / 1000;
        if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
        return `${Math.round(kbps)} kbps`;
    }

    function formatDuration(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function hasSource() {
        // Liveness, not mere presence. A MediaStream whose tracks have been
        // stopped still reports them, and track.stop() never fires 'ended' --
        // so a presence check would re-enable Start on a dead capture.
        if (!displayStream) return false;
        return displayStream.getVideoTracks().some((track) => track.readyState === 'live');
    }

    function canStartNow() {
        return !unsupported && hostAllowed === true && hasSource() && !isPublishing && !isStarting;
    }

    function transportNoteText() {
        if (unsupported) return 'Browser broadcasting is not supported in this browser.';
        if (hostAllowed === null) return 'Checking host access…';
        if (hostAllowed === false) return 'Browser broadcasting runs on the host laptop only.';
        if (isPublishing) return 'Live. Encoder settings are fixed until you stop.';
        if (isStarting) return 'Starting the encoder…';
        if (!hasSource()) return 'Choose a source to unlock broadcasting.';
        return 'Ready. Press start when you are.';
    }

    function stoppedNote() {
        return hasSource()
            ? 'Stopped. Press start to broadcast again.'
            : 'Stopped. Choose a source to broadcast again.';
    }

    // Single place that derives every transport control from state. Callers
    // may override the note for a one-off message (stopped, error, takeover).
    function refreshTransport(note) {
        if (startBtn) startBtn.disabled = !canStartNow();
        if (stopBtn) stopBtn.hidden = !isPublishing;
        if (pickSourceBtn) {
            pickSourceBtn.disabled = unsupported || hostAllowed === false || isPublishing || isStarting;
        }
        if (transportNote) transportNote.textContent = note || transportNoteText();
    }

    function resetMeters() {
        if (meterBitrate) meterBitrate.textContent = '0 kbps';
        if (meterFps) meterFps.textContent = '0';
        if (meterResolution) meterResolution.textContent = '—';
        if (meterCodec) meterCodec.textContent = '—';
        if (meterDropped) {
            meterDropped.textContent = '0';
            meterDropped.title = '';
        }
        if (meterKeyframes) meterKeyframes.textContent = '0';
    }

    // Resolution, frame rate, bitrate, CBR and content type are all baked into
    // the encoder configuration. WebCodecs has no supported "reconfigure the
    // running encoder" path that would not also force a keyframe and a visible
    // hiccup, so the honest UI is to lock them until the next broadcast.
    function setEncoderControlsLocked(locked) {
        const controls = [
            resolutionSelect,
            framerateSelect,
            bitrateSlider,
            audioBitrateSelect,
            cbrCheckbox,
            contentHintSelect
        ];
        controls.forEach((control) => {
            if (!control) return;
            control.disabled = locked;
            if (locked) {
                control.title = 'Stop the broadcast to change this.';
            } else {
                control.removeAttribute('title');
            }
        });
        if (encoderHint) {
            encoderHint.textContent = locked
                ? 'Settings are fixed for this broadcast. Stop to change resolution, frame rate, bitrate or CBR.'
                : 'Settings are locked in when you go live. Leave ~25% of your upload free.';
        }
    }

    // ==========================================================================
    // Host access
    // ==========================================================================

    async function checkHostAccess() {
        try {
            const response = await fetch(HOST_INFO_PATH, {
                cache: 'no-store',
                signal: AbortSignal.timeout(HOST_INFO_TIMEOUT_MS)
            });
            // 403 is the deliberate answer for a tunneled/remote request.
            hostAllowed = response.ok;
        } catch (err) {
            console.warn('[Studio] Could not verify host access:', err);
            hostAllowed = false;
        }

        if (hostAllowed) {
            setNotice(DEFAULT_NOTICE);
            setStatus('idle', 'Ready');
        } else {
            setNotice(HOST_ONLY_NOTICE);
            setStatus('error', 'Host only');
        }
        refreshTransport();

        if (!hostAllowed) return;

        // Advisory only: the relay overrides an existing publisher. Learning
        // that BEFORE starting is the difference between a deliberate takeover
        // and an OBS stream dying without explanation.
        isAlreadyPublishing().then((already) => {
            if (already && !isPublishing) {
                showToast('Something is already publishing to this stream. Starting here will replace it.', 'warning');
                refreshTransport('Another publisher is live — starting will replace it.');
            }
        });
    }

    async function isAlreadyPublishing() {
        try {
            const response = await fetch(MEDIAMTX_API_PATH, {
                cache: 'no-store',
                signal: AbortSignal.timeout(PATH_PROBE_TIMEOUT_MS)
            });
            if (!response.ok) return false;
            const data = await response.json();
            const items = Array.isArray(data.items) ? data.items : [];
            const path = items.find((entry) => entry && entry.name === STREAM_PATH);
            if (!path) return false;
            return Boolean(path.ready || path.online);
        } catch (err) {
            // The probe is advisory. A failure must not block the broadcast.
            console.warn('[Studio] Could not check for an existing publisher:', err);
            return false;
        }
    }

    // ==========================================================================
    // Audio graph
    // ==========================================================================
    // The microphone and the captured system/tab audio are summed into one
    // master GainNode. That node is handed to the ingest client, whose
    // AudioWorklet tap reduces it to interleaved s16le for ffmpeg. Gain stays
    // live for the whole broadcast; the set of sources is fixed at start.

    function buildAudioGraph() {
        teardownAudioGraph();

        const sources = [];
        if (micStream) sources.push({ kind: 'mic', stream: micStream });
        if (displayStream && displayStream.getAudioTracks().some((track) => track.readyState === 'live')) {
            sources.push({ kind: 'display', stream: displayStream });
        }
        if (!sources.length) return null;

        try {
            // The worklet emits 480-sample frames and ffmpeg reads them as
            // 48 kHz. Letting the context choose 44.1 kHz would make every
            // "10 ms" frame 10.88 ms of real time and drift the audio against
            // the video for the whole broadcast.
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
                latencyHint: 'interactive'
            });
        } catch (err) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (fallbackErr) {
                console.error('[Studio] Could not create AudioContext:', fallbackErr);
                audioContext = null;
                return null;
            }
        }

        if (Math.round(audioContext.sampleRate) !== 48000) {
            console.error(`[Studio] AudioContext runs at ${audioContext.sampleRate} Hz; the PCM tap requires 48000 Hz.`);
            try { audioContext.close(); } catch (err) { /* already closing */ }
            audioContext = null;
            return null;
        }

        masterGainNode = audioContext.createGain();
        masterGainNode.gain.value = 1;

        let connected = 0;
        for (const source of sources) {
            try {
                const node = audioContext.createMediaStreamSource(source.stream);
                const gain = audioContext.createGain();
                node.connect(gain);
                gain.connect(masterGainNode);

                if (source.kind === 'mic') {
                    micSourceNode = node;
                    micGainNode = gain;
                } else {
                    displayAudioSourceNode = node;
                    displayGainNode = gain;
                }
                connected += 1;
            } catch (err) {
                // One bad source must not cost the other.
                console.error(`[Studio] Could not route ${source.kind} audio:`, err);
            }
        }

        if (!connected) {
            teardownAudioGraph();
            return null;
        }

        outgoingAnalyser = audioContext.createAnalyser();
        outgoingAnalyser.fftSize = 1024;
        // Short window: the meter is a live readout, not a spectrum display.
        outgoingAnalyser.smoothingTimeConstant = 0.6;
        levelData = new Uint8Array(outgoingAnalyser.fftSize);
        masterGainNode.connect(outgoingAnalyser);

        // An AnalyserNode with no path to the destination is not guaranteed to
        // be pulled. A zero-gain sink keeps the meter alive without sending the
        // broadcast mix to the speakers (which would feed the mic back).
        meterSink = audioContext.createGain();
        meterSink.gain.value = 0;
        outgoingAnalyser.connect(meterSink);
        meterSink.connect(audioContext.destination);

        applyGainValues();
        return masterGainNode;
    }

    function applyGainValues() {
        if (micGainNode) {
            micGainNode.gain.value = micCheckbox && micCheckbox.checked
                ? Number(micGain.value) / 100
                : 0;
        }
        if (displayGainNode) {
            displayGainNode.gain.value = systemAudioCheckbox && systemAudioCheckbox.checked
                ? Number(systemGain.value) / 100
                : 0;
        }
    }

    function teardownAudioGraph() {
        stopLevelMeter();
        const disconnect = (node) => {
            if (!node) return;
            try { node.disconnect(); } catch (err) { /* already disconnected */ }
        };
        disconnect(micSourceNode);
        disconnect(displayAudioSourceNode);
        disconnect(micGainNode);
        disconnect(displayGainNode);
        disconnect(outgoingAnalyser);
        disconnect(meterSink);
        disconnect(masterGainNode);
        micSourceNode = null;
        displayAudioSourceNode = null;
        micGainNode = null;
        displayGainNode = null;
        outgoingAnalyser = null;
        meterSink = null;
        masterGainNode = null;
        levelData = null;
        if (audioContext) {
            const context = audioContext;
            audioContext = null;
            context.close().catch(() => {});
        }
    }

    // Drives the outgoing level bar from the mixed graph.
    function startLevelMeter() {
        stopLevelMeter();
        const tick = () => {
            if (!outgoingAnalyser || !levelData) return;
            outgoingAnalyser.getByteTimeDomainData(levelData);
            let peak = 0;
            for (let i = 0; i < levelData.length; i += 1) {
                const amplitude = Math.abs(levelData[i] - 128) / 128;
                if (amplitude > peak) peak = amplitude;
            }
            if (outgoingLevel) {
                outgoingLevel.style.width = `${Math.min(100, peak * 100)}%`;
            }
            levelRafId = requestAnimationFrame(tick);
        };
        levelRafId = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRafId) {
            cancelAnimationFrame(levelRafId);
            levelRafId = null;
        }
        if (outgoingLevel) outgoingLevel.style.width = '0%';
    }

    // ==========================================================================
    // On Air window (Document Picture-in-Picture)
    // ==========================================================================
    // requestWindow() must be called synchronously from a user gesture, so the
    // Start handler calls openOnAirWindow() before its first await. The window
    // is small, always-on-top, and carries a Stop button so the broadcaster
    // can end the stream without finding the studio tab again.

    function openOnAirWindow() {
        if (!('documentPictureInPicture' in window)) return Promise.resolve(null);
        if (onAirWindow && !onAirWindow.closed) return Promise.resolve(onAirWindow);

        let request;
        try {
            request = window.documentPictureInPicture.requestWindow({
                width: 300,
                height: 190,
                disallowReturnToOpener: false
            });
        } catch (err) {
            console.warn('[Studio] On Air window could not open:', err);
            return Promise.resolve(null);
        }

        return request.then((win) => {
            buildOnAirWindow(win);
            onAirWindow = win;
            return win;
        }).catch((err) => {
            console.warn('[Studio] On Air window request was rejected:', err);
            return null;
        });
    }

    function buildOnAirWindow(win) {
        const doc = win.document;
        doc.title = 'Rydius — On Air';

        const style = doc.createElement('style');
        style.textContent = `
            :root { color-scheme: dark; }
            * { box-sizing: border-box; }
            body {
                margin: 0;
                min-height: 100vh;
                display: grid;
                grid-template-rows: auto 1fr auto;
                background: #080812;
                color: #f8fafc;
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            }
            header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 14px 0;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.12em;
                color: #ef4444;
            }
            .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #ef4444;
                box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
                animation: pulse 1.6s infinite;
            }
            @keyframes pulse {
                70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
                100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
            }
            main {
                padding: 4px 14px 10px;
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 5px;
                min-width: 0;
            }
            .source {
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .metrics {
                display: flex;
                gap: 12px;
                font-family: Consolas, 'Fira Code', monospace;
                font-size: 11px;
                color: #94a3b8;
                font-variant-numeric: tabular-nums;
            }
            footer { padding: 0 14px 14px; }
            button {
                width: 100%;
                padding: 8px 10px;
                border: 1px solid rgba(239, 68, 68, 0.4);
                border-radius: 7px;
                background: rgba(239, 68, 68, 0.12);
                color: #fecaca;
                font: inherit;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
            }
            button:hover:not(:disabled) { background: rgba(239, 68, 68, 0.22); }
            button:disabled { opacity: 0.5; cursor: default; }
        `;
        doc.head.appendChild(style);

        const header = doc.createElement('header');
        const dot = doc.createElement('span');
        dot.className = 'dot';
        const onAir = doc.createElement('span');
        onAir.textContent = 'ON AIR';
        header.append(dot, onAir);

        const main = doc.createElement('main');
        const source = doc.createElement('div');
        source.className = 'source';
        source.textContent = 'Starting encoder…';
        const metrics = doc.createElement('div');
        metrics.className = 'metrics';
        const fps = doc.createElement('span');
        fps.textContent = '— fps';
        const time = doc.createElement('span');
        time.textContent = '0:00';
        metrics.append(fps, time);
        main.append(source, metrics);

        const footer = doc.createElement('footer');
        const stop = doc.createElement('button');
        stop.type = 'button';
        stop.textContent = 'Stop broadcast';
        stop.disabled = true;
        stop.addEventListener('click', () => {
            stopFromOnAir();
        });
        footer.appendChild(stop);

        doc.body.append(header, main, footer);

        pipSource = source;
        pipFps = fps;
        pipTime = time;
        pipStopBtn = stop;

        win.addEventListener('pagehide', () => {
            if (onAirWindow !== win) return;
            onAirWindow = null;
            pipSource = null;
            pipFps = null;
            pipTime = null;
            pipStopBtn = null;
            if (isPublishing && !pipWarned) {
                pipWarned = true;
                showToast('The On Air window was closed. Keep this tab visible — Chrome throttles hidden tabs.', 'warning');
            }
        });
    }

    function updateOnAirWindow(sourceLabel) {
        if (!onAirWindow || onAirWindow.closed) return;
        if (pipSource) pipSource.textContent = sourceLabel || 'Screen';
        if (pipStopBtn) pipStopBtn.disabled = false;
    }

    function updateOnAirStats(stats) {
        if (!onAirWindow || onAirWindow.closed) return;
        if (pipFps) pipFps.textContent = `${Math.round(stats.fps)} fps`;
        if (pipTime) pipTime.textContent = formatDuration(stats.uptimeMs);
    }

    function closeOnAirWindow() {
        const win = onAirWindow;
        onAirWindow = null;
        pipSource = null;
        pipFps = null;
        pipTime = null;
        pipStopBtn = null;
        if (win && !win.closed) {
            try { win.close(); } catch (err) { /* already closing */ }
        }
    }

    async function stopFromOnAir() {
        if (!isPublishing || isTearingDown) return;
        await stopBroadcast();
        setStatus('idle', 'Stopped');
        refreshTransport(stoppedNote());
        showToast('Broadcast stopped.', 'info');
    }

    // ==========================================================================
    // Source capture
    // ==========================================================================

    // Builds the full capture constraint set. Every applyConstraints() call
    // must carry all of it: Chrome replaces the whole set, so sending only
    // frameRate makes it forget the width/height cap and fall back to the
    // monitor's native size (a 4K desktop then costs 4x the per-frame
    // downscale and halves the encoder rate).
    function captureConstraints(fps) {
        const size = RESOLUTION_MAP[resolutionSelect ? resolutionSelect.value : '1080'];
        const constraints = {
            frameRate: { ideal: fps, max: fps }
        };
        if (size) {
            constraints.width = { ideal: size.width, max: size.width };
            constraints.height = { ideal: size.height, max: size.height };
        }
        return constraints;
    }

    async function pickSource() {
        if (unsupported) return;
        if (hostAllowed === false) {
            showToast('Browser broadcasting only works on the host laptop.', 'warning');
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            showToast('This browser cannot capture a screen. Chrome, Edge or another Chromium browser is required.', 'error');
            return;
        }

        // Stop a previous capture before opening a new picker: the user is
        // replacing the source, and two live display tracks would mean two
        // capture indicators and a doubled encode.
        if (displayStream) {
            teardownAudioGraph();
            teardownCapture();
            displayStream = null;
            updateSourceUi();
        }

        // `ideal` alone is only a REQUEST: a browser is free to ignore it.
        // `max` is the constraint that actually caps, and unlike min/exact it
        // is legal on a display track. Both keys are set so the control is
        // real rather than advisory.
        const requestedFps = Number(framerateSelect ? framerateSelect.value : 24) || 24;
        const videoConstraints = captureConstraints(requestedFps);

        const constraints = {
            video: Object.assign({}, videoConstraints, {
                displaySurface: selectedMode,
                surfaceSwitching: 'include',
                selfBrowserSurface: 'exclude'
            }),
            // System/tab audio is offered by the picker itself. The resolved
            // stream is the only authority on whether it exists.
            audio: { systemAudio: 'include' }
        };

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        } catch (err) {
            reportCaptureError(err);
            return;
        }

        const videoTracks = stream.getVideoTracks();
        if (!videoTracks.length) {
            stream.getTracks().forEach((track) => track.stop());
            showToast('No video track was returned by the picker.', 'error');
            return;
        }

        displayStream = stream;
        const videoTrack = videoTracks[0];
        if ('contentHint' in videoTrack) videoTrack.contentHint = currentContentHint();

        // The user can end the share from the browser's own bar without ever
        // touching this page. `ended` is the only signal for that: calling
        // stop() ourselves does not fire it.
        videoTrack.onended = () => {
            if (isTearingDown) return;
            handleCaptureEnded();
        };

        describeSource(videoTrack);
        reportAchievedFrameRate(videoTrack);

        if (preview) {
            preview.srcObject = stream;
            preview.play().catch((err) => {
                console.warn('[Studio] Preview autoplay was blocked:', err);
            });
        }
        if (shell) shell.classList.add('has-source');

        syncAudioAvailability();
        setStatus('capturing', 'Ready to go live');
        refreshTransport('Ready. Press start when you are.');

        if (await isAlreadyPublishing()) {
            showToast('Something is already publishing to this stream. Going live here will replace it.', 'warning');
            refreshTransport('Another publisher is live — starting will replace it.');
        }
    }

    // Turns a getDisplayMedia rejection into something actionable. Each name
    // below is a distinct real cause with a distinct user action.
    function reportCaptureError(err) {
        const name = (err && err.name) || '';
        switch (name) {
            case 'NotAllowedError':
                showToast('Screen sharing was cancelled or blocked. Allow it in the site settings, then try again.', 'warning');
                break;
            case 'NotFoundError':
                showToast('No capture source is available on this device.', 'error');
                break;
            case 'NotReadableError':
                showToast('The screen could not be read — it may be locked, or another app is using it exclusively.', 'error');
                break;
            case 'AbortError':
                showToast('The capture was interrupted before it started.', 'warning');
                break;
            case 'InvalidStateError':
                showToast('The page is not allowed to capture. Reload the page and press start again.', 'error');
                break;
            case 'TypeError':
                showToast('The browser rejected the capture constraints (min/exact are not allowed here).', 'error');
                break;
            default:
                console.warn('[Studio] Unexpected capture error:', err);
                showToast(`Could not start the capture: ${(err && err.message) || 'unknown error'}.`, 'error');
        }
    }

    function describeSource(videoTrack) {
        if (!videoTrack) return;
        const settings = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
        const surface = settings.displaySurface;

        const label = surface === 'monitor' ? 'Entire screen'
            : surface === 'window' ? 'Application window'
            : surface === 'browser' ? 'Browser tab'
            : 'Screen source';

        if (sourceInfo) sourceInfo.hidden = false;
        if (sourceInfoText) {
            const dims = settings.width && settings.height ? ` — ${settings.width}×${settings.height}` : '';
            sourceInfoText.textContent = label + dims;
        }
        if (sourceInfoIcon) sourceInfoIcon.className = 'fa-solid fa-circle-check';
        if (sourceInfo) sourceInfo.classList.remove('is-warning');
    }

    function currentContentHint() {
        return contentHintSelect && contentHintSelect.value === 'motion' ? 'motion' : 'detail';
    }

    // The capture track's real settings, read back after a delay: immediately
    // after the picker resolves, getSettings() tends to echo the constraints
    // rather than a settled rate.
    function reportAchievedFrameRate(videoTrack, delayMs = 1200) {
        if (!videoTrack || typeof videoTrack.getSettings !== 'function') return;
        setTimeout(() => {
            if (!displayStream || !displayStream.getVideoTracks().includes(videoTrack)) return;
            const settings = videoTrack.getSettings();
            const achieved = Number(settings.frameRate);
            if (!Number.isFinite(achieved) || achieved <= 0) return;

            const requested = Number(framerateSelect ? framerateSelect.value : 0);
            if (Number.isFinite(requested) && requested > 0 && achieved < requested * 0.9) {
                console.log(`[Studio] Capture is running at ${achieved}fps, below the requested ${requested}fps.`);
                showToast(`This source is only capturing at ${Math.round(achieved)} fps, not the ${requested} fps you asked for. `
                    + 'A busy machine or a mostly-static source is the usual cause — try a lower resolution or frame rate.',
                'warning');
            }
            if (sourceInfoText) {
                const label = sourceInfoText.textContent.split(' — ')[0];
                const dims = settings.width && settings.height ? ` — ${settings.width}×${settings.height}` : '';
                sourceInfoText.textContent = `${label}${dims} @ ${Math.round(achieved)} fps`;
            }
        }, delayMs);
    }

    function syncAudioAvailability() {
        const tracks = displayStream ? displayStream.getAudioTracks() : [];
        const hasDisplayAudio = tracks.some((track) => track.readyState === 'live');
        if (systemAudioCheckbox) {
            systemAudioCheckbox.disabled = !hasDisplayAudio;
            if (!hasDisplayAudio) systemAudioCheckbox.checked = false;
        }
        if (systemGain) systemGain.disabled = !hasDisplayAudio;
        if (systemGainRow) systemGainRow.style.opacity = hasDisplayAudio ? '1' : '0.45';

        const note = getPlatformAudioNote(hasDisplayAudio);
        if (audioHint && note) audioHint.textContent = note;
    }

    function getPlatformAudioNote(hasDisplayAudio) {
        if (!hasDisplayAudio) {
            if (navigator.platform && /Mac/i.test(navigator.platform)) {
                return 'System audio was not shared. Chrome can capture tab audio on macOS, but not whole-system audio — share a tab, or use a microphone.';
            }
            return 'No system or tab audio was shared. Tick "Share tab audio" / "Share system audio" in the picker, or use a microphone.';
        }
        return 'System audio is being captured and mixed with the microphone.';
    }

    async function handleCaptureEnded() {
        if (isTearingDown) return;
        await stopBroadcast();
        setStatus('idle', 'Stopped');
        refreshTransport('Sharing stopped. Choose a source to broadcast again.');
        showToast('Sharing stopped from the browser.', 'warning');
    }

    // ==========================================================================
    // Encoder dimensions
    // ==========================================================================

    function resolveDimensions() {
        const preset = RESOLUTION_MAP[resolutionSelect ? resolutionSelect.value : '1080'];
        if (preset) return preset;

        // "Match source": the capture's own size, capped at 4K and made even.
        // getSettings() is authoritative once the picker has resolved; the
        // preview's videoWidth is the fallback before metadata settles.
        const track = displayStream && displayStream.getVideoTracks()[0];
        const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
        let width = Number(settings.width) || (preview && preview.videoWidth) || 1920;
        let height = Number(settings.height) || (preview && preview.videoHeight) || 1080;

        const pure = window.StudioIngest && window.StudioIngest._pure;
        if (pure && typeof pure.matchSourceDimensions === 'function') {
            return pure.matchSourceDimensions(width, height, 3840, 2160);
        }

        width = Math.max(2, Math.round(width / 2) * 2);
        height = Math.max(2, Math.round(height / 2) * 2);
        const scale = Math.min(1, 3840 / width, 2160 / height);
        return {
            width: Math.max(2, Math.round((width * scale) / 2) * 2),
            height: Math.max(2, Math.round((height * scale) / 2) * 2)
        };
    }

    // ==========================================================================
    // Broadcast start / stop
    // ==========================================================================

    async function startPublishing(pipPromise) {
        if (hostAllowed === false) {
            throw new Error('Browser broadcasting only works on the host machine. Open the studio on the laptop that runs the stream.');
        }
        if (!hasSource()) {
            throw new Error('Choose a screen, window or tab first.');
        }
        if (!window.StudioIngest || typeof window.StudioIngest.createPublisher !== 'function') {
            throw new Error('The ingest client did not load. Reload the page.');
        }

        const dims = resolveDimensions();
        const fps = Number(framerateSelect ? framerateSelect.value : 24) || 24;
        const bitrateKbps = Number(bitrateSlider ? bitrateSlider.value : 4000) || 4000;
        const audioBitrate = Number(audioBitrateSelect ? audioBitrateSelect.value : 128000) || 128000;
        const cbr = !cbrCheckbox || cbrCheckbox.checked;
        const contentHint = currentContentHint();

        let master = null;
        try {
            master = buildAudioGraph();
        } catch (err) {
            console.warn('[Studio] Audio graph could not be built, continuing video-only:', err);
            master = null;
        }

        let audioInput = null;
        audioIsSilent = true;
        if (master && audioContext) {
            if (audioContext.state === 'suspended') {
                try { await audioContext.resume(); } catch (err) { /* checked below */ }
            }
            if (audioContext.state === 'running') {
                audioInput = master;
                audioIsSilent = false;
            }
        }
        const hadAudioSources = Boolean(master);
        // If the graph exists but the browser will not run it, do NOT hand
        // ffmpeg an audio input: it would wait forever for PCM that never
        // arrives and the whole broadcast would produce no output.
        const tapContext = audioInput ? audioContext : null;

        audioTapFailed = false;

        let localPublisher = null;
        try {
            localPublisher = window.StudioIngest.createPublisher({
                video: preview,
                width: dims.width,
                height: dims.height,
                fps,
                bitrate: bitrateKbps * 1000,
                audioBitrate,
                cbr,
                contentHint,
                audioContext: tapContext,
                audioInput,
                onEvent: (type, detail) => {
                    if (type === 'error') {
                        handlePublisherError(detail.message || 'The broadcast failed.');
                    } else if (type === 'audio-unavailable') {
                        audioTapFailed = true;
                    }
                }
            });
        } catch (err) {
            teardownAudioGraph();
            closeOnAirWindow();
            throw err;
        }

        publisher = localPublisher;
        try {
            await localPublisher.start();
        } catch (err) {
            if (publisher === localPublisher) publisher = null;
            try { await localPublisher.stop(); } catch (stopErr) { /* already gone */ }
            teardownAudioGraph();
            closeOnAirWindow();
            throw err;
        }

        // An error callback can fire while start() is still resolving. In that
        // case handlePublisherError already tore everything down; claiming Live
        // here would leave the UI describing a broadcast that does not exist.
        if (publisher !== localPublisher || !localPublisher.running) return;

        // The user can end the share from the browser bar during startup. The
        // encoder is already configured, but with no live track it would sit
        // there producing nothing.
        if (!hasSource()) {
            publisher = null;
            try { await localPublisher.stop(); } catch (stopErr) { /* already gone */ }
            teardownAudioGraph();
            closeOnAirWindow();
            throw new Error('The screen capture ended before the broadcast started.');
        }

        isPublishing = true;
        setBusy(false);
        setStatus('live', 'Live');
        setEncoderControlsLocked(true);
        refreshTransport();
        if (meters) meters.hidden = false;
        startLevelMeter();
        startStatsLoop();
        updateOnAirWindow(sourceInfoText ? sourceInfoText.textContent : 'Screen');

        let pip = null;
        if (pipPromise) {
            try { pip = await pipPromise; } catch (err) { pip = null; }
        }
        if (pip) {
            // The window is built asynchronously; the first update above ran
            // before it existed, so set the source and enable Stop again.
            updateOnAirWindow(sourceInfoText ? sourceInfoText.textContent : 'Screen');
        }
        const pipNote = pip
            ? ''
            : ' Keep this tab visible — the On Air window could not open, and Chrome throttles hidden tabs.';

        let audioNote;
        let kind = 'info';
        if (localPublisher.audioEnabled) {
            audioNote = ' with audio';
        } else {
            kind = 'warning';
            if (audioTapFailed) {
                audioNote = ' — NO AUDIO (the audio tap could not start)';
            } else if (!hadAudioSources) {
                audioNote = ' — NO AUDIO (no microphone or system audio was captured)';
            } else if (audioIsSilent) {
                audioNote = ' — NO AUDIO (the browser blocked audio; click the page and start again)';
            } else {
                audioNote = ' — NO AUDIO';
            }
        }

        showToast(
            `Broadcasting H.264 at ${dims.width}×${dims.height}, ${fps} fps${audioNote}.${pipNote}`,
            kind
        );
    }

    async function handlePublisherError(message) {
        if (isTearingDown) return;
        await stopBroadcast({ keepSource: true });
        setStatus('error', 'Failed');
        refreshTransport('Broadcast stopped after an error. Press start to try again.');
        showToast(message, 'error');
    }

    // Reached from Stop, the browser's own "Stop sharing" bar, a publisher
    // error, and pagehide. Idempotent: the first caller wins and later ones
    // return immediately.
    async function stopBroadcast(options) {
        const keepSource = Boolean(options && options.keepSource);
        if (isTearingDown) return;
        isTearingDown = true;

        try {
            stopStatsLoop();
            stopLevelMeter();
            closeOnAirWindow();

            const active = publisher;
            publisher = null;
            if (active) {
                try {
                    await active.stop({ keepalive: Boolean(options && options.keepalive) });
                } catch (err) {
                    console.warn('[Studio] Publisher stop failed:', err);
                }
            }

            isPublishing = false;
            teardownAudioGraph();
            if (!keepSource) {
                teardownCapture();
                updateSourceUi();
            }

            if (meters) meters.hidden = true;
            resetMeters();
            setEncoderControlsLocked(false);
            setBusy(false);
        } finally {
            isTearingDown = false;
        }
    }

    // Stops the capture tracks and forgets the streams. The microphone is
    // stopped here too: leaving it live would show a recording indicator after
    // the broadcast ended.
    function teardownCapture() {
        if (displayStream) {
            displayStream.getTracks().forEach((track) => {
                track.onended = null;
                try { track.stop(); } catch (err) { /* already stopped */ }
            });
            displayStream = null;
        }
        if (micStream) {
            micStream.getTracks().forEach((track) => {
                try { track.stop(); } catch (err) { /* already stopped */ }
            });
            micStream = null;
        }
    }

    function updateSourceUi() {
        const present = hasSource();
        if (shell) shell.classList.toggle('has-source', present);
        if (!present) {
            if (preview) preview.srcObject = null;
            if (sourceInfo) sourceInfo.hidden = true;
            if (previewEmpty) previewEmpty.hidden = false;
        } else if (previewEmpty) {
            previewEmpty.hidden = true;
        }
    }

    // ==========================================================================
    // Statistics
    // ==========================================================================

    function startStatsLoop() {
        stopStatsLoop();
        statsTimer = setInterval(updateStats, STATS_INTERVAL_MS);
        updateStats();
    }

    function stopStatsLoop() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
    }

    function updateStats() {
        if (!publisher) return;
        let stats;
        try {
            stats = publisher.getStats();
        } catch (err) {
            return;
        }

        if (meterBitrate) meterBitrate.textContent = formatBitrate(stats.bitrate);
        if (meterFps) meterFps.textContent = String(Math.round(stats.fps));
        if (meterResolution) meterResolution.textContent = `${stats.width}×${stats.height}`;
        if (meterCodec) meterCodec.textContent = 'H.264';

        const dropped = (stats.droppedVideo || 0) + (stats.serverDropped || 0);
        if (meterDropped) {
            meterDropped.textContent = String(dropped);
            meterDropped.title = `${stats.droppedVideo || 0} dropped by the browser, `
                + `${stats.serverDropped || 0} dropped by the relay, `
                + `${stats.droppedAudio || 0} audio frames dropped.`;
        }
        if (meterKeyframes) meterKeyframes.textContent = String(stats.keyframes || 0);

        updateOnAirStats(stats);
    }

    // ==========================================================================
    // Microphone
    // ==========================================================================
    // Requested lazily, on the first broadcast attempt. Processing constraints
    // are OFF: echo cancellation and noise suppression are tuned for a voice
    // call, and on a broadcast mic next to the speakers they pump and gate.

    async function requestMicrophone() {
        if (!micCheckbox || !micCheckbox.checked) {
            if (micStream) {
                micStream.getTracks().forEach((track) => track.stop());
                micStream = null;
            }
            return null;
        }
        if (micStream) return micStream;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;

        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 2,
                    sampleRate: 48000
                },
                video: false
            });
        } catch (err) {
            const name = (err && err.name) || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                showToast('Microphone permission was denied. The stream will publish without a mic.', 'warning');
            } else if (name === 'NotFoundError') {
                showToast('No microphone was found. The stream will publish without audio.', 'warning');
            } else {
                showToast(`The microphone could not be opened: ${(err && err.message) || 'unknown error'}.`, 'warning');
            }
            if (micCheckbox) micCheckbox.checked = false;
            if (micGainRow) micGainRow.style.opacity = '0.45';
            micStream = null;
        }
        return micStream;
    }

    // ==========================================================================
    // UI wiring
    // ==========================================================================

    function initModeSelector() {
        const syncRovingTabindex = () => {
            modeButtons.forEach((button) => {
                button.tabIndex = button.classList.contains('active') ? 0 : -1;
            });
        };

        const selectMode = (button) => {
            if (isPublishing || isStarting) {
                showToast('Stop the broadcast before changing what is shared.', 'info');
                return false;
            }
            selectedMode = button.dataset.mode || 'monitor';
            modeButtons.forEach((other) => {
                const isActive = other === button;
                other.classList.toggle('active', isActive);
                other.setAttribute('aria-checked', String(isActive));
            });
            syncRovingTabindex();
            // Re-picking is the only way to change the surface: getDisplayMedia
            // has no way to retarget an existing track.
            if (hasSource()) pickSource();
            return true;
        };

        modeButtons.forEach((button, index) => {
            button.addEventListener('click', () => selectMode(button));

            button.addEventListener('keydown', (event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                let next = null;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    next = modeButtons[(index + 1) % modeButtons.length];
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    next = modeButtons[(index - 1 + modeButtons.length) % modeButtons.length];
                } else if (event.key === 'Home') {
                    next = modeButtons[0];
                } else if (event.key === 'End') {
                    next = modeButtons[modeButtons.length - 1];
                }
                if (!next) return;
                event.preventDefault();
                if (selectMode(next)) next.focus();
            });
        });

        syncRovingTabindex();
    }

    function initEncoderControls() {
        if (bitrateSlider) {
            paintSlider(bitrateSlider);
            bitrateSlider.addEventListener('input', () => {
                if (bitrateValue) bitrateValue.textContent = `${bitrateSlider.value} kbps`;
                paintSlider(bitrateSlider);
            });
        }

        if (framerateSelect) {
            framerateSelect.addEventListener('change', () => {
                if (isPublishing) return;
                if (hasSource()) {
                    const track = displayStream.getVideoTracks()[0];
                    const fps = Number(framerateSelect.value) || 24;
                    track.applyConstraints(captureConstraints(fps))
                        .then(() => reportAchievedFrameRate(track))
                        .catch((err) => console.warn('[Studio] Frame rate constraint rejected:', err));
                }
            });
        }

        if (resolutionSelect) {
            resolutionSelect.addEventListener('change', () => {
                if (!isPublishing) applyResolution();
            });
        }

        if (contentHintSelect) {
            contentHintSelect.addEventListener('change', () => {
                if (isPublishing) return;
                if (hasSource()) {
                    const track = displayStream.getVideoTracks()[0];
                    if (track && 'contentHint' in track) track.contentHint = currentContentHint();
                }
            });
        }
    }

    // Resolution is a capture constraint, not an encoder parameter. `max` is
    // what makes the control real; an ideal-only constraint is advisory.
    async function applyResolution() {
        if (!displayStream) return;
        const track = displayStream.getVideoTracks()[0];
        if (!track) return;
        const entry = RESOLUTION_MAP[resolutionSelect ? resolutionSelect.value : '1080'];
        if (!entry) return; // "Match source" leaves the track alone.

        try {
            const fps = Number(framerateSelect ? framerateSelect.value : 24) || 24;
            await track.applyConstraints(captureConstraints(fps));
        } catch (err) {
            console.warn('[Studio] Could not apply the resolution constraint:', err);
            showToast(`This source could not be forced to ${entry.width}×${entry.height}; it stays at the size the system chose.`, 'warning');
        }
    }

    function initAudioControls() {
        const bindGain = (slider, valueNode) => {
            if (!slider) return;
            paintSlider(slider);
            slider.addEventListener('input', () => {
                if (valueNode) valueNode.textContent = `${slider.value}%`;
                paintSlider(slider);
                applyGainValues();
            });
        };
        bindGain(micGain, micGainValue);
        bindGain(systemGain, systemGainValue);

        if (micCheckbox) {
            micCheckbox.addEventListener('change', () => {
                if (isPublishing) {
                    showToast('Mic source changes apply on the next broadcast; the level is live.', 'info');
                }
                applyGainValues();
            });
        }

        if (systemAudioCheckbox) {
            systemAudioCheckbox.addEventListener('change', () => {
                if (isPublishing) {
                    showToast('System audio changes apply on the next broadcast; the level is live.', 'info');
                }
                applyGainValues();
            });
        }
    }

    function initTransport() {
        if (pickSourceBtn) {
            pickSourceBtn.addEventListener('click', () => {
                if (isPublishing || isStarting) {
                    showToast('Stop the broadcast before choosing a different source.', 'warning');
                    return;
                }
                pickSource();
            });
        }

        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                if (isPublishing || isStarting) return;
                if (hostAllowed !== true) {
                    showToast('Browser broadcasting only works on the host laptop. Open http://127.0.0.1:3000/streaming/studio there.', 'warning');
                    return;
                }
                if (!hasSource()) {
                    showToast('Choose a screen, window or tab first.', 'warning');
                    return;
                }

                // Document PiP must be requested in the click's gesture, before
                // the first await (the mic prompt and the session POST both
                // come later). This call is synchronous; the promise resolves
                // once the window's document exists.
                pipWarned = false;
                const pipPromise = openOnAirWindow();

                isStarting = true;
                refreshTransport('Starting the encoder…');
                setBusy(true, 'Starting the encoder…');
                setStatus('connecting', 'Starting');

                try {
                    await requestMicrophone();
                    if (!hasSource()) {
                        throw new Error('The screen capture ended before the broadcast started.');
                    }
                    await startPublishing(pipPromise);
                } catch (err) {
                    console.error('[Studio] Failed to start broadcasting:', err);
                    const active = publisher;
                    publisher = null;
                    if (active) {
                        try { await active.stop(); } catch (stopErr) { /* already gone */ }
                    }
                    teardownAudioGraph();
                    closeOnAirWindow();
                    isPublishing = false;
                    setBusy(false);
                    setStatus('error', 'Failed');
                    setEncoderControlsLocked(false);
                    refreshTransport('Could not start. Check the message and try again.');
                    showToast(describeStartError(err), 'error');
                } finally {
                    isStarting = false;
                    refreshTransport();
                }
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                if (isTearingDown) return;
                await stopBroadcast();
                setStatus('idle', 'Stopped');
                refreshTransport(stoppedNote());
                showToast('Broadcast stopped.', 'info');
            });
        }

        if (toastClose) {
            toastClose.addEventListener('click', () => {
                if (toast) toast.hidden = true;
            });
        }
    }

    function describeStartError(err) {
        const message = (err && err.message) || String(err);
        if (err && err.name === 'AbortError') {
            return 'The start request timed out. Is the host server still running?';
        }
        if (/WebCodecs|VideoEncoder|OffscreenCanvas/i.test(message)) {
            return 'This browser cannot encode H.264 with WebCodecs. Use Chrome or Edge on the host laptop.';
        }
        if (/host machine|host laptop/i.test(message)) {
            return 'Browser broadcasting only works on the host laptop. Open the studio there.';
        }
        return `Could not start broadcasting: ${message}`;
    }

    // ==========================================================================
    // Unload and visibility
    // ==========================================================================
    // Leaving the page with a live session would leave the relay's ffmpeg
    // publishing into a stream nobody is encoding for. pagehide is used rather
    // than beforeunload because it fires on mobile and bfcache navigations.

    window.addEventListener('pagehide', () => {
        // Best-effort and synchronous: an await here would not complete during
        // unload. The client's DELETE uses keepalive, and the relay also frees
        // the session when the upload socket closes.
        const active = publisher;
        publisher = null;
        if (active) {
            active.stop({ keepalive: true }).catch(() => {});
        }
        closeOnAirWindow();
        stopStatsLoop();
        stopLevelMeter();
        isPublishing = false;
        isStarting = false;
        teardownCapture();
        teardownAudioGraph();
    });

    window.addEventListener('pageshow', () => {
        if (isPublishing || isStarting) return;
        // pageshow fires after the async host check has often already run. Do
        // not overwrite its verdict with a cheerful "Ready": a tunneled page
        // would then show a Ready badge next to a disabled Start button.
        if (unsupported) {
            setStatus('error', 'Unsupported');
        } else if (hostAllowed === false) {
            setStatus('error', 'Host only');
        } else {
            setStatus('idle', 'Ready');
        }
        updateSourceUi();
        setEncoderControlsLocked(false);
        refreshTransport();
    });

    document.addEventListener('visibilitychange', () => {
        if (!isPublishing) return;
        if (document.hidden) {
            console.log('[Studio] Tab backgrounded; the On Air window keeps the encoder running.');
        } else {
            updateStats();
        }
    });

    // ==========================================================================
    // Initialisation
    // ==========================================================================

    function init() {
        initModeSelector();
        initEncoderControls();
        initAudioControls();
        initTransport();

        if (bitrateValue && bitrateSlider) bitrateValue.textContent = `${bitrateSlider.value} kbps`;
        if (micGainValue && micGain) micGainValue.textContent = `${micGain.value}%`;
        if (systemGainValue && systemGain) systemGainValue.textContent = `${systemGain.value}%`;
        resetMeters();
        setEncoderControlsLocked(false);
        setNotice(DEFAULT_NOTICE);

        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            unsupported = true;
            setStatus('error', 'Unsupported');
            refreshTransport('This browser cannot capture a screen. Use Chrome, Edge or another Chromium browser on a computer.');
            showToast('Screen capture is not available in this browser. Use Chrome, Edge or another Chromium browser on a computer.', 'error');
            return;
        }

        if (!window.StudioIngest || typeof window.StudioIngest.createPublisher !== 'function') {
            unsupported = true;
            setStatus('error', 'Unsupported');
            refreshTransport('The ingest client did not load. Reload the page.');
            showToast('The ingest client did not load. Reload the page.', 'error');
            return;
        }

        if (!window.VideoEncoder || !window.VideoFrame || !window.OffscreenCanvas) {
            unsupported = true;
            setStatus('error', 'Unsupported');
            refreshTransport('This browser cannot encode H.264 with WebCodecs. Use Chrome or Edge on the host laptop.');
            showToast('This browser cannot encode H.264 with WebCodecs. Use Chrome or Edge on the host laptop.', 'error');
            return;
        }

        setStatus('idle', 'Ready');
        refreshTransport();
        checkHostAccess();
    }

    init();
});
